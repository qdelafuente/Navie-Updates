/**
 * update.js — Lógica de la página de actualización.
 * Separado del HTML para cumplir con la CSP de Chrome MV3.
 */

async function init() {
  const { pendingUpdate } = await chrome.storage.local.get("pendingUpdate");
  if (!pendingUpdate) return;

  const { newVersion, currentVersion, releaseNotes, downloaded } = pendingUpdate;

  document.getElementById("currentVersion").textContent = `v${currentVersion}`;
  document.getElementById("newVersion").textContent = `v${newVersion}`;
  document.getElementById("zipFilename").textContent = `navie-extension-v${newVersion}.zip`;

  if (releaseNotes && releaseNotes.trim()) {
    document.getElementById("releaseNotes").textContent = releaseNotes;
    document.getElementById("notesSection").style.display = "block";
  }

  // Si la descarga falló, cambiar el primer paso para indicarlo
  if (!downloaded) {
    const firstStep = document.querySelector(".step.done");
    if (firstStep) {
      firstStep.classList.remove("done");
      firstStep.classList.add("todo");
      firstStep.querySelector(".step-icon").textContent = "⚠️";
      firstStep.querySelector(".step-title").textContent = "El ZIP no se pudo descargar";
      firstStep.querySelector(".step-title").classList.remove("done-text");
      firstStep.querySelector(".step-desc").innerHTML =
        'Descárgalo manualmente desde <strong>github.com/qdelafuente/Navie-Updates/releases</strong>';
    }
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
