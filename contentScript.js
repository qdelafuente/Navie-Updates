const BASE = "https://blackboard.ie.edu";

/** URL fija del syllabus por curso: solo se sustituye course_id por el learnCourseId. */
function buildSyllabusUrlForCourse(learnCourseId) {
  return `${BASE}/webapps/blackboard/execute/blti/launchPlacement?blti_placement_id=_1218_1&course_id=${encodeURIComponent(learnCourseId)}&from_ultra=true`;
}

const XSRF_ERROR_ACTIONABLE =
  "Open Blackboard in a tab and make sure you are logged in.";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "PING") {
    sendResponse({ ok: true });
    return true;
  }

  (async () => {
    try {
      if (msg?.type === "DISCOVER_AUTH") {
        const result = await discoverAuth();
        sendResponse(result);
        return;
      }
      if (msg?.type === "SYNC_COURSES") {
        const xsrf = msg?.xsrf ?? null;
        const result = await runSyncCourses(xsrf);
        sendResponse(result);
        return;
      }
      if (msg?.type === "SYNC_SYLLABI_IN_PAGE") {
        const xsrf = msg?.xsrf ?? null;
        const result = await syncSyllabiAndGradebook(xsrf);
        sendResponse(result);
        return;
      }
      if (msg?.type === "SYNC_GRADEBOOK_ONLY") {
        const xsrf = msg?.xsrf ?? null;
        const result = await syncGradebookOnly(xsrf);
        sendResponse(result);
        return;
      }
      if (msg?.type === "SYNC_SYLLABUS_FOR_COURSE") {
        const learnCourseId = msg?.learnCourseId;
        const courseName = msg?.courseName ?? "";
        if (!learnCourseId) {
          sendResponse({ ok: false, error: "Falta learnCourseId" });
          return;
        }
        sendResponse({
          ok: true,
          courseId: learnCourseId,
          courseName,
          syllabusUrl: buildSyllabusUrlForCourse(learnCourseId)
        });
        return;
      }
      if (msg?.type === "GET_CALENDAR_ITEMS") {
        const xsrf = msg?.xsrf ?? null;
        const since = msg?.since;
        const until = msg?.until;
        if (!since || !until) {
          sendResponse({ ok: false, error: "Faltan since/until" });
          return;
        }
        try {
          const result = await fetchCalendarItems(since, until, xsrf);
          sendResponse(result);
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e), items: [] });
        }
        return;
      }
      if (msg?.type === "FETCH_CURRENT_USER_ID") {
        try {
          const result = await fetchCurrentUserId();
          sendResponse(result);
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
        return;
      }
      if (msg?.type === "FETCH_USER_PROFILE") {
        const xsrf = msg?.xsrf ?? null;
        try {
          const result = await fetchUserProfile(xsrf);
          sendResponse(result);
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e), profile: null });
        }
        return;
      }
      if (msg?.type === "FETCH_GRADEBOOK_COLUMNS_RAW") {
        const courseId = msg?.courseId;
        const xsrf = msg?.xsrf ?? null;
        if (!courseId) {
          sendResponse({ ok: false, error: "courseId required", results: [] });
          return;
        }
        try {
          const results = await fetchGradebookColumns(courseId, xsrf);
          sendResponse({ ok: true, results });
        } catch (e) {
          const errMsg = e?.message || String(e);
          const isAuth = /401|403|logueado|logged in/i.test(errMsg);
          sendResponse({
            ok: false,
            error: isAuth ? "Open Blackboard and ensure you're logged in." : errMsg,
            notAuthenticated: isAuth,
            results: []
          });
        }
        return;
      }
      if (msg?.type === "FETCH_GRADEBOOK_GRADES") {
        const courseId = msg?.courseId;
        const userId = msg?.userId;
        const xsrf = msg?.xsrf ?? null;
        if (!courseId || !userId) {
          sendResponse({ ok: false, error: "courseId and userId required", results: [] });
          return;
        }
        try {
          const result = await fetchGradebookGrades(courseId, userId, xsrf);
          sendResponse(result);
        } catch (e) {
          const errMsg = e?.message || String(e);
          const isAuth = /401|403|logueado|logged in/i.test(errMsg);
          sendResponse({
            ok: false,
            error: isAuth ? "Open Blackboard and ensure you're logged in." : errMsg,
            notAuthenticated: isAuth,
            results: []
          });
        }
        return;
      }
      if (msg?.type === "FETCH_GRADEBOOK_ATTEMPT") {
        const courseId = msg?.courseId;
        const attemptId = msg?.attemptId;
        const xsrf = msg?.xsrf ?? null;
        if (!courseId || !attemptId) {
          sendResponse({ ok: false, error: "courseId and attemptId required" });
          return;
        }
        try {
          const attempt = await fetchGradebookAttemptDetail(courseId, attemptId, xsrf);
          const status = attempt?.status ?? attempt?.attempt?.status ?? null;
          sendResponse({ ok: true, status: status != null ? String(status) : null });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
        return;
      }
      if (msg?.type === "FETCH_COURSE_CONVERSATIONS") {
        const courseId = msg?.courseId;
        const xsrf = msg?.xsrf ?? null;
        if (!courseId) {
          sendResponse({ ok: false, error: "courseId required", results: [] });
          return;
        }
        try {
          const result = await fetchCourseConversations(courseId, xsrf);
          sendResponse(result);
        } catch (e) {
          const errMsg = e?.message || String(e);
          const isAuth = /401|403|logueado|logged in/i.test(errMsg);
          sendResponse({
            ok: false,
            error: isAuth ? "Open Blackboard and ensure you're logged in." : errMsg,
            notAuthenticated: isAuth,
            results: []
          });
        }
        return;
      }
      if (msg?.type === "SYNC_ANNOUNCEMENTS") {
        let xsrf = msg?.xsrf ?? null;
        try {
          const auth = await discoverAuth();
          if (auth?.ok && auth.xsrf != null) xsrf = auth.xsrf;
        } catch (_) {}
        try {
          const result = await syncAllAnnouncementsInPage(xsrf);
          sendResponse(result);
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e), data: [], errors: [] });
        }
        return;
      }
      if (msg?.type === "FETCH_ANNOUNCEMENTS_FOR_AI") {
        const courseId = msg?.courseId;
        let xsrf = msg?.xsrf ?? null;
        if (!courseId) {
          sendResponse({ ok: false, error: "courseId missing", announcements: [] });
          return;
        }
        try {
          const auth = await discoverAuth();
          if (auth?.ok && auth.xsrf != null) xsrf = auth.xsrf;
        } catch (_) {}
        try {
          const announcements = await fetchAnnouncementsForCourseWithBody(courseId, xsrf);
          sendResponse({ ok: true, announcements });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e), announcements: [] });
        }
        return;
      }
      if (msg?.type === "FETCH_SYLLABUS_HTML_FOR_COURSE") {
        const courseId = msg?.courseId;
        if (!courseId) {
          sendResponse({ ok: false, error: "courseId required" });
          return;
        }
        try {
          const result = await fetchSyllabusHtmlForCourse(courseId);
          sendResponse(result);
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
        return;
      }
      if (msg?.type === "FETCH_LTI_LAUNCH_FORM") {
        const courseId = msg?.courseId;
        if (!courseId) {
          sendResponse({ ok: false, error: "courseId required" });
          return;
        }
        try {
          const result = await fetchLtiLaunchForm(courseId);
          sendResponse(result);
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
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

async function bbFetchJson(url, xsrf) {
  const headers = { Accept: "application/json" };
  if (xsrf) {
    headers["X-Blackboard-XSRF"] = xsrf;
    headers["x-blackboard-xsrf"] = xsrf;
  }
  const res = await fetch(url, { method: "GET", credentials: "include", cache: "no-store", headers });
  if (res.status === 401 || res.status === 403) {
    throw new Error(XSRF_ERROR_ACTIONABLE);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} en ${url} ${text}`);
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    // Log parse error with URL to help debugging.
    console.log("[BB_FETCH]", "GET", url, "→ JSON parse error:", e?.message || String(e));
    throw e;
  }
  // Debug log: every Blackboard GET used by the AI (calendar, gradebook, announcements, syllabi).
  // Shows the URL and a small sample of the JSON returned so you can see what was extracted.
  try {
    const sample = JSON.stringify(data);
    const sampleStr = sample.length > 800 ? sample.slice(0, 800) + "… (truncated)" : sample;
    console.log("[BB_FETCH]", "GET", url, "→ sample:", sampleStr);
    // Send to extension UI (sidepanel) so the user can see which GETs the AI performed and what it received.
    try {
      chrome.runtime.sendMessage({ type: "BB_FETCH_LOG", url, sample: sampleStr });
    } catch (_) {
      // Ignore logging failures.
    }
  } catch {
    console.log("[BB_FETCH]", "GET", url, "→ response logged (non-JSON-serializable)");
  }
  return data;
}

/** GET /learn/api/v1/users/me, extract id only. Used by user identity bootstrap. */
async function fetchCurrentUserId() {
  const url = `${BASE}/learn/api/v1/users/me`;
  const res = await fetch(url, { method: "GET", credentials: "include", cache: "no-store", headers: { Accept: "application/json" } });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "Open Blackboard in a tab and ensure you're logged in, then retry.", notAuthenticated: true };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  let data;
  try {
    data = await res.json();
  } catch (_) {
    return { ok: false, error: "Unexpected response from Blackboard: invalid JSON." };
  }
  const id = data?.id;
  if (id == null || id === "") {
    return { ok: false, error: "Unexpected response from Blackboard: user id not found." };
  }
  return { ok: true, id: String(id) };
}

/** GET /learn/api/v1/users/me, full profile for AI. Uses TOP-LEVEL studentId only (ignore permissions.fieldPermissions). */
async function fetchUserProfile(xsrf) {
  const url = `${BASE}/learn/api/v1/users/me`;
  const data = await bbFetchJson(url, xsrf);
  const givenName = (data?.givenName ?? "").toString().trim();
  const familyName = (data?.familyName ?? "").toString().trim();
  const fullName = [givenName, familyName].filter(Boolean).join(" ").trim();
  const profile = {
    userId: data?.id != null ? String(data.id) : null,
    givenName: givenName || null,
    familyName: familyName || null,
    fullName: fullName || null,
    email: (data?.emailAddress ?? "").toString().trim() || null,
    studentId: typeof data?.studentId === "string" ? data.studentId.trim() : null,
    username: (data?.userName ?? "").toString().trim() || null,
    locale: (data?.locale ?? "").toString().trim() || null
  };
  return { ok: true, profile };
}

/**
 * Si since y until corresponden al mismo día (misma fecha), fuerza el formato exacto de la API:
 * since=YYYY-MM-DDT00:00Z&until=YYYY-MM-DDT22:59Z
 */
function normalizeCalendarRange(sinceISO, untilISO) {
  const sinceStr = String(sinceISO || "").trim();
  const untilStr = String(untilISO || "").trim();
  const datePartSince = sinceStr.slice(0, 10);
  const datePartUntil = untilStr.slice(0, 10);
  if (datePartSince && datePartUntil && datePartSince === datePartUntil && /^\d{4}-\d{2}-\d{2}$/.test(datePartSince)) {
    return { since: datePartSince + "T00:00Z", until: datePartUntil + "T22:59Z" };
  }
  return { since: sinceStr, until: untilStr };
}

/**
 * GET /learn/api/v1/calendars/calendarItems?since=<ISO_Z>&until=<ISO_Z>
 * credentials: "include". Devuelve items crudos; calendar.js filtra solo CalendarEntry y normaliza.
 * Usa formato exacto since=YYYY-MM-DDT00:00Z&until=YYYY-MM-DDT22:59Z para coincidir con la zona horaria.
 */
async function fetchCalendarItems(sinceISO, untilISO, xsrf) {
  const { since, until } = normalizeCalendarRange(sinceISO, untilISO);
  const url = `${BASE}/learn/api/v1/calendars/calendarItems?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;
  const headers = { Accept: "application/json" };
  if (xsrf) {
    headers["X-Blackboard-XSRF"] = xsrf;
    headers["x-blackboard-xsrf"] = xsrf;
  }
  const res = await fetch(url, { method: "GET", credentials: "include", cache: "no-store", headers });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, items: [], error: "Session expired. Open Blackboard and log in." };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, items: [], error: "HTTP " + res.status + (text ? " " + text.slice(0, 80) : "") };
  }
  const data = await res.json().catch(() => ({}));
  let raw = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.calendarItemViews)
      ? data.calendarItemViews
      : Array.isArray(data?.calendarItems)
        ? data.calendarItems
        : Array.isArray(data?.body)
          ? data.body
          : Array.isArray(data?.items)
            ? data.items
            : Array.isArray(data?.content)
              ? data.content
              : Array.isArray(data?.data)
                ? data.data
                : Array.isArray(data) ? data : [];
  if (raw.length > 0 && raw[0] && typeof raw[0] === "object") {
    if (raw[0].calendarItem != null) raw = raw.map((r) => r.calendarItem).filter(Boolean);
    else if (raw[0].item != null) raw = raw.map((r) => r.item).filter(Boolean);
  }
  return { ok: true, items: raw };
}

