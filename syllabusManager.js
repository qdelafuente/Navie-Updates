/**
 * Syllabus status detection, uploaded PDF records, and fast retrieval.
 * All data in extension storage (no Blackboard upload). Course-keyed by courseId.
 */

import { parseSyllabusFromText, toStructuredFormat } from "./syllabusParser.js";

const STORAGE_STATUS = "syllabusStatusByCourse";
const STORAGE_UPLOADS = "syllabusUploads";
const IDB_NAME = "jarvis_syllabus_pdfs";
const IDB_STORE = "pdf_blobs";
const SYLLABUS_CHECK_COOLDOWN_MS = 5 * 60 * 1000; // 5 min
const CHUNK_CHARS = 2000;
const CHUNK_OVERLAP = 200;
const ESTIMATE_CHARS_PER_TOKEN = 4;

export const SyllabusStatus = Object.freeze({ AVAILABLE: "AVAILABLE", MISSING: "MISSING", UNKNOWN: "UNKNOWN", UPLOADED: "UPLOADED" });

const UNAVAILABLE_PHRASES = [
  /eSyllabus\s+Not\s+Available/i,
  /esyllabus\s+not\s+available/i,
  /syllabus\s+not\s+available/i,
  /not\s+available\s*[.\s]*$/im
];

/**
 * Detect if the syllabus HTML indicates "not available".
 * @param {string} html
 * @returns {boolean}
 */
export function isSyllabusUnavailable(html) {
  if (!html || typeof html !== "string") return false;
  const trimmed = html.trim();
  if (trimmed.length < 50) return true;
  for (const re of UNAVAILABLE_PHRASES) {
    if (re.test(html)) return true;
  }
  return false;
}

/**
 * Determine syllabus status from fetch result.
 * @param {{ ok: boolean, html?: string, error?: string }} result
 * @returns {"AVAILABLE"|"MISSING"|"UNKNOWN"}
 */
export function getSyllabusStatusFromFetch(result) {
  if (!result) return SyllabusStatus.UNKNOWN;
  if (result.ok && result.html) {
    return isSyllabusUnavailable(result.html) ? SyllabusStatus.MISSING : SyllabusStatus.AVAILABLE;
  }
  return SyllabusStatus.UNKNOWN;
}

/**
 * Persist syllabus status for a course (called after fetch).
 * @param {string} courseId
 * @param {"AVAILABLE"|"MISSING"|"UNKNOWN"} status
 */
export async function setSyllabusStatus(courseId, status) {
  const key = String(courseId).trim();
  if (!key) return;
  const data = await chrome.storage.local.get([STORAGE_STATUS]);
  const map = data[STORAGE_STATUS] || {};
  map[key] = { status, lastCheckedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [STORAGE_STATUS]: map });
}

/**
 * Get status and lastCheckedAt for a course.
 * @param {string} courseId
 * @returns {Promise<{ status: string, lastCheckedAt: string | null }>}
 */
export async function getSyllabusStatus(courseId) {
  const key = String(courseId).trim();
  const data = await chrome.storage.local.get([STORAGE_STATUS]);
  const map = data[STORAGE_STATUS] || {};
  const entry = map[key];
  return entry ? { status: entry.status, lastCheckedAt: entry.lastCheckedAt || null } : { status: SyllabusStatus.UNKNOWN, lastCheckedAt: null };
}

/**
 * Get all statuses.
 * @returns {Promise<Record<string, { status: string, lastCheckedAt: string }>>}
 */
export async function getAllSyllabusStatuses() {
  const data = await chrome.storage.local.get([STORAGE_STATUS]);
  return data[STORAGE_STATUS] || {};
}

/**
 * Get uploaded syllabus record for a course (metadata + extractedText + chunks). No blob.
 * @param {string} courseId
 * @returns {Promise<import("./syllabusManager.js").UploadedSyllabusRecord | null>}
 */
