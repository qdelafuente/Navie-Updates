/**
 * Assignment Grade Lookup service for Blackboard Ultra (IE University).
 * Uses existing gradebook data (REST API) and fuzzy matching. No PII stored or logged.
 */

import { findBestMatch, similarityScore } from "./textMatch.js";

const ASSIGNMENT_GRADE_MATCH_THRESHOLD = 0.45;
const AMBIGUOUS_DELTA = 0.03;
const MAX_CLARIFY_ITEMS = 4;
const COURSE_NAME_MATCH_THRESHOLD = 0.4;

/**
 * Normalize typos and filler so natural phrasing still matches ALL_GRADES patterns.
 * @param {string} userText
 * @returns {string}
 */
export function normalizeUserTextForGradeLookup(userText) {
  if (typeof userText !== "string") return "";
  let s = userText.trim();
  if (!s) return "";
  s = s.replace(/^(?:hey|hi|hello|ok)\s+[,.]?\s*/i, "");
  s = s.replace(/\bgimme\b/gi, "give me");
  s = s.replace(/\basignment(s)?\b/gi, "assignment ");
  s = s.replace(/\bassignement(s)?\b/gi, "assignment ");
  s = s.replace(/\bforr\b/gi, "for ");
  s = s.replace(/\bmicrocecon\b/gi, "microeconomics");
  s = s.replace(/\bmicroecon\b/gi, "microeconomics");
  s = s.replace(/\btday\b/gi, "today");
  s = s.replace(/\bassigns\b/gi, "assignments");
  // Synonyms: gradebook, notas, tareas, entregas, actividades → assignments/grades
  s = s.replace(/\bgradebook\b/gi, "assignments");
  s = s.replace(/\bnotas\b/gi, "grades");
  s = s.replace(/\btareas\b/gi, "assignments");
  s = s.replace(/\bactividades\b/gi, "assignments");
  s = s.replace(/\bentregas\b/gi, "assignments");
  s = s.replace(/\bdeliverables\b/gi, "assignments");
  s = s.replace(/\bpendientes\b/gi, "assignments");
  // "what are my assignments like only for X" → "what are my assignments for X"
  s = s.replace(/\bassignments?\s+like\s+only\s+for\b/gi, "assignments for");
  s = s.replace(/\bassignments?\s+only\s+for\b/gi, "assignments for");
  // "give me all for X" → explicit assignments wording
  s = s.replace(/\b(?:give|show|get)\s+me\s+all\s+for\s+/gi, "give me all assignments for ");
  s = s.replace(/\b(?:give|show|get)\s+me\s+all\s+in\s+/gi, "give me all assignments in ");
  s = s.replace(/\b(?:give|show|get)\s+me\s+all\s+of\s+/gi, "give me all assignments of ");
  s = s.replace(/\bgive\s+me\s+the\s+ones\s+(?:in|for)\s+/gi, "give me all assignments for ");
  // Spanish patterns → English equivalents
  s = s.replace(/\bqu[eé]\s+(?:asignaciones|tareas|actividades|entregas)\s+tengo\s+(?:en|para|de)\s+/gi, "what assignments do I have for ");
  s = s.replace(/\bmu[eé]strame\s+(?:mis\s+)?(?:asignaciones|tareas|actividades|notas)\s+(?:de|en|para)\s+/gi, "show me my assignments for ");
  s = s.replace(/\b(?:dame|d[aá]me)\s+(?:mis\s+)?(?:notas|tareas|asignaciones)\s+(?:de|en|para)\s+/gi, "give me my assignments for ");
  return s.replace(/\s+/g, " ").trim();
}

