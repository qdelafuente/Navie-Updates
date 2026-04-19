/**
 * Calendar-based enrichment for midterm dates when session is known but date is missing.
 * Uses Blackboard calendar items to map midterm_session -> startDate/endDate.
 * Deterministic; no LLM.
 */

/**
 * @param {Date} [now]
 * @param {number} [daysBack] - days before now (default 70). If daysForward is omitted, used for both sides (symmetric).
 * @param {number} [daysForward] - days after now. If omitted, same as daysBack.
 * @returns {{ sinceISO: string, untilISO: string }}
 */
export function buildCalendarWindow(now = new Date(), daysBack = 70, daysForward = undefined) {
  const forward = daysForward !== undefined ? daysForward : daysBack;
  const since = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const until = new Date(now.getTime() + forward * 24 * 60 * 60 * 1000);
  return {
    sinceISO: since.toISOString(),
    untilISO: until.toISOString()
  };
}

/**
 * @param {string} s
 * @returns {string}
 */
export function normalizeText(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/\s+/g, " ")
    .replace(/[.,:;()[\]?!\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * Parse session numbers and ranges from calendar item title.
 * Supports: "(Ses. 17)", "(Ses. 6-7)", "Session 13 & 14", "S15 & S16", "Ses 15".
 * @param {string} title
 * @returns {{ sessions: number[], ranges: Array<{ from: number, to: number }> }}
 */
export function parseCalendarSessionTokens(title) {
  const sessions = new Set();
  const ranges = [];
  if (!title || typeof title !== "string") return { sessions: [], ranges: [] };

  const rangeRe = /\b(?:ses\.?|session|s)\s*(\d{1,3})\s*[-–]\s*(\d{1,3})\b/gi;
  let m;
  while ((m = rangeRe.exec(title)) !== null) {
    const from = parseInt(m[1], 10);
    const to = parseInt(m[2], 10);
    if (from >= 1 && from <= 200 && to >= 1 && to <= 200) {
      ranges.push({ from: Math.min(from, to), to: Math.max(from, to) });
    }
  }

  const singleRe = /\b(?:ses\.?|session|s)\s*(\d{1,3})\b/gi;
  while ((m = singleRe.exec(title)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 200) sessions.add(n);
  }

  const andRe = /\b(\d{1,3})\s*&\s*(\d{1,3})\b/g;
  while ((m = andRe.exec(title)) !== null) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a >= 1 && a <= 200) sessions.add(a);
    if (b >= 1 && b <= 200) sessions.add(b);
  }

  for (const r of ranges) {
    for (let i = r.from; i <= r.to; i++) sessions.add(i);
  }

  return { sessions: [...sessions], ranges };
}

/**
 * @param {unknown} item - raw calendar item
 * @returns {{ title: string, startDate: string, endDate: string, calendarName: string, calendarId: string, itemSourceId?: string }}
 */
function normalizeCalendarItem(item) {
  const o = item && typeof item === "object" ? item : {};
  const title = (o.title ?? o.name ?? "").trim();
  const startDate = (o.startDate ?? o.start ?? o.startDateISO ?? "").trim();
  const endDate = (o.endDate ?? o.end ?? o.endDateISO ?? "").trim();
  const calName = (o.calendarNameLocalizable?.rawValue ?? o.calendarName ?? o.calendarNameLocalizable ?? "").trim();
  const calendarId = (o.calendarId ?? o.calendar_id ?? "").trim();
  const itemSourceId = (o.id ?? o.itemSourceId ?? o.item_id ?? "").trim();
  return { title, startDate, endDate, calendarName: typeof calName === "string" ? calName : "", calendarId, itemSourceId };
}

/**
 * Score how well a calendar item matches the course context.
 * @param {{ title: string, calendarName: string }} item
 * @param {{ courseTitle: string|null, calendarId: string|null, calendarNameRawHint: string|null }} courseContext
 * @returns {number}
 */
function scoreCourseMatch(item, courseContext) {
  let score = 0;
  const nameNorm = normalizeText(item.calendarName);
  const titleNorm = normalizeText(item.title);
  const courseTitleNorm = normalizeText(courseContext.courseTitle || "");
  const hintNorm = normalizeText(courseContext.calendarNameRawHint || "");

  if (courseContext.calendarId && item.calendarId === courseContext.calendarId) return 3;
  if (courseTitleNorm && nameNorm.includes(courseTitleNorm)) score = Math.max(score, 3);
  if (courseTitleNorm && titleNorm.includes(courseTitleNorm)) score = Math.max(score, 2);
  if (hintNorm && (nameNorm.includes(hintNorm) || titleNorm.includes(hintNorm))) score = Math.max(score, 2);
  if (score === 0 && (nameNorm || titleNorm)) score = 1;
  return score;
}

/**
 * @param {string} iso
 * @returns {{ date: string, time: string }}
 */