export async function getUploadedSyllabus(courseId) {
  const key = String(courseId).trim();
  const data = await chrome.storage.local.get([STORAGE_UPLOADS]);
  const map = data[STORAGE_UPLOADS] || {};
  return map[key] || null;
}

/**
 * Save uploaded syllabus record (metadata, extractedText, chunks). Caller stores blob separately in IndexedDB.
 * @param {string} courseId
 * @param {import("./syllabusManager.js").UploadedSyllabusRecord} record
 */
export async function setUploadedSyllabus(courseId, record) {
  const key = String(courseId).trim();
  if (!key) return;
  const data = await chrome.storage.local.get([STORAGE_UPLOADS]);
  const map = data[STORAGE_UPLOADS] || {};
  map[key] = record;
  await chrome.storage.local.set({ [STORAGE_UPLOADS]: map });
  await setSyllabusStatus(courseId, SyllabusStatus.UPLOADED);
}

/**
 * Remove uploaded syllabus for a course. Caller must delete blob from IndexedDB.
 * @param {string} courseId
 * @param {"AVAILABLE"|"MISSING"|"UNKNOWN"} fallbackStatus
 */
export async function removeUploadedSyllabus(courseId, fallbackStatus = SyllabusStatus.MISSING) {
  const key = String(courseId).trim();
  const data = await chrome.storage.local.get([STORAGE_UPLOADS]);
  const map = data[STORAGE_UPLOADS] || {};
  delete map[key];
  await chrome.storage.local.set({ [STORAGE_UPLOADS]: map });
  await setSyllabusStatus(courseId, fallbackStatus);
}

/**
 * Parse sessions from extracted PDF text using the robust parser.
 * Returns array sorted by session number. Each: { number, title, content }.
 */
export function parseSessionsFromText(text, options) {
  const parsed = parseSyllabusFromText(text, options);
  return (parsed.sessions || []).map(s => ({
    number: s.sessionNumber,
    title: s.title || "",
    content: s.rawText || ""
  }));
}

/**
 * Full parse returning the structured result + diagnostics (re-exported for callers that need more).
 */
export { parseSyllabusFromText, toStructuredFormat };

/**
 * Chunk text for fast retrieval. Session-aware via the robust parser:
 * each correctly-reconstructed session gets its own chunk, non-session parts are chunked by section.
 */
export function chunkSyllabusText(text, options = {}) {
  const maxChunk = options.maxChunkChars ?? CHUNK_CHARS;
  if (!text || typeof text !== "string") return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  const parsed = parseSyllabusFromText(trimmed);
  const chunks = [];
  let index = 0;

  for (const sec of parsed.sections || []) {
    const name = (sec.name || "").toUpperCase();
    if (/^PROGRAM/.test(name)) continue;
    if (!sec.text || sec.text.trim().length === 0) continue;
    for (const piece of fixedChunk(sec.text, maxChunk, index)) {
      chunks.push(piece);
      index++;
    }
  }

  for (const s of parsed.sessions || []) {
    const header = "SESSION " + s.sessionNumber;
    const titleLine = s.title || "";
    const subtopics = (s.subtopics || []).join("\n");
    const body = [titleLine, subtopics].filter(Boolean).join("\n");
    const chunkText = header + "\n" + body.trim();
    if (chunkText.trim().length <= header.length + 1) {
      chunks.push({
        chunkId: "s" + s.sessionNumber,
        text: header + "\n(No content extracted)",
        tokenCountEstimate: 5,
        keywords: ["session", String(s.sessionNumber)],
        sessionNumber: s.sessionNumber
      });
    } else {
      chunks.push({
        chunkId: "s" + s.sessionNumber,
        text: chunkText,
        tokenCountEstimate: Math.ceil(chunkText.length / ESTIMATE_CHARS_PER_TOKEN),
        keywords: extractKeywords(chunkText),
        sessionNumber: s.sessionNumber
      });
    }
    index++;
  }

  if (chunks.length === 0) {
    for (const piece of fixedChunk(trimmed, maxChunk, index)) {
      chunks.push(piece);
      index++;
    }
  }

  return chunks;
}