async function runSyncCourses(xsrf) {
  const log = [];
  const fetchJson = (url, xsrfToken) => bbFetchJson(url, xsrfToken);
  const result = await window.CourseRegistry.syncCourses(BASE, xsrf, {
    fetchJson,
    log: (msg) => log.push(msg)
  });
  return { ok: result.ok, count: result.count, sample: result.sample || [], log: result.log || [], error: result.error };
}

/**
 * Syllabi y gradebook: usamos SIEMPRE learnCourseId en /learn/api/v1/courses/{learnCourseId}/...
 */
/**
 * Fetches the Blackboard LTI launch page for a given course (in page context, so all
 * Blackboard session cookies are included) and returns the parsed LTI form data.
 * The background service worker then uses this form to POST to ltitools.ie.edu.
 * Returns: { ok, action, body, inputCount } or { ok: false, error }
 */
async function fetchLtiLaunchForm(courseId) {
  const launchUrl = buildSyllabusUrlForCourse(courseId);
  let getRes;
  try {
    getRes = await fetch(launchUrl, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "text/html,application/xhtml+xml,*/*" }
    });
  } catch (e) {
    return { ok: false, error: "Network error fetching LTI launch: " + (e?.message || String(e)) };
  }
  if (!getRes.ok) {
    return { ok: false, error: "LTI launch GET HTTP " + getRes.status };
  }
  const html = await getRes.text();

  function getAttr(tagStr, name) {
    const re = new RegExp("\\s" + name + "\\s*=\\s*[\"']([^\"']*)[\"']", "i");
    const m = tagStr.match(re);
    return m ? m[1].trim() : null;
  }

  // Look for bltiLaunchForm specifically, then fall back to any LTI-looking form
  let formBlock = html.match(/<\s*form[^>]*?(?:id|name)\s*=\s*["']bltiLaunchForm["'][^>]*>([\s\S]*?)<\s*\/\s*form\s*>/i);
  let formOpen = "";
  let inner = "";
  if (formBlock) {
    formOpen = formBlock[0].match(/^<\s*form[^>]*>/)?.[0] ?? "";
    inner = formBlock[1];
  } else {
    // Try any form that looks like an LTI form
    const anyForm = html.match(/<\s*form\s+([^>]+)>([\s\S]*?)<\s*\/\s*form\s*>/i);
    if (!anyForm) return { ok: false, error: "No LTI form found in Blackboard launch page" };
    if (!/oauth_consumer_key|lti_message_type|blti|launch/i.test(anyForm[2])) {
      return { ok: false, error: "Form found but does not appear to be an LTI form" };
    }
    formOpen = "<form " + anyForm[1] + ">";
    inner = anyForm[2];
  }

  let action = getAttr(formOpen, "action");
  if (!action) return { ok: false, error: "LTI form has no action URL" };
  if (action.startsWith("/")) action = BASE + action;
  else if (!/^https?:\/\//i.test(action)) action = BASE + "/" + action.replace(/^\//, "");

  const pairs = [];
  const inputRe = /<\s*input\s+([^>]+)>/gi;
  let m;
  while ((m = inputRe.exec(inner)) !== null) {
    const name = getAttr(m[1], "name");
    if (!name) continue;
    const type = (getAttr(m[1], "type") || "text").toLowerCase();
    if ((type === "radio" || type === "checkbox") && !/checked/i.test(m[1])) continue;
    pairs.push([name, getAttr(m[1], "value") ?? ""]);
  }
  const textareaRe = /<\s*textarea\s+([^>]*)>([\s\S]*?)<\s*\/\s*textarea\s*>/gi;
  while ((m = textareaRe.exec(inner)) !== null) {
    const name = getAttr(m[1], "name");
    if (name) pairs.push([name, (m[2] || "").trim()]);
  }

  if (pairs.length === 0) return { ok: false, error: "LTI form found but has no input fields" };
  const body = pairs.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
  return { ok: true, action, body, inputCount: pairs.length };
}

/**
 * Fetches the syllabus HTML for a given course by performing the full LTI launch flow
 * from the page context (so all cookies including ltitools.ie.edu session are included).
 * Uses the correct placement ID _1218_1 with from_ultra=true.
 */
async function fetchSyllabusHtmlForCourse(courseId) {
  const launchUrl = buildSyllabusUrlForCourse(courseId);

  // Step 1: GET the Blackboard LTI launch page
  const getRes = await fetch(launchUrl, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "text/html,application/xhtml+xml,*/*" }
  });
  if (!getRes.ok) {
    return { ok: false, error: "LTI launch GET failed: HTTP " + getRes.status };
  }
  const launchHtml = await getRes.text();

  // Step 2: Parse the bltiLaunchForm
  function getAttrInline(tagStr, name) {
    const re = new RegExp("\\s" + name + "\\s*=\\s*[\"']([^\"']*)[\"']", "i");
    const m = tagStr.match(re);
    return m ? m[1].trim() : null;
  }

  function parseFormInputs(html) {
    const formMatch = html.match(/<\s*form\s+([^>]+)>([\s\S]*?)<\s*\/\s*form\s*>/i);
    if (!formMatch) return null;
    const formOpen = formMatch[1];
    const inner = formMatch[2];
    let action = getAttrInline(formOpen, "action");
    if (!action) return null;
    if (action.startsWith("/")) action = BASE + action;
    const pairs = [];
    const inputRe = /<\s*input\s+([^>]+)>/gi;
    let m;
    while ((m = inputRe.exec(inner)) !== null) {
      const name = getAttrInline(m[1], "name");
      if (!name) continue;
      const type = (getAttrInline(m[1], "type") || "text").toLowerCase();
      if ((type === "radio" || type === "checkbox") && !/checked/i.test(m[1])) continue;
      pairs.push([name, getAttrInline(m[1], "value") ?? ""]);
    }
    const textareaRe = /<\s*textarea\s+([^>]*)>([\s\S]*?)<\s*\/\s*textarea\s*>/gi;
    while ((m = textareaRe.exec(inner)) !== null) {
      const name = getAttrInline(m[1], "name");
      if (name) pairs.push([name, (m[2] || "").trim()]);
    }
    if (pairs.length === 0) return null;
    return { action, body: pairs.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&") };
  }

  const form = parseFormInputs(launchHtml);
  if (!form) {
    // No form found — try direct index URL with credentials
    const fallbackUrl = "https://ltitools.ie.edu/ESyllabusLTI/index?course_id=" + encodeURIComponent(courseId);
    const fallbackRes = await fetch(fallbackUrl, { method: "GET", credentials: "include", headers: { Accept: "text/html,*/*" } });
    if (!fallbackRes.ok) return { ok: false, error: "No LTI form and fallback failed: HTTP " + fallbackRes.status };
    const html = await fallbackRes.text();
    return { ok: true, html, url: fallbackRes.url };
  }

  // Step 3: POST the form to the LTI tool
  const postRes = await fetch(form.action, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html,application/xhtml+xml,*/*" },
    body: form.body
  });
  if (!postRes.ok) {
    return { ok: false, error: "LTI form POST failed: HTTP " + postRes.status };
  }
  let html = await postRes.text();
  let finalUrl = postRes.url || form.action;

  // Step 4: If the result is an auto-submit form (SSO relay), follow it
  if (html && (html.includes("document.forms") || (html.includes("auto") && html.includes("submit")))) {
    const relay = parseFormInputs(html);
    if (relay) {
      const relayRes = await fetch(relay.action, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html,*/*" },
        body: relay.body
      });
      if (relayRes.ok) {
        html = await relayRes.text();
        finalUrl = relayRes.url || finalUrl;
      }
    }
  }

  return { ok: true, html, url: finalUrl };
}

