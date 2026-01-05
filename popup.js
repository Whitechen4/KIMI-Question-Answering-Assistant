const FIELDS = ["kimiKey", "ocrKey"];

function $(id) {
  return document.getElementById(id);
}

function setStatus(msg) {
  $("status").textContent = msg || "";
}

async function loadKeys() {
  try {
    const data = await chrome.storage.sync.get(FIELDS);
    $("kimiKey").value = data.kimiKey || "";
    $("ocrKey").value = data.ocrKey || "";
    setStatus("已加载（Loaded）");
  } catch (e) {
    console.error(e);
    setStatus("加载失败（Load failed）");
  }
}

async function saveKeys() {
  try {
    const kimiKey = ($("kimiKey").value || "").trim();
    const ocrKey = ($("ocrKey").value || "").trim();

    await chrome.storage.sync.set({ kimiKey, ocrKey });
    setStatus("已保存（Saved）");
  } catch (e) {
    console.error(e);
    setStatus("保存失败（Save failed）");
  }
}

async function clearKeys() {
  try {
    await chrome.storage.sync.remove(FIELDS);
    $("kimiKey").value = "";
    $("ocrKey").value = "";
    setStatus("已清空（Cleared）");
  } catch (e) {
    console.error(e);
    setStatus("清空失败（Clear failed）");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadKeys();
  $("saveBtn").addEventListener("click", saveKeys);
  $("clearBtn").addEventListener("click", clearKeys);
});
