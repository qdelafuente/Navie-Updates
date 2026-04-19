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
  if (!btn) return;
  if (selectedOS === "mac") {
    btn.href = chrome.runtime.getURL("scripts/install-native-host-mac.command");
    btn.download = "install-navie-updater.command";
  } else {
    btn.href = chrome.runtime.getURL("scripts/install-native-host-windows.bat");
    btn.download = "install-navie-updater.bat";
  }
}

const btnWindows = document.getElementById("btn-windows");
const btnMac = document.getElementById("btn-mac");
if (btnWindows) btnWindows.addEventListener("click", () => selectOS("windows"));
if (btnMac) btnMac.addEventListener("click", () => selectOS("mac"));

const downloadBtn = document.getElementById("downloadBtn");
if (downloadBtn) {
  downloadBtn.addEventListener("click", () => {
    const msg = document.getElementById("successMsg");
    if (msg) msg.style.display = "block";
  });
}

async function handleDismiss() {
  const { pendingUpdate } = await chrome.storage.local.get("pendingUpdate");
  if (pendingUpdate?.newVersion) {
    await chrome.storage.local.set({ updateDismissedVersion: pendingUpdate.newVersion });
  }
  window.close();
}

const dismissBtn = document.getElementById("dismissBtn");
if (dismissBtn) dismissBtn.addEventListener("click", handleDismiss);

const dismissBtnInstall = document.getElementById("dismissBtnInstall");
if (dismissBtnInstall) dismissBtnInstall.addEventListener("click", handleDismiss);

// Cargar info del update desde storage
async function init() {
  selectOS(selectedOS);
  updateDownloadLink();

  const { pendingUpdate } = await chrome.storage.local.get("pendingUpdate");
  if (!pendingUpdate) return;

  const currentVersionEl = document.getElementById("currentVersion");
  const newVersionEl = document.getElementById("newVersion");
  if (currentVersionEl) currentVersionEl.textContent = `v${pendingUpdate.currentVersion}`;
  if (newVersionEl) newVersionEl.textContent = `v${pendingUpdate.newVersion}`;

  if (pendingUpdate.releaseNotes && pendingUpdate.releaseNotes.trim()) {
    const notesBody = document.getElementById("releaseNotes");
    const notesSection = document.getElementById("notesSection");
    if (notesBody) notesBody.textContent = pendingUpdate.releaseNotes;
    if (notesSection) notesSection.style.display = "block";
  }

  // Si ya tiene el native host instalado, mostrar modo "solo recarga"
  // Si no lo tiene, mostrar modo "instala el actualizador primero"
  if (!pendingUpdate.needsNativeHost) {
    // Native host ya instalado — la actualización se descargó automáticamente
    const stepsSection = document.getElementById("stepsSection");
    const osSelectorSection = document.getElementById("osSelectorSection");
    const downloadSection = document.getElementById("downloadSection");
    const reloadSection = document.getElementById("reloadSection");
    if (stepsSection) stepsSection.style.display = "none";
    if (osSelectorSection) osSelectorSection.style.display = "none";
    if (downloadSection) downloadSection.style.display = "none";
    if (reloadSection) reloadSection.style.display = "block";
  }
}

const openExtensionsBtn = document.getElementById("openExtensionsBtn");
if (openExtensionsBtn) {
  openExtensionsBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions" });
  });
}

init();
