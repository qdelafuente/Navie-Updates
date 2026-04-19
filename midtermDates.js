/**
 * midtermDates — Detects midterm/intermediate exam date queries and gathers
 * evidence (syllabus → calendar → announcements) for every course in the
 * student's current semester, then asks the LLM to produce a consolidated answer.
 *
 * Flow (strict, per user requirement):
 * 1. Extract midterm SESSION NUMBER from syllabus (Program/Sessions + Evaluation).
 * 2. Search CALENDAR ±200 days for that session number in the course's events.
 * 3. Announcements for any date/room changes.
 *
 * Does NOT touch the calendar, assignments, or announcements systems directly;
 * it receives dependency functions from the caller (background.js).
 */

const MIDTERM_CALENDAR_DAYS = 200;

// ── Query detection ────────────────────────────────────────────────────────

const ALL_MIDTERMS_RE = [
  /\b(?:all|every|each|todos?\s+(?:l[oa]s)?)\s+(?:my\s+)?(?:midterms?|mid-terms?|intermediate\s+exams?|parcial(?:es)?|examen(?:es)?\s+intermedi[oa]s?)\b/i,
  /\b(?:when\s+are|when's|whens|dates?\s+(?:of|for))\s+(?:all\s+)?(?:my\s+)?(?:midterms?|mid-terms?|intermediate\s+exams?|parcial(?:es)?)\b/i,
  /\b(?:midterms?|mid-terms?|intermediate\s+exams?|parcial(?:es)?)\s+(?:dates?|schedule|calendario)\b/i,
  /\b(?:when\s+(?:is|are)\s+(?:the\s+)?midterms?|when\s+(?:is|are)\s+(?:the\s+)?intermediate)\b/i,
  /\b(?:give\s+me|show\s+me|tell\s+me|list)\s+(?:all\s+)?(?:the\s+)?(?:midterm|mid-term|intermediate\s+exam)\s+dates?\b/i,
  /cu[aá]ndo\s+(?:son|es)\s+(?:(?:el|los|mis?)\s+)?(?:parcial(?:es)?|midterms?|examen(?:es)?\s+intermedi[oa]s?)/i,
];

const SINGLE_MIDTERM_RE = [
  /\b(?:when\s+is|when's|whens|date\s+of|fecha\s+de|cu[aá]ndo\s+es)\b.*\b(?:midterm|mid-term|intermediate\s+exam|parcial|examen\s+intermedi[oa])\b/i,
  /\b(?:midterm|mid-term|intermediate\s+exam|parcial|examen\s+intermedi[oa])\b.*\b(?:when|date|fecha|cu[aá]ndo)\b/i,
];

/** Course-specific tail: "of X", "for X", "in X", "de X". Indicates a single course. */
const COURSE_TAIL_RE = /\b(?:of|for|in|de|del)\s+\w/i;

/** Keywords that identify a session as midterm/intermediate exam. */
const MIDTERM_SESSION_RE = /\b(midterm|mid-term|intermediate\s+exam|parcial|examen\s+intermedi[oa])\b/i;

/** Evaluation item names that indicate midterm. */
const MIDTERM_EVAL_RE = /\b(midterm|mid-term|intermediate|parcial|examen\s+intermedi[oa])\b/i;

/** Calendar title patterns to extract session number: "Session 15", "Sesión 15", "Ses. 15", "Session #15", "Clase 15", etc. */
const SESSION_IN_TITLE_RE = /\b(?:session|sesi[oó]n|ses\.?|clase)\s*#?\s*(\d+)\b/i;

/**
 * Returns { isAll: true } if asking for ALL midterms across courses.
 * Returns { isAll: false, isSingle: true } if asking for a specific course's midterm.
 * Returns null if not a midterm query at all.
 */
export function detectMidtermQuery(text) {
  if (!text || typeof text !== "string") return null;
  const t = text.trim();

  // If the query mentions a specific course (e.g. "midterm of statistics"), treat as single.
  for (const re of SINGLE_MIDTERM_RE) {
    if (re.test(t) && COURSE_TAIL_RE.test(t)) return { isAll: false, isSingle: true };
  }

  for (const re of ALL_MIDTERMS_RE) {
    if (re.test(t)) return { isAll: true, isSingle: false };
  }

  for (const re of SINGLE_MIDTERM_RE) {
    if (re.test(t)) return { isAll: false, isSingle: true };
  }

  return null;
}

// ── Calendar range helper ──────────────────────────────────────────────────

function calendarRange(now) {
  const pad = (n) => String(n).padStart(2, "0");
  const from = new Date(now);
  from.setDate(from.getDate() - MIDTERM_CALENDAR_DAYS);
  const to = new Date(now);
  to.setDate(to.getDate() + MIDTERM_CALENDAR_DAYS);
  return {
    since: `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}T00:00Z`,
    until: `${to.getFullYear()}-${pad(to.getMonth() + 1)}-${pad(to.getDate())}T22:59Z`
  };
}

function formatDateLocal(isoStr) {
  if (!isoStr || typeof isoStr !== "string") return "";
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    return d.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" });
  } catch {
    return isoStr;
  }
}

function extractCourseName(raw) {
  const loc = raw?.calendarNameLocalizable ?? raw?.calendarName ?? {};
  const rawVal = typeof loc === "string" ? loc : (loc?.rawValue ?? loc?.value ?? "");
  const str = (typeof rawVal === "string" ? rawVal : "").trim();
  return str.indexOf(": ") !== -1 ? str.slice(str.indexOf(": ") + 2).trim() : str;
}

/** Check if a calendar item belongs to this course (by courseId or calendar name). */
function itemBelongsToCourse(item, courseId, courseNameLower) {
  const itemCourseId = (item?.courseId ?? item?.calendarId ?? item?.contextId ?? "").toString().trim();
  if (itemCourseId && courseId && itemCourseId === courseId) return true;
  const itemName = extractCourseName(item).toLowerCase();
  if (!itemName && !courseNameLower) return false;
  return itemName.includes(courseNameLower) || courseNameLower.includes(itemName);
}

/** Extract session number from calendar item title (Session 15, Sesión 15, Ses. 15, etc.). */
function extractSessionNumberFromTitle(title) {
  if (!title || typeof title !== "string") return null;
  const m = title.match(SESSION_IN_TITLE_RE);
  return m ? parseInt(m[1], 10) : null;
}

/** Check if title explicitly contains this session number (exact match to avoid "1" matching "15"). */
function titleMatchesSession(title, sessionNum) {
  if (!title || sessionNum == null) return false;
  const t = title.toString();
  const numStr = String(sessionNum);
  const re = new RegExp("\\b(?:session|sesi[oó]n|ses\\.?|clase)\\s*#?\\s*" + numStr + "\\b", "i");
  if (re.test(t)) return true;
  const reStandalone = new RegExp("\\b" + numStr + "\\b");
  const match = t.match(SESSION_IN_TITLE_RE);
  return match && match[1] === numStr;
}

/**
 * Extract midterm session numbers from syllabus.
 * Returns number[] (session numbers that are midterm/intermediate exam).
 */
function extractMidtermSessionNumbers(structured) {
  const nums = new Set();
  const sessions = Array.isArray(structured?.sessions) ? structured.sessions : [];
  const evaluation = Array.isArray(structured?.evaluation) ? structured.evaluation : [];

  // 1) Sessions whose title/content mentions midterm, intermediate, parcial
  for (const s of sessions) {
    const num = s.sessionNumber ?? s.number;
    if (num == null) continue;
    const title = (s.title || s.name || s.topic || "").toString();
    const desc = (s.description || s.content || s.rawText || "").toString();
    const text = (title + " " + desc).toLowerCase();
    if (MIDTERM_SESSION_RE.test(text)) nums.add(Number(num));
  }

  // 2) Evaluation items like "Midterm" — try to link to session via "Session 15" in raw text
  if (nums.size === 0 && evaluation.length > 0) {
    const evalText = evaluation
      .map((e) => (e.name || "") + " " + (e.rawText || "") + " " + (e.description || ""))
      .join(" ");
    const sessionRef = evalText.match(/\b(?:session|sesi[oó]n|ses\.?)\s*#?\s*(\d+)\b/i);
    if (sessionRef) nums.add(parseInt(sessionRef[1], 10));
  }

  // 3) Evaluation names that mention midterm — if we have sessions, use first session with "midterm" in title; else use session that matches eval position
  if (nums.size === 0) {
    for (const e of evaluation) {
      const name = (e.name || e.title || "").toString();
      if (!MIDTERM_EVAL_RE.test(name)) continue;
      for (const s of sessions) {
        const num = s.sessionNumber ?? s.number;
        const title = (s.title || s.name || s.topic || "").toString();
        if (num != null && MIDTERM_SESSION_RE.test((title + " " + name).toLowerCase())) {
          nums.add(Number(num));
          break;
        }
      }
    }
  }

  return Array.from(nums).sort((a, b) => a - b);
}

// ── Per-course evidence gathering ──────────────────────────────────────────

/**
 * For ONE course, gather syllabus + calendar + announcements evidence about the midterm.
 * Flow: 1) syllabus → session number, 2) calendar ±200d → find that session, 3) announcements.
 *
 * @param {{ courseId: string, courseName: string }} course
 * @param {Date} now
 * @param {{
 *   fetchSyllabusStructured: (courseId: string) => Promise<any>,
 *   fetchCalendar: (since: string, until: string) => Promise<{ ok: boolean, items?: any[] }>,
 *   fetchAnnouncements: (courseId: string) => Promise<{ list?: any[] } | null>
 * }} deps
 * @returns {Promise<{ courseId: string, courseName: string, syllabusBlock: string, calendarBlock: string, announcementsBlock: string, midtermSessionNums: number[], matchedCalendarDate: string|null, matchedCalendarTitle: string|null }>}
 */
async function gatherEvidenceForCourse(course, now, deps) {
  const courseId = course.courseId;
  const courseName = course.courseName || courseId;
  const courseNameLower = courseName.toLowerCase();

  let syllabusBlock = "";
  let midtermSessionNums = [];
  let structured = null;

  try {
    structured = await deps.fetchSyllabusStructured(courseId);
    if (structured) {
      midtermSessionNums = extractMidtermSessionNumbers(structured);
      const rawText = structured.rawText || "";
      const sessions = Array.isArray(structured.sessions) ? structured.sessions : [];
      const evaluation = Array.isArray(structured.evaluation) ? structured.evaluation : [];

      const sessionLines = sessions.map((s, i) => {
        const num = s.sessionNumber ?? s.number ?? (i + 1);
        const title = s.title || s.name || s.topic || "";
        const desc = s.description || "";
        return "Session " + num + ": " + title + (desc ? " — " + desc : "");
      });
      const evalLines = evaluation.map((e) => {
        const name = e.name || e.title || "";
        const pct = e.percentage || e.weight || "";
        const desc = e.description || "";
        return name + (pct ? " (" + pct + ")" : "") + (desc ? " — " + desc : "");
      });

      syllabusBlock =
        "--- SYLLABUS for " + courseName + " ---\n" +
        (sessionLines.length ? "Sessions:\n" + sessionLines.join("\n") : "(No sessions extracted)") +
        "\n\n" +
        (evalLines.length ? "Evaluation:\n" + evalLines.join("\n") : "(No evaluation extracted)") +
        (midtermSessionNums.length > 0 ? "\n\n[IDENTIFIED MIDTERM SESSION(S): " + midtermSessionNums.join(", ") + "]" : "") +
        (rawText.length > 0 ? "\n\nFull text (first 12 000 chars):\n" + rawText.slice(0, 12000) : "");
    }
  } catch {
    syllabusBlock = "--- SYLLABUS for " + courseName + ": not available ---";
  }

  let calendarBlock = "";
  let matchedCalendarDate = null;
  let matchedCalendarTitle = null;

  try {
    const { since, until } = calendarRange(now);
    const calRes = await deps.fetchCalendar(since, until);
    const allItems = calRes?.ok && Array.isArray(calRes.items) ? calRes.items : [];
    const courseItems = allItems.filter((item) => itemBelongsToCourse(item, courseId, courseNameLower));

    if (courseItems.length > 0) {
      const lines = courseItems.map((item) => {
        const title = (item.title ?? item.name ?? item.itemName ?? "").toString().trim();
        const start = item.startDate ?? item.startDateTime ?? item.startTime ?? "";
        return title + " | " + formatDateLocal(start);
      });
      calendarBlock = "--- CALENDAR for " + courseName + " (±200 days, " + courseItems.length + " events) ---\n" + lines.join("\n");

      // Step 2: Find session number in calendar — search for each midterm session
      for (const sessionNum of midtermSessionNums) {
        const match = courseItems.find((item) => {
          const title = (item.title ?? item.name ?? item.itemName ?? "").toString().trim();
          return titleMatchesSession(title, sessionNum);
        });
        if (match) {
          const start = match.startDate ?? match.startDateTime ?? match.startTime ?? "";
          matchedCalendarDate = formatDateLocal(start);
          matchedCalendarTitle = (match.title ?? match.name ?? match.itemName ?? "").toString().trim();
          break;
        }
      }

      // STRICT: Do NOT use calendar-only fallback (midterm keywords in title) for assigning dates.
      // We only assign when: syllabus accessible + session says midterm + calendar matches that session.
    } else {
      calendarBlock = "--- CALENDAR for " + courseName + ": no events in ±200 days (searched " + since + " to " + until + ") ---";
    }
  } catch {
    calendarBlock = "--- CALENDAR for " + courseName + ": could not load ---";
  }

  let announcementsBlock = "";
  try {
    const annData = await deps.fetchAnnouncements(courseId);
    const list = annData?.list || [];
    if (list.length > 0) {
      const midtermKeywords = /midterm|mid-term|intermediate|parcial|examen\s+intermedi/i;
      const relevant = list.filter((a) => {
        const text = ((a.title || "") + " " + (a.bodyText || "")).toLowerCase();
        return midtermKeywords.test(text);
      });
      const toShow = relevant.length > 0 ? relevant.slice(0, 5) : list.slice(0, 3);
      const lines = toShow.map((a) => {
        const date = a.dateISO || a.createdDate || a.modifiedDate || "";
        const title = a.title || "(No title)";
        const body = (a.bodyText || "").slice(0, 800);
        return "Announcement: " + title + " | " + date + "\n" + body;
      });
      announcementsBlock = "--- ANNOUNCEMENTS for " + courseName + " ---\n" + lines.join("\n---\n");
    } else {
      announcementsBlock = "--- ANNOUNCEMENTS for " + courseName + ": none ---";
    }
  } catch {
    announcementsBlock = "--- ANNOUNCEMENTS for " + courseName + ": could not load ---";
  }

  // Strict status: never invent dates. Only "ok" when syllabus + session + calendar all align.
  let status = "ok";
  if (!structured) status = "no_syllabus";
  else if (midtermSessionNums.length === 0) status = "no_midterm_session";
  else if (!matchedCalendarDate) status = "no_calendar_match";

  return {
    courseId,
    courseName,
    syllabusBlock,
    calendarBlock,
    announcementsBlock,
    midtermSessionNums,
    matchedCalendarDate: status === "ok" ? matchedCalendarDate : null,
    matchedCalendarTitle: status === "ok" ? matchedCalendarTitle : null,
    status
  };
}

// ── Structured export for caching (no LLM) ───────────────────────────────────

/**
 * Gather midterm evidence and return structured items for caching.
 * STRICT: Only assigns date when syllabus + midterm session + calendar match.
 * Never invents dates.
 *
 * @param {{ courseId: string, courseName: string }[]} courses
 * @param {Date} now
 * @param {object} deps
 * @returns {Promise<{ ok: boolean, items: Array<{ courseId: string, courseName: string, sessionNum: number|null, date: string|null, status: string }>, semester: string, error?: string }>}
 */
export async function gatherMidtermEvidenceStructured(courses, now, deps) {
  if (!courses || courses.length === 0) {
    return { ok: false, items: [], semester: "", error: "No courses." };
  }
  const evidence = await Promise.all(
    courses.map((c) =>
      gatherEvidenceForCourse(c, now, deps).catch(() => ({
        courseId: c.courseId,
        courseName: c.courseName,
        status: "error",
        matchedCalendarDate: null,
        midtermSessionNums: []
      }))
    )
  );
  const items = evidence.map((e) => ({
    courseId: e.courseId,
    courseName: e.courseName,
    sessionNum: e.midtermSessionNums?.[0] ?? null,
    date: e.matchedCalendarDate,
    status: e.status || "error"
  }));
  return { ok: true, items, semester: "" };
}

// ── Build prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(courses, userQuery) {
  const lines = [
    "You are an assistant that finds midterm / intermediate exam dates for a student.",
    "The system has already performed: (1) syllabus → session number, (2) calendar search ±200 days for that session.",
    "",
    "RULES:",
    "1) For each course below, use the [RESOLVED] line when present: it gives the exact date from the calendar.",
    "2) Do NOT say 'session not found in calendar' — the system has searched. If [RESOLVED] is missing, use the SYLLABUS + CALENDAR blocks to infer, or say 'No midterm date could be determined' only if there is no usable evidence.",
    "3) Check ANNOUNCEMENTS for any date/room changes and mention them.",
    "4) Present results as a clear list: Course Name — Session N — Date and time (or 'No date found' only when truly no evidence).",
    "5) Use plain text only (no asterisks). Respond in the same language as the user.",
    ""
  ];

  for (const c of courses) {
    lines.push("========== " + c.courseName + " ==========");
    if (c.matchedCalendarDate) {
      lines.push("[RESOLVED: Session " + (c.midtermSessionNums?.[0] ?? "?") + " → " + c.matchedCalendarDate + (c.matchedCalendarTitle ? " (" + c.matchedCalendarTitle + ")" : "") + "]");
    }
    lines.push(c.syllabusBlock);
    lines.push("");
    lines.push(c.calendarBlock);
    lines.push("");
    lines.push(c.announcementsBlock);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Main public API ────────────────────────────────────────────────────────

/**
 * Gather midterm evidence for a list of courses and build a prompt for the LLM.
 * Flow: syllabus → session number → calendar ±200 days → match session in calendar.
 *
 * @param {string} userQuery
 * @param {{ courseId: string, courseName: string }[]} courses
 * @param {Date} now
 * @param {{
 *   fetchSyllabusStructured: (courseId: string) => Promise<any>,
 *   fetchCalendar: (since: string, until: string) => Promise<{ ok: boolean, items?: any[] }>,
 *   fetchAnnouncements: (courseId: string) => Promise<{ list?: any[] } | null>
 * }} deps
 * @returns {Promise<{ ok: true, systemContent: string, userContent: string } | { ok: false, error: string }>}
 */
export async function gatherMidtermEvidence(userQuery, courses, now, deps) {
  if (!courses || courses.length === 0) {
    return { ok: false, error: "No courses provided for midterm lookup." };
  }

  const evidencePromises = courses.map((c) =>
    gatherEvidenceForCourse(c, now, deps).catch((e) => ({
      courseId: c.courseId,
      courseName: c.courseName,
      syllabusBlock: "--- SYLLABUS: error ---",
      calendarBlock: "--- CALENDAR: error ---",
      announcementsBlock: "--- ANNOUNCEMENTS: error ---",
      midtermSessionNums: [],
      matchedCalendarDate: null,
      matchedCalendarTitle: null
    }))
  );

  const evidence = await Promise.all(evidencePromises);
  const systemContent = buildSystemPrompt(evidence, userQuery);

  return { ok: true, systemContent, userContent: userQuery };
}
