/**
 * User ID bootstrap: fetch and cache Blackboard user id (e.g. _109504_1).
 * Other features MUST call getCurrentUserId() and never guess the id.
 * Runs in the extension background only.
 */

const STORAGE_KEY_USER_ID = "bb_user_id";
const STORAGE_KEY_FETCHED_AT = "bb_user_id_fetched_at";
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_USER_ME_URL = "https://blackboard.ie.edu/learn/api/v1/users/me";
const RETRY_BACKOFF_MIN_MS = 300;
const RETRY_BACKOFF_MAX_MS = 800;

const DEBUG_USER_IDENTITY = false;
function debugLog(...args) {
  if (DEBUG_USER_IDENTITY) console.log("[userIdentity]", ...args);
}

/** Thrown when the user is not authenticated (401/403 or no Blackboard tab logged in). */
export class UserNotAuthenticatedError extends Error {
  constructor(message = "Open Blackboard in a tab and ensure you're logged in, then retry.") {
    super(message);
    this.name = "UserNotAuthenticatedError";
  }
}

let cachedUserId = null;
let initPromise = null;

function getBackoffMs() {
  return Math.floor(RETRY_BACKOFF_MIN_MS + Math.random() * (RETRY_BACKOFF_MAX_MS - RETRY_BACKOFF_MIN_MS + 1));
}

/** Fetch user id from a Blackboard tab (content script). */
async function fetchUserIdFromPage() {
  const tabs = await chrome.tabs.query({ url: "https://blackboard.ie.edu/*" });
  const tab = tabs?.[0];
  if (!tab?.id) {
    throw new UserNotAuthenticatedError("Open Blackboard in a tab and ensure you're logged in, then retry.");
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "PING" });
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["courseRegistry.js", "contentScript.js"] });
    await new Promise((r) => setTimeout(r, 150));
  }
  const res = await chrome.tabs.sendMessage(tab.id, { type: "FETCH_CURRENT_USER_ID" });
  if (!res) throw new Error("No response from content script.");
  if (res.ok && res.id != null && res.id !== "") {
    return { id: String(res.id) };
  }
  const errMsg = res?.error || "User id not returned.";
  if (res?.notAuthenticated) {
    throw new UserNotAuthenticatedError(errMsg);
  }
  throw new Error(errMsg);
}

async function fetchUserIdWithRetry() {
  let lastErr;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const { id } = await fetchUserIdFromPage();
      return id;
    } catch (e) {
      lastErr = e;
      if (e instanceof UserNotAuthenticatedError) throw e;
      if (attempt === 0) {
        const backoff = getBackoffMs();
        debugLog("fetch retry after", backoff, "ms:", e?.message);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

/**
 * Initialize user identity: load from storage (if valid TTL) or fetch from Blackboard.
 * Safe to call multiple times; guarded so it doesn't refetch constantly.
 */
export async function initUserIdentity() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    debugLog("initUserIdentity started");
    const stored = await chrome.storage.local.get([STORAGE_KEY_USER_ID, STORAGE_KEY_FETCHED_AT]);
    const storedId = stored[STORAGE_KEY_USER_ID];
    const fetchedAt = stored[STORAGE_KEY_FETCHED_AT];
    const now = Date.now();
    if (storedId && typeof storedId === "string" && fetchedAt && now - fetchedAt < TTL_MS) {
      cachedUserId = storedId;
      debugLog("storage hit, id:", storedId, "fetchedAt:", new Date(fetchedAt).toISOString());
      return;
    }
    debugLog("storage miss or expired, fetching from network");
    try {
      const id = await fetchUserIdWithRetry();
      if (!id || typeof id !== "string") {
        throw new Error("Unexpected response from Blackboard: user id not found.");
      }
      cachedUserId = id;
      await chrome.storage.local.set({
        [STORAGE_KEY_USER_ID]: id,
        [STORAGE_KEY_FETCHED_AT]: now
      });
      debugLog("fetched id:", id, "timestamp:", new Date(now).toISOString());
    } finally {
      initPromise = null;
    }
  })();
  return initPromise;
}

/**
 * Returns the current Blackboard user id (cached or after init).
 * @returns {Promise<string>}
 * @throws {UserNotAuthenticatedError} when not logged in
 * @throws {Error} on other failures
 */
export async function getCurrentUserId() {
  if (cachedUserId) return cachedUserId;
  await initUserIdentity();
  if (cachedUserId) return cachedUserId;
  throw new UserNotAuthenticatedError("Open Blackboard in a tab and ensure you're logged in, then retry.");
}

/**
 * Clear cached user id and storage (for debugging / logout).
 */
export async function clearUserIdentity() {
  initPromise = null;
  cachedUserId = null;
  await chrome.storage.local.remove([STORAGE_KEY_USER_ID, STORAGE_KEY_FETCHED_AT]);
  debugLog("clearUserIdentity done");
}
