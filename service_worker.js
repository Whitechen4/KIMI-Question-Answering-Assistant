const MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1";
const MOONSHOT_TEXT_MODEL = "kimi-k2-turbo-preview";

async function getApiKeys() {
  const { kimiKey, ocrKey } = await chrome.storage.sync.get([
    "kimiKey",
    "ocrKey",
  ]);
  return {
    kimiKey: (kimiKey || "").trim(),
    ocrKey: (ocrKey || "").trim(),
  };
}

async function sendToActiveTab(payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, payload);
}

async function captureVisibleTabPng() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab");

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  if (!dataUrl?.startsWith("data:image/"))
    throw new Error("captureVisibleTab failed");
  return dataUrl;
}

async function ocrSpaceRecognize(imageDataUrl, apiKey, timeoutMs = 20000) {
  if (!apiKey)
    throw new Error(
      "Missing OCR API key. Please set it in the extension popup."
    );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      signal: controller.signal,
      headers: {
        apikey: apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        base64Image: imageDataUrl,
        language: "chs",
        isOverlayRequired: "false",
        OCREngine: "2",
      }),
    });

    const data = await resp.json().catch(() => null);
    if (!data) throw new Error("OCR: invalid JSON response");
    if (data.IsErroredOnProcessing) {
      throw new Error(
        "OCR error: " + (data.ErrorMessage?.join?.("; ") || "unknown")
      );
    }

    const text = data?.ParsedResults?.[0]?.ParsedText || "";
    return String(text).trim();
  } finally {
    clearTimeout(timer);
  }
}

function buildTextGradingPrompt(ocrText) {
  return [
    "你是阅卷老师。下面是从试卷截图 OCR 识别出来的文本，可能存在错字、断行、重复。",
    "",
    "任务：识别所有选择题题号，给出每题正确选项，并附上该选项对应的选项内容（简短即可）。",
    "",
    "输出要求（必须严格遵守）：",
    "1) 每行一题",
    "2) 格式：题号.选项：选项内容",
    "   示例：1.A：2",
    "3) 选项只允许 A/B/C/D；若无法判断则：题号.N/A：无法判断",
    "4) 按题号从小到大排序",
    "5) 不要输出任何解释、推理、额外文字",
    "",
    "OCR 文本如下：",
    ocrText,
  ].join("\n");
}

async function callKimiText({ promptText, apiKey, timeoutMs = 20000 }) {
  if (!apiKey?.startsWith("sk-")) {
    throw new Error(
      "Missing/Invalid Kimi API key. Please set it in the extension popup."
    );
  }

  const url = MOONSHOT_BASE_URL.replace(/\/$/, "") + "/chat/completions";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MOONSHOT_TEXT_MODEL,
        temperature: 0,
        messages: [{ role: "user", content: promptText }],
      }),
    });

    const raw = await resp.text().catch(() => "");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${raw.slice(0, 800)}`);

    const data = JSON.parse(raw);
    const out = data?.choices?.[0]?.message?.content ?? "";
    return String(out).trim();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAnswerText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const kept = lines.filter((l) => /^\d+\.(A|B|C|D|N\/A)：/.test(l));
  return kept.length ? kept.join("\n") : lines.join("\n") || "N/A";
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "grade-visible") return;

  try {
    const { kimiKey, ocrKey } = await getApiKeys();
    if (!kimiKey || !ocrKey) {
      await sendToActiveTab({
        type: "SHOW_ANSWERS",
        text: "N/A\n请点击插件图标，在 Popup 里填写 Kimi Key 与 OCR Key（Please set keys in popup）。",
      });
      return;
    }

    await sendToActiveTab({
      type: "SHOW_STATUS",
      text: "Capturing full view...",
    });
    const fullImg = await captureVisibleTabPng();

    await sendToActiveTab({ type: "START_CROP_MODE", imageDataUrl: fullImg });
    await sendToActiveTab({
      type: "SHOW_STATUS",
      text: "Drag to select area (Release to confirm, Esc cancel)...",
    });
  } catch (e) {
    await sendToActiveTab({
      type: "SHOW_ANSWERS",
      text: "N/A\n" + String(e?.message || e),
    });
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  (async () => {
    if (msg?.type !== "CROPPED_IMAGE_READY") return;

    const cropped = String(msg.imageDataUrl || "");
    if (!cropped.startsWith("data:image/")) {
      await sendToActiveTab({
        type: "SHOW_ANSWERS",
        text: "N/A\nInvalid cropped image",
      });
      return;
    }

    const { kimiKey, ocrKey } = await getApiKeys();
    if (!kimiKey || !ocrKey) {
      await sendToActiveTab({
        type: "SHOW_ANSWERS",
        text: "N/A\n未检测到密钥：请在插件 Popup 填写 Kimi Key 与 OCR Key。",
      });
      return;
    }

    await sendToActiveTab({ type: "SHOW_STATUS", text: "OCR..." });
    const ocrText = await ocrSpaceRecognize(cropped, ocrKey, 25000);

    if (!ocrText) {
      await sendToActiveTab({ type: "SHOW_ANSWERS", text: "N/A\nOCR empty" });
      return;
    }

    const ocrClip = ocrText.slice(0, 8000);

    await sendToActiveTab({
      type: "SHOW_STATUS",
      text: "Calling Kimi text model...",
    });
    const prompt = buildTextGradingPrompt(ocrClip);
    const ans = await callKimiText({
      promptText: prompt,
      apiKey: kimiKey,
      timeoutMs: 25000,
    });

    await sendToActiveTab({
      type: "SHOW_ANSWERS",
      text: normalizeAnswerText(ans),
    });
  })().catch(async (e) => {
    await sendToActiveTab({
      type: "SHOW_ANSWERS",
      text: "N/A\n" + String(e?.message || e),
    });
  });
});
