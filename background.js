import {
  parseSyllabusHtml,
  classifySyllabusQuestionWithContext,
  buildEffectiveSyllabusUserText,
  searchSyllabusStructure,
  buildFullSyllabusContext
} from "./syllabusIntelligence.js";
import { isSyllabusUnavailable, setSyllabusStatus, getSyllabusStatus, getSyllabusStatusFromFetch, getAllSyllabusStatuses, getUploadedSyllabus, setUploadedSyllabus, removeUploadedSyllabus, getRelevantChunks, chunkSyllabusText, deletePdfBlob, parseSessionsFromText, parseSyllabusFromText, toStructuredFormat, SyllabusStatus } from "./syllabusManager.js";
import { initUserIdentity, getCurrentUserId, clearUserIdentity } from "./userIdentity.js";
import { getClassifiedCourses, currentSemester } from "./src/courseClassifier/index.js";
import { gatherMidtermEvidence, gatherMidtermEvidenceStructured } from "./midtermDates.js";
import { detectMidtermSession, resolveMidtermSession } from "./midtermSessionDetector.js";
import { enrichMidtermWithCalendar, enrichFinalWithCalendar } from "./calendarMidtermEnricher.js";
import { resolveFinalSession } from "./finalExamSessionDetector.js";
import { getAttendanceForCourse } from "./attendance.js";
import { runCombinedCourseQuery } from "./courseQueryOrchestrator.js";
import { getAssignmentGrade, isAllGradesForCourseQuery, resolveCourseByMention, buildGradeItemList } from "./gradeLookupService.js";
import { getOrFetchConversations, executePlan, formatResponse as formatCourseMessagesResponse } from "./courseMessagesService.js";
import { findBestMatch } from "./textMatch.js";
import { initUpdateChecker, handleUpdateAlarm, checkForUpdate, fetchLatestRelease, compareVersions, getLocalVersion } from "./updateManager.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  initUpdateChecker();
});

/**
 * Auto-cache syllabi: when the user naturally navigates to a ltitools.ie.edu ESyllabus page
 * (by clicking on a course syllabus in Blackboard), the browser's session is set correctly.
 * We immediately fetch the HTML and cache it so future queries work without any LTI round-trip.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab?.url || !tab.url.includes("ltitools.ie.edu/ESyllabusLTI")) return;

  try {
    // Fetch the page HTML while the ltitools session is freshly set for this course
    const htmlRes = await fetchWithRetry(tab.url, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "text/html,application/xhtml+xml,*/*" }
    }, FETCH_TIMEOUT_MS);
    if (!htmlRes.ok) return;
    const html = await htmlRes.text();
    const structured = parseSyllabusHtml(html);
    if (!structured?.courseTitle || !structured.rawText) return;

    // Correlate the fetched title with a known courseId from storage
    const [syllabiData, coursesData] = await Promise.all([
      chrome.storage.local.get("syllabi"),
      chrome.storage.local.get(REGISTRY_KEYS.coursesList)
    ]);
    const syllabi = syllabiData.syllabi || [];
    const coursesList = coursesData[REGISTRY_KEYS.coursesList] || [];

    // Try syllabi list first (has courseId directly), then coursesList
    const match =
      syllabi.find((s) => syllabusCourseTitleMatches(structured.courseTitle, s.courseName)) ||
      coursesList.find((c) => syllabusCourseTitleMatches(structured.courseTitle, c.name));

    const cid = String(match?.courseId || match?.learnCourseId || "").trim();
    if (!cid) {
      console.log("[Syllabus] Tab auto-cache: could not find courseId for title '" + structured.courseTitle + "'");
      return;
    }

    const cacheKey = syllabusParsedCacheKey(cid);
    syllabusProcessedCache.set(cacheKey, { structured, timestamp: Date.now() });
    await setSyllabusPersistentCache(cid, structured);
    setSyllabusStatus(cid, SyllabusStatus.AVAILABLE).catch(() => {});
    console.log("[Syllabus] Tab auto-cached: '" + structured.courseTitle + "' → courseId " + cid);
  } catch (e) {
    console.warn("[Syllabus] Tab auto-cache failed:", e?.message || e);
  }
});

// ——— Syllabus HTML fetch (LTI flow) ———
const LTI_LAUNCH_BASE = "https://blackboard.ie.edu";
const LTI_LAUNCH_PATH = "/webapps/blackboard/execute/blti/launchPlacement";
const LTI_PLACEMENT_ID = "_20_1";
const SYLLABUS_INDEX_BASE = "https://ltitools.ie.edu/ESyllabusLTI/index";
const FETCH_TIMEOUT_MS = 25000;
const FETCH_RETRIES = 1;
const RETRY_BACKOFF_MS = 800;

const MIDTERM_DATES_CACHE_KEY = "midtermDatesCache";
const MIDTERM_SESSIONS_CACHE_KEY = "midtermSessionsCache";
const FINAL_DATES_CACHE_KEY = "finalDatesCache";
const MIDTERM_DATES_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const FINAL_DATES_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const BLUE_SURVEYS_BASE = "https://iesurveys.bluera.com/ieBlueConnector";
const BLUE_SURVEYS_CONSUMER_ID = "CWN1RxHsa4vY9b2QgVC7jQ==";

const LAST_ACTIVITY_KEY = "navieLastActivity";
const DATA_EXPIRY_DAYS = 90;
const DAILY_CLEANUP_ALARM = "dailyDataCleanup";
const MIDTERM_REFRESH_HOURS_LOCAL = [9, 13, 17, 21];

function courseHasMidtermDateInDb(it) {
  const d = it?.midterm_date;
  return d != null && String(d).trim() !== "";
}

function courseHasFinalDateInDb(it) {
  const d = it?.final_date;
  return d != null && String(d).trim() !== "";
}

/** YYYY-MM-DD -> "May 15, 2026"; passthrough if not ISO date. */
function formatExamDateEnglish(ymd, time, tz) {
  if (!ymd || typeof ymd !== "string") return "";
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    let s = ymd.trim();
    if (time) s += " at " + time;
    if (tz) s += " " + tz;
    return s;
  }
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  const d = new Date(Date.UTC(y, mo, day));
  if (Number.isNaN(d.getTime())) return ymd;
  let s = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  if (time) s += " at " + time;
  if (tz) s += " " + tz;
  return s;
}

function formatFinalExamLineEnglish(it) {
  const sessionPart = it.final_session != null ? "Session " + it.final_session : null;
  const datePart = it.final_date
    ? formatExamDateEnglish(String(it.final_date).trim(), it.final_time || "", it.timezone || "")
    : "";
  const bits = [];
  if (sessionPart) bits.push(sessionPart);
  if (datePart) bits.push(datePart);
  return it.courseName + ": " + (bits.length ? bits.join(", ") : "—");
}

function formatMidtermExamLineEnglish(it) {
  const sessionPart = it.midterm_session != null ? "Session " + it.midterm_session : null;
  const datePart = it.midterm_date
    ? formatExamDateEnglish(String(it.midterm_date).trim(), it.midterm_time || "", it.timezone || "")
    : "";
  const bits = [];
  if (sessionPart) bits.push(sessionPart);
  if (datePart) bits.push(datePart);
  return it.courseName + ": " + (bits.length ? bits.join(", ") : "—");
}

/**
 * Full-list exam replies: always English. Section 1 = courses with a stored exam date;
 * section 2 = courses with no date in the database (name only, optional session hint).
 */
function buildDeterministicFinalExamReplyEnglish(filteredItems) {
  const withDate = filteredItems.filter(courseHasFinalDateInDb);
  const withoutDate = filteredItems.filter((it) => !courseHasFinalDateInDb(it));
  const h1 = "EXAMS WITH A DATE IN THE DATABASE";
  const h2 = "NO EXAM DATE WAS FOUND IN THE DATABASE FOR THE FOLLOWING COURSES";
  const footer =
    "For courses in the second list, check your syllabus or Blackboard Options > Final dates (Refresh if needed).";
  const parts = [h1, ""];
  if (withDate.length) {
    parts.push(...withDate.map(formatFinalExamLineEnglish));
  } else {
    parts.push("(No courses in this list have a final exam date stored yet.)");
  }
  parts.push("", h2, "");
  if (withoutDate.length) {
    for (const it of withoutDate) {
      const sess = it.final_session != null ? " (Session " + it.final_session + ")" : "";
      parts.push((it.courseName || "?") + sess);
    }
  } else {
    parts.push("(None — every course above has a date in the database.)");
  }
  parts.push("", footer);
  return parts.join("\n");
}

function buildDeterministicMidtermExamReplyEnglish(filteredItems) {
  const withDate = filteredItems.filter(courseHasMidtermDateInDb);
  const withoutDate = filteredItems.filter((it) => !courseHasMidtermDateInDb(it));
  const h1 = "MIDTERM / INTERMEDIATE EXAMS WITH A DATE IN THE DATABASE";
  const h2 = "NO MIDTERM DATE WAS FOUND IN THE DATABASE FOR THE FOLLOWING COURSES";
  const footer =
    "For courses in the second list, check your syllabus or Blackboard Options > Midterm dates (Refresh if needed).";
  const parts = [h1, ""];
  if (withDate.length) {
    parts.push(...withDate.map(formatMidtermExamLineEnglish));
  } else {
    parts.push("(No courses in this list have a midterm date stored yet.)");
  }
  parts.push("", h2, "");
  if (withoutDate.length) {
    for (const it of withoutDate) {
      const sess = it.midterm_session != null ? " (Session " + it.midterm_session + ")" : "";
      parts.push((it.courseName || "?") + sess);
    }
  } else {
    parts.push("(None — every course above has a midterm date in the database.)");
  }
  parts.push("", footer);
  return parts.join("\n");
}

/** One-course final answer: plain English, no section headers. */
function buildSingleFinalExamAnswerEnglish(it) {
  const name = it?.courseName || "This course";
  if (courseHasFinalDateInDb(it)) {
    const when = formatExamDateEnglish(String(it.final_date).trim(), it.final_time || "", it.timezone || "");
    const sess = it.final_session != null ? "Session " + it.final_session : null;
    if (sess && when) {
      return (
        "Your final exam for " +
        name +
        " is on " +
        when +
        " (" +
        sess +
        "). Dates come from the extension database (calendar sync). If anything looks wrong, use Options > Final dates."
      );
    }
    return (
      "Your final exam for " +
        name +
        " is on " +
        when +
        ". Dates come from the extension database. Use Options > Final dates if you need to refresh."
    );
  }
  if (it?.final_session != null) {
    return (
      "Your final exam for " +
        name +
        " is listed as Session " +
        it.final_session +
        ", but no calendar date is stored in the database yet. Open Blackboard Options > Final dates and click Refresh, or check your syllabus."
    );
  }
  return (
    "No final exam date or session was found in the database for " +
      name +
      ". Open Options > Final dates (Refresh) or check your syllabus."
  );
}

function buildSingleMidtermExamAnswerEnglish(it) {
  const name = it?.courseName || "This course";
  if (courseHasMidtermDateInDb(it)) {
    const when = formatExamDateEnglish(String(it.midterm_date).trim(), it.midterm_time || "", it.timezone || "");
    const sess = it.midterm_session != null ? "Session " + it.midterm_session : null;
    if (sess && when) {
      return (
        "Your midterm for " +
        name +
        " is on " +
        when +
        " (" +
        sess +
        "). Dates come from the extension database. Use Options > Midterm dates if you need to refresh."
      );
    }
    return (
      "Your midterm for " + name + " is on " + when + ". Use Options > Midterm dates if you need to refresh."
    );
  }
  if (it?.midterm_session != null) {
    return (
      "Your midterm for " +
        name +
        " is listed as Session " +
        it.midterm_session +
        ", but no calendar date is stored in the database yet. Open Options > Midterm dates and click Refresh, or check your syllabus."
    );
  }
  return (
    "No midterm date or session was found in the database for " +
      name +
      ". Open Options > Midterm dates (Refresh) or check your syllabus."
  );
}

function getNextMidtermRefreshTime() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();
  for (const h of MIDTERM_REFRESH_HOURS_LOCAL) {
    const next = new Date(year, month, date, h, 0, 0, 0);
    if (next > now) return next.getTime();
  }
  const tomorrow = new Date(year, month, date + 1, MIDTERM_REFRESH_HOURS_LOCAL[0], 0, 0, 0);
  return tomorrow.getTime();
}

const syllabusFetchInFlight = new Map();

function getLaunchUrl(courseId) {
  return `${LTI_LAUNCH_BASE}${LTI_LAUNCH_PATH}?blti_placement_id=${LTI_PLACEMENT_ID}&course_id=${encodeURIComponent(courseId)}`;
}

function getAttr(tagStr, name) {
  const re = new RegExp("\\s" + name + "\\s*=\\s*[\"']([^\"']*)[\"']", "i");
  const m = tagStr.match(re);
  return m ? m[1].trim() : null;
}

function parseBltiLaunchForm(html, baseUrl) {
  const formBlock = html.match(/<\s*form[^>]*?(?:id|name)\s*=\s*["']bltiLaunchForm["'][^>]*>([\s\S]*?)<\s*\/\s*form\s*>/i);
  if (!formBlock) return null;
  const formOpen = formBlock[0].match(/^<\s*form[^>]*>/)?.[0] ?? "";
  const inner = formBlock[1];
  let action = getAttr(formOpen, "action");
  if (!action) return null;
  if (action.startsWith("/")) action = baseUrl.replace(/\/$/, "") + action;
  else if (!/^https?:\/\//i.test(action)) action = baseUrl.replace(/\/?$/, "/") + action.replace(/^\//, "");

  const pairs = [];
  const inputRe = /<\s*input\s+([^>]+)>/gi;
  let m;
  while ((m = inputRe.exec(inner)) !== null) {
    const attrs = m[1];
    const name = getAttr(attrs, "name");
    if (!name) continue;
    const type = (getAttr(attrs, "type") || "text").toLowerCase();
    if (type === "radio" || type === "checkbox") {
      if (!/^\s*checked\s/i.test(attrs) && !/checked\s*=\s*["'][^"']*["']/i.test(attrs)) continue;
    }
    const value = getAttr(attrs, "value") ?? "";
    pairs.push([name, value]);
  }
  const textareaRe = /<\s*textarea\s+([^>]*)>([\s\S]*?)<\s*\/\s*textarea\s*>/gi;
  while ((m = textareaRe.exec(inner)) !== null) {
    const name = getAttr(m[1], "name");
    if (!name) continue;
    pairs.push([name, (m[2] || "").trim()]);
  }
  const selectRe = /<\s*select\s+([^>]*)>([\s\S]*?)<\s*\/\s*select\s*>/gi;
  while ((m = selectRe.exec(inner)) !== null) {
    const name = getAttr(m[1], "name");
    if (!name) continue;
    const opts = m[2];
    const selected = opts.match(/<\s*option[^>]*\sselected\s[^>]*value\s*=\s*["']([^"']*)["']/i)
      || opts.match(/<\s*option[^>]*value\s*=\s*["']([^"']*)["'][^>]*\sselected/i);
    const val = selected ? selected[1] : (opts.match(/<\s*option[^>]*value\s*=\s*["']([^"']*)["']/i)?.[1] ?? "");
    pairs.push([name, val]);
  }
  const body = pairs.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
  return { action, body, inputCount: pairs.length };
}

function parseFormInnerToBody(inner, baseUrl) {
  const pairs = [];
  const inputRe = /<\s*input\s+([^>]+)>/gi;
  let m;
  while ((m = inputRe.exec(inner)) !== null) {
    const attrs = m[1];
    const name = getAttr(attrs, "name");
    if (!name) continue;
    const type = (getAttr(attrs, "type") || "text").toLowerCase();
    if (type === "radio" || type === "checkbox") {
      if (!/checked/i.test(attrs)) continue;
    }
    pairs.push([name, getAttr(attrs, "value") ?? ""]);
  }
  const textareaRe = /<\s*textarea\s+([^>]*)>([\s\S]*?)<\s*\/\s*textarea\s*>/gi;
  while ((m = textareaRe.exec(inner)) !== null) {
    const name = getAttr(m[1], "name");
    if (name) pairs.push([name, (m[2] || "").trim()]);
  }
  const selectRe = /<\s*select\s+([^>]*)>([\s\S]*?)<\s*\/\s*select\s*>/gi;
  while ((m = selectRe.exec(inner)) !== null) {
    const name = getAttr(m[1], "name");
    if (!name) continue;
    const opts = m[2];
    const selected = opts.match(/<\s*option[^>]*\sselected\s[^>]*value\s*=\s*["']([^"']*)["']/i) || opts.match(/<\s*option[^>]*value\s*=\s*["']([^"']*)["'][^>]*\sselected/i);
    pairs.push([name, selected ? selected[1] : (opts.match(/<\s*option[^>]*value\s*=\s*["']([^"']*)["']/i)?.[1] ?? "")]);
  }
  return pairs;
}

function parseAnyLtiLaunchForm(html, baseUrl) {
  const formRe = /<\s*form\s+([^>]+)>([\s\S]*?)<\s*\/\s*form\s*>/gi;
  let fm;
  while ((fm = formRe.exec(html)) !== null) {
    const open = fm[1];
    const inner = fm[2];
    if (!/oauth_consumer_key|lti_message_type|blti|launch/i.test(inner)) continue;
    let action = getAttr(open, "action");
    if (!action) continue;
    if (action.startsWith("/")) action = baseUrl.replace(/\/$/, "") + action;
    else if (!/^https?:\/\//i.test(action)) action = baseUrl.replace(/\/?$/, "/") + action.replace(/^\//, "");
    const pairs = parseFormInnerToBody(inner, baseUrl);
    if (pairs.length === 0) continue;
    const body = pairs.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
    return { action, body, inputCount: pairs.length };
  }
  return null;
}

function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const opts = { ...options, signal: ctrl.signal };
  return fetch(url, opts).finally(() => clearTimeout(t));
}

function normalizeBlueToolUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    if (/^https?:\/\//i.test(raw)) return raw;
    return new URL(raw, BLUE_SURVEYS_BASE + "/").toString();
  } catch (_) {
    return null;
  }
}

async function fetchBlueUltraSetting(userId, language = "en-US") {
  const uid = String(userId || "").trim();
  if (!uid) {
    return { ok: false, error: "userId required", locked: false, setting: null };
  }
  const lang = String(language || "en-US").trim() || "en-US";
  const url =
    `${BLUE_SURVEYS_BASE}//api/blackboard/GetBlueUltraSetting` +
    `?userId=${encodeURIComponent(uid)}&language=${encodeURIComponent(lang)}`;
  let res;
  try {
    res = await fetchWithRetry(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
        consumerid: BLUE_SURVEYS_CONSUMER_ID
      }
    }, FETCH_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, error: e?.message || "Survey endpoint unreachable.", locked: false, setting: null };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "Survey session not authenticated.", notAuthenticated: true, locked: false, setting: null, status: res.status };
  }
  if (!res.ok) {
    const rawErr = await res.text().catch(() => "");
    return { ok: false, error: "Survey endpoint HTTP " + res.status + (rawErr ? " " + rawErr.slice(0, 160) : ""), locked: false, setting: null, status: res.status };
  }
  let setting = null;
  try {
    setting = await res.json();
  } catch (_) {
    return { ok: false, error: "Survey endpoint returned invalid JSON.", locked: false, setting: null, status: res.status };
  }
  const toolUrl = normalizeBlueToolUrl(setting?.ToolUrl);
  const locked = setting?.HasTasks === true && !!toolUrl;
  return {
    ok: true,
    locked,
    setting: {
      LoginFOHeaderText: setting?.LoginFOHeaderText ?? null,
      LoginButtonText: setting?.LoginButtonText ?? null,
      LoginPromptEnabled: setting?.LoginPromptEnabled === true,
      LoginPromptType: Number(setting?.LoginPromptType || 0),
      HasTasks: setting?.HasTasks === true,
      ToolUrl: toolUrl
    }
  };
}

async function fetchWithRetry(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  let lastErr;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.status >= 500 && attempt < FETCH_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < FETCH_RETRIES) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    }
  }
  throw lastErr;
}

function isLoginOrSsoPage(html) {
  if (!html || typeof html !== "string") return false;
  const lower = html.toLowerCase();
  if (!/login|saml|cas|sign\s*in|iniciar\s*sesi[oó]n|session\s*expired/i.test(lower)) return false;
  if (lower.includes("bltilaunchform") || lower.includes("oauth_consumer_key") || lower.includes("lti_message_type")) return false;
  return (lower.includes("type=\"password\"") || lower.includes("type='password'")) || (lower.includes("id=\"password\"") || lower.includes("name=\"password\""));
}

