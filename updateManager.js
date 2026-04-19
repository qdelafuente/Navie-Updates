/**
 * updateManager.js — Sistema de actualizaciones automáticas para Navie.
 *
 * Flujo:
 * 1. Cada hora (via chrome.alarms) checkea GitHub por nueva versión.
 * 2. Si hay versión nueva, el native host descarga e instala el ZIP
 *    directamente en la carpeta de la extensión.
 * 3. El usuario solo necesita hacer clic en ⟲ Reload en chrome://extensions.
 *
 * Setup único: el usuario ejecuta install-native-host-mac.command una sola vez.
 */

const GITHUB_REPO = "qdelafuente/Navie-Updates";
const NATIVE_HOST = "com.navie.updater";
const UPDATE_CHECK_ALARM = "navieUpdateCheck";
const UPDATE_CHECK_INTERVAL_MINUTES = 60;
const STORAGE_KEY_DISMISSED = "updateDismissedVersion";

export function getLocalVersion() {
  return chrome.runtime.getManifest().version;
}

/**
 * Obtiene la última versión desde GitHub Releases.
 * @returns {{ version, notes, zipUrl } | null}
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
 * Envía un mensaje al native host.
 */
function sendToNativeHost(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, msg, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: "Sin respuesta" });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

/**
 * Comprueba si el native host está instalado y responde.
 */
async function isNativeHostAvailable() {
  const res = await sendToNativeHost({ action: "ping" });
  return res?.ok === true;
}

/**
 * Checkea si hay actualización, la instala via native host y notifica al usuario.
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

  // Intentar instalación automática via native host
  if (release.zipUrl && await isNativeHostAvailable()) {
    const result = await sendToNativeHost({ action: "update", url: release.zipUrl });
    if (result.ok) {
      // Actualización instalada — notificar que solo falta recargar
      chrome.notifications.create("navie-update-ready", {
        type: "basic",
        iconUrl: "Logo.png",
        title: `Navie v${release.version} listo`,
        message: "La actualización se instaló. Solo tienes que recargar la extensión en chrome://extensions.",
        priority: 2,
        buttons: [{ title: "Abrir chrome://extensions" }]
      });
      await chrome.storage.local.set({ pendingReload: { newVersion: release.version } });
      return { updateAvailable: true, installed: true, newVersion: release.version };
    }
  }

  // Native host no disponible — abrir página de actualización
  await openUpdatePage(release.version, localVersion, release.notes);
  return { updateAvailable: true, installed: false, newVersion: release.version };
}

async function openUpdatePage(newVersion, currentVersion, releaseNotes) {
  await chrome.storage.local.set({
    pendingUpdate: { newVersion, currentVersion, releaseNotes, timestamp: Date.now() }
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

  chrome.notifications.onButtonClicked.addListener((notifId, btnIndex) => {
    if (notifId === "navie-update-ready" && btnIndex === 0) {
      chrome.tabs.create({ url: "chrome://extensions" });
    }
  });
}

export async function handleUpdateAlarm(alarm) {
  if (alarm?.name === UPDATE_CHECK_ALARM) {
    await checkForUpdate();
  }
}
