const DEFAULT_BASE_URL = "https://blackboard.ie.edu";
const DEFAULT_CACHE_TTL_MS = 45 * 1000;

/** @typedef {"Q1" | "Q2" | "ANNUAL" | "ORGANIZATION_COMMUNITY" | "OTHER"} CourseCategory */

let _cache = {
  userId: null,
  expiresAt: 0,
  result: null
};

/**
 * Normalize string for robust, case-insensitive matching.
 * @param {string} s
 * @returns {string}
 */
export function normalizeText(s) {
  if (!s || typeof s !== "string") return "";
  return s.toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Build the text haystack used for Q1/Q2/ANNUAL detection.
 * Order: term.name, term.id, displayName, name, description.
 * @param {any} course
 * @returns {string}
 */
export function buildCourseSearchText(course) {
  if (!course || typeof course !== "object") return "";
  const term = course.term || {};
  const parts = [
    term?.name,
    term?.id,
    course.displayName,
    course.name,
    course.description
  ]
    .filter(Boolean)
    .map((v) => (typeof v === "string" ? v : String(v)));
  if (parts.length === 0) return "";
  return normalizeText(parts.join(" | "));
}

/**
 * Classify a Blackboard course object into a standardized category.
 * Rules:
 *  A) COMMUNITY or isOrganization → ORGANIZATION_COMMUNITY
 *  B) "FIRST Q1" in term/name/description → Q1
 *  C) "FIRST Q2" → Q2
 *  D) "ANNUAL" → ANNUAL
 *  E) otherwise → OTHER
 *
 * @param {any} course
 * @returns {CourseCategory}
 */
export function classifyCourse(course) {
  try {
    if (!course || typeof course !== "object") return "OTHER";

    const serviceLevelType = course.serviceLevelType;
    const isOrganization = course.isOrganization === true;
    if (serviceLevelType === "COMMUNITY" || isOrganization) {
      return "ORGANIZATION_COMMUNITY";
    }

    const haystack = buildCourseSearchText(course);
    if (!haystack) return "OTHER";

    if (haystack.includes("FIRST Q1")) return "Q1";
    if (haystack.includes("FIRST Q2")) return "Q2";
    if (haystack.includes("ANNUAL")) return "ANNUAL";

    return "OTHER";
  } catch {
    return "OTHER";
  }
}

/**
 * Best-effort availability flag combining membership + course availability.
 * @param {any} membership
 * @param {any} course
 * @returns {boolean}
 */
function computeAvailability(membership, course) {
  // Default to true unless we see explicit "false" signals.
  let available = true;

  if (membership && typeof membership === "object") {
    if (membership.isAvailable === false) available = false;
    if (membership.available === false) available = false;
  }

  if (course && typeof course === "object") {
    if (course.isAvailable === false) available = false;
    if (course.available === false) available = false;
    const eff = course.effectiveAvailability || {};
    // Blackboard often uses available: "Yes"/"No" or booleans.
    if (eff.available != null) {
      const val = typeof eff.available === "string" ? eff.available.toLowerCase() : eff.available;
      if (val === "no" || val === false || val === 0) available = false;
    }
  }

  return available;
}

/**
 * Normalize one membership record to the extension's data model.
 * @param {any} membership
 * @param {{ keepRaw?: boolean, debug?: boolean }} [opts]
 * @returns {{
 *   membershipId: string | null,
 *   userId: string | null,
 *   courseId: string | null,
 *   courseDisplayName: string,
 *   termName: string | null,
 *   serviceLevelType: string | null,
 *   isOrganization: boolean,
 *   category: CourseCategory,
 *   externalAccessUrl: string | null,
 *   isAvailable: boolean,
 *   lastAccessDate: string | null,
 *   raw?: any
 * } | null}
 */
export function normalizeMembership(membership, opts) {
  try {
    const keepRaw = !opts || opts.keepRaw !== false;
    const course = membership?.course || {};
    const membershipId = membership?.id != null ? String(membership.id) : null;
    const userId = membership?.userId != null ? String(membership.userId) : null;
    const courseId =
      (course && (course.id != null ? String(course.id) : null)) ||
      (membership?.courseId != null ? String(membership.courseId) : null);

    const displayName =
      (course?.displayName && String(course.displayName).trim()) ||
      (course?.name && String(course.name).trim()) ||
      (courseId || "(no name)");

    const termName =
      (course?.term && course.term.name != null ? String(course.term.name) : null) ?? null;

    const serviceLevelType =
      course?.serviceLevelType != null ? String(course.serviceLevelType) : null;

    const isOrganization = course?.isOrganization === true;

    const category = classifyCourse(course);

    const externalAccessUrl =
      course?.externalAccessUrl != null ? String(course.externalAccessUrl) : null;

    const isAvailable = computeAvailability(membership, course);

    const lastAccessDateRaw =
      membership?.lastAccessDate ??
      membership?.lastAccessed ??
      membership?.lastAccess ??
      membership?.lastActivityDate ??
      null;
    const lastAccessDate =
      lastAccessDateRaw != null ? String(lastAccessDateRaw) : null;

    const base = {
      membershipId,
      userId,
      courseId,
      courseDisplayName: displayName,
      termName,
      serviceLevelType,
      isOrganization,
      category,
      externalAccessUrl,
      isAvailable,
      lastAccessDate
    };

    if (keepRaw) {
      return { ...base, raw: membership };
    }
    return base;
  } catch (e) {
    if (opts?.debug && typeof console !== "undefined" && console.warn) {
      console.warn("[courseClassifier] normalizeMembership error", e);
    }
    return null;
  }
}

/**
 * Classify and normalize a memberships API response.
 * @param {any} responseJson
 * @param {{ keepRaw?: boolean, debug?: boolean }} [opts]
 * @returns {{
 *   totals: { Q1: number, Q2: number, ANNUAL: number, ORGANIZATION_COMMUNITY: number, OTHER: number },
 *   items: ReturnType<typeof normalizeMembership>[]
 * }}
 */
export function classifyMemberships(responseJson, opts) {
  const totals = {
    Q1: 0,
    Q2: 0,
    ANNUAL: 0,
    ORGANIZATION_COMMUNITY: 0,
    OTHER: 0
  };

  const items = [];
  const results = Array.isArray(responseJson?.results) ? responseJson.results : [];

  for (const m of results) {
    const norm = normalizeMembership(m, opts);
    if (!norm) continue;
    items.push(norm);
    if (norm.category && Object.prototype.hasOwnProperty.call(totals, norm.category)) {
      totals[norm.category]++;
    } else {
      totals.OTHER++;
    }
  }

  return { totals, items };
}

/**
 * Determine the current semester from classification totals.
 * If there are 0 Q2 courses → first semester; if more than 0 Q2 → second semester.
 *
 * @param {{ Q2?: number }} totals - object with at least totals.Q2 (from classifyMemberships)
 * @returns {"first" | "second"}
 */
export function currentSemester(totals) {
  const q2 = totals && typeof totals.Q2 === "number" ? totals.Q2 : 0;
  return q2 > 0 ? "second" : "first";
}

/**
 * Internal helper to decide whether cached result is still valid.
 * @param {string} userId
 * @param {number} now
 * @returns {boolean}
 */
function cacheIsValid(userId, now) {
  return (
    _cache.userId === userId &&
    _cache.expiresAt > 0 &&
    now < _cache.expiresAt &&
    _cache.result != null
  );
}

/**
 * Fetch memberships for a user from Blackboard Ultra API.
 *
 * Signature:
 *   fetchMemberships(userId, authContext?)
 *
 * authContext may include:
 *   - baseUrl?: string (default: https://blackboard.ie.edu)
 *   - xsrf?: string
 *   - fetchJson?: (url: string, xsrf?: string) => Promise<any>
 *   - debug?: boolean
 *
 * @param {string} userId
 * @param {{ baseUrl?: string, xsrf?: string, fetchJson?: (url: string, xsrf?: string) => Promise<any>, debug?: boolean }} [authContext]
 * @returns {Promise<any>}
 */
export async function fetchMemberships(userId, authContext) {
  if (!userId || typeof userId !== "string") {
    throw new Error("fetchMemberships: userId is required");
  }

  const baseUrl =
    (authContext && typeof authContext.baseUrl === "string" && authContext.baseUrl) ||
    DEFAULT_BASE_URL;
  const xsrf = authContext?.xsrf;
  const debug = authContext?.debug === true;

  const fetchJson =
    typeof authContext?.fetchJson === "function"
      ? authContext.fetchJson
      : async (url, xsrfToken) => {
          const headers = { Accept: "application/json" };
          if (xsrfToken) {
            headers["X-Blackboard-XSRF"] = xsrfToken;
            headers["x-blackboard-xsrf"] = xsrfToken;
          }
          const res = await fetch(url, {
            method: "GET",
            credentials: "include",
            cache: "no-store",
            headers
          });
          if (res.status === 401 || res.status === 403) {
            throw new Error(
              "Open Blackboard in a tab and ensure you're logged in, then retry."
            );
          }
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(
              `HTTP ${res.status} at ${url} ${text ? text.slice(0, 200) : ""}`.trim()
            );
          }
          const data = await res.json();
          if (debug && typeof console !== "undefined" && console.log) {
            try {
              const sample = JSON.stringify(data);
              const sampleStr =
                sample.length > 800 ? sample.slice(0, 800) + "… (truncated)" : sample;
              console.log("[courseClassifier] memberships GET", url, "→ sample:", sampleStr);
            } catch {
              console.log("[courseClassifier] memberships GET", url, "→ response logged");
            }
          }
          return data;
        };

  const base = baseUrl.replace(/\/$/, "");
  const url =
    `${base}/learn/api/v1/users/${encodeURIComponent(
      userId
    )}/memberships` +
    "?expand=course.effectiveAvailability,course.permissions,courseRole" +
    "&includeCount=true&limit=10000";

  return fetchJson(url, xsrf);
}