async function fetchSyllabusForCourse(courseId) {
  const courseIdStr = (courseId || "").toString().trim();
  if (!courseIdStr) return { ok: false, error: "courseId requerido", details: {} };

  const launchUrl = getLaunchUrl(courseIdStr);
  const details = { courseId: courseIdStr, status: null, url: null };

  try {
    console.log("[Syllabus] GET launchUrl:", launchUrl);
    const getRes = await fetchWithRetry(launchUrl, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "text/html,application/xhtml+xml,*/*" }
    });
    details.status = getRes.status;
    details.url = getRes.url;
    console.log("[Syllabus] GET status:", getRes.status, "finalUrl:", getRes.url);

    if (!getRes.ok) {
      const text = await getRes.text().catch(() => "");
      if (getRes.status === 401 || getRes.status === 403 || isLoginOrSsoPage(text)) {
        return { ok: false, error: "User not authenticated on Blackboard", details };
      }
      return { ok: false, error: "GET launchPlacement failed: " + getRes.status, details };
    }

    const html = await getRes.text();
    let parsed = parseBltiLaunchForm(html, LTI_LAUNCH_BASE);
    if (!parsed) parsed = parseAnyLtiLaunchForm(html, LTI_LAUNCH_BASE);
    if (!parsed) return { ok: false, error: "Form bltiLaunchForm no encontrado", details };
    console.log("[Syllabus] Form parsed, action:", parsed.action, "inputs:", parsed.inputCount);

    const postRes = await fetchWithRetry(parsed.action, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml,*/*"
      },
      body: parsed.body
    });
    details.postStatus = postRes.status;
    details.postUrl = postRes.url;
    console.log("[Syllabus] POST status:", postRes.status, "postUrl:", postRes.url);

    let indexHtml = await postRes.text();
    let indexUrl = postRes.url || "";

    if (postRes.ok && indexHtml && isLoginOrSsoPage(indexHtml)) {
      return { ok: false, error: "User not authenticated on Blackboard", details };
    }

    const autoFormMatch = indexHtml && indexHtml.match(/<\s*form[^>]*action\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*form\s*>/i);
    if (autoFormMatch && (indexHtml.includes("auto") && indexHtml.includes("submit") || indexHtml.includes("document.forms"))) {
      let nextAction = (autoFormMatch[1] || "").trim();
      if (nextAction && !/^https?:\/\//i.test(nextAction)) nextAction = new URL(nextAction, parsed.action).href;
      if (nextAction) {
        const formInner = autoFormMatch[2] || "";
        const pairs = [];
        const inputRe = /<\s*input\s+([^>]+)>/gi;
        let m;
        while ((m = inputRe.exec(formInner)) !== null) {
          const name = getAttr(m[1], "name");
          if (!name) continue;
          const type = (getAttr(m[1], "type") || "text").toLowerCase();
          if ((type === "radio" || type === "checkbox") && !/checked/i.test(m[1])) continue;
          pairs.push([name, getAttr(m[1], "value") ?? ""]);
        }
        const body = pairs.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
        if (pairs.length > 0) {
          const nextPost = await fetchWithRetry(nextAction, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html,application/xhtml+xml,*/*" },
            body
          });
          indexUrl = nextPost.url || indexUrl;
          indexHtml = await nextPost.text();
        }
      }
    }

    if (!indexUrl || !indexUrl.includes("ltitools.ie.edu")) {
      const fallbackUrl = SYLLABUS_INDEX_BASE + "?course_id=" + encodeURIComponent(courseIdStr);
      indexUrl = fallbackUrl;
      const indexRes = await fetchWithRetry(fallbackUrl, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "text/html,application/xhtml+xml,*/*" }
      });
      indexHtml = await indexRes.text();
      indexUrl = indexRes.url || indexUrl;
    }

    if (isLoginOrSsoPage(indexHtml)) return { ok: false, error: "User not authenticated on Blackboard", details };
    details.syllabusStatus = isSyllabusUnavailable(indexHtml) ? SyllabusStatus.MISSING : SyllabusStatus.AVAILABLE;
    return { ok: true, html: indexHtml, details: { ...details, indexUrl, htmlLength: indexHtml.length } };
  } catch (e) {
    const msg = e?.message ?? String(e);
    console.error("[Syllabus] Error:", msg, e);
    details.syllabusStatus = SyllabusStatus.UNKNOWN;
    if (/abort|timeout/i.test(msg)) return { ok: false, error: "Timeout or cancellation", details };
    if (/Failed to fetch|NetworkError/i.test(msg)) return { ok: false, error: "Network error", details };
    return { ok: false, error: msg || "Unknown error", details };
  }
}

function getSyllabusWithDedup(courseId) {
  const key = String(courseId).trim();
  if (syllabusFetchInFlight.has(key)) return syllabusFetchInFlight.get(key);
  const p = fetchSyllabusForCourse(key).finally(() => {
    syllabusFetchInFlight.delete(key);
  });
  syllabusFetchInFlight.set(key, p);
  return p;
}

/**
 * Fetches syllabus HTML via the content script (running in the Blackboard page context).
 * The content script has proper cookies and can do the full LTI flow reliably.
 * Returns { ok, html, url } or { ok: false, error }.
 */