async function syncSyllabiAndGradebook(xsrf) {
  const log = [];
  const keys = window.CourseRegistry.STORAGE_KEYS;
  const stored = await chrome.storage.local.get([keys.coursesList, keys.coursesByCourseId]);
  const coursesList = stored[keys.coursesList] || [];
  const coursesByCourseId = stored[keys.coursesByCourseId] || {};

  if (coursesList.length === 0) {
    log.push("No courses in registry. Click «Sync courses» first.");
    return {
      ok: false,
      error: "Sync courses first.",
      syllabi: [],
      gradebookColumns: [],
      log
    };
  }

  const syllabi = [];
  for (const meta of coursesList) {
    const learnCourseId = meta.learnCourseId;
    log.push("Syncing syllabus " + meta.name + " (" + learnCourseId + ").");
    const syllabusUrl = buildSyllabusUrlForCourse(learnCourseId);
    syllabi.push({ courseId: learnCourseId, courseName: meta.name, syllabusUrl });
  }

  const gradebookColumns = [];
  const gradebookByCourseId = {};

  for (const meta of coursesList) {
    const learnCourseId = meta.learnCourseId;
    const courseName = meta.name || learnCourseId;
    log.push("Gradebook " + courseName + " (" + learnCourseId + ").");

    let rawColumns = [];
    try {
      rawColumns = await fetchGradebookColumns(learnCourseId, xsrf);
      log.push("  List columns HTTP OK, " + rawColumns.length + " columns.");
    } catch (e) {
      const err = e?.message || String(e);
      log.push("  Error list gradebook: " + err);
      if (err.includes("404") && !looksLikeLearnCourseId(learnCourseId)) {
        log.push("  (404: ensure courseId is in format _123_1.)");
      }
      gradebookColumns.push({ courseId: learnCourseId, courseName, columns: [], assignments: [] });
      gradebookByCourseId[learnCourseId] = { courseName, columns: [], assignments: [] };
      continue;
    }

    const columns = [];
    const assignments = [];
    for (const col of rawColumns) {
      const columnId = col?.id ?? col?.columnId;
      if (!columnId) continue;
      try {
        const detail = await fetchGradebookColumnDetail(learnCourseId, columnId, xsrf);
        const norm = normalizeColumnDetail(detail);
        const title = norm?.title ?? col.effectiveColumnName ?? col.columnName ?? columnId;
        const navigableUrl = buildColumnNavigableUrl(learnCourseId, columnId, detail, log, col);
        const colEntry = {
          id: columnId,
          name: title,
          title,
          dueDate: norm?.dueDate ?? null,
          pointsPossible: norm?.pointsPossible ?? null,
          availability: norm?.availability,
          contentId: norm?.contentId,
          linkId: norm?.linkId,
          userCreatedColumn: norm?.userCreatedColumn,
          isAttemptBased: norm?.isAttemptBased ?? (col?.isAttemptBased === true)
        };
        columns.push(colEntry);
        const a = toAssignment(learnCourseId, courseName, columnId, norm, navigableUrl);
        if (a) assignments.push(a);
      } catch (e) {
        const err = e?.message || String(e);
        log.push("  Column " + columnId + " detail: " + (err.includes("404") ? "HTTP 404" : err));
        const title = col.effectiveColumnName ?? col.columnName ?? columnId;
        columns.push({ id: columnId, name: title, title, dueDate: null, isAttemptBased: col?.isAttemptBased === true });
      }
    }

    gradebookColumns.push({ courseId: learnCourseId, courseName, columns, assignments });
    gradebookByCourseId[learnCourseId] = { courseName, columns, assignments };
  }

  return {
    ok: true,
    syllabi,
    gradebookColumns,
    gradebookByCourseId,
    coursesByCourseId,
    coursesList,
    log
  };
}