/** Patterns to detect "all grades/assignments of [course]" and capture course mention. Order matters: more specific first. */
const ALL_GRADES_FOR_COURSE_PATTERNS = [
  // "gimme / give me the assigns|assignments in|for [course]" (after normalize: give me the assignments …)
  /\b(?:give|show|get)\s+me\s+the\s+assignments?\s+(?:in|for|of)\s+(.+)/i,
  /\b(?:give|show|get)\s+me\s+(?:the\s+)?assignments?\s+(?:in|for|of)\s+(.+)/i,
  // "any assignments in/for/of [course]?" (natural / informal — list all for course, not one item by name)
  /\b(?:are\s+there\s+)?any\s+assignments?\s+(?:in|for|of)\s+(.+)/i,
  /\b(?:got|have)\s+any\s+assignments?\s+(?:in|for|of)\s+(.+)/i,
  /\bdo\s+i\s+have\s+any\s+assignments?\s+(?:in|for|of)\s+(.+)/i,
  // "give me the ones in/for [course]" (conversational referent to assignments)
  /\b(?:give|show|get)\s+me\s+(?:the\s+)?(?:ones|those)\s+(?:in|for)\s+(.+)/i,
  // "what are my assignments like only for [course]"
  /what\s+are\s+my\s+assignments?\s+(?:like\s+)?(?:only\s+)?(?:for|in|of)\s+(.+)/i,
  // "what are all my assignments of [course]" / "what are my assignments of [course]" / "what are mi assignments for [course]"
  /what\s+are\s+(?:all\s+)?(?:my\s+|mi\s+)?(?:the\s+)?as?signments?\s+(?:of|for|in)\s+(.+)/i,
  // "what assignments do I have for/in/of [course]" / "what assignments I have for [course]"
  /wha?t\s+as?signmen\w*\s+(?:do\s+i\s+)?have\s+(?:of|for|in)\s+(.+)/i,
  // "what assignments are there in [course]"
  /what\s+as?signments?\s+are\s+there\s+(?:in|for|of)\s+(.+)/i,
  // "show me my assignments for [course]"
  /show\s+me\s+my\s+as?signments?\s+for\s+(.+)/i,
  // "what tasks do I have in [course]"
  /what\s+tasks?\s+do\s+i\s+have\s+(?:in|for|of)\s+(.+)/i,
  // "what homework do I have in [course]"
  /what\s+homework\s+do\s+i\s+have\s+(?:in|for|of)\s+(.+)/i,
  // "what work is assigned in [course]"
  /what\s+work\s+is\s+assigned\s+(?:in|for|of)\s+(.+)/i,
  // "what coursework do I have for [course]"
  /what\s+coursework\s+do\s+i\s+have\s+(?:for|in|of)\s+(.+)/i,
  // "what deliverables do I have in [course]"
  /what\s+deliverables?\s+do\s+i\s+have\s+(?:in|for|of)\s+(.+)/i,
  // "what are the grades of my assignments of [course]" / "what are the grades of my assignments in [course]"
  /what\s+are\s+(?:the\s+)?grades?\s+(?:of|for)\s+(?:my\s+)?as?signments?\s+(?:of|for|in)\s+(.+)/i,
  // "what's my grade on the assignments of [course]" / "what's my grade on assignments of [course]"
  /(?:what'?s?|what\s+is)\s+my\s+grade\s+on\s+(?:the\s+)?as?signments?\s+of\s+(.+)/i,
  // "what are my grades on the assignments of [course]"
  /what\s+are\s+my\s+grades?\s+on\s+(?:the\s+)?as?signments?\s+of\s+(.+)/i,
  // "what's my grade on all the assignments of [course]"
  /(?:what'?s?|what\s+is)\s+my\s+grade\s+on\s+all\s+(?:the\s+)?(?:as?signments?|grades?)\s+(?:of|for|in)\s+(.+)/i,
  // "show/get/give me (my) (all) (the) grades/assignments of [course]"
  /(?:what\s+are|show|get|give)\s+(?:me\s+)?(?:(?:all\s+)?(?:my\s+)?|(?:my\s+)?(?:all\s+(?:the\s+)?)?)(?:the\s+)?(?:as?signments?|grades?)\s+(?:of|for|in)\s+(.+)/i,
  // After normalize: "give me all assignments for [course]"
  /(?:give|show|get)\s+me\s+all\s+assignments?\s+(?:for|in|of)\s+(.+)/i,
  /all\s+(?:the\s+)?(?:as?signments?|grades?)\s+(?:of|for|in)\s+(.+)/i,
  /(?:my\s+)?grades?\s+(?:in|for|of)\s+(?:the\s+)?(.+)/i,
  /grades?\s+(?:of|for)\s+(?:the\s+)?(.+)/i
];

/** Leading patterns to strip from user text to get the assignment mention. */
const STRIP_PATTERNS = [
  /^(?:what'?s?|what\s+is)\s+my\s+grade\s+on\s+(?:the\s+)?/i,
  /^(?:what'?s?|what\s+is)\s+my\s+grade\s+for\s+(?:the\s+)?/i,
  /^grade\s+(?:on|for)\s+(?:the\s+)?/i,
  /^my\s+grade\s+(?:on|for)\s+(?:the\s+)?/i,
  /^(?:show|get|give)\s+(?:me\s+)?(?:my\s+)?grade\s+(?:on|for)\s+(?:the\s+)?/i,
  /^how\s+did\s+I\s+do\s+on\s+(?:the\s+)?/i,
  /^score\s+(?:on|for)\s+(?:the\s+)?/i,
  /^what\s+did\s+I\s+get\s+(?:on|for)\s+(?:the\s+)?/i
];

/**
 * Parse the user question to extract the assignment mention (free text).
 * @param {string} userText
 * @returns {{ assignmentQuery: string, empty: boolean }}
 */
export function parseAssignmentQuery(userText) {
  if (typeof userText !== "string") return { assignmentQuery: "", empty: true };
  let s = userText.trim();
  if (!s) return { assignmentQuery: "", empty: true };
  for (const re of STRIP_PATTERNS) {
    s = s.replace(re, "");
  }
  s = s.replace(/\?+$/, "").trim();
  return {
    assignmentQuery: s,
    empty: s.length === 0
  };
}

/**
 * Detect "all grades/assignments for [course]" and return the course mention.
 * @param {string} userText
 * @returns {{ isAll: true, courseMention: string } | { isAll: false }}
 */
export function isAllGradesForCourseQuery(userText) {
  if (typeof userText !== "string") return { isAll: false };
  const t = normalizeUserTextForGradeLookup(userText);
  if (!t) return { isAll: false };
  for (const re of ALL_GRADES_FOR_COURSE_PATTERNS) {
    const m = t.match(re);
    if (m && m[1]) {
      const courseMention = m[1].replace(/\?+$/, "").trim();
      if (courseMention.length > 0) return { isAll: true, courseMention };
    }
  }
  return { isAll: false };
}

/**
 * When the user clearly lists assignments/grades per course but no ALL_GRADES pattern matched,
 * extract the course tail so we can list grades for that course instead of fuzzy-matching the whole sentence.
 * Uses plural "assignments"/"grades" only (not singular "assignment") to avoid hijacking single-item lookups.
 * @param {string} userText
 * @returns {string | null}
 */
function tryInferCourseMentionForListFallback(userText) {
  const t = normalizeUserTextForGradeLookup(userText);
  if (!t) return null;
  const m = t.match(/\b(?:assignments|grades)\s+(?:in|for|of)\s+(.+)/i);
  if (!m || !m[1]) return null;
  const courseMention = m[1].replace(/\?+$/, "").trim();
  return courseMention.length >= 2 ? courseMention : null;
}

/**
 * Normalize course name for lookup: lowercase, collapse spaces, trim.
 * @param {string} s
 * @returns {string}
 */
function normalizeCourseName(s) {
  if (typeof s !== "string") return "";
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Score when mention words are prefixes of course name words (e.g. "cost acc" → "cost accounting").
 * @param {string} mentionNorm - normalized mention
 * @param {string} keyNorm - normalized course name
 * @returns {number} 0..1
 */
function prefixMatchScore(mentionNorm, keyNorm) {
  const ma = mentionNorm.split(/\s+/).filter(Boolean);
  const ka = keyNorm.split(/\s+/).filter(Boolean);
  if (ma.length === 0) return 0;
  let match = 0;
  for (const mw of ma) {
    if (ka.some((kw) => kw === mw || kw.startsWith(mw) || mw.startsWith(kw))) match += 1;
  }
  return match / ma.length;
}

/**
 * Resolve a course by user mention (e.g. "fundamentals of data analysis", "cost acc") using registry.
 * @param {string} mention
 * @param {Record<string, string>} courseIdByNormalizedName - normalized name -> courseId
 * @param {Record<string, { name?: string }>} coursesByCourseId - courseId -> { name }
 * @returns {{ courseId: string, courseName: string } | null}
 */
export function resolveCourseByMention(mention, courseIdByNormalizedName, coursesByCourseId) {
  if (!mention || !courseIdByNormalizedName || !coursesByCourseId || typeof courseIdByNormalizedName !== "object") return null;
  const norm = normalizeCourseName(mention);
  if (!norm) return null;
  const exactId = courseIdByNormalizedName[norm];
  if (exactId && coursesByCourseId[exactId]) {
    return { courseId: exactId, courseName: coursesByCourseId[exactId]?.name ?? norm };
  }
  const keys = Object.keys(courseIdByNormalizedName);
  let best = null;
  let bestScore = -1;
  for (const key of keys) {
    const meta = coursesByCourseId[courseIdByNormalizedName[key]];
    const courseName = (meta?.name ?? key).toLowerCase().replace(/\s+/g, " ");
    const keyNorm = key.toLowerCase().replace(/\s+/g, " ");
    const sim = similarityScore(mention, key);
    const prefix = prefixMatchScore(norm, keyNorm);
    const score = Math.max(sim, prefix >= 1 ? 0.95 : prefix * 0.9);
    if (score > bestScore && score >= COURSE_NAME_MATCH_THRESHOLD) {
      bestScore = score;
      best = { key, courseId: courseIdByNormalizedName[key] };
    }
  }
  if (!best || !coursesByCourseId[best.courseId]) return null;
  return { courseId: best.courseId, courseName: coursesByCourseId[best.courseId]?.name ?? best.key };
}

/**
 * Build a map columnId -> { submitted: boolean, reason: string, status?: string } from grades API results.
 * Submission rules:
 * - NO_GRADE_RECORD: column exists but no grade record for this user.
 * - ATTEMPT_PRESENT: grade record exists and has firstAttemptId or lastAttemptId.
 * - GRADE_WITHOUT_ATTEMPT: grade record exists but both attempt ids are null.
 * IMPORTANT: status === "GRADED" is NOT considered evidence of submission.
 *
 * This helper only looks at grades; the "no grade record" case is handled when iterating columns.
 * @param {unknown[]} gradeResults
 * @returns {Map<string, { submitted: boolean, reason: string, status?: string, firstAttemptId?: string | null, lastAttemptId?: string | null }>}
 */
function buildSubmissionStatusFromGrades(gradeResults) {
  const map = new Map();
  if (!Array.isArray(gradeResults)) return map;
  for (const entry of gradeResults) {
    if (!entry || typeof entry !== "object") continue;
    const g = entry.grade ?? entry;
    const colId = g?.columnId ?? entry.columnId;
    if (colId == null) continue;
    const key = String(colId);
    const firstAttemptId = g?.firstAttemptId ?? entry.firstAttemptId ?? null;
    const lastAttemptId = g?.lastAttemptId ?? entry.lastAttemptId ?? null;
    const status = g?.status ?? entry.status ?? null;
    let submitted;
    let reason;
    if (firstAttemptId != null || lastAttemptId != null) {
      submitted = true;
      reason = "ATTEMPT_PRESENT";
    } else {
      // Grade record exists but no attempts → explicitly treat as not submitted.
      submitted = false;
      reason = "GRADE_WITHOUT_ATTEMPT";
    }
    if (!map.has(key)) {
      map.set(key, { submitted, reason, status: status != null ? String(status) : undefined, firstAttemptId, lastAttemptId });
    }
  }
  return map;
}

/**
 * Format a list of grades for a course.
 * @param {string} courseName
 * @param {Array<{ title: string, gradeText: string | null, statusText: string | null, submitted?: boolean, reason?: string }>} items
 * @returns {string}
 */
export function formatAllGradesResponse(courseName, items) {
  if (!items || items.length === 0) {
    return "There are no gradebook items for " + (courseName || "that course") + " yet.";
  }

  /** Local helper: treat attendance-like items specially (no submission suffix). */
  const isAttendanceTitle = (title) => {
    if (!title || typeof title !== "string") return false;
    const t = title.trim().toLowerCase();
    return t === "attendance" || t === "qwattendance" || t.includes("attendance");
  };

  /** Local helper: pretty-print due dates for answers (fallback to raw string if parsing fails). */
  const formatDueDateForAnswer = (dueDate) => {
    if (!dueDate || typeof dueDate !== "string") return null;
    const s = dueDate.trim();
    if (!s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    try {
      // Format as: 24 Feb 2026, 23:59 (day numeric, short month, 24h minutes).
      const day = String(d.getDate()).padStart(2, "0");
      const month = d.toLocaleString(undefined, { month: "short" });
      const year = d.getFullYear();
      const hours = String(d.getHours()).padStart(2, "0");
      const minutes = String(d.getMinutes()).padStart(2, "0");
      return `${day} ${month} ${year}, ${hours}:${minutes}`;
    } catch (_) {
      return s;
    }
  };

  const lines = items.map((it) => {
    const title = it?.title ?? "Item";
    const gradeText = it?.gradeText ?? null;
    const statusText = it?.statusText ?? null;
    const dueDate = it?.dueDate ?? null;
    const hasSubmission = typeof it?.submitted === "boolean";
    let submissionSuffix = "";
    // Never append submission status for attendance-like items (QWAttendance / Attendance).
    if (hasSubmission && !isAttendanceTitle(title)) {
      const submitted = it.submitted;
      const suffixWord = submitted ? "submitted" : "not submitted";
      submissionSuffix = "(" + suffixWord + ")";
    }
    const empty = !gradeText || gradeText === "—" || gradeText === "-" || String(gradeText).toLowerCase() === "not graded";
    const baseValue = !empty ? gradeText : (statusText || "—");
    const prettyDue = formatDueDateForAnswer(dueDate);

    let line = "• " + title + ":";
    // Only show ": value" when we actually have a grade or status; keep it a bit more compact.
    if (baseValue && baseValue !== "—") {
      line += " " + baseValue;
    } else {
      line += " —";
    }

    if (prettyDue) {
      line += "  (due: " + prettyDue + ")";
    }
    if (submissionSuffix) {
      line += "  " + submissionSuffix;
    }

    return line;
  });
  return "Here are your grades for " + (courseName || "this course") + ":\n\n" + lines.join("\n\n");
}

/**
 * Build a flat list of gradebook items from gradebookByCourseId for matching.
 * @param {Record<string, { courseName: string, columns?: Array<{ id: string, name?: string, title?: string }>, assignments?: Array<{ title?: string, columnId?: string }> }>} gradebookByCourseId
 * @returns {Array<{ courseId: string, courseName: string, columnId: string, title: string }>}
 */
export function buildGradeItemList(gradebookByCourseId) {
  const list = [];
  if (!gradebookByCourseId || typeof gradebookByCourseId !== "object") return list;
  for (const [courseId, data] of Object.entries(gradebookByCourseId)) {
    const courseName = data?.courseName ?? courseId;
    const columns = data?.columns ?? [];
    for (const col of columns) {
      const colId = col?.id ?? col?.columnId;
      if (!colId) continue;
      const title = (col?.title ?? col?.name ?? "").trim() || colId;
      list.push({ courseId, courseName, columnId: colId, title });
    }
    const assignments = data?.assignments ?? [];
    for (const a of assignments) {
      const colId = a?.columnId ?? a?.id;
      if (!colId) continue;
      const title = (a?.title ?? a?.name ?? "").trim() || colId;
      if (!list.some((x) => x.courseId === courseId && x.columnId === colId)) {
        list.push({ courseId, courseName, columnId: colId, title });
      }
    }
  }
  return list;
}

/**
 * Resolve which course and column the assignment query refers to.
 * @param {string} assignmentQuery
 * @param {Record<string, { courseName: string, columns?: Array<{ id: string, name?: string, title?: string }>, assignments?: Array<{ title?: string, columnId?: string }> }>} gradebookByCourseId
 * @returns {{ courseId: string, courseName: string, columnId: string, title: string, score: number } | { ambiguous: string[] } | null}
 */
export function resolveCourseForAssignment(assignmentQuery, gradebookByCourseId) {
  const items = buildGradeItemList(gradebookByCourseId);
  if (items.length === 0) return null;

  let best = null;
  let bestScore = -1;
  const scored = [];

  for (let i = 0; i < items.length; i++) {
    const score = similarityScore(assignmentQuery, items[i].title);
    if (score >= ASSIGNMENT_GRADE_MATCH_THRESHOLD) {
      scored.push({ ...items[i], score });
      if (score > bestScore) {
        bestScore = score;
        best = { ...items[i], score };
      }
    }
  }

  if (!best) return null;

  const ambiguous = scored.filter((m) => Math.abs(m.score - bestScore) <= AMBIGUOUS_DELTA);
  if (ambiguous.length > 1) {
    const titles = [...new Set(ambiguous.slice(0, MAX_CLARIFY_ITEMS).map((m) => m.title))];
    return { ambiguous: titles };
  }

  return best;
}

/**
 * Extract grade text from a grade API result entry.
 * Priority:
 * 1) displayGrade.text (if non-empty)
 * 2) displayGrade.score (numeric)
 * 3) manualScore / manualGrade / averageScore (numeric-looking)
 * @param {unknown} entry - one element from gradebook/grades API results
 * @returns {{ gradeText: string | null, statusText: string | null }}
 */
export function extractGradeFromEntry(entry) {
  let gradeText = null;
  let statusText = null;
  if (!entry || typeof entry !== "object") return { gradeText, statusText };
  const grade = entry.grade ?? entry;
  const displayGrade = grade?.displayGrade;
  if (displayGrade && typeof displayGrade === "object") {
    if (displayGrade.text != null && String(displayGrade.text).trim() !== "") {
      gradeText = String(displayGrade.text).trim();
    } else if (displayGrade.score != null) {
      const n = Number(displayGrade.score);
      if (!Number.isNaN(n)) gradeText = String(n);
    }
  }
   // Fallbacks when displayGrade is missing or empty but there is a numeric score.
   if (gradeText == null || gradeText === "") {
     const numericCandidates = [
       grade?.manualScore,
       grade?.manualGrade,
       grade?.averageScore
     ];
     for (const val of numericCandidates) {
       if (val == null) continue;
       const s = String(val).trim();
       if (!s) continue;
       const n = Number(s);
       if (!Number.isNaN(n)) {
         gradeText = s;
         break;
       }
     }
   }
  const status = grade?.status ?? entry?.status;
  if (status != null) statusText = String(status).trim();
  return { gradeText, statusText };
}

/**
 * Get the user's grade for a specific column from grades API results.
 * @param {unknown[]} gradeResults - results from gradebook/grades API
 * @param {string} columnId
 * @returns {{ gradeText: string | null, statusText: string | null } | null}
 */
export function getGradeForColumn(gradeResults, columnId) {
  if (!Array.isArray(gradeResults)) return null;
  const colStr = String(columnId);
  for (const entry of gradeResults) {
    const g = entry?.grade ?? entry;
    const entryColId = g?.columnId ?? entry?.columnId;
    if (entryColId == null) continue;
    if (String(entryColId) === colStr) {
      return extractGradeFromEntry(entry);
    }
  }
  return null;
}

/**
 * Format the user-facing response string.
 * @param {{ title: string, gradeText: string | null, statusText: string | null }} match
 * @returns {string}
 */
export function formatGradeResponse(match) {
  const title = match?.title ?? "this item";
  const gradeText = match?.gradeText ?? null;
  const statusText = match?.statusText ?? null;

  const emptyGrade = !gradeText || gradeText === "—" || gradeText === "-" || gradeText.toLowerCase() === "not graded";
  if (!emptyGrade) {
    return "Your grade for '" + title + "' is " + gradeText + ".";
  }
  if (statusText) {
    return "Your item '" + title + "' is currently " + statusText + ".";
  }
  return "Your item '" + title + "' does not have a grade yet.";
}

/**
 * Main entry: get assignment grade from user text (single item or all grades for a course).
 * @param {string} userText
 * @param {{ gradebookByCourseId: Record<string, unknown>, userId: string | null, fetchGrades: (courseId: string, userId: string) => Promise<{ ok: boolean, results?: unknown[] }>, courseIdByNormalizedName?: Record<string, string>, coursesByCourseId?: Record<string, { name?: string }> }} context
 * @returns {Promise<string>}
 */
export async function getAssignmentGrade(userText, context) {
  const { gradebookByCourseId, userId, fetchGrades, courseIdByNormalizedName, coursesByCourseId } = context || {};
  if (!userId) {
    return "I couldn't load your grades. Open Blackboard in a tab and make sure you're logged in.";
  }
  if (!gradebookByCourseId || Object.keys(gradebookByCourseId).length === 0) {
    return "Sync your courses first (Sync syllabi or Sync gradebook) so I can look up grades.";
  }
  if (typeof fetchGrades !== "function") {
    return "Grade lookup is not available. Please try again.";
  }

  userText = normalizeUserTextForGradeLookup(userText);

  // "All grades/assignments of [course]" → resolve course by name and return full grade list
  const allQuery = isAllGradesForCourseQuery(userText);
  if (allQuery.isAll && courseIdByNormalizedName && coursesByCourseId) {
    const course = resolveCourseByMention(allQuery.courseMention, courseIdByNormalizedName, coursesByCourseId);
    if (!course) {
      return "I couldn't identify the course '" + allQuery.courseMention + "'. Try using the exact course name (e.g. from your course list).";
    }
    let gradesRes;
    try {
      gradesRes = await fetchGrades(course.courseId, userId);
    } catch (e) {
      return "I couldn't load your gradebook for " + (course.courseName || "that course") + ". Please try again.";
    }
    if (!gradesRes?.ok || !Array.isArray(gradesRes.results)) {
      return "I couldn't load your gradebook for " + (course.courseName || "that course") + ". Please try again.";
    }
    const courseData = gradebookByCourseId[course.courseId];
    const columns = courseData?.columns ?? [];
    const assignments = courseData?.assignments ?? [];
    const urlByColId = new Map();
    for (const a of assignments) {
      const cid = a?.columnId ?? a?.id;
      if (cid && a?.urlOpcional) urlByColId.set(String(cid), a.urlOpcional);
    }
    const submissionByColId =
      context.submissionMap != null && typeof context.submissionMap === "object"
        ? new Map(Object.entries(context.submissionMap))
        : buildSubmissionStatusFromGrades(gradesRes.results);
    const items = [];
    for (const col of columns) {
      const colId = col?.id ?? col?.columnId;
      if (!colId) continue;
      const title = (col?.title ?? col?.name ?? "").trim() || colId;
      const gradeInfo = getGradeForColumn(gradesRes.results, colId);
      const submission = submissionByColId.get(String(colId));
      let submitted = undefined;
      let reason = undefined;
      if (submission) {
        submitted = submission.submitted;
        reason = submission.reason;
      } else {
        submitted = false;
        reason = "NO_GRADE_RECORD";
      }
      items.push({
        title,
        gradeText: gradeInfo?.gradeText ?? null,
        statusText: gradeInfo?.statusText ?? null,
        dueDate: col?.dueDate ?? null,
        submitted,
        reason,
        url: urlByColId.get(String(colId)) ?? null
      });
    }
    const text = formatAllGradesResponse(course.courseName, items);
    const assignmentItems = items.filter((i) => i.url).map((i) => ({ title: i.title, url: i.url }));
    return { text, assignmentItems };
  }

  const { assignmentQuery, empty } = parseAssignmentQuery(userText);
  if (empty) {
    return "Which assignment do you mean? Try asking something like: What's my grade on the midterm? Or: What are my grades in [course name]?";
  }

  const resolved = resolveCourseForAssignment(assignmentQuery, gradebookByCourseId);
  if (!resolved) {
    const fallbackMention = tryInferCourseMentionForListFallback(userText);
    if (fallbackMention && courseIdByNormalizedName && coursesByCourseId) {
      const course = resolveCourseByMention(fallbackMention, courseIdByNormalizedName, coursesByCourseId);
      if (course) {
        return getAssignmentGrade("what are my assignments for " + fallbackMention, context);
      }
    }
    const items = buildGradeItemList(gradebookByCourseId);
    const withScores = items.map((it) => ({ ...it, score: similarityScore(assignmentQuery, it.title) }));
    const best = withScores.length > 0 ? withScores.reduce((acc, it) => (it.score > (acc?.score ?? -1) ? it : acc), null) : null;
    if (best && best.score >= 0.3) {
      const closest = withScores.sort((a, b) => b.score - a.score).slice(0, 5).map((i) => "'" + i.title + "'").join(", ");
      return "I couldn't clearly match that to one assignment. Here are the closest items I see: " + closest + ".";
    }
    return "I couldn't match that to a single gradebook column. If you meant every item in a course, use the course name as it appears in Blackboard; or name the exact column title.";
  }

  if (resolved.ambiguous && resolved.ambiguous.length > 0) {
    return "I found multiple similar assignments: " + resolved.ambiguous.join(", ") + ". Try asking again using one of those names.";
  }

  const { courseId, columnId, title, courseName } = resolved;
  let gradesRes;
  try {
    gradesRes = await fetchGrades(courseId, userId);
  } catch (e) {
    return "I couldn't load your gradebook for " + (courseName || "that course") + ". Please try again.";
  }
  if (!gradesRes?.ok || !Array.isArray(gradesRes.results)) {
    return "I couldn't load your gradebook for " + (courseName || "that course") + ". Please try again.";
  }

  const gradeInfo = getGradeForColumn(gradesRes.results, columnId);
  return formatGradeResponse({
    title,
    gradeText: gradeInfo?.gradeText ?? null,
    statusText: gradeInfo?.statusText ?? null
  });
}
