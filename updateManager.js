/**
 * updateManager.js — Sistema de actualizaciones automáticas para Navie.
 *
 * Flujo con Native Messaging (actualización 1-clic):
 * 1. Cada hora (via chrome.alarms) checkea GitHub por nueva versión.
 * 2. Si hay versión nueva, intenta instalarla automáticamente via Native Messaging.
 *    - Si el native host está instalado: descarga y extrae el ZIP al directorio de la extensión.
 *      El usuario solo necesita hacer clic en ⟲ Reload en chrome://extensions.
 *    - Si el native host NO está instalado: abre update.html con instrucciones de instalación.
 * 3. Una vez instalado el native host, todas las actualizaciones futuras son automáticas.
 */

const GITHUB_REPO = "qdelafuente/Navie-Updates";
const NATIVE_HOST = "com.navie.updater";
const UPDATE_CHECK_ALARM = "navieUpdateCheck";
const UPDATE_CHECK_INTERVAL_MINUTES = 60;
const STORAGE_KEY_DISMISSED = "updateDismissedVersion";

/**
 * Obtiene la versión actual de la extensión desde el manifest.
 */
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
      {
        headers: { "Accept": "application/vnd.github+json" },
        cache: "no-store"
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const version = (data.tag_name || "").replace(/^v/, "");
    const notes = data.body || "";

    // Encontrar el asset ZIP de la extensión
    const zipAsset = (data.assets || []).find(a => a.name.endsWith(".zip"));
    const zipUrl = zipAsset?.browser_download_url || null;

    return { version, notes, zipUrl };
  } catch {
    return null;
  }
}

/**
 * Compara dos versiones en formato semver (X.Y.Z).
 * @returns {number} 1 si a > b, -1 si a < b, 0 si iguales
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
 * Verifica si el native host está instalado enviando un ping.
 * @returns {boolean}
 */
async function isNativeHostAvailable() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: "ping" }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Obtiene el directorio de la extensión en disco.
 * chrome.runtime.getURL devuelve chrome-extension://ID/...,
 * necesitamos la ruta real del sistema de archivos.
 * El native host la recibe para saber dónde extraer el ZIP.
 */
function getExtensionDirectory() {
  // En una extensión desempaquetada, la ruta está en el ID del runtime.
  // El native host calculará la ruta desde el extensionId proporcionado.
  return chrome.runtime.id;
}

/**
 * Envía el ZIP al native host para que lo instale.
 * El native host conoce la ruta de la extensión por su propia ubicación en disco.
 * @returns {{ ok: boolean, message: string }}
 */
async function installViaNativeHost(zipUrl) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(
        NATIVE_HOST,
        { action: "update", url: zipUrl },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, message: chrome.runtime.lastError.message });
          } else {
            resolve(response || { ok: false, message: "No response" });
          }
        }
      );
    } catch (e) {
      resolve({ ok: false, message: String(e) });
    }
  });
}

/**
 * Checkea si hay actualización disponible y la instala automáticamente si es posible.
 * Exportada para llamarla manualmente desde el botón de settings.
 * @returns {{ updateAvailable: boolean, installed: boolean, needsNativeHost: boolean, newVersion?: string }}
 */
export async function checkForUpdate() {
  const release = await fetchLatestRelease();
  if (!release) return { updateAvailable: false };

  const localVersion = getLocalVersion();
  if (compareVersions(release.version, localVersion) <= 0) {
    return { updateAvailable: false };
  }

  // Ver si el usuario ya descartó esta versión
  const { [STORAGE_KEY_DISMISSED]: dismissed } = await chrome.storage.local.get(STORAGE_KEY_DISMISSED);
  if (dismissed === release.version) return { updateAvailable: false };

  // Hay update disponible — ¿tenemos native host?
  const nativeHostOk = await isNativeHostAvailable();

  if (nativeHostOk && release.zipUrl) {
    // Instalación automática
    const result = await installViaNativeHost(release.zipUrl);
    if (result.ok) {
      // Notificar al usuario que solo necesita recargar
      await notifyReloadNeeded(release.version);
      return { updateAvailable: true, installed: true, newVersion: release.version };
    }
    // Si falla la instalación automática, caer al flujo manual
  }

  // Sin native host o instalación fallida → abrir página de actualización
  await openUpdatePage(release.version, localVersion, release.notes, !nativeHostOk);
  return { updateAvailable: true, installed: false, needsNativeHost: !nativeHostOk, newVersion: release.version };
}

/**
 * Muestra una notificación pidiendo al usuario que recargue la extensión.
 */
async function notifyReloadNeeded(newVersion) {
  await chrome.storage.local.set({
    pendingReload: { newVersion, timestamp: Date.now() }
  });

  chrome.notifications.create("navie-reload-needed", {
    type: "basic",
    iconUrl: "Logo.png",
    title: "Navie actualizado a v" + newVersion,
    message: "La nueva versión está lista. Ve a chrome://extensions y haz clic en ⟲ Reload en Navie.",
    priority: 2,
    buttons: [{ title: "Abrir chrome://extensions" }]
  });
}

/**
 * Abre la página de actualización como tab.
 * @param {boolean} needsNativeHost — si true, mostrar instrucciones de instalación del host
 */
async function openUpdatePage(newVersion, currentVersion, releaseNotes, needsNativeHost = false) {
  await chrome.storage.local.set({
    pendingUpdate: {
      newVersion,
      currentVersion,
      releaseNotes,
      needsNativeHost,
      timestamp: Date.now()
    }
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

/**
 * Registra la alarma de checkeo de actualizaciones.
 */
export function initUpdateChecker() {
  chrome.alarms.get(UPDATE_CHECK_ALARM, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(UPDATE_CHECK_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: UPDATE_CHECK_INTERVAL_MINUTES
      });
    }
  });

  // Manejar clic en botón de notificación
  chrome.notifications.onButtonClicked.addListener((notifId, btnIndex) => {
    if (notifId === "navie-reload-needed" && btnIndex === 0) {
      chrome.tabs.create({ url: "chrome://extensions" });
    }
  });
}

/**
 * Handler para la alarma.
 */
export async function handleUpdateAlarm(alarm) {
  if (alarm?.name === UPDATE_CHECK_ALARM) {
    await checkForUpdate();
  }
}