async function fetchSyllabusViaContentScript(courseId) {
  try {
    const tab = await findAnyBlackboardTab();
    if (!tab?.id) return { ok: false, error: "No Blackboard tab found" };
    // The content script does the full LTI flow from the page context (correct cookies).
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "FETCH_SYLLABUS_HTML_FOR_COURSE",
      courseId: String(courseId).trim()
    });
    return result || { ok: false, error: "No response from content script" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

const REGISTRY_KEYS = {
  coursesByCourseId: "courseRegistry_coursesByCourseId",
  courseIdByNormalizedName: "courseRegistry_courseIdByNormalizedName",
  coursesList: "courseRegistry_coursesList",
  syncedAt: "courseRegistry_syncedAt"
};

const MESSAGES_WIDGET_CACHE_KEY = "bb_widget_messages_cache";
const MESSAGES_WIDGET_TTL_MS = 2 * 60 * 1000;

/**
 * Returns false if the syllabus text clearly belongs to a different course (e.g. contains
 * "Financial Accounting" when the requested course is "Fundamentals of Data Analysis").
 * Checks the first 1500 chars (where course title usually appears) to avoid false positives from bibliography.
 */
function syllabusContentMatchesCourse(rawText, courseName) {
  if (!rawText || typeof rawText !== "string" || rawText.length < 50) return true;
  const titleZone = rawText.slice(0, 1500).toLowerCase();
  const nameNorm = (courseName || "").toLowerCase();
  if (!nameNorm.trim()) return true;

  const otherCoursePhrases = [
    "introduction to financial accounting",
    "financial accounting",
    "cost accounting",
    "microeconomics",
    "macroeconomics",
    "principles of programming",
    "physics for computer science",
    "well-being in practice",
    "start-up lab",
    "ie humanities"
  ];
  for (const phrase of otherCoursePhrases) {
    if (!titleZone.includes(phrase)) continue;
    if (nameNorm.includes(phrase)) continue;
    const phraseWords = phrase.split(/\s+/).filter(Boolean);
    const nameHasPhrase = phraseWords.every((w) => nameNorm.includes(w));
    if (nameHasPhrase) continue;
    return false;
  }

  const keywords = nameNorm.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const hasExpected = keywords.length === 0 || keywords.some((kw) => titleZone.includes(kw));
  if (!hasExpected && titleZone.length > 500) return false;
  return true;
}

/**
 * True when the syllabus document's own courseTitle shares at least one significant word with the
 * expected course name. Used to reject LTI responses that landed on the wrong course's page.
 * Returns true (pass) when fetchedTitle is empty (can't validate).
 */
function syllabusCourseTitleMatches(fetchedTitle, expectedCourseName) {
  if (!fetchedTitle || !fetchedTitle.trim()) return true;
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const stopWords = new Set(["the", "and", "for", "of", "in", "to", "a", "an", "de", "del", "la", "el", "los", "las", "y"]);
  const sigWords = (s) => norm(s).split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
  const fetchedWords = new Set(sigWords(fetchedTitle));
  const expectedWords = sigWords(expectedCourseName);
  if (fetchedWords.size === 0 || expectedWords.length === 0) return true;
  return expectedWords.some((w) => fetchedWords.has(w));
}

const SYLLABUS_AVAILABILITY_CONCURRENCY = 3;

/**
 * Run syllabus availability check for each courseId (fetch + set status). Only for Q1/Q2 courses.
 * Runs in background after init; does not throw.
 * @param {string[]} courseIds
 */
async function runSyllabusAvailabilityChecks(courseIds) {
  if (!Array.isArray(courseIds) || courseIds.length === 0) return;
  const toCheck = [];
  for (const courseId of courseIds) {
    const uploaded = await getUploadedSyllabus(courseId);
    if (uploaded?.extractedText) continue;
    const entry = await getSyllabusStatus(courseId);
    if (entry?.status === SyllabusStatus.UPLOADED) continue;
    toCheck.push(courseId);
  }
  const limit = SYLLABUS_AVAILABILITY_CONCURRENCY;
  let index = 0;
  async function runNext() {
    const i = index++;
    if (i >= toCheck.length) return;
    const courseId = toCheck[i];
    try {
      const result = await getSyllabusWithDedup(courseId);
      const status = getSyllabusStatusFromFetch(result);
      await setSyllabusStatus(courseId, status);
    } catch (_) {
      try {
        await setSyllabusStatus(courseId, SyllabusStatus.UNKNOWN);
      } catch (_) {}
    }
    await runNext();
  }
  const workers = Array.from({ length: Math.min(limit, toCheck.length) }, () => runNext());
  await Promise.all(workers);
}

// ——— Syllabus intelligence: cache + course resolution ———
const syllabusProcessedCache = new Map();
const SYLLABUS_CACHE_TTL_MS = 60 * 60 * 1000;
// Persistent syllabus cache: survives service worker restarts (24h TTL).
// Keyed in chrome.storage.local as "syllabus_parsed_v3_{courseId}".
const SYLLABUS_PERSISTENT_CACHE_PREFIX = "syllabus_parsed_v3_";
const SYLLABUS_PERSISTENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function getSyllabusPersistentCache(courseId) {
  try {
    const key = SYLLABUS_PERSISTENT_CACHE_PREFIX + String(courseId).trim();
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (!entry || !entry.structured || !entry.savedAt) return null;
    if (Date.now() - entry.savedAt > SYLLABUS_PERSISTENT_TTL_MS) return null;
    return entry.structured;
  } catch (_) {
    return null;
  }
}

async function setSyllabusPersistentCache(courseId, structured) {
  try {
    const key = SYLLABUS_PERSISTENT_CACHE_PREFIX + String(courseId).trim();
    await chrome.storage.local.set({ [key]: { structured, savedAt: Date.now() } });
  } catch (_) {}
}

async function clearSyllabusPersistentCache(courseId) {
  try {
    const key = SYLLABUS_PERSISTENT_CACHE_PREFIX + String(courseId).trim();
    await chrome.storage.local.remove(key);
  } catch (_) {}
}

function normalizeCourseNameForResolution(str) {
  if (typeof str !== "string") return "";
  let s = str.trim().toLowerCase();
  s = s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  // Treat common punctuation (including ?, !, -) as separators so they do not block matches.
  s = s.replace(/\s+/g, " ").replace(/[.,:;()[\]?!\-]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Stops at follow-up clauses so "of humanities like whats the content" → "humanities".
 */
function truncateCourseMentionTail(tail) {
  if (!tail || typeof tail !== "string") return "";
  const s = tail.trim();
  if (!s) return "";
  const parts = s.split(
    /\s+(?:like|what|whats|which|when|how|about|tell|me|is|are|the|content|session|class|and\s+what|but|or\s+what)\b/i
  );
  return (parts[0] || s).trim();
}

/**
 * Course mention after the *last* of/for/in/de/del. Fixes "any idea of whats session 27 of microecon"
 * where the first "of" would capture "whats session…" instead of "microecon".
 * @param {string} rawQuery
 * @returns {string}
 */
function extractTailAfterLastPreposition(rawQuery) {
  if (typeof rawQuery !== "string" || !rawQuery.trim()) return "";
  const q = rawQuery.trim();
  const re = /\b(?:of|for|in|de|del)\s+/gi;
  let lastEnd = -1;
  let m;
  while ((m = re.exec(q)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < 0 || lastEnd >= q.length) return "";
  let tail = q.slice(lastEnd).replace(/[?.!]+$/g, "").trim();
  return truncateCourseMentionTail(tail);
}

/**
 * Second pass: short course name before discourse ("of humanities like" → "humanities").
 */
function extractShortCourseNameForRetry(userText) {
  const t = (userText || "").trim();
  const last = extractTailAfterLastPreposition(t);
  if (last && last.length >= 2) return last;
  const m = t.match(
    /\b(?:of|for|in|de|del)\s+([a-z][a-z0-9\s\-]{1,60}?)(?:\s+(?:like|what|whats|which|when|how|about|tell|me|is|are|the|content|session|class)\b|[?]|$)/i
  );
  if (m && m[1]) return truncateCourseMentionTail(m[1].trim());
  return "";
}

/** Concatenate prior chat turns so course names in assistant replies can resolve follow-ups without repeating the course. */
function flattenRecentMessagesForCourseResolution(recentMessages) {
  if (!Array.isArray(recentMessages) || recentMessages.length === 0) return "";
  const lines = [];
  for (const m of recentMessages.slice(-10)) {
    if (!m || typeof m !== "object") continue;
    const c = String(m.content || "").trim();
    if (!c) continue;
    lines.push(c.slice(0, 4000));
  }
  return lines.join("\n");
}

async function resolveCourseInBackgroundFromQueryText(userText) {
  const data = await chrome.storage.local.get([
    REGISTRY_KEYS.courseIdByNormalizedName,
    REGISTRY_KEYS.coursesByCourseId
  ]);
  const courseIdByNormalizedName = data[REGISTRY_KEYS.courseIdByNormalizedName] || {};
  const coursesByCourseId = data[REGISTRY_KEYS.coursesByCourseId] || {};
  const keys = Object.keys(courseIdByNormalizedName);
  if (keys.length === 0) {
    return { ok: false, reason: "not_found", message: "No courses synced. Sync courses from Blackboard first.", suggestions: [] };
  }
  let rawQuery = (userText || "").trim();
  rawQuery = rawQuery
    .replace(/\bfor\s+toda\b(?!\s+la\b)/gi, "for today")
    .replace(/\bof\s+toda\b(?!\s+la\b)/gi, "of today")
    .replace(/\bin\s+toda\b(?!\s+la\b)/gi, "in today")
    .replace(/\b(sessions?|classes?)\s+toda\b/gi, "$1 today")
    .replace(/\btday\b/gi, "today")
    .replace(/\btmrw\b/gi, "tomorrow")
    .replace(/\btmr\b/gi, "tomorrow")
    .replace(/\bassigns\b/gi, "assignments");

  // Try to extract course mention from tails like "session 28 of data analysis", "syllabus of cost acc".
  // Prefer text after the *last* preposition so "idea of whats session 27 of microecon" → "microecon", not "whats".
  let mentionRaw = rawQuery;
  const tailFromLastPrep = extractTailAfterLastPreposition(rawQuery);
  if (tailFromLastPrep && tailFromLastPrep.length >= 2) {
    mentionRaw = tailFromLastPrep;
  } else {
    const prepMatch = rawQuery.match(/\b(?:of|for|in|de|del)\s+(.+)$/i);
    if (prepMatch && prepMatch[1]) {
      const tail = truncateCourseMentionTail(prepMatch[1].trim());
      if (tail.length >= 2) mentionRaw = tail;
    }
  }

  const normalizedQuery = normalizeCourseNameForResolution(mentionRaw || "");
  if (!normalizedQuery) {
    const suggestionsEmpty = Object.values(coursesByCourseId).slice(0, 5).map((c) => c.name);
    return { ok: false, reason: "not_found", message: "No course detected in your question. Specify the course name (e.g. Cost Accounting, Microeconomics).", suggestions: suggestionsEmpty };
  }

  const exactId = courseIdByNormalizedName[normalizedQuery];
  if (exactId && coursesByCourseId[exactId]) {
    return { ok: true, courseId: exactId, name: coursesByCourseId[exactId].name };
  }

  const simpleNormalize = (s) => {
    if (typeof s !== "string") return "";
    return s
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[^\w\s]/g, "")
      .trim();
  };

  const makeAcronym = (name) => {
    const norm = simpleNormalize(name);
    if (!norm) return "";
    const stop = new Set(["of", "for", "and", "the", "de", "del"]);
    const parts = norm.split(/\s+/).filter((p) => p && !stop.has(p));
    return parts.map((p) => p[0]).join("");
  };

  const tokenSetSimilarity = (a, b) => {
    const na = simpleNormalize(a);
    const nb = simpleNormalize(b);
    if (!na && !nb) return 1;
    if (!na || !nb) return 0;
    const sa = new Set(na.split(" "));
    const sb = new Set(nb.split(" "));
    let inter = 0;
    for (const t of sa) {
      if (sb.has(t)) inter++;
    }
    const union = sa.size + sb.size - inter;
    return union === 0 ? 0 : inter / union;
  };

  const normalizedForMatch = simpleNormalize(mentionRaw);
  const queryAcronym = makeAcronym(mentionRaw);
  const mentionTokens = normalizedForMatch.split(/\s+/).filter(Boolean);
  const strongMentionTokens = mentionTokens.filter((t) => t.length >= 5);
  const timeWordFalsePositives = new Set([
    "toda",
    "tody",
    "tday",
    "tmrw",
    "tmr",
    "today",
    "tomorrow",
    "tommorow",
    "tommorrow"
  ]);
  if (mentionTokens.length === 1 && timeWordFalsePositives.has(mentionTokens[0])) {
    const suggestionsEmpty = Object.values(coursesByCourseId).slice(0, 5).map((c) => c.name);
    return {
      ok: false,
      reason: "not_found",
      message: "No course detected in your question. Specify the course name (e.g. Cost Accounting, Microeconomics).",
      suggestions: suggestionsEmpty
    };
  }

  let bestId = null;
  let bestScore = 0;
  let secondBestScore = 0;

  for (const key of keys) {
    const courseId = courseIdByNormalizedName[key];
    const meta = coursesByCourseId[courseId];
    if (!meta) continue;

    const courseName = meta.name || key;
    const keyNorm = key;
    const nameNorm = normalizeCourseNameForResolution(courseName);
    const courseAcronym = makeAcronym(courseName);

    let score = 0;

    if (keyNorm.includes(normalizedQuery) || normalizedQuery.includes(keyNorm)) {
      const lenRatio = Math.min(normalizedQuery.length, keyNorm.length) / Math.max(normalizedQuery.length, keyNorm.length || 1);
      score = Math.max(score, 0.7 + lenRatio * 0.25);
    }

    if (courseAcronym) {
      const acr = courseAcronym.toLowerCase();
      if (acr === normalizedForMatch || acr === queryAcronym.toLowerCase()) {
        score = Math.max(score, 0.99);
      } else if (normalizedForMatch.startsWith(acr) || acr.startsWith(normalizedForMatch)) {
        score = Math.max(score, 0.9);
      }
    }

    const nameSim = tokenSetSimilarity(mentionRaw, courseName);
    score = Math.max(score, nameSim);

    if (score > bestScore) {
      secondBestScore = bestScore;
      bestScore = score;
      bestId = courseId;
    } else if (score > secondBestScore) {
      secondBestScore = score;
    }
  }

  const THRESHOLD = 0.6;
  if (bestId && coursesByCourseId[bestId] && bestScore >= THRESHOLD) {
    const metaBest = coursesByCourseId[bestId];
    const bestNameNorm = simpleNormalize(metaBest?.name || "");
    const hasStrongTokenHit =
      strongMentionTokens.length === 0 ||
      strongMentionTokens.some((t) => bestNameNorm.includes(t));
    const isAmbiguous = bestScore - secondBestScore < 0.08;

    // High-confidence match: accept even when the second candidate is close (long tails used to trigger ambiguity).
    if (bestScore >= 0.76 && hasStrongTokenHit) {
      return { ok: true, courseId: bestId, name: metaBest?.name || "" };
    }

    // Be conservative for syllabus/course routing: when uncertain, ask to clarify instead of choosing a wrong course.
    if (!hasStrongTokenHit || isAmbiguous) {
      const suggestions = Object.values(coursesByCourseId).slice(0, 5).map((c) => c.name);
      return {
        ok: false,
        reason: "ambiguous",
        message: "I couldn't confidently identify the course. Please use the exact course name as shown in Blackboard.",
        suggestions
      };
    }

    return { ok: true, courseId: bestId, name: metaBest?.name || "" };
  }

  const suggestions = Object.values(coursesByCourseId).slice(0, 5).map((c) => c.name);
  return {
    ok: false,
    reason: "not_found",
    message: "No course in your sync matched that name. Try the exact title from Blackboard or pick from your course list.",
    suggestions
  };
}

/**
 * Resolves course from user text; if that fails, retries with the same text plus recent chat (assistant often names the course).
 */
async function resolveCourseInBackground(userText, opts = {}) {
  // If the LLM classifier already extracted a clean course name, try it first.
  // This bypasses the preposition-dependency of the regex extractor below.
  if (opts.courseHint && typeof opts.courseHint === "string" && opts.courseHint.trim().length >= 2) {
    const hintRes = await resolveCourseInBackgroundFromQueryText(opts.courseHint.trim());
    if (hintRes.ok) return hintRes;
  }
  const t = (userText || "").trim();
  let res = await resolveCourseInBackgroundFromQueryText(t);
  if (res.ok) return res;
  const ctx = flattenRecentMessagesForCourseResolution(opts.recentMessages);
  if (!ctx || ctx.length < 12) return res;
  const merged = t + "\n\n" + ctx;
  const res2 = await resolveCourseInBackgroundFromQueryText(merged);
  if (res2.ok) return res2;
  return res;
}

/**
 * Find an uploaded syllabus by resolved course name (fallback when courseId lookup misses).
 * Returns { courseId, record } or null.
 * WARNING: Name matching can be fuzzy — only use the returned syllabus if fallback.courseId === requested courseId.
 */
async function findUploadedSyllabusByCourseName(courseName) {
  const normTarget = normalizeCourseNameForResolution(courseName || "");
  if (!normTarget) return null;
  const data = await chrome.storage.local.get([
    REGISTRY_KEYS.coursesByCourseId,
    "syllabusUploads"
  ]);
  const coursesByCourseId = data[REGISTRY_KEYS.coursesByCourseId] || {};
  const uploads = data.syllabusUploads || {};
  for (const [cid, record] of Object.entries(uploads)) {
    if (!record?.extractedText) continue;
    const meta = coursesByCourseId[cid];
    const name = meta?.name || "";
    const normName = normalizeCourseNameForResolution(name);
    if (!normName) continue;
    if (normTarget === normName || normTarget.includes(normName) || normName.includes(normTarget)) {
      return { courseId: cid, record };
    }
  }
  return null;
}

const BB_ANNOUNCEMENTS_AI_CACHE_PREFIX = "bb_announcements_by_course:";
const BB_ANNOUNCEMENTS_AI_TTL_MS = 6 * 60 * 60 * 1000;
const BB_ANNOUNCEMENTS_AI_MAX_RECENT = 5;
/** Full announcement body for AI context (up to 25k chars per announcement). */
const BB_ANNOUNCEMENTS_AI_EXCERPT_CHARS = 25000;
const ULTRA_ANNOUNCEMENT_LINK = "https://blackboard.ie.edu/ultra/courses";

/**
 * Get raw announcements list for a course (from cache or fetch). Used by both syllabus context and announcements-only Q&A.
 * Returns { list } or null on failure.
 */
async function getAnnouncementsListForCourse(courseId) {
  const cacheKey = BB_ANNOUNCEMENTS_AI_CACHE_PREFIX + String(courseId).trim();
  try {
    const stored = await chrome.storage.local.get([cacheKey]);
    const entry = stored[cacheKey];
    let list = [];
    if (entry && Array.isArray(entry.list) && entry.cachedAt != null && (Date.now() - entry.cachedAt) < BB_ANNOUNCEMENTS_AI_TTL_MS) {
      list = entry.list;
    } else {
      const tab = await findAnyBlackboardTab();
      if (!tab?.id) return null;
      await pingContentScript(tab.id);
      let xsrf = null;
      try {
        const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
        if (authRes?.ok) xsrf = authRes.xsrf ?? null;
      } catch (_) {}
      const res = await chrome.tabs.sendMessage(tab.id, { type: "FETCH_ANNOUNCEMENTS_FOR_AI", courseId, xsrf });
      if (!res?.ok || !Array.isArray(res.announcements)) return null;
      list = res.announcements;
      await chrome.storage.local.set({ [cacheKey]: { list, cachedAt: Date.now() } });
    }
    return { list };
  } catch (e) {
    return null;
  }
}

/**
 * Get announcements knowledge for AI: from cache or fetch via content script.
 * Returns a string block for the prompt, or null on failure (caller should still answer from syllabus).
 */
async function getAnnouncementsKnowledgeForCourse(courseId, userText) {
  try {
    const data = await getAnnouncementsListForCourse(courseId);
    if (!data || !Array.isArray(data.list)) return null;
    const list = data.list;
    if (list.length === 0) return "";

    const queryLower = (userText || "").toLowerCase();
    const keywords = queryLower.split(/\s+/).filter((w) => w.length > 2);
    const recent = list.slice(0, BB_ANNOUNCEMENTS_AI_MAX_RECENT);
    const keywordMatches = keywords.length === 0 ? [] : list.filter((a) => {
      const title = (a.title || "").toLowerCase();
      const body = (a.bodyText || "").toLowerCase();
      return keywords.some((kw) => title.includes(kw) || body.includes(kw));
    });
    const seenIds = new Set();
    const selected = [];
    for (const a of keywordMatches) {
      if (!seenIds.has(a.announcementId)) {
        seenIds.add(a.announcementId);
        selected.push(a);
      }
    }
    for (const a of recent) {
      if (!seenIds.has(a.announcementId)) {
        seenIds.add(a.announcementId);
        selected.push(a);
      }
    }

    const lines = [];
    for (const a of selected) {
      const dateStr = a.dateISO || a.modifiedDate || a.createdDate || "";
      const header = "Announcement: " + (a.title || "(No title)") + " | Date: " + dateStr + " | Id: " + (a.announcementId || "");
      let excerpt = (a.bodyText || "").slice(0, BB_ANNOUNCEMENTS_AI_EXCERPT_CHARS);
      if ((a.bodyText || "").length > BB_ANNOUNCEMENTS_AI_EXCERPT_CHARS) excerpt += "...";
      lines.push(header + "\n" + excerpt);
    }
    return lines.join("\n\n---\n\n");
  } catch (e) {
    return null;
  }
}

const SYLLABUS_PARSED_CACHE_REVISION = 6;

function syllabusParsedCacheKey(courseId) {
  return String(courseId).trim() + ":p" + SYLLABUS_PARSED_CACHE_REVISION;
}

async function getStructuredSyllabus(courseId, courseName) {
  const cid = String(courseId).trim();
  const cacheKey = syllabusParsedCacheKey(cid);

  // Layer 1: in-memory cache (fast, lost on service worker restart).
  const cached = syllabusProcessedCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SYLLABUS_CACHE_TTL_MS) {
    if (courseName) {
      const cachedTitle = (cached.structured?.courseTitle || "").trim();
      if (cachedTitle && !syllabusCourseTitleMatches(cachedTitle, courseName)) {
        console.warn("[Syllabus] Memory cache evicted — title '" + cachedTitle + "' doesn't match '" + courseName + "'");
        syllabusProcessedCache.delete(cacheKey);
        await clearSyllabusPersistentCache(cid);
      } else {
        return cached.structured;
      }
    } else {
      return cached.structured;
    }
  }

  // Layer 2: persistent storage (survives service worker restarts, 24h TTL).
  const persisted = await getSyllabusPersistentCache(cid);
  if (persisted) {
    if (courseName) {
      const persistedTitle = (persisted.courseTitle || "").trim();
      if (persistedTitle && !syllabusCourseTitleMatches(persistedTitle, courseName)) {
        console.warn("[Syllabus] Persistent cache evicted — title '" + persistedTitle + "' doesn't match '" + courseName + "'");
        await clearSyllabusPersistentCache(cid);
        // Fall through to live fetch
      } else {
        // Warm up in-memory cache from persistent storage
        syllabusProcessedCache.set(cacheKey, { structured: persisted, timestamp: Date.now() });
        return persisted;
      }
    } else {
      syllabusProcessedCache.set(cacheKey, { structured: persisted, timestamp: Date.now() });
      return persisted;
    }
  }

  // Layer 3: live LTI fetch via background service worker (_20_1 placement, returns standard HTML form).
  const result = await getSyllabusWithDedup(cid);
  const status = getSyllabusStatusFromFetch(result);
  setSyllabusStatus(cid, status).catch(() => {});
  if (!result.ok || !result.html) throw new Error(result.error || "Could not fetch the syllabus");
  const structured = parseSyllabusHtml(result.html);

  // Validate before caching: if courseTitle clearly belongs to a different course, don't cache it.
  if (courseName) {
    const fetchedTitle = (structured?.courseTitle || "").trim();
    if (fetchedTitle && !syllabusCourseTitleMatches(fetchedTitle, courseName)) {
      console.warn("[Syllabus] Title mismatch on live fetch — fetched '" + fetchedTitle + "' expected '" + courseName + "'. Not caching.");
      return structured; // Return without caching — LTI session will be retried next time
    }
  }

  // Cache in both layers on success.
  syllabusProcessedCache.set(cacheKey, { structured, timestamp: Date.now() });
  setSyllabusPersistentCache(cid, structured).catch(() => {});
  return structured;
}

/**
 * Single source for syllabus content: if the course has an uploaded PDF, return synthetic structured from it;
 * otherwise return structured from the Blackboard endpoint. Same shape as parseSyllabusHtml so callers need no change.
 * @param {string} courseId
 * @param {string} [courseName] - used for fallback lookup by name when upload is not keyed by courseId
 * @param {{ strictCourseId?: boolean }} [opts] - if strictCourseId true, never use name-based fallback (ensures syllabus is for this exact courseId)
 * @returns {Promise<{ rawText: string, courseTitle: string, sessions: unknown[], evaluation: unknown[], bibliography: unknown[], policies: unknown[] }>}
 */
async function getSyllabusStructuredPreferred(courseId, courseName, opts = {}) {
  const strictCourseId = opts.strictCourseId === true;
  let uploaded = await getUploadedSyllabus(courseId);
  if (!uploaded?.extractedText && courseName && !strictCourseId) {
    const fallback = await findUploadedSyllabusByCourseName(courseName);
    if (fallback && fallback.courseId === courseId) {
      uploaded = fallback.record;
    }
  }
  if (uploaded?.extractedText) {
    const rawText = uploaded.extractedText.length > 90000 ? uploaded.extractedText.slice(0, 90000) : uploaded.extractedText;
    const parsed = parseSyllabusFromText(rawText, { courseId });
    console.log("[SYLLABUS_PARSER] mode:", parsed.diagnostics?.programParsingMode, "| sessions:", parsed.sessions?.length, "| warnings:", parsed.diagnostics?.warnings);
    return toStructuredFormat(parsed, courseName);
  }
  return getStructuredSyllabus(courseId, courseName);
}

/**
 * Fetches widget messages from Blackboard and writes them to storage (MESSAGES_WIDGET_CACHE_KEY).
 * Used only in background (SYNC_WIDGET_MESSAGES). Widget UI reads via GET_WIDGET_MESSAGES from cache only.
 */
async function refreshWidgetMessagesCache() {
  try {
    const stored = await chrome.storage.local.get([MESSAGES_WIDGET_CACHE_KEY]);
    const entry = stored[MESSAGES_WIDGET_CACHE_KEY];
    if (entry && entry.fetchedAt != null && (Date.now() - entry.fetchedAt) < MESSAGES_WIDGET_TTL_MS) {
      return; // cache still fresh
    }
    const tab = await findAnyBlackboardTab();
    if (!tab?.id) return;
    await pingContentScript(tab.id);
    let xsrf = await getXsrfFromBbRouterCookie();
    if (!xsrf) {
      const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
      xsrf = authRes?.ok ? (authRes.xsrf ?? null) : null;
    }
    const data = await chrome.storage.local.get([REGISTRY_KEYS.coursesList, REGISTRY_KEYS.coursesByCourseId]);
    const coursesList = data[REGISTRY_KEYS.coursesList] || [];
    const coursesByCourseId = data[REGISTRY_KEYS.coursesByCourseId] || {};
    const allCourses = coursesList.length
      ? coursesList.map((c) => ({ id: c.learnCourseId, name: c.name }))
      : Object.keys(coursesByCourseId).map((cid) => ({ id: cid, name: coursesByCourseId[cid]?.name || cid }));

    if (!allCourses.length) return;

    const fetchConversations = (cid) =>
      chrome.tabs.sendMessage(tab.id, { type: "FETCH_COURSE_CONVERSATIONS", xsrf, courseId: cid });

    /** @type {{ courseId: string, courseName: string, message: any }[]} */
    const candidates = [];

    for (const c of allCourses) {
      try {
        const { normalized, indexes } = await getOrFetchConversations(c.id, fetchConversations, {
          forceRefresh: false
        });
        const { byDate } = indexes;
        if (!byDate || byDate.length === 0) continue;
        const takeCount = Math.min(3, byDate.length);
        for (let i = 0; i < takeCount; i++) {
          const idx = byDate[i].i;
          const msgObj = normalized.messages[idx];
          if (msgObj) {
            candidates.push({ courseId: c.id, courseName: c.name, message: msgObj });
          }
        }
      } catch (_) {
        // ignore courses that fail
      }
    }

    if (!candidates.length) {
      try {
        await chrome.storage.local.set({ [MESSAGES_WIDGET_CACHE_KEY]: { items: [], fetchedAt: Date.now() } });
      } catch (_) {}
      return;
    }

    candidates.sort((a, b) => (b.message.postDateEpoch || 0) - (a.message.postDateEpoch || 0));
    const top3 = candidates.slice(0, 3);

    const items = top3.map(({ courseId, courseName, message }) => {
      const title = courseName || "Message";
      const date = message.postDateISO || message.postDate || message.postDateIso || message.postDateRaw || null;
      let dateText = "";
      try {
        if (date) {
          const d = new Date(date);
          if (!Number.isNaN(d.getTime())) {
            const day = String(d.getDate()).padStart(2, "0");
            const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const month = monthNames[d.getMonth()] || "";
            const year = d.getFullYear();
            const hours = String(d.getHours()).padStart(2, "0");
            const mins = String(d.getMinutes()).padStart(2, "0");
            dateText = `${day} ${month} ${year}, ${hours}:${mins}`;
          }
        }
      } catch (_) {
        dateText = "";
      }

      let url = null;
      const convId = message.conversationId || message.messageId || "";
      if (courseId && convId) {
        const cidEnc = encodeURIComponent(courseId);
        const convEnc = encodeURIComponent(convId);
        url =
          "https://blackboard.ie.edu/ultra/courses/" +
          cidEnc +
          "/messages/edit/" +
          convEnc +
          "?courseId=" +
          cidEnc +
          "&offset=0&count=2";
      }

      const preview = message.textPreview || "";

      return {
        title,
        courseName,
        dateText,
        preview,
        url
      };
    });

    try {
      await chrome.storage.local.set({ [MESSAGES_WIDGET_CACHE_KEY]: { items, fetchedAt: Date.now() } });
    } catch (_) {
      // ignore storage errors
    }
  } catch (_) {
    // fail silently; next sync will retry
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      touchLastActivity();

      if (msg?.type === "CHECK_FOR_UPDATES") {
        const release = await fetchLatestRelease();
        const currentVersion = getLocalVersion();
        if (!release) {
          sendResponse({ ok: false });
          return;
        }
        if (compareVersions(release.version, currentVersion) > 0) {
          await checkForUpdate();
          sendResponse({ ok: true, updateAvailable: true, newVersion: release.version, currentVersion });
        } else {
          sendResponse({ ok: true, upToDate: true, currentVersion });
        }
        return;
      }

      if (msg?.type === "GET_ANNOUNCEMENTS") {
        const data = await chrome.storage.local.get(["announcementsData", "announcementsSyncedAt"]);
        sendResponse({
          ok: true,
          data: data.announcementsData || [],
          syncedAt: data.announcementsSyncedAt ?? null
        });
        return;
      }

      if (msg?.type === "GET_ANNOUNCEMENTS_RAW_TEXT") {
        const courseId = msg?.courseId;
        const courseName = msg?.courseName || "";
        if (!courseId) {
          sendResponse({ ok: false, error: "courseId required", rawText: "" });
          return;
        }
        try {
          const data = await getAnnouncementsListForCourse(courseId);
          const list = data?.list || [];
          const lines = [];
          for (const a of list) {
            const dateStr = a.dateISO || a.modifiedDate || a.createdDate || "";
            lines.push("--- Announcement: " + (a.title || "(No title)") + " | Date: " + dateStr + " ---");
            lines.push(a.bodyText || "(Empty)");
            lines.push("");
          }
          const rawText = lines.length ? lines.join("\n") : "(No announcements for this course.)";
          sendResponse({ ok: true, rawText, count: list.length, courseName: courseName || courseId });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "Error fetching announcements text", rawText: "" });
        }
        return;
      }

      if (msg?.type === "GET_MESSAGES_RAW_TEXT") {
        const courseId = msg?.courseId;
        const courseName = msg?.courseName || "";
        if (!courseId) {
          sendResponse({ ok: false, error: "courseId required", rawText: "" });
          return;
        }
        try {
          const tab = await findAnyBlackboardTab();
          if (!tab?.id) {
            sendResponse({ ok: false, error: "Open Blackboard in a tab to load messages.", rawText: "" });
            return;
          }
          await pingContentScript(tab.id);
          let xsrf = await getXsrfFromBbRouterCookie();
          if (!xsrf) {
            const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
            xsrf = authRes?.ok ? (authRes.xsrf ?? null) : null;
          }
          const fetchConversations = (cid) =>
            chrome.tabs.sendMessage(tab.id, { type: "FETCH_COURSE_CONVERSATIONS", xsrf, courseId: cid });
          const { normalized } = await getOrFetchConversations(courseId, fetchConversations, { forceRefresh: false });
          const messages = normalized?.messages || [];
          const lines = [];
          const sorted = [...messages].sort((a, b) => (b.postDateEpoch || 0) - (a.postDateEpoch || 0));
          for (const m of sorted) {
            const dateStr = m.postDateISO || "";
            const sender = m.senderName || m.senderUsername || "(Unknown)";
            lines.push("--- Message: " + sender + " | Date: " + dateStr + " ---");
            lines.push(m.textPlain || "(Empty)");
            lines.push("");
          }
          const rawText = lines.length ? lines.join("\n") : "(No messages for this course.)";
          sendResponse({ ok: true, rawText, count: messages.length, courseName: courseName || courseId });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "Error fetching messages text", rawText: "" });
        }
        return;
      }

      if (msg?.type === "GET_USER_PROFILE") {
        const data = await chrome.storage.local.get(["bb_user_profile"]);
        const stored = data.bb_user_profile || null;
        const profile = stored && typeof stored === "object" ? stored : null;
        sendResponse({ ok: true, profile });
        return;
      }

      if (msg?.type === "SYNC_USER_PROFILE") {
        const BB_USER_PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
        try {
          const data = await chrome.storage.local.get(["bb_user_profile"]);
          const stored = data.bb_user_profile;
          if (stored && typeof stored === "object" && stored.lastFetched != null && (Date.now() - stored.lastFetched) < BB_USER_PROFILE_TTL_MS) {
            sendResponse({ ok: true, fromCache: true });
            return;
          }
        } catch (_) {}
        let tab = null;
        try {
          tab = await findAnyBlackboardTab();
        } catch (e) {
          sendResponse({ ok: true });
          return;
        }
        if (!tab?.id) {
          sendResponse({ ok: true });
          return;
        }
        try {
          await pingContentScript(tab.id);
        } catch (e) {
          sendResponse({ ok: true });
          return;
        }
        let xsrf = null;
        try {
          const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
          if (authRes?.ok) xsrf = authRes.xsrf ?? null;
        } catch (_) {
          sendResponse({ ok: true });
          return;
        }
        if (!xsrf) {
          try {
            xsrf = await getXsrfFromBbRouterCookie();
          } catch (_) {}
        }
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { type: "FETCH_USER_PROFILE", xsrf });
          if (res?.ok && res?.profile && typeof res.profile === "object") {
            const toStore = { ...res.profile, lastFetched: Date.now() };
            await chrome.storage.local.set({ bb_user_profile: toStore });
          }
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: true });
        }
        return;
      }

      if (msg?.type === "SYNC_ANNOUNCEMENTS") {
        let tab = null;
        try {
          tab = await findAnyBlackboardTab();
        } catch (e) {
          sendResponse({ ok: false, error: "Could not find tab: " + (e?.message || e), data: [], errors: [] });
          return;
        }
        if (!tab?.id) {
          sendResponse({ ok: false, error: "Open Blackboard in a tab (blackboard.ie.edu) and click Sync again.", data: [], errors: [] });
          return;
        }
        try {
          await pingContentScript(tab.id);
        } catch (e) {
          sendResponse({ ok: false, error: "Reload the Blackboard tab and try again.", data: [], errors: [] });
          return;
        }
        let xsrf = null;
        try {
          const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
          if (authRes?.ok) xsrf = authRes.xsrf ?? null;
        } catch (authErr) {
          sendResponse({ ok: false, error: "No session. Open Blackboard, sign in and reload the tab.", data: [], errors: [] });
          return;
        }
        if (!xsrf) {
          try {
            xsrf = await getXsrfFromBbRouterCookie();
          } catch (_) {}
        }
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { type: "SYNC_ANNOUNCEMENTS", xsrf });
          sendResponse({ ok: res?.ok ?? false, data: res?.data ?? [], errors: res?.errors ?? [], error: res?.error });
        } catch (e) {
          sendResponse({ ok: false, error: "Content script: " + (e?.message || e) + ". Reload the Blackboard tab.", data: [], errors: [] });
        }
        return;
      }

      if (msg?.type === "SYNC_COURSES") {
        const tab = await findAnyBlackboardTab();
        if (!tab?.id) {
          throw new Error("Open Blackboard in a tab and make sure you are logged in.");
        }
        await pingContentScript(tab.id);
        let xsrf = await getXsrfFromBbRouterCookie();
        if (!xsrf) {
          const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
          if (!authRes?.ok) throw new Error(authRes?.error || "Open Blackboard in a tab and make sure you are logged in.");
          xsrf = authRes.xsrf ?? null;
        }
        const res = await chrome.tabs.sendMessage(tab.id, { type: "SYNC_COURSES", xsrf });
        sendResponse({ ok: res?.ok, count: res?.count ?? 0, sample: res?.sample ?? [], log: res?.log ?? [], error: res?.error });
        return;
      }

      if (msg?.type === "SYNC_SYLLABI") {
        const tab = await findAnyBlackboardTab();
        if (!tab?.id) throw new Error("Open Blackboard in a tab and make sure you are logged in.");
        await pingContentScript(tab.id);
        let xsrf = await getXsrfFromBbRouterCookie();
        if (!xsrf) {
          const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
          if (!authRes?.ok) throw new Error(authRes?.error || "Open Blackboard in a tab and make sure you are logged in.");
          xsrf = authRes.xsrf ?? null;
        }
        const syncRes = await chrome.tabs.sendMessage(tab.id, { type: "SYNC_SYLLABI_IN_PAGE", xsrf });
        if (!syncRes?.ok) throw new Error(syncRes?.error || "Content script error");

        const syllabi = syncRes.syllabi || [];
        const gradebookColumns = syncRes.gradebookColumns || [];
        const gradebookByCourseId = syncRes.gradebookByCourseId || {};
        const syncLog = syncRes.log || [];

        // Strip syllabusHtml before persisting — HTML is large and already parsed into the persistent cache below.
        const syllabiForStorage = syllabi.map(({ syllabusHtml: _html, ...rest }) => rest);
        await chrome.storage.local.set({
          syllabi: syllabiForStorage,
          syllabiSyncedAt: Date.now(),
          gradebookColumns,
          gradebookByCourseId,
          syncLog
        });
        syllabusProcessedCache.clear();

        // Parse and cache any syllabus HTML that was fetched during sync.
        // This is the most reliable path: the content script fetches HTML while the Blackboard
        // tab is active (correct cookies), so no on-demand LTI round-trip is needed.
        const syllabusParseLog = [];
        for (const s of syllabi) {
          const cid = String(s.courseId || "").trim();
          if (!cid || !s.syllabusHtml) continue;
          try {
            const structured = parseSyllabusHtml(s.syllabusHtml);
            if (!structured) continue;
            const fetchedTitle = (structured.courseTitle || "").trim();
            if (fetchedTitle && s.courseName && !syllabusCourseTitleMatches(fetchedTitle, s.courseName)) {
              syllabusParseLog.push("Mismatch: " + s.courseName + " → fetched '" + fetchedTitle + "'");
              continue;
            }
            syllabusProcessedCache.set(syllabusParsedCacheKey(cid), { structured, timestamp: Date.now() });
            await setSyllabusPersistentCache(cid, structured);
            setSyllabusStatus(cid, SyllabusStatus.AVAILABLE).catch(() => {});
            syllabusParseLog.push("Cached: " + s.courseName + " (title: " + (fetchedTitle || "?") + ")");
          } catch (e) {
            syllabusParseLog.push("Parse error for " + s.courseName + ": " + (e?.message || String(e)));
          }
        }

        sendResponse({ ok: true, count: syllabi.length, syllabi, log: [...syncLog, ...syllabusParseLog] });
        return;
      }

      if (msg?.type === "SYNC_GRADEBOOK_ONLY") {
        const tab = await findAnyBlackboardTab();
        if (!tab?.id) {
          sendResponse({ ok: false, error: "Open Blackboard in a tab and make sure you are logged in." });
          return;
        }
        await pingContentScript(tab.id);
        let xsrf = await getXsrfFromBbRouterCookie();
        if (!xsrf) {
          const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
          if (!authRes?.ok) {
            sendResponse({ ok: false, error: authRes?.error || "Open Blackboard in a tab and make sure you are logged in." });
            return;
          }
          xsrf = authRes.xsrf ?? null;
        }
        const res = await chrome.tabs.sendMessage(tab.id, { type: "SYNC_GRADEBOOK_ONLY", xsrf });
        if (!res?.ok) {
          sendResponse({ ok: false, error: res?.error, log: res?.log ?? [] });
          return;
        }
        await chrome.storage.local.set({
          gradebookColumns: res.gradebookColumns || [],
          gradebookByCourseId: res.gradebookByCourseId || {}
        });
        sendResponse({ ok: true, gradebookColumns: res.gradebookColumns, gradebookByCourseId: res.gradebookByCourseId, log: res.log ?? [] });
        return;
      }

      if (msg?.type === "SYNC_SYLLABUS_FOR_COURSE") {
        const learnCourseId = msg?.learnCourseId;
        const courseName = msg?.courseName ?? "";
        if (!learnCourseId) {
          sendResponse({ ok: false, error: "Falta learnCourseId" });
          return;
        }
        const tab = await findAnyBlackboardTab();
        if (!tab?.id) {
          sendResponse({ ok: false, error: "Open Blackboard in a tab and make sure you are logged in." });
          return;
        }
        await pingContentScript(tab.id);
        let xsrf = await getXsrfFromBbRouterCookie();
        if (!xsrf) {
          const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
          if (!authRes?.ok) {
            sendResponse({ ok: false, error: authRes?.error || "Open Blackboard in a tab and make sure you are logged in." });
            return;
          }
          xsrf = authRes.xsrf ?? null;
        }
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: "SYNC_SYLLABUS_FOR_COURSE",
          xsrf,
          learnCourseId,
          courseName
        });
        if (!res?.ok) {
          sendResponse({ ok: false, error: res?.error, courseId: learnCourseId, courseName });
          return;
        }
        const data = await chrome.storage.local.get(["syllabi"]);
        const syllabi = data.syllabi || [];
        const without = syllabi.filter((s) => s.courseId !== learnCourseId);
        without.push({
          courseId: learnCourseId,
          courseName: res.courseName || courseName,
          syllabusUrl: res.syllabusUrl ?? null
        });
        await chrome.storage.local.set({ syllabi: without });
        sendResponse({
          ok: true,
          courseId: learnCourseId,
          courseName: res.courseName || courseName,
          syllabusUrl: res.syllabusUrl
        });
        return;
      }

      if (msg?.type === "GET_CALENDAR_ITEMS") {
        const since = msg?.since;
        const until = msg?.until;
        if (!since || !until) {
          sendResponse({ ok: false, error: "Missing since/until", items: [] });
          return;
        }
        const tab = await findAnyBlackboardTab();
        if (!tab?.id) {
          sendResponse({ ok: false, error: "Open Blackboard in a tab and make sure you are logged in.", items: [] });
          return;
        }
        await pingContentScript(tab.id);
        let xsrf = await getXsrfFromBbRouterCookie();
        if (!xsrf) {
          const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
          if (!authRes?.ok) {
            sendResponse({ ok: false, error: "No XSRF in BbRouter. Open Blackboard and log in.", items: [] });
            return;
          }
          xsrf = authRes.xsrf ?? null;
        }
        const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_CALENDAR_ITEMS", xsrf, since, until });
        sendResponse({ ok: res?.ok, items: res?.items || [], error: res?.error });
        return;
      }

      if (msg?.type === "GET_SYLLABI") {
        const data = await chrome.storage.local.get([
          "syllabi",
          "syllabiSyncedAt",
          "gradebookColumns",
          "gradebookByCourseId",
          "syncLog",
          REGISTRY_KEYS.coursesByCourseId,
          REGISTRY_KEYS.courseIdByNormalizedName,
          REGISTRY_KEYS.coursesList
        ]);
        sendResponse({
          ok: true,
          syllabi: data.syllabi || [],
          syllabiSyncedAt: data.syllabiSyncedAt ?? null,
          gradebookColumns: data.gradebookColumns || [],
          gradebookByCourseId: data.gradebookByCourseId || {},
          syncLog: data.syncLog || [],
          coursesByCourseId: data[REGISTRY_KEYS.coursesByCourseId] || {},
          courseIdByNormalizedName: data[REGISTRY_KEYS.courseIdByNormalizedName] || {},
          coursesList: data[REGISTRY_KEYS.coursesList] || []
        });
        return;
      }

      if (msg?.type === "GET_SYLLABUS_MANAGER_DATA") {
        try {
          const [coursesList, statuses, uploads] = await Promise.all([
            chrome.storage.local.get([REGISTRY_KEYS.coursesList]).then((d) => d[REGISTRY_KEYS.coursesList] || []),
            getAllSyllabusStatuses(),
            chrome.storage.local.get(["syllabusUploads"]).then((d) => d.syllabusUploads || {})
          ]);
          sendResponse({ ok: true, coursesList, statuses, uploads });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message, coursesList: [], statuses: {}, uploads: {} });
        }
        return;
      }

      if (msg?.type === "SYLLABUS_RECHECK") {
        const courseId = msg?.courseId;
        if (!courseId) {
          sendResponse({ ok: false, error: "courseId required" });
          return;
        }
        try {
          syllabusProcessedCache.delete(syllabusParsedCacheKey(courseId));
          const result = await getSyllabusWithDedup(courseId);
          const status = getSyllabusStatusFromFetch(result);
          await setSyllabusStatus(courseId, status);
          sendResponse({ ok: true, status });
        } catch (e) {
          await setSyllabusStatus(courseId, SyllabusStatus.UNKNOWN);
          sendResponse({ ok: false, error: e?.message, status: SyllabusStatus.UNKNOWN });
        }
        return;
      }

      if (msg?.type === "CHECK_SYLLABUS_AVAILABILITY") {
        (async () => {
          try {
            const userId = await getCurrentUserId();
            const [classResult, storage] = await Promise.all([
              getClassifiedCourses(userId, { debug: false }),
              chrome.storage.local.get([REGISTRY_KEYS.coursesList])
            ]);
            const items = classResult?.items || [];
            const q1q2Ids = new Set(
              items.filter((m) => m?.category === "Q1" || m?.category === "Q2").map((m) => m?.courseId).filter(Boolean)
            );
            const coursesList = storage[REGISTRY_KEYS.coursesList] || [];
            const registryIds = new Set(
              coursesList.map((c) => c.learnCourseId || c.courseId).filter(Boolean)
            );
            const courseIdsToCheck = [...registryIds].filter((id) => q1q2Ids.has(id));
            sendResponse({ ok: true, count: courseIdsToCheck.length });
            runSyllabusAvailabilityChecks(courseIdsToCheck).catch(() => {});
          } catch (e) {
            sendResponse({ ok: false, error: e?.message || "Could not start syllabus check", count: 0 });
          }
        })();
        return true;
      }

      if (msg?.type === "SYLLABUS_SAVE_UPLOAD") {
        const courseId = msg?.courseId;
        const { fileName, uploadDate, checksum, extractedText } = msg?.record || {};
        if (!courseId || extractedText == null) {
          sendResponse({ ok: false, error: "courseId and extractedText required" });
          return;
        }
        try {
          const chunks = chunkSyllabusText(extractedText);
          const record = {
            storageKey: String(courseId).trim(),
            fileName: fileName || "syllabus.pdf",
            mimeType: "application/pdf",
            uploadDate: uploadDate || new Date().toISOString(),
            checksum: checksum || "",
            extractedText: String(extractedText),
            chunks
          };
          await setUploadedSyllabus(courseId, record);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message });
        }
        return;
      }

      if (msg?.type === "SYLLABUS_REMOVE_UPLOAD") {
        const courseId = msg?.courseId;
        if (!courseId) {
          sendResponse({ ok: false, error: "courseId required" });
          return;
        }
        try {
          await removeUploadedSyllabus(courseId, SyllabusStatus.MISSING);
          try { await deletePdfBlob(courseId); } catch (_) {}
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message });
        }
        return;
      }

      /**
       * 3-step submission classification: GET #1 columns (from courseData), GET #2 grades (paginated),
       * GET #3 attempt details when lastAttemptId exists.
       * Rules (per column, in strict order):
       * - NO_GRADE_RECORD: column exists in assignments but no grade record in grades results.
       * - SCORE_PRESENT: grade record has a numeric score (displayGrade.score, averageScore, manualGrade/manualScore).
       * - NO_ATTEMPT_ID: grade record exists, no score, and no attempt id available.
       * - ATTEMPT_IN_PROGRESS: attempt exists and status === IN_PROGRESS (treat as not submitted).
       * - ATTEMPT_NOT_IN_PROGRESS: attempt exists and status !== IN_PROGRESS (treat as submitted).
       * - NOT_APPLICABLE_NON_ATTEMPT_BASED: column is not attempt-based.
       */
      async function buildSubmissionStatusWithAttempts(tabId, xsrf, courseId, userId, assignments) {
        const map = new Map();
        if (!assignments || assignments.length === 0) return map;
        let gradesRes;
        try {
          gradesRes = await chrome.tabs.sendMessage(tabId, {
            type: "FETCH_GRADEBOOK_GRADES",
            xsrf,
            courseId,
            userId
          });
        } catch (e) {
          return map;
        }
        if (!gradesRes?.ok || !Array.isArray(gradesRes.results)) return map;

        function looksNumeric(val) {
          if (val == null) return false;
          if (typeof val === "number") return !Number.isNaN(val);
          if (typeof val === "string") {
            const s = val.trim();
            if (!s) return false;
            return /^-?\d+(\.\d+)?$/.test(s);
          }
          return false;
        }

        function getScoreInfo(gradeRec) {
          const info = { hasScore: false, displayGradeScore: null, averageScore: null };
          if (!gradeRec || typeof gradeRec !== "object") return info;
          const displayGrade = gradeRec.displayGrade;
          if (displayGrade && typeof displayGrade === "object" && looksNumeric(displayGrade.score)) {
            info.hasScore = true;
            info.displayGradeScore = displayGrade.score;
            return info;
          }
          if (looksNumeric(gradeRec.averageScore)) {
            info.hasScore = true;
            info.averageScore = gradeRec.averageScore;
            return info;
          }
          if (looksNumeric(gradeRec.manualScore)) {
            info.hasScore = true;
            info.displayGradeScore = gradeRec.manualScore;
            return info;
          }
          if (looksNumeric(gradeRec.manualGrade)) {
            info.hasScore = true;
            info.displayGradeScore = gradeRec.manualGrade;
            return info;
          }
          return info;
        }
        const gradeByColId = new Map();
        for (const entry of gradesRes.results) {
          if (!entry || typeof entry !== "object") continue;
          const g = entry.grade ?? entry;
          const colId = g?.columnId ?? entry.columnId;
          if (colId != null) {
            const key = String(colId);
            if (!gradeByColId.has(key)) gradeByColId.set(key, { ...g, columnId: colId });
          }
        }
        for (const a of assignments) {
          const colId = a?.columnId ?? a?.id;
          if (!colId) continue;
          const key = String(colId);
          const isAttemptBased = a?.isAttemptBased === true;
          if (!isAttemptBased) {
            map.set(key, { submitted: null, reason: "NOT_APPLICABLE_NON_ATTEMPT_BASED" });
            continue;
          }
          const gradeRec = gradeByColId.get(key);
          if (!gradeRec) {
            map.set(key, { submitted: false, reason: "NO_GRADE_RECORD" });
            continue;
          }
          const scoreInfo = getScoreInfo(gradeRec);
          if (scoreInfo.hasScore) {
            map.set(key, {
              submitted: true,
              reason: "SCORE_PRESENT",
              attemptId: gradeRec.lastAttemptId ?? gradeRec.firstAttemptId ?? null,
              attemptStatus: undefined,
              displayGradeScore: scoreInfo.displayGradeScore,
              averageScore: scoreInfo.averageScore,
              gradeStatus: gradeRec.status != null ? String(gradeRec.status) : undefined
            });
            continue;
          }
          const lastAttemptId = gradeRec?.lastAttemptId ?? null;
          if (lastAttemptId == null) {
            map.set(key, { submitted: false, reason: "NO_ATTEMPT_ID" });
            continue;
          }
          let attemptStatus = null;
          try {
            const attemptRes = await chrome.tabs.sendMessage(tabId, {
              type: "FETCH_GRADEBOOK_ATTEMPT",
              xsrf,
              courseId,
              attemptId: lastAttemptId
            });
            if (attemptRes?.ok && attemptRes.status != null) attemptStatus = attemptRes.status;
          } catch (_) {}
          if (attemptStatus === "IN_PROGRESS") {
            map.set(key, { submitted: false, reason: "ATTEMPT_IN_PROGRESS", attemptId: lastAttemptId, attemptStatus });
          } else {
            map.set(key, { submitted: true, reason: "ATTEMPT_NOT_IN_PROGRESS", attemptId: lastAttemptId, attemptStatus });
          }
        }
        return map;
      }

      /** Pretty-print due dates for answers (fallback to raw string if parsing fails). */
      function formatDueDateForAnswer(dueDate) {
        if (!dueDate || typeof dueDate !== "string") return null;
        const s = dueDate.trim();
        if (!s) return null;
        const d = new Date(s);
        if (Number.isNaN(d.getTime())) return s;
        try {
          const day = String(d.getDate()).padStart(2, "0");
          const month = d.toLocaleString(undefined, { month: "short" });
          const year = d.getFullYear();
          const hours = String(d.getHours()).padStart(2, "0");
          const minutes = String(d.getMinutes()).padStart(2, "0");
          return day + " " + month + " " + year + ", " + hours + ":" + minutes;
        } catch (_) {
          return s;
        }
      }

      if (msg?.type === "GET_ASSIGNMENT_GRADE") {
        const userText = (msg?.userText ?? "").trim();
        if (!userText) {
          sendResponse({ ok: false, error: "Question text is missing.", responseText: null });
          return;
        }
        try {
          const data = await chrome.storage.local.get([
            "gradebookByCourseId",
            REGISTRY_KEYS.courseIdByNormalizedName,
            REGISTRY_KEYS.coursesByCourseId
          ]);
          const gradebookByCourseId = data.gradebookByCourseId || {};
          const courseIdByNormalizedName = data[REGISTRY_KEYS.courseIdByNormalizedName] || {};
          const coursesByCourseId = data[REGISTRY_KEYS.coursesByCourseId] || {};
          let userId = null;
          try {
            userId = await getCurrentUserId();
          } catch (_) {}
          const tab = await findAnyBlackboardTab();
          if (!tab?.id) {
            sendResponse({ ok: true, responseText: "I couldn't load your grades. Open Blackboard in a tab and make sure you're logged in." });
            return;
          }
          await pingContentScript(tab.id);
          let xsrf = await getXsrfFromBbRouterCookie();
          if (!xsrf) {
            const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
            xsrf = authRes?.ok ? (authRes.xsrf ?? null) : null;
          }
          const fetchGrades = (courseId, uid) =>
            chrome.tabs.sendMessage(tab.id, { type: "FETCH_GRADEBOOK_GRADES", xsrf, courseId, userId: uid });
          let submissionMap = null;
          let effectiveUserText = userText;
          const courseHint = (msg.courseHint && typeof msg.courseHint === "string" && msg.courseHint.trim().length >= 2)
            ? msg.courseHint.trim() : null;
          const allQuery = isAllGradesForCourseQuery(userText);
          // If pattern-based detection found a course, use it; otherwise fall back to LLM-extracted courseHint.
          const resolvedCourseMention = allQuery.isAll ? allQuery.courseMention : (courseHint || null);
          if (resolvedCourseMention && courseIdByNormalizedName && coursesByCourseId) {
            const course = resolveCourseByMention(resolvedCourseMention, courseIdByNormalizedName, coursesByCourseId);
            if (course) {
              const courseData = gradebookByCourseId[course.courseId];
              const assignments = courseData?.assignments || [];
              const submissionByColId = await buildSubmissionStatusWithAttempts(tab.id, xsrf, course.courseId, userId, assignments);
              submissionMap = Object.fromEntries(submissionByColId);
              // Rewrite userText to a canonical form that getAssignmentGrade will recognize as "all for course"
              if (!allQuery.isAll && courseHint) {
                effectiveUserText = "give me all assignments for " + courseHint;
              }
            }
          }
          const result = await getAssignmentGrade(effectiveUserText, {
            gradebookByCourseId,
            userId,
            fetchGrades,
            courseIdByNormalizedName,
            coursesByCourseId,
            submissionMap
          });
          if (typeof result === "object" && result != null && Array.isArray(result.assignmentItems)) {
            sendResponse({ ok: true, responseText: result.text, assignmentItems: result.assignmentItems });
          } else {
            sendResponse({ ok: true, responseText: String(result) });
          }
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "Grade lookup failed.", responseText: null });
        }
        return;
      }

      if (msg?.type === "GET_SINGLE_ASSIGNMENT_SUBMISSION_STATUS") {
        const userText = (msg?.userText ?? "").trim();
        if (!userText) {
          sendResponse({ ok: false, error: "Question text is missing.", responseText: null });
          return;
        }
        try {
          const data = await chrome.storage.local.get(["gradebookByCourseId"]);
          const gradebookByCourseId = data.gradebookByCourseId || {};

          let userId = null;
          try {
            userId = await getCurrentUserId();
          } catch (_) {}
          if (!userId) {
            sendResponse({
              ok: true,
              responseText: "I couldn't load your grades. Open Blackboard in a tab and make sure you're logged in."
            });
            return;
          }

          const tab = await findAnyBlackboardTab();
          if (!tab?.id) {
            sendResponse({
              ok: true,
              responseText: "Open Blackboard in a tab and make sure you're logged in so I can check submissions."
            });
            return;
          }
          await pingContentScript(tab.id);
          let xsrf = await getXsrfFromBbRouterCookie();
          if (!xsrf) {
            const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
            xsrf = authRes?.ok ? (authRes.xsrf ?? null) : null;
          }

          // Extract assignment mention from phrases like "did I submit X", "have I submitted X", etc.
          function extractAssignmentMention(text) {
            const patterns = [
              /\bdid\s+i\s+(?:already\s+)?submit\s+(.+?)(\?|$)/i,
              /\bhave\s+i\s+(?:already\s+)?submitted\s+(.+?)(\?|$)/i,
              /\bhave\s+i\s+(?:already\s+)?turned\s+in\s+(.+?)(\?|$)/i,
              /\bdid\s+i\s+(?:already\s+)?hand\s+in\s+(.+?)(\?|$)/i
            ];
            for (const re of patterns) {
              const m = text.match(re);
              if (m && m[1]) return m[1].trim();
            }
            return text.trim();
          }

          const assignmentQuery = extractAssignmentMention(userText);
          const items = buildGradeItemList(gradebookByCourseId);
          if (!items.length) {
            sendResponse({
              ok: true,
              responseText: "I couldn't find any assignments in your gradebook. Sync gradebook and try again."
            });
            return;
          }
          const best = findBestMatch(assignmentQuery, items, 0.4);
          if (!best || best.index < 0) {
            sendResponse({
              ok: true,
              responseText: "I couldn't find an assignment matching '" + assignmentQuery + "'. Try using the exact assignment name."
            });
            return;
          }
          const match = items[best.index];
          const courseId = match.courseId;
          const columnId = match.columnId;
          const courseName = match.courseName || courseId;
          const title = match.title || String(columnId);

          const courseData = gradebookByCourseId[courseId] || {};
          const assignments = courseData?.assignments || [];

          const submissionByColId = await buildSubmissionStatusWithAttempts(tab.id, xsrf, courseId, userId, assignments);
          const s = submissionByColId.get(String(columnId));

          let submitted = false;
          let reason = "NO_GRADE_RECORD";
          let attemptId = null;
          let attemptStatus = null;
          if (s) {
            submitted = s.submitted;
            reason = s.reason;
            attemptId = s.attemptId ?? null;
            attemptStatus = s.attemptStatus ?? null;
          }

          let responseText;
          if (submitted === null) {
            responseText =
              "The item '" +
              title +
              "' in " +
              courseName +
              " is not an attempt-based assignment, so submission does not apply.";
          } else if (submitted === true) {
            responseText =
              "Yes, you have submitted '" +
              title +
              "' in " +
              courseName +
              ". (Reason: " +
              reason +
              (attemptStatus ? ", attempt status: " + attemptStatus : "") +
              ".)";
          } else {
            responseText =
              "No, you have not submitted '" +
              title +
              "' in " +
              courseName +
              " yet. (Reason: " +
              reason +
              (attemptStatus ? ", attempt status: " + attemptStatus : "") +
              ".)";
          }

          sendResponse({
            ok: true,
            responseText,
            courseId,
            userId,
            columnId: String(columnId),
            assignmentName: title,
            submitted,
            reason,
            attemptId,
            attemptStatus
          });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e?.message || "Single assignment submission check failed.",
            responseText: null
          });
        }
        return;
      }

      if (msg?.type === "GET_ASSIGNMENT_SUBMISSION_STATUS") {
        const userText = (msg?.userText ?? "").trim();
        if (!userText) {
          sendResponse({ ok: false, error: "Question text is missing.", responseText: null });
          return;
        }
        try {
          const resolution = await resolveCourseInBackground(userText, { courseHint: msg.courseHint });
          if (!resolution.ok) {
            sendResponse({
              ok: false,
              error: resolution.message || "Could not identify the course.",
              responseText: null,
              suggestions: resolution.suggestions
            });
            return;
          }
          const { courseId, name: courseName } = { courseId: resolution.courseId, name: resolution.name };

          const data = await chrome.storage.local.get(["gradebookByCourseId"]);
          const gradebookByCourseId = data.gradebookByCourseId || {};

          let userId = null;
          try {
            userId = await getCurrentUserId();
          } catch (_) {}
          if (!userId) {
            sendResponse({
              ok: true,
              responseText: "I couldn't load your grades. Open Blackboard in a tab and make sure you're logged in."
            });
            return;
          }

          const tab = await findAnyBlackboardTab();
          if (!tab?.id) {
            sendResponse({
              ok: true,
              responseText: "Open Blackboard in a tab and make sure you're logged in so I can check submissions."
            });
            return;
          }
          await pingContentScript(tab.id);
          let xsrf = await getXsrfFromBbRouterCookie();
          if (!xsrf) {
            const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
            xsrf = authRes?.ok ? (authRes.xsrf ?? null) : null;
          }

          const courseData = gradebookByCourseId[courseId] || {};
          const assignments = courseData?.assignments || [];
          const submissionByColId = await buildSubmissionStatusWithAttempts(tab.id, xsrf, courseId, userId, assignments);

          const items = [];
          for (const a of assignments) {
            const colId = a?.columnId ?? a?.id;
            if (!colId) continue;
            const title = (a?.title ?? a?.name ?? "").trim() || String(colId);
            const s = submissionByColId.get(String(colId));
            let submitted = undefined;
            let reason = undefined;
            if (s) {
              submitted = s.submitted;
              reason = s.reason;
            } else {
              submitted = false;
              reason = "NO_GRADE_RECORD";
            }
            items.push({
              columnId: String(colId),
              title,
              submitted,
              reason,
              dueDate: a?.dueDate ?? a?.dueDateRaw ?? null,
              url: a?.urlOpcional ?? null
            });
          }

          // Pending = attempt-based items not submitted: NO_GRADE_RECORD, NO_ATTEMPT_ID, or ATTEMPT_IN_PROGRESS.
          const pending = items.filter(
            (it) =>
              it.submitted === false &&
              (it.reason === "NO_GRADE_RECORD" || it.reason === "NO_ATTEMPT_ID" || it.reason === "ATTEMPT_IN_PROGRESS")
          );
          const submittedItems = items.filter((it) => it.submitted === true);

          let responseText;
          const courseLabel = courseName || courseId || "this course";
          if (pending.length === 0) {
            if (submittedItems.length === 0) {
              responseText =
                "For " +
                courseLabel +
                ", I could not find any assignments that still need to be submitted.";
            } else {
              responseText =
                "You do not appear to have anything left to submit for " +
                courseLabel +
                ". All assignments I can see either have submissions or do not require a submission record.";
            }
          } else {
            responseText =
              "You still have items left to submit for " +
              courseLabel +
              ":\n" +
              pending
                .map((it) => {
                  const pretty = formatDueDateForAnswer(it.dueDate);
                  const duePart = pretty ? " (due: " + pretty + ")" : "";
                  return "• " + it.title + duePart + " (not submitted)";
                })
                .join("\n");
          }

          const assignmentItems = pending.map((it) => ({
            title: it.title,
            courseId,
            url: it.url || ("https://blackboard.ie.edu/ultra/courses/" + encodeURIComponent(courseId) + "/grades")
          }));
          sendResponse({ ok: true, responseText, assignmentItems });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e?.message || "Submission status lookup failed.",
            responseText: null
          });
        }
        return;
      }

      if (msg?.type === "GET_ASSIGNMENT_SUBMISSION_STATUS_ALL") {
        const userText = (msg?.userText ?? "").trim();
        try {
          const data = await chrome.storage.local.get([
            "gradebookByCourseId",
            REGISTRY_KEYS.coursesByCourseId
          ]);
          const gradebookByCourseId = data.gradebookByCourseId || {};
          const coursesByCourseId = data[REGISTRY_KEYS.coursesByCourseId] || {};

          let userId = null;
          try {
            userId = await getCurrentUserId();
          } catch (_) {}
          if (!userId) {
            sendResponse({
              ok: true,
              responseText: "I couldn't load your grades. Open Blackboard in a tab and make sure you're logged in."
            });
            return;
          }

          const tab = await findAnyBlackboardTab();
          if (!tab?.id) {
            sendResponse({
              ok: true,
              responseText: "Open Blackboard in a tab and make sure you're logged in so I can check submissions."
            });
            return;
          }
          await pingContentScript(tab.id);
          let xsrf = await getXsrfFromBbRouterCookie();
          if (!xsrf) {
            const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
            xsrf = authRes?.ok ? (authRes.xsrf ?? null) : null;
          }

          /** @type {Array<{ courseId: string, courseName: string, title: string, url?: string | null }>} */
          const globalPending = [];

          for (const [courseId, courseData] of Object.entries(gradebookByCourseId)) {
            const assignments = (courseData && courseData.assignments) || [];
            if (!assignments.length) continue;
            const courseName = courseData?.courseName || coursesByCourseId[courseId]?.name || courseId;

            const submissionByColId = await buildSubmissionStatusWithAttempts(tab.id, xsrf, courseId, userId, assignments);

            for (const a of assignments) {
              const colId = a?.columnId ?? a?.id;
              if (!colId) continue;
              const title = (a?.title ?? a?.name ?? "").trim() || String(colId);
              const s = submissionByColId.get(String(colId));
              let submitted = false;
              let reason = "NO_GRADE_RECORD";
              if (s) {
                submitted = s.submitted;
                reason = s.reason;
              }
              if (submitted === false && (reason === "NO_GRADE_RECORD" || reason === "NO_ATTEMPT_ID" || reason === "ATTEMPT_IN_PROGRESS")) {
                globalPending.push({
                  courseId,
                  courseName,
                  title,
                  dueDate: a?.dueDate ?? a?.dueDateRaw ?? null,
                  url: a?.urlOpcional ?? null
                });
              }
            }
          }

          let responseText;
          if (globalPending.length === 0) {
            responseText =
              "You do not appear to have any assignments left to submit across your courses.";
          } else {
            responseText =
              "You still have assignments left to submit across your courses:\n" +
              globalPending
                .map((it) => {
                  const pretty = formatDueDateForAnswer(it.dueDate);
                  const duePart = pretty ? " (due: " + pretty + ")" : "";
                  return "• " + it.courseName + ": " + it.title + duePart + " (not submitted)";
                })
                .join("\n");
          }

          const assignmentItems = globalPending.map((it) => ({
            courseName: it.courseName,
            courseId: it.courseId,
            title: it.title,
            url: it.url || ("https://blackboard.ie.edu/ultra/courses/" + encodeURIComponent(it.courseId) + "/grades")
          }));
          sendResponse({ ok: true, responseText, assignmentItems });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e?.message || "Global submission status lookup failed.",
            responseText: null
          });
        }
        return;
      }

      if (msg?.type === "COURSE_MESSAGES_EXECUTE") {
        const plan = msg?.plan;
        const courseId = msg?.courseId;
        const courseName = msg?.courseName ?? plan?.course?.name ?? "";
        if (!plan || !courseId) {
          sendResponse({ ok: false, error: "Missing plan or courseId.", responseText: null });
          return;
        }
        try {
          const tab = await findAnyBlackboardTab();
          if (!tab?.id) {
            sendResponse({ ok: true, responseText: "Open Blackboard in a tab and make sure you're logged in to load course messages." });
            return;
          }
          await pingContentScript(tab.id);
          let xsrf = await getXsrfFromBbRouterCookie();
          if (!xsrf) {
            const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
            xsrf = authRes?.ok ? (authRes.xsrf ?? null) : null;
          }
          const fetchConversations = (cid) =>
            chrome.tabs.sendMessage(tab.id, { type: "FETCH_COURSE_CONVERSATIONS", xsrf, courseId: cid });
          const { normalized, indexes } = await getOrFetchConversations(courseId, fetchConversations, {
            forceRefresh: Boolean(plan.needsRefresh)
          });
          const result = executePlan(plan, normalized, indexes);
          const responseText = formatCourseMessagesResponse(plan, result, courseName);
          sendResponse({ ok: true, responseText });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "Course messages failed.", responseText: null });
        }
        return;
      }

      if (msg?.type === "COURSE_MESSAGES_EXECUTE_GLOBAL") {
        const plan = msg?.plan;
        if (!plan) {
          sendResponse({ ok: false, error: "Missing plan.", responseText: null });
          return;
        }
        try {
          const tab = await findAnyBlackboardTab();
          if (!tab?.id) {
            sendResponse({
              ok: true,
              responseText: "Open Blackboard in a tab and make sure you're logged in to load messages."
            });
            return;
          }
          await pingContentScript(tab.id);
          let xsrf = await getXsrfFromBbRouterCookie();
          if (!xsrf) {
            const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
            xsrf = authRes?.ok ? (authRes.xsrf ?? null) : null;
          }
          const data = await chrome.storage.local.get([REGISTRY_KEYS.coursesList, REGISTRY_KEYS.coursesByCourseId]);
          const coursesList = data[REGISTRY_KEYS.coursesList] || [];
          const coursesByCourseId = data[REGISTRY_KEYS.coursesByCourseId] || {};
          const allCourses = coursesList.length
            ? coursesList.map((c) => ({ id: c.learnCourseId, name: c.name }))
            : Object.keys(coursesByCourseId).map((cid) => ({ id: cid, name: coursesByCourseId[cid]?.name || cid }));

          if (!allCourses.length) {
            sendResponse({
              ok: true,
              responseText: "There are no courses with messages to load."
            });
            return;
          }

          const fetchConversations = (cid) =>
            chrome.tabs.sendMessage(tab.id, { type: "FETCH_COURSE_CONVERSATIONS", xsrf, courseId: cid });

          const aggregate = [];

          function formatGlobalMessagesResponse(messages) {
            if (!messages || messages.length === 0) {
              return "No messages found across your courses.";
            }
            const header = messages.length === 1
              ? "Last message across all courses:"
              : "Latest " + messages.length + " message(s) across all courses:";
            const lines = messages.map((m) => {
              const course = m.__courseName || "Unknown course";
              const d = m.postDateISO ? new Date(m.postDateISO) : null;
              const dateStr = d && !Number.isNaN(d.getTime())
                ? d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
                : "—";
              const sender = m.senderName || m.senderUsername || "Unknown";
              const preview = m.textPreview || "(no text)";
              const readStatus = m.isRead ? "Read" : "Unread";
              const link = m.webLocation ? "\nLink: " + m.webLocation : "";
              return course + "\n" + dateStr + " — " + sender + "\n\"" + preview + "\"\nStatus: " + readStatus + link;
            });
            return header + "\n\n" + lines.join("\n\n---\n\n");
          }

          for (const c of allCourses) {
            try {
              const { normalized, indexes } = await getOrFetchConversations(c.id, fetchConversations, {
                forceRefresh: Boolean(plan.needsRefresh)
              });
              const resultForCourse = executePlan(plan, normalized, indexes);
              const items = Array.isArray(resultForCourse?.messages) ? resultForCourse.messages : [];
              for (const msg of items) {
                if (!msg) continue;
                aggregate.push({
                  ...msg,
                  __courseName: c.name || c.id
                });
              }
            } catch (_) {
              // Ignore courses that fail to load messages.
            }
          }

          if (aggregate.length === 0) {
            sendResponse({
              ok: true,
              responseText: "No messages found across your courses."
            });
            return;
          }

          aggregate.sort((a, b) => (b.postDateEpoch || 0) - (a.postDateEpoch || 0));
          const maxItems = Math.min(50, Math.max(1, Number(plan?.limit) || 5));
          const selected = aggregate.slice(0, maxItems);
          const responseText = formatGlobalMessagesResponse(selected);
          sendResponse({ ok: true, responseText });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "Global messages failed.", responseText: null });
        }
        return;
      }

      if (msg?.type === "GET_WIDGET_MESSAGES") {
        // Widget only reads from cache (same as assignments: data is refreshed in background via SYNC_WIDGET_MESSAGES).
        (async () => {
          try {
            const stored = await chrome.storage.local.get([MESSAGES_WIDGET_CACHE_KEY]);
            const entry = stored[MESSAGES_WIDGET_CACHE_KEY];
            if (entry && Array.isArray(entry.items)) {
              sendResponse({ ok: true, items: entry.items });
              return;
            }
            sendResponse({ ok: true, items: [] });
            // Optionally kick a background refresh so next time we have data (fire-and-forget).
            refreshWidgetMessagesCache().catch(() => {});
          } catch (_) {
            sendResponse({ ok: true, items: [] });
          }
        })();
        return true;
      }

      if (msg?.type === "SYNC_WIDGET_MESSAGES") {
        // Refresh messages widget cache in background (like SYNC_GRADEBOOK_ONLY for assignments). No blocking.
        sendResponse({ ok: true });
        refreshWidgetMessagesCache().catch(() => {});
        return true;
      }

      if (msg?.type === "GET_MESSAGES_FOR_PANEL") {
        (async () => {
          try {
            const tab = await findAnyBlackboardTab();
            if (!tab?.id) {
              sendResponse({ ok: true, data: [] });
              return;
            }
            await pingContentScript(tab.id);
            let xsrf = await getXsrfFromBbRouterCookie();
            if (!xsrf) {
              const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
              xsrf = authRes?.ok ? (authRes.xsrf ?? null) : null;
            }
            const data = await chrome.storage.local.get([REGISTRY_KEYS.coursesList, REGISTRY_KEYS.coursesByCourseId]);
            const coursesList = data[REGISTRY_KEYS.coursesList] || [];
            const coursesByCourseId = data[REGISTRY_KEYS.coursesByCourseId] || {};
            const allCourses = coursesList.length
              ? coursesList.map((c) => ({ id: c.learnCourseId, name: c.name }))
              : Object.keys(coursesByCourseId).map((cid) => ({ id: cid, name: coursesByCourseId[cid]?.name || cid }));

            if (!allCourses.length) {
              sendResponse({ ok: true, data: [] });
              return;
            }

            const fetchConversations = (cid) =>
              chrome.tabs.sendMessage(tab.id, { type: "FETCH_COURSE_CONVERSATIONS", xsrf, courseId: cid });

            const groups = [];
            const LIMIT_PER_COURSE = 30;

            for (const c of allCourses) {
              try {
                const { normalized, indexes } = await getOrFetchConversations(c.id, fetchConversations, {
                  forceRefresh: false
                });
                const { byDate } = indexes;
                if (!byDate || byDate.length === 0) continue;
                const items = [];
                const takeCount = Math.min(LIMIT_PER_COURSE, byDate.length);
                for (let i = 0; i < takeCount; i++) {
                  const idx = byDate[i].i;
                  const m = normalized.messages[idx];
                  if (!m) continue;
                  const dateISO = m.postDateISO || m.postDate || "";
                  let url = null;
                  const convId = m.conversationId || m.messageId || "";
                  if (c.id && convId) {
                    const cidEnc = encodeURIComponent(c.id);
                    const convEnc = encodeURIComponent(convId);
                    url =
                      "https://blackboard.ie.edu/ultra/courses/" +
                      cidEnc +
                      "/messages/edit/" +
                      convEnc +
                      "?courseId=" +
                      cidEnc +
                      "&offset=0&count=2";
                  }
                  const title = m.textPreview || "Message";
                  items.push({ title, dateISO, url });
                }
                if (items.length > 0) {
                  groups.push({ courseId: c.id, courseName: c.name, messages: items });
                }
              } catch (_) {
                // ignore errors per course
              }
            }

            sendResponse({ ok: true, data: groups });
          } catch (e) {
            sendResponse({ ok: false, error: e?.message || "Messages panel failed.", data: [] });
          }
        })();
        return true;
      }

      if (msg?.type === "GET_COURSE_REGISTRY") {
        const data = await chrome.storage.local.get([
          REGISTRY_KEYS.coursesByCourseId,
          REGISTRY_KEYS.courseIdByNormalizedName,
          REGISTRY_KEYS.coursesList,
          REGISTRY_KEYS.syncedAt
        ]);
        sendResponse({
          ok: true,
          coursesByCourseId: data[REGISTRY_KEYS.coursesByCourseId] || {},
          courseIdByNormalizedName: data[REGISTRY_KEYS.courseIdByNormalizedName] || {},
          coursesList: data[REGISTRY_KEYS.coursesList] || [],
          syncedAt: data[REGISTRY_KEYS.syncedAt] ?? null
        });
        return;
      }

      if (msg?.type === "GET_SYLLABUS") {
        const courseId = msg?.courseId;
        if (!courseId) {
          sendResponse({ ok: false, error: "courseId required", details: {} });
          return;
        }
        getSyllabusWithDedup(courseId).then(async (result) => {
          const status = getSyllabusStatusFromFetch(result);
          await setSyllabusStatus(courseId, status);
          if (result.ok) sendResponse({ ok: true, html: result.html, details: { ...result.details, syllabusStatus: status } });
          else sendResponse({ ok: false, error: result.error, details: { ...(result.details || {}), syllabusStatus: status } });
        }).catch(async (e) => {
          await setSyllabusStatus(courseId, SyllabusStatus.UNKNOWN);
          sendResponse({ ok: false, error: e?.message || "Error fetching syllabus", details: { syllabusStatus: SyllabusStatus.UNKNOWN } });
        });
        return;
      }

      if (msg?.type === "GET_SYLLABUS_RAW_TEXT") {
        const courseId = msg?.courseId;
        const courseName = msg?.courseName || "";
        if (!courseId) {
          sendResponse({ ok: false, error: "courseId required", rawText: "", source: "" });
          return;
        }
        try {
          const structured = await getSyllabusStructuredPreferred(courseId, courseName, { strictCourseId: true });
          const uploaded = await getUploadedSyllabus(courseId);
          const rawText = structured?.rawText || "";
          const source = uploaded?.extractedText ? "uploaded syllabus PDF" : "Blackboard endpoint";
          sendResponse({ ok: true, rawText, source, courseName: courseName || structured?.courseTitle || courseId });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "Error fetching syllabus text", rawText: "", source: "" });
        }
        return;
      }

      if (msg?.type === "GET_MIDTERM_SESSIONS") {
        try {
          const result = await refreshMidtermData();
          if (!result.ok) {
            sendResponse({ ok: false, error: result.error || "GET_MIDTERM_SESSIONS failed", items: [] });
            return;
          }
          sendResponse({
            ok: true,
            items: result.sessionItems,
            semester: result.semester,
            currentSemester: result.currentSemester
          });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "GET_MIDTERM_SESSIONS failed", items: [] });
        }
        return;
      }

      if (msg?.type === "GET_FINAL_SESSIONS") {
        try {
          const result = await refreshFinalData();
          if (!result.ok) {
            sendResponse({ ok: false, error: result.error || "GET_FINAL_SESSIONS failed", items: [] });
            return;
          }
          sendResponse({
            ok: true,
            items: result.sessionItems,
            semester: result.semester,
            currentSemester: result.currentSemester
          });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "GET_FINAL_SESSIONS failed", items: [] });
        }
        return;
      }

      if (msg?.type === "GET_FINAL_DATES") {
        const userText = (msg?.userText ?? "").trim();
        const singleCourseId = msg?.courseId ?? null;
        try {
          let items = [];
          let semester = null;
          let currentSemester = null;
          const stored = await chrome.storage.local.get(FINAL_DATES_CACHE_KEY);
          const cache = stored[FINAL_DATES_CACHE_KEY];
          const now = Date.now();
          const cacheValid = cache?.items && cache.updatedAt != null && (now - cache.updatedAt) < FINAL_DATES_CACHE_TTL_MS;
          if (cacheValid) {
            items = cache.items;
            semester = cache.semester;
            currentSemester = cache.currentSemester;
          } else {
            const result = await refreshFinalData();
            if (result.ok) {
              items = result.dateItems;
              semester = result.semester;
              currentSemester = result.currentSemester;
            } else if (cache?.items) {
              items = cache.items;
              semester = cache.semester;
              currentSemester = cache.currentSemester;
            }
          }

          if (userText) {
            if (items.length === 0) {
              refreshFinalData().catch(() => {});
              sendResponse({
                ok: true,
                answer: "Please wait a few seconds for final exam dates to load. You can open Options > Final dates and click Refresh, or try your question again in a moment."
              });
              return;
            }
            let filtered = items;
            if (singleCourseId) {
              filtered = items.filter((it) => it.courseId === singleCourseId);
            }
            let answer;
            if (filtered.length === 0) {
              answer = singleCourseId
                ? "No final exam data in the database for this course. Open Options > Final dates and click Refresh."
                : "No final exam data in the database for the current semester. Open Options > Final dates and click Refresh.";
            } else if (singleCourseId && filtered.length === 1) {
              answer = buildSingleFinalExamAnswerEnglish(filtered[0]);
            } else {
              answer = buildDeterministicFinalExamReplyEnglish(filtered);
            }
            sendResponse({ ok: true, answer, semester, items: filtered });
            return;
          }

          sendResponse({
            ok: true,
            items,
            semester: semester || cache?.semester,
            currentSemester: currentSemester ?? cache?.currentSemester,
            fromCache: !!cacheValid,
            updatedAt: cache?.updatedAt ?? null
          });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "Could not load final dates.", items: [] });
        }
        return;
      }

      if (msg?.type === "GET_FINAL_DATES_CACHE") {
        const data = await chrome.storage.local.get([FINAL_DATES_CACHE_KEY]);
        const cache = data[FINAL_DATES_CACHE_KEY] || null;
        sendResponse({ ok: true, cache });
        return;
      }

      if (msg?.type === "GET_MIDTERM_DATES") {
        const userText = (msg?.userText ?? "").trim();
        const singleCourseId = msg?.courseId ?? null;
        try {
          let items = [];
          let semester = null;
          let currentSemester = null;
          const stored = await chrome.storage.local.get(MIDTERM_DATES_CACHE_KEY);
          const cache = stored[MIDTERM_DATES_CACHE_KEY];
          const now = Date.now();
          const cacheValid = cache?.items && cache.updatedAt != null && (now - cache.updatedAt) < MIDTERM_DATES_CACHE_TTL_MS;
          if (cacheValid) {
            items = cache.items;
            semester = cache.semester;
            currentSemester = cache.currentSemester;
          } else {
            const result = await refreshMidtermData();
            if (result.ok) {
              items = result.dateItems;
              semester = result.semester;
              currentSemester = result.currentSemester;
            } else if (cache?.items) {
              items = cache.items;
              semester = cache.semester;
              currentSemester = cache.currentSemester;
            }
          }

          if (userText) {
            if (items.length === 0) {
              refreshMidtermData().catch(() => {});
              sendResponse({
                ok: true,
                answer: "Please wait a few seconds for midterm dates to load. You can open Options > Midterm dates and click Refresh, or try your question again in a moment."
              });
              return;
            }
            let filtered = items;
            if (singleCourseId) {
              filtered = items.filter((it) => it.courseId === singleCourseId);
            }
            let answer;
            if (filtered.length === 0) {
              answer = singleCourseId
                ? "No midterm data in the database for this course. Open Options > Midterm dates and click Refresh."
                : "No midterm data in the database for the current semester. Open Options > Midterm dates and click Refresh.";
            } else if (singleCourseId && filtered.length === 1) {
              answer = buildSingleMidtermExamAnswerEnglish(filtered[0]);
            } else {
              answer = buildDeterministicMidtermExamReplyEnglish(filtered);
            }
            sendResponse({ ok: true, answer, semester, items: filtered });
            return;
          }

          sendResponse({
            ok: true,
            items,
            semester: semester || cache?.semester,
            currentSemester: currentSemester ?? cache?.currentSemester,
            fromCache: !!cacheValid,
            updatedAt: cache?.updatedAt ?? null
          });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "Could not load midterm dates.", items: [], semester: null });
        }
        return;
      }

      if (msg?.type === "SYLLABUS_QUESTION") {
        const userText = (msg?.userText ?? "").trim();
        if (!userText) {
          sendResponse({ ok: false, error: "Question text is missing." });
          return;
        }
        const recentOpts = { recentMessages: msg.recentMessages, courseHint: msg.courseHint };
        let resolution = await resolveCourseInBackground(userText, recentOpts);
        if (!resolution.ok) {
          const short = (msg.courseHint && msg.courseHint.trim().length >= 2 ? msg.courseHint.trim() : null) || extractShortCourseNameForRetry(userText);
          if (short && short.length >= 2) {
            resolution = await resolveCourseInBackground("what is the syllabus of " + short, recentOpts);
          }
        }
        if (!resolution.ok) {
          sendResponse({ ok: false, fallThroughToChat: true, error: "COURSE_UNRESOLVED" });
          return;
        }
        let courseId = resolution.courseId;
        const courseName = resolution.name || "";
        const recentBlob = flattenRecentMessagesForCourseResolution(msg.recentMessages);
        const intent = classifySyllabusQuestionWithContext(userText, recentBlob);
        const effectiveUserText = buildEffectiveSyllabusUserText(userText, courseName, intent);
        let fullContext = "";
        let sourceAttribution = "Blackboard syllabus";
        let syllabusDisclaimer = "";
        let structured = null;
        let structuredCourseTitle = "";

        let uploaded = await getUploadedSyllabus(courseId);
        const usedUploadByNameFallback = false;
        if (uploaded?.extractedText) {
          if (!uploaded.chunks?.length || !uploaded.chunks.some((c) => c.sessionNumber != null)) {
            uploaded.chunks = chunkSyllabusText(uploaded.extractedText);
          }
          fullContext = getRelevantChunks(uploaded, effectiveUserText, { maxChunks: 10 });
          if (!fullContext && uploaded.extractedText) fullContext = uploaded.extractedText.slice(0, 15000);
          sourceAttribution = "uploaded syllabus PDF";
        } else {
          try {
            structured = await getSyllabusStructuredPreferred(courseId, courseName, { strictCourseId: true });
            structuredCourseTitle = (structured && structured.courseTitle) || "";
            // Validate: if the document's own title clearly belongs to a different course, discard it.
            if (structuredCourseTitle && !syllabusCourseTitleMatches(structuredCourseTitle, courseName)) {
              console.warn("[SYLLABUS_QUESTION] Title mismatch — fetched '" + structuredCourseTitle + "' for course '" + courseName + "'. Discarding.");
              structured = null;
              structuredCourseTitle = "";
              syllabusDisclaimer = "The syllabus on file appears to be for a different course. Check Blackboard directly or upload the correct PDF in Options → Syllabus Manager.\n\n";
              fullContext = "";
            } else {
              fullContext = buildFullSyllabusContext(structured, { canonicalCourseName: courseName });
            }
          } catch (e) {
            structured = null;
            structuredCourseTitle = "";
            const statusEntry = await getSyllabusStatus(courseId);
            syllabusDisclaimer =
              "Blackboard shows the syllabus is not available for this course. If you upload the syllabus PDF in Settings → Syllabus Manager, I can answer accurately.\n\n";
            fullContext = "";
          }
        }

        if (structured && fullContext) {
          if (intent.type === "session" && intent.sessionNumber != null) {
            const focused = searchSyllabusStructure(structured, effectiveUserText, intent);
            fullContext =
              "--- PRIORITY EXCERPT FOR SESSION " +
              intent.sessionNumber +
              " (read this first; same course as the full syllabus below) ---\n" +
              focused +
              "\n\n--- FULL SYLLABUS CONTEXT ---\n" +
              fullContext;
          }
        }

        // [SYLLABUS_DEBUG] Check extension Service Worker console (chrome://extensions → Jarvis → Service worker → Inspect)
        console.log("[SYLLABUS_DEBUG] courseId:", courseId, "| courseName:", courseName);
        console.log("[SYLLABUS_DEBUG] source:", sourceAttribution, "| uploadFoundByNameFallback:", usedUploadByNameFallback);
        console.log("[SYLLABUS_DEBUG] chunks count:", uploaded?.chunks?.length || 0, "| session chunks:", (uploaded?.chunks || []).filter(c => c.sessionNumber != null).map(c => "S" + c.sessionNumber).join(","));
        console.log("[SYLLABUS_DEBUG] fullContext length:", (fullContext || "").length, "| preview:", (fullContext || "").slice(0, 400).replace(/\n/g, " ") + ((fullContext || "").length > 400 ? "..." : ""));

        let announcementsBlock = null;
        try {
          announcementsBlock = await getAnnouncementsKnowledgeForCourse(courseId, effectiveUserText);
        } catch (_) {
          announcementsBlock = null;
        }
        const storage = await chrome.storage.local.get("openrouterApiKey");
        const apiKey = (storage.openrouterApiKey ?? "").trim();
        if (!apiKey) {
          sendResponse({ ok: false, error: "Set your OpenRouter API Key in settings to get syllabus answers." });
          return;
        }
        if (!fullContext && !announcementsBlock) {
          const statusEntry = await getSyllabusStatus(courseId);
          if (statusEntry.status === SyllabusStatus.MISSING || statusEntry.status === SyllabusStatus.UNKNOWN) {
            sendResponse({
              ok: true,
              answer: syllabusDisclaimer +
                "I don't have syllabus content for this course. Upload your syllabus PDF in Settings → Syllabus Manager so I can answer course questions accurately."
            });
            return;
          }
        }
        let systemContent =
          "You are an assistant that answers questions about a course syllabus. Below you are given syllabus content (Source: " + sourceAttribution + "). "
          + "You must answer ONLY with information that appears in this document. Do not make up data or use external information. "
          + "When the user asks 'What is the content of session X of [course]?' or 'What is session X of [course] about?', use the syllabus content to find that session and answer. "
          + "If the answer is not in the text provided, say explicitly that this information was not found in the syllabus. "
          + "Respond clearly, precisely and concisely in English. Do not use asterisks (*) in your response; use plain text only.\n\n"
          + "COURSE ANCHOR (authoritative): This syllabus was fetched for Blackboard course \"" + courseName + "\" (courseId \"" + courseId + "\"). "
          + "The HTML document title line may read: \"" + (structuredCourseTitle || courseName) + "\". "
          + "If that title differs from \"" + courseName + "\", still treat the syllabus body and PROGRAM/SESSIONS as belonging to \"" + courseName + "\" for this courseId. "
          + "Do not claim the syllabus is for a different course because of a mismatched heading or another course name elsewhere in the page; ignore navigation, template text, or footers that mention other subjects. "
          + "When the user refers to \"that session\", \"this session\", or similar without naming the course, use the course and session from the recent conversation messages below (if any).\n\n";
        if (syllabusDisclaimer) systemContent += syllabusDisclaimer;
        systemContent += fullContext || "(No syllabus text available.)";
        if (announcementsBlock !== null) {
          systemContent += "\n\nCourse announcements (Blackboard announcements for this course):\n"
            + (announcementsBlock || "(No announcements for this course.)")
            + "\n\nRules: If announcements mention changes, new instructions, or due dates, treat them as higher priority than older syllabus text. If both syllabus and announcements provide info, merge them and explain clearly. If conflicting info exists, prefer the newest announcement; mention it is the newest source and include its date.";
        } else {
          systemContent += "\n\n(Announcements for this course could not be loaded; answer using syllabus only.)";
        }
        const recentTurns = [];
        if (Array.isArray(msg?.recentMessages)) {
          for (const m of msg.recentMessages) {
            if (!m || typeof m !== "object") continue;
            const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : null;
            if (!role) continue;
            const content = String(m.content || "").trim();
            if (!content) continue;
            recentTurns.push({ role, content: content.slice(0, 4000) });
          }
        }
        const messages = [{ role: "system", content: systemContent }];
        for (const turn of recentTurns.slice(-10)) {
          messages.push(turn);
        }
        messages.push({ role: "user", content: effectiveUserText });
        try {
          const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + apiKey,
              "HTTP-Referer": "https://blackboard.ie.edu"
            },
            body: JSON.stringify({
              model: msg?.model || "anthropic/claude-haiku-4.5",
              messages,
              max_tokens: 1024
            })
          });
          const rawBody = await res.text();
          if (!res.ok) {
            sendResponse({ ok: false, error: "OpenRouter: " + (rawBody.slice(0, 200) || res.status) });
            return;
          }
          const data = JSON.parse(rawBody);
          const answer = (data?.choices?.[0]?.message?.content ?? "").trim() || "Could not generate a response.";
          sendResponse({ ok: true, answer });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "Error calling the model." });
        }
        return;
      }

      if (msg?.type === "ANNOUNCEMENTS_ONLY_QUESTION") {
        const userText = (msg?.userText ?? "").trim();
        if (!userText) {
          sendResponse({ ok: false, error: "Question text is missing." });
          return;
        }
        const resolution = await resolveCourseInBackground(userText, { recentMessages: msg.recentMessages, courseHint: msg.courseHint });
        const hasAnnouncementsWording = /\bannouncements?\b|\bannounc\w*\b/i.test(userText);
        const useAllCourses =
          !resolution.ok &&
          hasAnnouncementsWording &&
          !/\b(?:announcements?|announc\w*)\s+(?:for|in|of)\s+[a-z][a-z0-9\s]{2,30}\s*(\?|$|,|\.)/i.test(userText);
        let courseId = resolution.ok ? resolution.courseId : null;
        let courseName = resolution.ok ? resolution.name : null;
        let data = null;
        if (resolution.ok) {
          data = await getAnnouncementsListForCourse(resolution.courseId);
        } else if (useAllCourses) {
          const stored = await chrome.storage.local.get(["announcementsData"]);
          const byCourse = stored.announcementsData || [];
          const merged = [];
          for (const group of byCourse) {
            const name = group.courseName || group.courseId || "?";
            for (const a of group.announcements || []) {
              merged.push({ ...a, courseName: name, courseId: group.courseId });
            }
          }
          merged.sort((a, b) => (b.dateISO || b.modifiedDate || b.createdDate || "").localeCompare(a.dateISO || a.modifiedDate || a.createdDate || ""));
          data = merged.length ? { list: merged } : null;
          courseName = "All courses";
        } else {
          sendResponse({ ok: false, error: resolution.message || "Could not identify the course.", suggestions: resolution.suggestions });
          return;
        }
        if (!data || !Array.isArray(data.list)) {
          sendResponse({ ok: false, error: "I couldn't load announcements right now. Open Blackboard in a tab, sync announcements from Settings, and try again." });
          return;
        }
        const list = [...data.list].sort((a, b) => {
          const da = a.dateISO || a.modifiedDate || a.createdDate || "";
          const db = b.dateISO || b.modifiedDate || b.createdDate || "";
          return db.localeCompare(da);
        });
        const t = userText.toLowerCase();
        let selected = [];
        /** Full body for "paste last announcement fully" and combined context. */
        const announcementBodyMaxChars = 25000;
        const buildLink = (a) => {
          const cid = a.courseId || courseId;
          const aid = a.announcementId || a.id;
          if (!cid || !aid) return "";
          return ULTRA_ANNOUNCEMENT_LINK + "/" + encodeURIComponent(cid) + "/announcements/announcement-detail?courseId=" + encodeURIComponent(cid) + "&announcementId=" + encodeURIComponent(aid);
        };
        const linkBase = courseId ? ULTRA_ANNOUNCEMENT_LINK + "/" + encodeURIComponent(courseId) + "/announcements/announcement-detail?courseId=" + encodeURIComponent(courseId) + "&announcementId=" : null;

        const parseListN = (str) => {
          const m =
            str.match(/(?:list|show|give|dame)\s+(?:the\s+)?(\d+)\s+(?:most\s+recent|recent|latest)/i) ||
            str.match(/(\d+)\s+most\s+recent/i) ||
            str.match(/(?:last|latest)\s+(\d+)/i) ||
            str.match(/(\d+)\s+recent\s+(?:announcements?|announc\w*)/i);
          return m ? Math.min(parseInt(m[1], 10) || 5, 20) : 5;
        };
        const parseDays = (str) => {
          const w = str.match(/(\d+)\s*weeks?/i);
          if (w) return (parseInt(w[1], 10) || 1) * 7;
          const d = str.match(/(\d+)\s*days?/i);
          return d ? (parseInt(d[1], 10) || 7) : null;
        };
        const searchMatch = userText.match(/search\s+(?:announcements?\s+)?(?:in|for)\s+[^"']*(?:"([^"]+)"|'([^']+)')/i) || userText.match(/for\s+["']([^"']+)["']/i);
        const searchPhrase = searchMatch ? (searchMatch[1] || searchMatch[2] || "").trim() : null;
        const professorSayMatch = userText.match(/what\s+(?:did|does)\s+(?:the\s+)?professor\s+say\s+about\s+(.+?)(?:\?|$)/i) || userText.match(/what\s+(?:did|does)\s+.+say\s+about\s+(.+?)(?:\?|$)/i);
        const professorSayKeywords = professorSayMatch ? (professorSayMatch[1] || "").replace(/["']/g, "").trim().split(/\s+/).filter((w) => w.length > 1) : null;
        let searchKeywords = searchPhrase ? searchPhrase.split(/\s+/) : (t.includes("search") ? t.replace(/.*search\s+(?:announcements?\s+)?(?:in|for)\s*/, "").replace(/["']/g, "").trim().split(/\s+/) : null);
        if (!searchKeywords?.length && professorSayKeywords?.length) searchKeywords = professorSayKeywords;

        if (/\bhow\s+many\s+(unread\s+)?announcements?\b/i.test(userText)) {
          const unread = /\bunread\b/i.test(userText);
          const count = unread ? list.filter((a) => a.isRead === false).length : list.length;
          selected = list.slice(0, 3);
          const countLine = unread
            ? "Total unread announcements (from loaded data): " + count + "."
            : "Total announcements (from loaded data): " + list.length + ".";
          const storage = await chrome.storage.local.get("openrouterApiKey");
          const apiKey = (storage.openrouterApiKey ?? "").trim();
          if (!apiKey) {
            sendResponse({ ok: false, error: "Set your OpenRouter API Key in settings." });
            return;
          }
          const systemContent = "Announcements-only mode. Course: " + courseName + ". " + countLine + "\n\nAnswer with the count. If the user asked for unread, give the unread count. Be concise. Do not use asterisks (*) in your response; use plain text only.";
          const contextLines = selected.map((a) => (a.courseName ? a.courseName + " | " : "") + a.title + " | " + (a.dateISO || "") + " | Link: " + buildLink(a));
          const fullSystem = systemContent + "\n\nSample (for context):\n" + contextLines.join("\n");
          try {
            const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey, "HTTP-Referer": "https://blackboard.ie.edu" },
              body: JSON.stringify({ model: "anthropic/claude-haiku-4.5", messages: [{ role: "system", content: fullSystem }, { role: "user", content: userText }], max_tokens: 512 })
            });
            const rawBody = await res.text();
            if (!res.ok) { sendResponse({ ok: false, error: "OpenRouter: " + (rawBody.slice(0, 150) || res.status) }); return; }
            const parsed = JSON.parse(rawBody);
            const answer = (parsed?.choices?.[0]?.message?.content ?? "").trim() || (count + " announcement(s).");
            sendResponse({ ok: true, answer });
          } catch (e) {
            sendResponse({ ok: false, error: e?.message || "Error calling the model." });
          }
          return;
        }

        if (searchKeywords && searchKeywords.length > 0 && searchKeywords.some((w) => w.length > 1)) {
          selected = list.filter((a) => {
            const title = (a.title || "").toLowerCase();
            const body = (a.bodyText || "").toLowerCase();
            return searchKeywords.some((kw) => title.includes(kw) || body.includes(kw));
          });
          selected = selected.slice(0, 10);
        } else {
          const n = parseListN(userText);
          const days = parseDays(userText);
          if (days != null) {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - days);
            const cutoffIso = cutoff.toISOString();
            selected = list.filter((a) => (a.dateISO || a.modifiedDate || a.createdDate || "") >= cutoffIso).slice(0, 15);
          } else {
            selected = list.slice(0, Math.max(n, 10));
          }
        }

        const lines = [];
        for (const a of selected) {
          const dateStr = a.dateISO || a.modifiedDate || a.createdDate || "";
          const link = buildLink(a);
          const body = a.bodyText || "";
          const bodyForPrompt = body.length > announcementBodyMaxChars ? body.slice(0, announcementBodyMaxChars) + "\n[... truncated for length]" : body;
          lines.push((a.courseName ? "Course: " + a.courseName + "\n" : "") + "Title: " + (a.title || "(No title)") + "\nDate: " + dateStr + "\nLink: " + link + "\nBody:\n" + bodyForPrompt);
        }

        const storage = await chrome.storage.local.get("openrouterApiKey");
        const apiKey = (storage.openrouterApiKey ?? "").trim();
        if (!apiKey) {
          sendResponse({ ok: false, error: "Set your OpenRouter API Key in settings to get announcement answers." });
          return;
        }
        const systemContent =
          "Announcements-only mode rules: Answer using the announcements data below only. Do not use syllabus or other sources unless the user asks to combine. "
          + "If the user asks for 'latest' or 'last', use the first (newest) announcement. If multiple match, provide the top 1–3 with dates. "
          + "Always include: Course name, announcement title, date, and the Link when relevant. If you cannot find a match, say so and suggest refining the query. "
          + "Keep answers concise: title + date + key info + link. Do not use asterisks (*) in your response; use plain text only. Course: " + courseName + ".\n\n"
          + "Announcements data:\n" + (lines.length ? lines.join("\n\n---\n\n") : "(No announcements in the selected range.)");
        try {
          const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey, "HTTP-Referer": "https://blackboard.ie.edu" },
            body: JSON.stringify({
              model: msg?.model || "anthropic/claude-haiku-4.5",
              messages: [{ role: "system", content: systemContent }, { role: "user", content: userText }],
              max_tokens: 1024
            })
          });
          const rawBody = await res.text();
          if (!res.ok) {
            sendResponse({ ok: false, error: "OpenRouter: " + (rawBody.slice(0, 200) || res.status) });
            return;
          }
          const parsed = JSON.parse(rawBody);
          const answer = (parsed?.choices?.[0]?.message?.content ?? "").trim() || "No response generated.";
          sendResponse({ ok: true, answer });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "Error calling the model." });
        }
        return;
      }

      if (msg?.type === "PRELOAD_MIDTERM_DATES") {
        try {
          const userId = await getCurrentUserId();
          const classResult = await getClassifiedCourses(userId, { debug: false });
          const semester = currentSemester(classResult.totals);
          const semesterCategory = semester === "second" ? "Q2" : "Q1";
          const courses = classResult.items
            .filter((m) => m.category === semesterCategory)
            .map((m) => ({ courseId: m.courseId, courseName: m.courseDisplayName || m.courseId }));
          if (courses.length === 0) {
            sendResponse({ ok: true, cached: false, semester: semesterCategory });
            return;
          }
          const now = new Date();
          const deps = {
            fetchSyllabusStructured: (cid) => {
              const name = courses.find((c) => c.courseId === cid)?.courseName || cid;
              return getSyllabusStructuredPreferred(cid, name, { strictCourseId: true });
            },
            fetchCalendar: fetchCalendarInBackground,
            fetchAnnouncements: getAnnouncementsListForCourse
          };
          const result = await gatherMidtermEvidenceStructured(courses, now, deps);
          const cache = {
            items: result.items || [],
            semester: semesterCategory,
            fetchedAt: Date.now()
          };
          await chrome.storage.local.set({ [MIDTERM_DATES_CACHE_KEY]: cache });
          sendResponse({ ok: true, cached: true, semester: semesterCategory, itemCount: cache.items.length });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "Error preloading midterm dates." });
        }
        return;
      }

      if (msg?.type === "GET_MIDTERM_DATES_CACHE") {
        const data = await chrome.storage.local.get([MIDTERM_DATES_CACHE_KEY]);
        const cache = data[MIDTERM_DATES_CACHE_KEY] || null;
        sendResponse({ ok: true, cache });
        return;
      }

      if (msg?.type === "COMBINED_COURSE_QUERY") {
        const userText = (msg?.userText ?? "").trim();
        if (!userText) {
          sendResponse({ ok: false, error: "Question text is missing." });
          return;
        }
        const resolution = await resolveCourseInBackground(userText, { recentMessages: msg.recentMessages, courseHint: msg.courseHint });
        if (!resolution.ok) {
          sendResponse({ ok: false, error: resolution.message || "Could not identify the course.", suggestions: resolution.suggestions });
          return;
        }
        const now = new Date();
        const deps = {
          fetchCalendar: fetchCalendarInBackground,
          fetchAnnouncements: getAnnouncementsListForCourse,
          fetchSyllabusStructured: (courseId) => getSyllabusStructuredPreferred(courseId, resolution.name, { strictCourseId: true }),
          announcementLinkBase: ULTRA_ANNOUNCEMENT_LINK
        };
        try {
          const result = await runCombinedCourseQuery(userText, { courseId: resolution.courseId, name: resolution.name }, now, deps);
          if (!result.ok) {
            sendResponse({ ok: false, error: result.error || "Combined query failed." });
            return;
          }
          const storage = await chrome.storage.local.get("openrouterApiKey");
          const apiKey = (storage.openrouterApiKey ?? "").trim();
          if (!apiKey) {
            sendResponse({ ok: false, error: "Set your OpenRouter API Key in settings." });
            return;
          }
          const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey, "HTTP-Referer": "https://blackboard.ie.edu" },
            body: JSON.stringify({
              model: msg?.model || "anthropic/claude-haiku-4.5",
              messages: [
                { role: "system", content: result.systemContent },
                { role: "user", content: result.userContent }
              ],
              max_tokens: 1024
            })
          });
          const rawBody = await res.text();
          if (!res.ok) {
            sendResponse({ ok: false, error: "OpenRouter: " + (rawBody.slice(0, 200) || res.status) });
            return;
          }
          const data = JSON.parse(rawBody);
          const answer = (data?.choices?.[0]?.message?.content ?? "").trim() || "No response generated.";
          sendResponse({ ok: true, answer });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "Error running combined course query." });
        }
        return;
      }

      if (msg?.type === "OPENROUTER_CHAT") {
        const apiKey = (msg?.apiKey ?? "").trim();
        const body = msg?.body;
        if (!apiKey || !body?.messages) {
          sendResponse({ ok: false, status: 401, errorText: "API key o mensajes faltantes", content: "" });
          return;
        }
        const url = "https://openrouter.ai/api/v1/chat/completions";
        let res;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + apiKey,
              "HTTP-Referer": "https://blackboard.ie.edu"
            },
            body: JSON.stringify({
              model: body.model || "anthropic/claude-haiku-4.5",
              messages: body.messages,
              max_tokens: body.max_tokens ?? 512
            })
          });
        } catch (e) {
          sendResponse({ ok: false, status: 0, errorText: String(e?.message || e), content: "" });
          return;
        }
        const rawBody = await res.text();
        if (!res.ok) {
          sendResponse({ ok: false, status: res.status, errorText: rawBody.slice(0, 500), content: "" });
          return;
        }
        let content = "";
        try {
          const data = JSON.parse(rawBody);
          content = (data?.choices?.[0]?.message?.content ?? "").trim();
        } catch (_) {}
        sendResponse({ ok: true, status: res.status, content, errorText: null });
        return;
      }

      if (msg?.type === "GET_GRADES_PAGE_DEBUG") {
        const url = "https://blackboard.ie.edu/ultra/courses/_136261_1/grades";
        try {
          const res = await fetchWithRetry(url, { method: "GET", credentials: "include" }, FETCH_TIMEOUT_MS);
          const html = await res.text();
          sendResponse({
            ok: true,
            url,
            html
          });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e?.message || "Could not fetch grades page."
          });
        }
        return;
      }

      if (msg?.type === "GET_CURRENT_USER_ID") {
        try {
          const userId = await getCurrentUserId();
          sendResponse({ ok: true, userId });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "User id not available", notAuthenticated: e?.name === "UserNotAuthenticatedError" });
        }
        return;
      }

      if (msg?.type === "CHECK_BLUE_SURVEYS") {
        try {
          const userId = String(msg?.userId || "").trim() || await getCurrentUserId();
          const language = String(msg?.language || "en-US").trim() || "en-US";
          const result = await fetchBlueUltraSetting(userId, language);
          sendResponse({ ...result, userId });
        } catch (e) {
          const notAuthenticated = e?.name === "UserNotAuthenticatedError";
          sendResponse({
            ok: false,
            error: notAuthenticated ? "Open Blackboard and ensure you're logged in." : (e?.message || "Survey check failed."),
            notAuthenticated,
            locked: false,
            setting: null
          });
        }
        return;
      }

      if (msg?.type === "GET_COURSE_CATEGORIES") {
        try {
          const userId = await getCurrentUserId();
          const result = await getClassifiedCourses(userId, { debug: false });
          const semester = currentSemester(result.totals);
          sendResponse({
            ok: true,
            userId,
            totals: result.totals,
            items: result.items,
            currentSemester: semester
          });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e?.message || "Could not load course categories.",
            totals: { Q1: 0, Q2: 0, ANNUAL: 0, ORGANIZATION_COMMUNITY: 0, OTHER: 0 },
            items: [],
            currentSemester: null
          });
        }
        return;
      }

      if (msg?.type === "INIT_USER_IDENTITY") {
        try {
          await initUserIdentity();
          const userId = await getCurrentUserId().catch(() => null);
          sendResponse({ ok: true, userId });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "Init failed", notAuthenticated: e?.name === "UserNotAuthenticatedError" });
        }
        return;
      }

      if (msg?.type === "CLEAR_USER_IDENTITY") {
        try {
          await clearUserIdentity();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || "Clear failed" });
        }
        return;
      }

      if (msg?.type === "GET_ATTENDANCE_FOR_COURSE") {
        const courseId = msg?.courseId;
        const courseName = msg?.courseName ?? null;
        if (!courseId) {
          sendResponse({ ok: false, error: "courseId required", courseId: null, courseName, score: null, scoreFormatted: null });
          return;
        }
        try {
          const userId = await getCurrentUserId();
          const tab = await findAnyBlackboardTab();
          if (!tab?.id) {
            sendResponse({
              ok: false,
              error: "Open Blackboard in a tab and ensure you're logged in.",
              courseId,
              courseName,
              userId: null,
              selectedColumn: null,
              score: null,
              scoreFormatted: null,
              sources: null
            });
            return;
          }
          await pingContentScript(tab.id);
          let xsrf = await getXsrfFromBbRouterCookie();
          if (!xsrf) {
            const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
            if (!authRes?.ok) {
              sendResponse({
                ok: false,
                error: authRes?.error || "Open Blackboard and ensure you're logged in.",
                courseId,
                courseName,
                userId,
                selectedColumn: null,
                score: null,
                scoreFormatted: null,
                sources: null
              });
              return;
            }
            xsrf = authRes.xsrf ?? null;
          }
          const fetchColumns = (cid) =>
            chrome.tabs.sendMessage(tab.id, { type: "FETCH_GRADEBOOK_COLUMNS_RAW", xsrf, courseId: cid });
          const fetchGrades = (cid, uid) =>
            chrome.tabs.sendMessage(tab.id, { type: "FETCH_GRADEBOOK_GRADES", xsrf, courseId: cid, userId: uid });
          const result = await getAttendanceForCourse(courseId, courseName, {
            userId,
            fetchColumns,
            fetchGrades
          });
          sendResponse(result);
        } catch (e) {
          const isAuth = e?.name === "UserNotAuthenticatedError";
          sendResponse({
            ok: false,
            error: isAuth ? "Open Blackboard and ensure you're logged in." : (e?.message || "Attendance request failed."),
            courseId: courseId ?? null,
            courseName: courseName ?? null,
            userId: null,
            selectedColumn: null,
            score: null,
            scoreFormatted: null,
            sources: null
          });
        }
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;
});

