/**
 * Attendance % per course (gradebook-based).
 * Uses existing course resolution and userId bootstrap; does not change them.
 * Cache: attendance column IDs per course (TTL 24h).
 */

const STORAGE_KEY_PREFIX = "attendance_columns_by_course";
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ATTENDANCE_NAME = "Attendance";
const QW_ATTENDANCE_NAME = "QWAttendance";

const DEBUG_ATTENDANCE = false;
function debugLog(...args) {
  if (DEBUG_ATTENDANCE) console.log("[attendance]", ...args);
}

function getCacheKey(courseId) {
  return STORAGE_KEY_PREFIX + "_" + (courseId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getColumnDisplayName(col) {
  if (!col || typeof col !== "object") return "";
  const name =
    col.effectiveColumnName ??
    col.columnName ??
    (col.name != null ? col.name : "");
  if (typeof name === "string" && name.trim()) return name.trim();
  const loc = col.localizedColumnName;
  if (loc && typeof loc === "object" && (loc.rawValue ?? loc.value)) {
    return String(loc.rawValue ?? loc.value).trim();
  }
  if (loc && typeof loc === "object" && loc.languageKey) {
    return String(loc.languageKey).trim();
  }
  return "";
}

/**
 * From raw API .results, find column IDs for Attendance and QWAttendance (case-insensitive).
 * @returns {{ attendanceColumnId: string | null, qwAttendanceColumnId: string | null }}
 */
export function findAttendanceColumnIds(columnsResults) {
  let attendanceColumnId = null;
  let qwAttendanceColumnId = null;
  const list = Array.isArray(columnsResults) ? columnsResults : [];
  for (const col of list) {
    const id = col.id ?? col.columnId;
    if (!id) continue;
    const name = getColumnDisplayName(col);
    if (!name) continue;
    const lower = name.toLowerCase();
    if (lower === ATTENDANCE_NAME.toLowerCase()) {
      attendanceColumnId = String(id);
    } else if (lower === QW_ATTENDANCE_NAME.toLowerCase()) {
      qwAttendanceColumnId = String(id);
    }
  }
  return { attendanceColumnId, qwAttendanceColumnId };
}

/**
 * Read cached attendance column IDs for course. Returns null if missing or expired.
 */
export async function getAttendanceColumnIdsFromCache(courseId) {
  const key = getCacheKey(courseId);
  const data = await chrome.storage.local.get(key);
  const raw = data[key];
  if (!raw || typeof raw !== "object") return null;
  const fetchedAt = raw.fetchedAt;
  if (!fetchedAt || Date.now() - fetchedAt > TTL_MS) return null;
  return {
    attendanceColumnId: raw.attendanceColumnId ?? null,
    qwAttendanceColumnId: raw.qwAttendanceColumnId ?? null
  };
}

/**
 * Write attendance column IDs to cache for course.
 */
export async function setAttendanceColumnIdsCache(courseId, payload) {
  const key = getCacheKey(courseId);
  await chrome.storage.local.set({
    [key]: {
      attendanceColumnId: payload.attendanceColumnId ?? null,
      qwAttendanceColumnId: payload.qwAttendanceColumnId ?? null,
      fetchedAt: Date.now()
    }
  });
}

/**
 * Extract numeric score from a grade entry (displayGrade.score).
 * Returns null if not available.
 */
function getScoreFromGradeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const grade = entry.grade ?? entry;
  const displayGrade = grade?.displayGrade;
  if (!displayGrade || typeof displayGrade !== "object") return null;
  const score = displayGrade.score;
  if (score == null) return null;
  const num = Number(score);
  if (Number.isNaN(num)) return null;
  return num;
}

/**
 * From grades API .results, collect scores for the given attendance column IDs.
 * @returns {{ score: number | null, columnName: string }[] } (one per column that had a score)
 */
export function extractAttendanceScoresFromGrades(gradeResults, attendanceColumnId, qwAttendanceColumnId) {
  const list = Array.isArray(gradeResults) ? gradeResults : [];
  const out = [];
  const ids = [attendanceColumnId, qwAttendanceColumnId].filter(Boolean);
  const names = [];
  if (attendanceColumnId) names.push(ATTENDANCE_NAME);
  if (qwAttendanceColumnId) names.push(QW_ATTENDANCE_NAME);
  for (let i = 0; i < ids.length; i++) {
    const colId = ids[i];
    const colName = names[i] || "Attendance";
    for (const entry of list) {
      const g = entry?.grade ?? entry;
      const entryColId = g?.columnId ?? entry?.columnId;
      if (entryColId == null) continue;
      if (String(entryColId) !== String(colId)) continue;
      const score = getScoreFromGradeEntry(entry);
      if (score != null) {
        out.push({ score, columnName: colName });
        break;
      }
    }
  }
  return out;
}

/**
 * Decide final score: one score → use it; both → max; none → null.
 */
export function selectAttendanceScore(scoresWithColumn) {
  if (!scoresWithColumn || scoresWithColumn.length === 0) return { score: null, selectedColumn: null };
  if (scoresWithColumn.length === 1) {
    return { score: scoresWithColumn[0].score, selectedColumn: scoresWithColumn[0].columnName };
  }
  const maxEntry = scoresWithColumn.reduce((best, cur) =>
    cur.score > (best?.score ?? -1) ? cur : best
  );
  return { score: maxEntry.score, selectedColumn: maxEntry.columnName };
}

/**
 * Full pipeline: resolve column IDs (cache or fetch), fetch grades, compute result.
 * context: { userId: string, fetchColumns: (courseId) => Promise<{ ok, results }>, fetchGrades: (courseId, userId) => Promise<{ ok, results }> }
 */
export async function getAttendanceForCourse(courseId, courseName, context) {
  const userId = context?.userId;
  const fetchColumns = context?.fetchColumns;
  const fetchGrades = context?.fetchGrades;
  if (!userId || typeof fetchColumns !== "function" || typeof fetchGrades !== "function") {
    return {
      ok: false,
      error: "Open Blackboard and ensure you're logged in.",
      courseId,
      courseName: courseName ?? null,
      userId: userId ?? null,
      selectedColumn: null,
      score: null,
      scoreFormatted: null,
      sources: null
    };
  }

  let attendanceColumnId = null;
  let qwAttendanceColumnId = null;
  const cached = await getAttendanceColumnIdsFromCache(courseId);
  if (cached && (cached.attendanceColumnId || cached.qwAttendanceColumnId)) {
    attendanceColumnId = cached.attendanceColumnId;
    qwAttendanceColumnId = cached.qwAttendanceColumnId;
    debugLog("courseId", courseId, "column IDs from cache", { attendanceColumnId, qwAttendanceColumnId });
  } else {
    const colRes = await fetchColumns(courseId);
    if (!colRes?.ok) {
      const err = colRes?.error || "Could not load gradebook columns.";
      const friendly404 = /404/.test(String(err)) ? "Gradebook not available for this course." : err;
      return {
        ok: false,
        error: friendly404,
        courseId,
        courseName: courseName ?? null,
        userId,
        selectedColumn: null,
        score: null,
        scoreFormatted: null,
        sources: { columnsEndpointUsed: "gradebook/columns", gradesEndpointUsed: null }
      };
    }
    const results = colRes.results ?? [];
    const found = findAttendanceColumnIds(results);
    attendanceColumnId = found.attendanceColumnId;
    qwAttendanceColumnId = found.qwAttendanceColumnId;
    debugLog("courseId", courseId, "found column IDs", { attendanceColumnId, qwAttendanceColumnId });
    if (!attendanceColumnId && !qwAttendanceColumnId) {
      return {
        ok: true,
        error: "Attendance column not found for this course.",
        courseId,
        courseName: courseName ?? null,
        userId,
        selectedColumn: null,
        score: null,
        scoreFormatted: null,
        sources: { columnsEndpointUsed: "gradebook/columns", gradesEndpointUsed: null }
      };
    }
    await setAttendanceColumnIdsCache(courseId, {
      attendanceColumnId,
      qwAttendanceColumnId
    });
  }

  const gradesRes = await fetchGrades(courseId, userId);
  if (!gradesRes?.ok) {
    const err = gradesRes?.error || "Could not load grades.";
    const friendly404 = /404/.test(String(err)) ? "Gradebook not available for this course." : err;
    return {
      ok: false,
      error: friendly404,
      courseId,
      courseName: courseName ?? null,
      userId,
      selectedColumn: null,
      score: null,
      scoreFormatted: null,
      sources: { columnsEndpointUsed: "gradebook/columns", gradesEndpointUsed: "gradebook/grades" }
    };
  }
  const gradeResults = gradesRes.results ?? [];
  const scoresWithColumn = extractAttendanceScoresFromGrades(
    gradeResults,
    attendanceColumnId,
    qwAttendanceColumnId
  );
  debugLog("courseId", courseId, "userId", userId, "scoresWithColumn", scoresWithColumn);
  const { score, selectedColumn } = selectAttendanceScore(scoresWithColumn);

  let scoreFormatted = null;
  if (score != null) {
    const rounded = Math.round(score * 100) / 100;
    scoreFormatted = rounded.toFixed(2) + "%";
  }

  return {
    ok: true,
    error: score == null ? "Attendance score not available yet." : null,
    courseId,
    courseName: courseName ?? null,
    userId,
    selectedColumn,
    score: score ?? null,
    scoreFormatted,
    sources: {
      columnsEndpointUsed: "gradebook/columns",
      gradesEndpointUsed: "gradebook/grades"
    }
  };
}
