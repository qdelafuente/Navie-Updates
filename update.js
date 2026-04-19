/**
 * update.js — Lógica de la página de actualización.
 * Separado del HTML para cumplir con la CSP de Chrome MV3.
 */

async function init() {
  const { pendingUpdate } = await chrome.storage.local.get("pendingUpdate");
  if (!pendingUpdate) return;

  const { newVersion, currentVersion, releaseNotes, installed } = pendingUpdate;

  document.getElementById("currentVersion").textContent = `v${currentVersion}`;
  document.getElementById("newVersion").textContent = `v${newVersion}`;

  if (releaseNotes && releaseNotes.trim()) {
    document.getElementById("releaseNotes").textContent = releaseNotes;
    document.getElementById("notesSection").style.display = "block";
  }

  if (installed) {
    // Native host instaló el ZIP — solo falta recargar
    document.getElementById("subtitle").textContent =
      "La actualización ya está instalada. Solo tienes que recargar.";
    document.getElementById("stepsContainer").innerHTML = `
      <div class="step done">
        <div class="step-icon">✅</div>
        <div class="step-content">
          <div class="step-title done-text">Actualización instalada automáticamente</div>
          <div class="step-desc">Los archivos de v${newVersion} ya están en tu equipo.</div>
        </div>
      </div>
      <div class="step todo">
        <div class="step-icon">1️⃣</div>
        <div class="step-content">
          <div class="step-title">Recarga la extensión</div>
          <div class="step-desc">Haz clic en el botón de abajo → pulsa <strong>⟲</strong> junto a Navie.</div>
        </div>
      </div>
    `;
  } else {
    // Sin native host — la zipFilename ya está en el HTML estático
    const filenameEl = document.getElementById("zipFilename");
    if (filenameEl) filenameEl.textContent = `navie-extension-v${newVersion}.zip`;
  }
}

document.getElementById("openExtensionsBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions" });
});

document.getElementById("dismissBtn").addEventListener("click", async () => {
  const { pendingUpdate } = await chrome.storage.local.get("pendingUpdate");
  if (pendingUpdate?.newVersion) {
    await chrome.storage.local.set({ updateDismissedVersion: pendingUpdate.newVersion });
  }
  window.close();
});

init();
