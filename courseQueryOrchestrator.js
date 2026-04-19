/**
 * Combined course query orchestration: Calendar + Announcements + Syllabus.
 * Does not modify calendar, announcements, or syllabus tools; only composes and ranks evidence.
 */

import { classifySyllabusQuestion, searchSyllabusStructure, buildFullSyllabusContext, SYLLABUS_EXTRACTION_MAP } from "./syllabusIntelligence.js";

/** For combined course query (midterm/final/session date questions): fetch ALL classes from 200 days back to 200 days forward. */
const COMBINED_CALENDAR_DAYS = 200;
const MAX_EVIDENCE_CALENDAR = 50;
const MAX_EVIDENCE_ANNOUNCEMENTS = 12;
const MAX_SYLLABUS_CHARS = 90000;
/** Full announcement body for AI (no truncation); cap per item to avoid huge prompts. */
const MAX_ANNOUNCEMENT_BODY_CHARS = 25000;

/**
 * @typedef {{ source: 'calendar'|'announcements'|'syllabus', courseId: string, courseName: string, title: string, text: string, startDate?: string, endDate?: string, createdDate?: string, modifiedDate?: string, url?: string, raw?: unknown }} EvidenceItem
 */

/**
 * Get calendar API since/until for combined query (midterm/final, "when is session X"): now ± 200 days so all sessions are available.
 * @param {Date} now
 * @returns {{ since: string, until: string }}
 */
function getCalendarRange120(now) {
  const from = new Date(now);
  from.setDate(from.getDate() - COMBINED_CALENDAR_DAYS);
  const to = new Date(now);
  to.setDate(to.getDate() + COMBINED_CALENDAR_DAYS);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    since: `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}T00:00Z`,
    until: `${to.getFullYear()}-${pad(to.getMonth() + 1)}-${pad(to.getDate())}T22:59Z`
  };
}

/**
 * Extract course name from calendar item (calendarNameLocalizable / calendarName often "X: Course Name").
 * @param {unknown} raw
 * @returns {string}
 */
