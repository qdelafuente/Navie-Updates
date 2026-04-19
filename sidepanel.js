const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const STORAGE_API_KEY = "openrouterApiKey";
const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";
const BLACKBOARD_BASE = "https://blackboard.ie.edu";
const CHAT_DEFAULT_PLACEHOLDER = "Prompt here";
const SURVEY_GATE_POLL_MS = 15000;

// ─── Consent system ───────────────────────────────────────────────────────────
const CONSENT_STORAGE_KEY = "navieConsent";
const CURRENT_POLICY_VERSION = "1.0";
const PRIVACY_POLICY_URL = "[PENDIENTE — URL de la política de privacidad]";

// ─── Sync preferences ─────────────────────────────────────────────────────────
const SYNC_PREFS_KEY = "syncPreferences";
const DEFAULT_SYNC_PREFS = { syllabi: true, gradebook: true, announcements: true, messages: false, calendar: true };

/**
 * Returns the stored consent object or null if none exists.
 */
async function getStoredConsent() {
  try {
    const data = await chrome.storage.local.get(CONSENT_STORAGE_KEY);
    return data[CONSENT_STORAGE_KEY] ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * Returns true if the user has given valid consent for the current policy version.
 */
async function hasValidConsent() {
  const consent = await getStoredConsent();
  return consent?.given === true && consent?.version === CURRENT_POLICY_VERSION;
}

/**
 * Persists a consent record with timestamp and policy version.
 */
async function saveConsent(given) {
  await chrome.storage.local.set({
    [CONSENT_STORAGE_KEY]: {
      given,
      date: new Date().toISOString(),
      version: CURRENT_POLICY_VERSION,
      privacyPolicyUrl: PRIVACY_POLICY_URL
    }
  });
}

/**
 * Reads stored consent and updates the status indicator in the Settings panel.
 */
/**
 * Clears all local data: chrome.storage, IndexedDB PDF blobs, and in-memory state.
 * Returns a Promise that resolves when everything is wiped.
 */
async function deleteAllUserData() {
  await chrome.storage.local.clear();
  await new Promise((resolve) => {
    const req = indexedDB.open("jarvis_syllabus_pdfs", 1);
    req.onerror = () => resolve();
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("pdf_blobs")) { db.close(); resolve(); return; }
      const tx = db.transaction("pdf_blobs", "readwrite");
      tx.objectStore("pdf_blobs").clear();
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    };
  });
  chatHistory = [];
  syllabiListCache = [];
  syllabiCategoryByCourseId = {};
  resolutionLogLines = [];
  gradesDebugLoaded = false;
}

async function loadSyncPrefs() {
  try {
    const data = await chrome.storage.local.get(SYNC_PREFS_KEY);
    return Object.assign({}, DEFAULT_SYNC_PREFS, data[SYNC_PREFS_KEY] || {});
  } catch (_) {
    return { ...DEFAULT_SYNC_PREFS };
  }
}

async function saveSyncPrefs(prefs) {
  await chrome.storage.local.set({ [SYNC_PREFS_KEY]: prefs });
}

async function updateConsentStatusIndicator() {
  if (!consentStatusRow) return;
  const consent = await getStoredConsent();
  const iconEl = consentStatusRow.querySelector(".consent-status-icon");
  const labelEl = consentStatusRow.querySelector(".consent-status-label");
  const metaEl = consentStatusRow.querySelector(".consent-status-meta");

  consentStatusRow.classList.remove("is-accepted", "is-declined");

  if (consent?.given === true) {
    consentStatusRow.classList.add("is-accepted");
    if (iconEl) iconEl.textContent = "";
    if (labelEl) labelEl.textContent = "Privacy consent accepted";
    if (metaEl) {
      const d = consent.date ? new Date(consent.date) : null;
      const dateStr = d ? d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";
      metaEl.textContent = "Policy v" + (consent.version || "—") + " · " + dateStr;
    }
    if (consentRevokeBtn) consentRevokeBtn.classList.remove("hidden");
  } else {
    consentStatusRow.classList.add("is-declined");
    if (iconEl) iconEl.textContent = "⚠️";
    if (labelEl) labelEl.textContent = "Consent not given";
    if (metaEl) metaEl.textContent = "Chat is disabled until consent is accepted";
    if (consentRevokeBtn) consentRevokeBtn.classList.add("hidden");
  }
}

/**
 * Shows the consent overlay and returns a Promise that resolves to true (accepted)
 * or false (declined) when the user makes a choice.
 */
function showConsentOverlay() {
  return new Promise((resolve) => {
    const overlay = document.getElementById("consentOverlay");
    const acceptBtn = document.getElementById("consentAcceptBtn");
    const declineBtn = document.getElementById("consentDeclineBtn");
    const privacyLink = document.getElementById("consentPrivacyLink");

    if (privacyLink) privacyLink.href = PRIVACY_POLICY_URL;

    if (overlay) {
      overlay.classList.remove("hidden");
      overlay.setAttribute("aria-hidden", "false");
    }

    function onAccept() {
      cleanup();
      if (overlay) {
        overlay.classList.add("hidden");
        overlay.setAttribute("aria-hidden", "true");
      }
      resolve(true);
    }

    function onDecline() {
      cleanup();
      if (overlay) {
        overlay.classList.add("hidden");
        overlay.setAttribute("aria-hidden", "true");
      }
      resolve(false);
    }

    function cleanup() {
      if (acceptBtn) acceptBtn.removeEventListener("click", onAccept);
      if (declineBtn) declineBtn.removeEventListener("click", onDecline);
    }

    if (acceptBtn) acceptBtn.addEventListener("click", onAccept);
    if (declineBtn) declineBtn.addEventListener("click", onDecline);
  });
}

/**
 * Shows the "consent declined" screen and wires the "Review consent" button
 * to re-show the consent overlay.
 * Returns a Promise that resolves to true when the user eventually accepts.
 */
function showConsentDeclinedScreen() {
  return new Promise((resolve) => {
    const screen = document.getElementById("consentDeclinedScreen");
    const retryBtn = document.getElementById("consentDeclinedRetryBtn");

    if (screen) {
      screen.classList.remove("hidden");
      screen.setAttribute("aria-hidden", "false");
    }

    async function onRetry() {
      if (retryBtn) retryBtn.removeEventListener("click", onRetry);
      if (screen) {
        screen.classList.add("hidden");
        screen.setAttribute("aria-hidden", "true");
      }
      const accepted = await showConsentOverlay();
      if (accepted) {
        resolve(true);
      } else {
        const againAccepted = await showConsentDeclinedScreen();
        resolve(againAccepted);
      }
    }

    if (retryBtn) retryBtn.addEventListener("click", onRetry);
  });
}

/**
 * Full consent gate: checks storage, shows overlay if needed.
 * Resolves when the user has valid consent (loops until they accept or close the panel).
 * Does NOT block — returns immediately if consent already exists.
 */
async function ensureConsent() {
  const valid = await hasValidConsent();
  if (valid) return;

  const accepted = await showConsentOverlay();
  if (accepted) {
    await saveConsent(true);
    return;
  }

  // User declined: show the declined screen and wait for them to retry.
  await showConsentDeclinedScreen();
  // When showConsentDeclinedScreen resolves, the user accepted via the retry flow.
  await saveConsent(true);
}
// ─── End of consent system ────────────────────────────────────────────────────

/** URL fija del syllabus: solo se sustituye course_id por el learnCourseId del curso. Usar SIEMPRE esta URL cuando pidan un syllabus. */
function buildSyllabusUrlForCourse(learnCourseId) {
  return `${BLACKBOARD_BASE}/webapps/blackboard/execute/blti/launchPlacement?blti_placement_id=_1218_1&course_id=${encodeURIComponent(learnCourseId)}&from_ultra=true`;
}

const syncCoursesBtn = document.getElementById("syncCoursesBtn");
const syncBtn = document.getElementById("syncBtn");
const syncStatus = document.getElementById("syncStatus");
const syncLogPre = document.getElementById("syncLogPre");
const panelToggleBtn = document.getElementById("panelToggleBtn");
const sidePanel = document.getElementById("sidePanel");
const sidePanelClose = document.getElementById("sidePanelClose");
const sidePanelBackdrop = document.getElementById("sidePanelBackdrop");
const announcementGateOverlay = document.getElementById("announcementGateOverlay");
const announcementGateTitle = document.getElementById("announcementGateTitle");
const announcementGateMeta = document.getElementById("announcementGateMeta");
const announcementGateScroll = document.getElementById("announcementGateScroll");
const announcementGateBody = document.getElementById("announcementGateBody");
const announcementGateHint = document.getElementById("announcementGateHint");
const announcementGateLink = document.getElementById("announcementGateLink");
const announcementGateContinue = document.getElementById("announcementGateContinue");
const surveyGateOverlay = document.getElementById("surveyGateOverlay");
const surveyGateBody = document.getElementById("surveyGateBody");
const surveyGateLink = document.getElementById("surveyGateLink");
const surveyGateRefresh = document.getElementById("surveyGateRefresh");
const panelTabAjustes = document.getElementById("panelTabAjustes");
const consentStatusRow = document.getElementById("consentStatus");
const consentRevokeBtn = document.getElementById("consentRevokeBtn");
const deleteAllDataBtn = document.getElementById("deleteAllDataBtn");
const checkUpdatesBtn = document.getElementById("checkUpdatesBtn");
const checkUpdatesStatus = document.getElementById("checkUpdatesStatus");
const syncPrefSyllabiEl = document.getElementById("syncPrefSyllabi");
const syncPrefGradebookEl = document.getElementById("syncPrefGradebook");
const syncPrefAnnouncementsEl = document.getElementById("syncPrefAnnouncements");
const syncPrefMessagesEl = document.getElementById("syncPrefMessages");
const syncPrefCalendarEl = document.getElementById("syncPrefCalendar");
const panelTabSyllabusTest = document.getElementById("panelTabSyllabusTest");
const panelTabLog = document.getElementById("panelTabLog");
const panelTabGradesDebug = document.getElementById("panelTabGradesDebug");
const settingsPanelContent = document.getElementById("settingsPanelContent");
const courseCategoriesPanelContent = document.getElementById("courseCategoriesPanelContent");
const syllabiPanelContent = document.getElementById("syllabiPanelContent");
const syllabiSearchInput = document.getElementById("syllabiSearchInput");
const syllabiListContainer = document.getElementById("syllabiListContainer");
const syllabusTestPanelContent = document.getElementById("syllabusTestPanelContent");
const syllabusTestCourseId = document.getElementById("syllabusTestCourseId");
const syllabusTestBtn = document.getElementById("syllabusTestBtn");
const syllabusTestStatus = document.getElementById("syllabusTestStatus");
const syllabusTestOut = document.getElementById("syllabusTestOut");
const syllabusTestSearch = document.getElementById("syllabusTestSearch");
const syllabusTestSearchCount = document.getElementById("syllabusTestSearchCount");
const logSearchInput = document.getElementById("logSearchInput");
const logSearchCount = document.getElementById("logSearchCount");
const logPanelContent = document.getElementById("logPanelContent");
const gradesDebugPanelContent = document.getElementById("gradesDebugPanelContent");
const gradesDebugLoadBtn = document.getElementById("gradesDebugLoadBtn");
const gradesDebugStatus = document.getElementById("gradesDebugStatus");
const gradesDebugOut = document.getElementById("gradesDebugOut");
const gradesDebugSearch = document.getElementById("gradesDebugSearch");
const gradesDebugSearchCount = document.getElementById("gradesDebugSearchCount");
const courseCategoriesStatus = document.getElementById("courseCategoriesStatus");
const courseCategoriesSemester = document.getElementById("courseCategoriesSemester");
const courseCategoriesList = document.getElementById("courseCategoriesList");
const panelTabSyllabusManager = document.getElementById("panelTabSyllabusManager");
const syllabusManagerPanelContent = document.getElementById("syllabusManagerPanelContent");
const syllabusManagerList = document.getElementById("syllabusManagerList");
const syllabusManagerSearch = document.getElementById("syllabusManagerSearch");
const syllabusManagerBanner = document.getElementById("syllabusManagerBanner");
const syllabusManagerFileInput = document.getElementById("syllabusManagerFileInput");
const panelTabAnnouncements = document.getElementById("panelTabAnnouncements");
const panelTabAssignments = document.getElementById("panelTabAssignments");
const panelTabMessages = document.getElementById("panelTabMessages");
const announcementsPanelContent = document.getElementById("announcementsPanelContent");
const assignmentsPanelContent = document.getElementById("assignmentsPanelContent");
const messagesPanelContent = document.getElementById("messagesPanelContent");
const announcementsSyncBtn = document.getElementById("announcementsSyncBtn");
const announcementsStatus = document.getElementById("announcementsStatus");
const announcementsListContainer = document.getElementById("announcementsListContainer");
const assignmentsListContainer = document.getElementById("assignmentsListContainer");
const messagesListContainer = document.getElementById("messagesListContainer");

let syllabiListCache = [];
let syllabiCategoryByCourseId = {};
const apiKeyInput = document.getElementById("apiKeyInput");
const saveKeyBtn = document.getElementById("saveKeyBtn");
const keySavedHint = document.getElementById("keySavedHint");
const themeSelect = document.getElementById("themeSelect");
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const clearChatBtn = document.getElementById("clearChatBtn");
const loadingOverlay = document.getElementById("loadingOverlay");
const chatMain = document.getElementById("chatMain");
const timeContextLine = document.getElementById("timeContextLine");
const timeContextUpdated = document.getElementById("timeContextUpdated");
const upcomingWidget = document.getElementById("upcomingWidget");
const upcomingWidgetList = document.getElementById("upcomingWidgetList");
const upcomingWidgetEmpty = document.getElementById("upcomingWidgetEmpty");
const upcomingWidgetLoading = document.getElementById("upcomingWidgetLoading");
const upcomingWidgetToggle = document.getElementById("upcomingWidgetToggle");
const upcomingWidgetToggleAssignments = document.getElementById("upcomingWidgetToggleAssignments");
const upcomingWidgetToggleAnnouncements = document.getElementById("upcomingWidgetToggleAnnouncements");
const upcomingWidgetToggleMessages = document.getElementById("upcomingWidgetToggleMessages");
const examDatesStatusDot = document.getElementById("examDatesStatusDot");

let upcomingWidgetMode = "assignments";

let chatHistory = [];
let timeContextRefreshTimer = null;
let resolutionLogLines = [];
let gradesDebugLoaded = false;
let announcementGateCurrent = null;
let announcementGatePollingTimer = null;
let announcementGatePollingInFlight = false;
let surveyGatePollingTimer = null;
let surveyGatePollingInFlight = false;
let surveyGateLocked = false;
let midtermDatesLoaded = false;
let finalDatesLoaded = false;

const REQUIRED_ANNOUNCEMENT = {
  id: "_196610_1",
  courseId: "_84110_1",
  title: "Final Exams"
};
const STORAGE_THEME = "jarvisTheme";

function updateExamDatesStatusDot() {
  if (!examDatesStatusDot) return;
  const ready = midtermDatesLoaded && finalDatesLoaded;
  examDatesStatusDot.classList.toggle("exam-dates-status--ready", ready);
  examDatesStatusDot.classList.toggle("exam-dates-status--loading", !ready);
  examDatesStatusDot.title = ready
    ? "Midterm and final dates are loaded"
    : "Loading midterm and final dates";
  examDatesStatusDot.setAttribute("aria-label", examDatesStatusDot.title);
}

function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function applyTheme(theme) {
  const safeTheme = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", safeTheme);
  if (themeSelect) themeSelect.value = safeTheme;
}

async function loadThemePreference() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_THEME);
    const theme = stored?.[STORAGE_THEME] === "light" ? "light" : "dark";
    applyTheme(theme);
    return theme;
  } catch (_) {
    applyTheme("dark");
    return "dark";
  }
}

// Receive low-level Blackboard fetch logs from the content script and show them in the Log tab.
// This lets you see, for each AI-assisted request, which GET URL was called and a sample of the JSON returned.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "BB_FETCH_LOG" && typeof msg.url === "string") {
    const line =
      "[BB_FETCH] " +
      msg.url +
      (typeof msg.sample === "string" && msg.sample
        ? "\n  sample: " + msg.sample
        : "");
    resolutionLogLines.push(line);
    renderResolutionLog();
  }
});

/** Actualiza y persiste el Time Context; refresca la UI. Devuelve el contexto actual. */
async function refreshTimeContext() {
  if (typeof window.TimeContext === "undefined") return null;
  const ctx = await window.TimeContext.persistNowContext();
  if (timeContextLine) {
    timeContextLine.textContent = ctx ? "Hora actual: " + ctx.localIso + " (" + ctx.timezone + ")" : "";
    timeContextLine.classList.toggle("empty", !ctx);
  }
  if (timeContextUpdated) {
    const updated = ctx?.epochMs ? new Date(ctx.epochMs).toLocaleString("sv-SE", { timeZone: ctx.timezone }) : "";
    timeContextUpdated.textContent = updated ? "Last updated: " + updated : "";
    timeContextUpdated.classList.toggle("empty", !updated);
  }
  return ctx;
}

/** Inicia el refresco automático cada 60s mientras el panel esté abierto. */
function startTimeContextRefreshInterval() {
  if (timeContextRefreshTimer) clearInterval(timeContextRefreshTimer);
  timeContextRefreshTimer = setInterval(refreshTimeContext, 60 * 1000);
}

/** True if we already have widget data (assignments or announcements) so we don't show the widget loading. */
async function hasWidgetDataCached() {
  const data = await getSyncData();
  if (data.gradebookByCourseId && Object.keys(data.gradebookByCourseId).length > 0) return true;
  try {
    const ann = await sendMessage({ type: "GET_ANNOUNCEMENTS" });
    const list = ann?.data || [];
    if (list.some((g) => !g.error && (g.announcements || []).length > 0)) return true;
  } catch (_) {}
  return false;
}

async function getSyncData() {
  const res = await sendMessage({ type: "GET_SYLLABI" });
  if (!res?.ok) {
    return {
      syllabi: [],
      coursesByCourseId: {},
      courseIdByNormalizedName: {},
      coursesList: [],
      gradebookColumns: [],
      gradebookByCourseId: {},
      syncLog: []
    };
  }
  return {
    syllabi: res.syllabi || [],
    coursesByCourseId: res.coursesByCourseId || {},
    courseIdByNormalizedName: res.courseIdByNormalizedName || {},
    coursesList: res.coursesList || [],
    gradebookColumns: res.gradebookColumns || [],
    gradebookByCourseId: res.gradebookByCourseId || {},
    syncLog: res.syncLog || []
  };
}

/** Returns a User Profile block for the AI system prompt, or "" if no profile. */
async function getUserProfileBlock() {
  const res = await sendMessage({ type: "GET_USER_PROFILE" });
  if (!res?.ok || !res?.profile || typeof res.profile !== "object") return "";
  const p = res.profile;
  const fullName = p.fullName != null ? p.fullName : "not available";
  const givenName = p.givenName != null ? p.givenName : "not available";
  const familyName = p.familyName != null ? p.familyName : "not available";
  const email = p.email != null ? p.email : "not available";
  const studentId = p.studentId != null ? p.studentId : "not available";
  const userId = p.userId != null ? p.userId : "not available";
  const lines = [
    "[USER_PROFILE]",
    "Full name: " + fullName,
    "Given name: " + givenName,
    "Family name: " + familyName,
    "Email: " + email,
    "Student ID: " + studentId,
    "Blackboard User ID: " + userId,
    "",
    "Rules: If the user asks for their name, email, or student ID, answer ONLY from the values above. Use the same language as the user. If a value is 'not available', say it is not available; do not guess."
  ];
  return lines.join("\n");
}

/** True if the user is asking for their name, email, or student ID (answer must come from GET_USER_PROFILE). */
function isProfileIdentityQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  return (
    /\b(?:what('s| is)|whats)\s+my\s+name\??/i.test(t) ||
    /\b(?:what('s| is)|whats)\s+my\s+email\??/i.test(t) ||
    /\b(?:what('s| is)|whats)\s+my\s+student\s+id\??/i.test(t) ||
    /\b(?:tell\s+me\s+)?my\s+(?:name|email|student\s+id)\s*\??$/i.test(t) ||
    /\b(?:what('s| is)|whats)\s+(?:my\s+)?(?:full\s+)?name\??/i.test(t)
  );
}

/** Returns the answer string for name/email/student ID from profile data (from GET_USER_PROFILE). */
function getProfileIdentityAnswer(text, profile) {
  if (!profile || typeof profile !== "object") return "Your profile could not be loaded. Make sure Blackboard is open and you are logged in.";
  const t = (text || "").toLowerCase();
  const fullName = profile.fullName != null ? String(profile.fullName).trim() : null;
  const email = profile.email != null ? String(profile.email).trim() : null;
  const studentId = profile.studentId != null ? String(profile.studentId).trim() : null;
  const nameVal = fullName || "not available";
  const emailVal = email || "not available";
  const studentIdVal = studentId || "not available";
  if (/\b(?:student\s+id|studentid)\b/i.test(t)) return "Your student ID is " + studentIdVal + ".";
  if (/\bemail\b/i.test(t)) return "Your email is " + emailVal + ".";
  if (/\bname\b/i.test(t)) return "Your name is " + nameVal + ".";
  return "Your name is " + nameVal + ", your email is " + emailVal + ", and your student ID is " + studentIdVal + ".";
}

/**
 * Paso C — Resuelve curso desde lo que escribe el usuario.
 * Devuelve { learnCourseId, name } o null. Añade log de resolución.
 */
function resolveCourseForPrompt(userText, courseIdByNormalizedName, coursesByCourseId) {
  if (!userText || !courseIdByNormalizedName || !coursesByCourseId || Object.keys(courseIdByNormalizedName).length === 0) return null;
  if (typeof window.CourseRegistry !== "undefined" && window.CourseRegistry.resolveCourse) {
    const result = window.CourseRegistry.resolveCourse(userText, courseIdByNormalizedName, coursesByCourseId);
    if (result.learnCourseId && result.meta) {
      resolutionLogLines.push(result.log || "Resolved '" + userText.trim() + "' → " + result.meta.name + " (" + result.learnCourseId + ")");
      renderResolutionLog();
      return { learnCourseId: result.learnCourseId, name: result.meta.name };
    }
    if (result.suggestions && result.suggestions.length) {
      resolutionLogLines.push((result.log || "") + " Sugerencias: " + result.suggestions.join(", "));
      renderResolutionLog();
    }
    return null;
  }
  const normalized = (typeof window.CourseRegistry !== "undefined" && window.CourseRegistry.normalizeCourseName)
    ? window.CourseRegistry.normalizeCourseName(userText) : userText.trim().toLowerCase();
  const keys = Object.keys(courseIdByNormalizedName);
  let bestId = null;
  let bestKey = null;
  for (const key of keys) {
    if (key.includes(normalized) || normalized.includes(key)) {
      if (!bestKey || key.length > bestKey.length) {
        bestKey = key;
        bestId = courseIdByNormalizedName[key];
      }
    }
  }
  if (!bestId) return null;
  const meta = coursesByCourseId[bestId];
  resolutionLogLines.push("Resolved '" + userText.trim() + "' → " + (meta?.name || bestKey) + " (" + bestId + ")");
  renderResolutionLog();
  return { learnCourseId: bestId, name: meta?.name ?? bestKey };
}

function getCourseSuggestionsForText(userText, courseIdByNormalizedName, coursesByCourseId, limit) {
  const max = Math.max(1, Number(limit) || 3);
  try {
    if (typeof window.CourseRegistry !== "undefined" && window.CourseRegistry.resolveCourse) {
      const result = window.CourseRegistry.resolveCourse(userText, courseIdByNormalizedName, coursesByCourseId);
      if (result && Array.isArray(result.suggestions)) {
        return result.suggestions.filter(Boolean).slice(0, max);
      }
    }
  } catch (_) {}
  const names = Object.values(coursesByCourseId || {})
    .map((c) => c && c.name)
    .filter(Boolean)
    .slice(0, max);
  return names;
}

function isNonCriticalCourseResolutionMessage(text) {
  if (!text || typeof text !== "string") return false;
  return (
    /course\s+was\s+not\s+found/i.test(text) ||
    /could(?:n't| not)\s+(?:identify|confidently\s+identify)\s+the\s+course/i.test(text) ||
    /please\s+(?:specify|mention)\s+the\s+course\s+name/i.test(text) ||
    /check\s+the\s+name\s+or\s+sync\s+again/i.test(text)
  );
}

function resolveCourseForMessages(userText, courseIdByNormalizedName, coursesByCourseId) {
  if (!userText || !courseIdByNormalizedName || !coursesByCourseId) return null;

  const fallback = resolveCourseForPrompt(userText, courseIdByNormalizedName, coursesByCourseId);
  if (fallback) return fallback;

  const normalize =
    typeof window.CourseRegistry !== "undefined" && typeof window.CourseRegistry.normalizeCourseName === "function"
      ? window.CourseRegistry.normalizeCourseName
      : (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

  const normalizedText = normalize(userText);
  if (!normalizedText) return null;

  const variants = Object.keys(courseIdByNormalizedName || {})
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const variant of variants) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|\\W)${escaped}(\\W|$)`, "i");
    if (!re.test(normalizedText)) continue;
    const learnCourseId = courseIdByNormalizedName[variant];
    const meta = coursesByCourseId[learnCourseId];
    if (!learnCourseId || !meta) continue;
    resolutionLogLines.push("Resolved messages course from text → " + meta.name + " (" + learnCourseId + ") [substring]");
    renderResolutionLog();
    return { learnCourseId, name: meta.name };
  }

  return null;
}

function applyLogSearchToText(fullText) {
  if (!syncLogPre) return;
  const q = (logSearchInput && logSearchInput.value || "").trim().toLowerCase();
  if (!q) {
    syncLogPre.textContent = fullText || "";
    if (logSearchCount) logSearchCount.textContent = "";
    return;
  }
  const lines = (fullText || "").split("\n");
  const filtered = lines.filter((line) => line.toLowerCase().includes(q));
  syncLogPre.textContent = filtered.join("\n") || "(No matches in log)";
  if (logSearchCount) {
    const n = filtered.length;
    logSearchCount.textContent = n === 0 ? "0 matches" : (n === 1 ? "1 match" : n + " matches");
  }
}

function renderSyncLog(lines) {
  if (!syncLogPre) return;
  const base = lines.length ? lines.join("\n") : "";
  syncLogPre.dataset.syncLines = base;
  const resolution = resolutionLogLines.length ? resolutionLogLines.join("\n") : "";
  const full = resolution ? (base ? base + "\n" + resolution : resolution) : base;
  applyLogSearchToText(full);
}

function renderResolutionLog() {
  if (!syncLogPre) return;
  const base = syncLogPre.dataset.syncLines || "";
  const resolution = resolutionLogLines.length ? resolutionLogLines.join("\n") : "";
  const full = resolution ? (base ? base + "\n" + resolution : resolution) : base;
  applyLogSearchToText(full);
}

function setSyncStatus(text) {
  syncStatus.textContent = text;
}

if (syncCoursesBtn) {
  syncCoursesBtn.addEventListener("click", async () => {
    setSyncStatus("Syncing courses...");
    syncCoursesBtn.disabled = true;
    try {
      const res = await sendMessage({ type: "SYNC_COURSES" });
      if (!res?.ok) {
        setSyncStatus("Error: " + (res?.error || "unknown"));
        renderSyncLog(res?.log || []);
        return;
      }
      const logLines = res.log || [];
      setSyncStatus("Courses: " + (res.count || 0) + " saved. Click «Sync syllabi» for syllabi and gradebook.");
      renderSyncLog(logLines);
      if (syncLogPre) syncLogPre.dataset.syncLines = logLines.join("\n");
      await refreshTimeContext();
    } finally {
      syncCoursesBtn.disabled = false;
    }
  });
}

syncBtn.addEventListener("click", async () => {
  setSyncStatus("Syncing syllabi...");
  syncBtn.disabled = true;
  resolutionLogLines = [];
  try {
    const res = await sendMessage({ type: "SYNC_SYLLABI" });
    if (!res?.ok) {
      setSyncStatus("Error: " + (res?.error || "unknown"));
      renderSyncLog(res?.log || []);
      return;
    }
    const logLines = res.log || [];
    setSyncStatus("Done (" + res.count + " syllabi). Ask for a syllabus or assignments.");
    renderSyncLog(logLines);
    if (syncLogPre) syncLogPre.dataset.syncLines = logLines.join("\n");
    await refreshTimeContext();
    refreshUpcomingWidget();
  } finally {
    syncBtn.disabled = false;
  }
});

if (logSearchInput) {
  logSearchInput.addEventListener("input", () => {
    renderResolutionLog();
  });
}

if (panelTabGradesDebug) {
  panelTabGradesDebug.addEventListener("click", () => showPanelTab("gradesDebug"));
}

if (gradesDebugLoadBtn) {
  gradesDebugLoadBtn.addEventListener("click", async () => {
    if (gradesDebugLoaded) {
      if (gradesDebugStatus) gradesDebugStatus.textContent = "Already loaded (reload extension to fetch again).";
      return;
    }
    if (gradesDebugStatus) gradesDebugStatus.textContent = "Loading grades page…";
    try {
      const res = await sendMessage({ type: "GET_GRADES_PAGE_DEBUG" });
      if (!res?.ok) {
        if (gradesDebugStatus) gradesDebugStatus.textContent = res?.error || "Could not fetch grades page.";
        return;
      }
      gradesDebugLoaded = true;
      if (gradesDebugStatus) gradesDebugStatus.textContent = "Loaded. Showing full HTML response.";
      if (gradesDebugOut) {
        gradesDebugOut.dataset.fullHtml = res.html || "";
        applyGradesDebugSearch();
      }
    } catch (e) {
      if (gradesDebugStatus) gradesDebugStatus.textContent = e?.message || "Error fetching grades page.";
    }
  });
}

function applyGradesDebugSearch() {
  if (!gradesDebugOut) return;
  const full = gradesDebugOut.dataset.fullHtml || "";
  const q = (gradesDebugSearch && gradesDebugSearch.value || "").trim().toLowerCase();
  if (!q) {
    gradesDebugOut.textContent = full || "(Empty response)";
    if (gradesDebugSearchCount) gradesDebugSearchCount.textContent = "";
    return;
  }
  const lines = full.split("\n");
  const filtered = lines.filter((line) => line.toLowerCase().includes(q));
  gradesDebugOut.textContent = filtered.join("\n") || "(No matches in HTML)";
  if (gradesDebugSearchCount) {
    const n = filtered.length;
    gradesDebugSearchCount.textContent = n === 0 ? "0 matches" : (n === 1 ? "1 match" : n + " matches");
  }
}

if (gradesDebugSearch) {
  gradesDebugSearch.addEventListener("input", () => applyGradesDebugSearch());
}

function openSidePanel() {
  if (sidePanel) sidePanel.classList.add("open");
  if (sidePanelBackdrop) sidePanelBackdrop.classList.remove("hidden");
  showPanelTab(null);
}
function closeSidePanel() {
  if (sidePanel) sidePanel.classList.remove("open");
  if (sidePanelBackdrop) sidePanelBackdrop.classList.add("hidden");
}
function showPanelTab(tab) {
  const showAjustes = tab === "ajustes";
  const showCourseCategories = tab === "courseCategories";
  const showMidtermSessions = tab === "midtermSessions";
  const showMidtermDates = tab === "midtermDates";
  const showFinalsSessions = tab === "finalsSessions";
  const showFinalDates = tab === "finalDates";
  const showSyllabusTextLog = tab === "syllabusTextLog";
  const showAnnouncementsTextLog = tab === "announcementsTextLog";
  const showMessagesTextLog = tab === "messagesTextLog";
  const showSyllabi = tab === "syllabi";
  const showSyllabusManager = tab === "syllabusManager";
  const showSyllabusTest = tab === "syllabusTest";
  const showGradesDebug = tab === "gradesDebug";
  const showLog = tab === "log";
  const showAnnouncements = tab === "announcements";
  const showAssignments = tab === "assignments";
  const showMessages = tab === "messages";
  if (settingsPanelContent) settingsPanelContent.classList.toggle("hidden", !showAjustes);
  if (courseCategoriesPanelContent) courseCategoriesPanelContent.classList.toggle("hidden", !showCourseCategories);
  if (midtermSessionsPanelContent) midtermSessionsPanelContent.classList.toggle("hidden", !showMidtermSessions);
  if (midtermDatesPanelContent) midtermDatesPanelContent.classList.toggle("hidden", !showMidtermDates);
  if (finalsSessionsPanelContent) finalsSessionsPanelContent.classList.toggle("hidden", !showFinalsSessions);
  if (finalDatesPanelContent) finalDatesPanelContent.classList.toggle("hidden", !showFinalDates);
  if (syllabusTextLogPanelContent) syllabusTextLogPanelContent.classList.toggle("hidden", !showSyllabusTextLog);
  if (announcementsTextLogPanelContent) announcementsTextLogPanelContent.classList.toggle("hidden", !showAnnouncementsTextLog);
  if (messagesTextLogPanelContent) messagesTextLogPanelContent.classList.toggle("hidden", !showMessagesTextLog);
  if (syllabiPanelContent) syllabiPanelContent.classList.toggle("hidden", !showSyllabi);
  if (syllabusManagerPanelContent) syllabusManagerPanelContent.classList.toggle("hidden", !showSyllabusManager);
  if (syllabusTestPanelContent) syllabusTestPanelContent.classList.toggle("hidden", !showSyllabusTest);
  if (gradesDebugPanelContent) gradesDebugPanelContent.classList.toggle("hidden", !showGradesDebug);
  if (logPanelContent) logPanelContent.classList.toggle("hidden", !showLog);
  if (announcementsPanelContent) announcementsPanelContent.classList.toggle("hidden", !showAnnouncements);
  if (assignmentsPanelContent) assignmentsPanelContent.classList.toggle("hidden", !showAssignments);
  if (messagesPanelContent) messagesPanelContent.classList.toggle("hidden", !showMessages);
  if (syllabiAccessBtn) syllabiAccessBtn.classList.toggle("active", showSyllabi);
  if (panelTabAjustes) panelTabAjustes.classList.toggle("active", showAjustes);
  if (panelTabSyllabusManager) panelTabSyllabusManager.classList.toggle("active", showSyllabusManager);
  if (panelTabSyllabusTest) panelTabSyllabusTest.classList.toggle("active", showSyllabusTest);
  if (panelTabGradesDebug) panelTabGradesDebug.classList.toggle("active", showGradesDebug);
  if (panelTabLog) panelTabLog.classList.toggle("active", showLog);
  if (panelTabAnnouncements) panelTabAnnouncements.classList.toggle("active", showAnnouncements);
  if (panelTabAssignments) panelTabAssignments.classList.toggle("active", showAssignments);
  if (panelTabMessages) panelTabMessages.classList.toggle("active", showMessages);
  if (panelTabCourseCategories) panelTabCourseCategories.classList.toggle("active", showCourseCategories);
  if (panelTabMidtermSessions) panelTabMidtermSessions.classList.toggle("active", showMidtermSessions);
  if (panelTabMidtermDates) panelTabMidtermDates.classList.toggle("active", showMidtermDates);
  if (panelTabFinalsSessions) panelTabFinalsSessions.classList.toggle("active", showFinalsSessions);
  if (panelTabFinalDates) panelTabFinalDates.classList.toggle("active", showFinalDates);
  if (panelTabSyllabusTextLog) panelTabSyllabusTextLog.classList.toggle("active", showSyllabusTextLog);
  if (panelTabAnnouncementsTextLog) panelTabAnnouncementsTextLog.classList.toggle("active", showAnnouncementsTextLog);
  if (panelTabMessagesTextLog) panelTabMessagesTextLog.classList.toggle("active", showMessagesTextLog);
  if (showSyllabi && syllabiListContainer) renderSyllabiList();
  if (showSyllabusManager && syllabusManagerList) renderSyllabusManagerList();
  if (showAnnouncements && announcementsListContainer) renderAnnouncementsList();
  if (showAssignments && assignmentsListContainer) renderAssignmentsList();
  if (showMessages && messagesListContainer) renderMessagesList();
  if (showCourseCategories && courseCategoriesList) renderCourseCategoriesList();
  if (showMidtermSessions && midtermSessionsList) renderMidtermSessionsList();
  if (showMidtermDates && midtermDatesList) renderMidtermDatesList();
  if (showFinalsSessions && finalsSessionsList) renderFinalsSessionsList();
  if (showFinalDates && finalDatesList) renderFinalDatesList();
  if (showSyllabusTextLog && syllabusTextLogList) renderSyllabusTextLogList();
  if (showAnnouncementsTextLog && announcementsTextLogList) renderAnnouncementsTextLogList();
  if (showMessagesTextLog && messagesTextLogList) renderMessagesTextLogList();
}

function renderSyllabiListFiltered(list, query, categoryByCourseId) {
  if (!syllabiListContainer) return;
  syllabiListContainer.innerHTML = "";
  const q = (query || "").trim().toLowerCase();
  const filtered = q
    ? list.filter((c) => {
        const name = (c.name || c.learnCourseId || c.courseId || "").toLowerCase();
        const id = (c.learnCourseId || c.courseId || "").toLowerCase();
        return name.includes(q) || id.includes(q);
      })
    : list;
  /** Only Q1 and Q2 count as courses with a syllabus; Annual, Organizations, Other are excluded. */
  const syllabusCategories = ["Q1", "Q2"];
  const filteredWithSyllabus = filtered.filter((c) => {
    const key = c.learnCourseId || c.courseId || "";
    const cat = categoryByCourseId && key ? categoryByCourseId[key] : null;
    return cat && syllabusCategories.includes(cat);
  });
  if (filteredWithSyllabus.length === 0) {
    syllabiListContainer.innerHTML =
      '<p class="syllabi-list-empty">' +
      (q ? "No Q1/Q2 course matches the search." : "Only Q1 and Q2 courses are shown. Sync courses and open Course categories to load classifications.") +
      "</p>";
    return;
  }
  const byCategory = { Q1: [], Q2: [] };
  for (const c of filteredWithSyllabus) {
    const key = c.learnCourseId || c.courseId || "";
    const cat = categoryByCourseId && key ? categoryByCourseId[key] : null;
    if (cat === "Q1" || cat === "Q2") byCategory[cat].push(c);
  }
  const order = [["Q1", "Q1"], ["Q2", "Q2"]];
  for (const [key, label] of order) {
    const group = byCategory[key] || [];
    if (!group.length) continue;
    const groupDiv = document.createElement("div");
    groupDiv.className = "course-category-group";
    const h = document.createElement("h3");
    h.className = "course-category-heading";
    h.textContent = label + " (" + group.length + ")";
    groupDiv.appendChild(h);
    group
      .slice()
      .sort((a, b) => (a.name || a.learnCourseId || "").localeCompare(b.name || b.learnCourseId || ""))
      .forEach((c) => {
        const learnCourseId = c.learnCourseId || c.courseId;
        const name = c.name || learnCourseId || "Curso";
        if (!learnCourseId) return;
        const a = document.createElement("a");
        a.href = buildSyllabusUrlForCourse(learnCourseId);
        a.target = "_blank";
        a.rel = "noopener";
        a.className = "syllabi-list-btn";
        a.textContent = name;
        groupDiv.appendChild(a);
      });
    syllabiListContainer.appendChild(groupDiv);
  }
}

async function renderSyllabiList() {
  if (!syllabiListContainer) return;
  const data = await getSyncData();
  const list = data.coursesList || [];
  syllabiListCache = list;
  const query = syllabiSearchInput ? syllabiSearchInput.value : "";
  syllabiCategoryByCourseId = {};
  try {
    const res = await sendMessage({ type: "GET_COURSE_CATEGORIES" });
    if (res?.ok && Array.isArray(res.items)) {
      for (const m of res.items) {
        const cid = m?.courseId;
        if (cid) syllabiCategoryByCourseId[cid] = m.category || "OTHER";
      }
    }
  } catch (_) {
    syllabiCategoryByCourseId = {};
  }
  renderSyllabiListFiltered(list, query, syllabiCategoryByCourseId);
}

if (syllabiSearchInput) {
  syllabiSearchInput.addEventListener("input", () =>
    renderSyllabiListFiltered(syllabiListCache, syllabiSearchInput.value, syllabiCategoryByCourseId)
  );
}

if (panelToggleBtn) panelToggleBtn.addEventListener("click", openSidePanel);
if (sidePanelClose) sidePanelClose.addEventListener("click", closeSidePanel);
if (sidePanelBackdrop) sidePanelBackdrop.addEventListener("click", closeSidePanel);
if (panelTabAjustes) panelTabAjustes.addEventListener("click", () => { showPanelTab("ajustes"); updateConsentStatusIndicator(); initSyncPrefsUI(); });
if (consentRevokeBtn) consentRevokeBtn.addEventListener("click", async () => {
  await saveConsent(false);
  updateConsentStatusIndicator();
  ensureConsent();
});
if (checkUpdatesBtn) checkUpdatesBtn.addEventListener("click", async () => {
  checkUpdatesBtn.disabled = true;
  checkUpdatesBtn.textContent = "Checking...";
  checkUpdatesStatus.style.display = "none";

  try {
    const res = await sendMessage({ type: "CHECK_FOR_UPDATES" });
    if (res?.updateAvailable) {
      checkUpdatesStatus.textContent = `✓ Nueva versión disponible: v${res.newVersion}. Abriendo página de actualización...`;
      checkUpdatesStatus.style.color = "#2e7d32";
    } else if (res?.upToDate) {
      checkUpdatesStatus.textContent = `✓ Ya tienes la última versión (v${res.currentVersion}).`;
      checkUpdatesStatus.style.color = "#555";
    } else {
      checkUpdatesStatus.textContent = "No se pudo comprobar. Verifica tu conexión.";
      checkUpdatesStatus.style.color = "#c0392b";
    }
  } catch {
    checkUpdatesStatus.textContent = "Error al comprobar actualizaciones.";
    checkUpdatesStatus.style.color = "#c0392b";
  }

  checkUpdatesStatus.style.display = "block";
  checkUpdatesBtn.disabled = false;
  checkUpdatesBtn.textContent = "Check for updates";
});

if (deleteAllDataBtn) deleteAllDataBtn.addEventListener("click", async () => {
  const confirmed = confirm("¿Seguro? Esto borrará todos tus datos locales incluyendo syllabi subidos, cursos sincronizados y configuración.");
  if (!confirmed) return;
  await deleteAllUserData();
  updateConsentStatusIndicator();
  ensureConsent();
});

async function initSyncPrefsUI() {
  const prefs = await loadSyncPrefs();
  if (syncPrefSyllabiEl) syncPrefSyllabiEl.checked = !!prefs.syllabi;
  if (syncPrefGradebookEl) syncPrefGradebookEl.checked = !!prefs.gradebook;
  if (syncPrefAnnouncementsEl) syncPrefAnnouncementsEl.checked = !!prefs.announcements;
  if (syncPrefMessagesEl) syncPrefMessagesEl.checked = !!prefs.messages;
  if (syncPrefCalendarEl) syncPrefCalendarEl.checked = !!prefs.calendar;
}

async function onSyncPrefChange() {
  await saveSyncPrefs({
    syllabi: !!syncPrefSyllabiEl?.checked,
    gradebook: !!syncPrefGradebookEl?.checked,
    announcements: !!syncPrefAnnouncementsEl?.checked,
    messages: !!syncPrefMessagesEl?.checked,
    calendar: !!syncPrefCalendarEl?.checked
  });
}

[syncPrefSyllabiEl, syncPrefGradebookEl, syncPrefAnnouncementsEl, syncPrefMessagesEl, syncPrefCalendarEl].forEach((el) => {
  if (el) el.addEventListener("change", onSyncPrefChange);
});

if (panelTabSyllabusManager) panelTabSyllabusManager.addEventListener("click", () => showPanelTab("syllabusManager"));
if (panelTabSyllabusTest) panelTabSyllabusTest.addEventListener("click", () => showPanelTab("syllabusTest"));
if (panelTabLog) panelTabLog.addEventListener("click", () => showPanelTab("log"));
if (panelTabAnnouncements) panelTabAnnouncements.addEventListener("click", () => showPanelTab("announcements"));
if (panelTabAssignments) panelTabAssignments.addEventListener("click", () => showPanelTab("assignments"));
if (panelTabMessages) panelTabMessages.addEventListener("click", () => showPanelTab("messages"));
const panelTabCourseCategories = document.getElementById("panelTabCourseCategories");
const panelTabMidtermSessions = document.getElementById("panelTabMidtermSessions");
const panelTabMidtermDates = document.getElementById("panelTabMidtermDates");
const panelTabFinalsSessions = document.getElementById("panelTabFinalsSessions");
const panelTabFinalDates = document.getElementById("panelTabFinalDates");
const midtermSessionsPanelContent = document.getElementById("midtermSessionsPanelContent");
const midtermDatesPanelContent = document.getElementById("midtermDatesPanelContent");
const finalsSessionsPanelContent = document.getElementById("finalsSessionsPanelContent");
const finalDatesPanelContent = document.getElementById("finalDatesPanelContent");
const midtermSessionsList = document.getElementById("midtermSessionsList");
const midtermDatesList = document.getElementById("midtermDatesList");
const finalsSessionsList = document.getElementById("finalsSessionsList");
const finalDatesList = document.getElementById("finalDatesList");
const midtermSessionsRefreshBtn = document.getElementById("midtermSessionsRefreshBtn");
const midtermDatesRefreshBtn = document.getElementById("midtermDatesRefreshBtn");
const finalsSessionsRefreshBtn = document.getElementById("finalsSessionsRefreshBtn");
const finalDatesRefreshBtn = document.getElementById("finalDatesRefreshBtn");
const midtermSessionsStatus = document.getElementById("midtermSessionsStatus");
const midtermDatesStatus = document.getElementById("midtermDatesStatus");
const finalsSessionsStatus = document.getElementById("finalsSessionsStatus");
const finalDatesStatus = document.getElementById("finalDatesStatus");
const panelTabSyllabusTextLog = document.getElementById("panelTabSyllabusTextLog");
const panelTabAnnouncementsTextLog = document.getElementById("panelTabAnnouncementsTextLog");
const panelTabMessagesTextLog = document.getElementById("panelTabMessagesTextLog");
const syllabusTextLogPanelContent = document.getElementById("syllabusTextLogPanelContent");
const announcementsTextLogPanelContent = document.getElementById("announcementsTextLogPanelContent");
const messagesTextLogPanelContent = document.getElementById("messagesTextLogPanelContent");
const syllabusTextLogList = document.getElementById("syllabusTextLogList");
const announcementsTextLogList = document.getElementById("announcementsTextLogList");
const messagesTextLogList = document.getElementById("messagesTextLogList");
const announcementsTextLogSearch = document.getElementById("announcementsTextLogSearch");
const messagesTextLogSearch = document.getElementById("messagesTextLogSearch");
const announcementsTextLogPre = document.getElementById("announcementsTextLogPre");
const announcementsTextLogTitle = document.getElementById("announcementsTextLogTitle");
const announcementsTextLogCopyBtn = document.getElementById("announcementsTextLogCopyBtn");
const messagesTextLogPre = document.getElementById("messagesTextLogPre");
const messagesTextLogTitle = document.getElementById("messagesTextLogTitle");
const messagesTextLogCopyBtn = document.getElementById("messagesTextLogCopyBtn");
const syllabusTextLogSearch = document.getElementById("syllabusTextLogSearch");
const syllabusTextLogPre = document.getElementById("syllabusTextLogPre");
const syllabusTextLogTitle = document.getElementById("syllabusTextLogTitle");
const syllabusTextLogCopyBtn = document.getElementById("syllabusTextLogCopyBtn");
if (panelTabCourseCategories) panelTabCourseCategories.addEventListener("click", () => showPanelTab("courseCategories"));
if (panelTabMidtermSessions) panelTabMidtermSessions.addEventListener("click", () => showPanelTab("midtermSessions"));
if (panelTabMidtermDates) panelTabMidtermDates.addEventListener("click", () => showPanelTab("midtermDates"));
if (panelTabFinalsSessions) panelTabFinalsSessions.addEventListener("click", () => showPanelTab("finalsSessions"));
if (panelTabFinalDates) panelTabFinalDates.addEventListener("click", () => showPanelTab("finalDates"));
if (panelTabSyllabusTextLog) panelTabSyllabusTextLog.addEventListener("click", () => showPanelTab("syllabusTextLog"));
if (panelTabAnnouncementsTextLog) panelTabAnnouncementsTextLog.addEventListener("click", () => showPanelTab("announcementsTextLog"));
if (panelTabMessagesTextLog) panelTabMessagesTextLog.addEventListener("click", () => showPanelTab("messagesTextLog"));
const syllabiAccessBtn = document.getElementById("syllabiAccessBtn");
if (syllabiAccessBtn) syllabiAccessBtn.addEventListener("click", () => showPanelTab("syllabi"));

let syllabusManagerData = { coursesList: [], statuses: {}, uploads: {} };
let syllabusManagerUploadCourseId = null;

let syllabusTextLogCache = [];
let syllabusTextLogCategoryByCourseId = {};

function renderSyllabusTextLogListFiltered(list, query, categoryByCourseId) {
  if (!syllabusTextLogList) return;
  const q = (query || "").trim().toLowerCase();
  const filtered = q
    ? list.filter((c) => {
        const name = (c.name || c.learnCourseId || c.courseId || "").toLowerCase();
        const id = (c.learnCourseId || c.courseId || "").toLowerCase();
        return name.includes(q) || id.includes(q);
      })
    : list;
  const syllabusCategories = ["Q1", "Q2"];
  const filteredWithSyllabus = filtered.filter((c) => {
    const key = c.learnCourseId || c.courseId || "";
    const cat = categoryByCourseId && key ? categoryByCourseId[key] : null;
    return cat && syllabusCategories.includes(cat);
  });
  if (filteredWithSyllabus.length === 0) {
    syllabusTextLogList.innerHTML =
      '<p class="announcements-list-empty">' +
      (q ? "No Q1/Q2 course matches the search." : "Sync courses and open Course categories to load classifications.") +
      "</p>";
    return;
  }
  syllabusTextLogList.innerHTML = "";
  const byCategory = { Q1: [], Q2: [] };
  for (const c of filteredWithSyllabus) {
    const key = c.learnCourseId || c.courseId || "";
    const cat = categoryByCourseId && key ? categoryByCourseId[key] : null;
    if (cat === "Q1" || cat === "Q2") byCategory[cat].push(c);
  }
  for (const [key, label] of [["Q1", "Q1"], ["Q2", "Q2"]]) {
    const group = (byCategory[key] || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    if (!group.length) continue;
    const groupDiv = document.createElement("div");
    groupDiv.className = "course-category-group";
    const h = document.createElement("h3");
    h.className = "course-category-heading";
    h.textContent = label + " (" + group.length + ")";
    groupDiv.appendChild(h);
    for (const c of group) {
      const learnCourseId = c.learnCourseId || c.courseId;
      const name = c.name || learnCourseId || "Course";
      if (!learnCourseId) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-sync syllabi-list-btn syllabus-text-log-btn";
      btn.textContent = name;
      btn.dataset.courseId = learnCourseId;
      btn.dataset.courseName = name;
      btn.addEventListener("click", () => loadSyllabusTextForLog(learnCourseId, name));
      groupDiv.appendChild(btn);
    }
    syllabusTextLogList.appendChild(groupDiv);
  }
}

async function renderSyllabusTextLogList() {
  if (!syllabusTextLogList) return;
  syllabusTextLogList.innerHTML = "<p class=\"announcements-list-empty\">Loading courses…</p>";
  const data = await getSyncData();
  const list = data.coursesList || [];
  syllabusTextLogCache = list;
  syllabusTextLogCategoryByCourseId = {};
  try {
    const res = await sendMessage({ type: "GET_COURSE_CATEGORIES" });
    if (res?.ok && Array.isArray(res.items)) {
      for (const m of res.items) {
        const cid = m?.courseId;
        if (cid) syllabusTextLogCategoryByCourseId[cid] = m.category || "OTHER";
      }
    }
  } catch (_) {
    syllabusTextLogCategoryByCourseId = {};
  }
  const query = syllabusTextLogSearch ? syllabusTextLogSearch.value : "";
  renderSyllabusTextLogListFiltered(list, query, syllabusTextLogCategoryByCourseId);
}

async function loadSyllabusTextForLog(courseId, courseName) {
  if (!syllabusTextLogPre || !syllabusTextLogTitle) return;
  syllabusTextLogPre.textContent = "Loading…";
  syllabusTextLogTitle.textContent = courseName || courseId;
  if (syllabusTextLogCopyBtn) {
    syllabusTextLogCopyBtn.classList.add("hidden");
  }
  try {
    const r = await sendMessage({ type: "GET_SYLLABUS_RAW_TEXT", courseId, courseName });
    if (r?.ok) {
      syllabusTextLogPre.textContent = r.rawText || "(Empty)";
      syllabusTextLogTitle.textContent = (courseName || courseId) + " — " + (r.source || "");
      if (syllabusTextLogCopyBtn) syllabusTextLogCopyBtn.classList.remove("hidden");
    } else {
      syllabusTextLogPre.textContent = (r?.error || "Error") + (r?.source ? "\n\nSource: " + r.source : "");
    }
  } catch (e) {
    syllabusTextLogPre.textContent = "Error: " + (e?.message || e);
  }
}

if (syllabusTextLogSearch) {
  syllabusTextLogSearch.addEventListener("input", () =>
    renderSyllabusTextLogListFiltered(syllabusTextLogCache, syllabusTextLogSearch.value, syllabusTextLogCategoryByCourseId)
  );
}

if (syllabusTextLogCopyBtn) {
  syllabusTextLogCopyBtn.addEventListener("click", () => {
    if (syllabusTextLogPre && syllabusTextLogPre.textContent && syllabusTextLogPre.textContent !== "—" && syllabusTextLogPre.textContent !== "Loading…") {
      navigator.clipboard.writeText(syllabusTextLogPre.textContent).then(() => {
        syllabusTextLogCopyBtn.textContent = "Copied!";
        setTimeout(() => { syllabusTextLogCopyBtn.textContent = "Copy"; }, 1500);
      }).catch(() => {});
    }
  });
}

let announcementsTextLogCache = [];
let announcementsTextLogCategoryByCourseId = {};

function renderAnnouncementsTextLogListFiltered(list, query, categoryByCourseId) {
  if (!announcementsTextLogList) return;
  const q = (query || "").trim().toLowerCase();
  const filtered = q
    ? list.filter((c) => {
        const name = (c.name || c.learnCourseId || c.courseId || "").toLowerCase();
        const id = (c.learnCourseId || c.courseId || "").toLowerCase();
        return name.includes(q) || id.includes(q);
      })
    : list;
  const syllabusCategories = ["Q1", "Q2"];
  const filteredWithSyllabus = filtered.filter((c) => {
    const key = c.learnCourseId || c.courseId || "";
    const cat = categoryByCourseId && key ? categoryByCourseId[key] : null;
    return cat && syllabusCategories.includes(cat);
  });
  if (filteredWithSyllabus.length === 0) {
    announcementsTextLogList.innerHTML =
      '<p class="announcements-list-empty">' +
      (q ? "No Q1/Q2 course matches the search." : "Sync courses and open Course categories to load classifications.") +
      "</p>";
    return;
  }
  announcementsTextLogList.innerHTML = "";
  const byCategory = { Q1: [], Q2: [] };
  for (const c of filteredWithSyllabus) {
    const key = c.learnCourseId || c.courseId || "";
    const cat = categoryByCourseId && key ? categoryByCourseId[key] : null;
    if (cat === "Q1" || cat === "Q2") byCategory[cat].push(c);
  }
  for (const [key, label] of [["Q1", "Q1"], ["Q2", "Q2"]]) {
    const group = (byCategory[key] || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    if (!group.length) continue;
    const groupDiv = document.createElement("div");
    groupDiv.className = "course-category-group";
    const h = document.createElement("h3");
    h.className = "course-category-heading";
    h.textContent = label + " (" + group.length + ")";
    groupDiv.appendChild(h);
    for (const c of group) {
      const learnCourseId = c.learnCourseId || c.courseId;
      const name = c.name || learnCourseId || "Course";
      if (!learnCourseId) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-sync syllabi-list-btn syllabus-text-log-btn";
      btn.textContent = name;
      btn.dataset.courseId = learnCourseId;
      btn.dataset.courseName = name;
      btn.addEventListener("click", () => loadAnnouncementsTextForLog(learnCourseId, name));
      groupDiv.appendChild(btn);
    }
    announcementsTextLogList.appendChild(groupDiv);
  }
}

async function renderAnnouncementsTextLogList() {
  if (!announcementsTextLogList) return;
  announcementsTextLogList.innerHTML = "<p class=\"announcements-list-empty\">Loading courses…</p>";
  const data = await getSyncData();
  const list = data.coursesList || [];
  announcementsTextLogCache = list;
  announcementsTextLogCategoryByCourseId = {};
  try {
    const res = await sendMessage({ type: "GET_COURSE_CATEGORIES" });
    if (res?.ok && Array.isArray(res.items)) {
      for (const m of res.items) {
        const cid = m?.courseId;
        if (cid) announcementsTextLogCategoryByCourseId[cid] = m.category || "OTHER";
      }
    }
  } catch (_) {
    announcementsTextLogCategoryByCourseId = {};
  }
  const query = announcementsTextLogSearch ? announcementsTextLogSearch.value : "";
  renderAnnouncementsTextLogListFiltered(list, query, announcementsTextLogCategoryByCourseId);
}

async function loadAnnouncementsTextForLog(courseId, courseName) {
  if (!announcementsTextLogPre || !announcementsTextLogTitle) return;
  announcementsTextLogPre.textContent = "Loading…";
  announcementsTextLogTitle.textContent = courseName || courseId;
  if (announcementsTextLogCopyBtn) announcementsTextLogCopyBtn.classList.add("hidden");
  try {
    const r = await sendMessage({ type: "GET_ANNOUNCEMENTS_RAW_TEXT", courseId, courseName });
    if (r?.ok) {
      announcementsTextLogPre.textContent = r.rawText || "(No announcements)";
      announcementsTextLogTitle.textContent = (courseName || courseId) + " — " + (r.count ?? 0) + " announcements";
      if (announcementsTextLogCopyBtn) announcementsTextLogCopyBtn.classList.remove("hidden");
    } else {
      announcementsTextLogPre.textContent = (r?.error || "Error");
    }
  } catch (e) {
    announcementsTextLogPre.textContent = "Error: " + (e?.message || e);
  }
}

if (announcementsTextLogSearch) {
  announcementsTextLogSearch.addEventListener("input", () =>
    renderAnnouncementsTextLogListFiltered(announcementsTextLogCache, announcementsTextLogSearch.value, announcementsTextLogCategoryByCourseId)
  );
}

if (announcementsTextLogCopyBtn) {
  announcementsTextLogCopyBtn.addEventListener("click", () => {
    if (announcementsTextLogPre && announcementsTextLogPre.textContent && announcementsTextLogPre.textContent !== "—" && announcementsTextLogPre.textContent !== "Loading…") {
      navigator.clipboard.writeText(announcementsTextLogPre.textContent).then(() => {
        announcementsTextLogCopyBtn.textContent = "Copied!";
        setTimeout(() => { announcementsTextLogCopyBtn.textContent = "Copy"; }, 1500);
      }).catch(() => {});
    }
  });
}

let messagesTextLogCache = [];
let messagesTextLogCategoryByCourseId = {};

function renderMessagesTextLogListFiltered(list, query, categoryByCourseId) {
  if (!messagesTextLogList) return;
  const q = (query || "").trim().toLowerCase();
  const filtered = q
    ? list.filter((c) => {
        const name = (c.name || c.learnCourseId || c.courseId || "").toLowerCase();
        const id = (c.learnCourseId || c.courseId || "").toLowerCase();
        return name.includes(q) || id.includes(q);
      })
    : list;
  const syllabusCategories = ["Q1", "Q2"];
  const filteredWithSyllabus = filtered.filter((c) => {
    const key = c.learnCourseId || c.courseId || "";
    const cat = categoryByCourseId && key ? categoryByCourseId[key] : null;
    return cat && syllabusCategories.includes(cat);
  });
  if (filteredWithSyllabus.length === 0) {
    messagesTextLogList.innerHTML =
      '<p class="announcements-list-empty">' +
      (q ? "No Q1/Q2 course matches the search." : "Sync courses and open Course categories to load classifications.") +
      "</p>";
    return;
  }
  messagesTextLogList.innerHTML = "";
  const byCategory = { Q1: [], Q2: [] };
  for (const c of filteredWithSyllabus) {
    const key = c.learnCourseId || c.courseId || "";
    const cat = categoryByCourseId && key ? categoryByCourseId[key] : null;
    if (cat === "Q1" || cat === "Q2") byCategory[cat].push(c);
  }
  for (const [key, label] of [["Q1", "Q1"], ["Q2", "Q2"]]) {
    const group = (byCategory[key] || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    if (!group.length) continue;
    const groupDiv = document.createElement("div");
    groupDiv.className = "course-category-group";
    const h = document.createElement("h3");
    h.className = "course-category-heading";
    h.textContent = label + " (" + group.length + ")";
    groupDiv.appendChild(h);
    for (const c of group) {
      const learnCourseId = c.learnCourseId || c.courseId;
      const name = c.name || learnCourseId || "Course";
      if (!learnCourseId) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-sync syllabi-list-btn syllabus-text-log-btn";
      btn.textContent = name;
      btn.dataset.courseId = learnCourseId;
      btn.dataset.courseName = name;
      btn.addEventListener("click", () => loadMessagesTextForLog(learnCourseId, name));
      groupDiv.appendChild(btn);
    }
    messagesTextLogList.appendChild(groupDiv);
  }
}

async function renderMessagesTextLogList() {
  if (!messagesTextLogList) return;
  messagesTextLogList.innerHTML = "<p class=\"announcements-list-empty\">Loading courses…</p>";
  const data = await getSyncData();
  const list = data.coursesList || [];
  messagesTextLogCache = list;
  messagesTextLogCategoryByCourseId = {};
  try {
    const res = await sendMessage({ type: "GET_COURSE_CATEGORIES" });
    if (res?.ok && Array.isArray(res.items)) {
      for (const m of res.items) {
        const cid = m?.courseId;
        if (cid) messagesTextLogCategoryByCourseId[cid] = m.category || "OTHER";
      }
    }
  } catch (_) {
    messagesTextLogCategoryByCourseId = {};
  }
  const query = messagesTextLogSearch ? messagesTextLogSearch.value : "";
  renderMessagesTextLogListFiltered(list, query, messagesTextLogCategoryByCourseId);
}

async function loadMessagesTextForLog(courseId, courseName) {
  if (!messagesTextLogPre || !messagesTextLogTitle) return;
  messagesTextLogPre.textContent = "Loading…";
  messagesTextLogTitle.textContent = courseName || courseId;
  if (messagesTextLogCopyBtn) messagesTextLogCopyBtn.classList.add("hidden");
  try {
    const r = await sendMessage({ type: "GET_MESSAGES_RAW_TEXT", courseId, courseName });
    if (r?.ok) {
      messagesTextLogPre.textContent = r.rawText || "(No messages)";
      messagesTextLogTitle.textContent = (courseName || courseId) + " — " + (r.count ?? 0) + " messages";
      if (messagesTextLogCopyBtn) messagesTextLogCopyBtn.classList.remove("hidden");
    } else {
      messagesTextLogPre.textContent = (r?.error || "Error");
    }
  } catch (e) {
    messagesTextLogPre.textContent = "Error: " + (e?.message || e);
  }
}

if (messagesTextLogSearch) {
  messagesTextLogSearch.addEventListener("input", () =>
    renderMessagesTextLogListFiltered(messagesTextLogCache, messagesTextLogSearch.value, messagesTextLogCategoryByCourseId)
  );
}

if (messagesTextLogCopyBtn) {
  messagesTextLogCopyBtn.addEventListener("click", () => {
    if (messagesTextLogPre && messagesTextLogPre.textContent && messagesTextLogPre.textContent !== "—" && messagesTextLogPre.textContent !== "Loading…") {
      navigator.clipboard.writeText(messagesTextLogPre.textContent).then(() => {
        messagesTextLogCopyBtn.textContent = "Copied!";
        setTimeout(() => { messagesTextLogCopyBtn.textContent = "Copy"; }, 1500);
      }).catch(() => {});
    }
  });
}

async function renderMidtermSessionsList() {
  if (!midtermSessionsList) return;
  if (midtermSessionsStatus) midtermSessionsStatus.textContent = "";
  midtermSessionsList.innerHTML = "<p class=\"announcements-list-empty\">Loading…</p>";
  try {
    const res = await sendMessage({ type: "GET_MIDTERM_SESSIONS" });
    if (!res?.ok) {
      midtermSessionsList.innerHTML =
        '<p class="announcements-list-empty">' + (res?.error || "Could not load. Open Blackboard and sync courses.") + "</p>";
      if (midtermSessionsStatus) midtermSessionsStatus.textContent = "";
      return;
    }
    const items = res.items || [];
    const semester = res.semester || "";
    const semesterLabel = res.currentSemester === "second" ? "Q2 (Second)" : "Q1 (First)";
    if (midtermSessionsStatus) midtermSessionsStatus.textContent = semester ? "Semester: " + semesterLabel + " · " + items.length + " courses" : "";

    if (items.length === 0) {
      midtermSessionsList.innerHTML =
        '<p class="announcements-list-empty">No courses in current semester. Sync courses and open Course categories.</p>';
      return;
    }

    const ul = document.createElement("ul");
    ul.className = "announcements-list midterm-sessions-ul";
    for (const it of items) {
      const li = document.createElement("li");
      li.className = "midterm-sessions-item";
      const sessionStr = it.midterm_session != null
        ? "Session " + it.midterm_session
        : it.midterm_date != null
          ? it.midterm_date + (it.midterm_time ? " " + it.midterm_time : "")
          : "—";
      const confStr = it.confidence > 0 ? " (" + (it.confidence * 100).toFixed(0) + "%)" : "";
      const srcStr = it.source && it.source !== "none" ? " · " + it.source : "";
      const candStr = it.candidates?.length ? " · Alt: " + it.candidates.join(", ") : "";
      const syllabusIdStr = it.courseId ? " · Syllabus ID: " + it.courseId : "";
      const line = it.courseName + " — " + sessionStr + confStr + srcStr + syllabusIdStr + candStr;
      li.innerHTML = "<span class=\"midterm-sessions-line\">" + escapeHtml(line) + "</span>";
      if (it.reason && it.reason !== "—") {
        const reasonEl = document.createElement("span");
        reasonEl.className = "midterm-sessions-reason";
        reasonEl.textContent = it.reason;
        li.appendChild(reasonEl);
      }
      if (it.evidence?.length) {
        const evWrap = document.createElement("details");
        evWrap.className = "midterm-sessions-evidence";
        evWrap.innerHTML = "<summary>Evidence</summary>";
        const evPre = document.createElement("pre");
        evPre.textContent = it.evidence.map((e) => (e.source ? "[" + e.source + "] " : "") + (e.text || "")).join("\n\n---\n\n");
        evWrap.appendChild(evPre);
        li.appendChild(evWrap);
      }
      ul.appendChild(li);
    }
    midtermSessionsList.innerHTML = "";
    midtermSessionsList.appendChild(ul);
  } catch (e) {
    midtermSessionsList.innerHTML =
      '<p class="announcements-list-empty">Error: ' + (e?.message || e) + "</p>";
    if (midtermSessionsStatus) midtermSessionsStatus.textContent = "";
  }
}

if (midtermSessionsRefreshBtn) {
  midtermSessionsRefreshBtn.addEventListener("click", () => {
    if (midtermSessionsStatus) midtermSessionsStatus.textContent = "Loading…";
    renderMidtermSessionsList();
  });
}

async function renderFinalsSessionsList() {
  if (!finalsSessionsList) return;
  if (finalsSessionsStatus) finalsSessionsStatus.textContent = "";
  finalsSessionsList.innerHTML = "<p class=\"announcements-list-empty\">Loading…</p>";
  try {
    const res = await sendMessage({ type: "GET_FINAL_SESSIONS" });
    if (!res?.ok) {
      finalsSessionsList.innerHTML =
        '<p class="announcements-list-empty">' + (res?.error || "Could not load. Open Blackboard and sync courses.") + "</p>";
      if (finalsSessionsStatus) finalsSessionsStatus.textContent = "";
      return;
    }
    const items = res.items || [];
    const semester = res.semester || "";
    const semesterLabel = res.currentSemester === "second" ? "Q2 (Second)" : "Q1 (First)";
    if (finalsSessionsStatus) finalsSessionsStatus.textContent = semester ? "Semester: " + semesterLabel + " · " + items.length + " courses" : "";

    if (items.length === 0) {
      finalsSessionsList.innerHTML =
        '<p class="announcements-list-empty">No courses in current semester. Sync courses and open Course categories.</p>';
      return;
    }

    const ul = document.createElement("ul");
    ul.className = "announcements-list finals-sessions-ul";
    for (const it of items) {
      const li = document.createElement("li");
      li.className = "finals-sessions-item";
      const sessionStr = it.final_session != null
        ? "Session " + it.final_session
        : it.final_date != null
          ? it.final_date + (it.final_time ? " " + it.final_time : "")
          : "—";
      const confStr = it.confidence > 0 ? " (" + (it.confidence * 100).toFixed(0) + "%)" : "";
      const srcStr = it.source && it.source !== "none" ? " · " + it.source : "";
      const candStr = it.candidates?.length ? " · Alt: " + it.candidates.join(", ") : "";
      const syllabusIdStr = it.courseId ? " · Syllabus ID: " + it.courseId : "";
      const line = it.courseName + " — " + sessionStr + confStr + srcStr + syllabusIdStr + candStr;
      li.innerHTML = "<span class=\"finals-sessions-line\">" + escapeHtml(line) + "</span>";
      if (it.reason && it.reason !== "—") {
        const reasonEl = document.createElement("span");
        reasonEl.className = "finals-sessions-reason";
        reasonEl.textContent = it.reason;
        li.appendChild(reasonEl);
      }
      if (it.evidence?.length) {
        const evWrap = document.createElement("details");
        evWrap.className = "finals-sessions-evidence";
        evWrap.innerHTML = "<summary>Evidence</summary>";
        const evPre = document.createElement("pre");
        evPre.textContent = it.evidence.map((e) => (e.source ? "[" + e.source + "] " : "") + (e.text || "")).join("\n\n---\n\n");
        evWrap.appendChild(evPre);
        li.appendChild(evWrap);
      }
      ul.appendChild(li);
    }
    finalsSessionsList.innerHTML = "";
    finalsSessionsList.appendChild(ul);
  } catch (e) {
    finalsSessionsList.innerHTML =
      '<p class="announcements-list-empty">Error: ' + (e?.message || e) + "</p>";
    if (finalsSessionsStatus) finalsSessionsStatus.textContent = "";
  }
}

if (finalsSessionsRefreshBtn) {
  finalsSessionsRefreshBtn.addEventListener("click", () => {
    if (finalsSessionsStatus) finalsSessionsStatus.textContent = "Loading…";
    renderFinalsSessionsList();
  });
}

async function renderMidtermDatesList() {
  if (!midtermDatesList) return;
  midtermDatesLoaded = false;
  updateExamDatesStatusDot();
  if (midtermDatesStatus) midtermDatesStatus.textContent = "";
  midtermDatesList.innerHTML = "<p class=\"announcements-list-empty\">Loading…</p>";
  try {
    const res = await sendMessage({ type: "GET_MIDTERM_DATES" });
    if (!res?.ok) {
      midtermDatesList.innerHTML =
        '<p class="announcements-list-empty">' + (res?.error || "Could not load. Open Blackboard and sync courses.") + "</p>";
      if (midtermDatesStatus) midtermDatesStatus.textContent = "";
      return;
    }
    midtermDatesLoaded = true;
    updateExamDatesStatusDot();
    const items = res.items || [];
    const semester = res.semester || "";
    const semesterLabel = res.currentSemester === "second" ? "Q2 (Second)" : "Q1 (First)";
    let statusText = semester ? "Semester: " + semesterLabel + " · " + items.length + " courses" : "";
    if (res.updatedAt != null) {
      const d = new Date(res.updatedAt);
      statusText += (statusText ? " · " : "") + "Last updated: " + d.toLocaleString() + (res.fromCache ? " (cached)" : "");
    }
    if (midtermDatesStatus) midtermDatesStatus.textContent = statusText;

    if (items.length === 0) {
      midtermDatesList.innerHTML =
        '<p class="announcements-list-empty">No courses in current semester. Sync courses and open Course categories.</p>';
      return;
    }

    const ul = document.createElement("ul");
    ul.className = "announcements-list midterm-dates-ul";
    for (const it of items) {
      const li = document.createElement("li");
      li.className = "midterm-dates-item";
      const sessionStr = it.midterm_session != null ? "Session " + it.midterm_session : "—";
      const dateStr = it.midterm_date != null
        ? it.midterm_date + (it.midterm_time ? " " + it.midterm_time : "") + (it.timezone ? " " + it.timezone : "")
        : "—";
      const calendarBadge = it.calendar_inferred ? " · <span class=\"midterm-dates-calendar-badge\">date from calendar</span>" : "";
      const line = it.courseName + " — " + sessionStr + " · " + dateStr + calendarBadge;
      li.innerHTML = "<span class=\"midterm-dates-line\">" + escapeHtml(it.courseName) + " — " + escapeHtml(sessionStr) + " · " + escapeHtml(dateStr) + "</span>" + (it.calendar_inferred ? " <span class=\"midterm-dates-calendar-badge\">date from calendar</span>" : "");
      if (it.reason && it.reason !== "—") {
        const reasonEl = document.createElement("span");
        reasonEl.className = "midterm-dates-reason";
        reasonEl.textContent = it.reason;
        li.appendChild(reasonEl);
      }
      if (it.calendar_match && it.calendar_match.matched && it.calendar_match.title) {
        const calEl = document.createElement("span");
        calEl.className = "midterm-dates-calendar-match";
        calEl.textContent = "Calendar: " + it.calendar_match.title;
        li.appendChild(calEl);
      }
      if (it.evidence?.length) {
        const evWrap = document.createElement("details");
        evWrap.className = "midterm-dates-evidence";
        evWrap.innerHTML = "<summary>Evidence</summary>";
        const evPre = document.createElement("pre");
        evPre.textContent = it.evidence.map((e) => (e.source ? "[" + e.source + "] " : "") + (e.text || "")).join("\n\n---\n\n");
        evWrap.appendChild(evPre);
        li.appendChild(evWrap);
      }
      ul.appendChild(li);
    }
    midtermDatesList.innerHTML = "";
    midtermDatesList.appendChild(ul);
  } catch (e) {
    midtermDatesList.innerHTML =
      '<p class="announcements-list-empty">Error: ' + (e?.message || e) + "</p>";
    if (midtermDatesStatus) midtermDatesStatus.textContent = "";
    updateExamDatesStatusDot();
  }
}

if (midtermDatesRefreshBtn) {
  midtermDatesRefreshBtn.addEventListener("click", () => {
    if (midtermDatesStatus) midtermDatesStatus.textContent = "Loading…";
    renderMidtermDatesList();
  });
}

async function renderFinalDatesList() {
  if (!finalDatesList) return;
  finalDatesLoaded = false;
  updateExamDatesStatusDot();
  if (finalDatesStatus) finalDatesStatus.textContent = "";
  finalDatesList.innerHTML = "<p class=\"announcements-list-empty\">Loading…</p>";
  try {
    const res = await sendMessage({ type: "GET_FINAL_DATES" });
    if (!res?.ok) {
      finalDatesList.innerHTML =
        '<p class="announcements-list-empty">' + (res?.error || "Could not load. Open Blackboard and sync courses.") + "</p>";
      if (finalDatesStatus) finalDatesStatus.textContent = "";
      return;
    }
    finalDatesLoaded = true;
    updateExamDatesStatusDot();
    const items = res.items || [];
    const semester = res.semester || "";
    const semesterLabel = res.currentSemester === "second" ? "Q2 (Second)" : "Q1 (First)";
    let statusText = semester ? "Semester: " + semesterLabel + " · " + items.length + " courses" : "";
    if (res.updatedAt != null) {
      const d = new Date(res.updatedAt);
      statusText += (statusText ? " · " : "") + "Last updated: " + d.toLocaleString() + (res.fromCache ? " (cached)" : "");
    }
    if (finalDatesStatus) finalDatesStatus.textContent = statusText;

    if (items.length === 0) {
      finalDatesList.innerHTML =
        '<p class="announcements-list-empty">No courses in current semester. Sync courses and open Course categories.</p>';
      return;
    }

    const ul = document.createElement("ul");
    ul.className = "announcements-list final-dates-ul";
    for (const it of items) {
      const li = document.createElement("li");
      li.className = "final-dates-item";
      const sessionStr = it.final_session != null ? "Session " + it.final_session : "—";
      const dateStr = it.final_date != null
        ? it.final_date + (it.final_time ? " " + it.final_time : "") + (it.timezone ? " " + it.timezone : "")
        : "—";
      li.innerHTML = "<span class=\"final-dates-line\">" + escapeHtml(it.courseName) + " — " + escapeHtml(sessionStr) + " · " + escapeHtml(dateStr) + "</span>" + (it.calendar_inferred ? " <span class=\"final-dates-calendar-badge\">date from calendar</span>" : "");
      if (it.reason && it.reason !== "—") {
        const reasonEl = document.createElement("span");
        reasonEl.className = "final-dates-reason";
        reasonEl.textContent = it.reason;
        li.appendChild(reasonEl);
      }
      if (it.calendar_match && it.calendar_match.matched && it.calendar_match.title) {
        const calEl = document.createElement("span");
        calEl.className = "final-dates-calendar-match";
        calEl.textContent = "Calendar: " + it.calendar_match.title;
        li.appendChild(calEl);
      }
      if (it.evidence?.length) {
        const evWrap = document.createElement("details");
        evWrap.className = "final-dates-evidence";
        evWrap.innerHTML = "<summary>Evidence</summary>";
        const evPre = document.createElement("pre");
        evPre.textContent = it.evidence.map((e) => (e.source ? "[" + e.source + "] " : "") + (e.text || "")).join("\n\n---\n\n");
        evWrap.appendChild(evPre);
        li.appendChild(evWrap);
      }
      ul.appendChild(li);
    }
    finalDatesList.innerHTML = "";
    finalDatesList.appendChild(ul);
  } catch (e) {
    finalDatesList.innerHTML =
      '<p class="announcements-list-empty">Error: ' + (e?.message || e) + "</p>";
    if (finalDatesStatus) finalDatesStatus.textContent = "";
    updateExamDatesStatusDot();
  }
}

if (finalDatesRefreshBtn) {
  finalDatesRefreshBtn.addEventListener("click", () => {
    if (finalDatesStatus) finalDatesStatus.textContent = "Loading…";
    renderFinalDatesList();
  });
}

async function renderCourseCategoriesList() {
  if (!courseCategoriesList) return;
  courseCategoriesList.innerHTML =
    '<p class="announcements-list-empty">Loading course categories…</p>';
  if (courseCategoriesStatus) courseCategoriesStatus.textContent = "";
  if (courseCategoriesSemester) courseCategoriesSemester.textContent = "";
  try {
    const res = await sendMessage({ type: "GET_COURSE_CATEGORIES" });
    if (!res?.ok) {
      courseCategoriesList.innerHTML =
        '<p class="announcements-list-empty">Could not load course categories. Open Blackboard in a tab and make sure you are logged in.</p>';
      if (courseCategoriesStatus) courseCategoriesStatus.textContent = res?.error || "";
      if (courseCategoriesSemester) courseCategoriesSemester.textContent = "";
      return;
    }
    const items = Array.isArray(res.items) ? res.items : [];
    const totals = res.totals || { Q1: 0, Q2: 0, ANNUAL: 0, ORGANIZATION_COMMUNITY: 0, OTHER: 0 };
    if (courseCategoriesSemester && (res.currentSemester === "first" || res.currentSemester === "second")) {
      courseCategoriesSemester.textContent =
        "Current semester: " + (res.currentSemester === "first" ? "First" : "Second");
    }
    if (courseCategoriesStatus) {
      courseCategoriesStatus.textContent =
        "Q1: " +
        totals.Q1 +
        " · Q2: " +
        totals.Q2 +
        " · Annual: " +
        totals.ANNUAL +
        " · Organizations: " +
        totals.ORGANIZATION_COMMUNITY +
        " · Other: " +
        totals.OTHER;
    }
    if (items.length === 0) {
      courseCategoriesList.innerHTML =
        '<p class="announcements-list-empty">No courses found for your Blackboard account.</p>';
      if (courseCategoriesSemester) courseCategoriesSemester.textContent = "";
      return;
    }
    const byCategory = {
      Q1: [],
      Q2: [],
      ANNUAL: [],
      ORGANIZATION_COMMUNITY: [],
      OTHER: []
    };
    for (const m of items) {
      const cat = m?.category && byCategory[m.category] ? m.category : "OTHER";
      byCategory[cat].push(m);
    }
    const order = [
      ["Q1", "Q1"],
      ["Q2", "Q2"],
      ["ANNUAL", "Annual"],
      ["ORGANIZATION_COMMUNITY", "Organizations / Communities"],
      ["OTHER", "Other"]
    ];
    courseCategoriesList.innerHTML = "";
    for (const [key, label] of order) {
      const list = byCategory[key] || [];
      if (!list.length) continue;
      const section = document.createElement("div");
      section.className = "announcements-course-block announcements-course-block--collapsed";

      const header = document.createElement("button");
      header.type = "button";
      header.className = "announcements-course-header";
      header.setAttribute("aria-expanded", "false");

      const headerText = document.createElement("span");
      headerText.className = "announcements-course-name";
      headerText.textContent = label + " (" + list.length + ")";

      const chevron = document.createElement("span");
      chevron.className = "announcements-course-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.textContent = "▶";

      header.appendChild(headerText);
      header.appendChild(chevron);
      header.addEventListener("click", () => {
        const collapsed = section.classList.toggle("announcements-course-block--collapsed");
        header.setAttribute("aria-expanded", String(!collapsed));
        chevron.textContent = collapsed ? "▶" : "▼";
      });

      section.appendChild(header);

      const listWrap = document.createElement("div");
      listWrap.className = "announcements-course-list";
      const ul = document.createElement("ul");
      ul.className = "announcements-item-list";

      list
        .slice()
        .sort((a, b) => (a.courseDisplayName || "").localeCompare(b.courseDisplayName || ""))
        .forEach((m) => {
          const li = document.createElement("li");
          li.className = "announcements-item";
          const name = m.courseDisplayName || m.courseId || "Course";
          const id = m.courseId || "";
          const term = m.termName || "";
          const url = m.externalAccessUrl || null;
          const available = m.isAvailable !== false;

          const titleSpan = document.createElement("span");
          titleSpan.className = "announcements-item-title";
          titleSpan.textContent = name + (id ? " (" + id + ")" : "");

          const metaSpan = document.createElement("span");
          metaSpan.className = "announcements-item-meta";
          metaSpan.textContent = term || (available ? "" : "Unavailable");

          if (!available) {
            metaSpan.classList.add("course-category-badge-unavailable");
          }

          if (url) {
            const link = document.createElement("a");
            link.href = url;
            link.target = "_blank";
            link.rel = "noopener";
            link.className = "announcements-item-link";
            link.appendChild(titleSpan);
            link.appendChild(metaSpan);
            li.appendChild(link);
          } else {
            li.appendChild(titleSpan);
            li.appendChild(metaSpan);
          }

          ul.appendChild(li);
        });
      listWrap.appendChild(ul);
      section.appendChild(listWrap);
      courseCategoriesList.appendChild(section);
    }
  } catch (e) {
    courseCategoriesList.innerHTML =
      '<p class="announcements-list-empty">Could not load course categories.</p>';
    if (courseCategoriesStatus) courseCategoriesStatus.textContent = e?.message || "";
    if (courseCategoriesSemester) courseCategoriesSemester.textContent = "";
  }
}

async function renderSyllabusManagerList() {
  if (!syllabusManagerList) return;
  syllabusManagerList.innerHTML = "<p class=\"syllabus-manager-loading\">Loading…</p>";
  const res = await sendMessage({ type: "GET_SYLLABUS_MANAGER_DATA" });
  if (!res?.ok) {
    syllabusManagerList.innerHTML = "<p class=\"syllabus-manager-error\">" + (res?.error || "Could not load.") + "</p>";
    return;
  }
  let coursesList = res.coursesList || [];
  /** Only Q1 and Q2 are treated as courses with a syllabus; Annual, Organizations, Other are excluded. */
  try {
    const catRes = await sendMessage({ type: "GET_COURSE_CATEGORIES" });
    if (!catRes?.ok || !Array.isArray(catRes.items)) {
      coursesList = [];
    } else {
      const categoryByCourseId = {};
      for (const m of catRes.items) {
        const cid = m?.courseId;
        if (cid) categoryByCourseId[cid] = m.category || "OTHER";
      }
      coursesList = coursesList.filter((c) => {
        const key = c.learnCourseId || c.courseId || "";
        const cat = categoryByCourseId[key];
        return cat === "Q1" || cat === "Q2";
      });
    }
  } catch (_) {
    coursesList = [];
  }
  syllabusManagerData = {
    coursesList,
    statuses: res.statuses || {},
    uploads: res.uploads || {}
  };
  const sortBy = (syllabusManagerSort && syllabusManagerSort.dataset.sort) || "missing";
  let list = [...syllabusManagerData.coursesList];
  const statuses = syllabusManagerData.statuses;
  const uploads = syllabusManagerData.uploads;
  if (sortBy === "missing") {
    list.sort((a, b) => {
      const idA = a.learnCourseId || a.courseId || "";
      const idB = b.learnCourseId || b.courseId || "";
      const statusA = uploads[idA] ? "UPLOADED" : (statuses[idA]?.status || "UNKNOWN");
      const statusB = uploads[idB] ? "UPLOADED" : (statuses[idB]?.status || "UNKNOWN");
      const miss = (s) => (s === "MISSING" ? 0 : s === "UNKNOWN" ? 1 : 2);
      return miss(statusA) - miss(statusB) || (a.name || "").localeCompare(b.name || "");
    });
  } else {
    list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }
  const searchQ = (syllabusManagerSearch && syllabusManagerSearch.value || "").trim().toLowerCase();
  if (searchQ) list = list.filter((c) => (c.name || "").toLowerCase().includes(searchQ) || (c.learnCourseId || c.courseId || "").toLowerCase().includes(searchQ));

  let missingCount = 0;
  syllabusManagerList.innerHTML = "";
  if (list.length === 0) {
    const emptyP = document.createElement("p");
    emptyP.className = "syllabus-manager-loading";
    emptyP.textContent = "Only Q1 and Q2 courses are shown here. Open Blackboard in a tab so course categories can load.";
    syllabusManagerList.appendChild(emptyP);
  }
  for (const c of list) {
    const courseId = c.learnCourseId || c.courseId;
    const courseName = c.name || courseId || "Course";
    const hasUpload = uploads[courseId];
    const statusEntry = statuses[courseId];
    const displayStatus = hasUpload ? "UPLOADED" : (statusEntry?.status || "UNKNOWN");
    if (displayStatus === "MISSING") missingCount++;

    const row = document.createElement("div");
    row.className = "syllabus-manager-row";
    const badge = document.createElement("span");
    badge.className = "syllabus-manager-badge syllabus-manager-badge--" + displayStatus.toLowerCase();
    badge.textContent = displayStatus === "UPLOADED" ? "UPLOADED (Your PDF)" : displayStatus === "MISSING" ? "MISSING (Upload recommended)" : displayStatus === "AVAILABLE" ? "AVAILABLE (Blackboard)" : "UNKNOWN";
    row.appendChild(badge);
    const nameEl = document.createElement("div");
    nameEl.className = "syllabus-manager-course-name";
    nameEl.textContent = courseName;
    row.appendChild(nameEl);
    if (displayStatus === "MISSING" && !hasUpload) {
      const hint = document.createElement("p");
      hint.className = "syllabus-manager-missing-hint";
      hint.textContent = "Blackboard shows \"eSyllabus Not Available\". Upload your syllabus PDF so I can answer course questions accurately.";
      row.appendChild(hint);
    }
    const actions = document.createElement("div");
    actions.className = "syllabus-manager-actions";
    const uploadBtn = document.createElement("button");
    uploadBtn.type = "button";
    uploadBtn.className = "btn btn-ghost syllabus-manager-btn";
    uploadBtn.textContent = hasUpload ? "Replace PDF" : "Upload PDF";
    uploadBtn.addEventListener("click", () => { syllabusManagerUploadCourseId = courseId; syllabusManagerFileInput && syllabusManagerFileInput.click(); });
    actions.appendChild(uploadBtn);
    if (hasUpload) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn btn-ghost syllabus-manager-btn";
      removeBtn.textContent = "Remove PDF";
      removeBtn.addEventListener("click", async () => {
        if (!confirm("Remove uploaded syllabus for this course?")) return;
        const r = await sendMessage({ type: "SYLLABUS_REMOVE_UPLOAD", courseId });
        if (r?.ok) renderSyllabusManagerList(); else alert(r?.error || "Failed");
      });
      actions.appendChild(removeBtn);
    }
    const recheckBtn = document.createElement("button");
    recheckBtn.type = "button";
    recheckBtn.className = "btn btn-ghost syllabus-manager-btn";
    recheckBtn.textContent = "Re-check Blackboard";
    recheckBtn.addEventListener("click", async () => {
      recheckBtn.disabled = true;
      recheckBtn.textContent = "Checking…";
      const r = await sendMessage({ type: "SYLLABUS_RECHECK", courseId });
      recheckBtn.disabled = false;
      recheckBtn.textContent = "Re-check Blackboard";
      if (r?.ok) renderSyllabusManagerList(); else alert(r?.error || "Re-check failed");
    });
    actions.appendChild(recheckBtn);
    row.appendChild(actions);
    syllabusManagerList.appendChild(row);
  }
  if (syllabusManagerBanner) {
    if (missingCount > 0) {
      syllabusManagerBanner.textContent = "Some courses have missing syllabi. Upload PDFs to improve accuracy.";
      syllabusManagerBanner.classList.remove("hidden");
    } else {
      syllabusManagerBanner.classList.add("hidden");
    }
  }
  if (list.length === 0) {
    syllabusManagerList.innerHTML = "<p class=\"syllabus-manager-empty\">No courses found. Sync courses from Settings first.</p>";
  }
}

const syllabusManagerSort = document.getElementById("syllabusManagerSort");
if (syllabusManagerSort) {
  syllabusManagerSort.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      syllabusManagerSort.dataset.sort = btn.dataset.sort || "missing";
      if (syllabusManagerList) renderSyllabusManagerList();
    });
  });
}
if (syllabusManagerSearch) syllabusManagerSearch.addEventListener("input", () => syllabusManagerList && renderSyllabusManagerList());

async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  const scriptUrl = chrome.runtime.getURL("lib/pdf.min.js");
  const workerUrl = chrome.runtime.getURL("lib/pdf.worker.min.js");
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.onload = () => {
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
        resolve(window.pdfjsLib);
      } else reject(new Error("PDF.js not loaded"));
    };
    script.onerror = () => reject(new Error("Failed to load PDF.js"));
    document.head.appendChild(script);
  });
}

/**
 * Extract text from PDF (simple join). Optional pre-read arrayBuffer to avoid double read.
 */
async function extractTextFromPdfFile(file, optionalArrayBuffer) {
  const pdfjsLib = await loadPdfJs();
  const arrayBuffer = optionalArrayBuffer != null ? optionalArrayBuffer : await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = doc.numPages;
  const parts = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str || "").join(" ");
    parts.push(text);
  }
  const full = parts.join("\n\n").replace(/\s+/g, " ").trim();
  if (full.length < 50) throw new Error("This PDF looks like scanned images. Please upload a text-based PDF.");
  return full;
}

/**
 * Extract text using top-to-bottom, right-column-then-left reading-order pipeline when available; else simple extraction.
 * Pipeline is loaded via module script in sidepanel.html and exposed on window (no dynamic import).
 */
async function extractTextFromPdfWithReadingOrder(file, arrayBuffer) {
  let runPipeline = typeof window.runPdfReadingOrderPipeline === "function";
  let stripDelim = typeof window.stripPageDelimiter === "function";
  if (!runPipeline || !stripDelim) {
    await new Promise((r) => setTimeout(r, 400));
    runPipeline = typeof window.runPdfReadingOrderPipeline === "function";
    stripDelim = typeof window.stripPageDelimiter === "function";
  }
  if (!runPipeline || !stripDelim) {
    return extractTextFromPdfFile(file, arrayBuffer);
  }
  try {
    const pdfjsLib = await loadPdfJs();
    const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const result = await window.runPdfReadingOrderPipeline(doc);
    const ordered = (result.orderedText || result.rawFallback || "").trim();
    const extractedText = window.stripPageDelimiter(ordered);
    if (extractedText && extractedText.length >= 50) return extractedText;
  } catch (_) {
    /* fallback to simple extraction */
  }
  return extractTextFromPdfFile(file, arrayBuffer);
}

function simpleHash(s) {
  if (typeof s !== "string") return "";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
  return Math.abs(h).toString(36);
}

function storeSyllabusPdfBlob(courseId, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("jarvis_syllabus_pdfs", 1);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("pdf_blobs")) db.createObjectStore("pdf_blobs", { keyPath: "courseId" });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("pdf_blobs", "readwrite");
      tx.objectStore("pdf_blobs").put({ courseId: String(courseId).trim(), blob: arrayBuffer, at: Date.now() });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

if (syllabusManagerFileInput) {
  syllabusManagerFileInput.addEventListener("change", async (e) => {
    const file = e.target && e.target.files && e.target.files[0];
    e.target.value = "";
    const courseId = syllabusManagerUploadCourseId;
    syllabusManagerUploadCourseId = null;
    if (!file || !courseId) return;
    if (file.type !== "application/pdf") {
      alert("Please select a PDF file.");
      return;
    }
    const courseName = syllabusManagerData.coursesList.find((c) => (c.learnCourseId || c.courseId) === courseId)?.name || courseId;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bufferForStorage = arrayBuffer.slice(0);
      const extractedText = await extractTextFromPdfWithReadingOrder(file, arrayBuffer);
      await storeSyllabusPdfBlob(courseId, bufferForStorage);
      const record = {
        fileName: file.name || "syllabus.pdf",
        uploadDate: new Date().toISOString(),
        checksum: simpleHash(extractedText),
        extractedText
      };
      const r = await sendMessage({ type: "SYLLABUS_SAVE_UPLOAD", courseId, record });
      if (r?.ok) {
        renderSyllabusManagerList();
        alert("Assigned syllabus to " + courseName + ". I'll use it when you ask about this course.");
      } else alert(r?.error || "Failed to save.");
    } catch (err) {
      alert(err?.message || "PDF extraction failed.");
    }
  });
}

function formatAnnouncementDate(dateISO) {
  if (!dateISO || typeof dateISO !== "string") return "";
  const d = new Date(dateISO);
  if (Number.isNaN(d.getTime())) return dateISO;
  return d.toLocaleDateString(undefined, { dateStyle: "short" });
}

function formatAnnouncementDateLong(dateISO) {
  if (!dateISO || typeof dateISO !== "string") return "";
  const d = new Date(dateISO);
  if (Number.isNaN(d.getTime())) return dateISO;
  return d.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function normalizeAnnouncementTitle(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function isRequiredAnnouncementMatch(announcement, groupCourseId) {
  const announcementId = String(announcement?.id || announcement?.announcementId || "").trim();
  const announcementCourseId = String(announcement?.courseId || groupCourseId || "").trim();
  const announcementTitle = normalizeAnnouncementTitle(announcement?.title);

  if (REQUIRED_ANNOUNCEMENT.id && announcementId !== REQUIRED_ANNOUNCEMENT.id) return false;
  if (REQUIRED_ANNOUNCEMENT.courseId && announcementCourseId !== REQUIRED_ANNOUNCEMENT.courseId) return false;
  if (REQUIRED_ANNOUNCEMENT.title && announcementTitle !== normalizeAnnouncementTitle(REQUIRED_ANNOUNCEMENT.title)) return false;

  return true;
}

function getAnnouncementReadState(announcement) {
  if (typeof announcement?.isRead === "boolean") return announcement.isRead;
  if (typeof announcement?.readStatus?.isRead === "boolean") return announcement.readStatus.isRead;
  return false;
}

function buildAnnouncementUrl(courseId, announcementId) {
  if (!courseId || !announcementId) return "";
  return `https://blackboard.ie.edu/ultra/courses/${encodeURIComponent(courseId)}/announcements/announcement-detail?courseId=${encodeURIComponent(courseId)}&announcementId=${encodeURIComponent(announcementId)}`;
}

function updateAnnouncementGateHint(text) {
  if (announcementGateHint) announcementGateHint.textContent = text;
}

function stopAnnouncementGatePolling() {
  if (announcementGatePollingTimer) {
    clearTimeout(announcementGatePollingTimer);
    announcementGatePollingTimer = null;
  }
}

function scheduleAnnouncementGatePolling(delayMs) {
  stopAnnouncementGatePolling();
  announcementGatePollingTimer = setTimeout(checkRequiredAnnouncementReadStatus, delayMs);
}

function hideAnnouncementGate() {
  if (!announcementGateOverlay) return;
  stopAnnouncementGatePolling();
  announcementGateCurrent = null;
  announcementGateOverlay.classList.add("hidden");
  announcementGateOverlay.setAttribute("aria-hidden", "true");
}

function showAnnouncementGate(announcement, courseName, courseId) {
  if (!announcementGateOverlay || !announcementGateTitle || !announcementGateMeta || !announcementGateScroll || !announcementGateBody || !announcementGateContinue) return;
  const displayDate = formatAnnouncementDateLong(announcement.modifiedDate || announcement.dateISO || announcement.createdDate || "");
  const announcementId = announcement.id || announcement.announcementId || "";
  const announcementUrl = buildAnnouncementUrl(courseId || announcement.courseId || "", announcementId);
  announcementGateCurrent = {
    courseId: courseId || announcement.courseId || "",
    announcementId,
    url: announcementUrl
  };
  announcementGateTitle.textContent = (announcement.title || REQUIRED_ANNOUNCEMENT.title || "Important announcement").trim();
  announcementGateMeta.textContent = [courseName || announcement.courseId || "Course", displayDate].filter(Boolean).join(" · ");
  announcementGateBody.textContent = announcement.bodyText || "No announcement text available.";
  announcementGateScroll.scrollTop = 0;
  announcementGateContinue.disabled = !announcementUrl;
  announcementGateContinue.textContent = "Open announcement and continue";
  if (announcementGateLink) {
    announcementGateLink.href = announcementUrl || "#";
    announcementGateLink.classList.toggle("hidden", !announcementUrl);
  }
  updateAnnouncementGateHint("Open the announcement in Blackboard. Navie will unlock automatically after it is marked as read.");
  announcementGateOverlay.classList.remove("hidden");
  announcementGateOverlay.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    announcementGateScroll.focus();
  });
}

function findRequiredUnreadAnnouncement(groups) {
  for (const group of groups || []) {
    if (!group || group.error) continue;
    for (const announcement of group.announcements || []) {
      if (!isRequiredAnnouncementMatch(announcement, group.courseId)) continue;
      if (getAnnouncementReadState(announcement)) continue;
      return {
        announcement,
        courseName: group.courseName || group.courseId || "Course",
        courseId: group.courseId || announcement.courseId || ""
      };
    }
  }
  return null;
}

function maybeShowRequiredAnnouncementGate(groups) {
  const match = findRequiredUnreadAnnouncement(groups);
  if (!match) {
    hideAnnouncementGate();
    return;
  }
  showAnnouncementGate(match.announcement, match.courseName, match.courseId);
}

async function checkRequiredAnnouncementReadStatus() {
  if (announcementGatePollingInFlight) return;
  announcementGatePollingInFlight = true;
  try {
    const res = await sendMessage({ type: "SYNC_ANNOUNCEMENTS" });
    if (res?.ok) {
      const match = findRequiredUnreadAnnouncement(res.data || []);
      if (!match) {
        hideAnnouncementGate();
        return;
      }
      showAnnouncementGate(match.announcement, match.courseName, match.courseId);
      updateAnnouncementGateHint("The announcement is still unread. Open it in Blackboard, then return here.");
      scheduleAnnouncementGatePolling(4000);
    } else {
      scheduleAnnouncementGatePolling(4000);
    }
  } catch (_) {
    scheduleAnnouncementGatePolling(4000);
  } finally {
    announcementGatePollingInFlight = false;
  }
}

if (announcementGateContinue) {
  announcementGateContinue.addEventListener("click", () => {
    const url = announcementGateCurrent?.url || "";
    if (!url) return;
    window.open(url, "_blank", "noopener");
    updateAnnouncementGateHint("Waiting for Blackboard to mark this announcement as read...");
    scheduleAnnouncementGatePolling(2500);
  });
}

function stopSurveyGatePolling() {
  if (surveyGatePollingTimer) {
    clearTimeout(surveyGatePollingTimer);
    surveyGatePollingTimer = null;
  }
}

function scheduleSurveyGatePolling(delayMs = SURVEY_GATE_POLL_MS) {
  stopSurveyGatePolling();
  surveyGatePollingTimer = setTimeout(checkSurveyGateStatus, Math.max(2000, Number(delayMs) || SURVEY_GATE_POLL_MS));
}

function setSurveyLockState(locked) {
  surveyGateLocked = locked === true;
  if (!chatInput || !sendBtn) return;
  if (surveyGateLocked) {
    chatInput.disabled = true;
    chatInput.placeholder = "Complete the pending survey to unlock Navie.";
    sendBtn.disabled = true;
    return;
  }
  chatInput.disabled = false;
  if (!chatInput.value) chatInput.placeholder = CHAT_DEFAULT_PLACEHOLDER;
  const hasLoading = !!document.querySelector(".msg.assistant.loading");
  if (!hasLoading) sendBtn.disabled = false;
}

function hideSurveyGate() {
  stopSurveyGatePolling();
  if (surveyGateOverlay) {
    surveyGateOverlay.classList.add("hidden");
    surveyGateOverlay.setAttribute("aria-hidden", "true");
  }
  setSurveyLockState(false);
}

function showSurveyGate(setting) {
  if (!surveyGateOverlay) return;
  const toolUrl = String(setting?.ToolUrl || "").trim();
  if (surveyGateBody) {
    const header = String(setting?.LoginFOHeaderText || "").trim();
    surveyGateBody.textContent = header || "You must complete the pending survey before using Navie.";
  }
  if (surveyGateLink) {
    surveyGateLink.href = toolUrl || "#";
    surveyGateLink.classList.toggle("hidden", !toolUrl);
  }
  if (surveyGateRefresh) surveyGateRefresh.disabled = false;
  surveyGateOverlay.classList.remove("hidden");
  surveyGateOverlay.setAttribute("aria-hidden", "false");
  setSurveyLockState(true);
}

async function checkSurveyGateStatus() {
  if (surveyGatePollingInFlight) return;
  surveyGatePollingInFlight = true;
  try {
    const language = (navigator.language || "en-US").trim() || "en-US";
    const res = await sendMessage({ type: "CHECK_BLUE_SURVEYS", language });
    if (res?.ok && res?.locked && res?.setting?.ToolUrl) {
      showSurveyGate(res.setting);
      scheduleSurveyGatePolling();
      return;
    }
    hideSurveyGate();
  } catch (_) {
    scheduleSurveyGatePolling();
  } finally {
    surveyGatePollingInFlight = false;
  }
}

if (surveyGateLink) {
  surveyGateLink.addEventListener("click", () => {
    if (surveyGateRefresh) surveyGateRefresh.disabled = true;
    scheduleSurveyGatePolling(3500);
  });
}

if (surveyGateRefresh) {
  surveyGateRefresh.addEventListener("click", async () => {
    surveyGateRefresh.disabled = true;
    await checkSurveyGateStatus();
    surveyGateRefresh.disabled = false;
  });
}

async function renderAnnouncementsList() {
  if (!announcementsListContainer) return;
  announcementsListContainer.innerHTML = "";
  const res = await sendMessage({ type: "GET_ANNOUNCEMENTS" });
  const rawList = res?.data || [];
  const list = rawList.filter((group) => !group.error);
  if (list.length === 0) {
    announcementsListContainer.innerHTML = '<p class="announcements-list-empty">Sync to load announcements. Open Blackboard in a tab and sync from Settings.</p>';
    return;
  }
  for (const group of list) {
    const courseName = group.courseName || group.courseId || "Course";
    const section = document.createElement("div");
    section.className = "announcements-course-block announcements-course-block--collapsed";
    const header = document.createElement("button");
    header.type = "button";
    header.className = "announcements-course-header";
    header.setAttribute("aria-expanded", "false");
    const headerText = document.createElement("span");
    headerText.className = "announcements-course-name";
    headerText.textContent = courseName;
    const chevron = document.createElement("span");
    chevron.className = "announcements-course-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "▶";
    header.appendChild(headerText);
    header.appendChild(chevron);
    header.addEventListener("click", () => {
      const collapsed = section.classList.toggle("announcements-course-block--collapsed");
      header.setAttribute("aria-expanded", String(!collapsed));
      chevron.textContent = collapsed ? "▶" : "▼";
    });
    section.appendChild(header);
    const listWrap = document.createElement("div");
    listWrap.className = "announcements-course-list";
    const ul = document.createElement("ul");
    ul.className = "announcements-item-list";
    const courseId = group.courseId || "";
    for (const a of group.announcements || []) {
      const li = document.createElement("li");
      li.className = "announcements-item";
      const dateStr = formatAnnouncementDate(a.dateISO);
      const title = a.title || "(No title)";
      if (courseId && a.id) {
        const announcementUrl = `https://blackboard.ie.edu/ultra/courses/${encodeURIComponent(courseId)}/announcements/announcement-detail?courseId=${encodeURIComponent(courseId)}&announcementId=${encodeURIComponent(a.id)}`;
        const link = document.createElement("a");
        link.href = announcementUrl;
        link.target = "_blank";
        link.rel = "noopener";
        link.className = "announcements-item-link";
        const titleSpan = document.createElement("span");
        titleSpan.className = "announcements-item-title";
        titleSpan.textContent = title;
        const metaSpan = document.createElement("span");
        metaSpan.className = "announcements-item-meta";
        metaSpan.textContent = dateStr || "";
        link.appendChild(titleSpan);
        link.appendChild(metaSpan);
        li.appendChild(link);
      } else {
        const titleSpan = document.createElement("span");
        titleSpan.className = "announcements-item-title";
        titleSpan.textContent = title;
        const metaSpan = document.createElement("span");
        metaSpan.className = "announcements-item-meta";
        metaSpan.textContent = dateStr || "";
        li.appendChild(titleSpan);
        li.appendChild(metaSpan);
      }
      ul.appendChild(li);
    }
    listWrap.appendChild(ul);
    section.appendChild(listWrap);
    announcementsListContainer.appendChild(section);
  }
}

async function renderAssignmentsList() {
  if (!assignmentsListContainer) return;
  assignmentsListContainer.innerHTML = "";
  const data = await getSyncData();
  const gradebookByCourseId = data?.gradebookByCourseId || {};
  const courseIds = Object.keys(gradebookByCourseId).filter((id) => {
    const gb = gradebookByCourseId[id];
    return gb && Array.isArray(gb.assignments) && gb.assignments.length > 0;
  });
  if (courseIds.length === 0) {
    assignmentsListContainer.innerHTML =
      '<p class="announcements-list-empty">Sync syllabi to load assignments. Open Blackboard in a tab and sync from Settings.</p>';
    return;
  }
  for (const courseId of courseIds) {
    const gb = gradebookByCourseId[courseId];
    const courseName = gb.courseName || courseId;
    const section = document.createElement("div");
    section.className = "announcements-course-block announcements-course-block--collapsed";
    const header = document.createElement("button");
    header.type = "button";
    header.className = "announcements-course-header";
    header.setAttribute("aria-expanded", "false");
    const headerText = document.createElement("span");
    headerText.className = "announcements-course-name";
    headerText.textContent = courseName;
    const chevron = document.createElement("span");
    chevron.className = "announcements-course-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "▶";
    header.appendChild(headerText);
    header.appendChild(chevron);
    header.addEventListener("click", () => {
      const collapsed = section.classList.toggle("announcements-course-block--collapsed");
      header.setAttribute("aria-expanded", String(!collapsed));
      chevron.textContent = collapsed ? "▶" : "▼";
    });
    section.appendChild(header);
    const listWrap = document.createElement("div");
    listWrap.className = "announcements-course-list";
    const ul = document.createElement("ul");
    ul.className = "announcements-item-list";
    for (const a of gb.assignments || []) {
      const li = document.createElement("li");
      li.className = "announcements-item";
      const dueStr = formatDueDateForWidget(a.dueDate, a.dueEpochMs) || "";
      const title = a.title || "(No title)";
      const url = a.urlOpcional || a.url || null;
      if (url) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        link.className = "announcements-item-link";
        const titleSpan = document.createElement("span");
        titleSpan.className = "announcements-item-title";
        titleSpan.textContent = title;
        const metaSpan = document.createElement("span");
        metaSpan.className = "announcements-item-meta";
        metaSpan.textContent = dueStr;
        link.appendChild(titleSpan);
        link.appendChild(metaSpan);
        li.appendChild(link);
      } else {
        const titleSpan = document.createElement("span");
        titleSpan.className = "announcements-item-title";
        titleSpan.textContent = title;
        const metaSpan = document.createElement("span");
        metaSpan.className = "announcements-item-meta";
        metaSpan.textContent = dueStr;
        li.appendChild(titleSpan);
        li.appendChild(metaSpan);
      }
      ul.appendChild(li);
    }
    listWrap.appendChild(ul);
    section.appendChild(listWrap);
    assignmentsListContainer.appendChild(section);
  }
}

async function renderMessagesList() {
  if (!messagesListContainer) return;
  messagesListContainer.innerHTML = "";
  const res = await sendMessage({ type: "GET_MESSAGES_FOR_PANEL" });
  const rawList = res?.data || [];
  const list = rawList.filter((group) => Array.isArray(group.messages) && group.messages.length > 0);
  if (list.length === 0) {
    messagesListContainer.innerHTML =
      '<p class="announcements-list-empty">Open Blackboard in a tab so I can load your course messages.</p>';
    return;
  }
  for (const group of list) {
    const courseName = group.courseName || group.courseId || "Course";
    const section = document.createElement("div");
    section.className = "announcements-course-block announcements-course-block--collapsed";
    const header = document.createElement("button");
    header.type = "button";
    header.className = "announcements-course-header";
    header.setAttribute("aria-expanded", "false");
    const headerText = document.createElement("span");
    headerText.className = "announcements-course-name";
    headerText.textContent = courseName;
    const chevron = document.createElement("span");
    chevron.className = "announcements-course-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "▶";
    header.appendChild(headerText);
    header.appendChild(chevron);
    header.addEventListener("click", () => {
      const collapsed = section.classList.toggle("announcements-course-block--collapsed");
      header.setAttribute("aria-expanded", String(!collapsed));
      chevron.textContent = collapsed ? "▶" : "▼";
    });
    section.appendChild(header);
    const listWrap = document.createElement("div");
    listWrap.className = "announcements-course-list";
    const ul = document.createElement("ul");
    ul.className = "announcements-item-list";
    for (const m of group.messages || []) {
      const li = document.createElement("li");
      li.className = "announcements-item";
      const dateStr = formatAnnouncementDate(m.dateISO);
      const title = m.title || "(No title)";
      const url = m.url || null;
      if (url) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        link.className = "announcements-item-link";
        const titleSpan = document.createElement("span");
        titleSpan.className = "announcements-item-title";
        titleSpan.textContent = title;
        const metaSpan = document.createElement("span");
        metaSpan.className = "announcements-item-meta";
        metaSpan.textContent = dateStr || "";
        link.appendChild(titleSpan);
        link.appendChild(metaSpan);
        li.appendChild(link);
      } else {
        const titleSpan = document.createElement("span");
        titleSpan.className = "announcements-item-title";
        titleSpan.textContent = title;
        const metaSpan = document.createElement("span");
        metaSpan.className = "announcements-item-meta";
        metaSpan.textContent = dateStr || "";
        li.appendChild(titleSpan);
        li.appendChild(metaSpan);
      }
      ul.appendChild(li);
    }
    listWrap.appendChild(ul);
    section.appendChild(listWrap);
    messagesListContainer.appendChild(section);
  }
}

if (announcementsSyncBtn) {
  announcementsSyncBtn.addEventListener("click", async () => {
    announcementsSyncBtn.disabled = true;
    if (announcementsStatus) announcementsStatus.textContent = "Syncing…";
    try {
      const res = await sendMessage({ type: "SYNC_ANNOUNCEMENTS" });
      if (chrome.runtime?.lastError) {
        if (announcementsStatus) announcementsStatus.textContent = "Extension error";
        if (announcementsListContainer) renderAnnouncementsList();
        return;
      }
      if (res?.ok) {
        if (announcementsStatus) announcementsStatus.textContent = "Done.";
        maybeShowRequiredAnnouncementGate(res.data || []);
      } else {
        if (announcementsStatus) announcementsStatus.textContent = res?.error || "Sync failed";
      }
      if (announcementsListContainer) renderAnnouncementsList();
    } catch (e) {
      if (announcementsStatus) announcementsStatus.textContent = e?.message || "Error";
      if (announcementsListContainer) renderAnnouncementsList();
    } finally {
      announcementsSyncBtn.disabled = false;
    }
  });
}

let lastSyllabusTestHtml = "";

function escapeHtmlForDisplay(str) {
  if (typeof str !== "string") return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderSyllabusTestOut() {
  if (!syllabusTestOut) return;
  const searchTerm = (syllabusTestSearch?.value ?? "").trim();
  if (!lastSyllabusTestHtml) {
    syllabusTestOut.textContent = "";
    if (syllabusTestSearchCount) syllabusTestSearchCount.textContent = "";
    return;
  }
  if (!searchTerm) {
    syllabusTestOut.textContent = lastSyllabusTestHtml;
    if (syllabusTestSearchCount) syllabusTestSearchCount.textContent = "";
    return;
  }
  const escapedHtml = escapeHtmlForDisplay(lastSyllabusTestHtml);
  const escapedSearch = escapeHtmlForDisplay(searchTerm);
  const regex = new RegExp(escapeRegex(escapedSearch), "gi");
  const withMarks = escapedHtml.replace(regex, "<mark class=\"syllabus-search-hit\">$&</mark>");
  const count = (escapedHtml.match(regex) || []).length;
  syllabusTestOut.innerHTML = withMarks;
  if (syllabusTestSearchCount) {
    syllabusTestSearchCount.textContent = count === 0 ? "No hay coincidencias" : count === 1 ? "1 coincidencia" : count + " coincidencias";
  }
}

if (syllabusTestBtn && syllabusTestCourseId && syllabusTestStatus && syllabusTestOut) {
  syllabusTestBtn.addEventListener("click", async () => {
    const courseId = (syllabusTestCourseId.value || "").trim();
    if (!courseId) {
      syllabusTestStatus.textContent = "Escribe un ID de curso.";
      syllabusTestOut.textContent = "";
      lastSyllabusTestHtml = "";
      if (syllabusTestSearch) syllabusTestSearch.value = "";
      if (syllabusTestSearchCount) syllabusTestSearchCount.textContent = "";
      return;
    }
    syllabusTestStatus.textContent = "Loading...";
    syllabusTestOut.textContent = "";
    lastSyllabusTestHtml = "";
    if (syllabusTestSearchCount) syllabusTestSearchCount.textContent = "";
    syllabusTestBtn.disabled = true;
    try {
      const r = await sendMessage({ type: "GET_SYLLABUS", courseId });
      if (r?.ok) {
        syllabusTestStatus.textContent = "OK · " + (r.details?.htmlLength ?? 0) + " caracteres";
        lastSyllabusTestHtml = r.html || "";
        if (syllabusTestSearch) syllabusTestSearch.value = "";
        renderSyllabusTestOut();
      } else {
        syllabusTestStatus.textContent = "Error";
        syllabusTestOut.textContent = (r?.error || "Unknown error") + (r?.details?.url ? "\n\nURL: " + r.details.url : "") + (r?.details?.status != null ? "\nStatus: " + r.details.status : "");
      }
    } catch (e) {
      syllabusTestStatus.textContent = "Error";
      syllabusTestOut.textContent = e?.message || String(e);
    }
    syllabusTestBtn.disabled = false;
  });
}
if (syllabusTestSearch && syllabusTestOut) {
  syllabusTestSearch.addEventListener("input", () => renderSyllabusTestOut());
  syllabusTestSearch.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      syllabusTestSearch.value = "";
      renderSyllabusTestOut();
      syllabusTestSearch.blur();
    }
  });
}

saveKeyBtn.addEventListener("click", async () => {
  const key = (apiKeyInput.value || "").trim();
  if (key) {
    await chrome.storage.local.set({ [STORAGE_API_KEY]: key });
    apiKeyInput.value = "";
    if (keySavedHint) {
      keySavedHint.classList.remove("hidden");
      keySavedHint.textContent = "API key saved. It will be remembered when the extension is closed.";
      setTimeout(() => keySavedHint.classList.add("hidden"), 3000);
    }
  }
});

async function getApiKey() {
  const o = await chrome.storage.local.get(STORAGE_API_KEY);
  const key = o[STORAGE_API_KEY] || "";
  return typeof key === "string" ? key.trim() : "";
}

if (themeSelect) {
  themeSelect.addEventListener("change", async () => {
    const theme = themeSelect.value === "light" ? "light" : "dark";
    applyTheme(theme);
    try {
      await chrome.storage.local.set({ [STORAGE_THEME]: theme });
    } catch (_) {}
  });
}

function appendMessage(role, content, isError = false, opts) {
  const div = document.createElement("div");
  div.className = "msg " + (isError ? "error" : role);
  if (role === "assistant" && !isError && opts && opts.syllabusLink) {
    div.innerHTML = buildSyllabusLinkBlock(opts.url, opts.courseName, opts.isEnglish);
  } else if (role === "assistant" && !isError && opts && opts.upcomingAssignments && opts.upcomingAssignments.length > 0) {
    div.innerHTML = buildAssistantMessageWithAssignmentButtons(content, opts.upcomingAssignments);
  } else if (role === "assistant" && !isError && opts && opts.assignmentItems && opts.assignmentItems.length > 0) {
    div.innerHTML = buildAssignmentListWithLinks(content, opts.assignmentItems);
  } else if (role === "assistant" && !isError) {
    div.innerHTML = buildAssistantMessageHtml(content);
  } else {
    div.textContent = content;
  }
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/** Devuelve true si la consulta del usuario parece estar en inglés (para título/botón del link al syllabus). */
function isEnglishQuery(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim().toLowerCase();
  return /\b(give|get|send|need|what|when|can you|could you|please|open|the link|syllabus of|syllabus for)\b/i.test(t);
}

/** HTML del mensaje con botón de syllabus (siempre el botón; título y botón en español o inglés). */
function buildSyllabusLinkBlock(url, courseName, isEnglish) {
  const textPart = courseName ? "Here is the syllabus for " + courseName + "." : "Here is the syllabus.";
  const btnLabel = "Open syllabus";
  const escaped = escapeHtml(textPart);
  const btn = '<a class="msg-syllabus-btn" href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(btnLabel) + "</a>";
  return escaped + "<br>" + btn;
}

function linkify(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, (url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`);
}

/** Score how well a line matches an assignment (course + title overlap). Higher = better. */
function scoreAssignmentMatch(lineLower, assignment) {
  const courseLower = (assignment.courseName || "").toLowerCase();
  const titleLower = (assignment.title || "").toLowerCase();
  if (!courseLower || !lineLower) return 0;
  let score = 0;
  if (lineLower.includes(courseLower)) score += 2;
  const titleWords = titleLower.split(/\s+/).filter((w) => w.length > 1);
  if (titleWords.length === 0) return score;
  const found = titleWords.filter((w) => lineLower.includes(w)).length;
  score += (found / titleWords.length) * 3;
  return score;
}

/**
 * Build assistant message HTML when it looks like an assignment list: add an "Open" button next to each
 * numbered assignment line, using the same urlOpcional logic as the Next Assignments widget.
 */
function buildAssistantMessageWithAssignmentButtons(content, upcomingAssignments) {
  if (!upcomingAssignments || upcomingAssignments.length === 0) return buildAssistantMessageHtml(content);
  const lines = content.split(/\n/);
  const usedIndices = new Set();
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match numbered items (1. or 1)) AND bullet items (- or •)
    const numberedMatch = line.match(/^\s*(\d+)[\.\)]\s*(.*)$/);
    const bulletMatch = !numberedMatch && line.match(/^\s*[-•]\s+(.+)$/);
    const isAssignmentLine = !!(numberedMatch || bulletMatch);
    if (isAssignmentLine) {
      const lineContent = (numberedMatch ? numberedMatch[2] : bulletMatch[1]).trim();
      const lineLower = lineContent.toLowerCase();
      let bestIdx = -1;
      let bestScore = 0;
      for (let j = 0; j < upcomingAssignments.length; j++) {
        if (usedIndices.has(j)) continue;
        const score = scoreAssignmentMatch(lineLower, upcomingAssignments[j]);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = j;
        }
      }
      const matched = bestIdx >= 0 && bestScore >= 2 ? upcomingAssignments[bestIdx] : null;
      const matchedUrl = matched
        ? (matched.urlOpcional || (matched.courseId ? "https://blackboard.ie.edu/ultra/courses/" + encodeURIComponent(matched.courseId) + "/grades" : null))
        : null;
      if (matched && matchedUrl) {
        usedIndices.add(bestIdx);
        const url = matchedUrl;
        const btn =
          '<a class="msg-assignment-btn" href="' +
          escapeHtml(url) +
          '" target="_blank" rel="noopener" aria-label="Open assignment">Open</a>';
        let blockText = escapeHtml(line);
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (j < lines.length && /^\s*Open\s*$/i.test(lines[j])) j++;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (j < lines.length && /^\s*Due\s*:/i.test(lines[j])) {
          blockText += "<br>" + escapeHtml(lines[j].trim());
          i = j;
        }
        result.push('<div class="msg-assignment-item">' + blockText + "<br>" + btn + "</div>");
      } else {
        result.push(escapeHtml(line));
      }
    } else {
      result.push(escapeHtml(line));
    }
  }
  return result.join("<br>\n");
}

/**
 * Build assistant message HTML for assignment-list responses: put a green "Open" button below each
 * bullet line, using assignmentItems (from gradebook urlOpcional / buildColumnNavigableUrl).
 * assignmentItems: Array<{ title: string, url: string }> or Array<{ courseName: string, title: string, url: string }> for global lists.
 */
function buildAssignmentListWithLinks(content, assignmentItems) {
  if (!content || !assignmentItems || assignmentItems.length === 0) return buildAssistantMessageHtml(content);
  const hasCourseName = assignmentItems.some((a) => a.courseName != null);
  // Process line-by-line (response uses single \n between bullets, not double)
  const lines = content.split(/\n/);
  const result = [];
  for (const line of lines) {
    if (!line.trim().startsWith("•")) {
      result.push(escapeHtml(line));
      continue;
    }
    const lineContent = line.replace(/^\s*•\s*/, "").trim();
    let matched = null;
    if (hasCourseName) {
      for (const it of assignmentItems) {
        if (!it.url || !it.courseName || !it.title) continue;
        // Match "COURSE: title" prefix (before the " (not submitted)" / " (due: ...)" suffix)
        const prefix = it.courseName + ": " + it.title;
        if (lineContent.startsWith(prefix)) {
          matched = it;
          break;
        }
      }
    } else {
      let bestLen = 0;
      for (const it of assignmentItems) {
        if (!it.url || !it.title) continue;
        if (lineContent.startsWith(it.title) && it.title.length > bestLen) {
          bestLen = it.title.length;
          matched = it;
        }
      }
    }
    if (matched && matched.url) {
      const btn =
        '<a class="msg-assignment-btn" href="' +
        escapeHtml(matched.url) +
        '" target="_blank" rel="noopener" aria-label="Open assignment">Open</a>';
      result.push('<div class="msg-assignment-item">' + escapeHtml(line) + "<br>" + btn + "</div>");
    } else {
      result.push(escapeHtml(line));
    }
  }
  return result.join("<br>\n");
}

/** True if the URL is the known syllabus BLTI link (so we only show syllabus card for real syllabus links, not e.g. announcement links). */
function isSyllabusUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /blti\/launchPlacement|execute\/blti/i.test(url);
}

/** Estética: si el mensaje contiene un enlace al syllabus (BLTI), mostrarlo como botón y mensaje canónico. Otros enlaces (announcements, etc.) solo se linkean. */
function buildAssistantMessageHtml(content) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const match = content.match(urlRegex);
  if (!match || match.length === 0) return linkify(content);
  const url = match[0];
  if (!isSyllabusUrl(url)) return linkify(content);
  const courseName = extractSyllabusCourseName(content);
  const textPart = courseName ? "Here is the syllabus for " + courseName + "." : "Here is the syllabus.";
  const escaped = escapeHtml(textPart);
  const btn = '<a class="msg-syllabus-btn" href="' + escapeHtml(url) + '" target="_blank" rel="noopener">Open syllabus</a>';
  return escaped + "<br>" + btn;
}

function extractSyllabusCourseName(content) {
  const t = content.substring(0, content.indexOf("http")).trim();
  const patterns = [
    /(?:el\s+)?syllabus\s+de\s+([^:\.\[\n\(]+?)(?:\s+se\s|\s+está|:|\s*\[|$)/i,
    /syllabus\s+for\s+([^:\.\[\n\(]+?)(?:\s+is\s|:|\s*\[|$)/i,
    /syllabus\s+of\s+([^:\.\[\n\(]+?)(?:\s+is\s|:|\s*\[|$)/i,
    /(?:enlace\s+)?(?:del?\s+)?syllabus\s+de\s+([^:\.\[\n\(]+)/i,
    /\[([^\]]+)\s+syllabus\]/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) return m[1].trim().replace(/\s+/g, " ");
  }
  return "";
}

const MAX_SYLLABI_IN_PROMPT = 12;
const MAX_COURSES_IN_PROMPT = 40;
const MAX_GRADEBOOK_COURSES = 2;
const MAX_COLUMNS_PER_COURSE = 12;
const MAX_UPCOMING_IN_PROMPT = 8;
const MAX_CHAT_HISTORY_MESSAGES = 10;

function buildSyllabiContext(syllabi) {
  const withUrl = (syllabi || []).filter((s) => s.syllabusUrl).slice(0, MAX_SYLLABI_IN_PROMPT);
  if (withUrl.length === 0) return "No syllabus loaded.";
  return withUrl.map((s) => s.courseName + " -> " + s.syllabusUrl).join("\n");
}

function buildGradebookContext(gradebookColumns, coursesByCourseId, resolvedLearnCourseId, includePoints) {
  const all = gradebookColumns || [];
  const entries = resolvedLearnCourseId
    ? all.filter((e) => e.courseId === resolvedLearnCourseId).concat(all.filter((e) => e.courseId !== resolvedLearnCourseId)).slice(0, MAX_GRADEBOOK_COURSES)
    : all.slice(0, MAX_GRADEBOOK_COURSES);
  if (!entries.length) return "";
  const lines = [];
  for (const entry of entries) {
    const name = entry.courseName || coursesByCourseId[entry.courseId]?.name || entry.courseId;
    const cols = (entry.columns || []).filter((c) => c?.name).slice(0, MAX_COLUMNS_PER_COURSE);
    const assignLines = cols.map((c) => {
      let s = c.name;
      if (c.dueDate) s += "(due:" + c.dueDate + ")";
      if (includePoints && c.pointsPossible != null) s += "(pts:" + c.pointsPossible + ")";
      return s;
    });
    lines.push(name + ": " + assignLines.join(", "));
  }
  return "Gradebook: " + lines.join(" | ");
}

/**
 * Los 3 assignments de todos los cursos que vencen más próximamente (dueEpochMs >= now).
 */
function getNextThreeUpcoming(gradebookByCourseId) {
  if (!gradebookByCourseId || typeof gradebookByCourseId !== "object") return [];
  const nowEpoch = typeof window.TimeContext !== "undefined" && window.TimeContext.getNowContext
    ? window.TimeContext.getNowContext().epochMs
    : Date.now();
  const parseEpoch =
    typeof window.TimeContext !== "undefined" && window.TimeContext.parseBbDateToEpoch
      ? window.TimeContext.parseBbDateToEpoch
      : (s) => (s ? new Date(s).getTime() : null);

  const all = [];
  for (const courseId of Object.keys(gradebookByCourseId)) {
    const gb = gradebookByCourseId[courseId];
    for (const a of gb.assignments || []) {
      const epoch = a.dueEpochMs != null ? a.dueEpochMs : parseEpoch(a.dueDate ?? a.dueDateRaw);
      if (epoch != null && !Number.isNaN(epoch) && epoch >= nowEpoch) {
        all.push({
          title: a.title || "(no title)",
          courseName: a.courseName || gb.courseName || courseId,
          dueDate: a.dueDate ?? a.dueDateRaw,
          dueEpochMs: epoch,
          urlOpcional: a.urlOpcional
        });
      }
    }
  }
  all.sort((a, b) => (a.dueEpochMs || 0) - (b.dueEpochMs || 0));
  return all.slice(0, 3).map((a) => {
    const meta = formatDueDateForWidget(a.dueDate, a.dueEpochMs);
    return {
      title: a.title,
      courseName: a.courseName,
      dueDate: a.dueDate,
      dueEpochMs: a.dueEpochMs,
      urlOpcional: a.urlOpcional,
      metaText: a.courseName + (meta ? " · " + meta : "")
    };
  });
}

/** Los 3 announcements más recientes de la caché (solo cursos sin error). */
async function getNextThreeAnnouncements() {
  const res = await sendMessage({ type: "GET_ANNOUNCEMENTS" });
  const rawList = res?.data || [];
  const groups = rawList.filter((g) => !g.error);
  const flat = [];
  for (const g of groups) {
    const courseId = g.courseId || "";
    const courseName = g.courseName || g.courseId || "Course";
    for (const a of g.announcements || []) {
      const dateISO = a.dateISO || "";
      const urlOpcional =
        courseId && a.id
          ? `https://blackboard.ie.edu/ultra/courses/${encodeURIComponent(courseId)}/announcements/announcement-detail?courseId=${encodeURIComponent(courseId)}&announcementId=${encodeURIComponent(a.id)}`
          : null;
      flat.push({
        title: a.title || "(No title)",
        courseName,
        dateISO,
        urlOpcional,
        metaText: courseName + (dateISO ? " · " + formatAnnouncementDate(dateISO) : "")
      });
    }
  }
  flat.sort((a, b) => (b.dateISO || "").localeCompare(a.dateISO || ""));
  return flat.slice(0, 3);
}

/** Próximas entregas de todos los cursos, hasta `limit` (misma fuente que el widget: gradebook). */
function getUpcomingAssignmentsAll(gradebookByCourseId, limit) {
  if (!gradebookByCourseId || typeof gradebookByCourseId !== "object") return [];
  const nowEpoch = typeof window.TimeContext !== "undefined" && window.TimeContext.getNowContext ? window.TimeContext.getNowContext().epochMs : Date.now();
  const parseEpoch = typeof window.TimeContext !== "undefined" && window.TimeContext.parseBbDateToEpoch ? window.TimeContext.parseBbDateToEpoch : (s) => (s ? new Date(s).getTime() : null);
  const all = [];
  for (const courseId of Object.keys(gradebookByCourseId)) {
    const gb = gradebookByCourseId[courseId];
    for (const a of gb.assignments || []) {
      const epoch = a.dueEpochMs != null ? a.dueEpochMs : parseEpoch(a.dueDate ?? a.dueDateRaw);
      if (epoch != null && !Number.isNaN(epoch) && epoch >= nowEpoch) {
        all.push({
          title: a.title || "(no title)",
          courseName: a.courseName || gb.courseName || courseId,
          courseId,
          dueDate: a.dueDate ?? a.dueDateRaw,
          dueEpochMs: epoch,
          urlOpcional: a.urlOpcional
        });
      }
    }
  }
  all.sort((a, b) => (a.dueEpochMs || 0) - (b.dueEpochMs || 0));
  return all.slice(0, limit ?? 20);
}

function formatDueDateForWidget(dueDate, dueEpochMs) {
  if (dueEpochMs != null && !Number.isNaN(dueEpochMs)) {
    const d = new Date(dueEpochMs);
    return d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  return dueDate || "";
}

function refreshUpcomingWidget() {
  if (upcomingWidgetMode === "announcements") {
    return getNextThreeAnnouncements().then((items) => renderUpcomingWidget(items));
  }
  if (upcomingWidgetMode === "messages") {
    return getNextThreeMessages().then((items) => renderUpcomingWidget(items));
  }
  return getSyncData().then((data) => renderUpcomingWidget(getNextThreeUpcoming(data.gradebookByCourseId)));
}

function renderUpcomingWidget(items) {
  if (!upcomingWidgetList || !upcomingWidgetEmpty) return;
  if (upcomingWidget) {
    if (upcomingWidgetMode === "announcements") {
      upcomingWidget.classList.add("upcoming-widget--announcements");
      upcomingWidget.classList.remove("upcoming-widget--messages");
    } else if (upcomingWidgetMode === "messages") {
      upcomingWidget.classList.add("upcoming-widget--messages");
      upcomingWidget.classList.remove("upcoming-widget--announcements");
    } else {
      upcomingWidget.classList.remove("upcoming-widget--announcements");
      upcomingWidget.classList.remove("upcoming-widget--messages");
    }
  }
  upcomingWidgetList.innerHTML = "";
  const metaTextForItem = (a) => a.metaText != null ? a.metaText : (a.courseName + (formatDueDateForWidget(a.dueDate, a.dueEpochMs) ? " · " + formatDueDateForWidget(a.dueDate, a.dueEpochMs) : ""));
  if (!items || items.length === 0) {
    upcomingWidgetList.classList.add("hidden");
    upcomingWidgetEmpty.classList.remove("hidden");
    return;
  }
  upcomingWidgetEmpty.classList.add("hidden");
  upcomingWidgetList.classList.remove("hidden");
  for (const a of items) {
    const li = document.createElement("li");
    li.className = "upcoming-item";
    const metaText = escapeHtml(metaTextForItem(a));
    const btnHtml = a.urlOpcional
      ? '<a href="' + escapeHtml(a.urlOpcional) + '" target="_blank" rel="noopener" class="upcoming-item-btn" aria-label="Abrir">→</a>'
      : "";
    li.innerHTML =
      '<div class="upcoming-item-content">' +
      '<span class="upcoming-item-title">' + escapeHtml(a.title) + "</span>" +
      '<span class="upcoming-item-meta">' + metaText + "</span>" +
      "</div>" +
      (btnHtml ? '<div class="upcoming-item-actions">' + btnHtml + "</div>" : "");
    upcomingWidgetList.appendChild(li);
  }
}

function escapeHtml(s) {
  if (s == null) return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

if (upcomingWidgetToggleAssignments) {
  upcomingWidgetToggleAssignments.addEventListener("click", () => {
    if (upcomingWidgetMode === "assignments") return;
    upcomingWidgetMode = "assignments";
    if (upcomingWidgetToggle) upcomingWidgetToggle.dataset.active = "0";
    upcomingWidgetToggleAssignments.classList.add("active");
    upcomingWidgetToggleAssignments.setAttribute("aria-pressed", "true");
    if (upcomingWidgetToggleAnnouncements) {
      upcomingWidgetToggleAnnouncements.classList.remove("active");
      upcomingWidgetToggleAnnouncements.setAttribute("aria-pressed", "false");
    }
    if (upcomingWidgetToggleMessages) {
      upcomingWidgetToggleMessages.classList.remove("active");
      upcomingWidgetToggleMessages.setAttribute("aria-pressed", "false");
    }
    refreshUpcomingWidget();
  });
}
if (upcomingWidgetToggleAnnouncements) {
  upcomingWidgetToggleAnnouncements.addEventListener("click", () => {
    if (upcomingWidgetMode === "announcements") return;
    upcomingWidgetMode = "announcements";
    if (upcomingWidgetToggle) upcomingWidgetToggle.dataset.active = "1";
    upcomingWidgetToggleAnnouncements.classList.add("active");
    upcomingWidgetToggleAnnouncements.setAttribute("aria-pressed", "true");
    if (upcomingWidgetToggleAssignments) {
      upcomingWidgetToggleAssignments.classList.remove("active");
      upcomingWidgetToggleAssignments.setAttribute("aria-pressed", "false");
    }
    if (upcomingWidgetToggleMessages) {
      upcomingWidgetToggleMessages.classList.remove("active");
      upcomingWidgetToggleMessages.setAttribute("aria-pressed", "false");
    }
    refreshUpcomingWidget();
  });
}

if (upcomingWidgetToggleMessages) {
  upcomingWidgetToggleMessages.addEventListener("click", () => {
    if (upcomingWidgetMode === "messages") return;
    upcomingWidgetMode = "messages";
    if (upcomingWidgetToggle) upcomingWidgetToggle.dataset.active = "2";
    upcomingWidgetToggleMessages.classList.add("active");
    upcomingWidgetToggleMessages.setAttribute("aria-pressed", "true");
    if (upcomingWidgetToggleAssignments) {
      upcomingWidgetToggleAssignments.classList.remove("active");
      upcomingWidgetToggleAssignments.setAttribute("aria-pressed", "false");
    }
    if (upcomingWidgetToggleAnnouncements) {
      upcomingWidgetToggleAnnouncements.classList.remove("active");
      upcomingWidgetToggleAnnouncements.setAttribute("aria-pressed", "false");
    }
    refreshUpcomingWidget();
  });
}

async function getNextThreeMessages() {
  const res = await sendMessage({ type: "GET_WIDGET_MESSAGES" });
  if (!res?.ok || !Array.isArray(res.items)) return [];
  return res.items.map((m) => {
    const dateText = m.dateText || "";
    const preview = m.preview || "";
    const shortPreview = preview && preview.length > 80 ? preview.slice(0, 77) + "..." : preview;
    const parts = [];
    if (dateText) parts.push(dateText);
    if (shortPreview) parts.push(shortPreview);
    const meta = parts.join(" · ");
    return {
      title: m.courseName || "Message",
      courseName: m.courseName || "",
      metaText: meta,
      urlOpcional: m.url || null
    };
  });
}

/**
 * Assignments "próximos" = dueEpochMs >= nowEpochMs, orden ascendente por dueEpochMs.
 * Opción nextNDays: solo incluir los que vencen en los próximos N días.
 * @param {{ epochMs: number }} nowContext - contexto actual (reloj del dispositivo)
 * @param {{ nextNDays?: number }} options - ej. { nextNDays: 7 }
 */
function getUpcomingAssignmentsForCourse(learnCourseId, gradebookByCourseId, courseName, nowContext, options) {
  const gb = gradebookByCourseId?.[learnCourseId];
  const name = courseName || gb?.courseName || learnCourseId;
  if (!gb) {
    return { assignments: [], message: "No gradebook data for this course. Sync syllabi first.", courseName: name };
  }
  const nowEpoch = nowContext?.epochMs ?? Date.now();
  const nextNDays = options?.nextNDays;
  const maxEpoch = nextNDays != null ? nowEpoch + nextNDays * 24 * 60 * 60 * 1000 : undefined;
  const parseEpoch =
    typeof window.TimeContext !== "undefined" && window.TimeContext.parseBbDateToEpoch
      ? window.TimeContext.parseBbDateToEpoch
      : (s) => (s ? new Date(s).getTime() : null);

  let withDue = (gb.assignments || []).filter((a) => {
    const epoch = a.dueEpochMs != null ? a.dueEpochMs : parseEpoch(a.dueDate ?? a.dueDateRaw);
    return epoch != null && !Number.isNaN(epoch) && epoch >= nowEpoch;
  });
  withDue = withDue.map((a) => ({
    ...a,
    dueEpochMs: a.dueEpochMs != null ? a.dueEpochMs : parseEpoch(a.dueDate ?? a.dueDateRaw)
  }));
  if (maxEpoch != null) withDue = withDue.filter((a) => (a.dueEpochMs || 0) <= maxEpoch);
  const sorted = withDue.slice().sort((a, b) => (a.dueEpochMs || 0) - (b.dueEpochMs || 0));

  if (sorted.length === 0) {
    const columnNames = (gb.columns || []).slice(0, 20).map((c) => c.name || c.title).filter(Boolean);
    const msg =
      "No hay deadlines detectados en el gradebook para este curso." +
      (columnNames.length ? " Columnas detectadas: " + columnNames.join(", ") : "");
    return { assignments: [], message: msg, courseName: name };
  }
  return {
    assignments: sorted.map((a) => ({
      title: a.title,
      dueDate: a.dueDate ?? a.dueDateRaw,
      dueEpochMs: a.dueEpochMs,
      courseName: a.courseName,
      urlOpcional: a.urlOpcional
    })),
    message: null,
    courseName: name
  };
}

/**
 * Consulta tipo "dame los assignments próximos de la clase de fisica".
 * Fuzzy match al curso; devuelve assignments con dueEpochMs >= now, orden ascendente.
 */
function getUpcomingAssignments(queryText, gradebookByCourseId, courseIdByNormalizedName, coursesByCourseId, nowContext, options) {
  const resolved = resolveCourseForPrompt(queryText, courseIdByNormalizedName, coursesByCourseId);
  if (!resolved?.learnCourseId) return { assignments: [], message: null, courseName: null };
  return getUpcomingAssignmentsForCourse(resolved.learnCourseId, gradebookByCourseId, resolved.name, nowContext, options);
}

/** Typos / shorthand so assignment routing matches natural language (gradebook path, not syllabus). */
function normalizeAssignmentQueryTypos(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\bassigns\b/gi, "assignments ")
    .replace(/\basignment(s)?\b/gi, "assignment ")
    .replace(/\bassignement(s)?\b/gi, "assignment ")
    .replace(/\btday\b/gi, "today")
    .replace(/\bforr\b/gi, "for ")
    .replace(/\bmicrocecon\b/gi, "microeconomics")
    .replace(/\bmicroecon\b/gi, "microeconomics")
    .replace(/\s+/g, " ")
    .trim();
}

/** True si el usuario pregunta EXPLÍCITAMENTE por su nota/puntuación numérica (no solo por deadlines). */
function isExplicitGradeQuery(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  return (
    /\b(?:my\s+grade|my\s+score|my\s+mark|what\s+(?:grade|score|mark)|how\s+(?:am\s+i\s+doing|did\s+i\s+do)|show\s+(?:my\s+)?grades?|my\s+points?\s+in|my\s+current\s+grade)\b/i.test(t) ||
    /\b(?:nota|notas|calificaci[oó]n|calificaciones|puntuaci[oó]n|cu[aá]ntos\s+puntos|mi\s+nota|tengo\s+aprobado|voy\s+a\s+aprobar|cu[aá]nto\s+(?:tengo|saco|llevo))\b/i.test(t)
  );
}

/** True si el usuario pregunta por entregas/assignments/tareas/deadlines/grades/pending (fuente: gradebook, no calendario). */
function isAssignmentQuery(text) {
  const raw = String(text || "");
  const t = normalizeAssignmentQueryTypos(raw);
  return (
    /\b(?:are\s+there\s+)?any\s+assignments?\s+(?:in|for|of)\b/i.test(t) ||
    /\b(?:give|show|get)\s+me\s+(?:the\s+)?(?:ones|those)\s+(?:in|for)\b/i.test(t) ||
    (/^\s*(?:all\s+the\s+)?assignments?\s*\.?\s*$/i.test(raw.trim()) && hasRecentAssignmentDomainInChat()) ||
    /\b(?:give|show|get)\s+me\s+all\s+(?:for|in|of)\b/i.test(t) ||
    /\b(?:give|show|get)\s+me\s+everything\s+(?:for|in|of)\b/i.test(t) ||
    /\b(?:i\s+want|give\s+me|show\s+me|tell\s+me|list)\s+(?:my\s+)?(?:last|first|all|the\s+last|the\s+first|\d{1,2})\s+assignments?\b/i.test(t) ||
    /\blast\s+assignments?\s+(?:of|for|in)\b/i.test(t) ||
    /\b(?:all|every)\s+(?:the\s+)?assignments?\s+(?:of|for|in)\b/i.test(t) ||
    /\b(assignment[s]?|entregas?|tareas?|deadline[s]?|due|pr[oó]ximas?\s*entregas?|entregas?\s*pr[oó]ximas?)\b/i.test(t) ||
    /\b(qué|que|cuántas|cuantas|dame|listar)\s*(entregas?|tareas?|as?signments?)\b/i.test(t) ||
    /what\s+(assignments|deliverables|due|tasks|homework|coursework|work)\b/i.test(t) ||
    /\b(tasks|homework|coursework|deliverables)\s+(?:do\s+i\s+)?have\s+(?:for|in|of)\b/i.test(t) ||
    /\bwork\s+is\s+assigned\s+(?:in|for|of)\b/i.test(t) ||
    /\b(pending|overdue|incomplete|to-do|submitted|submission\s+status)\b/i.test(t) ||
    /\b(what'?s\s+next|next\s+due|next\s+deadline|next\s+assignment|next\s+task)\b/i.test(t) ||
    /\b(due\s+today|due\s+tomorrow|due\s+tonight|due\s+this\s+week|due\s+next\s+week|due\s+soon)\b/i.test(t) ||
    /\b(what\s+is\s+due|what'?s\s+due|anything\s+due|everything\s+due\s+this\s+week)\b/i.test(t) ||
    /\b(overdue|past\s+due|late|missing\s+submissions?|what\s+did\s+I\s+miss)\b/i.test(t) ||
    /\b(grades?|gradebook|graded\s+items?|ungraded|feedback|rubric|score|points)\b/i.test(t) ||
    /\b(show\s+my\s+grades?|list\s+grades?|my\s+grade\s+in|grade\s+for\s+\w+)\b/i.test(t) ||
    /\b(to-do\s+list|pending\s+items?|incomplete\s+items?|what\s+do\s+I\s+still\s+need)\b/i.test(t) ||
    /\b(summarize\s+(?:my\s+)?(?:upcoming\s+)?deadlines?|summarize\s+what'?s\s+due)\b/i.test(t) ||
    /\b(filter\s+by\s+due|sort\s+by\s+due|group\s+by\s+course)\b/i.test(t) ||
    /\b(due\?|next\?|today\?|tmr\?|week\?|overdue\?|grades\?|gradebook\?)\s*$/im.test(t)
  );
}

/** True if the user is asking specifically about submission status (anything left to submit, need to submit, etc.). */
function isSubmissionStatusQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  return (
    /\bdo\s+i\s+have\s+(anything|something)\s+(left\s+)?to\s+submit\b/i.test(t) ||
    /\bdo\s+i\s+need\s+to\s+submit\b/i.test(t) ||
    /\bneed\s+to\s+submit\s+(anything|something)\b/i.test(t) ||
    /\b(anything|something)\s+left\s+to\s+submit\b/i.test(t) ||
    /\bdo\s+i\s+still\s+have\s+to\s+submit\b/i.test(t) ||
    /\bdo\s+i\s+have\s+to\s+submit\s+anything\b/i.test(t) ||
    /\bdo\s+i\s+have\s+to\s+submit\s+any\s+as?signments?\b/i.test(t) ||
    // "what assignments do I need to submit (for X)?"
    /\bwhat\s+as?signments?\s+do\s+i\s+need\s+to\s+submit\b/i.test(t) ||
    // "what assignments I need to submit (for X)?"
    /\bwhat\s+as?signments?\s+i\s+need\s+to\s+submit\b/i.test(t) ||
    // "do I have any pending assignments (for X)?"
    /\bdo\s+i\s+have\s+any\s+pending\s+as?signments?\b/i.test(t) ||
    // "any pending assignments left to submit"
    /\bany\s+pending\s+as?signments?\s+(?:left\s+)?to\s+submit\b/i.test(t) ||
    // "what assignments have pending submission (for X)?"
    /\bwhat\s+as?signments?\s+have\s+pending\s+submission\b/i.test(t) ||
    // "which assignments are/have pending submission (for X)?"
    /\bwhich\s+as?signments?\s+(?:are|have)\s+pending\s+submission\b/i.test(t) ||
    // "Do I have any assignments to submit for X course?"
    /\bdo\s+i\s+have\s+any\s+as?signments?\s+to\s+submit\b/i.test(t) ||
    // "Is there anything due for X course?"
    /\bis\s+there\s+anything\s+due\s+for\b/i.test(t) ||
    // "Do I need to turn in anything for X?"
    /\bdo\s+i\s+need\s+to\s+turn\s+in\s+anything\b/i.test(t) ||
    // "Is there an assignment I'm supposed to submit for X?"
    /\bis\s+there\s+an?\s+as?signments?\s+i['’]?\s*m\s+supposed\s+to\s+submit\b/i.test(t) ||
    // "Am I required to submit anything for X?"
    /\bam\s+i\s+required\s+to\s+submit\s+anything\b/i.test(t) ||
    // "Do I have anything pending in/for/of X?"
    /\bdo\s+i\s+have\s+anything\s+pending\s+(in|for|of)\b/i.test(t) ||
    // "do I have any assignments (for/in/of X)?"
    /\bdo\s+i\s+have\s+any\s+as?signments?\s+(for|in|of)\b/i.test(t) ||
    /\bdo\s+i\s+have\s+as?signments?\s+(for|in|of)\b/i.test(t)
  );
}

/** True if the user is asking about a single assignment submission, e.g. "did I submit X?". */
function isSingleAssignmentSubmissionCheckQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  return (
    /\bdid\s+i\s+(already\s+)?submit\b/i.test(t) ||
    /\bhave\s+i\s+(already\s+)?submitted\b/i.test(t) ||
    /\bhave\s+i\s+(already\s+)?turned\s+in\b/i.test(t) ||
    /\bdid\s+i\s+(already\s+)?hand\s+in\b/i.test(t)
  );
}

/** True if the user is asking about assignments to submit across all courses (no specific course). */
function isGlobalSubmissionStatusQuestion(text) {
  if (!text || typeof text !== "string") return false;
  // If the text clearly refers to a specific course, this is NOT a global question.
  if (isCourseQuestion(text)) return false;
  const t = text.toLowerCase().trim();
  const mentionsAllCourses =
    /\ball\s+courses\b/i.test(t) ||
    /\bevery\s+course\b/i.test(t) ||
    /\ball\s+my\s+courses\b/i.test(t);
  const assignmentsAndSubmit =
    /\bas?signments?\b/i.test(t) &&
    (/\bneed\s+to\s+submit\b/i.test(t) || /\bhave\s+to\s+submit\b/i.test(t) || /\bleft\s+to\s+submit\b/i.test(t));
  const genericAllAssignments =
    /\bwhat\s+assignments\s+do\s+i\s+need\s+to\s+submit\b/i.test(t) ||
    /\bwhat\s+are\s+all\s+the\s+assignments\s+that\s+i\s+need\s+to\s+submit\b/i.test(t) ||
    /\bwhat\s+are\s+all\s+my\s+assignments\s+that\s+i\s+need\s+to\s+submit\b/i.test(t);
  const pendingAssignmentsOnly =
    /\bwhat\s+are\s+all\s+my\s+pending\s+as?signments?\b/i.test(t) ||
    /\bwhat\s+are\s+my\s+pending\s+as?signments?\b/i.test(t) ||
    /\bwhat\s+as?signments\s+are\s+pending\b/i.test(t) ||
    /\blist\s+my\s+pending\s+as?signments?\b/i.test(t);
  const genericSubmitAnything =
    /\bdo\s+i\s+need\s+to\s+submit\s+anything\b/i.test(t) ||
    /\bdo\s+i\s+have\s+(anything|something)\s+left\s+to\s+submit\b/i.test(t) ||
    /\bdo\s+i\s+need\s+to\s+submit\s+any\s+as?signments?\b/i.test(t) ||
    /\bdo\s+i\s+need\s+to\s+submit\s+as?signments?\b/i.test(t);
  return genericAllAssignments || (assignmentsAndSubmit && mentionsAllCourses) || pendingAssignmentsOnly || genericSubmitAnything;
}

/** True si la pregunta es solo sobre assignments/grades/deadlines (no sobre clases/sesiones). No inyectar calendario en ese caso. */
function isAssignmentOnlyQuery(text) {
  if (!isAssignmentQuery(text)) return false;
  const t = (text || "").toLowerCase();
  return !/\b(clase[s]?|sesi[oó]n|sesiones|horario[s]?|session[s]?|class(?:es)?)\b/i.test(t);
}

/** Levenshtein distance for fuzzy "attendance" typo repair (e.g. attsndance). */
function levenshteinStr(a, b) {
  const s = a || "";
  const t = b || "";
  const n = s.length;
  const m = t.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const dp = new Array(m + 1);
  for (let j = 0; j <= m; j++) dp[j] = j;
  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      const c = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + c);
      prev = tmp;
    }
  }
  return dp[m];
}

/**
 * Fix common typos / slang so attendance intent is detected without exact wording.
 * Applied before isAttendanceQuestion and before course resolution.
 * @param {string} raw
 * @returns {string}
 */
function normalizeAttendanceQueryTypos(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw.toLowerCase().trim();
  s = s.replace(/\bsupa\s+/g, "");
  s = s.replace(/\bgimme\b/g, "give me");
  s = s.replace(/\bmicroecon\b/g, "microeconomics");
  s = s.replace(/\bmicrocecon\b/g, "microeconomics");
  s = s.replace(/\battendnce\b/g, "attendance");
  s = s.replace(/\battendnces\b/g, "attendance");
  s = s.replace(/\battndace\b/g, "attendance");
  s = s.replace(/\battendanc\b/g, "attendance");
  s = s.replace(/\battendace\b/g, "attendance");
  s = s.replace(/\batendance\b/g, "attendance");
  s = s.replace(/\batendances?\b/g, "attendance");
  s = s.replace(/\battendence\b/g, "attendance");
  s = s.replace(/\bassistencia\b/g, "asistencia");
  s = s.replace(/\b[a-z]{8,13}\b/gi, function (w) {
    const lw = w.toLowerCase();
    if (lw === "attendance" || lw === "microeconomics") return w;
    if (lw.length >= 8 && lw.length <= 13 && levenshteinStr(lw, "attendance") <= 2) return "attendance";
    return w;
  });
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** True si el usuario pregunta por asistencia/attendance (porcentaje por curso, gradebook). */
function isAttendanceQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  return (
    /\b(attendance|asistencia)\b/i.test(t) ||
    /\bporcentaje\s+de\s+asistencia\b/i.test(t) ||
    /\bmi\s+attendance\b/i.test(t) ||
    /\bmy\s+attendance\b/i.test(t) ||
    /\b(faltas|asistencias)\s+(en|de|del)\b/i.test(t) ||
    /\b(qué|que|cuál|what)\s+(es\s+)?(mi\s+)?(attendance|asistencia)\b/i.test(t) ||
    /\b(attendance|asistencia)\s+(en|for|of|de|in|on)\b/i.test(t) ||
    /\bhow\s+(is\s+)?(my\s+)?attendance\b/i.test(t) ||
    /\b(?:what\s+is|what'?s|whats|how'?s|how\s+is)\s+my\s+attendance\b/i.test(t) ||
    /\battendance\s+(?:score|grade|percentage|percent)\b/i.test(t) ||
    /\b(?:score|grade|percentage)\s+(?:for|on|in)\s+attendance\b/i.test(t)
  );
}

/** Recent chat was about gradebook attendance so follow-ups like "and for X?" stay on attendance. */
function hasRecentAttendanceDomainInChat() {
  const recent = (getRecentChatWindowText(12) + "\n" + getLastAssistantMessageText()).toLowerCase();
  return (
    /\battendance|asistencia|attendance score|your attendance|qwattendance\b/.test(recent) ||
    /\d+\.\d+\s*%\s*(?:in|for)\b/.test(recent)
  );
}

/** After an attendance answer, short course switch: "and for cost accounting?" */
function isAttendanceCourseSwitchFollowUp(text) {
  if (!text || typeof text !== "string") return false;
  if (!hasRecentAttendanceDomainInChat()) return false;
  const t = text.trim();
  return (
    /^(?:and|or|also)\s+for\s+(?!.*(?:grade|final|exam|project|assignment|test|homework)).{1,40}(?:\?)?$/i.test(t) ||
    /^(?:and|or|also)\s+in\s+[a-z]/i.test(t) ||
    /^(?:what|how)\s+about\s+(?!.*(?:grade|final|exam|project|assignment|test|homework)).{1,40}\??$/i.test(t)
  );
}

/**
 * Expand follow-ups into a full attendance query for course resolution.
 * @param {string} originalText - raw user message (for follow-up shape detection)
 * @param {string} [normalizedSeed] - output of normalizeAttendanceQueryTypos(originalText)
 */
function augmentAttendanceUserText(originalText, normalizedSeed) {
  if (!originalText || typeof originalText !== "string") return originalText || "";
  const base =
    normalizedSeed != null && String(normalizedSeed).trim() !== ""
      ? String(normalizedSeed).trim()
      : normalizeAttendanceQueryTypos(originalText);
  if (!isAttendanceCourseSwitchFollowUp(originalText)) return base;
  const trimmed = base.trim();
  let m = trimmed.match(/^(?:and|or|also)\s+for\s+(.+)/i);
  if (m && m[1]) return "what is my attendance for " + m[1].trim().replace(/\?+$/, "");
  m = trimmed.match(/^(?:and|or|also)\s+in\s+(.+)/i);
  if (m && m[1]) return "what is my attendance for " + m[1].trim().replace(/\?+$/, "");
  m = trimmed.match(/^what\s+about\s+(.+)\??$/i);
  if (m && m[1]) return "what is my attendance for " + m[1].trim().replace(/\?+$/, "");
  m = trimmed.match(/^how\s+about\s+(.+)\??$/i);
  if (m && m[1]) return "what is my attendance for " + m[1].trim().replace(/\?+$/, "");
  return base;
}

/** True if the user is asking for their grade(s) (single assignment or all for a course). */
function isAssignmentGradeQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const t = normalizeAssignmentQueryTypos(text);
  return (
    /\b(?:are\s+there\s+)?any\s+assignments?\s+(?:in|for|of)\b/i.test(t) ||
    /\b(?:got|have)\s+any\s+assignments?\s+(?:in|for|of)\b/i.test(t) ||
    /\bdo\s+i\s+have\s+any\s+assignments?\s+(?:in|for|of)\b/i.test(t) ||
    /\b(?:give|show|get)\s+me\s+(?:the\s+)?(?:ones|those)\s+(?:in|for)\b/i.test(t) ||
    /\bwhat\s+are\s+my\s+assignments?\s+(?:like\s+)?(?:only\s+)?(?:for|in|of)\b/i.test(t) ||
    /\b(?:i\s+want|i\s+need)\s+(?:my\s+)?(?:last|first|next)\s+assignments?\s+(?:of|for|in)\b/i.test(t) ||
    /\b(?:i\s+want|give\s+me|show\s+me)\s+(?:my\s+)?(?:last|first|all)\s+assignments?\s+(?:of|for|in)\b/i.test(t) ||
    /\bwhat'?s\s+my\s+grade\s+on\b/i.test(t) ||
    /\bwhat\s+is\s+my\s+grade\s+(on|for)\b/i.test(t) ||
    /\bwhat\s+are\s+my\s+grades?\s+(on|for|in)?\b/i.test(t) ||
    /\bmy\s+grade\s+(on|for)\b/i.test(t) ||
    /\bgrade\s+for\s+/i.test(t) ||
    /\bgrade\s+on\s+/i.test(t) ||
    /\bgrades?\s+(on|for|of|in)\s+/i.test(t) ||
    /\bhow\s+did\s+i\s+do\s+(on|in)\b/i.test(t) ||
    /\bscore\s+(on|for)\s+/i.test(t) ||
    /\bwhat\s+(did\s+i\s+)?(get|score)\s+(on|for)\b/i.test(t) ||
    // Treat "what are (all) my assignments of/for/in X" as a request to list all assignments/grades for that course.
    /\bwhat\s+are\s+(?:all\s+)?(?:my\s+)?as?signments?\s+(?:of|for|in)\b/i.test(t) ||
    /\bwhat\s+are\s+(?:all\s+)?(?:mi\s+)?as?signments?\s+(?:of|for|in)\b/i.test(t) ||
    /\bwhat\s+are\s+all\s+the\s+as?signments?\s+(?:of|for|in)\b/i.test(t) ||
    // "what assignments do I have in X" / "what assignments are there in X"
    /\bwhat\s+as?signments?\s+(?:do\s+i\s+)?have\s+(?:for|in|of)\b/i.test(t) ||
    /\bwhat\s+as?signments?\s+are\s+there\s+(?:in|for|of)\b/i.test(t) ||
    // "Show me my assignments for X"
    /\bshow\s+me\s+my\s+as?signments?\s+for\b/i.test(t) ||
    // "What tasks do I have in X" / "What homework do I have in X" / "What coursework do I have for X" / "What deliverables do I have in X"
    /\bwhat\s+tasks?\s+do\s+i\s+have\s+(?:in|for|of)\b/i.test(t) ||
    /\bwhat\s+homework\s+do\s+i\s+have\s+(?:in|for|of)\b/i.test(t) ||
    /\bwhat\s+work\s+is\s+assigned\s+(?:in|for|of)\b/i.test(t) ||
    /\bwhat\s+coursework\s+do\s+i\s+have\s+(?:for|in|of)\b/i.test(t) ||
    /\bwhat\s+deliverables?\s+do\s+i\s+have\s+(?:in|for|of)\b/i.test(t)
  );
}

function hasCourseMessagesIntent(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  const normalizedTypos = t
    .replace(/\bmesages?\b/g, " messages ")
    .replace(/\bmsgs?\b/g, " messages ")
    .replace(/\brecieved\b/g, " received ")
    .replace(/\breceve?d\b/g, " received ");
  const mentionsMessageDomain =
    /\bmessages?\b/i.test(normalizedTypos) ||
    /\bconversation(?:s)?\b/i.test(normalizedTypos) ||
    /\bthread(?:s)?\b/i.test(normalizedTypos) ||
    /\binbox\b/i.test(normalizedTypos) ||
    /\bcommunication(?:s)?\b/i.test(normalizedTypos) ||
    /\brepl(?:y|ies|ied)\b/i.test(normalizedTypos) ||
    /\bunread\b/i.test(normalizedTypos);
  const messageAction =
    /\b(last|latest|recent|new|unread|received|sent|from|mentioning|containing|search|find|check|show|list|open|read|posted|what|which|any|all)\b/i.test(normalizedTypos) ||
    /\bdo\s+i\s+have\b/i.test(normalizedTypos) ||
    /\bhas\s+.*\b(written|replied|sent|posted)\b/i.test(normalizedTypos) ||
    /\bwho\s+sent\b/i.test(normalizedTypos) ||
    /\bwhen\s+was\b/i.test(normalizedTypos) ||
    /\bcan\s+you\s+(show|check|find|get|read)\b/i.test(normalizedTypos);
  const implicitMessageQuery =
    /\b(last|latest|recent)\b/i.test(normalizedTypos) &&
    /\b(received|sent)\b/i.test(normalizedTypos);
  const messageQuestionShape =
    /\?/.test(normalizedTypos) ||
    /\b(what|which|when|who|show|list|find|get|check|read|open|tell\s+me|give\s+me|do\s+i\s+have|are\s+there)\b/i.test(normalizedTypos) ||
    isCourseQuestion(normalizedTypos);
  const excludesAnnouncementsOnly =
    !/\bannouncement(?:s)?\b/i.test(normalizedTypos) ||
    mentionsMessageDomain;
  return (mentionsMessageDomain || implicitMessageQuery) && (messageAction || messageQuestionShape || implicitMessageQuery) && excludesAnnouncementsOnly;
}

/** True if the user is asking about course messages/conversations (Blackboard messages in a course). Not announcements. */
function isCourseMessagesQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  if (hasCourseMessagesIntent(t)) return true;
  // Support looser course-specific wording such as "did the professor write in X?" even without the word "message".
  return (
    isCourseQuestion(text) &&
    (
      /\b(wrote|written|replied|reply|sent|posted|answered|responded)\b/i.test(t) ||
      /\b(anything\s+new|anything\s+unread|anything\s+recent)\b/i.test(t)
    )
  );
}

/** True if the user is asking for the single most recent message across all courses. */
function isGlobalLastMessageQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  return (
    (hasCourseMessagesIntent(t) && !isCourseQuestion(t) && /\b(last|latest|most\s+recent|newest)\b/i.test(t)) ||
    /\b(what'?s|what\s+is|what\s+was)\s+my\s+last\s+message\b/i.test(t) ||
    /\bshow\s+me\s+my\s+most\s+recent\s+message\b/i.test(t) ||
    /\bmy\s+most\s+recent\s+message\b/i.test(t)
  );
}

function getMostRecentUserMessageText() {
  if (!Array.isArray(chatHistory) || chatHistory.length === 0) return "";
  for (let i = chatHistory.length - 1; i >= 0; i -= 1) {
    const item = chatHistory[i];
    if (item && item.role === "user" && typeof item.content === "string" && item.content.trim()) {
      return item.content.trim();
    }
  }
  return "";
}

function isMessagesFollowUpQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  const shortFollowUp =
    /^(and\s+)?(my\s+)?last\s+\d{1,2}\??$/.test(t) ||
    /^(the\s+)?\d{1,2}\s+(latest|most\s+recent)\s*$/i.test(t) ||
    /^(and\s+)?(the\s+)?\d{1,2}\s+latest\s*$/i.test(t) ||
    /^(and\s+)?(what\s+about\s+)?(from|since)\s+(yesterday|today|last\s+week|this\s+week|ayer|hoy)\??$/.test(t) ||
    /^(from\s+)?(any|all)\s+course[s]?\??$/.test(t) ||
    /^(from\s+)?anywhere\??$/.test(t);
  if (!shortFollowUp) return false;
  const previousUserText = getMostRecentUserMessageText();
  return !!previousUserText && hasCourseMessagesIntent(previousUserText);
}

/** Global messages query (across all courses), including natural follow-ups like "and my last 4?" after a messages question. */
function isGlobalMessagesQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  if (isCourseQuestion(t)) return false;
  if (hasCourseMessagesIntent(t)) return true;
  if (/^(from\s+)?(any|all)\s+course[s]?\??$/.test(t) || /^(from\s+)?anywhere\??$/.test(t)) {
    const previousUserText = getMostRecentUserMessageText();
    return !!previousUserText && hasCourseMessagesIntent(previousUserText);
  }
  return isMessagesFollowUpQuestion(t);
}

function hasAnnouncementsIntentText(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  return (
    /\bannoun\w*ment\w*\b/i.test(t) ||
    /\bannouncement[s]?\b/i.test(t) ||
    /\bannounc\w*\b/i.test(t) ||
    /\bnotice[s]?\b/i.test(t) ||
    /\bupdate[s]?\b/i.test(t) ||
    /\b(aviso|avisos|anuncio|anuncios)\b/i.test(t)
  );
}

function getRecentChatWindowText(maxItems) {
  const take = Math.max(1, Number(maxItems) || 6);
  if (!Array.isArray(chatHistory) || chatHistory.length === 0) return "";
  return chatHistory
    .slice(-take)
    .map((m) => (m && typeof m.content === "string" ? m.content : ""))
    .filter(Boolean)
    .join("\n");
}

/** Prior turns (before the current message) sent to the service worker for course resolution + model context. */
function getRecentMessagesForSyllabusApi() {
  if (!Array.isArray(chatHistory) || chatHistory.length === 0) return [];
  return chatHistory.slice(-8).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 2500)
  }));
}

function hasRecentAnnouncementsContext() {
  const recent = getRecentChatWindowText(8).toLowerCase();
  if (!recent) return false;
  return (
    /\bannoun\w*ment\w*\b/.test(recent) ||
    /\bannouncement[s]?\b/.test(recent) ||
    /\bnotice[s]?\b/.test(recent) ||
    /\bupdate[s]?\b/.test(recent) ||
    /\b(aviso|avisos|anuncio|anuncios)\b/.test(recent)
  );
}

function isGenericLatestFollowUp(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  return (
    /^(and\s+)?(like\s+)?(the\s+)?latest\??$/.test(t) ||
    /^(and\s+)?(like\s+)?what'?s\s+(the\s+)?latest\??$/.test(t) ||
    /^(and\s+)?(give|show|tell)\s+me\s+(the\s+)?latest\??$/.test(t) ||
    /^(and\s+)?(give|show|tell)\s+me\s+(the\s+)?last\s+one\??$/.test(t)
  );
}

function isAnnouncementsFollowUpQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  const isShortFollowUp =
    /^(and\s+)?announcement\??$/.test(t) ||
    /^(and\s+)?announcements\??$/.test(t) ||
    /^(like\s+)?what'?s\s+my\s+last\s+one\??$/.test(t) ||
    /^(and\s+)?(the\s+)?last\s+one\??$/.test(t) ||
    /^(and\s+)?(the\s+)?latest\s+one\??$/.test(t);
  if (!isShortFollowUp && !isGenericLatestFollowUp(t)) return false;
  const prev = getMostRecentUserMessageText();
  return hasAnnouncementsIntentText(prev) || hasRecentAnnouncementsContext();
}

function normalizeAnnouncementsFollowUpQuery(text) {
  if (!isAnnouncementsFollowUpQuestion(text)) return text;
  const t = String(text || "").toLowerCase();
  if (/\blast\b|\blatest\b/.test(t)) {
    return "show me the latest announcement across all courses";
  }
  return "show me announcements across all courses";
}

function buildGlobalMessagesPlan(userText) {
  const t = (userText || "").toLowerCase().trim();
  const plan = {
    intent: "GET_LAST_MESSAGE",
    course: { name: "all courses", id: "" },
    filters: { unreadOnly: false, sender: "" },
    query: { keywords: [], raw: userText || "" },
    dateRange: { from: "", to: "" },
    limit: 1,
    needsRefresh: true,
    responseStyle: "brief"
  };
  if (/\bunread\b/i.test(t)) {
    plan.intent = "CHECK_UNREAD";
    plan.filters.unreadOnly = true;
    plan.limit = 10;
    return plan;
  }
  const latestN = t.match(/\b(?:the\s+)?(\d{1,2})\s+(?:latest|most\s+recent)\b/i);
  if (latestN) {
    plan.intent = "GET_RECENT_MESSAGES";
    plan.limit = Math.max(1, Math.min(10, parseInt(latestN[1], 10) || 1));
    return plan;
  }
  const mostNRecent = t.match(/\bmost\s+(\d{1,2})\s+recent\b/i);
  if (mostNRecent) {
    plan.intent = "GET_RECENT_MESSAGES";
    plan.limit = Math.max(1, Math.min(10, parseInt(mostNRecent[1], 10) || 1));
    return plan;
  }
  const lastN = t.match(/\blast\s+(\d{1,2})\b/i);
  if (lastN) {
    plan.intent = "GET_RECENT_MESSAGES";
    plan.limit = Math.max(1, Math.min(10, parseInt(lastN[1], 10) || 1));
    return plan;
  }
  if (/\b(yesterday|ayer)\b/i.test(t)) {
    const now = new Date();
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const ymd = y.toISOString().slice(0, 10);
    plan.intent = "SEARCH_BY_DATE_RANGE";
    plan.dateRange.from = ymd;
    plan.dateRange.to = ymd;
    plan.limit = 10;
    return plan;
  }
  if (/\b(today|hoy)\b/i.test(t)) {
    const now = new Date();
    const ymd = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString().slice(0, 10);
    plan.intent = "SEARCH_BY_DATE_RANGE";
    plan.dateRange.from = ymd;
    plan.dateRange.to = ymd;
    plan.limit = 10;
    return plan;
  }
  if (/\blast|latest|recent|newest\b/i.test(t)) {
    plan.intent = "GET_LAST_MESSAGE";
    plan.limit = 1;
    return plan;
  }
  plan.intent = "GET_RECENT_MESSAGES";
  plan.limit = 5;
  return plan;
}

/**
 * Sistema de assignments/entregas — MÓDULO AISLADO. No modificar al cambiar otras funciones.
 * Devuelve el bloque [ASSIGNMENTS_CONTEXT] para el prompt (gradebook; misma fuente que el widget).
 */
function getAssignmentsContextBlock(gradebookByCourseId) {
  const upcomingAll = getUpcomingAssignmentsAll(gradebookByCourseId, 20);
  if (upcomingAll.length > 0) {
    return (
      "[ASSIGNMENTS_CONTEXT]\n" +
      "Rule: Use ONLY this data to answer questions about assignments, tasks, or deadlines. Do not use calendar or syllabus for assignment due dates.\n" +
      "Upcoming assignments (courseName, title, dueDate): " +
      JSON.stringify(upcomingAll.map((a) => ({ courseName: a.courseName, title: a.title, dueDate: a.dueDate }))) +
      "\n[/ASSIGNMENTS_CONTEXT]"
    );
  }
  return "[ASSIGNMENTS_CONTEXT]\nNo upcoming assignments in the gradebook. If the user asks about assignments, tell them to sync syllabi and try again.\n[/ASSIGNMENTS_CONTEXT]";
}

/** True if the user query is about midterm dates/sessions (all midterms, one course midterm, when is the midterm, etc.). */
function isMidtermRelatedQuery(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  return (
    isAllMidtermsQuery(t) ||
    isExamDateQuestion(t) ||
    /\b(?:midterm|mid-term|parcial|intermediate\s+exam)\s+(?:date|dates|session|when|fecha|cu[aá]ndo|closest|nearest|next|last|latest|first|second|third)\b/i.test(t) ||
    /\b(?:closest|nearest|next|last|latest|first|second|third)\s+(?:midterm|mid-term|parcial)\b/i.test(t)
  );
}

/** Returns [MIDTERM_DATES] block from cached midterm dates for use in the main chat prompt. Uses cache only (no refresh). */
async function getMidtermDatesContextBlock() {
  try {
    const res = await sendMessage({ type: "GET_MIDTERM_DATES_CACHE" });
    const cache = res?.cache;
    const items = cache?.items;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return "[MIDTERM_DATES]\nNo midterm dates in the database. The user can open Options > Midterm dates and click Refresh to populate.\n[/MIDTERM_DATES]";
    }
    const lines = items.map((it) => {
      const session = it.midterm_session != null ? "Session " + it.midterm_session : "—";
      const dateTime = it.midterm_date
        ? it.midterm_date + (it.midterm_time ? " " + it.midterm_time : "") + (it.timezone ? " " + it.timezone : "")
        : "—";
      return it.courseName + ": " + session + ", " + dateTime;
    });
    return "[MIDTERM_DATES]\nUse this data to answer questions about midterm/intermediate exam dates. One line per course: courseName, session, date/time.\n" + lines.join("\n") + "\n[/MIDTERM_DATES]";
  } catch (_) {
    return "";
  }
}

/** True if the user query is about final exam dates/sessions (any question about the DATE of final exams). */
function isFinalRelatedQuery(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  return (
    isAllFinalsQuery(t) ||
    (isExamDateQuestion(t) && /\b(?:final\s+exam|final\s+examination|final\s+test|finals?|examen\s+final)\b/i.test(t)) ||
    /\b(?:final\s+exam|final\s+examination|finals?)\s+(?:date|dates|session|when|fecha|cu[aá]ndo|closest|nearest|next|last|latest|first|second|third|close|soon)\b/i.test(t) ||
    /\b(?:date|dates|fecha|fechas)\s+(?:of|for|de|del|de\s+los?)\s+(?:the\s+)?(?:final\s+exams?|finals?|examen(?:es)?\s+final(?:es)?)/i.test(t) ||
    /\b(?:cu[aá]ndo|when)\s+(?:es|son|is|are)\s+(?:el|la|los|las|the\s+)?(?:final\s+exam\s+)?(?:final(?:es)?|exam(?:s)?)/i.test(t) ||
    /\b(?:closest|nearest|next|last|latest|first|second|third|close)\s+(?:final|finals|final\s+exam)\b/i.test(t) ||
    /\b(?:do\s+i\s+have|have\s+i\s+got)\s+any\s+(?:final\s+exam|finals?)\b/i.test(t) ||
    /\b(?:any|some)\s+(?:final\s+exam|finals?)\s+(?:close|soon|coming|left|next)\b/i.test(t) ||
    /\bgot\s+any\s+(?:final\s+exam|finals?)\b/i.test(t)
  );
}

function getLastAssistantMessageText() {
  if (!Array.isArray(chatHistory) || chatHistory.length === 0) return "";
  for (let i = chatHistory.length - 1; i >= 0; i -= 1) {
    const item = chatHistory[i];
    if (item && item.role === "assistant" && typeof item.content === "string" && item.content.trim()) {
      return item.content.trim();
    }
  }
  return "";
}

/** Recent chat mentions gradebook / assignments so short follow-ups ("and for X") route to GET_ASSIGNMENT_GRADE. */
function hasRecentAssignmentDomainInChat() {
  const recent = (getRecentChatWindowText(12) + "\n" + getLastAssistantMessageText()).toLowerCase();
  return /\bassignments?|gradebook|here are your grades|grades?\s+for|homework|due\s*:|•\s|entregas?|tareas?\b/.test(recent);
}

function extractCourseFromLastAssistantGradesLine() {
  const last = getLastAssistantMessageText();
  if (!last) return "";
  const m =
    last.match(/grades?\s+for\s+([^\n:]+?)(?:\s*:|\n|$)/i) ||
    last.match(/Here are your grades for\s+([^\n:]+?)(?:\s*:|\n|$)/i);
  return m ? m[1].trim().replace(/\s+/g, " ") : "";
}

function isAssignmentCourseSwitchFollowUp(text) {
  if (!text || typeof text !== "string") return false;
  if (!hasRecentAssignmentDomainInChat()) return false;
  const t = text.trim();
  if (/^(?:and|or|also)\s+for\s+[a-z]/i.test(t)) return true;
  // "and in physics?" — same intent as "any assignments in physics" after a grade list for another course.
  if (/^(?:and|or|also)\s+in\s+[a-z]/i.test(t)) return true;
  return false;
}

/** "give me the ones in microecon" / "the ones for physics" — refers to assignments from conversation context. */
function isAssignmentReferentFollowUp(text) {
  if (!text || typeof text !== "string") return false;
  if (!hasRecentAssignmentDomainInChat()) return false;
  const t = normalizeAssignmentQueryTypos(normalizeClassQueryTypos(text));
  return (
    /\b(?:give|show|get)\s+me\s+(?:the\s+)?(?:ones|those)\s+(?:in|for)\b/i.test(t) ||
    /\b(?:the\s+)?(?:ones|those)\s+(?:in|for)\s+[a-z]/i.test(t)
  );
}

/** Expand short natural follow-ups so gradebook parsing gets a full "all assignments for [course]" query. */
function augmentAssignmentGradeUserText(text) {
  if (!text || typeof text !== "string") return text;
  const trimmed = text.trim();
  if (isAssignmentCourseSwitchFollowUp(text)) {
    let m = trimmed.match(/^(?:and|or|also)\s+for\s+(.+)/i);
    if (m && m[1]) return "what are all my assignments for " + m[1].trim().replace(/\?+$/, "");
    m = trimmed.match(/^(?:and|or|also)\s+in\s+(.+)/i);
    if (m && m[1]) return "what are all my assignments for " + m[1].trim().replace(/\?+$/, "");
  }
  if (isAssignmentReferentFollowUp(text)) {
    const m = trimmed.match(/\b(?:in|for)\s+([^?.!\n]+)/i);
    if (m && m[1]) {
      const course = m[1].trim().replace(/\?+$/, "").trim();
      if (course.length >= 2 && !/^(today|tomorrow|yesterday|tday|tmrw)$/i.test(course)) {
        return "what are all my assignments for " + course;
      }
    }
  }
  if (/^\s*(?:all\s+the\s+)?assignments?\s*\.?\s*$/i.test(trimmed) && hasRecentAssignmentDomainInChat()) {
    const course = extractCourseFromLastAssistantGradesLine();
    if (course) return "what are all my assignments for " + course;
  }
  return text;
}

/** When true, use gradebook lookup even if NLU chose COMBINED_COURSE_QUERY (single-intent confidence blocks legacy fallback). */
function assignmentGradeRoutePredicate(t) {
  return (
    isAssignmentGradeQuestion(t) ||
    isAssignmentCourseSwitchFollowUp(t) ||
    isAssignmentReferentFollowUp(t) ||
    (isAssignmentQuery(t) && isCourseQuestion(t) && !isAssignmentsFollowUpQuestion(t) && !isSubmissionStatusQuestion(t) && !isGlobalSubmissionStatusQuestion(t))
  );
}

function isExamFollowUpQuestion(text) {
  const t = (text || "").toLowerCase().trim();
  if (!t) return false;
  const followUpShape = /^(and\s+)?(like\s+)?(which\s+one|what\s+about|the\s+closest|the\s+nearest|the\s+latest|the\s+last|the\s+earliest|the\s+oldest|the\s+third|the\s+second|the\s+first|my\s+earliest|my\s+latest|my\s+last)\??$/.test(t);
  const allShape =
    /^(and\s+)?(when\s+are\s+)?all\s+of\s+them\??$/.test(t) ||
    /^(and\s+)?all\s+of\s+them\??$/.test(t) ||
    /^(and\s+)?(no\s+but\s+)?(give|show|tell)\s+me\s+all\??$/.test(t) ||
    /^(and\s+)?all\??$/.test(t);
  const switchExamKindShape =
    /^(and\s+)?(midterms?|parciales?|finals?|final\s+exams?)\s*(too|as\s+well)?\??$/.test(t);
  if (!followUpShape && !allShape && !switchExamKindShape) return false;
  const recent = (getMostRecentUserMessageText() + "\n" + getLastAssistantMessageText()).toLowerCase();
  return /\bmidterm|parcial|final\s+exam|finals?\b/.test(recent);
}

function examKindFromText(text) {
  const t = (text || "").toLowerCase();
  if (/\bmidterm|mid-term|parcial\b/.test(t)) return "midterm";
  if (/\bfinal|finals|final\s+exam\b/.test(t)) return "final";
  const recent = (getMostRecentUserMessageText() + "\n" + getLastAssistantMessageText()).toLowerCase();
  if (/\bmidterm|mid-term|parcial\b/.test(recent)) return "midterm";
  if (/\bfinal|finals|final\s+exam\b/.test(recent)) return "final";
  return "";
}

function getRecentExamContextText() {
  return (getRecentChatWindowText(10) + "\n" + getLastAssistantMessageText()).toLowerCase();
}

function detectExamIntentFromConversation(text) {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) return { hasIntent: false, kind: "", source: "none" };
  const normalized = raw
    .replace(/\bwhens\b/gi, "when ")
    .replace(/\bmidt?rem\b/g, " midterm ")
    .replace(/\bparcial(?:es)?\b/g, " midterm ")
    .replace(/\bfinals\b/g, " final ");
  // Hard guard: assignment queries must never be hijacked by exam context.
  if (/\b(assignments?|assignmentss|deliverables?|tasks?|homework|entregas?|tareas?)\b/.test(normalized)) {
    return { hasIntent: false, kind: "", source: "assignment_guard" };
  }
  const hasFinalWord = /\bfinal(?:\s+exam)?\b/.test(normalized);
  const hasMidtermWord = /\bmidterm\b/.test(normalized);
  const hasDateIntent =
    /\b(whens|when|date|fecha|cu[aá]ndo|closest|nearest|next|last|latest|earliest|oldest|first|second|third|close|soon)\b/.test(normalized) ||
    /\b(all|all of them|all of my|all my)\b/.test(normalized) ||
    /\b(?:do\s+i\s+have|have\s+i\s+got)\s+any\s+(?:final|finals|final\s+exam)\b/.test(normalized);
  if ((hasFinalWord || hasMidtermWord) && hasDateIntent) {
    return { hasIntent: true, kind: hasFinalWord ? "final" : "midterm", source: "explicit" };
  }
  if ((hasFinalWord || hasMidtermWord) && /\b(my|mine)\b/.test(normalized)) {
    return { hasIntent: true, kind: hasFinalWord ? "final" : "midterm", source: "explicit_my_exam" };
  }

  const recent = getRecentExamContextText();
  const hasRecentExamDomain = /\bmidterm|parcial|final\s+exam|finals?\b/.test(recent);
  const followUpShape =
    /^(and\s+)?(like\s+)?(the\s+)?(closest|nearest|next|last|latest|earliest|oldest|first|second|third)\??$/.test(normalized) ||
    /^(and\s+)?(when\s+are\s+)?all\s+of\s+them\??$/.test(normalized) ||
    /^(and\s+)?which\s+one\??$/.test(normalized) ||
    /^(and\s+)?my\s+(earliest|latest|last)\??$/.test(normalized) ||
    /^(and\s+)?(no\s+but\s+)?(give|show|tell)\s+me\s+all\??$/.test(normalized) ||
    /^(and\s+)?all\??$/.test(normalized) ||
    /^(and\s+)?(midterms?|parciales?|finals?|final\s+exams?)\s*(too|as\s+well)?\??$/.test(normalized);
  // Contextual follow-up only when the utterance itself is a compact exam-like follow-up.
  if (hasRecentExamDomain && followUpShape) {
    const inferredKind = /\bmidterm|parcial\b/.test(recent) ? "midterm" : (/\bfinal\b/.test(recent) ? "final" : "");
    return { hasIntent: true, kind: inferredKind, source: "context_followup" };
  }
  return { hasIntent: false, kind: "", source: "none" };
}

function getOrdinalRankFromText(text) {
  const t = (text || "").toLowerCase();
  const m = t.match(/\b(\d+)(?:st|nd|rd|th)?\b/);
  if (m) return Math.max(1, parseInt(m[1], 10) || 1);
  if (/\bfirst|primer[oa]?\b/.test(t)) return 1;
  if (/\bsecond|segund[oa]?\b/.test(t)) return 2;
  if (/\bthird|tercer[oa]?\b/.test(t)) return 3;
  return null;
}

function parseExamDateEpoch(item, kind) {
  const dateKey = kind === "midterm" ? "midterm_date" : "final_date";
  const timeKey = kind === "midterm" ? "midterm_time" : "final_time";
  const d = (item && item[dateKey]) ? String(item[dateKey]).trim() : "";
  if (!d) return null;
  const time = (item && item[timeKey]) ? String(item[timeKey]).trim() : "00:00";
  const iso = d.includes("T") ? d : (d + "T" + (time.length >= 5 ? time : "00:00") + ":00Z");
  const epoch = Date.parse(iso);
  return Number.isNaN(epoch) ? null : epoch;
}

function parseExamSortableValue(item, kind) {
  const dateKey = kind === "midterm" ? "midterm_date" : "final_date";
  const timeKey = kind === "midterm" ? "midterm_time" : "final_time";
  const d = (item && item[dateKey]) ? String(item[dateKey]).trim() : "";
  if (!d) return null;
  const dm = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!dm) return null;
  const t = (item && item[timeKey]) ? String(item[timeKey]).trim() : "00:00";
  const tm = t.match(/^(\d{1,2}):(\d{2})/);
  const hh = tm ? String(parseInt(tm[1], 10)).padStart(2, "0") : "00";
  const mm = tm ? tm[2] : "00";
  return Number(dm[1] + dm[2] + dm[3] + hh + mm);
}

function normalizeExamCourseText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractReferenceCourseFromExamQuery(text) {
  const t = normalizeExamCourseText(text);
  const m =
    t.match(/\b(?:before|after)\s+([a-z0-9][a-z0-9\s]{2,60})$/i) ||
    t.match(/\b(?:before|after)\s+([a-z0-9][a-z0-9\s]{2,60})\b/i) ||
    t.match(/\b(?:antes\s+de|despues\s+de)\s+([a-z0-9][a-z0-9\s]{2,60})$/i);
  if (!m) return "";
  return String(m[1] || "").replace(/\b(final|exam|midterm|parcial|the|el|la|de|del)\b/g, " ").replace(/\s+/g, " ").trim();
}

function formatExamDateForAnswer(item, kind) {
  const dateKey = kind === "midterm" ? "midterm_date" : "final_date";
  const timeKey = kind === "midterm" ? "midterm_time" : "final_time";
  const tzKey = kind === "midterm" ? "timezone" : "final_timezone";
  const d = item && item[dateKey] ? String(item[dateKey]).trim() : "";
  const t = item && item[timeKey] ? String(item[timeKey]).trim() : "";
  const tz = item && item[tzKey] ? String(item[tzKey]).trim() : "";
  if (!d) return "date not available";
  const epoch = parseExamDateEpoch(item, kind);
  if (epoch != null) {
    const dateObj = new Date(epoch);
    const dateStr = dateObj.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const timeStr = t ? " at " + t : "";
    const tzStr = tz ? " " + tz : "";
    return dateStr + timeStr + tzStr;
  }
  return d + (t ? " at " + t : "") + (tz ? " " + tz : "");
}

function buildExamNaturalAnswer(kind, items, userText) {
  const now = Date.now();
  const withDates = (items || [])
    .map((it) => ({
      it,
      epoch: parseExamDateEpoch(it, kind),
      sortValue: parseExamSortableValue(it, kind)
    }))
    .filter((x) => x.epoch != null && x.sortValue != null)
    .sort((a, b) => a.sortValue - b.sortValue);
  if (!withDates.length) {
    return "I don't have " + (kind === "midterm" ? "midterm" : "final exam") + " dates in the database right now. Open Options > " + (kind === "midterm" ? "Midterm dates" : "Final dates") + " and click Refresh.";
  }
  const t = (userText || "").toLowerCase();
  let selected = null;
  const asksPluralExamSet =
    (kind === "final" && /\bmy\s+finals\b/.test(t)) ||
    (kind === "midterm" && /\bmy\s+midterms\b|\bmis\s+parciales\b/.test(t));
  // Do not use \bfinals?\b — it matches singular "final" in "the final of X" and triggers listing every course.
  // Same for \bmidterms?\b vs "the midterm of X". Only plural + "too" patterns, or explicit "parciales".
  const switchAllByKind =
    (kind === "midterm" &&
      (/\bmidterms\b\s*(too|as\s+well)?\b/.test(t) || /\bparciales?\b/.test(t))) ||
    (kind === "final" && /\bfinals\b\s*(too|as\s+well)?\b/.test(t));
  const wantsAll = /\ball\b/.test(t) || /\ball of them\b/.test(t) || /\bwhen are all\b/.test(t) || asksPluralExamSet || switchAllByKind;
  const wantsBefore = /\bbefore\b|\bantes\s+de\b/.test(t);
  const wantsAfter = /\bafter\b|\bdespues\s+de\b/.test(t);
  if ((wantsBefore || wantsAfter) && withDates.length > 1) {
    const refName = extractReferenceCourseFromExamQuery(userText);
    if (refName) {
      const refNorm = normalizeExamCourseText(refName);
      const idx = withDates.findIndex((x) => normalizeExamCourseText(x.it.courseName).includes(refNorm));
      if (idx >= 0) {
        if (wantsBefore && idx > 0) selected = withDates[idx - 1];
        if (wantsAfter && idx < withDates.length - 1) selected = withDates[idx + 1];
      }
    }
  }
  if (/\bclosest|nearest|next\b/.test(t)) {
    selected = selected || withDates.find((x) => x.epoch >= now) || withDates[withDates.length - 1];
  } else if (/\bearliest|oldest|first\b/.test(t)) {
    selected = selected || withDates[0];
  } else if (/\blast|latest\b/.test(t)) {
    selected = selected || withDates[withDates.length - 1];
  } else {
    const rank = getOrdinalRankFromText(t);
    if (rank != null) selected = selected || withDates[Math.min(withDates.length, rank) - 1] || null;
  }
  if (!selected && wantsAll) {
    const label = kind === "midterm" ? "midterms" : "final exams";
    const lines = withDates.map(({ it }) => {
      const session = kind === "midterm" ? it.midterm_session : it.final_session;
      return it.courseName + ": Session " + (session ?? "—") + ", " + formatExamDateForAnswer(it, kind) + ".";
    });
    return "Here are your " + label + " with a date in the database:\n\n" + lines.join("\n");
  }
  if (!selected) {
    selected = withDates[withDates.length - 1];
  }
  const row = selected.it;
  const session = kind === "midterm" ? row.midterm_session : row.final_session;
  const label = kind === "midterm" ? "midterm" : "final exam";
  return "Your " + label + " is " + row.courseName + ": Session " + (session ?? "—") + ", " + formatExamDateForAnswer(row, kind) + ".";
}

/** Returns [FINAL_DATES] block from cached final dates for use in the main chat prompt. Uses cache only (no refresh). */
async function getFinalDatesContextBlock() {
  try {
    const res = await sendMessage({ type: "GET_FINAL_DATES_CACHE" });
    const cache = res?.cache;
    const items = cache?.items;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return "[FINAL_DATES]\nNo final exam dates in the database. The user can open Options > Final dates and click Refresh to populate.\n[/FINAL_DATES]";
    }
    const lines = items.map((it) => {
      const session = it.final_session != null ? "Session " + it.final_session : "—";
      const dateTime = it.final_date
        ? it.final_date + (it.final_time ? " " + it.final_time : "") + (it.timezone ? " " + it.timezone : "")
        : "—";
      return it.courseName + ": " + session + ", " + dateTime;
    });
    return "[FINAL_DATES]\nUse this data to answer questions about final exam dates. One line per course: courseName, session, date/time.\n" + lines.join("\n") + "\n[/FINAL_DATES]";
  } catch (_) {
    return "";
  }
}

/**
 * If exam caches do not exist yet, populate them in background on startup.
 * The dates endpoints already run session detection internally, so warming them
 * here avoids requiring a manual first refresh.
 */
async function warmExamDateCachesIfNeeded() {
  midtermDatesLoaded = false;
  finalDatesLoaded = false;
  updateExamDatesStatusDot();
  try {
    const [midtermRes, finalRes] = await Promise.all([
      sendMessage({ type: "GET_MIDTERM_DATES" }).catch(() => null),
      sendMessage({ type: "GET_FINAL_DATES" }).catch(() => null)
    ]);
    midtermDatesLoaded = midtermRes?.ok === true;
    updateExamDatesStatusDot();
    finalDatesLoaded = finalRes?.ok === true;
    updateExamDatesStatusDot();
  } catch (_) {
    // Ignore warm-up failures; the manual panels can still refresh later.
    updateExamDatesStatusDot();
  }
}

function buildSystemPrompt(
  syllabi,
  coursesByCourseId,
  coursesList,
  gradebookColumns,
  gradebookByCourseId,
  courseIdByNormalizedName,
  resolvedCourse,
  nowContext,
  userText,
  routingDecision
) {
  const courseContext = (typeof window.CourseRegistry !== "undefined" && window.CourseRegistry.getCourseContextForAI)
    ? window.CourseRegistry.getCourseContextForAI(coursesList || [])
    : (coursesList || []).map((c) => ({ learnCourseId: c.learnCourseId, name: c.name, externalAccessUrl: c.externalAccessUrl }));

  const isCourseRelated = !!resolvedCourse?.learnCourseId;
  const isGradeQ = isExplicitGradeQuery(userText);
  const includeGradebook = isCourseRelated || isAssignmentQuery(userText);
  const gradebookBlob = includeGradebook
    ? buildGradebookContext(gradebookColumns, coursesByCourseId, resolvedCourse?.learnCourseId, isGradeQ)
    : "";

  let block = "Courses (name -> id): ";
  if (courseContext.length === 0) {
    block += "None. ";
  } else {
    const list = courseContext.slice(0, MAX_COURSES_IN_PROMPT).map((c) => (c.name || "?") + "->" + c.learnCourseId);
    block += list.join(", ") + ".\n";
  }
  const syllabiList = courseContext.slice(0, MAX_COURSES_IN_PROMPT).map((c) => (c.name || "?") + " -> " + buildSyllabusUrlForCourse(c.learnCourseId)).join("\n");
  block += "Syllabi (link per course; ALWAYS use this link when they ask for a syllabus): " + (syllabiList || "None.") + "\n";
  if (gradebookBlob) block += gradebookBlob + "\n";

  const ctx = nowContext || (typeof window.TimeContext !== "undefined" ? window.TimeContext.getNowContext() : null);
  const next7Match = /(próximos?\s*)?7\s*d[ií]as?|(next\s*)?7\s*days/i.test(userText || "");
  const options = next7Match ? { nextNDays: 7 } : {};
  if (resolvedCourse?.learnCourseId && gradebookByCourseId) {
    const upcoming = getUpcomingAssignmentsForCourse(
      resolvedCourse.learnCourseId,
      gradebookByCourseId,
      resolvedCourse.name,
      ctx,
      options
    );
    if (upcoming.assignments.length > 0) {
      const list = upcoming.assignments.slice(0, MAX_UPCOMING_IN_PROMPT).map((a) => a.title + " (due:" + a.dueDate + ")");
      block += "Upcoming assignments (" + upcoming.courseName + "): " + list.join("; ") + ".\n";
    } else if (upcoming.message) {
      block += upcoming.courseName + ": " + upcoming.message + ".\n";
    }
  }

  const routeName = routingDecision && routingDecision.route ? routingDecision.route : "";
  const composedRules =
    typeof window.PromptRules !== "undefined" && typeof window.PromptRules.composePromptRules === "function"
      ? window.PromptRules.composePromptRules(routeName)
      : "";
  block += composedRules +
    "Resolved course for this query: " + (resolvedCourse ? resolvedCourse.name + " (" + resolvedCourse.learnCourseId + ")" : "none") + ".";
  return block;
}

/**
 * Convierte una fecha/hora ISO (p. ej. UTC del API) a hora local HH:mm para que la IA no muestre horas adelantadas.
 */
function formatCalendarTimeToLocal(isoOrTimeStr) {
  if (!isoOrTimeStr || typeof isoOrTimeStr !== "string") return "";
  const s = isoOrTimeStr.trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  // Always format times in English (24h/12h depends on en-US locale).
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function formatCalendarDateToLocal(isoOrTimeStr) {
  if (!isoOrTimeStr || typeof isoOrTimeStr !== "string") return "";
  const s = isoOrTimeStr.trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  // Always format dates in English for calendar answers.
  return d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function formatCalendarDateObjectToEnglish(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function parseCalendarApiDay(apiDateTime) {
  if (!apiDateTime || typeof apiDateTime !== "string") return null;
  const m = apiDateTime.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  return new Date(year, month, day);
}

function getCalendarItemStartDate(raw) {
  const startRaw = raw?.startDate || raw?.startDateTime || raw?.startTime || "";
  const d = new Date(startRaw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeClassQueryTypos(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\bfor\s+toda\b(?!\s+la\b)/gi, "for today")
    .replace(/\bof\s+toda\b(?!\s+la\b)/gi, "of today")
    .replace(/\bin\s+toda\b(?!\s+la\b)/gi, "in today")
    .replace(/\b(sessions?|classes?)\s+toda\b/gi, "$1 today")
    .replace(/\btday\b/gi, "today")
    .replace(/\btmrw\b/gi, "tomorrow")
    .replace(/\btmr\b/gi, "tomorrow")
    .replace(/\btody\b/g, "today")
    .replace(/\bscheduld\b/g, "scheduled")
    .replace(/\bclasss+\b/g, "class")
    .replace(/\bclasess+\b/g, "classes")
    .replace(/\btodya\b/g, "today")
    .replace(/\btodat\b/g, "today")
    .replace(/\btmorrow\b/g, "tomorrow")
    .replace(/\byesteray\b/g, "yesterday")
    .replace(/\bforr\b/gi, "for")
    .replace(/\bmicrocecon\b/gi, "microeconomics")
    .replace(/\bmicroecon\b/gi, "microeconomics")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyNaturalClassTimeQuery(text) {
  const t = normalizeClassQueryTypos(text);
  const hasClassWord = /\b(class|classes|clase|clases|session|sessions)\b/.test(t);
  const hasTimeWord = /\b(today|tomorrow|yesterday|hoy|ma[nñ]ana|manana|ayer|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t);
  if (hasClassWord && hasTimeWord) return true;
  // Follow-up temporal questions should inherit class domain from recent turns.
  if (hasTimeWord) {
    const recent = getRecentChatWindowText(8).toLowerCase();
    if (/\byou have\s+\d+\s+class|\bclasses?\s+today\b|\bclasses?\s+tomorrow\b|\bclases?\b/.test(recent)) {
      return true;
    }
  }
  return false;
}

function isLikelySynchronousClassItem(raw) {
  if (!raw || typeof raw !== "object") return false;
  const title = String(raw.title || raw.name || raw.itemName || "").toLowerCase();
  if (!title) return false;
  if (/\basynchronous\b/.test(title)) return false;
  if (/\b(homework|assignment|submission|deliverable|project|quiz|rubric|deadline|due)\b/.test(title)) return false;
  const startDate = getCalendarItemStartDate(raw);
  const endRaw = raw?.endDate || raw?.endDateTime || raw?.endTime || "";
  const endDate = endRaw ? new Date(endRaw) : null;
  const hasValidStart = startDate && !Number.isNaN(startDate.getTime());
  const hasValidEnd = endDate && !Number.isNaN(endDate.getTime());
  if (!hasValidStart || !hasValidEnd) return false;
  const durationMin = Math.round((endDate.getTime() - startDate.getTime()) / 60000);
  if (durationMin < 20) return false;
  return true;
}

function dedupeCalendarClassItems(items) {
  const out = [];
  const seen = new Set();
  for (const raw of items || []) {
    const normalized = normalizeCalendarItemForAI(raw);
    if (!normalized) continue;
    const key = [
      String(normalized.curso || "").toLowerCase(),
      String(normalized.titulo || "").toLowerCase(),
      String(normalized.date || ""),
      String(normalized.inicio || ""),
      String(normalized.fin || "")
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

function getCalendarRawStartValue(raw) {
  return String(raw?.startDate || raw?.startDateTime || raw?.startTime || "").trim();
}

function getCalendarRawStartYmd(raw) {
  const s = getCalendarRawStartValue(raw);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function toLocalYmd(dateObj) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return "";
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

function addDaysToLocalDate(baseMidnight, n) {
  const x = new Date(baseMidnight.getFullYear(), baseMidnight.getMonth(), baseMidnight.getDate() + n);
  return x;
}

/**
 * Blackboard API range for one local calendar day (matches calendar.js toSince/toUntil).
 */
function calendarApiRangeFromLocalYmd(ymd) {
  if (!ymd || typeof ymd !== "string") return null;
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (Number.isNaN(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const pad2 = (n) => String(n).padStart(2, "0");
  return {
    since: y + "-" + pad2(mo) + "-" + pad2(d) + "T00:00Z",
    until: y + "-" + pad2(mo) + "-" + pad2(d) + "T22:59Z"
  };
}

/**
 * Resolves which local calendar day the user means for class/session queries.
 * Aligns with calendar.js intent but fixes: plain "Monday" when today is Monday means *today*, not next week.
 * Skips session-number / async / free-day queries (session "when" uses calendarSessionHistoryFetchRangeFromNow in sidepanel).
 */
function resolveSingleDayYmdForClassQuery(text, nowContext) {
  if (!text || typeof text !== "string") return "";
  const Cal = typeof window.Calendar !== "undefined" ? window.Calendar : null;
  if (Cal && typeof Cal.parseSessionXOfCourseY === "function" && Cal.parseSessionXOfCourseY(text)) return "";
  if (Cal && typeof Cal.isAsynchronousSessionQuery === "function" && Cal.isAsynchronousSessionQuery(text)) return "";
  if (Cal && typeof Cal.isFreeDayQuery === "function" && Cal.isFreeDayQuery(text)) return "";

  const t = normalizeClassQueryTypos(text);
  const now = nowContext && nowContext.epochMs != null ? new Date(nowContext.epochMs) : new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const engDow = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
  };

  if (/\btoday\b|\bhoy\b/.test(t)) return toLocalYmd(base);
  if (/\btomorrow\b|\bma[nñ]ana\b|\bmanana\b/.test(t)) return toLocalYmd(addDaysToLocalDate(base, 1));
  if (/\byesterday\b|\bayer\b/.test(t)) return toLocalYmd(addDaysToLocalDate(base, -1));
  if (/\bday\s+after\s+tomorrow\b|\bpasado\s+ma[nñ]ana\b/.test(t)) return toLocalYmd(addDaysToLocalDate(base, 2));

  if (/\b(last|past)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t)) {
    const m = t.match(/\b(last|past)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    const targetDow = engDow[(m && m[2] || "").toLowerCase()];
    if (targetDow != null) {
      const cur = base.getDay();
      let daysBack = cur - targetDow;
      if (daysBack <= 0) daysBack += 7;
      return toLocalYmd(addDaysToLocalDate(base, -daysBack));
    }
  }

  if (/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t)) {
    const m = t.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    const targetDow = engDow[(m && m[1] || "").toLowerCase()];
    if (targetDow != null) {
      const cur = base.getDay();
      let days = targetDow - cur;
      if (days <= 0) days += 7;
      return toLocalYmd(addDaysToLocalDate(base, days));
    }
  }

  if (/\bthis\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t)) {
    const m = t.match(/\bthis\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    const targetDow = engDow[(m && m[1] || "").toLowerCase()];
    if (targetDow != null) {
      const cur = base.getDay();
      let days = targetDow - cur;
      if (days < 0) days += 7;
      if (days === 0) return toLocalYmd(base);
      return toLocalYmd(addDaysToLocalDate(base, days));
    }
  }

  if (/\b(?:the\s+)?next\s+one\b/i.test(t)) {
    const w = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (w) {
      const targetDow = engDow[w[1].toLowerCase()];
      const cur = base.getDay();
      let days = targetDow - cur;
      if (days <= 0) days += 7;
      return toLocalYmd(addDaysToLocalDate(base, days));
    }
  }

  if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t) && /\bnext\s+week\b|\bthis\s+week\b/i.test(t)) {
    const m = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    const targetDow = engDow[(m && m[1] || "").toLowerCase()];
    if (targetDow != null) {
      const cur = base.getDay();
      const nextMondayDays = cur === 0 ? 1 : cur === 1 ? 7 : 8 - cur;
      const days = nextMondayDays + (targetDow === 0 ? 6 : targetDow - 1);
      return toLocalYmd(addDaysToLocalDate(base, days));
    }
  }

  if (/\b(el\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i.test(t)) {
    const m = t.match(/\b(?:el\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i);
    const esName = (m && m[1] || "").toLowerCase().replace(/é/g, "e").replace(/á/g, "a");
    const esDow = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
    const targetDow = esDow[esName];
    if (targetDow != null) {
      const cur = base.getDay();
      let days;
      if (/\bsemana\s+que\s+viene\b|pr[oó]xima\s+semana\b/i.test(t)) {
        const nextMondayDays = cur === 0 ? 1 : cur === 1 ? 7 : 8 - cur;
        days = nextMondayDays + (targetDow === 0 ? 6 : targetDow - 1);
      } else {
        days = targetDow - cur;
        if (days < 0) days += 7;
      }
      return toLocalYmd(addDaysToLocalDate(base, days));
    }
  }

  const w = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (w) {
    const targetDow = engDow[w[1].toLowerCase()];
    const cur = base.getDay();
    let delta = targetDow - cur;
    if (delta < 0) delta += 7;
    return toLocalYmd(addDaysToLocalDate(base, delta));
  }

  return "";
}

function detectCalendarSingleDayTarget(text, nowContext) {
  return resolveSingleDayYmdForClassQuery(text, nowContext) || "";
}

function calendarApiSameLocalDay(since, until) {
  if (!since || !until) return false;
  return String(since).slice(0, 10) === String(until).slice(0, 10);
}

function formatCalendarClassLine(raw) {
  const normalized = normalizeCalendarItemForAI(raw);
  if (!normalized) return "";
  const course = normalized.curso || "(course)";
  const title = normalized.titulo || "(no title)";
  const start = normalized.inicio || "";
  const end = normalized.fin || "";
  const location = normalized.lugar || "";
  const timeRange = start && end ? start + " to " + end : (start || end || "");
  return {
    course,
    title,
    timeRange,
    location
  };
}

/** Course name on calendar item (after "Course: " in calendarName). */
function getCalendarItemCourseLabel(raw) {
  const loc = raw.calendarNameLocalizable || raw.calendarName || {};
  const rawValue = typeof loc === "string" ? loc : (loc.rawValue || loc.value || "");
  const str = (typeof rawValue === "string" ? rawValue : "").trim();
  return str.indexOf(": ") !== -1 ? str.slice(str.indexOf(": ") + 2).trim() : str;
}

function normalizeCourseMatchTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 || w === "ie");
}

/** Match "IE HUMANITIES" to "IE HUMANITIES FIRST" / "Humanities" / registry vs calendar label. */
function calendarCourseLabelsMatch(itemLabel, resolvedName, queryTail) {
  const a = (itemLabel || "").trim();
  const b = (resolvedName || "").trim();
  const q = (queryTail || "").trim();
  if (!a) return false;
  if (b) {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (al.includes(bl) || bl.includes(al)) return true;
    const ta = normalizeCourseMatchTokens(b);
    const tb = normalizeCourseMatchTokens(a);
    const shorter = ta.length <= tb.length ? ta : tb;
    const longer = ta.length > tb.length ? ta : tb;
    const setL = new Set(longer);
    let hits = 0;
    for (const w of shorter) {
      if (setL.has(w)) hits++;
    }
    if (shorter.length >= 2 && hits >= 2) return true;
    if (shorter.length === 1 && hits >= 1 && shorter[0].length >= 6) return true;
  }
  if (q) {
    const ql = q.toLowerCase();
    if (a.toLowerCase().includes(ql) || ql.includes(a.toLowerCase())) return true;
    const tq = normalizeCourseMatchTokens(q);
    const ta = normalizeCourseMatchTokens(a);
    const shorter = tq.length <= ta.length ? tq : ta;
    const longer = tq.length > ta.length ? tq : ta;
    const setL = new Set(longer);
    let hits = 0;
    for (const w of shorter) {
      if (setL.has(w)) hits++;
    }
    if (shorter.length >= 1 && hits >= Math.min(2, shorter.length)) return true;
  }
  return false;
}

const SESSION_COURSE_QUERY_STOPWORDS = new Set([
  "of",
  "the",
  "for",
  "and",
  "in",
  "on",
  "at",
  "en",
  "el",
  "la",
  "los",
  "las",
  "del",
  "de",
  "course",
  "class"
]);

function courseQueryTokensForCourseValidation(courseQuery) {
  return normalizeCourseMatchTokens(courseQuery).filter((w) => !SESSION_COURSE_QUERY_STOPWORDS.has(w));
}

/** Every significant query token must appear in the official course name (stops "data analysis" → wrong stats course). */
function courseQueryMatchesResolvedName(courseQuery, resolvedName) {
  if (!courseQuery || !resolvedName) return true;
  const tokens = courseQueryTokensForCourseValidation(courseQuery);
  if (tokens.length === 0) return true;
  const hay = resolvedName.toLowerCase();
  return tokens.every((w) => haystackMatchesCourseToken(hay, w));
}

function haystackMatchesCourseToken(hayLower, token) {
  if (!token) return true;
  if (hayLower.includes(token)) return true;
  const cHay = hayLower.replace(/[-\s]/g, "");
  const cTok = token.replace(/[-\s]/g, "");
  if (cTok.length >= 2 && cHay.includes(cTok)) return true;
  return false;
}

/** Drop registry match if the user's words are not reflected in the official title (wrong fuzzy resolution). */
function refineResolvedSessionForSessionCalendarQuery(courseQuery, resolvedSession) {
  if (!resolvedSession || !courseQuery || !resolvedSession.name) return resolvedSession;
  if (courseQueryMatchesResolvedName(courseQuery, resolvedSession.name)) return resolvedSession;
  return null;
}

/** Without resolved course: require every significant query token in the calendar row course label (no loose blob). */
function calendarItemLabelMatchesCourseQueryStrict(itemLabel, courseQuery) {
  const tokens = courseQueryTokensForCourseValidation(courseQuery);
  if (tokens.length === 0) return calendarCourseLabelsMatch(itemLabel, "", courseQuery);
  const hay = (itemLabel || "").toLowerCase();
  return tokens.every((w) => haystackMatchesCourseToken(hay, w));
}

function calendarItemMatchesResolvedCourse(raw, resolvedSession, courseQuery) {
  if (!raw || typeof raw !== "object") return false;
  const q = (courseQuery || "").trim();
  const cid = (raw.courseId ?? raw.calendarId ?? raw.contextId ?? "").toString().trim();
  const want = resolvedSession && resolvedSession.learnCourseId && String(resolvedSession.learnCourseId).trim();
  const itemCourse = getCalendarItemCourseLabel(raw);
  const resolvedName = resolvedSession ? resolvedSession.name : "";

  if (want && cid) {
    const wantNorm = want.replace(/^_|_$/g, "");
    const cidNorm = cid.replace(/^_|_$/g, "");
    if (cidNorm === wantNorm || cid === want) return true;
    return false;
  }

  if (resolvedSession && resolvedName) {
    return calendarCourseLabelsMatch(itemCourse, resolvedName, q);
  }

  if (!q) return false;
  return calendarItemLabelMatchesCourseQueryStrict(itemCourse, q);
}

/**
 * Remove clock times / ISO-ish fragments so "11:20 AM" does not look like session 11.
 * Only used for description/blob fallback — titles are checked without stripping.
 */
function stripCalendarNoiseForSessionNumberMatch(text) {
  let t = String(text || "");
  t = t.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)\b/g, " ");
  t = t.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
  t = t.replace(/\b\d{1,2}h\d{2}\b/gi, " ");
  return t;
}

/** Session/week words; ranges like "Session 29–30" must appear after one of these (avoids date/time false positives). */
function calendarSessionRangeKeywordPrefix() {
  return "(?:session|sessions|sesi[oó]n|sesiones|ses\\.?|clase|week|wk\\.?|sem(?:ana)?)";
}

/**
 * First session range after a session-ish word that contains n (e.g. Session 29–30 → n=30).
 */
function findFirstSessionRangeContainingNum(textBlob, n) {
  const t = (textBlob || "").toString();
  if (!t || !Number.isFinite(n) || n < 1) return null;
  const kw = calendarSessionRangeKeywordPrefix();
  const reDash = new RegExp(
    "\\b" + kw + "\\s*[\\s\\S]{0,50}?(\\d{1,3})\\s*[-–—]\\s*(\\d{1,3})\\b",
    "gi"
  );
  for (const m of t.matchAll(reDash)) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (n >= lo && n <= hi) return { low: lo, high: hi };
  }
  const reAmp = new RegExp(
    "\\b" + kw + "\\s*[\\s\\S]{0,50}?(\\d{1,3})\\s*(?:&|and|\\by\\b)\\s*(\\d{1,3})\\b",
    "gi"
  );
  for (const m of t.matchAll(reAmp)) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (n >= lo && n <= hi) return { low: lo, high: hi };
  }
  return null;
}

function calendarTextImpliesSessionNRangeBlock(textBlob, n) {
  return findFirstSessionRangeContainingNum(textBlob, n) != null;
}

/**
 * True if text indicates calendar row is for session number n.
 * Avoid: [11] in HTML, "next week 11" (not Week 11), bare S+num, lesson/class (ambiguous).
 * Includes combined blocks: "Session 29–30" counts for 29 and 30.
 */
function calendarTextImpliesSessionN(textBlob, n) {
  const t = (textBlob || "").toString();
  if (!t) return false;
  const num = Number(n);
  if (!Number.isFinite(num) || num < 1) return false;
  const ns = String(num);
  const patterns = [
    new RegExp("\\b(?:session|sesi[oó]n|ses\\.?|clase)\\s*#?\\s*" + ns + "\\b", "i"),
    new RegExp("\\(?\\s*Ses\\.?\\s*" + ns + "\\s*\\)?", "i"),
    new RegExp("(?<!\\bnext\\s)\\b(?:week|wk\\.?|sem(?:ana)?)\\s*" + ns + "\\b", "i"),
    new RegExp("\\b(?:lesson|lecture)\\s*#?\\s*" + ns + "\\b", "i")
  ];
  for (const re of patterns) {
    if (re.test(t)) return true;
  }
  if (calendarTextImpliesSessionNRangeBlock(t, num)) return true;
  return false;
}

/**
 * Range label for deterministic reply (title first, then stripped blob).
 */
function getSessionRangeForDisplayFromCalendarRaw(raw, requestedNum) {
  const title = (raw.title || raw.name || raw.itemName || "").toString();
  let r = findFirstSessionRangeContainingNum(title, requestedNum);
  if (r && r.low < r.high) return r;
  const blob = stripCalendarNoiseForSessionNumberMatch(getCalendarItemTextBlob(raw));
  r = findFirstSessionRangeContainingNum(blob, requestedNum);
  if (r && r.low < r.high) return r;
  return null;
}

function getCalendarItemTextBlob(raw) {
  return [
    raw.title,
    raw.name,
    raw.itemName,
    raw.description,
    raw.body,
    raw.shortDescription,
    raw.details
  ]
    .filter(Boolean)
    .map((s) => String(s))
    .join(" ");
}

function calendarItemStartMs(raw) {
  const d = raw && (raw.startDate || raw.startDateTime || raw.startTime);
  if (!d) return 0;
  const ms = new Date(d).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Filter + rank calendar rows for "session X of course Y". Used by deterministic reply and getCalendarContextForUserQuery.
 */
function filterCalendarRawItemsForSessionXOfCourse(rawItems, sessionXIntent, resolvedSession) {
  const num = sessionXIntent.sessionNumber;
  const courseQuery = (sessionXIntent.courseQuery || "").trim();

  let list = (rawItems || []).filter((raw) => {
    const evType = raw && raw.dynamicCalendarItemProps && raw.dynamicCalendarItemProps.eventType;
    return evType !== "Discussion Message";
  });

  list = list.filter((raw) => calendarItemMatchesResolvedCourse(raw, resolvedSession, courseQuery));

  const titlePass = list.filter((raw) => {
    const title = (raw.title || raw.name || raw.itemName || "").toString();
    return calendarTextImpliesSessionN(title, num);
  });
  if (titlePass.length) {
    list = titlePass;
  } else {
    const blobPass = list.filter((raw) => {
      const blob = stripCalendarNoiseForSessionNumberMatch(getCalendarItemTextBlob(raw));
      return calendarTextImpliesSessionN(blob, num);
    });
    list = blobPass.length ? blobPass : [];
  }
  // Never fall back to "all events for this course" — that produced the same wrong date for every session number.

  list.sort((a, b) => calendarItemStartMs(a) - calendarItemStartMs(b));
  if (list.length > 1) {
    const seenKey = new Set();
    list = list.filter((raw) => {
      const title = (raw.title || "").toString();
      const start = raw.startDate || raw.startDateTime || raw.startTime || "";
      const key = getCalendarItemCourseLabel(raw) + "|" + title + "|" + start;
      if (seenKey.has(key)) return false;
      seenKey.add(key);
      return true;
    });
  }
  return list;
}

function calendarWideRangeFromNow(nowContext, daysBack, daysForward) {
  const now = nowContext && nowContext.epochMs != null ? new Date(nowContext.epochMs) : new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - daysBack);
  const to = new Date(now);
  to.setDate(to.getDate() + daysForward);
  const pad2 = (x) => String(x).padStart(2, "0");
  return {
    since: from.getFullYear() + "-" + pad2(from.getMonth() + 1) + "-" + pad2(from.getDate()) + "T00:00Z",
    until: to.getFullYear() + "-" + pad2(to.getMonth() + 1) + "-" + pad2(to.getDate()) + "T22:59Z"
  };
}

/**
 * "When is session X of course Y" must search deep history. calendar.js getParamsForCalendarQuestion only uses ±120d
 * for that pattern — not enough for last term or older. This is only used for GET_CALENDAR_ITEMS in sidepanel.
 */
function calendarSessionHistoryFetchRangeFromNow(nowContext) {
  return calendarWideRangeFromNow(nowContext, 2555, 800);
}

/**
 * Deterministic answer for "when is session X of course Y" using the same filters as getCalendarContextForUserQuery.
 * Previously answerCalendarTemporalQuery returned null here, so the request fell through to OPENROUTER and the model
 * often pasted a syllabus BLTI URL — buildAssistantMessageHtml then showed "Here is the syllabus" instead of a date.
 */
async function answerSessionXOfCourseYDeterministic(text, textForCal, normalizedText) {
  const Cal = window.Calendar;
  if (!Cal || typeof Cal.parseSessionXOfCourseY !== "function") return null;
  const candidates = [normalizedText, textForCal, text].filter((s) => s && String(s).trim());
  let sessionXIntent = null;
  let queryForParams = "";
  for (const q of candidates) {
    const p = Cal.parseSessionXOfCourseY(q);
    if (p && p.sessionNumber != null && p.courseQuery && String(p.courseQuery).trim().length >= 2) {
      sessionXIntent = p;
      queryForParams = q;
      break;
    }
  }
  if (!sessionXIntent) return null;

  const nowContext =
    typeof window.TimeContext !== "undefined" && window.TimeContext.getNowContext
      ? window.TimeContext.getNowContext()
      : null;
  const hist = calendarSessionHistoryFetchRangeFromNow(nowContext);
  let res = await sendMessage({ type: "GET_CALENDAR_ITEMS", since: hist.since, until: hist.until });
  if (!res?.ok || !Array.isArray(res.items)) {
    return "Could not load your calendar. Open Blackboard, stay logged in, and try again.";
  }

  const syncDataSession = await getSyncData();
  let resolvedSession = resolveCourseForPrompt(
    sessionXIntent.courseQuery,
    syncDataSession.courseIdByNormalizedName,
    syncDataSession.coursesByCourseId
  );
  resolvedSession = refineResolvedSessionForSessionCalendarQuery(sessionXIntent.courseQuery, resolvedSession);
  const num = sessionXIntent.sessionNumber;

  let rawItems = filterCalendarRawItemsForSessionXOfCourse(res.items || [], sessionXIntent, resolvedSession);
  if (rawItems.length === 0) {
    const maxRange = calendarWideRangeFromNow(nowContext, 3650, 800);
    res = await sendMessage({ type: "GET_CALENDAR_ITEMS", since: maxRange.since, until: maxRange.until });
    if (res?.ok && Array.isArray(res.items)) {
      rawItems = filterCalendarRawItemsForSessionXOfCourse(res.items, sessionXIntent, resolvedSession);
    }
  }

  const courseNameToMatch = resolvedSession ? resolvedSession.name : "";
  const displayCourse = (courseNameToMatch || sessionXIntent.courseQuery || "").trim();
  if (rawItems.length === 0) {
    return (
      "No calendar event found for Session " +
      num +
      " of " +
      displayCourse +
      " in your synced range. Sync calendar from Blackboard or check that the session title includes Session " +
      num +
      ". Very old sessions may not be returned by Blackboard if they are outside the fetched period."
    );
  }

  const first = rawItems[0];
  const n = normalizeCalendarItemForAI(first);
  if (!n) {
    return "Session " + num + " of " + displayCourse + " was found in the calendar but could not be formatted.";
  }
  const dateLine =
    n.date ||
    formatCalendarDateToLocal(first.startDate || first.startDateTime || first.startTime || "") ||
    "";
  const loc = n.lugar ? " in " + n.lugar : "";
  const timeRange = n.inicio && n.fin ? n.inicio + " to " + n.fin : n.inicio || n.fin || "";
  const courseLabel = n.curso && n.curso !== "(course)" ? n.curso : displayCourse;
  const range = getSessionRangeForDisplayFromCalendarRaw(first, num);
  const rangeNote =
    range && range.low < range.high
      ? " Blackboard lists Sessions " + range.low + "–" + range.high + " as one calendar entry (same time slot)."
      : "";
  return (
    "Session " +
    num +
    " of " +
    courseLabel +
    " is on " +
    dateLine +
    (timeRange ? " from " + timeRange : "") +
    loc +
    "." +
    rangeNote
  );
}

async function answerCalendarTemporalQuery(text, opts) {
  if (typeof window.Calendar === "undefined") return null;
  const expanded = expandShortCalendarQueryForSidepanel(text);
  const textForCal = expanded || text;
  const normalizedText = normalizeClassQueryTypos(textForCal);
  const isCalendarLike =
    (opts && opts.forceCalendar) ||
    window.Calendar.isCalendarQuery(text) ||
    window.Calendar.isCalendarQuery(textForCal) ||
    window.Calendar.isCalendarQuery(normalizedText) ||
    isLikelyNaturalClassTimeQuery(text);
  if (!isCalendarLike) return null;
  // Free-day questions need free_days / next_free_day from getCalendarContextForUserQuery, not a flat class list.
  if (
    typeof window.Calendar.isFreeDayQuery === "function" &&
    (window.Calendar.isFreeDayQuery(text) ||
      window.Calendar.isFreeDayQuery(textForCal) ||
      window.Calendar.isFreeDayQuery(normalizedText))
  ) {
    return null;
  }
  // Async-session questions need filtered calendar context from getCalendarContextForUserQuery, not a flat class list.
  if (
    typeof window.Calendar.isAsynchronousSessionQuery === "function" &&
    (window.Calendar.isAsynchronousSessionQuery(text) ||
      window.Calendar.isAsynchronousSessionQuery(textForCal) ||
      window.Calendar.isAsynchronousSessionQuery(normalizedText))
  ) {
    return null;
  }
  // "When is session X of course Y" — answer from calendar API + session/course filters (same as getCalendarContextForUserQuery).
  if (typeof window.Calendar.parseSessionXOfCourseY === "function") {
    if (
      window.Calendar.parseSessionXOfCourseY(text) ||
      window.Calendar.parseSessionXOfCourseY(textForCal) ||
      window.Calendar.parseSessionXOfCourseY(normalizedText)
    ) {
      const sessionAnswer = await answerSessionXOfCourseYDeterministic(text, textForCal, normalizedText);
      return sessionAnswer || null;
    }
  }
  const nowContext =
    typeof window.TimeContext !== "undefined" && window.TimeContext.getNowContext
      ? window.TimeContext.getNowContext()
      : null;
  const resolvedDayYmd = resolveSingleDayYmdForClassQuery(normalizedText, nowContext);
  let since;
  let until;
  if (resolvedDayYmd) {
    const r = calendarApiRangeFromLocalYmd(resolvedDayYmd);
    if (r) {
      since = r.since;
      until = r.until;
    }
  }
  if (!since) {
    const p = window.Calendar.getParamsForCalendarQuestion(textForCal, nowContext);
    since = p.since;
    until = p.until;
  }
  const res = await sendMessage({ type: "GET_CALENDAR_ITEMS", since, until });
  if (!res?.ok || !Array.isArray(res.items)) return null;
  const singleDayTarget = resolvedDayYmd || "";
  const apiSameDay = calendarApiSameLocalDay(since, until);
  const apiTargetYmd = apiSameDay ? String(since || "").slice(0, 10) : "";
  let classes = res.items.filter((raw) => isLikelySynchronousClassItem(raw));
  const targetYmd = singleDayTarget || apiTargetYmd;
  if (targetYmd) {
    classes = classes.filter((raw) => {
      const startDate = getCalendarItemStartDate(raw);
      if (!startDate) return false;
      return toLocalYmd(startDate) === targetYmd;
    });
  }
  classes = dedupeCalendarClassItems(classes);
  const t = normalizedText.toLowerCase();
  let label = "in that period";
  if (/\byesterday\b|\bayer\b/.test(t)) label = "yesterday";
  else if (/\btoday\b|\bhoy\b/.test(t)) label = "today";
  else if (/\btomorrow\b|\bma[nñ]ana\b|\bmanana\b/.test(t)) label = "tomorrow";
  else {
    const m = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
    if (m) label = "on " + m[1];
  }
  if (classes.length === 0) {
    return "You have no classes " + label + ".";
  }
  const sorted = classes
    .slice()
    .sort((a, b) => {
      const sa = getCalendarItemStartDate(a);
      const sb = getCalendarItemStartDate(b);
      const ea = sa ? sa.getTime() : 0;
      const eb = sb ? sb.getTime() : 0;
      return ea - eb;
    });
  const rows = sorted
    .slice(0, 20)
    .map((raw) => formatCalendarClassLine(raw))
    .filter(Boolean);
  const lines = rows.map((row, idx) => {
    const location = row.location ? " | Location: " + row.location : "";
    const titlePart = row.title ? " | " + row.title : "";
    const timePart = row.timeRange ? " | " + row.timeRange : "";
    return (idx + 1) + ". " + row.course + titlePart + timePart + location;
  });
  return "You have " + lines.length + " class" + (lines.length === 1 ? "" : "es") + " " + label + ":\n\n" + lines.join("\n");
}

function isAsynchronousCalendarItem(raw) {
  return /\basynchronous\b/i.test((raw?.title || raw?.name || raw?.itemName || "").toString());
}

function buildFreeDaysForAI(rawItems, since, until, nowContext) {
  const startDay = parseCalendarApiDay(since);
  const endDay = parseCalendarApiDay(until);
  if (!startDay || !endDay) return { freeDays: [], nextFreeDay: null };

  const weekdayMap = new Map();
  for (const raw of rawItems || []) {
    const startDate = getCalendarItemStartDate(raw);
    if (!startDate) continue;
    const dow = startDate.getDay();
    if (dow === 0 || dow === 6) continue;
    const key = startDate.getFullYear() + "-" + String(startDate.getMonth() + 1).padStart(2, "0") + "-" + String(startDate.getDate()).padStart(2, "0");
    const current = weekdayMap.get(key) || { synchronousCount: 0, asynchronousCount: 0 };
    if (isAsynchronousCalendarItem(raw)) current.asynchronousCount += 1;
    else current.synchronousCount += 1;
    weekdayMap.set(key, current);
  }

  const freeDays = [];
  const now = nowContext && nowContext.epochMs != null ? new Date(nowContext.epochMs) : new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let nextFreeDay = null;
  for (let cursor = new Date(startDay); cursor <= endDay; cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)) {
    const dow = cursor.getDay();
    if (dow === 0 || dow === 6) continue;
    const key = cursor.getFullYear() + "-" + String(cursor.getMonth() + 1).padStart(2, "0") + "-" + String(cursor.getDate()).padStart(2, "0");
    const stats = weekdayMap.get(key);
    if (!stats) {
      const item = {
        date: formatCalendarDateObjectToEnglish(cursor),
        reason: "No classes"
      };
      freeDays.push(item);
      if (!nextFreeDay && cursor.getTime() >= todayStart) nextFreeDay = item;
      continue;
    }
    if (stats.synchronousCount === 0 && stats.asynchronousCount > 0) {
      const item = {
        date: formatCalendarDateObjectToEnglish(cursor),
        reason: "Only asynchronous sessions"
      };
      freeDays.push(item);
      if (!nextFreeDay && cursor.getTime() >= todayStart) nextFreeDay = item;
    }
  }

  return { freeDays, nextFreeDay };
}

/**
 * Normalizes a raw calendar API item into an AI-friendly object.
 * Includes 'date' so the AI can answer exact-day questions correctly.
 */
function normalizeCalendarItemForAI(raw) {
  if (!raw || typeof raw !== "object") return null;
  const localizable = raw.calendarNameLocalizable || raw.calendarName || {};
  const rawValue = typeof localizable === "string" ? localizable : (localizable.rawValue || localizable.value || "");
  const courseName = typeof rawValue === "string" && rawValue.indexOf(": ") !== -1 ? rawValue.slice(rawValue.indexOf(": ") + 2).trim() : rawValue.trim() || raw.title || "";
  const title = (raw.title || raw.name || raw.itemName || "").toString().trim() || "";
  const startRaw = raw.startDate || raw.startDateTime || raw.startTime || "";
  const endRaw = raw.endDate || raw.endDateTime || raw.endTime || startRaw || "";
  const start = formatCalendarTimeToLocal(startRaw) || startRaw;
  const end = formatCalendarTimeToLocal(endRaw) || endRaw;
  const date = formatCalendarDateToLocal(startRaw) || "";
  const location = (raw.location || (raw.dynamicCalendarItemProps && raw.dynamicCalendarItemProps.location) || "").toString().trim() || "";
  return {
    curso: courseName || "(course)",
    titulo: title || "(no title)",
    date: date || undefined,
    inicio: start,
    fin: end,
    lugar: location || undefined
  };
}

/**
 * calendar.js isCalendarQuery() needs BOTH a class/session word AND a time expression.
 * Casual follow-ups ("and any classes?", "bro any classes?") often lack "today" — expand here only
 * (integration layer; do not change calendar.js).
 */
function expandShortCalendarQueryForSidepanel(userText) {
  let s = String(userText || "").trim();
  if (!s) return "";
  s = s.replace(/^(?:yo\s+bro\s+|yo\s+|hey\s+|hi\s+|bro\s+|dude\s+|lol\s+|pls\s+|please\s+)+/gi, "").trim();
  const t = normalizeClassQueryTypos(s);
  const lowered = t.toLowerCase();
  const shortClassFollowUp =
    /^(?:and\s+)?(?:any|some\s+)?(?:classes?|sessions?|lectures?)\s*\??$/i.test(lowered) ||
    /^(?:and\s+)?what\s+about\s+(?:classes?|sessions?|my\s+schedule)\s*\??$/i.test(lowered) ||
    /^what\s+(?:about\s+)?(?:classes?|sessions?)\s*\??$/i.test(lowered) ||
    /^(?:and\s+)?got\s+any\s+classes\s*\??$/i.test(lowered);
  if (shortClassFollowUp) {
    if (/\b(tomorrow|next\s+week|ma[nñ]ana|tmrw|tmr)\b/i.test(lowered)) return "what classes do I have tomorrow";
    if (/\b(yesterday|ayer)\b/i.test(lowered)) return "what classes did I have yesterday";
    return "what classes do I have today";
  }
  if (
    lowered.length < 96 &&
    /\bany\s+classes\b/i.test(lowered) &&
    !/\b(today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this\s+week|next\s+week|tday|tmrw|tmr|ma[nñ]ana|hoy|ayer)\b/i.test(
      lowered
    )
  ) {
    return "what classes do I have today";
  }
  return "";
}

/**
 * Calendario: flujo simple.
 * Incluye el contexto actual de fecha y hora (TimeContext) y normaliza los items para que la IA liste las clases correctamente.
 */
async function getCalendarContextForUserQuery(text, opts) {
  if (typeof window.Calendar === "undefined") return "";
  const raw = String(text || "").trim();
  let calendarQueryText = raw;
  if (!window.Calendar.isCalendarQuery(calendarQueryText)) {
    const expanded = expandShortCalendarQueryForSidepanel(raw);
    if (expanded && window.Calendar.isCalendarQuery(expanded)) {
      calendarQueryText = expanded;
    } else if (!(opts && opts.forceCalendar)) {
      return "";
    }
  }

  const nowContext =
    typeof window.TimeContext !== "undefined" && window.TimeContext.getNowContext
      ? window.TimeContext.getNowContext()
      : null;
  const timeContextBlock =
    nowContext && typeof window.TimeContext.buildTimeContextBlock === "function"
      ? window.TimeContext.buildTimeContextBlock(nowContext)
      : "";

  const sessionXIntent =
    typeof window.Calendar !== "undefined" && window.Calendar.parseSessionXOfCourseY
      ? window.Calendar.parseSessionXOfCourseY(calendarQueryText)
      : null;
  let since;
  let until;
  if (
    sessionXIntent &&
    sessionXIntent.sessionNumber != null &&
    sessionXIntent.courseQuery &&
    String(sessionXIntent.courseQuery).trim().length >= 2
  ) {
    const r = calendarSessionHistoryFetchRangeFromNow(nowContext);
    since = r.since;
    until = r.until;
  } else {
    const p = window.Calendar.getParamsForCalendarQuestion(calendarQueryText, nowContext);
    since = p.since;
    until = p.until;
    // When forced by LLM intent but no time expression found, use ±14 days so the LLM
    // has enough context to reason about "this week", "next class", etc.
    if (opts && opts.forceCalendar && since === until) {
      const nowRef = nowContext instanceof Date ? nowContext : (nowContext && nowContext.epochMs != null ? new Date(nowContext.epochMs) : new Date());
      const pad2 = (n) => String(n).padStart(2, "0");
      const from = new Date(nowRef); from.setDate(from.getDate() - 1);
      const to = new Date(nowRef); to.setDate(to.getDate() + 14);
      since = from.getFullYear() + "-" + pad2(from.getMonth() + 1) + "-" + pad2(from.getDate()) + "T00:00Z";
      until = to.getFullYear() + "-" + pad2(to.getMonth() + 1) + "-" + pad2(to.getDate()) + "T22:59Z";
    }
  }
  const res = await sendMessage({ type: "GET_CALENDAR_ITEMS", since, until });

  if (!res || !res.ok) {
    return "[CALENDAR_CONTEXT]\n" + (timeContextBlock ? timeContextBlock + "\n\n" : "") + "Error: Could not fetch calendar (" + (res?.error || "unknown") + "). Tell the user to open Blackboard and log in.\n[/CALENDAR_CONTEXT]";
  }

  let rawItems = res.items || [];
  // Excluir eventos de tipo "Discussion Message" (mensajes/recursos de foros, no clases reales).
  rawItems = rawItems.filter((raw) => {
    const evType = raw && raw.dynamicCalendarItemProps && raw.dynamicCalendarItemProps.eventType;
    return evType !== "Discussion Message";
  });

  const isFreeDayIntent = typeof window.Calendar !== "undefined" && typeof window.Calendar.isFreeDayQuery === "function"
    ? window.Calendar.isFreeDayQuery(calendarQueryText)
    : false;
  const isAsyncIntent = typeof window.Calendar !== "undefined" && typeof window.Calendar.isAsynchronousSessionQuery === "function"
    ? window.Calendar.isAsynchronousSessionQuery(calendarQueryText)
    : false;
  if (isAsyncIntent && !isFreeDayIntent) {
    rawItems = rawItems
      .filter((raw) => /\basynchronous\b/i.test((raw?.title || raw?.name || raw?.itemName || "").toString()))
      .sort((a, b) => {
        const aStart = new Date(a?.startDate || a?.startDateTime || a?.startTime || 0).getTime() || 0;
        const bStart = new Date(b?.startDate || b?.startDateTime || b?.startTime || 0).getTime() || 0;
        return aStart - bStart;
      });
  }

  if (sessionXIntent && sessionXIntent.sessionNumber && sessionXIntent.courseQuery) {
    const syncDataSession = await getSyncData();
    let resolvedSession = resolveCourseForPrompt(
      sessionXIntent.courseQuery,
      syncDataSession.courseIdByNormalizedName,
      syncDataSession.coursesByCourseId
    );
    resolvedSession = refineResolvedSessionForSessionCalendarQuery(sessionXIntent.courseQuery, resolvedSession);
    rawItems = filterCalendarRawItemsForSessionXOfCourse(rawItems, sessionXIntent, resolvedSession);
    if (rawItems.length === 0) {
      const maxRange = calendarWideRangeFromNow(nowContext, 3650, 800);
      const resWide = await sendMessage({ type: "GET_CALENDAR_ITEMS", since: maxRange.since, until: maxRange.until });
      if (resWide?.ok && Array.isArray(resWide.items)) {
        let wideItems = resWide.items || [];
        wideItems = wideItems.filter((raw) => {
          const evType = raw && raw.dynamicCalendarItemProps && raw.dynamicCalendarItemProps.eventType;
          return evType !== "Discussion Message";
        });
        if (isAsyncIntent && !isFreeDayIntent) {
          wideItems = wideItems
            .filter((raw) => /\basynchronous\b/i.test((raw?.title || raw?.name || raw?.itemName || "").toString()))
            .sort((a, b) => {
              const aStart = new Date(a?.startDate || a?.startDateTime || a?.startTime || 0).getTime() || 0;
              const bStart = new Date(b?.startDate || b?.startDateTime || b?.startTime || 0).getTime() || 0;
              return aStart - bStart;
            });
        }
        rawItems = filterCalendarRawItemsForSessionXOfCourse(wideItems, sessionXIntent, resolvedSession);
      }
    }
  }

  const clasesRaw = rawItems.map(normalizeCalendarItemForAI).filter(Boolean);
  const seen = new Set();
  const clases = clasesRaw.filter((c) => {
    const key = (c.curso + "|" + c.titulo + "|" + c.inicio + "|" + c.fin).trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const { freeDays, nextFreeDay } = isFreeDayIntent
    ? buildFreeDaysForAI(rawItems, since, until, nowContext)
    : { freeDays: [], nextFreeDay: null };
  resolutionLogLines.push("Calendario: " + clases.length + " items (since=" + since + " until=" + until + ")");
  renderResolutionLog();

  let instrucciones =
    "Rules: (1) If 'clases' has one or more elements, list every class with course, title, and start/end time. " +
    "(2) Use each item's 'date' field when the user asks WHEN a session is. Always state dates with English month names (e.g. Monday, February 18, 2025). " +
    "(3) Only say 'No classes' if the clases array is empty []. " +
    "(4) Use the time/date from the block above; do not invent events.\n";
  if (sessionXIntent) {
    instrucciones +=
      "When the user asks 'when is session X of course Y': reply using only [CALENDAR_CONTEXT]. State the exact day and date (use the 'date' field, with English month name) and the time. Do not use syllabus content for this.\n";
  }
  if (isAsyncIntent) {
    instrucciones +=
      "When the user asks about asynchronous sessions, use only calendar items whose title includes the word 'Asynchronous'. " +
      "If they ask for the next asynchronous session, return the nearest upcoming item relative to the current time in the block above. " +
      "If they ask for all asynchronous sessions or their dates, list only those asynchronous items with course, date, and time. " +
      "If the clases array is empty, say there are no asynchronous sessions in the requested calendar range.\n";
  }
  if (isFreeDayIntent) {
    instrucciones +=
      "When the user asks about free days, use ONLY the free_days array. " +
      "Definition: a free day is a weekday only; Saturdays and Sundays never count as free days. " +
      "A weekday is free if it has no classes, or if it only has asynchronous sessions. " +
      "If the user asks for the next free day, use next_free_day. " +
      "If free_days is empty, say there are no free weekdays in the requested range.\n";
  }

  const interpretNote =
    calendarQueryText !== raw
      ? "Interpreted for calendar fetch (user did not specify a day; defaulting as needed): " + calendarQueryText + "\n"
      : "";

  return (
    "[CALENDAR_CONTEXT]\n" +
    (timeContextBlock ? timeContextBlock + "\n\n" : "") +
    "User question: " + raw + "\n" +
    interpretNote +
    "GET: since=" + since + " until=" + until + "\n" +
    instrucciones +
    "clases (" + clases.length + "): " + JSON.stringify(clases) + "\n" +
    "free_days (" + freeDays.length + "): " + JSON.stringify(freeDays) + "\n" +
    "next_free_day: " + JSON.stringify(nextFreeDay) + "\n[/CALENDAR_CONTEXT]"
  );
}

sendBtn.addEventListener("click", sendChatMessage);
if (clearChatBtn) {
  clearChatBtn.addEventListener("click", () => {
    chatHistory = [];
    if (chatMessages) chatMessages.innerHTML = "";
    if (chatInput) chatInput.focus();
  });
}
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});
const CHAT_INPUT_LINE_HEIGHT = 34;
function resizeChatInput() {
  if (!chatInput) return;
  const val = (chatInput.value || "").trim();
  if (!val) {
    chatInput.style.height = CHAT_INPUT_LINE_HEIGHT + "px";
    return;
  }
  chatInput.style.height = "auto";
  const h = Math.min(Math.max(chatInput.scrollHeight, CHAT_INPUT_LINE_HEIGHT), 120);
  chatInput.style.height = h + "px";
}
chatInput.addEventListener("input", resizeChatInput);
chatInput.style.height = CHAT_INPUT_LINE_HEIGHT + "px";

/**
 * ONLY use the syllabus LINK function when the user explicitly asks for the link or to open/show/find the syllabus.
 * Covers: open/show/find/take me to/where is/download syllabus for X, is there a syllabus for X, do we have a syllabus for X.
 * NEVER use for: "what's the content of session X", "what's session X about" (those use syllabus content search).
 */
function isSyllabusLinkRequest(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  // Content/about questions must NEVER trigger link — they use syllabus content search.
  if (/\bcontent\s+of\s+session\b/i.test(t)) return false;
  if (/\bsession\s+\w+\s+(?:of|for)\s+.+\s+about\b/i.test(t)) return false;
  if (/\b(?:what's|what\s+is|whats)\s+(?:the\s+)?content\s+of\s+session\b/i.test(t)) return false;
  if (/\b(?:what's|what\s+is|whats)\s+session\s+\w+.+\s+about\??\s*$/im.test(t)) return false;
  const hasSyllabus = /\bsyllabus\b|\bs[ií]labo\b/i.test(t);
  if (!hasSyllabus) return false;
  // Explicit link for ONE course: open/show/find/download syllabus FOR X, or give me/get/link syllabus
  const linkIntentOneCourse =
    /\b(?:give|get|dame|pásame)\s+(?:me\s+)?(?:the\s+)?/i.test(t) ||
    /\b(?:link|enlace)\b/i.test(t) ||
    /\b(?:open|show|find|get)\s+(?:me\s+)?(?:the\s+)?(?:latest\s+)?(?:syllabus|s[ií]labo)\s+for\b/i.test(t) ||
    /\b(?:open|show)\s+\w+[\w\s]*\s+(?:syllabus|s[ií]labo)\b/i.test(t) ||
    /\b(?:take\s+me\s+to|where\s+is)\s+(?:the\s+)?(?:syllabus|s[ií]labo)\s+for\b/i.test(t) ||
    /\b(?:find|download)\s+(?:the\s+)?(?:syllabus|s[ií]labo)(?:\s+for|\s+pdf\b)/i.test(t) ||
    /\bshow\s+me\s+the\s+(?:syllabus|s[ií]labo)\s+pdf\s+for\b/i.test(t) ||
    /\b(?:is\s+there|do\s+we\s+have)\s+(?:a\s+)?(?:syllabus|s[ií]labo)\s+for\b/i.test(t);
  return !!linkIntentOneCourse;
}

/**
 * Announcements-only intent: user is asking about announcements (not syllabus/session content).
 * Must run before syllabus/course-content pipeline. Triggers ANNOUNCEMENTS_ONLY_QUESTION flow.
 */
function isAnnouncementsOnlyQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const t = text
    .toLowerCase()
    .trim()
    .replace(/\bannoun\w*ment\w*\b/gi, "announcement");
  // Do NOT match "message(s)" here — that is course messages/conversations (handled by isCourseMessagesQuestion).
  const announcementKeywords =
    /\bannouncement[s]?\b/i.test(t) ||
    /\bannounc\w*\b/i.test(t) ||
    /\bnotice[s]?\b/i.test(t) ||
    /\bupdate[s]?\b/i.test(t) ||
    /\bpost[s]?\b/i.test(t) ||
    /\bprofessor\s+posted\b/i.test(t) ||
    /\bblackboard\s+announcement\b/i.test(t) ||
    /\b(aviso|avisos|anuncio|anuncios)\b/i.test(t);
  if (!announcementKeywords) {
    const latestPostPatterns =
      /\b(latest|last|new|recent)\s+(update|post|notice)\b/i.test(t) ||
      /\b(latest|last|new|recent)\s+announcement\b/i.test(t) ||
      /\b(latest|last|new|recent)\s+announc\w*\b/i.test(t) ||
      /\blist\s+(unread\s+)?announcements?\b/i.test(t) ||
      /\blist\s+(unread\s+)?announc\w*\b/i.test(t) ||
      /\blist\s+(?:the\s+)?\d+\s+most\s+recent\s+announcements?\b/i.test(t) ||
      /\blist\s+(?:the\s+)?\d+\s+most\s+recent\s+announc\w*\b/i.test(t) ||
      /\bmost\s+recent\s+announcements?\s+(?:in|for)\b/i.test(t) ||
      /\bmost\s+recent\s+announc\w*\s+(?:in|for)\b/i.test(t) ||
      /\bshow\s+(me\s+)?(the\s+)?(latest|recent|unread)\s+announcements?\b/i.test(t) ||
      /\bshow\s+(me\s+)?(the\s+)?(latest|recent|unread)\s+announc\w*\b/i.test(t) ||
      /\bhow\s+many\s+(unread\s+)?announcements?\b/i.test(t) ||
      /\bhow\s+many\s+(unread\s+)?announc\w*\b/i.test(t) ||
      /\bsearch\s+announcements?\b/i.test(t) ||
      /\bsearch\s+announc\w*\b/i.test(t) ||
      /\b(unread|new)\s+announcements?\s+(in|for)\b/i.test(t);
    if (!latestPostPatterns) return false;
  }
  if (/\bsession\s+\d+\s+about\b|\bcontent\s+of\s+session\b|\bgrading\s+policy\b|\bwhen\s+is\s+session\b/i.test(t) && !announcementKeywords) return false;
  return true;
}

/**
 * Question about CONTENT (what's in a session, what's session X about, evaluation, bibliography, course description, professor, etc.).
 * When true, the intent is syllabus content search (HTML), NOT the syllabus link.
 */
function isSyllabusContentQuestion(text) {
  if (!text || typeof text !== "string") return false;
  if (isSyllabusLinkRequest(text)) return false;
  if (isExamDateQuestion(text)) return false;
  if (isFinalRelatedQuery(text) || isMidtermRelatedQuery(text)) return false;
  const t = text.toLowerCase().trim();
  // Session content (incl. ranges "23-24", follow-ups "like whats the content")
  if (/\bsession\s+[\d\-]+\s+of\s+.+/i.test(t) && /\b(content|like|whats|what|about)\b/i.test(t)) return true;
  if (/(?:what's|what\s+is|whats)\s+(?:the\s+)?content\s+of\s+session\s+\w+/i.test(t)) return true;
  if (/\b(?:whats|what\s+is|what's)\s+(?:the\s+)?content\s+of\s+(?:that|this|the)\s+session\b/i.test(t)) return true;
  if (/\bcontent\s+of\s+(?:that|this|the)\s+session\b/i.test(t)) return true;
  if (/(?:what's|what\s+is|whats)\s+session\s+\w+\s+(?:of|for)\s+.+\s+about/i.test(t)) return true;
  if (/\bsession\s+\w+[\s\S]{0,40}\babout\b/i.test(t)) return true;
  if (/\b(?:what\s+is\s+covered\s+in\s+session|what\s+is\s+covered\s+in\s+week)\s+\w+/i.test(t)) return true;
  // Course description, objectives, what is X about
  if (/\b(?:course\s+description|subject\s+description|what\s+is\s+\w+\s+about|what\s+will\s+I\s+learn)\b/i.test(t)) return true;
  if (/\b(?:learning\s+objectives|teaching\s+methodology|methodology\s+for|how\s+is\s+\w+\s+taught)\b/i.test(t)) return true;
  if (/\b(?:expected\s+workload|hours\s+should\s+I\s+dedicate)\b/i.test(t)) return true;
  // Professor, instructor, office hours, contact info (including pronoun follow-ups: "what's his email?")
  if (/\b(?:professor|instructor)\s+(?:name|email|for)\b/i.test(t)) return true;
  if (/\b(?:show\s+)?professor\s+contact\b/i.test(t)) return true;
  if (/\b(?:office\s+hours|how\s+do\s+office\s+hours)\b/i.test(t)) return true;
  if (/\b(?:what(?:'s|\s+is)\s+(?:his|her|their|the\s+professor(?:'s)?|the\s+instructor(?:'s)?)\s+(?:email|phone|contact|office))\b/i.test(t)) return true;
  if (/\b(?:his|her)\s+(?:email|phone|contact|office\s+hours?)\b/i.test(t)) return true;
  if (/\b(?:professor|profe|faculty)\s*(?:email|contact|phone|tel[eé]fono|correo)\b/i.test(t)) return true;
  if (/\b(?:correo|email)\s+(?:del?|de\s+la|de\s+los?)\s+(?:profesor|profesora|teacher)\b/i.test(t)) return true;
  // Program, schedule, topics, units, readings
  if (/\b(?:program\s+for|schedule\s+by\s+sessions|topics\s+covered|units?\s*\/?\s*parts?)\b/i.test(t)) return true;
  if (/\b(?:readings?\s+for\s+session|readings?\s+for\s+week|what\s+should\s+I\s+read\s+for\s+session)\b/i.test(t)) return true;
  if (/\b(?:required\s+readings?|recommended\s+readings?|bibliography|what\s+book\s+do\s+we\s+use|chapters?\s+do\s+we\s+cover)\b/i.test(t)) return true;
  // Evaluation, grading
  if (/\b(?:evaluation\s+criteria|how\s+is\s+\w+\s+graded|grading\s+breakdown|percentage\s+is\s+the\s+final\s+exam)\b/i.test(t)) return true;
  if (/\b(?:percentage\s+is\s+group\s+work|percentage\s+is\s+participation|assessments?\s+in\s+\w+|graded\s+components)\b/i.test(t)) return true;
  if (/\b(?:what\s+do\s+I\s+need\s+to\s+pass|minimum\s+grade\s+requirement)\b/i.test(t)) return true;
  // Attendance, AI, re-sit
  if (/\b(?:attendance\s+policy|attendance\s+requirement|miss\s+too\s+many\s+classes|absences?\s+allowed)\b/i.test(t)) return true;
  if (/\b(?:AI\s+policy|GenAI\s+allowed|use\s+AI\s+in|allowed\s+with\s+AI|forbidden\s+with\s+AI|use\s+AI\s+incorrectly)\b/i.test(t)) return true;
  if (/\b(?:re-sit|re-take|extraordinary\s+call|max\s+grade\s+in\s+the\s+extraordinary|attempts?\s+to\s+pass)\b/i.test(t)) return true;
  // Search/summarize syllabus
  if (/\b(?:search\s+(?:the\s+)?syllabus|find\s+in\s+the\s+syllabus|where\s+in\s+the\s+syllabus|syllabus\s+mention)\b/i.test(t)) return true;
  if (/\b(?:summarize\s+the\s+syllabus|key\s+points\s+of\s+the\s+syllabus|summary\s+of\s+the\s+syllabus)\b/i.test(t)) return true;
  // General content keywords
  if (/\b(contenido|qu[eé]\s+se\s+ve|qu[eé]\s+se\s+da|temario|what('s| is)\s+(covered|in the syllabus)|course content|session content)/i.test(t)) return true;
  // Short follow-up after a session/calendar turn: structural (no phrase whitelist); course comes from chat + resolver in background.
  if (
    isContinuationShapedSyllabusQuery(text) &&
    hasRecentSessionOrCourseContextInChat()
  ) {
    return true;
  }
  if (/\b(midterm|final\s+exam|quiz|evaluaci[oó]n|porcentaje|peso\s+%|weight\s+%|grade\s+%|assessment|grading)/i.test(t)) return true;
  if (/\b(bibliograf[ií]a|referencias|readings|obligatoria|lecturas|required reading)/i.test(t)) return true;
  if (/\bsyllabus\b|\bs[ií]labo\b/i.test(t)) return true;
  return false;
}

/**
 * Pregunta TEMPORAL: cuándo es una sesión, próxima sesión, qué sesiones tengo mañana/lunes, etc.
 * Debe responderse con el CALENDARIO (iCal), NUNCA con el HTML del syllabus.
 * Se comprueban PRIMERO los patrones de "cuándo/when"; si coinciden, es siempre calendario.
 */
function isTemporalSessionQuestion(text) {
  if (!text || typeof text !== "string") return false;
  // Content questions (what's session X about, content of session X) are NEVER temporal → use syllabus only.
  if (isSyllabusContentQuestion(text)) return false;
  const t = text.toLowerCase().trim();
  // "When/cuándo" + session/class → calendar only, never syllabus content.
  const temporalPatterns =
    /\b(cu[aá]ndo|when)\b[\s\S]*\b(sesi[oó]n|clase|session|class)\b/i.test(t) ||
    /\b(cu[aá]ndo|when)\s+es\s+(la\s+)?(sesi[oó]n|clase|pr[oó]xima|next)/i.test(t) ||
    /\b(cu[aá]ndo|when)\s+tengo\s+(la\s+)?(pr[oó]xima\s+)?(sesi[oó]n|clase)/i.test(t) ||
    /\b(qu[eé]|what)\s+sesiones\s+tengo\s+(ma[nñ]ana|el\s+lunes|el\s+martes|hoy|esta\s+semana)/i.test(t) ||
    /\b(qu[eé]|what)\s+clases\s+tengo\s+(ma[nñ]ana|el\s+lunes|tomorrow|today|this\s+week)/i.test(t) ||
    /\b(what\s+do\s+I\s+have|what\s+do\s+we\s+have|what('s| is)\s+on)\s+(tomorrow|today|(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday)|this\s+week)/i.test(t) ||
    /\b(my\s+)?(schedule|classes)\s+(tomorrow|today|for\s+(?:monday|tomorrow)|this\s+week)/i.test(t) ||
    /\bschedule\s+for\s+(tomorrow|today|monday|tuesday|wednesday|thursday|friday)/i.test(t) ||
    /\bsesiones\s+(ma[nñ]ana|el\s+lunes\s+que\s+viene|pr[oó]xima\s+semana|esta\s+semana)/i.test(t) ||
    /\bpr[oó]xima\s+sesi[oó]n\s+(de|of)\b/i.test(t) ||
    /\bpr[oó]xima\s+clase\s+(de|of)\b|\bnext\s+(session|class)\s+(of|for)\b/i.test(t) ||
    /\b(qu[eé]|what)\s+(clases|sesiones)\s+(tengo|hay)\s+(hoy|ma[nñ]ana|tomorrow|today)/i.test(t) ||
    /\b(classes|sessions)\s+for\s+(this|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t);
  if (temporalPatterns) return true;
  if (typeof window.Calendar !== "undefined" && window.Calendar.isCalendarQuery(text)) return true;
  if (isLikelyNaturalClassTimeQuery(text)) return true;
  if (expandShortCalendarQueryForSidepanel(text)) return true;
  return false;
}

/**
 * User is asking for ALL midterm / intermediate exam dates across courses.
 * E.g. "when are all my midterms?", "midterm dates", "all my intermediate exams".
 */
function isAllMidtermsQuery(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  const patterns = [
    /\b(?:all|every|each|todos?\s+(?:l[oa]s)?)\s+(?:my\s+)?(?:midterms?|mid-terms?|intermediate\s+exams?|parcial(?:es)?|examen(?:es)?\s+intermedi[oa]s?)\b/i,
    /\b(?:when\s+are|when's|whens|dates?\s+(?:of|for))\s+(?:all\s+)?(?:my\s+)?(?:midterms?|mid-terms?|intermediate\s+exams?|parcial(?:es)?)\b/i,
    /\b(?:midterms?|mid-terms?|intermediate\s+exams?|parcial(?:es)?)\s+(?:dates?|schedule|calendario)\b/i,
    /\b(?:when\s+(?:is|are)\s+(?:the\s+)?midterms?|when\s+(?:is|are)\s+(?:the\s+)?intermediate)\b/i,
    /\b(?:give\s+me|show\s+me|tell\s+me|list)\s+(?:all\s+)?(?:the\s+)?(?:midterm|mid-term|intermediate\s+exam)\s+dates?\b/i,
    /cu[aá]ndo\s+(?:son|es)\s+(?:(?:el|los|mis?)\s+)?(?:parcial(?:es)?|midterms?|examen(?:es)?\s+intermedi[oa]s?)/i,
  ];
  return patterns.some((re) => re.test(t));
}

/** User is asking for ALL final exam dates across courses (e.g. "when are all my finals?", "final exam dates", "fechas de los finales"). */
function isAllFinalsQuery(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  const patterns = [
    /\b(?:all|every|each|todos?\s+(?:l[oa]s)?)\s+(?:my\s+)?(?:finals?|final\s+exams?|final\s+examinations?|examen(?:es)?\s+final(?:es)?)\b/i,
    /\b(?:when\s+are|when's|whens|dates?\s+(?:of|for))\s+(?:all\s+)?(?:my\s+)?(?:finals?|final\s+exams?)\b/i,
    /\b(?:finals?|final\s+exams?)\s+(?:dates?|schedule|calendario)\b/i,
    /\b(?:when\s+(?:is|are)\s+(?:the\s+)?(?:finals?|final\s+exams?))\b/i,
    /\b(?:give\s+me|show\s+me|tell\s+me|list)\s+(?:all\s+)?(?:the\s+)?(?:final\s+exam\s+)?dates?\b/i,
    /cu[aá]ndo\s+(?:son|es)\s+(?:(?:el|los|mis?)\s+)?(?:final(?:es)?|examen(?:es)?\s+final(?:es)?)/i,
    /\b(?:fecha|fechas)\s+(?:de\s+los?|del?|of\s+the\s+)?(?:final(?:es)?|examen(?:es)?\s+final(?:es)?)/i,
    /\b(?:final\s+exam\s+)?date(?:s)?\s+(?:of\s+the\s+)?(?:final\s+exams?|finals?)/i,
  ];
  return patterns.some((re) => re.test(t));
}

/**
 * User is asking for the DATE of a midterm/final/exam (e.g. "when's the midterm of X?", "whens the midterm", "when is the final exam of Y?").
 * These must use Calendar + Syllabus + Announcements: syllabus gives session number, calendar gives the actual date.
 */
function isExamDateQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  const hasWhenDate =
    /\b(when's|whens|when\s+is|when\s+are|when\s+do\s+i\s+have|when\s+will\s+i\s+have|date\s+of|fecha\s+de|cu[aá]ndo\s+es)\b/i.test(
      t
    );
  const hasExam = /\b(midterm|mid-term|final\s+exam|final\s+examination|final\s+test|exam\s+date|final)\b/i.test(t);
  return hasWhenDate && hasExam;
}

/** Pregunta sobre el contenido del syllabus (sesiones, evaluación, bibliografía). Usa el HTML del syllabus. */
function isSyllabusQuestion(text) {
  if (!text || typeof text !== "string") return false;
  if (isSyllabusLinkRequest(text)) return false;
  if (isTemporalSessionQuestion(text)) return false;
  if (isExamDateQuestion(text)) return false;
  if (isFinalRelatedQuery(text) || isMidtermRelatedQuery(text)) return false;
  const t = text.toLowerCase().trim();
  const keywords = [
    "content of session", "session", "sesi\u00f3n", "sesion", "midterm", "final exam", "quiz", "quizzes",
    "evaluaci\u00f3n", "evaluacion", "evaluation", "bibliograf\u00eda", "bibliografia", "bibliography",
    "syllabus", "s\u00edlabo", "silabo", "porcentaje", "percent", "peso", "weight", "grade",
    "contenido de la sesi\u00f3n", "contenido sesi\u00f3n", "qu\u00e9 se ve en", "que se ve en",
    "obligatoria", "referencias", "readings"
  ];
  return keywords.some((k) => t.includes(k));
}

/**
 * True when the user query is a course question: should trigger combined Calendar + Announcements + Syllabus pipeline.
 * Only true when the user has EXPLICITLY mentioned a SPECIFIC course (name or "this course"). Returns false for
 * "every course", "all courses", "each course" (answer from default flow with all data). Schedule-only questions
 * like "what classes do I have tomorrow?" must NOT require a course — they use the normal calendar flow.
 */
function isCourseQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const t = normalizeClassQueryTypos(text);
  const GENERIC_NON_COURSE_NOUNS = new Set([
    "session", "sessions", "class", "classes", "assignment", "assignments", "announcement", "announcements",
    "message", "messages", "course", "courses", "kind", "type", "one", "ones", "thing", "things"
  ]);
  // Global/follow-up phrasing should not force a specific course resolution.
  if (/\bin\s+general\b|\bgeneralmente\b|\ben\s+general\b/i.test(t)) return false;
  // "of every course", "for all courses", "each course", "any course" = NOT a single course, use default flow
  if (/\b(?:every|all|each|any)\s+course[s]?\b/i.test(t)) return false;
  if (/\b(?:every|all)\s+my\s+courses?\b/i.test(t)) return false;
  // Explicit course reference: "this course", "that class", "my course"
  if (/\b(this\s+course|that\s+class|my\s+course)\b/i.test(t)) return true;
  // If the question is about classes and includes an explicit date like "16 of march" or "march 18",
  // treat it as a pure calendar question (no course resolution needed).
  const engDateInTextRe = /\b\d{1,2}\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/i;
  if (/\bclass(?:es)?\b/i.test(t) && engDateInTextRe.test(t)) return false;
  // "in X" / "of X" / "for X" where X is not a date/time word (so "in Microeconomics", "of Cost Accounting", "for Physics")
  const timeWords =
    "tomorrow|today|tday|tmrw|tmr|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|this monday|this tuesday|this wednesday|this thursday|this friday|this saturday|this sunday|next monday|next tuesday|next wednesday|next thursday|next friday|next saturday|next sunday";
  const dateLikeRe = /\b\d{1,2}\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/i;
  if (/\b(in|of|for)\s+[a-z][\w\s]{0,35}\s*(\?|$|,|\.)/i.test(t)) {
    let tail = t.replace(/.*\b(in|of|for)\s+/i, "");
    // Remove leading articles like "the", "el", "la" so patterns like "the 17 of march" are treated as dates.
    tail = tail.replace(/^(the|el|la)\s+/i, "");
    const firstToken = (tail.split(/\s+/)[0] || "").toLowerCase();
    if (GENERIC_NON_COURSE_NOUNS.has(firstToken)) return false;
    if (/^(any|some|all|kind|type)\b/.test(firstToken)) return false;
    // If the tail looks like a pure date (e.g. "17 of march", "march 18", "the 17 of march"), do NOT treat as course.
    if (!dateLikeRe.test(tail) && !new RegExp("\\b(" + timeWords + ")\\b", "i").test(tail)) return true;
  }
  // "session X of/in ...", "announcement(s) of/in ...", "syllabus of/for ..." (implies a course name follows)
  if (/\b(session|sesi[oó]n|announcement|syllabus|s[ií]labo)\s+(?:#?\d+\s+)?(?:of|in|for)\s+[a-z][\w\s]{1,35}\s*(\?|$|,|\.)/i.test(t)) return true;
  if (/\b(last|latest|recent)\s+(?:announcement|update|post)\s+(?:of|in|for)\s+[a-z][\w\s]{1,35}\s*(\?|$|,|\.)/i.test(t)) return true;
  // Avoid false positives in aggregate exam queries:
  // "my last/closest/next final", "my third midterm", etc.
  if (/\bmy\s+(?:last|latest|next|closest|nearest|first|second|third)\s+final(?:\s+exam)?\b/i.test(t)) return false;
  if (/\bmy\s+(?:last|latest|next|closest|nearest|first|second|third)\s+midterm\b/i.test(t)) return false;
  if (/\bmy\s+final(?:\s+exam)?\b/i.test(t) && !/\bmy\s+[a-z0-9][\w\s]{2,50}\s+final\b/i.test(t)) return false;
  if (/\bmy\s+midterm\b/i.test(t) && !/\bmy\s+[a-z0-9][\w\s]{2,50}\s+midterm\b/i.test(t)) return false;
  // "when's my Humanities final exam", "my Programming midterm date"
  if (/\bmy\s+[a-z0-9][\w\s]{0,50}?\s+final\b/i.test(t)) return true;
  if (/\bmy\s+[a-z0-9][\w\s]{0,50}?\s+midterm\b/i.test(t)) return true;
  return false;
}

function isAssignmentsFollowUpQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  const followUpShape =
    /^(and\s+)?(in\s+general[, ]*)?(like\s+)?(which\s+ones?\s+do\s+i\s+have)\??$/.test(t) ||
    /^(and\s+)?(in\s+general[, ]*)?(what\s+ones?\s+do\s+i\s+have)\??$/.test(t) ||
    /^(and\s+)?(in\s+general[, ]*)?(which\s+assignments?\s+do\s+i\s+have)\??$/.test(t) ||
    /^(and\s+)?(what\s+about\s+)?(in\s+general)\??$/.test(t);
  if (!followUpShape) return false;
  const recent = (getRecentChatWindowText(8) + "\n" + getLastAssistantMessageText()).toLowerCase();
  return /\bassignments?|deliverables?|tasks?|chores?|homework|entregas?|tareas?\b/.test(recent);
}

function isExamAggregateNaturalQuery(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  const hasExamDomain = /\b(final|finals|final\s+exam|midterm|mid-term|parcial)\b/.test(t);
  if (!hasExamDomain) return false;
  const hasAggregateSignal =
    /\b(last|latest|closest|nearest|next|first|second|third|close|soon)\b/.test(t) ||
    /\b(which\s+one|what\s+is\s+the\s+last|what\s+was\s+the\s+last)\b/.test(t) ||
    /\bmy\s+final(?:\s+exam)?\b/.test(t) ||
    /\bmy\s+midterm\b/.test(t) ||
    /\b(?:do\s+i\s+have|have\s+i\s+got)\s+any\s+(?:final|finals|final\s+exam|midterm)\b/.test(t);
  if (!hasAggregateSignal) return false;
  // If the user clearly specifies a course, keep single-course path.
  if (isCourseQuestion(t)) return false;
  return true;
}

/**
 * Short substring to resolve course from exam-date questions (full sentence scores poorly in CourseRegistry).
 */
function extractCourseNameHintForExamDateQuery(text) {
  if (!text || typeof text !== "string") return "";
  const t = text.trim();
  let m = t.match(/\bfinal\s+exam\s+(?:of|for)\s+(.+?)\s*(\?|$)/i);
  if (m) return m[1].replace(/\?+$/, "").trim();
  m = t.match(/\bmidterm\s+(?:exam\s+)?(?:of|for)\s+(.+?)\s*(\?|$)/i);
  if (m) return m[1].replace(/\?+$/, "").trim();
  m = t.match(/\bmy\s+(.+?)\s+final\s+exam\b/i);
  if (m) return m[1].trim();
  m = t.match(/\bmy\s+(.+?)\s+final\b/i);
  if (m) return m[1].trim();
  m = t.match(/\bmy\s+(.+?)\s+midterm\b/i);
  if (m) return m[1].trim();
  return "";
}

function resolveCourseForExamDateQuery(userText, courseIdByNormalizedName, coursesByCourseId) {
  let r = resolveCourseForPrompt(userText, courseIdByNormalizedName, coursesByCourseId);
  if (r) return r;
  const hint = extractCourseNameHintForExamDateQuery(userText);
  if (hint.length >= 2) {
    r = resolveCourseForPrompt(hint, courseIdByNormalizedName, coursesByCourseId);
    if (r) return r;
  }
  return null;
}

/** Last reply was a deterministic final/midterm date from the extension DB (short follow-ups reuse the same intent). */
function hasRecentExamDateDomainInChat() {
  const recent = (getRecentChatWindowText(12) + "\n" + getLastAssistantMessageText()).toLowerCase();
  return (
    /\byour\s+final\s+exam\s+(?:for|is)\b/.test(recent) ||
    /\byour\s+midterm\s+(?:for|is)\b/.test(recent) ||
    /\bhere\s+are\s+your\s+(?:final\s+exams?|midterms?)\b/.test(recent) ||
    (/\bdates\s+come\s+from\s+the\s+extension\s+database\b/.test(recent) &&
      /\b(?:final|midterm|session\s+\d+)/i.test(recent))
  );
}

function isExamCourseSwitchFollowUp(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  if (/^(?:and|or|also)\s+for\s+[a-z0-9]/i.test(t)) return true;
  if (/^(?:and|or|also)\s+in\s+[a-z0-9]/i.test(t)) return true;
  if (/^(?:what|how)\s+about\s+[a-z0-9]/i.test(t)) return true;
  return false;
}

function extractCourseFromExamFollowUp(trimmed) {
  let m = trimmed.match(/^(?:and|or|also)\s+for\s+(.+)/i);
  if (m && m[1]) return m[1].replace(/\?+$/, "").trim();
  m = trimmed.match(/^(?:and|or|also)\s+in\s+(.+)/i);
  if (m && m[1]) return m[1].replace(/\?+$/, "").trim();
  m = trimmed.match(/^(?:what|how)\s+about\s+(.+)/i);
  if (m && m[1]) return m[1].replace(/\?+$/, "").trim();
  return "";
}

function inferExamKindFromLastAssistant() {
  const last = (getLastAssistantMessageText() || "").toLowerCase();
  if (/\bfinal\s+exam\b|\byour\s+final\b/.test(last)) return "final";
  if (/\bmidterm\b|\bparcial\b/.test(last) && !/\bfinal\s+exam\b/.test(last)) return "midterm";
  const prevUser = (getMostRecentUserMessageText() || "").toLowerCase();
  if (/\bmidterm\b/.test(prevUser) && !/\bfinal\b/.test(prevUser)) return "midterm";
  return "final";
}

/** Turns "and for microecon?" into a full exam-date query so routing hits GET_FINAL_DATES with courseId. */
function augmentExamDateUserText(text) {
  if (!text || typeof text !== "string") return text;
  const trimmed = text.trim();
  if (!hasRecentExamDateDomainInChat()) return text;
  if (!isExamCourseSwitchFollowUp(trimmed)) return text;
  const course = extractCourseFromExamFollowUp(trimmed);
  if (!course || course.length < 2) return text;
  const kind = inferExamKindFromLastAssistant();
  if (kind === "midterm") return "when is my midterm exam for " + course + "?";
  return "when is my final exam for " + course + "?";
}

/**
 * Recent assistant/user text mentions a numbered session tied to a course (e.g. calendar line "Session 30 of COST ACCOUNTING…").
 * Used so follow-ups do not need a course name in the same message.
 */
function hasRecentSessionOrCourseContextInChat() {
  const blob = (getRecentChatWindowText(14) + "\n" + getLastAssistantMessageText()).trim();
  if (blob.length < 12) return false;
  if (/\bSession\s+\d+\s+of\s+/i.test(blob)) return true;
  if (/\bsession\s+\d+\s+of\s+/i.test(blob)) return true;
  // Syllabus answers: "According to the syllabus for X, Session 30 is:"
  if (/\bfor\s+[^,\n]{2,80},?\s+Session\s+\d{1,3}\b/i.test(blob)) return true;
  return false;
}

/**
 * Short message shaped like a continuation (not a list of exact phrases).
 * Excludes pure calendar follow-ups ("when is that session?").
 */
function isContinuationShapedSyllabusQuery(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  if (t.length > 180) return false;
  const lower = t.toLowerCase();
  if (/\b(?:when|cu[aá]ndo)\s+is\b/i.test(t) && /\b(?:that|this|the)\s+session\b/i.test(lower)) return false;
  if (/\b(?:when|cu[aá]ndo)\b/i.test(lower) && /\b(?:session|class)\b/i.test(lower)) {
    const syllabusish = /\b(?:content|cover|see|topic|material|syllabus|read|objectives|professor|grading|bibliography|program|what\s+we|going\s+to\s+see|learn|study)\b/i.test(lower);
    if (!syllabusish) return false;
  }
  const looksLikeFollowUp =
    /^(?:and|also|so|what about|ok|well|but)\b/i.test(t) ||
    /\b(?:that|this|the)\s+(?:session|class)\b/i.test(lower);
  if (!looksLikeFollowUp) return false;
  const asksSomething =
    /\b(?:what|which|how|who|content|cover|see|material|topic|read|syllabus|professor|grading|percent|bibliography|objectives|program|going|learn|stuff|about|explain|tell)\b/i.test(lower) ||
    /\?/.test(t);
  return asksSomething;
}

function extractSessionAndCourseFromMessage(text) {
  const t = (text || "").trim();
  if (t.length < 8) return null;
  const m = t.match(/\bsession\s+(\d{1,3})\s+of\s+(.+)/i);
  if (!m || !m[1] || !m[2]) return null;
  let course = m[2].trim().replace(/\?+$/, "").replace(/\s+/g, " ").trim();
  course = course.replace(/\s+(will take place|take place|is on|on [A-Za-z]+).*/i, "").trim();
  const n = parseInt(m[1], 10);
  if (Number.isNaN(n) || n < 1 || course.length < 2) return null;
  return { session: String(n), course };
}

function extractSessionAndCourseFromChatContext() {
  const combined = (getRecentChatWindowText(12) + "\n" + getLastAssistantMessageText()).trim();
  if (!combined) return null;
  const patterns = [
    /Session\s+(\d+)\s+of\s+([^\n.?]+?)(?:\s+will|\s+is\b|,|\n|$)/i,
    /\bsession\s+(\d+)\s+of\s+([^.?\n]+?)(?:\s+will|\?|,|\n|\.|$)/i,
    /\bthe\s+session\s+(\d+)\s+of\s+([^.?\n]+?)(?:\s*\?|$)/i
  ];
  let best = null;
  let bestIdx = -1;
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(combined)) !== null) {
      if (m && m[1] && m[2]) {
        let course = m[2].trim().replace(/\s+/g, " ");
        course = course.replace(/\s+(will take place|take place|is on|on [A-Za-z]+).*/i, "").trim();
        const n = parseInt(m[1], 10);
        if (!Number.isNaN(n) && n >= 1 && course.length >= 2 && m.index > bestIdx) {
          bestIdx = m.index;
          best = { session: String(n), course };
        }
      }
    }
  }
  const reForSess = /\bfor\s+([^,\n]+),?\s+Session\s+(\d{1,3})\b/gi;
  let fm;
  while ((fm = reForSess.exec(combined)) !== null) {
    let course = fm[1].trim().replace(/\s+/g, " ");
    course = course.replace(/^(the\s+syllabus\s+for|el\s+syllabus\s+de)\s+/i, "").trim();
    const n = parseInt(fm[2], 10);
    if (!Number.isNaN(n) && n >= 1 && course.length >= 2 && fm.index > bestIdx) {
      bestIdx = fm.index;
      best = { session: String(n), course };
    }
  }
  return best;
}

/**
 * "When is it?" / "When's that?" after a session/course turn → same as "whens session N of [course]?" for calendar routing.
 * Without this, the query lacks "session" and falls through to OpenRouter; the model may paste a syllabus URL and the UI shows "Open syllabus".
 */
function isBareWhenIsSessionFollowUp(text) {
  const t = (text || "").trim();
  if (t.length > 72) return false;
  return (
    /^(?:when|when's|whens)\s+(?:is|was)\s+it\??\s*$/i.test(t) ||
    /^(?:when|when's|whens)\s+is\s+that\??\s*$/i.test(t) ||
    /^(?:cu[aá]ndo)\s+(?:es|son)\s+eso\??\s*$/i.test(t)
  );
}

function augmentWhenIsItFollowUp(userText) {
  if (!userText || typeof userText !== "string") return userText;
  const trimmed = userText.trim();
  if (!isBareWhenIsSessionFollowUp(trimmed)) return userText;
  if (!hasRecentSessionOrCourseContextInChat()) return userText;
  const ctx = extractSessionAndCourseFromChatContext();
  if (!ctx) return userText;
  return "whens session " + ctx.session + " of " + ctx.course + "?";
}

/**
 * When session + course appear in recent chat, optionally expand to an explicit syllabus query so the first pass of course resolution matches.
 * Resolution still works without this via resolveCourseInBackground + recent chat in the service worker.
 */
function augmentSyllabusSessionFollowUp(userText) {
  if (!userText || typeof userText !== "string") return userText;
  const trimmed = userText.trim();
  // Same turn explicitly names session + course — normalize from THIS message only (never reuse older Session N from chat).
  const fromCurrent = extractSessionAndCourseFromMessage(trimmed);
  if (fromCurrent && !isTemporalSessionQuestion(trimmed)) {
    return "what is the content of session " + fromCurrent.session + " of " + fromCurrent.course + "?";
  }
  if (!hasRecentSessionOrCourseContextInChat()) return userText;
  if (!isContinuationShapedSyllabusQuery(trimmed)) return userText;
  if (isTemporalSessionQuestion(trimmed)) return userText;
  const ctx = extractSessionAndCourseFromChatContext();
  if (!ctx) return userText;
  return "what is the content of session " + ctx.session + " of " + ctx.course + "?";
}

function getIntentRoutingDecision(text) {
  const fallbackDecision = {
    route: "OPENROUTER_CHAT",
    confidence: 0,
    top1: { route: "OPENROUTER_CHAT", confidence: 0 },
    fallbackToLegacy: true
  };
  if (typeof window.IntentRouter === "undefined") return fallbackDecision;
  const router = window.IntentRouter;
  if (
    typeof router.preprocessText !== "function" ||
    typeof router.extractEntities !== "function" ||
    typeof router.classifyIntent !== "function" ||
    typeof router.chooseRoute !== "function"
  ) {
    return fallbackDecision;
  }
  const pre = router.preprocessText(text);
  const entities = router.extractEntities(pre);
  const intents = router.classifyIntent(pre, entities);
  const decision = router.chooseRoute(intents);
  return {
    pre,
    entities,
    intents,
    route: decision.route,
    confidence: decision.confidence,
    top1: decision.top1,
    fallbackToLegacy: !!decision.fallbackToLegacy
  };
}

function logIntentRoutingTelemetry(text, decision, usedLegacyFallback) {
  try {
    const safeText = (text || "").slice(0, 160);
    console.log("[NAVIE][IntentRouting]", {
      text: safeText,
      intentTop1: decision?.top1?.route || decision?.route || "OPENROUTER_CHAT",
      confidence: Number(decision?.confidence || 0).toFixed(3),
      routeChosen: decision?.route || "OPENROUTER_CHAT",
      fallbackUsed: !!usedLegacyFallback
    });
  } catch (_) {}
}

async function sendChatMessage() {
  if (surveyGateLocked) {
    showSurveyGate({ ToolUrl: surveyGateLink?.href || "", LoginFOHeaderText: surveyGateBody?.textContent || "" });
    return;
  }
  const rawUserText = (chatInput.value || "").trim();
  if (!rawUserText) return;
  let text = augmentWhenIsItFollowUp(rawUserText);
  text = augmentSyllabusSessionFollowUp(text);
  text = augmentExamDateUserText(text);

  const apiKey = await getApiKey();
  if (!apiKey) {
    appendMessage("assistant", "Set your OpenRouter API Key in the ⚙ button and try again.", true);
    chatInput.value = "";
    return;
  }

  // Show user message and loading indicator immediately — before any async work.
  chatInput.value = "";
  const welcome = chatMessages.querySelector(".welcome");
  if (welcome) welcome.remove();
  appendMessage("user", rawUserText);
  sendBtn.disabled = true;

  const loadingEl = document.createElement("div");
  loadingEl.className = "msg assistant loading";
  loadingEl.textContent = "…";
  chatMessages.appendChild(loadingEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Run LLM classification and syncPrefs in parallel — zero extra latency.
  const syncPrefs = await loadSyncPrefs();

  // LLM-based intent classification — replaces regex intentRouter for routing decisions.
  // Understands any phrasing, word order, or language variant without requiring exact keywords.
  let navieIntent = "GENERAL_CHAT";
  let navieCourse = null;
  try {
    if (typeof window.NavieClassifier !== "undefined") {
      const cls = await window.NavieClassifier.classify(text, chatHistory.slice(-4), apiKey, OPENROUTER_URL, DEFAULT_MODEL);
      navieIntent = cls.intent || "GENERAL_CHAT";
      navieCourse = cls.courseName || null;
      console.log("[NAVIE][Classifier]", { text: text.slice(0, 80), navieIntent, navieCourse, confidence: cls.confidence });
    }
  } catch (_) {}

  // Maps LLM intent IDs to legacy route names consumed by shouldRoute.
  const NAVIE_INTENT_ROUTE = {
    FINAL_EXAM_DATE: "FINAL_EXAM_DATE",
    ALL_FINALS: "FINAL_DATES_ALL",
    MIDTERM_DATE: "MIDTERM_DATE",
    ALL_MIDTERMS: "MIDTERM_DATES_ALL",
    ASSIGNMENT_GRADE: "ASSIGNMENT_GRADE",
    SUBMISSION_STATUS: "SUBMISSION_STATUS",
    SINGLE_SUBMISSION_CHECK: "SINGLE_ASSIGNMENT_SUBMISSION_CHECK",
    ATTENDANCE: "ATTENDANCE",
    CALENDAR_TEMPORAL: "TEMPORAL_SESSION",
    SYLLABUS_CONTENT: "SYLLABUS_QUESTION",
    SYLLABUS_LINK: "SYLLABUS_LINK",
    ANNOUNCEMENTS: "ANNOUNCEMENTS_ONLY",
    COURSE_MESSAGES: "COURSE_MESSAGES",
    PROFILE_IDENTITY: "PROFILE_IDENTITY"
  };
  const navieRoute = NAVIE_INTENT_ROUTE[navieIntent] || "OPENROUTER_CHAT";

  // LLM classification is authoritative; legacy predicates are a safety net.
  const shouldRoute = (routeName, legacyPredicate) => {
    if (navieRoute === routeName) return true;
    return typeof legacyPredicate === "function" ? !!legacyPredicate(text) : false;
  };
  console.log("[NAVIE][Route]", navieRoute, navieCourse ? "→ " + navieCourse : "");

  try {
    // Name / email / student ID → ALWAYS answer from GET_USER_PROFILE, never from model.
    if (shouldRoute("PROFILE_IDENTITY", isProfileIdentityQuestion)) {
      const res = await sendMessage({ type: "GET_USER_PROFILE" });
      loadingEl.remove();
      const answer = getProfileIdentityAnswer(text, res?.ok ? res.profile : null);
      appendMessage("assistant", answer);
      chatHistory.push({ role: "user", content: rawUserText });
      chatHistory.push({ role: "assistant", content: answer });
      if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
      sendBtn.disabled = false;
      return;
    }
    // Syllabus LINK only: "Give me the syllabus of X" / "Give me the link of the syllabus" → only the green button, no content/announcements.
    // Guard: only route here if "syllabus"/"silabo" is explicitly in the text — prevents "give me the link to them" from landing here.
    if (shouldRoute("SYLLABUS_LINK", isSyllabusLinkRequest) && /\b(?:syllabus|silabo|s[ií]labo)\b/i.test(text)) {
      const syncDataLink = await getSyncData();
      const resolvedCourseLink = resolveCourseForPrompt(navieCourse || text, syncDataLink.courseIdByNormalizedName, syncDataLink.coursesByCourseId);
      loadingEl.remove();
      if (resolvedCourseLink) {
        const syllabusUrl = buildSyllabusUrlForCourse(resolvedCourseLink.learnCourseId);
        appendMessage("assistant", "", false, {
          syllabusLink: true,
          url: syllabusUrl,
          courseName: resolvedCourseLink.name,
          isEnglish: isEnglishQuery(text)
        });
        chatHistory.push({ role: "user", content: rawUserText });
        chatHistory.push({ role: "assistant", content: "Here is the syllabus for " + resolvedCourseLink.name + ". " + syllabusUrl });
        if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
      } else {
        const suggestions = getCourseSuggestionsForText(
          text,
          syncDataLink.courseIdByNormalizedName,
          syncDataLink.coursesByCourseId,
          3
        );
        const suggestionText = suggestions.length
          ? " I found similar courses: " + suggestions.join(", ") + "."
          : "";
        appendMessage(
          "assistant",
          "I couldn't confidently match that course yet." +
            suggestionText +
            " Tell me the course with 1-2 keywords (for example: Cost Accounting) and I'll open the syllabus link.",
          false
        );
      }
      sendBtn.disabled = false;
      return;
    }
    // Attendance only: typo-tolerant + follow-ups — must not require perfect spelling or one sentence template.
    const tAttNorm = normalizeAttendanceQueryTypos(text);
    const attendanceQueryText = augmentAttendanceUserText(text, tAttNorm);
    const shouldHandleAttendance =
      navieIntent === "ATTENDANCE" ||
      shouldRoute("ATTENDANCE", function () {
        return isAttendanceQuestion(tAttNorm);
      }) ||
      isAttendanceQuestion(tAttNorm) ||
      isAttendanceQuestion(attendanceQueryText) ||
      isAttendanceCourseSwitchFollowUp(text);
    if (shouldHandleAttendance) {
      const syncDataAttendance = await getSyncData();
      let resolvedCourseAttendance = resolveCourseForPrompt(
        navieCourse || attendanceQueryText,
        syncDataAttendance.courseIdByNormalizedName,
        syncDataAttendance.coursesByCourseId
      );
      if (!resolvedCourseAttendance) {
        resolvedCourseAttendance = resolveCourseForPrompt(
          normalizeClassQueryTypos(attendanceQueryText),
          syncDataAttendance.courseIdByNormalizedName,
          syncDataAttendance.coursesByCourseId
        );
      }
      loadingEl.remove();
      if (!resolvedCourseAttendance) {
        appendMessage(
          "assistant",
          "I couldn't match that to one course yet—say it in a few words (for example: Data Analysis, Physics, Microeconomics).",
          false
        );
        sendBtn.disabled = false;
        return;
      }
      const attendanceRes = await sendMessage({
        type: "GET_ATTENDANCE_FOR_COURSE",
        courseId: resolvedCourseAttendance.learnCourseId,
        courseName: resolvedCourseAttendance.name
      });
      const ctxAttendance = typeof window.TimeContext !== "undefined" ? window.TimeContext.getNowContext() : null;
      const timeBlockAttendance =
        ctxAttendance && typeof window.TimeContext.buildTimeContextBlock === "function"
          ? window.TimeContext.buildTimeContextBlock(ctxAttendance)
          : "";
      let attendanceBlock =
        "[ATTENDANCE_RESULT]\n" +
        "Course: " + (attendanceRes?.courseName ?? resolvedCourseAttendance.name) + ".\n";
      if (attendanceRes?.ok && attendanceRes?.score != null && attendanceRes?.scoreFormatted) {
        attendanceBlock +=
          "Attendance score: " + attendanceRes.scoreFormatted +
          " (from column: " + (attendanceRes.selectedColumn || "Attendance") + ").\n" +
          "Answer the user with this percentage and the course name. Do not guess or invent a number.\n";
      } else {
        const errReason = attendanceRes?.error || attendanceRes?.scoreFormatted || "Attendance score not available yet.";
        attendanceBlock +=
          "Attendance score: not available. Reason: " + errReason + "\n" +
          "Tell the user that the attendance grade is not available yet for this course, or that they should open Blackboard and log in.\n";
      }
      attendanceBlock += "[/ATTENDANCE_RESULT]";
      const systemPromptAttendance =
        (timeBlockAttendance ? timeBlockAttendance + "\n\n" : "") +
        attendanceBlock + "\n\n" +
        "Rules: If [ATTENDANCE_RESULT] has a score, reply with that percentage and the course name. " +
        "If the score is missing, say it is not available yet or that they should open Blackboard and log in. " +
        "Respond in the same language as the user (English or Spanish). " +
        "Do not use asterisks (*) in your response; use plain text only.";
      const messagesAttendance = [
        { role: "system", content: systemPromptAttendance },
        { role: "user", content: rawUserText }
      ];
      const openRouterRes = await sendMessage({
        type: "OPENROUTER_CHAT",
        apiKey,
        body: { model: DEFAULT_MODEL, messages: messagesAttendance, max_tokens: 256 }
      });
      if (openRouterRes?.ok && openRouterRes?.content != null) {
        const content = (openRouterRes.content ?? "").trim() || "Could not get attendance.";
        appendMessage("assistant", content);
        chatHistory.push({ role: "user", content: rawUserText });
        chatHistory.push({ role: "assistant", content });
        if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
      } else {
        appendMessage("assistant", attendanceRes?.error || openRouterRes?.errorText || "Could not get attendance.", true);
      }
      sendBtn.disabled = false;
      return;
    }
    // Assignment grade / full assignment list lookup:
    // - "What's my grade on X?"
    // - "what are my assignments in/for/of X?"
    // - "what assignments do I have for X?"
    // Any assignment-related question that clearly mentions a course should go through the gradebook
    // (and never the syllabus), EXCEPT when the user is explicitly asking about submission status
    // ("do I need to submit", "what assignments do I need to submit", etc.), which is handled by
    // the submission-status branches below.
    // When LLM says ASSIGNMENT_GRADE but found no specific course, it's a global "show my upcoming
    // assignments" query — let it fall through to general chat (which has upcomingAssignments context).
    // Only send to GET_ASSIGNMENT_GRADE when there IS a course or a specific assignment name to look up.
    //
    // IMPORTANT: Scheduling/date questions ("when is the retake for X", "what date is the mini test",
    // "when does X take place") are NOT grade queries — even if they mention an assignment name.
    // The LLM sometimes misclassifies them as ASSIGNMENT_GRADE. Detect and reroute to COMBINED_COURSE_QUERY
    // so announcements, messages, and syllabus are searched instead.
    const isSchedulingOrDateQ =
      /\bwhen\s+(is|are|was|will)\b|\bwhat\s+(date|day|time)\b|\bcu[aá]ndo\b|\bfecha\b|\bretake\b|\breschedul|\bqu[eé]\s+d[ií]a\b/i.test(text) &&
      !/\b(?:grade|score|points?|mark|nota|calificaci[oó]n|puntos?|resultado|result)\b/i.test(text);

    const assignmentNeedsLookup = navieIntent === "ASSIGNMENT_GRADE"
      ? !!(navieCourse) && !isSchedulingOrDateQ  // LLM path: only lookup if course found AND not a scheduling question
      : (assignmentGradeRoutePredicate(text));    // legacy path: trust the predicate

    // Flag: LLM said ASSIGNMENT_GRADE but we're sending it to COMBINED instead (scheduling/date question with known course)
    const assignmentReroutedToCombined = navieIntent === "ASSIGNMENT_GRADE" && !!navieCourse && isSchedulingOrDateQ;

    if (assignmentNeedsLookup) {
      const gradeUserText = augmentAssignmentGradeUserText(text);
      const gradeRes = await sendMessage({ type: "GET_ASSIGNMENT_GRADE", userText: gradeUserText, courseHint: navieCourse });
      loadingEl.remove();
      const responseText = gradeRes?.ok ? (gradeRes.responseText ?? "") : (gradeRes?.error ?? "Grade lookup failed.");
      const opts = gradeRes?.ok && Array.isArray(gradeRes.assignmentItems) && gradeRes.assignmentItems.length > 0
        ? { assignmentItems: gradeRes.assignmentItems }
        : undefined;
      const softCourseError = !gradeRes?.ok && isNonCriticalCourseResolutionMessage(responseText);
      appendMessage("assistant", responseText, !gradeRes?.ok && !softCourseError, opts);
      chatHistory.push({ role: "user", content: rawUserText });
      chatHistory.push({ role: "assistant", content: responseText });
      if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
      sendBtn.disabled = false;
      return;
    }
    // Single assignment submission check: "Did I submit X?" → GET_SINGLE_ASSIGNMENT_SUBMISSION_STATUS.
    if (shouldRoute("SINGLE_ASSIGNMENT_SUBMISSION_CHECK", isSingleAssignmentSubmissionCheckQuestion)) {
      const subRes = await sendMessage({ type: "GET_SINGLE_ASSIGNMENT_SUBMISSION_STATUS", userText: text });
      loadingEl.remove();
      const responseText = subRes?.ok ? (subRes.responseText ?? "") : (subRes?.error ?? "Submission status lookup failed.");
      appendMessage("assistant", responseText, !subRes?.ok);
      chatHistory.push({ role: "user", content: rawUserText });
      chatHistory.push({ role: "assistant", content: responseText });
      if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
      sendBtn.disabled = false;
      return;
    }
    // Course messages (conversations): resolve course → AI plan → execute → show response.
    // Guard: never use COURSE_MESSAGES for contact-info queries (email, phone, office hours).
    // These belong in SYLLABUS/COMBINED — the classifier sometimes confuses them with inbox queries.
    const isContactInfoQuery = /\b(?:email|e-?mail|phone|tel[eé]fono|office\s*hours?|contact\s*info|contacto|c[oó]mo\s+(?:contactar|llegar))\b/i.test(text) &&
      !/\b(?:check\s+messages?|my\s+messages?|inbox\s+message|unread\s+messages?|conversation\s+in)\b/i.test(text);
    if (!isContactInfoQuery && shouldRoute("COURSE_MESSAGES", function (t) { return isCourseMessagesQuestion(t) || isGlobalMessagesQuestion(t); })) {
      // Global messages path: no explicit course needed ("messages from yesterday", "my last 4", etc.).
      if (isGlobalMessagesQuestion(text) || isGlobalLastMessageQuestion(text)) {
        loadingEl.remove();
        const plan = buildGlobalMessagesPlan(text);
        const msgRes = await sendMessage({
          type: "COURSE_MESSAGES_EXECUTE_GLOBAL",
          plan
        });
        const responseText = msgRes?.ok ? (msgRes.responseText ?? "") : (msgRes?.error ?? "Could not load messages. Open Blackboard and try again.");
        appendMessage("assistant", responseText, !msgRes?.ok);
        chatHistory.push({ role: "user", content: rawUserText });
        chatHistory.push({ role: "assistant", content: responseText });
        if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
        sendBtn.disabled = false;
        return;
      }

      // Normal per-course messages flow.
      const syncDataMsg = await getSyncData();
      const resolvedCourseMsg = resolveCourseForMessages(navieCourse || text, syncDataMsg.courseIdByNormalizedName, syncDataMsg.coursesByCourseId);
      loadingEl.remove();
      if (!resolvedCourseMsg) {
        appendMessage("assistant", "I understood that you are asking about course messages, but I could not identify the course yet. Please mention the course name and I will check the messages for you.");
        sendBtn.disabled = false;
        return;
      }
      const courseIdMsg = resolvedCourseMsg.learnCourseId;
      const courseNameMsg = resolvedCourseMsg.name;
      const planPrompt =
        "User question: " + JSON.stringify(text) + "\nCourse name: " + JSON.stringify(courseNameMsg) + "\nCourse id: " + JSON.stringify(courseIdMsg);
      const systemPromptCourseMessages =
        "You are an intent classifier for course message queries. Output ONLY a single valid JSON object, no markdown, no explanation. " +
        "Allowed intents: GET_LAST_MESSAGE, GET_RECENT_MESSAGES, CHECK_ANY_MESSAGES, CHECK_UNREAD, SEARCH_BY_SENDER, SEARCH_BY_KEYWORD, SEARCH_BY_DATE_RANGE, SUMMARIZE_LAST, SUMMARIZE_RESULTS, EXTRACT_DETAILS. " +
        "Use GET_LAST_MESSAGE for 'last/latest message', limit 1. Use GET_RECENT_MESSAGES for 'last N messages', set limit to N (max 10). " +
        "Use CHECK_UNREAD for unread messages; set filters.unreadOnly true. Use CHECK_ANY_MESSAGES for 'any messages'. " +
        "Use SEARCH_BY_SENDER when user names a person (e.g. 'from Catalina López'); put the name in filters.sender. " +
        "Use SEARCH_BY_KEYWORD when user asks about a topic or phrase; put words in query.keywords and/or query.raw. " +
        "Use SEARCH_BY_DATE_RANGE for 'messages from last week/month'; set dateRange.from/to as ISO dates. " +
        "Set needsRefresh true for: latest, recent, new, unread, today. Set responseStyle to brief, detailed, or summary. " +
        "JSON shape: {\"intent\":\"...\",\"course\":{\"name\":\"...\",\"id\":\"...\"},\"filters\":{\"unreadOnly\":false,\"sender\":\"\"},\"query\":{\"keywords\":[],\"raw\":\"\"},\"dateRange\":{\"from\":\"\",\"to\":\"\"},\"limit\":5,\"needsRefresh\":false,\"responseStyle\":\"brief\"}";
      const planRes = await sendMessage({
        type: "OPENROUTER_CHAT",
        apiKey,
        body: {
          model: DEFAULT_MODEL,
          messages: [
            { role: "system", content: systemPromptCourseMessages },
            { role: "user", content: planPrompt }
          ],
          max_tokens: 256
        }
      });
      let plan = null;
      if (planRes?.ok && planRes?.content) {
        const raw = (planRes.content || "").trim();
        const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        try {
          plan = JSON.parse(jsonStr);
        } catch (_) {}
      }
      if (!plan || typeof plan !== "object") {
        plan = {
          intent: "GET_LAST_MESSAGE",
          course: { name: courseNameMsg, id: courseIdMsg },
          filters: { unreadOnly: false, sender: "" },
          query: { keywords: [], raw: "" },
          dateRange: { from: "", to: "" },
          limit: 1,
          needsRefresh: true,
          responseStyle: "brief"
        };
      }
      plan.course = plan.course || {};
      plan.course.name = courseNameMsg;
      plan.course.id = courseIdMsg;
      const msgRes = await sendMessage({
        type: "COURSE_MESSAGES_EXECUTE",
        plan,
        courseId: courseIdMsg,
        courseName: courseNameMsg
      });
      const responseText = msgRes?.ok ? (msgRes.responseText ?? "") : (msgRes?.error ?? "Could not load course messages. Open Blackboard and try again.");
      appendMessage("assistant", responseText, !msgRes?.ok);
      chatHistory.push({ role: "user", content: rawUserText });
      chatHistory.push({ role: "assistant", content: responseText });
      if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
      sendBtn.disabled = false;
      return;
    }
    // Global submission status: "what assignments do I need to submit of all courses?"
    if (shouldRoute("GLOBAL_SUBMISSION_STATUS", isGlobalSubmissionStatusQuestion)) {
      const subRes = await sendMessage({ type: "GET_ASSIGNMENT_SUBMISSION_STATUS_ALL", userText: text });
      loadingEl.remove();
      const responseText = subRes?.ok ? (subRes.responseText ?? "") : (subRes?.error ?? "Submission status lookup failed.");
      const optsAll = subRes?.ok && Array.isArray(subRes.assignmentItems) && subRes.assignmentItems.length > 0
        ? { assignmentItems: subRes.assignmentItems }
        : undefined;
      appendMessage("assistant", responseText, !subRes?.ok, optsAll);
      chatHistory.push({ role: "user", content: rawUserText });
      chatHistory.push({ role: "assistant", content: responseText });
      if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
      sendBtn.disabled = false;
      return;
    }
    // Submission status: "Do I have anything left to submit (for X)?" → GET_ASSIGNMENT_SUBMISSION_STATUS.
    // Queries about upcoming/next assignments always fall through to general chat (LLM + upcomingAssignments + buttons)
    // regardless of whether a course was extracted — "due next" / "any assignments next?" are upcoming queries.
    if (shouldRoute("SUBMISSION_STATUS", isSubmissionStatusQuestion)) {
      const isExplicitPendingQuery = /\b(?:pending|not\s+submitted|haven'?t\s+submitted|left\s+to\s+submit|still\s+need\s+to\s+(?:turn|submit|hand)|overdue|past\s+due|missing|falta\s+entregar|qu[eé]\s+me\s+falta|didn'?t\s+submit|which\s+ones?\s+are\s+(?:the\s+)?pending)\b/i.test(text);
      const isUpcomingQuery = /\b(?:next|upcoming|due\s+next|due\s+soon|what'?s?\s+due|anything\s+due|coming\s+up)\b/i.test(text) && !isExplicitPendingQuery;
      if (isUpcomingQuery) {
        // "any assignments next?", "what's due next?", "give me 3 due next" → fall through to general chat
        // which uses upcomingAssignments context + LLM → smart filtered answer with buttons.
      } else if (!navieCourse) {
        if (isExplicitPendingQuery) {
          // "What do I still need to submit?" / "anything overdue?" → raw all-courses pending list
          const subRes = await sendMessage({ type: "GET_ASSIGNMENT_SUBMISSION_STATUS_ALL", userText: text });
          loadingEl.remove();
          const responseText = subRes?.ok ? (subRes.responseText ?? "") : (subRes?.error ?? "Submission status lookup failed.");
          const optsAll = subRes?.ok && Array.isArray(subRes.assignmentItems) && subRes.assignmentItems.length > 0
            ? { assignmentItems: subRes.assignmentItems }
            : undefined;
          appendMessage("assistant", responseText, !subRes?.ok, optsAll);
          chatHistory.push({ role: "user", content: rawUserText });
          chatHistory.push({ role: "assistant", content: responseText });
          if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
          sendBtn.disabled = false;
          return;
        }
        // No course, no explicit pending keywords → fall through to general chat
      } else {
        // Has specific course AND it's a pending/submission query
        const subRes = await sendMessage({ type: "GET_ASSIGNMENT_SUBMISSION_STATUS", userText: text, courseHint: navieCourse });
        loadingEl.remove();
        const responseText = subRes?.ok ? (subRes.responseText ?? "") : (subRes?.error ?? "Submission status lookup failed.");
        const optsSub = subRes?.ok && Array.isArray(subRes.assignmentItems) && subRes.assignmentItems.length > 0
          ? { assignmentItems: subRes.assignmentItems }
          : undefined;
        appendMessage("assistant", responseText, !subRes?.ok, optsSub);
        chatHistory.push({ role: "user", content: rawUserText });
        chatHistory.push({ role: "assistant", content: responseText });
        if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
        sendBtn.disabled = false;
        return;
      }
    }
    // Natural exam aggregate queries (closest/last/third, follow-ups) resolved directly from cached DB dates.
    // Must NOT run when the user names a specific course — that path is handled below (GET_FINAL_DATES / GET_MIDTERM_DATES with courseId).
    const examIntent = detectExamIntentFromConversation(text);
    const singleCourseFinalExam = navieIntent === "FINAL_EXAM_DATE" || (isFinalRelatedQuery(text) && isCourseQuestion(text));
    const singleCourseMidtermExam = navieIntent === "MIDTERM_DATE" ||
      (isExamDateQuestion(text) && isCourseQuestion(text) && !isFinalRelatedQuery(text));
    if (
      !singleCourseFinalExam &&
      !singleCourseMidtermExam &&
      (navieIntent === "ALL_FINALS" ||
        navieIntent === "ALL_MIDTERMS" ||
        examIntent.hasIntent ||
        isExamFollowUpQuestion(text) ||
        isExamAggregateNaturalQuery(text) ||
        (isFinalRelatedQuery(text) && !isCourseQuestion(text)) ||
        (isMidtermRelatedQuery(text) && !isCourseQuestion(text)))
    ) {
      const kind = (navieIntent === "ALL_FINALS" ? "final" : navieIntent === "ALL_MIDTERMS" ? "midterm" : null) || examIntent.kind || examKindFromText(text);
      if (kind === "final") {
        const res = await sendMessage({ type: "GET_FINAL_DATES", userText: text });
        loadingEl.remove();
        if (res?.ok && Array.isArray(res.items)) {
          const answer = buildExamNaturalAnswer("final", res.items, text);
          appendMessage("assistant", answer);
          chatHistory.push({ role: "user", content: rawUserText });
          chatHistory.push({ role: "assistant", content: answer });
          if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
        } else {
          appendMessage("assistant", res?.error || "Could not load final exam dates right now.", true);
        }
        sendBtn.disabled = false;
        return;
      }
      if (kind === "midterm") {
        const res = await sendMessage({ type: "GET_MIDTERM_DATES", userText: text });
        loadingEl.remove();
        if (res?.ok && Array.isArray(res.items)) {
          const answer = buildExamNaturalAnswer("midterm", res.items, text);
          appendMessage("assistant", answer);
          chatHistory.push({ role: "user", content: rawUserText });
          chatHistory.push({ role: "assistant", content: answer });
          if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
        } else {
          appendMessage("assistant", res?.error || "Could not load midterm dates right now.", true);
        }
        sendBtn.disabled = false;
        return;
      }
      // If the intent clearly points to exams but kind is ambiguous, ask a natural clarification.
      if (examIntent.hasIntent) {
        loadingEl.remove();
        appendMessage("assistant", "Do you want midterm dates or final exam dates? I can also show both.", false);
        sendBtn.disabled = false;
        return;
      }
    }
    // Single final exam date for a specific course — MUST run before the all-finals check so
    // "when's my final exam of programming?" doesn't fall into the full-list path.
    // Do not gate on shouldRoute: when NLU picks COMBINED_COURSE_QUERY with high confidence, legacy fallback is off
    // and we would skip this path and answer from syllabus/calendar instead of the final-dates database.
    // When the exam-date DB has data → answer immediately and return.
    // When the DB has NO data for this course → set the fallthrough flag so COMBINED_COURSE_QUERY
    // can search announcements + syllabus + messages (the answer may be there instead).
    let examDateLookupFailed = false;
    let midtermDateLookupFailed = false;

    if (singleCourseFinalExam) {
      const syncDataFinal = await getSyncData();
      const resolvedFinal = resolveCourseForExamDateQuery(
        navieCourse || text,
        syncDataFinal.courseIdByNormalizedName,
        syncDataFinal.coursesByCourseId
      );
      if (!resolvedFinal) {
        loadingEl.remove();
        appendMessage("assistant", "I couldn't identify the course. Please specify the course name (e.g. Humanities, Microeconomics) and ask again.", true);
        sendBtn.disabled = false;
        return;
      }
      const res = await sendMessage({
        type: "GET_FINAL_DATES",
        userText: text,
        courseId: resolvedFinal.learnCourseId,
        courseName: resolvedFinal.name
      });
      if (res?.ok && res.answer) {
        loadingEl.remove();
        appendMessage("assistant", res.answer);
        chatHistory.push({ role: "user", content: rawUserText });
        chatHistory.push({ role: "assistant", content: res.answer });
        if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
        sendBtn.disabled = false;
        return;
      }
      // No data in exam DB — fall through to COMBINED_COURSE_QUERY to search announcements/syllabus/messages.
      examDateLookupFailed = true;
    }
    // Single midterm exam date for a specific course — MUST run before the all-midterms check.
    // Same fallthrough pattern as finals above.
    if (!examDateLookupFailed && singleCourseMidtermExam) {
      const syncDataMidterm = await getSyncData();
      const resolvedMidterm = resolveCourseForExamDateQuery(
        navieCourse || text,
        syncDataMidterm.courseIdByNormalizedName,
        syncDataMidterm.coursesByCourseId
      );
      if (!resolvedMidterm) {
        loadingEl.remove();
        appendMessage("assistant", "I couldn't identify the course. Please specify the course name (e.g. Humanities, Microeconomics) and ask again.", true);
        sendBtn.disabled = false;
        return;
      }
      const res = await sendMessage({
        type: "GET_MIDTERM_DATES",
        userText: text,
        courseId: resolvedMidterm.learnCourseId,
        courseName: resolvedMidterm.name
      });
      if (res?.ok && res.answer) {
        loadingEl.remove();
        appendMessage("assistant", res.answer);
        chatHistory.push({ role: "user", content: rawUserText });
        chatHistory.push({ role: "assistant", content: res.answer });
        if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
        sendBtn.disabled = false;
        return;
      }
      // No data in exam DB — fall through to COMBINED_COURSE_QUERY.
      midtermDateLookupFailed = true;
    }
    // ALL final exam dates across courses. Same as midterms but for finals.
    if (shouldRoute("FINAL_DATES_ALL", isAllFinalsQuery)) {
      const res = await sendMessage({ type: "GET_FINAL_DATES", userText: text });
      loadingEl.remove();
      if (res?.ok && res.answer) {
        appendMessage("assistant", res.answer);
        chatHistory.push({ role: "user", content: rawUserText });
        chatHistory.push({ role: "assistant", content: res.answer });
        if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
      } else {
        const errMsg = res?.error || "Could not look up final exam dates. Make sure Blackboard is open and you are logged in.";
        appendMessage("assistant", errMsg, true);
      }
      sendBtn.disabled = false;
      return;
    }
    // ALL midterms / intermediate exams across courses in current semester. MUST run BEFORE syllabus (syllabus keywords include "midterm").
    if (shouldRoute("MIDTERM_DATES_ALL", isAllMidtermsQuery)) {
      const res = await sendMessage({ type: "GET_MIDTERM_DATES", userText: text });
      loadingEl.remove();
      if (res?.ok && res.answer) {
        appendMessage("assistant", res.answer);
        chatHistory.push({ role: "user", content: rawUserText });
        chatHistory.push({ role: "assistant", content: res.answer });
        if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
      } else {
        const errMsg = res?.error || "Could not look up midterm dates. Make sure Blackboard is open and you are logged in.";
        appendMessage("assistant", errMsg, true);
      }
      sendBtn.disabled = false;
      return;
    }
    // Syllabus CONTENT and general syllabus questions now fall through to COMBINED_COURSE_QUERY below.
    // COMBINED searches syllabus (uploaded PDF first via getSyllabusStructuredPreferred) + calendar + announcements
    // together — giving comprehensive answers. This is the required behaviour for all general course queries.
    // Announcements-only Q&A (latest, list, search, count unread) → no syllabus.
    // Use ONLY when no specific course is identified: global announcement queries ("any new announcements?").
    // When a course IS identified (navieCourse set), skip this handler entirely so the query reaches
    // COMBINED_COURSE_QUERY below, which searches ALL three sources (syllabus + calendar + announcements).
    //
    // IMPORTANT: Do NOT use shouldRoute here — shouldRoute("ANNOUNCEMENTS_ONLY") returns true whenever
    // navieIntent === "ANNOUNCEMENTS" (because navieRoute === "ANNOUNCEMENTS_ONLY"), which would bypass
    // the navieCourse guard. Use the explicit pattern check instead.
    if (
      (navieIntent === "ANNOUNCEMENTS" && !navieCourse) ||
      (navieIntent !== "ANNOUNCEMENTS" &&
        (isAnnouncementsOnlyQuestion(text) || isAnnouncementsFollowUpQuestion(text)) &&
        !isCourseQuestion(text))
    ) {
      const announcementsText = normalizeAnnouncementsFollowUpQuery(text);
      const res = await sendMessage({
        type: "ANNOUNCEMENTS_ONLY_QUESTION",
        userText: announcementsText,
        courseHint: navieCourse,
        recentMessages: getRecentMessagesForSyllabusApi()
      });
      loadingEl.remove();
      if (res?.ok && res.answer) {
        appendMessage("assistant", res.answer);
        chatHistory.push({ role: "user", content: rawUserText });
        chatHistory.push({ role: "assistant", content: res.answer });
        if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
      } else {
        const errMsg = res?.error || "Could not load announcements. Open Blackboard, sync announcements, and try again.";
        appendMessage("assistant", errMsg, true);
      }
      sendBtn.disabled = false;
      return;
    }
    // Combined course search: Calendar + Announcements + Syllabus (Blackboard). Skip when user asks about assignments/due/tasks.
    // Also fires when:
    //  • LLM classified GENERAL_CHAT but extracted a course name (general course question not covered by other intents).
    //  • Exam-date DB had no record for the course (examDateLookupFailed / midtermDateLookupFailed) — the answer
    //    may be in an announcement, message, or syllabus instead.
    if (
      examDateLookupFailed ||
      midtermDateLookupFailed ||
      assignmentReroutedToCombined ||
      // DEFAULT: any course-specific question that reached this point has NOT been handled by a
      // specialized handler above (they all return early on success). Route to COMBINED so the
      // answer is always searched across syllabus + calendar + announcements.
      // Exceptions: pure calendar queries (handled below by TEMPORAL_SESSION) and assignment queries.
      (navieCourse && !isAssignmentQuery(text) && navieIntent !== "CALENDAR_TEMPORAL") ||
      // Legacy fallback: pattern-based routing (no LLM course extraction available).
      shouldRoute("COMBINED_COURSE_QUERY", function (t) {
        if (!isCourseQuestion(t) || isAssignmentQuery(t)) return false;
        if (isFinalRelatedQuery(t) || isExamDateQuestion(t)) return false;
        return true;
      })
    ) {
      const res = await sendMessage({
        type: "COMBINED_COURSE_QUERY",
        userText: text,
        courseHint: navieCourse,
        recentMessages: getRecentMessagesForSyllabusApi()
      });
      loadingEl.remove();
      if (res?.ok && res.answer) {
        appendMessage("assistant", res.answer);
        chatHistory.push({ role: "user", content: rawUserText });
        chatHistory.push({ role: "assistant", content: res.answer });
        if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
      } else {
        const errMsg = res?.error || "Could not answer. Specify the course name (e.g. Microeconomics, Cost Accounting) and try again.";
        appendMessage("assistant", errMsg, !isNonCriticalCourseResolutionMessage(errMsg));
      }
      sendBtn.disabled = false;
      return;
    }
    // WHEN/temporal questions (when is session X, what classes tomorrow) → calendar only; continue to normal flow.
    if (shouldRoute("TEMPORAL_SESSION", isTemporalSessionQuestion)) {
      const calendarAnswer = await answerCalendarTemporalQuery(text, { forceCalendar: navieIntent === "CALENDAR_TEMPORAL" });
      if (calendarAnswer) {
        loadingEl.remove();
        appendMessage("assistant", calendarAnswer);
        chatHistory.push({ role: "user", content: rawUserText });
        chatHistory.push({ role: "assistant", content: calendarAnswer });
        if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
        sendBtn.disabled = false;
        return;
      }
      // Fallback to normal flow with calendar context if deterministic path could not answer.
    }

    const ctx = typeof window.TimeContext !== "undefined" ? window.TimeContext.getNowContext() : null;
    const timeBlock =
      ctx && typeof window.TimeContext.buildTimeContextBlock === "function"
        ? window.TimeContext.buildTimeContextBlock(ctx)
        : "";

    let syncData = await getSyncData();
    const expandedCalendarProbe = expandShortCalendarQueryForSidepanel(text);
    const isCalendarQ =
      navieIntent === "CALENDAR_TEMPORAL" ||
      (typeof window.Calendar !== "undefined" &&
        (window.Calendar.isCalendarQuery(text) ||
          (!!expandedCalendarProbe && window.Calendar.isCalendarQuery(expandedCalendarProbe))));
    const resolvedCourse = isCalendarQ ? null : resolveCourseForPrompt(navieCourse || text, syncData.courseIdByNormalizedName, syncData.coursesByCourseId);

    if (isSyllabusLinkRequest(text) && resolvedCourse) {
      loadingEl.remove();
      const syllabusUrl = buildSyllabusUrlForCourse(resolvedCourse.learnCourseId);
      appendMessage("assistant", "", false, {
        syllabusLink: true,
        url: syllabusUrl,
        courseName: resolvedCourse.name,
        isEnglish: isEnglishQuery(text)
      });
      chatHistory.push({ role: "user", content: rawUserText });
      chatHistory.push({ role: "assistant", content: "Here is the syllabus for " + resolvedCourse.name + ". " + syllabusUrl });
      if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
      sendBtn.disabled = false;
      return;
    }

    if (navieIntent === "MIDTERM_DATE" || navieIntent === "ALL_MIDTERMS" || isMidtermRelatedQuery(text)) {
      const cacheRes = await sendMessage({ type: "GET_MIDTERM_DATES_CACHE" });
      const cacheItems = cacheRes?.cache?.items;
      if (!cacheItems || !Array.isArray(cacheItems) || cacheItems.length === 0) {
        loadingEl.remove();
        appendMessage(
          "assistant",
          "Please wait a few seconds for midterm dates to load. You can open Options > Midterm dates and click Refresh, or try your question again in a moment."
        );
        chatHistory.push({ role: "user", content: rawUserText });
        chatHistory.push({
          role: "assistant",
          content: "Please wait a few seconds for midterm dates to load. You can open Options > Midterm dates and click Refresh, or try your question again in a moment."
        });
        if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
        sendMessage({ type: "GET_MIDTERM_DATES" }).catch(() => {});
        sendBtn.disabled = false;
        return;
      }
    }
    if (navieIntent === "FINAL_EXAM_DATE" || navieIntent === "ALL_FINALS" || isFinalRelatedQuery(text)) {
      const cacheRes = await sendMessage({ type: "GET_FINAL_DATES_CACHE" });
      const cacheItems = cacheRes?.cache?.items;
      if (!cacheItems || !Array.isArray(cacheItems) || cacheItems.length === 0) {
        loadingEl.remove();
        appendMessage(
          "assistant",
          "Please wait a few seconds for final exam dates to load. You can open Options > Final dates and click Refresh, or try your question again in a moment."
        );
        chatHistory.push({ role: "user", content: rawUserText });
        chatHistory.push({
          role: "assistant",
          content: "Please wait a few seconds for final exam dates to load. You can open Options > Final dates and click Refresh, or try your question again in a moment."
        });
        if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
        sendMessage({ type: "GET_FINAL_DATES" }).catch(() => {});
        sendBtn.disabled = false;
        return;
      }
    }

    const calendarBlock =
      (!syncPrefs.calendar || isAssignmentOnlyQuery(text) || (navieIntent === "ASSIGNMENT_GRADE" && !navieCourse)) ? "" : await getCalendarContextForUserQuery(text, { forceCalendar: navieIntent === "CALENDAR_TEMPORAL" });

    const { syllabi, coursesByCourseId, courseIdByNormalizedName, coursesList, gradebookColumns, gradebookByCourseId } = syncData;
    const assignmentsBlock = syncPrefs.gradebook ? getAssignmentsContextBlock(gradebookByCourseId) : "[ASSIGNMENTS_CONTEXT]\nAssignment data is disabled in settings.\n[/ASSIGNMENTS_CONTEXT]";
    const midtermBlock = (navieIntent === "MIDTERM_DATE" || navieIntent === "ALL_MIDTERMS" || isMidtermRelatedQuery(text)) ? await getMidtermDatesContextBlock() : "";
    const finalBlock = (navieIntent === "FINAL_EXAM_DATE" || navieIntent === "ALL_FINALS" || isFinalRelatedQuery(text)) ? await getFinalDatesContextBlock() : "";

    const restOfPrompt = buildSystemPrompt(
      syncPrefs.syllabi ? syllabi : [],
      coursesByCourseId,
      coursesList,
      syncPrefs.gradebook ? gradebookColumns : [],
      syncPrefs.gradebook ? gradebookByCourseId : {},
      courseIdByNormalizedName,
      resolvedCourse,
      ctx,
      text,
      { route: navieRoute }
    );
    let systemPrompt = timeBlock ? timeBlock + "\n\n" : "";
    if (calendarBlock) systemPrompt += calendarBlock + "\n\n";
    systemPrompt += assignmentsBlock + "\n\n";
    if (midtermBlock) systemPrompt += midtermBlock + "\n\n";
    if (finalBlock) systemPrompt += finalBlock + "\n\n";
    systemPrompt += restOfPrompt;
    if (isSyllabusLinkRequest(text) && resolvedCourse) {
      const syllabusUrl = buildSyllabusUrlForCourse(resolvedCourse.learnCourseId);
      systemPrompt =
        "[SYLLABUS_LINK]\nThe user asked for the syllabus link. Course: " +
        resolvedCourse.name +
        ". URL to return: " +
        syllabusUrl +
        "\nReply ONLY with this URL and the course name. Never say the URL was not found.\n[/SYLLABUS_LINK]\n\n" +
        systemPrompt;
    }

    const recentHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES);
    const messages = [
      { role: "system", content: systemPrompt },
      ...recentHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: rawUserText }
    ];

    const res = await sendMessage({
      type: "OPENROUTER_CHAT",
      apiKey,
      body: { model: DEFAULT_MODEL, messages, max_tokens: 512 }
    });

    loadingEl.remove();

    if (res == null || res === undefined) {
      appendMessage("assistant", "No response received. Check that the extension is active and try again.", true);
      return;
    }
    if (!res.ok) {
      const errText = res?.errorText || "";
      appendMessage("assistant", "Error connecting to the AI: " + (res?.status || "") + " " + errText.slice(0, 200), true);
      return;
    }

    const content = (res?.content ?? "").trim() || "(No response)";
    const opts = (isAssignmentOnlyQuery(text) || (navieIntent === "ASSIGNMENT_GRADE" && !navieCourse))
      ? { upcomingAssignments: getUpcomingAssignmentsAll(gradebookByCourseId, 20) }
      : {};
    appendMessage("assistant", content, false, opts);
    chatHistory.push({ role: "user", content: rawUserText });
    chatHistory.push({ role: "assistant", content });
    if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES * 2) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES * 2);
  } catch (e) {
    loadingEl.remove();
    appendMessage("assistant", "Error: " + (e?.message || e), true);
  } finally {
    sendBtn.disabled = false;
  }
}

(async function init() {
  await loadThemePreference();
  updateExamDatesStatusDot();

  // Consent gate: must be accepted before the app runs.
  // Runs before the splash timeout so the overlay appears on top of the splash screen.
  await ensureConsent();
  await checkSurveyGateStatus();

  setTimeout(function () {
    const splash = document.getElementById("splashScreen");
    const app = document.querySelector(".app");
    if (splash) splash.classList.add("splash-done");
    if (app) {
      app.classList.remove("app-hidden");
      app.classList.add("app-visible");
    }
    setTimeout(function () {
      if (splash) splash.style.display = "none";
    }, 450);
    refreshUpcomingWidget();
    sendMessage({ type: "GET_USER_PROFILE" }).then(function (res) {
      const name = res?.profile?.fullName;
      const welcomeText = name ? "Welcome " + name + ", how can I help you?" : "Welcome, how can I help you?";
      appendMessage("assistant", welcomeText);
    }).catch(function () {
      appendMessage("assistant", "Welcome, how can I help you?");
    });
  }, 2500);

  const key = await getApiKey();
  if (key) {
    apiKeyInput.placeholder = "•••••••• (ya guardada)";
  }

  await refreshTimeContext();
  startTimeContextRefreshInterval();

  const widgetAlreadyLoaded = await hasWidgetDataCached();
  if (widgetAlreadyLoaded && upcomingWidgetLoading && upcomingWidgetToggle) {
    upcomingWidgetLoading.classList.add("hidden");
    upcomingWidgetLoading.setAttribute("aria-hidden", "true");
    upcomingWidgetToggle.classList.remove("hidden");
    upcomingWidgetToggle.setAttribute("aria-hidden", "false");
  }

  // Sincronización automática al abrir: solo cursos (syllabi se piden bajo demanda)
  if (loadingOverlay) {
    loadingOverlay.classList.remove("hidden");
    loadingOverlay.title = "Syncing courses...";
  }
  let coursesOk = false;
  let coursesCount = 0;
  let coursesLog = [];
  let userIdentityLogLine = "";
  try {
    const [coursesRes, userIdRes] = await Promise.all([
      sendMessage({ type: "SYNC_COURSES" }),
      sendMessage({ type: "GET_CURRENT_USER_ID" })
    ]);
    coursesOk = coursesRes?.ok === true;
    coursesCount = coursesRes?.count ?? 0;
    coursesLog = coursesRes?.log || [];
    if (userIdRes?.ok && userIdRes.userId) {
      userIdentityLogLine = "[Start] User ID obtained: " + userIdRes.userId;
    } else {
      userIdentityLogLine = "[Start] User ID not obtained. Open Blackboard in a tab and make sure you are logged in.";
    }
    if (!coursesOk && coursesRes?.error) {
      setSyncStatus("Courses error: " + coursesRes.error);
      const errLogLines = userIdentityLogLine ? [userIdentityLogLine, ...coursesLog] : coursesLog;
      renderSyncLog(errLogLines);
      if (syncLogPre) syncLogPre.dataset.syncLines = errLogLines.join("\n");
    }
  } catch (e) {
    setSyncStatus("Error syncing courses: " + (e?.message || e));
    userIdentityLogLine = "[Start] User ID not obtained. Open Blackboard in a tab and make sure you are logged in.";
  }

  // On first open (and every open): sync assignments first, then announcements — no click needed
  if (coursesOk && loadingOverlay) loadingOverlay.title = "Syncing assignments...";
  let gradebookOk = false;
  if (coursesOk) {
    try {
      const gradebookRes = await sendMessage({ type: "SYNC_GRADEBOOK_ONLY" });
      gradebookOk = gradebookRes?.ok === true;
      if (!gradebookOk && gradebookRes?.error) {
        setSyncStatus("Courses OK. Gradebook: " + (gradebookRes.error || "error"));
      }
    } catch (e) {
      setSyncStatus("Courses OK. Assignments: " + (e?.message || e));
    }
  }

  await refreshUpcomingWidget();

  // Start populating messages widget cache in background (same pattern as assignments; no UI wait).
  sendMessage({ type: "SYNC_WIDGET_MESSAGES" }).catch(() => {});

  if (loadingOverlay) loadingOverlay.title = "Syncing announcements...";
  try {
    const annRes = await sendMessage({ type: "SYNC_ANNOUNCEMENTS" });
    if (annRes?.ok) {
      if (announcementsListContainer) renderAnnouncementsList();
      if (upcomingWidgetMode === "announcements") refreshUpcomingWidget();
      maybeShowRequiredAnnouncementGate(annRes.data || []);
    }
  } catch (_) {}

  if (upcomingWidgetLoading) upcomingWidgetLoading.classList.add("hidden");
  if (upcomingWidgetToggle) {
    upcomingWidgetToggle.classList.remove("hidden");
    upcomingWidgetToggle.setAttribute("aria-hidden", "false");
  }
  if (upcomingWidgetLoading) upcomingWidgetLoading.setAttribute("aria-hidden", "true");

  if (loadingOverlay) loadingOverlay.classList.add("hidden");

  if (coursesOk) {
    setSyncStatus(
      gradebookOk
        ? "Done (" + coursesCount + " courses, assignments updated). Ask for a syllabus or about assignments."
        : "Done (" + coursesCount + " courses). Ask for a course syllabus or click «Sync syllabi»."
    );
    const logLines = userIdentityLogLine ? [userIdentityLogLine, ...coursesLog] : coursesLog;
    if (logLines.length) {
      renderSyncLog(logLines);
      if (syncLogPre) syncLogPre.dataset.syncLines = logLines.join("\n");
    }
  } else if (userIdentityLogLine) {
    renderSyncLog([userIdentityLogLine, ...coursesLog]);
    if (syncLogPre) syncLogPre.dataset.syncLines = [userIdentityLogLine, ...coursesLog].join("\n");
  }
  await refreshTimeContext();

  sendMessage({ type: "SYNC_USER_PROFILE" }).catch(() => {});

  // Detect which syllabi are available / missing for Q1 and Q2 courses (runs in background, does not block)
  if (coursesOk) {
    sendMessage({ type: "CHECK_SYLLABUS_AVAILABILITY" }).catch(() => {});
  }
  warmExamDateCachesIfNeeded().catch(() => {});

  // Actualización en background cada minuto: assignments, announcements y mensajes del widget (sin bloquear la UI)
  setInterval(() => {
    Promise.all([
      sendMessage({ type: "SYNC_GRADEBOOK_ONLY" }).catch(() => {}),
      sendMessage({ type: "SYNC_ANNOUNCEMENTS" }).catch(() => {}),
      sendMessage({ type: "SYNC_WIDGET_MESSAGES" }).catch(() => {})
    ]).then(() => {
      refreshUpcomingWidget();
    });
  }, 60 * 1000);
})();