/**
 * Solo gradebook (columnas + detalles por curso). Para el widget de próximas entregas al abrir.
 * No sincroniza syllabi.
 */
async function syncGradebookOnly(xsrf) {
  const log = [];
  const keys = window.CourseRegistry.STORAGE_KEYS;
  const stored = await chrome.storage.local.get([keys.coursesList, keys.coursesByCourseId]);
  const coursesList = stored[keys.coursesList] || [];
  const coursesByCourseId = stored[keys.coursesByCourseId] || {};

  if (coursesList.length === 0) {
    log.push("No courses. Sync courses first.");
    return { ok: false, error: "Sync courses first.", gradebookColumns: [], gradebookByCourseId: {}, log };
  }

  const gradebookColumns = [];
  const gradebookByCourseId = {};

  for (const meta of coursesList) {
    const learnCourseId = meta.learnCourseId;
    const courseName = meta.name || learnCourseId;
    log.push("Gradebook " + courseName + " (" + learnCourseId + ").");

    let rawColumns = [];
    try {
      rawColumns = await fetchGradebookColumns(learnCourseId, xsrf);
      log.push("  List columns HTTP OK, " + rawColumns.length + " columns.");
    } catch (e) {
      const err = e?.message || String(e);
      log.push("  Error list gradebook: " + err);
      if (err.includes("404") && !looksLikeLearnCourseId(learnCourseId)) {
        log.push("  (404: ensure courseId is in format _123_1.)");
      }
      gradebookColumns.push({ courseId: learnCourseId, courseName, columns: [], assignments: [] });
      gradebookByCourseId[learnCourseId] = { courseName, columns: [], assignments: [] };
      continue;
    }

    const columns = [];
    const assignments = [];
    for (const col of rawColumns) {
      const columnId = col?.id ?? col?.columnId;
      if (!columnId) continue;
      try {
        const detail = await fetchGradebookColumnDetail(learnCourseId, columnId, xsrf);
        const norm = normalizeColumnDetail(detail);
        const title = norm?.title ?? col.effectiveColumnName ?? col.columnName ?? columnId;
        const navigableUrl = buildColumnNavigableUrl(learnCourseId, columnId, detail, log, col);
        const colEntry = {
          id: columnId,
          name: title,
          title,
          dueDate: norm?.dueDate ?? null,
          pointsPossible: norm?.pointsPossible ?? null,
          availability: norm?.availability,
          contentId: norm?.contentId,
          linkId: norm?.linkId,
          userCreatedColumn: norm?.userCreatedColumn,
          isAttemptBased: norm?.isAttemptBased ?? (col?.isAttemptBased === true)
        };
        columns.push(colEntry);
        const a = toAssignment(learnCourseId, courseName, columnId, norm, navigableUrl);
        if (a) assignments.push(a);
      } catch (e) {
        const err = e?.message || String(e);
        log.push("  Column " + columnId + " detail: " + (err.includes("404") ? "HTTP 404" : err));
        const title = col.effectiveColumnName ?? col.columnName ?? columnId;
        columns.push({ id: columnId, name: title, title, dueDate: null, isAttemptBased: col?.isAttemptBased === true });
      }
    }

    gradebookColumns.push({ courseId: learnCourseId, courseName, columns, assignments });
    gradebookByCourseId[learnCourseId] = { courseName, columns, assignments };
  }

  return { ok: true, gradebookColumns, gradebookByCourseId, log };
}

