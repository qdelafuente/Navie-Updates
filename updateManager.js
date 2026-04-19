/**
 * updateManager.js — Sistema de actualizaciones automáticas para Navie.
 *
 * Flujo:
 * 1. Cada hora (via chrome.alarms), checkea GitHub por nueva versión
 * 2. Si hay versión nueva, abre update.html con UI bonita
 * 3. Usuario descarga script (.bat o .sh) y ejecuta con doble clic
 * 4. Usuario recarga extensión en chrome://extensions
 */

const GITHUB_REPO = "qdelafuente/Navie-Updates";
const UPDATE_CHECK_ALARM = "navieUpdateCheck";
const UPDATE_CHECK_INTERVAL_MINUTES = 60; // cada hora
const STORAGE_KEY_DISMISSED = "updateDismissedVersion";

/**
 * Obtiene la versión actual de la extensión desde el manifest.
 */
export function getLocalVersion() {
  return chrome.runtime.getManifest().version;
}

/**
 * Obtiene la última versión disponible desde GitHub Releases.
 * @returns {{ version: string, notes: string, publishedAt: string } | null}
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
    const version = (data.tag_name || "").replace(/^v/, ""); // "v0.3.1" → "0.3.1"
    const notes = data.body || "";
    const publishedAt = data.published_at || "";
    return { version, notes, publishedAt };
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
 * Checkea si hay actualización disponible y si el usuario ya la descartó.
 */
export async function checkForUpdate() {
  const release = await fetchLatestRelease();
  if (!release) return;

  const localVersion = getLocalVersion();
  if (compareVersions(release.version, localVersion) <= 0) return; // no hay update

  // Ver si el usuario ya descartó esta versión
  const { [STORAGE_KEY_DISMISSED]: dismissed } = await chrome.storage.local.get(STORAGE_KEY_DISMISSED);
  if (dismissed === release.version) return;

  // Hay update disponible → abrir página de actualización
  await openUpdatePage(release.version, localVersion, release.notes);
}

/**
 * Abre la página de actualización como tab.
 */
async function openUpdatePage(newVersion, currentVersion, releaseNotes) {
  // Guardar info en storage para que update.html la lea
  await chrome.storage.local.set({
    pendingUpdate: {
      newVersion,
      currentVersion,
      releaseNotes,
      timestamp: Date.now()
    }
  });

  // Abrir la página de update
  const updateUrl = chrome.runtime.getURL("update.html");

  // Si ya hay una tab de update abierta, activarla en vez de abrir otra
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
 * Llamar desde background.js al inicializar.
 */
export function initUpdateChecker() {
  chrome.alarms.get(UPDATE_CHECK_ALARM, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(UPDATE_CHECK_ALARM, {
        delayInMinutes: 1, // primer check a los 1 min de abrir el navegador
        periodInMinutes: UPDATE_CHECK_INTERVAL_MINUTES
      });
    }
  });
}

/**
 * Handler para la alarma. Llamar desde chrome.alarms.onAlarm.addListener en background.js.
 */
export async function handleUpdateAlarm(alarm) {
  if (alarm?.name === UPDATE_CHECK_ALARM) {
    await checkForUpdate();
  }
}