function getCourseNameFromCalendarItem(raw) {
  const loc = raw?.calendarNameLocalizable ?? raw?.calendarName ?? {};
  const rawValue = typeof loc === "string" ? loc : (loc?.rawValue ?? loc?.value ?? "");
  const str = (typeof rawValue === "string" ? rawValue : "").trim();
  return str.indexOf(": ") !== -1 ? str.slice(str.indexOf(": ") + 2).trim() : str;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function formatCalendarDate(raw) {
  const s = raw?.startDate ?? raw?.startDateTime ?? raw?.startTime ?? "";
  if (!s) return "";
  try {
    const d = new Date(s);
    return isNaN(d.getTime()) ? String(s) : d.toISOString();
  } catch (_) {
    return String(s);
  }
}

/** Convert ISO date string to local time for display (so AI shows correct local hour, not UTC). */
function formatCalendarDateToLocal(isoOrEmpty) {
  if (!isoOrEmpty || typeof isoOrEmpty !== "string") return isoOrEmpty || "";
  try {
    const d = new Date(isoOrEmpty);
    if (isNaN(d.getTime())) return isoOrEmpty;
    // Always format in English so the model sees dates in English.
    return d.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" });
  } catch (_) {
    return isoOrEmpty;
  }
}

/**
 * Normalize calendar API items to EvidenceItems. Filter by courseName if provided.
 * @param {unknown[]} rawItems
 * @param {{ courseId: string, name: string }} course
 * @returns {EvidenceItem[]}
 */
function normalizeCalendarToEvidence(rawItems, course) {
  const courseNameLower = (course.name || "").toLowerCase();
  const items = (rawItems || []).filter((raw) => {
    if (!courseNameLower) return true;
    const itemCourse = getCourseNameFromCalendarItem(raw);
    return (
      itemCourse.toLowerCase().includes(courseNameLower) ||
      courseNameLower.includes(itemCourse.toLowerCase())
    );
  });
  return items.map((raw) => {
    const title = (raw?.title ?? raw?.name ?? raw?.itemName ?? "").toString().trim() || "(no title)";
    const itemCourse = getCourseNameFromCalendarItem(raw);
    const startDate = formatCalendarDate(raw);
    const endRaw = raw?.endDate ?? raw?.endDateTime ?? raw?.endTime;
    return {
      source: "calendar",
      courseId: course.courseId,
      courseName: course.name || itemCourse,
      title,
      text: title + (startDate ? " " + startDate : ""),
      startDate: startDate || undefined,
      endDate: endRaw ? formatCalendarDate({ startDate: endRaw }) : undefined,
      raw
    };
  });
}

/**
 * Normalize announcements list to EvidenceItems.
 * @param {{ title?: string, bodyText?: string, dateISO?: string, createdDate?: string, modifiedDate?: string, announcementId?: string, isRead?: boolean }[]} list
 * @param {{ courseId: string, name: string }} course
 * @param {string} baseUrl
 * @returns {EvidenceItem[]}
 */
function normalizeAnnouncementsToEvidence(list, course, baseUrl) {
  const sorted = [...(list || [])].sort((a, b) => {
    const da = a.dateISO || a.createdDate || a.modifiedDate || "";
    const db = b.dateISO || b.createdDate || b.modifiedDate || "";
    return db.localeCompare(da);
  });
  return sorted.map((a) => {
    const id = a.announcementId || "";
    const url = id ? `${baseUrl}/${encodeURIComponent(course.courseId)}/announcements/announcement-detail?courseId=${encodeURIComponent(course.courseId)}&announcementId=${encodeURIComponent(id)}` : undefined;
    const rawBody = a.bodyText || "";
    const text = rawBody.length > MAX_ANNOUNCEMENT_BODY_CHARS ? rawBody.slice(0, MAX_ANNOUNCEMENT_BODY_CHARS) + "\n[... truncated for length]" : rawBody;
    return {
      source: "announcements",
      courseId: course.courseId,
      courseName: course.name,
      title: (a.title || "").trim() || "(No title)",
      text,
      createdDate: a.dateISO || a.createdDate || a.modifiedDate,
      modifiedDate: a.modifiedDate || a.createdDate,
      url,
      raw: a
    };
  });
}

/**
 * Returns true when the syllabus document title shares at least one significant word with the
 * expected course name. Used to reject clearly wrong syllabi (e.g. "Cost Accounting" returned
 * for "IE Humanities"). Only fires when fetchedTitle is non-empty; empty title = can't validate.
 * @param {string} fetchedTitle - courseTitle extracted from the syllabus HTML
 * @param {string} expectedCourseName - the course name we asked for
 * @returns {boolean}
 */
function syllabusCourseTitleMatches(fetchedTitle, expectedCourseName) {
  if (!fetchedTitle || !fetchedTitle.trim()) return true; // Can't validate — pass through
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const stopWords = new Set(["the", "and", "for", "of", "in", "to", "a", "an", "de", "del", "la", "el", "los", "las", "y"]);
  const sigWords = (s) => norm(s).split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
  const fetchedWords = new Set(sigWords(fetchedTitle));
  const expectedWords = sigWords(expectedCourseName);
  if (fetchedWords.size === 0 || expectedWords.length === 0) return true;
  return expectedWords.some((w) => fetchedWords.has(w));
}

/**
 * Secondary validation: checks if any significant word of the expected course name appears
 * in the first ~1500 chars of the raw syllabus text (the header/intro area where the course
 * name almost always appears). Used as a fallback when title extraction fails or is ambiguous.
 * Only checks first 1500 chars to avoid false positives from body text that mentions other courses.
 * @param {string} rawText
 * @param {string} expectedCourseName
 * @returns {boolean}
 */
function syllabusRawTextMatchesCourse(rawText, expectedCourseName) {
  if (!rawText || rawText.length < 50) return true; // Too short — can't validate, pass through
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const stopWords = new Set(["the", "and", "for", "of", "in", "to", "a", "an", "de", "del", "la", "el", "los", "las", "y"]);
  const sigWords = (s) => norm(s).split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
  const expectedWords = sigWords(expectedCourseName);
  if (expectedWords.length === 0) return true;
  const excerpt = norm(rawText.slice(0, 1500));
  return expectedWords.some((w) => excerpt.includes(w));
}

/**
 * Build syllabus EvidenceItems from structured syllabus (one summary item + optional search result).
 * Returns [] when the syllabus document title clearly belongs to a different course —
 * prevents wrong content from being fed to the LLM.
 * @param {unknown} structured - Return type of parseSyllabusHtml
 * @param {{ courseId: string, name: string }} course
 * @param {string} userQuery
 * @returns {EvidenceItem[]}
 */
function normalizeSyllabusToEvidence(structured, course, userQuery) {
  const fetchedTitle = (structured && structured.courseTitle) ? structured.courseTitle.trim() : "";

  // Mismatch detection: use a two-stage check to decide whether to add a warning.
  // We NEVER hard-reject (return []) because false rejections leave the LLM with no syllabus
  // at all, which is worse than including the content with a clear warning.
  // Stage 1 — title word-overlap.
  // Stage 2 — rawText fallback (handles cases where title extraction picked up an institutional
  //   name like "IE University" instead of the actual course name).
  // If BOTH checks fail → the syllabus is very likely for a different course → prepend a strong
  //   warning so the LLM knows to ignore it. If either check passes → include without warning.
  let mismatchWarning = "";
  if (fetchedTitle && !syllabusCourseTitleMatches(fetchedTitle, course.name)) {
    const rawText = (structured && structured.rawText) ? structured.rawText : "";
    const confirmedByRawText = syllabusRawTextMatchesCourse(rawText, course.name);
    if (!confirmedByRawText) {
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[CourseQueryOrchestrator] Possible syllabus mismatch — title '" + fetchedTitle + "' and rawText header don't match '" + course.name + "'. Adding mismatch warning to evidence.");
      }
      mismatchWarning =
        "[SYLLABUS MISMATCH WARNING: The fetched document title is '" + fetchedTitle + "' but the expected course is '" + course.name + "'. " +
        "This syllabus content likely belongs to a DIFFERENT course. " +
        "DO NOT use it to answer questions about '" + course.name + "'. " +
        "If this is the only available syllabus, tell the user the syllabus for '" + course.name + "' is not available.]\n\n";
    } else if (typeof console !== "undefined" && console.warn) {
      console.warn("[CourseQueryOrchestrator] Title '" + fetchedTitle + "' didn't match '" + course.name + "' but rawText confirms course — including without warning.");
    }
  }

  const intent = classifySyllabusQuestion(userQuery || "");
  const searchResult = searchSyllabusStructure(structured, userQuery || "", intent);
  const fullContext = buildFullSyllabusContext(structured, { canonicalCourseName: course.name || "" });
  const truncated = fullContext.length > MAX_SYLLABUS_CHARS ? fullContext.slice(0, MAX_SYLLABUS_CHARS) + "\n[... truncated]" : fullContext;

  const items = [];
  if (searchResult && searchResult.trim()) {
    items.push({
      source: "syllabus",
      courseId: course.courseId,
      courseName: course.name,
      title: "Syllabus (relevant to query)",
      text: mismatchWarning + searchResult,
      raw: structured
    });
  }
  items.push({
    source: "syllabus",
    courseId: course.courseId,
    courseName: course.name,
    title: "Syllabus (full context)" + (mismatchWarning ? " [POSSIBLE WRONG COURSE]" : ""),
    text: mismatchWarning + truncated,
    raw: structured
  });
  return items;
}

