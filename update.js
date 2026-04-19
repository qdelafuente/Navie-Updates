/**
 * update.js — Lógica de la página de actualización.
 * Separado del HTML para cumplir con la CSP de Chrome MV3.
 */

let selectedOS = navigator.userAgent.includes("Mac") ? "mac" : "windows";

function selectOS(os) {
  selectedOS = os;
  document.getElementById("btn-windows").classList.toggle("active", os === "windows");
  document.getElementById("btn-mac").classList.toggle("active", os === "mac");
  updateDownloadLink();
}

function updateDownloadLink() {
  const btn = document.getElementById("downloadBtn");
  if (selectedOS === "mac") {
    btn.href = chrome.runtime.getURL("scripts/update-extension-mac.sh");
    btn.download = "update-navie-mac.sh";
  } else {
    btn.href = chrome.runtime.getURL("scripts/update-extension-windows.bat");
    btn.download = "update-navie-windows.bat";
  }
}

document.getElementById("btn-windows").addEventListener("click", () => selectOS("windows"));
document.getElementById("btn-mac").addEventListener("click", () => selectOS("mac"));

document.getElementById("downloadBtn").addEventListener("click", () => {
  document.getElementById("successMsg").style.display = "block";
});

document.getElementById("dismissBtn").addEventListener("click", async () => {
  const { pendingUpdate } = await chrome.storage.local.get("pendingUpdate");
  if (pendingUpdate?.newVersion) {
    await chrome.storage.local.set({ updateDismissedVersion: pendingUpdate.newVersion });
  }
  window.close();
});

// Cargar info del update desde storage
async function init() {
  selectOS(selectedOS);
  updateDownloadLink();

  const { pendingUpdate } = await chrome.storage.local.get("pendingUpdate");
  if (pendingUpdate) {
    document.getElementById("currentVersion").textContent = `v${pendingUpdate.currentVersion}`;
    document.getElementById("newVersion").textContent = `v${pendingUpdate.newVersion}`;

    if (pendingUpdate.releaseNotes && pendingUpdate.releaseNotes.trim()) {
      document.getElementById("releaseNotes").textContent = pendingUpdate.releaseNotes;
      document.getElementById("notesSection").style.display = "block";
    }
  }
}

init();