function isoToDateAndTime(iso) {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return {
    date: `${y}-${mo}-${day}`,
    time: `${h}:${min}`
  };
}

/**
 * @param {Object} resolvedMidterm - output of resolveMidtermSession
 * @param {{ getCalendarItems: (opts: { sinceISO: string, untilISO: string }) => Promise<{ ok: boolean, items?: unknown[] }> }} calendarClient
 * @param {{ courseId: string, courseTitle?: string|null, calendarId?: string|null, calendarNameRawHint?: string|null }} courseContext
 * @returns {Promise<Object>} enriched resolution with calendar_inferred, calendar_match, and possibly midterm_date/time from calendar
 */
export async function enrichMidtermWithCalendar(resolvedMidterm, calendarClient, courseContext) {
  const base = { ...resolvedMidterm };
  const targetSession = base.midterm_session;
  if (base.midterm_date != null || targetSession == null) {
    return {
      ...base,
      calendar_inferred: false,
      calendar_match: null
    };
  }

  const now = new Date();
  // Use 150 days back so midterms that already happened (common mid-semester) are always in range.
  const { sinceISO, untilISO } = buildCalendarWindow(now, 150, 60);
  let res;
  try {
    res = await calendarClient.getCalendarItems({ sinceISO, untilISO });
  } catch (e) {
    return {
      ...base,
      calendar_inferred: false,
      calendar_match: { matched: false, reason: "Calendar request failed", candidateCount: 0 }
    };
  }

  if (!res?.ok || !Array.isArray(res.items)) {
    return {
      ...base,
      calendar_inferred: false,
      calendar_match: { matched: false, reason: "No calendar items", candidateCount: 0 }
    };
  }

  const courseTitleNorm = normalizeText(courseContext.courseTitle || "");
  const candidates = [];

  for (const raw of res.items) {
    const item = normalizeCalendarItem(raw);
    const { sessions } = parseCalendarSessionTokens(item.title);
    if (!sessions.includes(targetSession)) continue;

    const courseScore = scoreCourseMatch(item, {
      courseTitle: courseContext.courseTitle ?? null,
      calendarId: courseContext.calendarId ?? null,
      calendarNameRawHint: courseContext.calendarNameRawHint ?? null
    });
    if (courseTitleNorm && courseScore < 2) continue;
    if (courseScore === 0) continue;

    let titleScore = 0;
    if (/\b(ses\.?|session|s)\s*\d/i.test(item.title)) titleScore = 1;

    candidates.push({
      ...item,
      courseScore,
      titleScore,
      matchedSessions: sessions,
      totalScore: courseScore + titleScore
    });
  }

  if (candidates.length === 0) {
    return {
      ...base,
      calendar_inferred: false,
      calendar_match: {
        matched: false,
        reason: "No calendar item matched session " + targetSession + " for this course",
        candidateCount: 0
      }
    };
  }

  candidates.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    const aStart = a.startDate || "";
    const bStart = b.startDate || "";
    return aStart.localeCompare(bStart);
  });

  const best = candidates[0];
  const { date, time } = isoToDateAndTime(best.startDate);

  const calendarEvidence = {
    source: "calendar",
    id: best.itemSourceId || best.calendarId || null,
    createdAt: null,
    text: best.title,
    start: null,
    end: null
  };

  return {
    ...base,
    midterm_date: date,
    midterm_time: time,
    timezone: "UTC",
    evidence: [...(base.evidence || []), calendarEvidence].slice(0, 6),
    calendar_inferred: true,
    calendar_match: {
      matched: true,
      calendarId: best.calendarId,
      itemSourceId: best.itemSourceId,
      title: best.title,
      startDate: best.startDate,
      endDate: best.endDate,
      matchedSessions: best.matchedSessions,
      candidateCount: candidates.length
    },
    reason: (base.reason || "") + (base.reason ? " " : "") + "Date from calendar (session " + targetSession + ")."
  };
}

/**
 * Same as enrichMidtermWithCalendar but for final exam: uses final_session to find date from calendar.
 * @param {Object} resolvedFinal - output of resolveFinalSession (final_session, final_date, final_time, ...)
 * @param {{ getCalendarItems: (opts: { sinceISO: string, untilISO: string }) => Promise<{ ok: boolean, items?: unknown[] }> }} calendarClient
 * @param {{ courseId: string, courseTitle?: string|null, calendarId?: string|null, calendarNameRawHint?: string|null }} courseContext
 * @returns {Promise<Object>} enriched with final_date, final_time, calendar_inferred, calendar_match when match found
 */