function fixedChunk(text, maxChunk, startIndex) {
  const overlap = CHUNK_OVERLAP;
  const pieces = [];
  let start = 0;
  let idx = startIndex;
  while (start < text.length) {
    let end = Math.min(start + maxChunk, text.length);
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(" ", end);
      if (lastSpace > start) end = lastSpace;
    }
    const slice = text.slice(start, end);
    pieces.push({
      chunkId: "c" + idx,
      text: slice,
      tokenCountEstimate: Math.ceil(slice.length / ESTIMATE_CHARS_PER_TOKEN),
      keywords: extractKeywords(slice)
    });
    idx++;
    start = end - (end - start >= maxChunk ? overlap : 0);
  }
  return pieces;
}

function extractKeywords(text) {
  if (!text || typeof text !== "string") return [];
  const stop = new Set(["the", "a", "an", "and", "or", "of", "in", "to", "for", "is", "are", "on", "with", "by", "as", "at", "from", "this", "that", "be", "have", "has", "will", "can", "not", "no", "all", "each", "every"]);
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stop.has(w))
    .slice(0, 50);
}

/**
 * Detect if the user query asks about a specific session number.
 * @param {string} query
 * @returns {number|null}
 */
function detectSessionNumber(query) {
  const m = (query || "").match(/\bsession\s+#?\s*(\d+)\b/i) || (query || "").match(/\bsesi[oó]n\s+#?\s*(\d+)\b/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Retrieve relevant chunks. Session-aware: when the query asks about a specific session,
 * return that session's chunk directly (exact match) plus surrounding sessions for context.
 */
export function getRelevantChunks(record, query, options = {}) {
  if (!record?.chunks?.length) return record?.extractedText?.slice(0, 15000) || "";
  const maxChunks = options.maxChunks ?? 8;

  const sessionNum = detectSessionNumber(query);
  if (sessionNum != null) {
    const exactChunk = record.chunks.find((c) => c.sessionNumber === sessionNum);
    if (exactChunk) {
      const nearby = record.chunks.filter((c) =>
        c.sessionNumber != null && Math.abs(c.sessionNumber - sessionNum) <= 1 && c.sessionNumber !== sessionNum
      );
      const result = [exactChunk, ...nearby];
      return result.map((c) => c.text).join("\n\n---\n\n");
    }
  }

  const qKeywords = extractKeywords(query);
  if (qKeywords.length === 0) {
    return record.chunks.slice(0, maxChunks).map((c) => c.text).join("\n\n---\n\n");
  }
  const scored = record.chunks.map((c) => {
    const set = new Set(c.keywords || []);
    let score = 0;
    for (const q of qKeywords) {
      if (set.has(q)) score++;
      else if ((c.text || "").toLowerCase().includes(q)) score += 0.5;
    }
    return { ...c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxChunks);
  return top.map((c) => c.text).join("\n\n---\n\n");
}

/**
 * Open IndexedDB for PDF blobs (use in sidepanel).
 * @returns {Promise<IDBDatabase>}
 */
export function openSyllabusIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: "courseId" });
    };
  });
}

/**
 * Store PDF blob in IndexedDB (sidepanel).
 * @param {string} courseId
 * @param {ArrayBuffer} blob
 */
export async function storePdfBlob(courseId, blob) {
  const db = await openSyllabusIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    store.put({ courseId: String(courseId).trim(), blob, at: Date.now() });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Delete PDF blob from IndexedDB (sidepanel).
 * @param {string} courseId
 */
export async function deletePdfBlob(courseId) {
  const db = await openSyllabusIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(String(courseId).trim());
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Simple hash for checksum (non-crypto).
 * @param {string} s
 * @returns {string}
 */
export function simpleHash(s) {
  if (typeof s !== "string") return "";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
  return Math.abs(h).toString(36);
}
