/**
 * Announcements module — sync and cache announcements for all courses.
 * Single public function: syncAllAnnouncements().
 * Does not modify calendar, syllabus, gradebook, or any other existing feature.
 */
(function (global) {
  "use strict";

  /**
   * Syncs announcements for all enrolled courses and caches the result.
   * Uses the extension message flow: SYNC_ANNOUNCEMENTS is handled by background → content script.
   * @returns {Promise<{ ok: boolean, data?: Array<{ courseId: string, courseName: string, announcements: Array, error?: string }>, error?: string }>}
   */
  function syncAllAnnouncements() {
    return new Promise((resolve, reject) => {
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
        reject(new Error("Extension context unavailable"));
        return;
      }
      chrome.runtime.sendMessage({ type: "SYNC_ANNOUNCEMENTS" }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "SYNC_ANNOUNCEMENTS failed"));
          return;
        }
        if (res?.ok) {
          resolve({ ok: true, data: res.data || [], errors: res.errors || [] });
        } else {
          resolve({ ok: false, error: res?.error || "Sync failed", data: res?.data || [], errors: res?.errors || [] });
        }
      });
    });
  }

  /**
   * Gets cached announcements from storage (no fetch).
   * @returns {Promise<{ ok: boolean, data?: Array, syncedAt?: number }>}
   */
  function getCachedAnnouncements() {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
        resolve({ ok: false, data: [], syncedAt: null });
        return;
      }
      chrome.runtime.sendMessage({ type: "GET_ANNOUNCEMENTS" }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, data: [], syncedAt: null });
          return;
        }
        resolve({
          ok: res?.ok ?? false,
          data: res?.data || [],
          syncedAt: res?.syncedAt ?? null
        });
      });
    });
  }

  global.Announcements = {
    syncAllAnnouncements,
    getCachedAnnouncements
  };
})(typeof window !== "undefined" ? window : this);