// User ID bootstrap: run once when the service worker loads (no refetch if storage valid).
initUserIdentity().catch(() => {});

async function findAnyBlackboardTab() {
  const tabs = await chrome.tabs.query({ url: "https://blackboard.ie.edu/*" });
  return tabs?.[0] || null;
}

/** Obtiene XSRF desde la cookie BbRouter (parsea substring xsrf:...). */
async function getXsrfFromBbRouterCookie() {
  const cookie = await chrome.cookies.get({ url: "https://blackboard.ie.edu", name: "BbRouter" });
  const v = cookie?.value ?? "";
  const m = v.match(/xsrf:([0-9a-f-]{20,})/i);
  return m?.[1] ?? null;
}

/** Asegura que el content script está cargado en la pestaña; si no responde a PING, lo inyecta y reintenta. */
async function pingContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (res?.ok) return;
  } catch (_) {}

  await chrome.scripting.executeScript({ target: { tabId }, files: ["courseRegistry.js", "contentScript.js"] });
  await new Promise((r) => setTimeout(r, 150));

  const res2 = await chrome.tabs.sendMessage(tabId, { type: "PING" });
  if (!res2?.ok) throw new Error("Content script no respondió tras inyección.");
}

/** Fetches calendar items for the combined course query. Uses same contract as content script (since/until). Does not modify GET_CALENDAR_ITEMS handler. */
async function fetchCalendarInBackground(since, until) {
  const tab = await findAnyBlackboardTab();
  if (!tab?.id) return { ok: false, error: "Open Blackboard in a tab and make sure you are logged in.", items: [] };
  await pingContentScript(tab.id);
  let xsrf = await getXsrfFromBbRouterCookie();
  if (!xsrf) {
    const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
    if (!authRes?.ok) return { ok: false, error: "No XSRF. Open Blackboard and log in.", items: [] };
    xsrf = authRes.xsrf ?? null;
  }
  const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_CALENDAR_ITEMS", xsrf, since, until });
  return { ok: res?.ok, items: res?.items || [], error: res?.error };
}