/** Formato esperado de courseId en /learn/api/v1/courses/{courseId}/... (ej: _123_1) */
function looksLikeLearnCourseId(id) {
  return typeof id === "string" && /^_[0-9]+_[0-9]+$/.test(id.trim());
}

async function fetchGradebookColumns(learnCourseId, xsrf) {
  const url = `${BASE}/learn/api/v1/courses/${encodeURIComponent(learnCourseId)}/gradebook/columns?limit=200&offset=0`;
  const data = await bbFetchJson(url, xsrf);
  return Array.isArray(data?.results) ? data.results : [];
}

/**
 * GET .../courses/{courseId}/gradebook/grades?userId={userId}&limit=200&offset=0
 * Fetches all pages so columnId lookup is complete. Used for attendance and submission classification.
 */
async function fetchGradebookGrades(learnCourseId, userId, xsrf) {
  const allResults = [];
  let offset = 0;
  const limit = 200;
  let hasMore = true;
  while (hasMore) {
    const url =
      `${BASE}/learn/api/v1/courses/${encodeURIComponent(learnCourseId)}/gradebook/grades` +
      `?userId=${encodeURIComponent(userId)}&limit=${limit}&offset=${offset}`;
    const data = await bbFetchJson(url, xsrf);
    const results = Array.isArray(data?.results) ? data.results : [];
    allResults.push(...results);
    if (results.length < limit) {
      hasMore = false;
    } else {
      offset += limit;
    }
  }
  return { ok: true, results: allResults };
}

/**
 * GET .../courses/{courseId}/gradebook/columns/{columnId} para título, dueDate, isAttemptBased, etc.
 * columnId aquí es el id de la columna (ej: _517334_1).
 */
async function fetchGradebookColumnDetail(learnCourseId, columnId, xsrf) {
  const url = `${BASE}/learn/api/v1/courses/${encodeURIComponent(learnCourseId)}/gradebook/columns/${encodeURIComponent(columnId)}`;
  return bbFetchJson(url, xsrf);
}

/**
 * GET .../courses/{courseId}/gradebook/attempts/{attemptId}
 * Final authority for submission: attempt.status === "IN_PROGRESS" means NOT submitted.
 */
async function fetchGradebookAttemptDetail(learnCourseId, attemptId, xsrf) {
  const url = `${BASE}/learn/api/v1/courses/${encodeURIComponent(learnCourseId)}/gradebook/attempts/${encodeURIComponent(attemptId)}`;
  return bbFetchJson(url, xsrf);
}

/**
 * GET .../courses/{courseId}/conversations/{conversationId} — full conversation (may include all messages).
 */
async function fetchConversationById(learnCourseId, conversationId, xsrf) {
  const url = `${BASE}/learn/api/v1/courses/${encodeURIComponent(learnCourseId)}/conversations/${encodeURIComponent(conversationId)}`;
  return bbFetchJson(url, xsrf);
}

/**
 * GET .../courses/{courseId}/conversations/{conversationId}/messages — all messages in a conversation (fallback).
 */
async function fetchConversationMessages(learnCourseId, conversationId, xsrf) {
  const url = `${BASE}/learn/api/v1/courses/${encodeURIComponent(learnCourseId)}/conversations/${encodeURIComponent(conversationId)}/messages`;
  const data = await bbFetchJson(url, xsrf);
  return Array.isArray(data?.results) ? data.results : (Array.isArray(data?.messages) ? data.messages : []);
}

/**
 * GET .../courses/{courseId}/conversations — course messages (conversations API).
 * Expands each conversation that has totalCount > messages.length by fetching the full conversation by ID
 * so the response includes all messages per conversation.
 */
async function fetchCourseConversations(learnCourseId, xsrf) {
  const url = `${BASE}/learn/api/v1/courses/${encodeURIComponent(learnCourseId)}/conversations`;
  const data = await bbFetchJson(url, xsrf);
  const results = Array.isArray(data?.results) ? data.results : [];
  for (let i = 0; i < results.length; i++) {
    const conv = results[i];
    const totalCount = Math.max(0, Number(conv?.totalCount) || 0);
    const currentCount = Array.isArray(conv?.messages) ? conv.messages.length : 0;
    if (totalCount > currentCount && conv?.id) {
      let expandedMessages = null;
      try {
        const fullConv = await fetchConversationById(learnCourseId, conv.id, xsrf);
        expandedMessages = Array.isArray(fullConv?.messages)
          ? fullConv.messages
          : Array.isArray(fullConv?.results)
            ? fullConv.results
            : null;
      } catch (_) {}
      if (!expandedMessages || expandedMessages.length < totalCount) {
        try {
          const msgList = await fetchConversationMessages(learnCourseId, conv.id, xsrf);
          if (msgList.length >= currentCount) expandedMessages = msgList;
        } catch (_) {}
      }
      if (expandedMessages && expandedMessages.length >= currentCount) {
        results[i] = { ...conv, messages: expandedMessages };
      }
    }
  }
  return { ok: true, results, nextPage: data?.nextPage ?? data?.paging?.nextPage ?? null };
}