/**
 * Rank and select top evidence per source for the user query.
 * @param {string} userQuery
 * @param {{ calendar: EvidenceItem[], announcements: EvidenceItem[], syllabus: EvidenceItem[] }} bySource
 * @returns {{ calendar: EvidenceItem[], announcements: EvidenceItem[], syllabus: EvidenceItem[], nextUpcoming?: EvidenceItem, mostRecentAnnouncement?: EvidenceItem }}
 */
function rankEvidence(userQuery, bySource) {
  const q = (userQuery || "").toLowerCase();
  const isSessionX = /\b(?:session|ses\.?|sesi[oó]n)\s*(?:#?\s*)?(\d+)\b/i.test(userQuery);
  const sessionNumMatch = userQuery.match(/(?:session|ses\.?|sesi[oó]n)\s*(?:#?\s*)?(\d+)/i);
  const sessionNum = sessionNumMatch ? parseInt(sessionNumMatch[1], 10) : null;
  const isLastAnnouncement = /\b(?:last|latest|most\s+recent|newest)\s+(?:announcement|update|post|message)\b/i.test(q) || /\b(?:announcement|update)s?\s+(?:last|latest|recent)\b/i.test(q);
  const isWhenSession = /\bwhen\s+(?:is|do)\s+(?:session|class|sesi[oó]n)\b/i.test(q);

  const sortedCalendar = [...(bySource.calendar || [])].sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));
  let calendar = sortedCalendar;
  if (sessionNum != null && isSessionX) {
    const sessionRe = new RegExp(`(?:Ses\\.?|Session|Sesi[oó]n)\\s*${sessionNum}\\b|\\b${sessionNum}\\s*(?:st|nd|rd|th)?\\s*(?:session|ses\\.?)`, "i");
    calendar = sortedCalendar.filter((e) => sessionRe.test(e.title)).slice(0, 5);
    if (calendar.length === 0) calendar = sortedCalendar.slice(0, MAX_EVIDENCE_CALENDAR);
  } else {
    calendar = sortedCalendar.slice(0, MAX_EVIDENCE_CALENDAR);
  }
  const byStart = [...calendar].sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));
  const nowIso = new Date().toISOString();
  const nextUpcoming = byStart.find((e) => (e.startDate || "") >= nowIso);

  let announcements = bySource.announcements || [];
  const mostRecentAnnouncement = announcements[0] || null;
  if (isLastAnnouncement) {
    announcements = announcements.slice(0, 3);
  } else {
    // Score announcements by keyword relevance before applying the limit,
    // so that relevant but older announcements are not cut off.
    const queryWords = q.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (queryWords.length > 0) {
      const scored = announcements.map((a, i) => {
        const hay = ((a.title || "") + " " + (a.text || "")).toLowerCase();
        const hits = queryWords.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
        return { a, hits, i };
      });
      // Sort: most keyword-relevant first; tie-break by original order (newest-first).
      scored.sort((x, y) => y.hits - x.hits || x.i - y.i);
      announcements = scored.map((s) => s.a).slice(0, MAX_EVIDENCE_ANNOUNCEMENTS);
    } else {
      announcements = announcements.slice(0, MAX_EVIDENCE_ANNOUNCEMENTS);
    }
  }

  const syllabus = (bySource.syllabus || []).slice(0, 3);

  return {
    calendar,
    announcements,
    syllabus,
    nextUpcoming,
    mostRecentAnnouncement
  };
}