/**
 * Single unified run: resolves session (syllabus/announcements/messages) then date (calendar when missing).
 * Saves both sessions cache and dates cache. Used by GET_MIDTERM_SESSIONS, GET_MIDTERM_DATES (when cache stale), and the 4h alarm.
 */
async function refreshMidtermData() {
  const updatedAt = Date.now();
  try {
    const userId = await getCurrentUserId();
    const classResult = await getClassifiedCourses(userId, { debug: false });
    const semester = currentSemester(classResult.totals);
    const semesterCategory = semester === "second" ? "Q2" : "Q1";
    const items = (classResult.items || []).filter((item) => item?.category === semesterCategory && item?.courseId);
    const calendarClient = {
      getCalendarItems: async ({ sinceISO, untilISO }) => {
        const r = await fetchCalendarInBackground(sinceISO, untilISO);
        return { ok: r.ok, items: r.items || [] };
      }
    };
    let fetchConversations = null;
    const tab = await findAnyBlackboardTab();
    if (tab?.id) {
      await pingContentScript(tab.id);
      let xsrf = await getXsrfFromBbRouterCookie();
      if (!xsrf) {
        const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
        xsrf = authRes?.ok ? (authRes.xsrf ?? null) : null;
      }
      if (xsrf) {
        fetchConversations = (cid) => chrome.tabs.sendMessage(tab.id, { type: "FETCH_COURSE_CONVERSATIONS", xsrf, courseId: cid });
      }
    }

    function runOneCourse(courseId, courseName, rawText, announcements, messages) {
      const hasInput = (rawText?.length || 0) >= 20 || (announcements?.length || 0) > 0 || (messages?.length || 0) > 0;
      const base = hasInput
        ? resolveMidtermSession(rawText || "", announcements || [], messages || [])
        : { midterm_session: null, midterm_date: null, midterm_time: null, timezone: null, candidates: [], source: "none", reason: "No input.", confidence: 0, evidence: [] };
      return base;
    }

    const sessionResults = [];
    for (const item of items) {
      const courseId = item.courseId;
      const courseName = item.courseDisplayName || item.courseName || item.name || courseId;
      try {
        const structured = await getSyllabusStructuredPreferred(courseId, courseName, { strictCourseId: true });
        let rawText = structured?.rawText || "";
        if (rawText.length >= 50 && !syllabusContentMatchesCourse(rawText, courseName)) {
          syllabusProcessedCache.delete(syllabusParsedCacheKey(courseId));
          rawText = "";
        }
        let announcements = [];
        try {
          const annData = await getAnnouncementsListForCourse(courseId);
          announcements = (annData?.list || []).map((a) => ({
            id: a.announcementId,
            title: a.title,
            body: a.bodyText,
            createdAt: a.dateISO || a.createdDate,
            updatedAt: a.modifiedDate || null
          }));
        } catch (_) {}
        let messages = [];
        if (fetchConversations) {
          try {
            const { normalized } = await getOrFetchConversations(courseId, fetchConversations, { forceRefresh: false });
            const msgs = normalized?.messages || [];
            messages = msgs.map((msg) => ({
              id: msg.messageId,
              senderName: msg.senderName,
              body: msg.textPlain,
              createdAt: msg.postDateISO,
              updatedAt: msg.postDateISO
            }));
          } catch (_) {}
        }
        const base = runOneCourse(courseId, courseName, rawText, announcements, messages);
        const resolution =
          base.midterm_date == null && base.midterm_session != null
            ? await enrichMidtermWithCalendar(base, calendarClient, { courseId, courseTitle: courseName, calendarId: courseId, calendarNameRawHint: null })
            : { ...base, calendar_inferred: false, calendar_match: null };

        const summarySession = base.midterm_session != null
          ? "Session " + base.midterm_session
          : base.midterm_date != null
            ? base.midterm_date + (base.midterm_time ? " " + base.midterm_time : "")
            : null;
        const summaryDate = resolution.midterm_session != null
          ? "Session " + resolution.midterm_session
          : resolution.midterm_date != null
            ? resolution.midterm_date + (resolution.midterm_time ? " " + resolution.midterm_time : "")
            : null;

        sessionResults.push({
          courseId,
          courseName,
          midterm_session: base.midterm_session,
          midterm_date: base.midterm_date,
          midterm_time: base.midterm_time,
          timezone: base.timezone,
          candidates: base.candidates || [],
          source: base.source || "syllabus",
          reason: base.reason,
          confidence: base.confidence,
          evidence: base.evidence || [],
          summary: summarySession ? summarySession + " (" + base.source + ", " + (base.confidence * 100).toFixed(0) + "%)" : (base.reason || "Not found.")
        });
        sessionResults[sessionResults.length - 1].dateResolution = {
          resolution,
          summaryDate
        };
      } catch (e) {
        sessionResults.push({
          courseId,
          courseName,
          midterm_session: null,
          candidates: [],
          source: "none",
          reason: "Error: " + (e?.message || e),
          confidence: 0,
          evidence: [],
          summary: "Could not load."
        });
        sessionResults[sessionResults.length - 1].dateResolution = null;
      }
    }

    const noMidtermIndices = sessionResults
      .map((r, i) => (r.midterm_session == null && r.midterm_date == null ? i : -1))
      .filter((i) => i >= 0);
    for (const idx of noMidtermIndices) {
      const r = sessionResults[idx];
      const courseId = r.courseId;
      const courseName = r.courseName;
      try {
        syllabusProcessedCache.delete(syllabusParsedCacheKey(courseId));
        const structured = await getSyllabusStructuredPreferred(courseId, courseName, { strictCourseId: true });
        let rawText = structured?.rawText || "";
        if (rawText.length >= 50 && !syllabusContentMatchesCourse(rawText, courseName)) {
          syllabusProcessedCache.delete(syllabusParsedCacheKey(courseId));
          rawText = "";
        }
        let announcements = [];
        try {
          const annData = await getAnnouncementsListForCourse(courseId);
          announcements = (annData?.list || []).map((a) => ({
            id: a.announcementId,
            title: a.title,
            body: a.bodyText,
            createdAt: a.dateISO || a.createdDate,
            updatedAt: a.modifiedDate || null
          }));
        } catch (_) {}
        let messages = [];
        if (fetchConversations) {
          try {
            const { normalized } = await getOrFetchConversations(courseId, fetchConversations, { forceRefresh: false });
            const msgs = normalized?.messages || [];
            messages = msgs.map((msg) => ({
              id: msg.messageId,
              senderName: msg.senderName,
              body: msg.textPlain,
              createdAt: msg.postDateISO,
              updatedAt: msg.postDateISO
            }));
          } catch (_) {}
        }
        const base = runOneCourse(courseId, courseName, rawText, announcements, messages);
        const resolution =
          base.midterm_date == null && base.midterm_session != null
            ? await enrichMidtermWithCalendar(base, calendarClient, { courseId, courseTitle: courseName, calendarId: courseId, calendarNameRawHint: null })
            : { ...base, calendar_inferred: false, calendar_match: null };
        const summarySession = base.midterm_session != null
          ? "Session " + base.midterm_session
          : base.midterm_date != null
            ? base.midterm_date + (base.midterm_time ? " " + base.midterm_time : "")
            : null;
        const summaryDate = resolution.midterm_session != null
          ? "Session " + resolution.midterm_session
          : resolution.midterm_date != null
            ? resolution.midterm_date + (resolution.midterm_time ? " " + resolution.midterm_time : "")
            : null;
        sessionResults[idx] = {
          courseId,
          courseName,
          midterm_session: base.midterm_session,
          midterm_date: base.midterm_date,
          midterm_time: base.midterm_time,
          timezone: base.timezone,
          candidates: base.candidates || [],
          source: base.source || "syllabus",
          reason: base.reason,
          confidence: base.confidence,
          evidence: base.evidence || [],
          summary: summarySession ? summarySession + " (" + base.source + ", " + (base.confidence * 100).toFixed(0) + "%)" : (base.reason || "Not found.")
        };
        sessionResults[idx].dateResolution = { resolution, summaryDate };
      } catch (_) {}
    }

    const sessionItems = sessionResults.map((r) => {
      const { dateResolution, ...rest } = r;
      return rest;
    });
    const dateItems = sessionResults.map((r) => {
      if (!r.dateResolution) {
        return {
          courseId: r.courseId,
          courseName: r.courseName,
          midterm_session: r.midterm_session,
          midterm_date: null,
          midterm_time: null,
          timezone: null,
          candidates: r.candidates || [],
          source: r.source,
          reason: r.reason,
          confidence: r.confidence,
          evidence: r.evidence || [],
          calendar_inferred: false,
          calendar_match: null,
          summary: r.summary
        };
      }
      const { resolution, summaryDate } = r.dateResolution;
      return {
        courseId: r.courseId,
        courseName: r.courseName,
        midterm_session: resolution.midterm_session,
        midterm_date: resolution.midterm_date,
        midterm_time: resolution.midterm_time,
        timezone: resolution.timezone,
        candidates: resolution.candidates || [],
        source: resolution.source || "syllabus",
        reason: resolution.reason,
        confidence: resolution.confidence,
        evidence: resolution.evidence || [],
        calendar_inferred: resolution.calendar_inferred ?? false,
        calendar_match: resolution.calendar_match ?? null,
        summary: summaryDate
          ? summaryDate + (resolution.calendar_inferred ? " (calendar)" : "") + " (" + resolution.source + ", " + (resolution.confidence * 100).toFixed(0) + "%)"
          : (resolution.reason || "Not found.")
      };
    });

    await chrome.storage.local.set({
      [MIDTERM_SESSIONS_CACHE_KEY]: { items: sessionItems, semester: semesterCategory, currentSemester: semester, updatedAt }
    });
    await chrome.storage.local.set({
      [MIDTERM_DATES_CACHE_KEY]: { items: dateItems, semester: semesterCategory, currentSemester: semester, updatedAt }
    });
    return { ok: true, sessionItems, dateItems, semester: semesterCategory, currentSemester: semester, updatedAt };
  } catch (e) {
    return { ok: false, error: e?.message || "Could not load midterm data.", sessionItems: [], dateItems: [], semester: null, currentSemester: null, updatedAt };
  }
}