// ——— Announcements (new module: fetch only, no change to calendar/syllabus/gradebook) ———
const ANNOUNCEMENTS_STORAGE_KEYS = { data: "announcementsData", syncedAt: "announcementsSyncedAt" };
const ANNOUNCEMENTS_CONCURRENCY = 4;
const ANNOUNCEMENTS_PAGE_LIMIT = 200;

function announcementReadStatus(item) {
  if (typeof item?.isRead === "boolean") return item.isRead;
  if (typeof item?.readStatus?.isRead === "boolean") return item.readStatus.isRead;
  return false;
}

function getAnnouncementResultsFromPage(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.announcements)) return data.announcements;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function getNextPageFromAnnouncementData(data) {
  return data?.nextPage ?? data?.paging?.nextPage ?? data?.page?.nextPage ?? null;
}

function resolveAnnouncementNextPageUrl(baseUrl, nextPage) {
  if (!nextPage || typeof nextPage !== "string") return null;
  return nextPage.startsWith("http")
    ? nextPage
    : BASE.replace(/\/$/, "") + (nextPage.startsWith("/") ? nextPage : "/" + nextPage);
}

function buildFallbackAnnouncementPageUrl(currentUrl, pageSize) {
  try {
    const url = new URL(currentUrl);
    const limitRaw = parseInt(url.searchParams.get("limit") || "", 10);
    const offsetRaw = parseInt(url.searchParams.get("offset") || "", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : ANNOUNCEMENTS_PAGE_LIMIT;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    if (!Number.isFinite(pageSize) || pageSize < limit) return null;
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset + pageSize));
    return url.toString();
  } catch (_) {
    return null;
  }
}

function announcementDateISO(item) {
  const modified = item?.modifiedDate ?? item?.modified;
  if (modified) return typeof modified === "string" ? modified : (modified?.iso ?? "");
  const created = item?.createdDate ?? item?.created;
  if (created) return typeof created === "string" ? created : (created?.iso ?? "");
  const start = item?.startDateRestriction ?? item?.startDate;
  if (start) return typeof start === "string" ? start : (start?.iso ?? "");
  return "";
}

/**
 * Fetch all announcements for one course with pagination. Uses same courseId as gradebook/calendar.
 */
async function fetchAnnouncementsForCourse(courseId, xsrf) {
  const out = [];
  let url = `${BASE}/learn/api/v1/courses/${encodeURIComponent(courseId)}/announcements/?limit=${ANNOUNCEMENTS_PAGE_LIMIT}&offset=0`;
  const visitedUrls = new Set();
  while (url) {
    if (visitedUrls.has(url)) break;
    visitedUrls.add(url);
    const data = await bbFetchJson(url, xsrf);
    const results = getAnnouncementResultsFromPage(data);
    for (const r of results) {
      const id = r?.id ?? r?.announcementId ?? "";
      const title = (r?.title ?? r?.name ?? "").trim() || "(No title)";
      const dateISO = announcementDateISO(r);
      const createdDate = r?.createdDate ?? r?.created ?? "";
      const modifiedDate = r?.modifiedDate ?? r?.modified ?? "";
      const rawBody = r?.body?.rawText ?? r?.body?.displayText ?? "";
      out.push({
        id,
        title,
        dateISO,
        createdDate: typeof createdDate === "string" ? createdDate : (createdDate?.iso ?? ""),
        modifiedDate: typeof modifiedDate === "string" ? modifiedDate : (modifiedDate?.iso ?? ""),
        bodyText: announcementBodyToText(rawBody),
        isRead: announcementReadStatus(r)
      });
    }
    const explicitNextPage = resolveAnnouncementNextPageUrl(url, getNextPageFromAnnouncementData(data));
    url = explicitNextPage || buildFallbackAnnouncementPageUrl(url, results.length);
  }
  return out;
}