export async function enrichFinalWithCalendar(resolvedFinal, calendarClient, courseContext) {
  const base = { ...resolvedFinal };
  const targetSession = base.final_session;
  if (base.final_date != null || targetSession == null) {
    return {
      ...base,
      calendar_inferred: false,
      calendar_match: null
    };
  }

  const now = new Date();
  const { sinceISO, untilISO } = buildCalendarWindow(now, 120);
  let res;
  try {
    res = await calendarClient.getCalendarItems({ sinceISO, untilISO });
  } catch (e) {
    return {
      ...base,
      calendar_inferred: false,
      calendar_match: { matched: false, reason: "Calendar request failed", candidateCount: 0 }
    };
  }

  if (!res?.ok || !Array.isArray(res.items)) {
    return {
      ...base,
      calendar_inferred: false,
      calendar_match: { matched: false, reason: "No calendar items", candidateCount: 0 }
    };
  }

  const courseTitleNorm = normalizeText(courseContext.courseTitle || "");
  const candidates = [];

  for (const raw of res.items) {
    const item = normalizeCalendarItem(raw);
    const { sessions } = parseCalendarSessionTokens(item.title);
    if (!sessions.includes(targetSession)) continue;

    const courseScore = scoreCourseMatch(item, {
      courseTitle: courseContext.courseTitle ?? null,
      calendarId: courseContext.calendarId ?? null,
      calendarNameRawHint: courseContext.calendarNameRawHint ?? null
    });
    if (courseTitleNorm && courseScore < 2) continue;
    if (courseScore === 0) continue;

    let titleScore = 0;
    if (/\b(ses\.?|session|s)\s*\d/i.test(item.title)) titleScore = 1;

    candidates.push({
      ...item,
      courseScore,
      titleScore,
      matchedSessions: sessions,
      totalScore: courseScore + titleScore
    });
  }

  if (candidates.length === 0) {
    return {
      ...base,
      calendar_inferred: false,
      calendar_match: {
        matched: false,
        reason: "No calendar item matched session " + targetSession + " for this course",
        candidateCount: 0
      }
    };
  }

  candidates.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    const aStart = a.startDate || "";
    const bStart = b.startDate || "";
    return aStart.localeCompare(bStart);
  });

  const best = candidates[0];
  const { date, time } = isoToDateAndTime(best.startDate);

  const calendarEvidence = {
    source: "calendar",
    id: best.itemSourceId || best.calendarId || null,
    createdAt: null,
    text: best.title,
    start: null,
    end: null
  };

  return {
    ...base,
    final_date: date,
    final_time: time,
    timezone: base.timezone || "UTC",
    evidence: [...(base.evidence || []), calendarEvidence].slice(0, 6),
    calendar_inferred: true,
    calendar_match: {
      matched: true,
      calendarId: best.calendarId,
      itemSourceId: best.itemSourceId,
      title: best.title,
      startDate: best.startDate,
      endDate: best.endDate,
      matchedSessions: best.matchedSessions,
      candidateCount: candidates.length
    },
    reason: (base.reason || "") + (base.reason ? " " : "") + "Date from calendar (session " + targetSession + ")."
  };
}

/**
 * Resolve midterm then enrich with calendar when date is missing but session exists.
 * @param {string} syllabus_raw_text
 * @param {Array} announcements
 * @param {Array} messages
 * @param {{ getCalendarItems: (opts: { sinceISO: string, untilISO: string }) => Promise<{ ok: boolean, items?: unknown[] }> }} calendarClient
 * @param {{ courseId: string, courseTitle?: string|null, calendarId?: string|null, calendarNameRawHint?: string|null }} courseContext
 * @param {import("./midtermSessionDetector.js")} detector - module with resolveMidtermSession
 * @returns {Promise<Object>}
 */
export async function resolveMidterm(syllabus_raw_text, announcements, messages, calendarClient, courseContext, detector) {
  const base = detector.resolveMidtermSession(syllabus_raw_text || "", announcements || [], messages || []);
  if (base.midterm_date != null || base.midterm_session == null) {
    return {
      ...base,
      calendar_inferred: false,
      calendar_match: null
    };
  }
  return enrichMidtermWithCalendar(base, calendarClient, courseContext);
}

/*
  Usage example with mocks:

  const { resolveMidterm } = await import("./calendarMidtermEnricher.js");
  const { resolveMidtermSession } = await import("./midtermSessionDetector.js");

  const mockCalendarClient = {
    getCalendarItems: async ({ sinceISO, untilISO }) => ({
      ok: true,
      items: [
        {
          title: "PRINCIPLES OF PROGRAMMING (Ses. 14)",
          startDate: "2026-04-20T09:00:00.000Z",
          endDate: "2026-04-20T10:30:00.000Z",
          calendarNameLocalizable: { rawValue: "PRINCIPLES OF PROGRAMMING" },
          calendarId: "cal1"
        }
      ]
    })
  };

  const syllabus = "SESSION 14 MID-TERM EXAM";
  const courseContext = { courseId: "c1", courseTitle: "PRINCIPLES OF PROGRAMMING", calendarId: null };
  const enriched = await resolveMidterm(syllabus, [], [], mockCalendarClient, courseContext, { resolveMidtermSession });
  // enriched.midterm_date === "2026-04-20", enriched.midterm_time === "09:00", enriched.calendar_inferred === true
*/