/**
 * High-level API: fetch + classify + cache for a short TTL.
 *
 * @param {string} userId
 * @param {{
 *   baseUrl?: string,
 *   xsrf?: string,
 *   fetchJson?: (url: string, xsrf?: string) => Promise<any>,
 *   debug?: boolean,
 *   cacheTtlMs?: number
 * }} [options]
 * @returns {Promise<{
 *   totals: { Q1: number, Q2: number, ANNUAL: number, ORGANIZATION_COMMUNITY: number, OTHER: number },
 *   items: ReturnType<typeof normalizeMembership>[]
 * }>}
 */
export async function getClassifiedCourses(userId, options) {
  const now = Date.now();
  const ttlMs =
    options && typeof options.cacheTtlMs === "number" && options.cacheTtlMs > 0
      ? options.cacheTtlMs
      : DEFAULT_CACHE_TTL_MS;

  if (cacheIsValid(userId, now)) {
    return _cache.result;
  }

  const json = await fetchMemberships(userId, options);
  const result = classifyMemberships(json, {
    keepRaw: true,
    debug: options?.debug === true
  });

  _cache = {
    userId,
    expiresAt: now + ttlMs,
    result
  };

  return result;
}

/**
 * Clear in-memory cache (for tests / debugging).
 */
export function clearCourseClassifierCache() {
  _cache = { userId: null, expiresAt: 0, result: null };
}