function scheduleNextMidtermDatesRefresh() {
  chrome.alarms.create("midtermDatesRefresh", { when: getNextMidtermRefreshTime() });
}

function scheduleNextFinalDatesRefresh() {
  chrome.alarms.create("finalDatesRefresh", { when: getNextMidtermRefreshTime() });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === "midtermDatesRefresh") {
    refreshMidtermData().then(() => scheduleNextMidtermDatesRefresh());
  }
  if (alarm?.name === "finalDatesRefresh") {
    refreshFinalData().then(() => scheduleNextFinalDatesRefresh());
  }
  if (alarm?.name === DAILY_CLEANUP_ALARM) {
    runDailyCleanup();
  }
  handleUpdateAlarm(alarm);
});

scheduleNextMidtermDatesRefresh();
scheduleNextFinalDatesRefresh();
chrome.alarms.create(DAILY_CLEANUP_ALARM, { periodInMinutes: 24 * 60 });

/**
 * Resolves final exam session (and optionally date from calendar) per course.
 * Mirrors refreshMidtermData exactly: same retry loop for courses with no result (syllabusProcessedCache.delete + re-fetch).
 */
async function refreshFinalData() {
  const updatedAt = Date.now();
  try {
    const userId = await getCurrentUserId();
    const classResult = await getClassifiedCourses(userId, { debug: false });
    const semester = currentSemester(classResult.totals);
    const semesterCategory = semester === "second" ? "Q2" : "Q1";
    const items = (classResult.items || []).filter((item) => item?.category === semesterCategory && item?.courseId);
    const calendarClient = {
      getCalendarItems: async ({ sinceISO, untilISO }) => {
        const r = await fetchCalendarInBackground(sinceISO, untilISO);
        return { ok: r.ok, items: r.items || [] };
      }
    };
    let fetchConversations = null;
    const tab = await findAnyBlackboardTab();
    if (tab?.id) {
      await pingContentScript(tab.id);
      let xsrf = await getXsrfFromBbRouterCookie();
      if (!xsrf) {
        const authRes = await chrome.tabs.sendMessage(tab.id, { type: "DISCOVER_AUTH" });
        xsrf = authRes?.ok ? (authRes.xsrf ?? null) : null;
      }
      if (xsrf) {
        fetchConversations = (cid) => chrome.tabs.sendMessage(tab.id, { type: "FETCH_COURSE_CONVERSATIONS", xsrf, courseId: cid });
      }
    }

    function runOneCourseFinal(courseId, courseName, rawText, announcements, messages) {
      const hasInput = (rawText?.length || 0) >= 20 || (announcements?.length || 0) > 0 || (messages?.length || 0) > 0;
      const base = hasInput
        ? resolveFinalSession(rawText || "", announcements || [], messages || [])
        : {
            final_session: null,
            final_date: null,
            final_time: null,
            timezone: null,
            candidates: [],
            source: "none",
            reason: "No input.",
            confidence: 0,
            evidence: []
          };
      return base;
    }

    const sessionResults = [];
    for (const item of items) {
      const courseId = item.courseId;
      const courseName = item.courseDisplayName || item.courseName || item.name || courseId;
      try {
        const structured = await getSyllabusStructuredPreferred(courseId, courseName, { strictCourseId: true });
        let rawText = structured?.rawText || "";
        if (rawText.length >= 50 && !syllabusContentMatchesCourse(rawText, courseName)) {
          syllabusProcessedCache.delete(syllabusParsedCacheKey(courseId));
          rawText = "";
        }
        let announcements = [];
        try {
          const annData = await getAnnouncementsListForCourse(courseId);
          announcements = (annData?.list || []).map((a) => ({
            id: a.announcementId,
            title: a.title,
            body: a.bodyText,
            createdAt: a.dateISO || a.createdDate,
            updatedAt: a.modifiedDate || null
          }));
        } catch (_) {}
        let messages = [];
        if (fetchConversations) {
          try {
            const { normalized } = await getOrFetchConversations(courseId, fetchConversations, { forceRefresh: false });
            const msgs = normalized?.messages || [];
            messages = msgs.map((msg) => ({
              id: msg.messageId,
              senderName: msg.senderName,
              body: msg.textPlain,
              createdAt: msg.postDateISO,
              updatedAt: msg.postDateISO
            }));
          } catch (_) {}
        }
        const base = runOneCourseFinal(courseId, courseName, rawText, announcements, messages);
        const resolution =
          base.final_date == null && base.final_session != null
            ? await enrichFinalWithCalendar(base, calendarClient, { courseId, courseTitle: courseName, calendarId: courseId, calendarNameRawHint: null })
            : { ...base, calendar_inferred: false, calendar_match: null };

        const summarySession = base.final_session != null
          ? "Session " + base.final_session
          : base.final_date != null
            ? base.final_date + (base.final_time ? " " + base.final_time : "")
            : null;
        const summaryDate = resolution.final_session != null
          ? "Session " + resolution.final_session
          : resolution.final_date != null
            ? resolution.final_date + (resolution.final_time ? " " + resolution.final_time : "")
            : null;

        sessionResults.push({
          courseId,
          courseName,
          final_session: base.final_session,
          final_date: base.final_date,
          final_time: base.final_time,
          timezone: base.timezone,
          candidates: base.candidates || [],
          source: base.source || "syllabus",
          reason: base.reason,
          confidence: base.confidence,
          evidence: base.evidence || [],
          summary: summarySession ? summarySession + " (" + base.source + ", " + (base.confidence * 100).toFixed(0) + "%)" : (base.reason || "Not found.")
        });
        sessionResults[sessionResults.length - 1].dateResolution = { resolution, summaryDate };
      } catch (e) {
        sessionResults.push({
          courseId,
          courseName,
          final_session: null,
          final_date: null,
          final_time: null,
          timezone: null,
          candidates: [],
          source: "none",
          reason: "Error: " + (e?.message || e),
          confidence: 0,
          evidence: [],
          summary: "Could not load."
        });
        sessionResults[sessionResults.length - 1].dateResolution = null;
      }
    }

    // Retry courses with no result: clear syllabus cache and re-fetch (same as midterm).
    const noFinalIndices = sessionResults
      .map((r, i) => (r.final_session == null && r.final_date == null ? i : -1))
      .filter((i) => i >= 0);
    for (const idx of noFinalIndices) {
      const r = sessionResults[idx];
      const courseId = r.courseId;
      const courseName = r.courseName;
      try {
        syllabusProcessedCache.delete(syllabusParsedCacheKey(courseId));
        const structured = await getSyllabusStructuredPreferred(courseId, courseName, { strictCourseId: true });
        let rawText = structured?.rawText || "";
        if (rawText.length >= 50 && !syllabusContentMatchesCourse(rawText, courseName)) {
          syllabusProcessedCache.delete(syllabusParsedCacheKey(courseId));
          rawText = "";
        }
        let announcements = [];
        try {
          const annData = await getAnnouncementsListForCourse(courseId);
          announcements = (annData?.list || []).map((a) => ({
            id: a.announcementId,
            title: a.title,
            body: a.bodyText,
            createdAt: a.dateISO || a.createdDate,
            updatedAt: a.modifiedDate || null
          }));
        } catch (_) {}
        let messages = [];
        if (fetchConversations) {
          try {
            const { normalized } = await getOrFetchConversations(courseId, fetchConversations, { forceRefresh: false });
            const msgs = normalized?.messages || [];
            messages = msgs.map((msg) => ({
              id: msg.messageId,
              senderName: msg.senderName,
              body: msg.textPlain,
              createdAt: msg.postDateISO,
              updatedAt: msg.postDateISO
            }));
          } catch (_) {}
        }
        const base = runOneCourseFinal(courseId, courseName, rawText, announcements, messages);
        const resolution =
          base.final_date == null && base.final_session != null
            ? await enrichFinalWithCalendar(base, calendarClient, { courseId, courseTitle: courseName, calendarId: courseId, calendarNameRawHint: null })
            : { ...base, calendar_inferred: false, calendar_match: null };
        const summarySession = base.final_session != null
          ? "Session " + base.final_session
          : base.final_date != null
            ? base.final_date + (base.final_time ? " " + base.final_time : "")
            : null;
        const summaryDate = resolution.final_session != null
          ? "Session " + resolution.final_session
          : resolution.final_date != null
            ? resolution.final_date + (resolution.final_time ? " " + resolution.final_time : "")
            : null;
        sessionResults[idx] = {
          courseId,
          courseName,
          final_session: base.final_session,
          final_date: base.final_date,
          final_time: base.final_time,
          timezone: base.timezone,
          candidates: base.candidates || [],
          source: base.source || "syllabus",
          reason: base.reason,
          confidence: base.confidence,
          evidence: base.evidence || [],
          summary: summarySession ? summarySession + " (" + base.source + ", " + (base.confidence * 100).toFixed(0) + "%)" : (base.reason || "Not found.")
        };
        sessionResults[idx].dateResolution = { resolution, summaryDate };
      } catch (_) {}
    }

    const sessionItems = sessionResults.map((r) => {
      const { dateResolution, ...rest } = r;
      return rest;
    });
    const dateItems = sessionResults.map((r) => {
      if (!r.dateResolution) {
        return {
          courseId: r.courseId,
          courseName: r.courseName,
          final_session: r.final_session,
          final_date: null,
          final_time: null,
          timezone: null,
          candidates: r.candidates || [],
          source: r.source,
          reason: r.reason,
          confidence: r.confidence,
          evidence: r.evidence || [],
          calendar_inferred: false,
          calendar_match: null,
          summary: r.summary
        };
      }
      const { resolution, summaryDate } = r.dateResolution;
      return {
        courseId: r.courseId,
        courseName: r.courseName,
        final_session: resolution.final_session,
        final_date: resolution.final_date,
        final_time: resolution.final_time,
        timezone: resolution.timezone,
        candidates: resolution.candidates || [],
        source: resolution.source || "syllabus",
        reason: resolution.reason,
        confidence: resolution.confidence,
        evidence: resolution.evidence || [],
        calendar_inferred: resolution.calendar_inferred ?? false,
        calendar_match: resolution.calendar_match ?? null,
        summary: summaryDate
          ? summaryDate + (resolution.calendar_inferred ? " (calendar)" : "") + " (" + resolution.source + ", " + (resolution.confidence * 100).toFixed(0) + "%)"
          : (resolution.reason || "Not found.")
      };
    });

    await chrome.storage.local.set({
      [FINAL_DATES_CACHE_KEY]: { items: dateItems, semester: semesterCategory, currentSemester: semester, updatedAt }
    });
    return { ok: true, sessionItems, dateItems, semester: semesterCategory, currentSemester: semester, updatedAt };
  } catch (e) {
    return { ok: false, error: e?.message || "Could not load final sessions.", sessionItems: [], dateItems: [], semester: null, currentSemester: null, updatedAt };
  }
}

// ─── Data expiration (Task 1.5) ───────────────────────────────────────────────

/** Updates the last-activity timestamp in storage. Called on every user interaction. */
function touchLastActivity() {
  chrome.storage.local.set({ [LAST_ACTIVITY_KEY]: Date.now() }).catch(() => {});
}

/**
 * Deletes academic data if the user has been inactive for more than DATA_EXPIRY_DAYS.
 * Preserves: openrouterApiKey, jarvisTheme, navieConsent, navieLastActivity.
 */
async function runDailyCleanup() {
  try {
    const data = await chrome.storage.local.get(LAST_ACTIVITY_KEY);
    const lastActivity = data[LAST_ACTIVITY_KEY];
    if (!lastActivity) return;
    const daysSince = (Date.now() - lastActivity) / (1000 * 60 * 60 * 24);
    if (daysSince < DATA_EXPIRY_DAYS) return;

    const KEYS_TO_KEEP = new Set([
      "openrouterApiKey",
      "jarvisTheme",
      "navieConsent",
      LAST_ACTIVITY_KEY
    ]);

    const allData = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(allData).filter((k) => !KEYS_TO_KEEP.has(k));
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }

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
  } catch (_) {}
}
