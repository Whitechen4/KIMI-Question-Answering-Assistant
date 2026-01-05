let panel;

async function initOnce() {
  const { warned } = await chrome.storage.local.get(["warned"]);
  if (warned) return;
  alert("在开始之前请在插件图标处输入 Kimi/OCR Key");
  await chrome.storage.local.set({ warned: true });
}

function ensurePanel() {
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = "paper-grader-panel";

  panel.style.position = "fixed";
  panel.style.top = "10px";
  panel.style.left = "10px";
  panel.style.zIndex = "2147483647";
  panel.style.color = "black";
  panel.style.fontSize = "16px";
  panel.style.lineHeight = "1.6";
  panel.style.whiteSpace = "pre-wrap";
  panel.style.pointerEvents = "none";

  document.documentElement.appendChild(panel);
  return panel;
}

function setText(text) {
  ensurePanel().textContent = text ?? "";
}

let cropCanvas = null;
let cropCtx = null;

let isCropping = false;
let isDragging = false;
let startPt = null;
let endPt = null;

let fullImage = null;

function removeCropLayer() {
  if (cropCanvas) cropCanvas.remove();
  cropCanvas = null;
  cropCtx = null;
  isCropping = false;
  isDragging = false;
  startPt = null;
  endPt = null;
  fullImage = null;
}

function drawCropOverlay() {
  if (!cropCtx || !cropCanvas) return;

  cropCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  cropCtx.fillStyle = "rgba(0, 0, 0, 0)";
  cropCtx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  if (startPt && endPt) {
    const x = Math.min(startPt.x, endPt.x);
    const y = Math.min(startPt.y, endPt.y);
    const rw = Math.abs(endPt.x - startPt.x);
    const rh = Math.abs(endPt.y - startPt.y);

    cropCtx.strokeStyle = "rgba(255, 0, 0, 0.72)";
    cropCtx.lineWidth = 0.5;
    cropCtx.strokeRect(x, y, rw, rh);
  }
}

async function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load screenshot image"));
    img.src = dataUrl;
  });
}

function cropAndSend() {
  if (!fullImage || !startPt || !endPt) return;

  const x = Math.min(startPt.x, endPt.x);
  const y = Math.min(startPt.y, endPt.y);
  const rw = Math.abs(endPt.x - startPt.x);
  const rh = Math.abs(endPt.y - startPt.y);

  if (rw < 10 || rh < 10) {
    removeCropLayer();
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const sx = Math.round(x * dpr);
  const sy = Math.round(y * dpr);
  const sw = Math.round(rw * dpr);
  const sh = Math.round(rh * dpr);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = sw;
  outCanvas.height = sh;
  const outCtx = outCanvas.getContext("2d");

  outCtx.drawImage(fullImage, sx, sy, sw, sh, 0, 0, sw, sh);

  const croppedDataUrl = outCanvas.toDataURL("image/png");

  chrome.runtime.sendMessage({
    type: "CROPPED_IMAGE_READY",
    imageDataUrl: croppedDataUrl,
  });

  removeCropLayer();
}

async function startCropMode(imageDataUrl) {
  removeCropLayer();

  fullImage = await loadImage(imageDataUrl);

  cropCanvas = document.createElement("canvas");
  cropCanvas.style.position = "fixed";
  cropCanvas.style.top = "0";
  cropCanvas.style.left = "0";
  cropCanvas.style.width = "100vw";
  cropCanvas.style.height = "100vh";
  cropCanvas.style.zIndex = "2147483646";
  cropCanvas.style.cursor = "crosshair";
  cropCanvas.style.pointerEvents = "auto";

  const dpr = window.devicePixelRatio || 1;
  cropCanvas.width = Math.round(window.innerWidth * dpr);
  cropCanvas.height = Math.round(window.innerHeight * dpr);

  cropCtx = cropCanvas.getContext("2d");
  cropCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  document.documentElement.appendChild(cropCanvas);

  isCropping = true;
  isDragging = false;
  startPt = null;
  endPt = null;

  const toPt = (x, y) => ({ x, y });

  const onMouseDown = (e) => {
    if (!isCropping) return;
    isDragging = true;
    startPt = toPt(e.clientX, e.clientY);
    endPt = toPt(e.clientX, e.clientY);
    drawCropOverlay();
  };

  const onMouseMove = (e) => {
    if (!isCropping || !isDragging || !startPt) return;
    endPt = toPt(e.clientX, e.clientY);
    drawCropOverlay();
  };

  const onMouseUp = (e) => {
    if (!isCropping || !isDragging || !startPt) return;
    isDragging = false;
    endPt = toPt(e.clientX, e.clientY);
    drawCropOverlay();

    cropAndSend();

    cropCanvas?.removeEventListener("mousedown", onMouseDown);
    cropCanvas?.removeEventListener("mousemove", onMouseMove);
    cropCanvas?.removeEventListener("mouseup", onMouseUp);
    window.removeEventListener("keydown", onKeyDown, true);
  };

  const onKeyDown = (e) => {
    if (!isCropping) return;
    if (e.key === "Escape") {
      removeCropLayer();
      cropCanvas?.removeEventListener("mousedown", onMouseDown);
      cropCanvas?.removeEventListener("mousemove", onMouseMove);
      cropCanvas?.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown, true);
    }
  };

  cropCanvas.addEventListener("mousedown", onMouseDown);
  cropCanvas.addEventListener("mousemove", onMouseMove);
  cropCanvas.addEventListener("mouseup", onMouseUp);
  window.addEventListener("keydown", onKeyDown, true);

  drawCropOverlay();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "SHOW_STATUS") setText(msg.text ?? "");
  if (msg?.type === "SHOW_ANSWERS") setText(msg.text ?? "");

  if (msg?.type === "START_CROP_MODE") {
    const img = msg.imageDataUrl;
    if (typeof img === "string" && img.startsWith("data:image/")) {
      startCropMode(img).catch((e) => {
        setText("N/A\n" + String(e?.message || e));
        removeCropLayer();
      });
    }
  }
});