/** Lightweight strip HTML to plain text for AI consumption. */
function stripHtmlForAi(html) {
  if (html == null || typeof html !== "string") return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function announcementBodyToText(html) {
  if (html == null || typeof html !== "string") return "";
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  try {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = text;
    return textarea.value.trim();
  } catch (_) {
    return text;
  }
}

/**
 * Fetch announcements for one course including body text, for AI knowledge only.
 * Same endpoint and pagination as fetchAnnouncementsForCourse; does not modify the UI announcements flow.
 */
async function fetchAnnouncementsForCourseWithBody(courseId, xsrf) {
  const out = [];
  let url = `${BASE}/learn/api/v1/courses/${encodeURIComponent(courseId)}/announcements/?limit=${ANNOUNCEMENTS_PAGE_LIMIT}&offset=0`;
  const visitedUrls = new Set();
  while (url) {
    if (visitedUrls.has(url)) break;
    visitedUrls.add(url);
    const data = await bbFetchJson(url, xsrf);
    const results = getAnnouncementResultsFromPage(data);
    for (const r of results) {
      const id = r?.id ?? r?.announcementId ?? "";
      const title = (r?.title ?? r?.name ?? "").trim() || "(No title)";
      const dateISO = announcementDateISO(r);
      const createdDate = r?.createdDate ?? r?.created ?? "";
      const modifiedDate = r?.modifiedDate ?? r?.modified ?? "";
      const rawBody = r?.body?.rawText ?? r?.body?.displayText ?? "";
      const bodyText = announcementBodyToText(rawBody) || stripHtmlForAi(rawBody);
      out.push({
        announcementId: id,
        title,
        createdDate: typeof createdDate === "string" ? createdDate : (createdDate?.iso ?? ""),
        modifiedDate: typeof modifiedDate === "string" ? modifiedDate : (modifiedDate?.iso ?? ""),
        dateISO,
        courseId,
        bodyText,
        isRead: announcementReadStatus(r)
      });
    }
    const explicitNextPage = resolveAnnouncementNextPageUrl(url, getNextPageFromAnnouncementData(data));
    url = explicitNextPage || buildFallbackAnnouncementPageUrl(url, results.length);
  }
  out.sort((a, b) => (b.dateISO || "").localeCompare(a.dateISO || ""));
  return out;
}

async function runWithConcurrency(taskFns, limit) {
  const results = [];
  let index = 0;
  async function runNext() {
    const i = index++;
    if (i >= taskFns.length) return;
    results[i] = await taskFns[i]();
    await runNext();
  }
  const workers = Array.from({ length: Math.min(limit, taskFns.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

async function syncAllAnnouncementsInPage(xsrf) {
  const keys = window.CourseRegistry?.STORAGE_KEYS || { coursesList: "courseRegistry_coursesList", coursesByCourseId: "courseRegistry_coursesByCourseId" };
  const stored = await chrome.storage.local.get([keys.coursesList, keys.coursesByCourseId]);
  const coursesList = stored[keys.coursesList] || [];
  const coursesByCourseId = stored[keys.coursesByCourseId] || {};
  if (coursesList.length === 0) {
    return { ok: false, error: "No courses. Sync courses first.", data: [], errors: [] };
  }
  const taskFns = coursesList.map((meta) => {
    const courseId = meta.learnCourseId ?? meta.courseId;
    const courseName = meta.name ?? coursesByCourseId[courseId]?.name ?? courseId ?? "?";
    return async () => {
      try {
        const list = await fetchAnnouncementsForCourse(courseId, xsrf);
        return { courseId, courseName, announcements: list, error: null };
      } catch (e) {
        return { courseId, courseName, announcements: [], error: e?.message || String(e) };
      }
    };
  });
  const perCourse = await runWithConcurrency(taskFns, ANNOUNCEMENTS_CONCURRENCY);
  const errors = [];
  const byCourse = perCourse.map((c) => {
    if (c.error) errors.push({ courseId: c.courseId, courseName: c.courseName, error: c.error });
    const seen = new Set();
    const deduped = (c.announcements || []).filter((a) => {
      // Only dedupe when Blackboard gives us a stable id. If id is missing, keep the item
      // so we do not accidentally collapse different announcements that share title/date.
      const key = a.id ? `${c.courseId}|${a.id}` : "";
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    deduped.sort((x, y) => (y.dateISO || "").localeCompare(x.dateISO || ""));
    return {
      courseId: c.courseId,
      courseName: c.courseName,
      announcements: deduped,
      error: c.error || undefined
    };
  });
  byCourse.sort((a, b) => {
    const aNewest = a.announcements[0]?.dateISO || "";
    const bNewest = b.announcements[0]?.dateISO || "";
    return bNewest.localeCompare(aNewest);
  });
  await chrome.storage.local.set({
    [ANNOUNCEMENTS_STORAGE_KEYS.data]: byCourse,
    [ANNOUNCEMENTS_STORAGE_KEYS.syncedAt]: Date.now()
  });
  return { ok: true, data: byCourse, errors };
}

const ULTRA_BASE = "https://blackboard.ie.edu/ultra";

/**
 * Extrae el identificador del assessment real (no el columnId) del detalle de la columna.
 * Busca: assessmentId, gradableItemId, attemptableId, contentId, linkId, o content.id.
 */
function extractAssessmentIdFromColumnDetail(detail) {
  if (!detail || typeof detail !== "object") return null;
  const d = detail.column ?? detail;
  const id =
    d?.assessmentId ??
    d?.gradableItemId ??
    d?.attemptableId ??
    d?.contentId ??
    d?.linkId ??
    (d?.content && typeof d.content === "object" && d.content?.id) ??
    null;
  const str = id != null ? String(id).trim() : "";
  return str || null;
}

/**
 * True if the column is a Discussion type (gradebookCategory.title or localizableTitle.languageKey === "Discussion.name").
 * colOrDetail: raw column from list response or detail.column / detail.
 */
function isDiscussionColumn(colOrDetail) {
  if (!colOrDetail || typeof colOrDetail !== "object") return false;
  const cat = colOrDetail.gradebookCategory;
  if (!cat || typeof cat !== "object") return false;
  if (cat.title === "Discussion.name") return true;
  const loc = cat.localizableTitle;
  if (loc && typeof loc === "object" && loc.languageKey === "Discussion.name") return true;
  return false;
}

/**
 * Construye el enlace navegable en la UI Ultra (no el endpoint de API).
 * - Si la columna es Discussion (gradebookCategory title/languageKey "Discussion.name") y tiene contentId:
 *   /ultra/courses/{courseId}/grades/discussion/{contentId}?view=discussions&courseId={courseId}
 * - Si hay assessmentId → /ultra/courses/{courseId}/grades/assessment/{assessmentId}/overview?courseId={courseId}
 * - Si no (Attendance, columnas manuales) → fallback al gradebook del curso: /ultra/courses/{courseId}/grades
 * listColumn: raw column from GET gradebook/columns list (optional); used to detect Discussion and get contentId.
 */
function buildColumnNavigableUrl(courseId, columnId, detail, log, listColumn) {
  const d = detail && (detail.column ?? detail);
  const contentId = (listColumn && listColumn.contentId) || (d && d.contentId);
  if (contentId && (isDiscussionColumn(listColumn) || isDiscussionColumn(d))) {
    const url = `${ULTRA_BASE}/courses/${encodeURIComponent(courseId)}/grades/discussion/${encodeURIComponent(contentId)}?view=discussions&courseId=${encodeURIComponent(courseId)}`;
    if (log && Array.isArray(log)) {
      log.push("  link columnId=" + columnId + " discussion contentId=" + contentId + " url=" + url);
    }
    return url;
  }
  const assessmentId = extractAssessmentIdFromColumnDetail(detail);
  let url;
  if (assessmentId) {
    url = `${ULTRA_BASE}/courses/${encodeURIComponent(courseId)}/grades/assessment/${encodeURIComponent(assessmentId)}/overview?courseId=${encodeURIComponent(courseId)}`;
  } else {
    url = `${ULTRA_BASE}/courses/${encodeURIComponent(courseId)}/grades`;
  }
  if (log && Array.isArray(log)) {
    log.push("  link columnId=" + columnId + " assessmentId=" + (assessmentId || "(ninguno, fallback)") + " url=" + url);
  }
  return url;
}

/**
 * Normaliza detalle de columna a título y dueDate.
 * title: name || effectiveColumnName || columnName
 * dueDate: dueDate si existe
 */
function normalizeColumnDetail(detail) {
  if (!detail || typeof detail !== "object") return null;
  const d = detail.column ?? detail;
  const title =
    (d?.name ?? d?.effectiveColumnName ?? d?.columnName ?? "").trim() || null;
  const dueDate = d.dueDate ?? null;
  const pointsPossible = d.pointsPossible ?? d.possible ?? null;
  const availability = d.availability ?? null;
  const contentId = d.contentId ?? null;
  const linkId = d.linkId ?? null;
  const userCreatedColumn = d.userCreatedColumn === true;
  const isAttemptBased = d?.isAttemptBased === true;
  return {
    title,
    dueDate,
    pointsPossible,
    availability,
    contentId,
    linkId,
    userCreatedColumn,
    isAttemptBased,
    calculationType: d.calculationType,
    scorable: d.scorable
  };
}

/** Considera "assignment" si tiene dueDate o señales de tarea (contentId/linkId o userCreatedColumn). */
function isAssignmentLike(normalized) {
  if (!normalized) return false;
  if (normalized.dueDate) return true;
  if (normalized.contentId || normalized.linkId || normalized.userCreatedColumn) return true;
  return false;
}

/** Attendance/QWAttendance sin dueDate no cuentan como "próximas tareas". Siguen guardándose en columns. */
function isAttendanceLike(title) {
  if (!title || typeof title !== "string") return false;
  const t = title.trim().toLowerCase();
  return t === "attendance" || t === "qwattendance" || t.includes("attendance");
}

/**
 * Construye objeto assignment para storage/IA: { courseId, courseName, columnId, title, dueDate, urlOpcional }.
 * urlOpcional debe ser el enlace navegable Ultra (buildColumnNavigableUrl), no el endpoint de API.
 */
function toAssignment(courseId, courseName, columnId, normalized, navigableUrl) {
  if (!normalized || !isAssignmentLike(normalized)) return null;
  if (!normalized.dueDate && isAttendanceLike(normalized.title)) return null;
  const dueDateRaw = normalized.dueDate ?? null;
  const dueEpochMs =
    typeof window.TimeContext !== "undefined" && window.TimeContext.parseBbDateToEpoch
      ? window.TimeContext.parseBbDateToEpoch(dueDateRaw)
      : dueDateRaw
        ? new Date(dueDateRaw).getTime()
        : null;
  return {
    courseId,
    courseName,
    columnId,
    title: normalized.title || columnId,
    dueDate: dueDateRaw,
    dueDateRaw,
    dueEpochMs: Number.isNaN(dueEpochMs) ? null : dueEpochMs,
    pointsPossible: normalized.pointsPossible ?? null,
    urlOpcional: navigableUrl ?? null,
    isAttemptBased: normalized?.isAttemptBased ?? false
  };
}

async function findSyllabusLaunchUrlForCourse(learnCourseId, xsrf) {
  const toVisit = ["ROOT"];
  const visited = new Set();

  while (toVisit.length) {
    const parentId = toVisit.shift();
    if (visited.has(parentId)) continue;
    visited.add(parentId);

    const url =
      `${BASE}/learn/api/v1/courses/${encodeURIComponent(learnCourseId)}` +
      `/contents/${encodeURIComponent(parentId)}/children?@view=Summary&limit=200` +
      `&expand=assignedGroups,selfEnrollmentGroups.group,gradebookCategory` +
      `&includeInActivityTracking=true`;

    let nextUrl = url;
    while (nextUrl) {
      const data = await bbFetchJson(nextUrl, xsrf);
      const items = data?.results ?? [];

      for (const item of items) {
        const launch = extractSyllabusLaunchUrl(item);
        if (launch) return normalizeLaunchUrl(launch);
        if (isContainer(item) && item?.id) toVisit.push(item.id);
      }

      const np = data?.paging?.nextPage;
      nextUrl = np && np.trim() ? (np.startsWith("http") ? np : BASE + np) : null;
    }
  }
  return null;
}

function extractSyllabusLaunchUrl(item) {
  if (item?.contentHandler === "resource/x-bb-bltiplacement-IESyllabus") {
    const node = item?.contentDetail?.["resource/x-bb-bltiplacement-IESyllabus"];
    return node?.launchLink || node?.placement?.launchLink || null;
  }
  const node = item?.contentDetail?.["resource/x-bb-bltiplacement-IESyllabus"];
  if (node?.launchLink) return node.launchLink;
  if (node?.placement?.launchLink) return node.placement.launchLink;
  const title = (item?.title || "").toLowerCase();
  if (title.includes("syllabus")) {
    try {
      const s = JSON.stringify(item);
      const m = s.match(/"launchLink"\s*:\s*"([^"]+)"/);
      if (m?.[1] && m[1].includes("launchPlacement")) return m[1];
    } catch (_) {}
  }
  return null;
}

function normalizeLaunchUrl(launchLinkOrUrl) {
  let u = launchLinkOrUrl;
  if (u.startsWith("/")) u = BASE + u;
  if (u.includes("launchPlacement") && !u.includes("from_ultra=true")) {
    u += (u.includes("?") ? "&" : "?") + "from_ultra=true";
  }
  return u;
}

function isContainer(item) {
  const ch = item?.contentHandler || "";
  if (ch === "resource/x-bb-folder" || ch === "resource/x-bb-lesson") return true;
  const cd = item?.contentDetail;
  if (cd?.["resource/x-bb-folder"]?.isFolder) return true;
  if (cd?.["resource/x-bb-lesson"]?.isLesson || cd?.["resource/x-bb-lesson"]?.isFolder) return true;
  return false;
}

async function discoverAuth() {
  const log = [];
  let xsrf = null;
  if (typeof window.__BB_XSRF__ !== "undefined" && window.__BB_XSRF__) xsrf = window.__BB_XSRF__;
  if (!xsrf && window.bbConfig?.xsrf) xsrf = window.bbConfig.xsrf;
  if (!xsrf && window.Blackboard?.xsrf) xsrf = window.Blackboard.xsrf;
  const meta = document.querySelector('meta[name="blackboard-xsrf"], meta[name="xsrf-token"], meta[name="x-blackboard-xsrf"]');
  if (!xsrf && meta?.content) xsrf = meta.content.trim();
  try {
    for (const key of Object.keys(sessionStorage || {})) {
      if (key.toLowerCase().includes("xsrf")) { xsrf = sessionStorage.getItem(key); break; }
    }
  } catch (_) {}
  if (!xsrf) {
    try {
      for (const key of Object.keys(localStorage || {})) {
        if (key.toLowerCase().includes("xsrf")) { xsrf = localStorage.getItem(key); break; }
      }
    } catch (_) {}
  }
  if (xsrf) return { ok: true, xsrf, log: log.join("; ") };
  try {
    const res = await fetch(`${BASE}/learn/api/public/v1/users/me`, { method: "GET", credentials: "include", headers: { Accept: "application/json" } });
    const h = res.headers.get("X-Blackboard-XSRF") || res.headers.get("x-blackboard-xsrf") || res.headers.get("X-XSRF-TOKEN");
    if (h) return { ok: true, xsrf: h, log: log.join("; ") };
    if (res.ok) return { ok: true, xsrf: null, log: log.join("; ") };
    if (res.status === 403 && res.headers.get("X-Blackboard-XSRF")) return { ok: true, xsrf: res.headers.get("X-Blackboard-XSRF"), log: log.join("; ") };
  } catch (e) {
    log.push("users/me error: " + (e?.message || e));
  }
  return { ok: false, error: XSRF_ERROR_ACTIONABLE, log: log.join("; ") };
}
