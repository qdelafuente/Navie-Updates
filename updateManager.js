/**
 * updateManager.js — Sistema de actualizaciones automáticas para Navie.
 *
 * Flujo:
 * 1. Cada hora (via chrome.alarms) checkea GitHub por nueva versión.
 * 2. Si hay versión nueva, descarga el ZIP automáticamente a la carpeta
 *    de Descargas del usuario via chrome.downloads.
 * 3. Abre update.html con instrucciones de 2 pasos:
 *    - Doble clic en el ZIP para extraer
 *    - Recargar Navie en chrome://extensions
 */

const GITHUB_REPO = "qdelafuente/Navie-Updates";
const UPDATE_CHECK_ALARM = "navieUpdateCheck";
const UPDATE_CHECK_INTERVAL_MINUTES = 60;
const STORAGE_KEY_DISMISSED = "updateDismissedVersion";

export function getLocalVersion() {
  return chrome.runtime.getManifest().version;
}

/**
 * Obtiene la última versión disponible desde GitHub Releases.
 * @returns {{ version: string, notes: string, zipUrl: string } | null}
 */
export async function fetchLatestRelease() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { "Accept": "application/vnd.github+json" }, cache: "no-store" }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const version = (data.tag_name || "").replace(/^v/, "");
    const notes = data.body || "";
    const zipAsset = (data.assets || []).find(a => a.name.endsWith(".zip"));
    const zipUrl = zipAsset?.browser_download_url || null;
    return { version, notes, zipUrl };
  } catch {
    return null;
  }
}

/**
 * Compara dos versiones semver. Devuelve 1 si a > b, -1 si a < b, 0 si iguales.
 */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/**
 * Descarga el ZIP automáticamente a la carpeta de Descargas.
 * @returns {number|null} downloadId o null si falla
 */
async function downloadZip(zipUrl, newVersion) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url: zipUrl,
        filename: `navie-extension-v${newVersion}.zip`,
        saveAs: false,
        conflictAction: "overwrite"
      },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          resolve(null);
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

/**
 * Checkea si hay actualización, la descarga y abre las instrucciones.
 */
export async function checkForUpdate() {
  const release = await fetchLatestRelease();
  if (!release) return { updateAvailable: false };

  const localVersion = getLocalVersion();
  if (compareVersions(release.version, localVersion) <= 0) {
    return { updateAvailable: false };
  }

  const { [STORAGE_KEY_DISMISSED]: dismissed } = await chrome.storage.local.get(STORAGE_KEY_DISMISSED);
  if (dismissed === release.version) return { updateAvailable: false };

  // Descargar ZIP automáticamente si tenemos la URL
  let downloaded = false;
  if (release.zipUrl) {
    const downloadId = await downloadZip(release.zipUrl, release.version);
    downloaded = downloadId !== null;
  }

  await openUpdatePage(release.version, localVersion, release.notes, downloaded);
  return { updateAvailable: true, newVersion: release.version, downloaded };
}

/**
 * Abre update.html con la info del update.
 */
async function openUpdatePage(newVersion, currentVersion, releaseNotes, downloaded) {
  await chrome.storage.local.set({
    pendingUpdate: { newVersion, currentVersion, releaseNotes, downloaded, timestamp: Date.now() }
  });

  const updateUrl = chrome.runtime.getURL("update.html");
  const tabs = await chrome.tabs.query({ url: updateUrl });
  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: updateUrl });
  }
}

export function initUpdateChecker() {
  chrome.alarms.get(UPDATE_CHECK_ALARM, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(UPDATE_CHECK_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: UPDATE_CHECK_INTERVAL_MINUTES
      });
    }
  });
}

export async function handleUpdateAlarm(alarm) {
  if (alarm?.name === UPDATE_CHECK_ALARM) {
    await checkForUpdate();
  }
}