/**
 * Build a single combined context string for the LLM.
 * @param {{ courseName: string, courseId: string }} course
 * @param {string} userQuery
 * @param {{ calendar: EvidenceItem[], announcements: EvidenceItem[], syllabus: EvidenceItem[], nextUpcoming?: EvidenceItem, mostRecentAnnouncement?: EvidenceItem }} ranked
 * @param {string[]} notes
 * @returns {string}
 */
function buildCombinedContext(course, userQuery, ranked, notes) {
  const lines = [];
  lines.push(`Course: ${course.courseName} (${course.courseId})`);
  lines.push(`User question: ${userQuery}`);
  lines.push("");

  const isSessionContentQuestion = /\b(about|cover|covers|topic|topics|content|what('s| is)\s+(session|sesi[oó]n)\s+\d+)/i.test(userQuery || "");
  if (isSessionContentQuestion) {
    lines.push("Instruction: For 'what is session X about?' use the SYLLABUS section below for topics and content. Use CALENDAR only for date/time.");
    lines.push("");
  }

  const isExamDateQuestion = /\b(when|when's|whens|when\s+is|date|fecha|cu[aá]ndo)\b/i.test(userQuery || "") && /\b(midterm|mid-term|final\s+exam|final\s+examination|final\s+test|exam\s+date|final)\b/i.test(userQuery || "");
  if (isExamDateQuestion) {
    lines.push("CRITICAL — Answer in this exact order:");
    lines.push("1) SYLLABUS: Find which SESSION number the midterm/final/exam is in. Look at the syllabus Program/Sessions and Evaluation sections. The syllabus may say e.g. 'Session 16: Midterm' or list midterm under a session number. Identify that session number.");
    lines.push("2) CALENDAR: Find the calendar event for THIS course whose title contains that session number (e.g. 'Session 16' or 'Session 20'). Report the date and time of that event. Never invent or approximate a date.");
    lines.push("3) ANNOUNCEMENTS: Check if any announcement changes the date, room, or format; mention it if relevant.");
    lines.push("Your answer must state: (a) which session the exam is (from syllabus), (b) the calendar date and time for that session, (c) any announcement update if present.");
    lines.push("");
  }

  const isWhenDateQuestion = /\b(when|when's|whens|when\s+is|date|fecha|cu[aá]ndo)\b/i.test(userQuery || "") && /\b(session|sesi[oó]n|midterm|exam|final|class|clase)\b/i.test(userQuery || "");
  if (isWhenDateQuestion && !isExamDateQuestion) {
    lines.push("Instruction: For 'when is session X?' use the CALENDAR section below. Reply with the exact date and time (e.g. Monday, February 18, 2025) for that session.");
    lines.push("");
  }

  if (isExamDateQuestion) {
    lines.push("--- SYLLABUS (first: find which SESSION the midterm/final/exam is in — Program/Sessions, Evaluation) ---");
    lines.push(SYLLABUS_EXTRACTION_MAP);
    lines.push("");
    ranked.syllabus.forEach((e) => {
      lines.push(e.title + ":");
      lines.push((e.text || "").slice(0, MAX_SYLLABUS_CHARS));
    });
    if (ranked.syllabus.length === 0) lines.push("(No syllabus content available.)");
    lines.push("");

    lines.push("--- CALENDAR (second: find the event for that session number — date and time in LOCAL time) ---");
    if (ranked.nextUpcoming) {
      lines.push("Next upcoming session: " + ranked.nextUpcoming.title + " | " + formatCalendarDateToLocal(ranked.nextUpcoming.startDate) + " | " + (ranked.nextUpcoming.text || ""));
    }
    ranked.calendar.forEach((e) => {
      lines.push("- " + e.title + " | " + formatCalendarDateToLocal(e.startDate) + " | " + (e.text || "").slice(0, 200));
    });
    if (ranked.calendar.length === 0) lines.push("(No calendar events in range for this course.)");
    lines.push("");

    lines.push("--- ANNOUNCEMENTS (third: check for date/room changes) ---");
    if (ranked.mostRecentAnnouncement) {
      const a = ranked.mostRecentAnnouncement;
      lines.push("Most recent: " + a.title + " | " + (a.createdDate || "") + (a.url ? " | Link: " + a.url : ""));
      lines.push(a.text || "");
    }
    ranked.announcements.forEach((e) => {
      if (e === ranked.mostRecentAnnouncement) return;
      lines.push("- " + e.title + " | " + (e.createdDate || "") + (e.url ? " | " + e.url : ""));
      lines.push(e.text || "");
    });
    if (ranked.announcements.length === 0) lines.push("(No announcements for this course.)");
    lines.push("");
  } else {
    lines.push("--- CALENDAR (sessions/classes — use for when/dates only; never infer or approximate; times are in LOCAL time) ---");
    if (ranked.nextUpcoming) {
      lines.push("Next upcoming session: " + ranked.nextUpcoming.title + " | " + formatCalendarDateToLocal(ranked.nextUpcoming.startDate) + " | " + (ranked.nextUpcoming.text || ""));
    }
    ranked.calendar.forEach((e) => {
      lines.push("- " + e.title + " | " + formatCalendarDateToLocal(e.startDate) + " | " + (e.text || "").slice(0, 200));
    });
    if (ranked.calendar.length === 0) lines.push("(No calendar events in range for this course.)");
    lines.push("");

    lines.push("--- ANNOUNCEMENTS ---");
    if (ranked.mostRecentAnnouncement) {
      const a = ranked.mostRecentAnnouncement;
      lines.push("Most recent: " + a.title + " | " + (a.createdDate || "") + (a.url ? " | Link: " + a.url : ""));
      lines.push(a.text || "");
    }
    ranked.announcements.forEach((e) => {
      if (e === ranked.mostRecentAnnouncement) return;
      lines.push("- " + e.title + " | " + (e.createdDate || "") + (e.url ? " | " + e.url : ""));
      lines.push(e.text || "");
    });
    if (ranked.announcements.length === 0) lines.push("(No announcements for this course.)");
    lines.push("");

    lines.push("--- SYLLABUS EXTRACTION MAP (use to locate sections: Course Info, Faculty, Subject Description, Learning Objectives, Methodology, AI Policy, Program/Sessions, Evaluation, Re-sit, Bibliography, Policies) ---");
    lines.push(SYLLABUS_EXTRACTION_MAP);
    lines.push("");
    lines.push("--- SYLLABUS (content/structure — use for what sessions cover, topics, grading, readings, AI policy, bibliography) ---");
    ranked.syllabus.forEach((e) => {
      lines.push(e.title + ":");
      lines.push((e.text || "").slice(0, MAX_SYLLABUS_CHARS));
    });
    if (ranked.syllabus.length === 0) lines.push("(No syllabus content available.)");
    lines.push("");
  }

  if (notes.length > 0) {
    lines.push("--- NOTES ---");
    notes.forEach((n) => lines.push(n));
  }

  return lines.join("\n");
}

/**
 * System prompt for the combined course query LLM call.
 * @param {string} courseName
 * @returns {string}
 */
function getSystemPromptForCombinedCourseQuery(courseName) {
  return (
    "You are an assistant that answers course-related questions using ONLY the evidence provided below (Syllabus, Calendar, Announcements). " +
    "You must ALWAYS consult ALL relevant sources. Never require the user to say 'according to the syllabus' or 'from the calendar' — use the right source for each part of the question automatically.\n\n" +
    "For 'when is the midterm?' or 'when is the final (exam)?' of a course you MUST do these steps in order:\n" +
    "1) SYLLABUS: Find which SESSION number that exam is in. Look at Program/Sessions (session list with titles like 'Session 16: Midterm') and the Evaluation section. The syllabus tells you the session number, not the calendar date.\n" +
    "2) CALENDAR: Find the event for this course whose title contains that session number (e.g. 'Session 16' or 'Session 20'). That event's date and time is when the exam takes place. Report that date and time. Never invent or approximate a date.\n" +
    "3) ANNOUNCEMENTS: Check for any announcement that changes the date, room, or format; mention it if relevant.\n" +
    "Your answer must state: which session the exam is (from syllabus), the calendar date and time for that session, and any announcement update if present.\n\n" +
    "Other rules:\n" +
    "- When the user asks what a session is ABOUT, what it COVERS, what TOPICS it includes → use SYLLABUS for content. Use CALENDAR only for date/time.\n" +
    "- For 'when is session X?' (user already gave the number) → use CALENDAR. Give the exact date and time for that session.\n" +
    "- CRITICAL — Calendar dates: Only state a date/time when it appears explicitly in the CALENDAR for that specific event. If no calendar event matches the session number, say clearly: 'The calendar does not list a date for Session X.' Do not estimate or use another session's date.\n" +
    "- For latest announcement, what did professor say: use ANNOUNCEMENTS. Include title, date, and brief summary; include link if provided.\n" +
    "- For content, grading, readings, policies: use SYLLABUS.\n" +
    "- If an announcement overrides syllabus (date/room changed), prefer the announcement and say so briefly.\n" +
    "If insufficient evidence after checking all three sources, say what is missing. Always include course name when relevant: " +
    (courseName || "the course") +
    ". Keep responses concise. Use plain text only (no asterisks).\n\n" +
    "SYLLABUS MISMATCH RULE: If the SYLLABUS section starts with [SYLLABUS MISMATCH WARNING: ...], " +
    "that syllabus belongs to a DIFFERENT course. DO NOT use any information from it (professor name, sessions, grading, email, etc.). " +
    "Instead, answer ONLY from ANNOUNCEMENTS and CALENDAR. " +
    "If those also lack the answer, tell the user: 'I could not find that information in the available sources for [course name].'"
  );
}

/**
 * Run the combined course query: fetch all three sources, normalize, rank, build context and system prompt.
 * Does not call the LLM; returns systemContent and userContent for the caller to send to OpenRouter.
 * @param {string} userQuery
 * @param {{ courseId: string, name: string }} resolvedCourse
 * @param {Date} now
 * @param {{ fetchCalendar: (since: string, until: string) => Promise<{ ok: boolean, items?: unknown[], error?: string }>, fetchAnnouncements: (courseId: string) => Promise<{ list?: unknown[] } | null>, fetchSyllabusStructured: (courseId: string) => Promise<unknown>, announcementLinkBase?: string }} deps
 * @returns {Promise<{ ok: true, systemContent: string, userContent: string } | { ok: false, error: string }>}
 */
export async function runCombinedCourseQuery(userQuery, resolvedCourse, now, deps) {
  const courseId = resolvedCourse.courseId || "";
  const courseName = resolvedCourse.name || "";
  const course = { courseId, name: courseName };
  const announcementLinkBase = deps.announcementLinkBase || "https://blackboard.ie.edu/ultra/courses";

  const { since, until } = getCalendarRange120(now);

  const [calendarRes, announcementsData, syllabusStructured] = await Promise.all([
    deps.fetchCalendar(since, until),
    deps.fetchAnnouncements(courseId),
    deps.fetchSyllabusStructured(courseId).catch(() => null)
  ]);

  if (typeof console !== "undefined" && console.log) {
    console.log("[CourseQueryOrchestrator] Combined query: calendar range " + since + " to " + until + "; calendar items=" + (calendarRes?.items?.length ?? 0) + ", announcements=" + (announcementsData?.list?.length ?? 0) + ", syllabus=" + (syllabusStructured ? "loaded" : "failed"));
  }

  const notes = [];
  if (calendarRes && !calendarRes.ok) notes.push("Calendar: " + (calendarRes.error || "could not load."));
  if (!announcementsData || !Array.isArray(announcementsData.list)) notes.push("Announcements: could not load or empty.");
  if (!syllabusStructured) notes.push("Syllabus: could not load.");

  const calendarItems = calendarRes?.ok && Array.isArray(calendarRes.items) ? calendarRes.items : [];
  const announcementList = announcementsData?.list || [];
  const announcementItems = Array.isArray(announcementList) ? announcementList : [];

  const calendarEvidence = normalizeCalendarToEvidence(calendarItems, course);
  const announcementsEvidence = normalizeAnnouncementsToEvidence(announcementItems, course, announcementLinkBase);
  const syllabusEvidence =
    syllabusStructured && typeof syllabusStructured === "object"
      ? normalizeSyllabusToEvidence(syllabusStructured, course, userQuery)
      : [];

  const ranked = rankEvidence(userQuery, {
    calendar: calendarEvidence,
    announcements: announcementsEvidence,
    syllabus: syllabusEvidence
  });

  const contextBlock = buildCombinedContext(course, userQuery, ranked, notes);
  const systemPrompt = getSystemPromptForCombinedCourseQuery(courseName);
  const systemContent = systemPrompt + "\n\n--- EVIDENCE ---\n" + contextBlock;

  return {
    ok: true,
    systemContent,
    userContent: userQuery
  };
}

export {
  getCalendarRange120,
  normalizeCalendarToEvidence,
  normalizeAnnouncementsToEvidence,
  normalizeSyllabusToEvidence,
  rankEvidence,
  buildCombinedContext,
  getSystemPromptForCombinedCourseQuery
};
