/**
 * Text normalization and fuzzy matching for assignment grade lookup.
 * No PII or tokens are logged.
 */

/**
 * Normalize a string for matching: lowercase, trim, collapse whitespace, remove punctuation.
 * @param {string} s
 * @returns {string}
 */
export function normalizeForMatch(s) {
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    .trim()
    .replace(/[\s]+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

/**
 * Tokenize into words (split on whitespace, filter empty).
 * @param {string} s - normalized string
 * @returns {string[]}
 */
export function tokenize(s) {
  if (typeof s !== "string") return [];
  return s.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Token set ratio: similarity based on set intersection / union.
 * Returns a value in [0, 1]. 1 = identical token sets.
 * @param {string} a - normalized string
 * @param {string} b - normalized string
 * @returns {number}
 */
export function tokenSetRatio(a, b) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (na === nb) return 1;
  const ta = new Set(tokenize(na));
  const tb = new Set(tokenize(nb));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection += 1;
  }
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Partial ratio: best substring match. If query is contained in title (after normalize), return high score.
 * @param {string} query - normalized or raw
 * @param {string} title - assignment title
 * @returns {number}
 */
export function partialRatio(query, title) {
  const nq = normalizeForMatch(query);
  const nt = normalizeForMatch(title);
  if (nq.length === 0) return 0;
  if (nt.includes(nq)) return Math.min(1, 0.85 + (nq.length / nt.length) * 0.15);
  if (nq.includes(nt)) return Math.min(1, 0.7 + (nt.length / nq.length) * 0.15);
  return tokenSetRatio(query, title);
}

/**
 * Combined score: token set ratio and partial ratio. Use best of both, with slight boost for partial.
 * @param {string} query
 * @param {string} title
 * @returns {number}
 */
export function similarityScore(query, title) {
  const setScore = tokenSetRatio(query, title);
  const partScore = partialRatio(query, title);
  return Math.max(setScore, partScore);
}

/**
 * Find best match from a list of items with .title. Returns { index, title, score } or null.
 * @param {string} query
 * @param {{ title: string }[]} items
 * @param {number} threshold - minimum score (default 0.45)
 * @returns {{ index: number, title: string, score: number } | null}
 */
export function findBestMatch(query, items, threshold = 0.45) {
  if (!items || items.length === 0) return null;
  let best = { index: -1, title: "", score: -1 };
  for (let i = 0; i < items.length; i++) {
    const title = items[i]?.title ?? items[i]?.name ?? String(items[i]);
    const score = similarityScore(query, title);
    if (score > best.score) {
      best = { index: i, title, score };
    }
  }
  return best.score >= threshold ? best : null;
}
