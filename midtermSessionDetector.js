/**
 * midtermSessionDetector.js — Deterministic algorithm to identify the session number
 * where the MIDTERM EXAM occurs in syllabus plain text.
 *
 * @returns {{ midterm_session: number|null, candidates: number[], reason: string, confidence: number, evidence: Array<{text:string,start:number,end:number}> }}
 */

const SESSION_PATTERNS = [
  /\bSESSION\s+(\d{1,3})\b/gi,
  /\bSESION\s+(\d{1,3})\b/gi,
  /\bSession\s+(\d{1,3})\s*[:\-\)]/gi,
  /\bSESSION\s*(\d{1,3})\s*\([^)]*\)/gi,
  /\bSESSION\s*(\d{1,3})\s*\[[^\]]*\]/gi,
  /^\s*(\d{1,3})\)\s*(?:SESSION|Session|SESIÓN)\s+/gim,
  /\b(?:Week|Semana|Class|Clase)\s+(\d{1,3})\b/gi
];

/** Midterm exam keywords (prefer explicit exam over review) */
const MIDTERM_EXAM_KEYWORDS = [
  // English
  "mid-term exam",
  "midterm exam",
  "mid-term examination",
  "midterm examination",
  "mid-term assessment",
  "midterm assessment",
  "mid-term exam (exam via",
  "midterm exam (exam via",
  "partial exam",
  // Spanish
  "examen midterm",
  "examen parcial",
  "prueba parcial",
  "evaluación parcial",
  "evaluacion parcial",
  "examen intermedio",
  "prueba intermedia",
  "evaluación intermedia",
  "evaluacion intermedia",
  "primer parcial",
  "segundo parcial"
];

const MIDTERM_ANY_KEYWORDS = [
  "mid-term",
  "midterm",
  "mid term",
  "parcial",
  "intermediate exam",
  "examen intermedi",
  "examen de medio",
  "prueba de medio"
];

const MIDTERM_REVIEW_KEYWORDS = ["mid-term review", "midterm review", "mid-term review (part", "parcial review", "repaso parcial", "repaso del parcial"];

function normalizeText(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/ +/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Find all session headings with their start/end offsets.
 * Dedupe by position (within 30 chars) to avoid same heading matched by multiple patterns.
 * @returns {Array<{ num: number, start: number, end: number, heading: string }>}
 */
function findSessionHeadings(text) {
  const headings = [];
  const seenStarts = new Set();

  for (const re of SESSION_PATTERNS) {
    const pattern = new RegExp(re.source, re.flags);
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const num = parseInt(m[1], 10);
      if (isNaN(num) || num < 1 || num > 200) continue;
      const pos = m.index;
      const nearby = [...seenStarts].some((s) => Math.abs(s - pos) <= 30);
      if (nearby) continue;
      seenStarts.add(pos);
      headings.push({
        num,
        start: pos,
        end: pos + m[0].length,
        heading: m[0]
      });
    }
  }

  return headings.sort((a, b) => a.start - b.start);
}

/**
 * Build session blocks: each session has heading span and content span (until next heading or EOF).
 */
function buildSessions(text, headings) {
  const sessions = [];

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const contentEnd = i + 1 < headings.length ? headings[i + 1].start : text.length;
    const contentStart = h.end;
    const content = text.slice(contentStart, contentEnd);
    const fullBlock = text.slice(h.start, contentEnd);

    sessions.push({
      num: h.num,
      headingStart: h.start,
      headingEnd: h.end,
      contentStart,
      contentEnd,
      heading: text.slice(h.start, h.end),
      content,
      fullBlock,
      fullStart: h.start,
      fullEnd: contentEnd
    });
  }

  return sessions;
}

function containsKeyword(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

function extractEvidence(text, start, end, maxLen = 300) {
  const snippet = text.slice(Math.max(0, start), Math.min(text.length, end));
  const trimmed = snippet.length > maxLen ? snippet.slice(0, maxLen) + "…" : snippet;
  return { text: trimmed.replace(/\n/g, " "), start, end };
}

/**
 * Look for explicit sentence "midterm ... session X" or "session X ... midterm"
 */
function findExplicitSessionMentions(text) {
  const results = [];
  let m;

  const re1 = /\b(?:midterm|mid-term|parcial|intermediate\s+exam)\b[\s\S]{0,150}?\b(?:session|sesi[oó]n|ses\.?|week|class)\s*(?:#?\s*)?(\d{1,3})\b/gi;
  while ((m = re1.exec(text)) !== null) {
    const sessionMatch = m[0].match(/\b(?:session|sesi[oó]n|ses\.?|week|class)\s*(?:#?\s*)?(\d{1,3})\b/i);
    const sessionStart = sessionMatch ? m.index + m[0].indexOf(sessionMatch[0]) : m.index;
    const distToMidterm = sessionStart - m.index;
    results.push({ num: parseInt(m[1], 10), start: m.index, end: m.index + m[0].length, sentence: m[0], altNum: null, distToMidterm, priority: 2 });
  }

  const re2 = /\b(?:session|sesi[oó]n|ses\.?)\s*(?:#?\s*)?(\d{1,3})\b[\s\S]{0,150}?\b(?:midterm|mid-term|parcial|intermediate\s+exam)\b/gi;
  while ((m = re2.exec(text)) !== null) {
    const num = parseInt(m[1], 10);
    const sessionNumEnd = m.index + m[0].indexOf(m[1]) + m[1].length;
    const midtermMatch = m[0].match(/\b(?:midterm|mid-term|parcial|intermediate\s+exam)\b/i);
    const midtermPos = midtermMatch ? m.index + m[0].indexOf(midtermMatch[0]) : m.index + m[0].length;
    const distToMidterm = midtermPos - sessionNumEnd;
    if (!results.some((r) => r.num === num && Math.abs(r.start - m.index) < 80)) {
      results.push({ num, start: m.index, end: m.index + m[0].length, sentence: m[0], altNum: null, distToMidterm, priority: 0 });
    }
  }

  const re3 = /\b(?:midterm|mid-term)\s+(?:exam|assessment|examination)?\s*(?:could|may|might|will)?\s*(?:take\s+place)?\s*(?:either\s+)?(?:in\s+)?(?:session\s+)?(\d{1,3})\s*(?:or\s+in\s+session\s+)?(\d{1,3})?/gi;
  while ((m = re3.exec(text)) !== null) {
    const n1 = parseInt(m[1], 10);
    const n2 = m[2] ? parseInt(m[2], 10) : null;
    if (!results.some((r) => r.num === n1 && r.altNum === n2)) {
      results.push({ num: n1, start: m.index, end: m.index + m[0].length, sentence: m[0], altNum: n2, distToMidterm: 0, priority: 1 });
    }
  }

  return results.sort((a, b) => {
    const priA = a.priority != null ? a.priority : 2;
    const priB = b.priority != null ? b.priority : 2;
    if (priA !== priB) return priA - priB;
    const distA = a.distToMidterm != null ? a.distToMidterm : 999;
    const distB = b.distToMidterm != null ? b.distToMidterm : 999;
    if (distA !== distB) return distA - distB;
    return a.start - b.start;
  });
}

/**
 * Main detection function.
 * @param {string} rawText - Syllabus plain text
 * @returns {{ midterm_session: number|null, candidates: number[], reason: string, confidence: number, evidence: Array<{text:string,start:number,end:number}>, summary: string }}
 */
export function detectMidtermSession(rawText) {
  const defaultResult = {
    midterm_session: null,
    candidates: [],
    reason: "No explicit midterm session found.",
    confidence: 0,
    evidence: [],
    summary: "No midterm session identified."
  };

  if (!rawText || typeof rawText !== "string" || rawText.trim().length < 20) {
    return { ...defaultResult, reason: "Input text too short or empty." };
  }

  const text = normalizeText(rawText);
  const textLower = text.toLowerCase();
  const evidence = [];

  // 1. Session segmentation first — most reliable when heading explicitly contains "MID-TERM EXAM"
  const headings = findSessionHeadings(text);
  const sessions = buildSessions(text, headings);

  if (sessions.length === 0) {
    // Fallback: search for "week X" or "class X" near "midterm"
    const fallbackRe = /\b(?:week|class|session|sesi[oó]n)\s*(\d{1,3})\b/gi;
    let bestNum = null;
    let bestDist = Infinity;
    const midtermIdx = textLower.search(/\b(?:midterm|mid-term|parcial)\b/);
    if (midtermIdx >= 0) {
      fallbackRe.lastIndex = 0;
      let m;
      while ((m = fallbackRe.exec(text)) !== null) {
        const dist = Math.abs(m.index - midtermIdx);
        if (dist < bestDist && dist < 500) {
          bestDist = dist;
          bestNum = parseInt(m[1], 10);
        }
      }
    }
    if (bestNum != null && bestNum >= 1 && bestNum <= 200) {
      return {
        midterm_session: bestNum,
        candidates: [],
        reason: "Midterm mentioned near week/class " + bestNum + ".",
        confidence: 0.65,
        evidence: [],
        summary: "Midterm inferred near session " + bestNum + " (confidence 0.65)."
      };
    }
    return defaultResult;
  }

  // 3. Direct: session heading OR first 400 chars of content contains explicit MID-TERM EXAM
  const examInHeading = sessions.filter((s) => {
    const headingBlock = s.heading + " " + s.content.slice(0, 400);
    return containsKeyword(s.heading, MIDTERM_EXAM_KEYWORDS) || containsKeyword(headingBlock, MIDTERM_EXAM_KEYWORDS) || (containsKeyword(s.heading, MIDTERM_ANY_KEYWORDS) && !containsKeyword(s.heading, MIDTERM_REVIEW_KEYWORDS));
  });
  if (examInHeading.length >= 1) {
    const chosen = examInHeading[0];
    evidence.push(extractEvidence(text, chosen.fullStart, chosen.fullEnd, 350));
    const otherFromHeadings = examInHeading.slice(1).map((s) => s.num);
    const altFromText = [];
    const altRe = /\b(?:session|sesi[oó]n)\s*(?:#?\s*)?(\d{1,3})\s*(?:or|and|\/|,)\s*(?:session\s*)?(\d{1,3})?/gi;
    let mm;
    while ((mm = altRe.exec(text)) !== null) {
      const n1 = parseInt(mm[1], 10);
      const n2 = mm[2] ? parseInt(mm[2], 10) : null;
      if (n1 >= 1 && n1 <= 200 && n1 !== chosen.num) altFromText.push(n1);
      if (n2 >= 1 && n2 <= 200 && n2 !== chosen.num) altFromText.push(n2);
    }
    const eitherRe = /(?:either|or)\s+(?:in\s+)?session\s+(\d{1,3})\s+or\s+(?:in\s+)?session\s+(\d{1,3})/gi;
    while ((mm = eitherRe.exec(text)) !== null) {
      const n1 = parseInt(mm[1], 10);
      const n2 = parseInt(mm[2], 10);
      if (n1 >= 1 && n1 <= 200 && n1 !== chosen.num) altFromText.push(n1);
      if (n2 >= 1 && n2 <= 200 && n2 !== chosen.num) altFromText.push(n2);
    }
    const candidates = [...new Set(otherFromHeadings.concat(altFromText))].filter((n) => n !== chosen.num).sort((a, b) => a - b);
    return {
      midterm_session: chosen.num,
      candidates,
      reason: "Session heading contains explicit 'MID-TERM EXAM'." + (candidates.length ? " Alternatives mentioned: " + candidates.join(", ") + "." : ""),
      confidence: candidates.length ? 0.9 : 0.98,
      evidence: evidence.slice(0, 3),
      summary: "Midterm found in session " + chosen.num + (candidates.length ? " (alt: " + candidates.join(", ") + ")" : "") + "."
    };
  }

  // 4. Heading has MID-TERM REVIEW — check if next session has exam
  const reviewSessions = sessions.filter((s) => containsKeyword(s.heading, MIDTERM_REVIEW_KEYWORDS));
  for (const rev of reviewSessions) {
    const nextSession = sessions.find((s) => s.headingStart > rev.fullEnd && s.num !== rev.num);
    if (nextSession && containsKeyword(nextSession.heading + " " + nextSession.content.slice(0, 400), MIDTERM_EXAM_KEYWORDS)) {
      evidence.push(extractEvidence(text, nextSession.fullStart, nextSession.fullEnd, 350));
      return {
        midterm_session: nextSession.num,
        candidates: [rev.num],
        reason: "Midterm review in session " + rev.num + "; explicit MID-TERM EXAM in following session " + nextSession.num + ".",
        confidence: 0.92,
        evidence: evidence.slice(0, 3),
        summary: "Midterm found in session " + nextSession.num + " (confidence 0.92)."
      };
    }
  }

  // 5. Content contains midterm within ~400 chars of session heading
  let bestByProximity = null;
  let bestScore = 0;

  for (const s of sessions) {
    const block = s.heading + " " + s.content.slice(0, 500);
    if (!containsKeyword(block, MIDTERM_ANY_KEYWORDS)) continue;
    if (containsKeyword(s.heading, MIDTERM_REVIEW_KEYWORDS) && !containsKeyword(block, MIDTERM_EXAM_KEYWORDS)) continue;

    const midtermPos = block.toLowerCase().search(/\b(?:midterm|mid-term|parcial)\b/);
    const dist = midtermPos >= 0 ? midtermPos : 999;
    const proximityScore = 1 / (1 + dist / 100);
    const hasExamKeyword = containsKeyword(block, MIDTERM_EXAM_KEYWORDS);
    const score = hasExamKeyword ? 0.85 + proximityScore * 0.1 : 0.6 + proximityScore * 0.2;

    if (score > bestScore && score >= 0.6) {
      bestScore = score;
      bestByProximity = { session: s, score, dist };
    }
  }

  if (bestByProximity) {
    const { session } = bestByProximity;
    evidence.push(extractEvidence(text, session.fullStart, Math.min(session.fullEnd, session.contentStart + 400), 350));
    return {
      midterm_session: session.num,
      candidates: [],
      reason: "Midterm phrase found in session " + session.num + " content (proximity to heading).",
      confidence: Math.min(0.95, bestByProximity.score),
      evidence: evidence.slice(0, 3),
      summary: "Midterm found in session " + session.num + " (confidence " + Math.min(0.95, bestByProximity.score).toFixed(2) + ")."
    };
  }

  // 6. Only review sessions — do NOT select
  if (reviewSessions.length > 0) {
    return {
      ...defaultResult,
      reason: "Only 'midterm review' sessions found; no explicit exam session.",
      summary: "No midterm exam session identified (only review sessions)."
    };
  }

  // 7. Fallback: explicit sentence mentions (midterm ... session X or session X ... midterm)
  const explicitMentions = findExplicitSessionMentions(text);
  if (explicitMentions.length >= 1) {
    const primary = explicitMentions[0];
    const candidates = [...new Set(explicitMentions.map((m) => m.num).concat(primary.altNum ? [primary.altNum] : []))].filter((n) => n >= 1 && n <= 200).sort((a, b) => a - b);
    const midtermSession = primary.num;
    const alts = candidates.filter((n) => n !== midtermSession);

    evidence.push(extractEvidence(text, primary.start, primary.end, 250));

    let confidence = 0.92;
    let reason = "Explicit sentence states midterm in session " + midtermSession + ".";

    if (containsKeyword(primary.sentence, ["could", "may", "might", "either"]) || alts.length > 0) {
      confidence = 0.78;
      reason = "Syllabus mentions midterm in session " + midtermSession + (alts.length ? "; alternatives: " + alts.join(", ") : "") + ".";
    }

    return {
      midterm_session: midtermSession,
      candidates: alts,
      reason,
      confidence,
      evidence: evidence.slice(0, 3),
      summary: "Midterm found in session " + midtermSession + " (confidence " + confidence.toFixed(2) + ")."
    };
  }

  return defaultResult;
}

// ─── Date parsing utilities ────────────────────────────────────────────────────

const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

const WEEKDAY_NAMES = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "mon", "tue", "wed", "thu", "fri", "sat", "sun"
]);

const TZ_TOKENS = /\b(CET|CEST|UTC|GMT|EST|EDT|PST|PDT|CST|CDT|BST|[+-]\d{1,2}:?\d{0,2})\b/gi;

function parseTimeToHHMM(str) {
  if (!str || typeof str !== "string") return null;
  const s = str.trim().toLowerCase();
  let m = s.match(/(\d{1,2})\s*[.:]\s*(\d{2})\s*(am|pm)?/i) || s.match(/(\d{1,2})\s*(am|pm)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  const isPm = (m[3] || m[2] || "").toLowerCase() === "pm";
  const isAm = (m[3] || m[2] || "").toLowerCase() === "am";
  if (isPm && h < 12) h += 12;
  if (isAm && h === 12) h = 0;
  if (!isPm && !isAm && h <= 12) {
    const hasAm = /\dam\b/i.test(str);
    const hasPm = /\dpm\b/i.test(str);
    if (hasPm && h < 12) h += 12;
    if (hasAm && h === 12) h = 0;
  }
  if (h < 0 || h > 23 || mins < 0 || mins > 59) return null;
  return String(h).padStart(2, "0") + ":" + String(mins).padStart(2, "0");
}

function inferYearForDate(month, day, refYear) {
  const d = new Date(refYear, month - 1, day);
  if (d.getMonth() === month - 1 && d.getDate() === day) return refYear;
  const dPrev = new Date(refYear - 1, month - 1, day);
  const dNext = new Date(refYear + 1, month - 1, day);
  const now = new Date();
  const distCurr = Math.abs(d.getTime() - now.getTime());
  const distPrev = Math.abs(dPrev.getTime() - now.getTime());
  const distNext = Math.abs(dNext.getTime() - now.getTime());
  if (distCurr <= distPrev && distCurr <= distNext) return refYear;
  if (distPrev <= distNext) return refYear - 1;
  return refYear + 1;
}

function parseDateToYYYYMMDD(str, refDateISO) {
  if (!str || typeof str !== "string") return null;
  const ref = refDateISO ? new Date(refDateISO) : new Date();
  const refYear = ref.getFullYear();

  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const m = parseInt(iso[2], 10);
    const d = parseInt(iso[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return iso[1] + "-" + iso[2] + "-" + iso[3];
    return null;
  }

  const slash = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/) || str.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slash) {
    let y, m, d;
    if (slash[3] && slash[3].length === 4) {
      m = parseInt(slash[1], 10);
      d = parseInt(slash[2], 10);
      y = parseInt(slash[3], 10);
    } else {
      y = parseInt(slash[1], 10);
      m = parseInt(slash[2], 10);
      d = parseInt(slash[3], 10);
    }
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    return null;
  }

  const monthMatch = str.toLowerCase().match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/);
  if (monthMatch) {
    const monthNum = MONTH_NAMES[monthMatch[1]];
    if (!monthNum) return null;
    const dayMatch = str.match(/(\d{1,2})(?:st|nd|rd|th)?/);
    const day = dayMatch ? parseInt(dayMatch[1], 10) : null;
    if (!day || day < 1 || day > 31) return null;
    const y = str.match(/\b(20\d{2})\b/) ? parseInt(str.match(/\b(20\d{2})\b/)[1], 10) : inferYearForDate(monthNum, day, refYear);
    return y + "-" + String(monthNum).padStart(2, "0") + "-" + String(day).padStart(2, "0");
  }

  const dmy = str.match(/(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)/i);
  if (dmy) {
    const monthNum = MONTH_NAMES[dmy[2].toLowerCase()];
    const day = parseInt(dmy[1], 10);
    if (monthNum && day >= 1 && day <= 31) {
      const y = str.match(/\b(20\d{2})\b/) ? parseInt(str.match(/\b(20\d{2})\b/)[1], 10) : inferYearForDate(monthNum, day, refYear);
      return y + "-" + String(monthNum).padStart(2, "0") + "-" + String(day).padStart(2, "0");
    }
  }

  return null;
}

function extractTimezone(text) {
  const m = text.match(TZ_TOKENS);
  return m ? m[0].trim() : null;
}

// ─── Announcement parsing and resolution ──────────────────────────────────────

const ORDINAL_MAP = {
  "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10,
  "eleventh": 11, "twelfth": 12, "thirteenth": 13, "fourteenth": 14, "fifteenth": 15, "sixteenth": 16, "seventeenth": 17, "eighteenth": 18, "nineteenth": 19, "twentieth": 20,
  "twenty-first": 21, "twenty-second": 22, "twenty-third": 23, "thirty": 30
};

function parseOrdinalSession(text) {
  const m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+session\b/i) || text.match(/\bsession\s+(\w+)\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!isNaN(n) && n >= 1 && n <= 60) return n;
  const word = (m[1] || "").toLowerCase();
  return ORDINAL_MAP[word] ?? null;
}

/**
 * Extract midterm session from announcements.
 * @param {Array<{id?:string, title?:string, body?:string, bodyText?:string, createdAt?:string, updatedAt?:string, createdDate?:string, modifiedDate?:string, dateISO?:string}>} announcements
 * @returns {Object} announcement_result
 */
export function extractMidtermFromAnnouncements(announcements) {
  const defaultResult = {
    midterm_session: null,
    candidates: [],
    confidence: 0,
    reason: "No midterm session found in announcements.",
    evidence: [],
    all_matches: []
  };

  if (!Array.isArray(announcements) || announcements.length === 0) return defaultResult;

  const allMatches = [];
  const midtermRe = /\bmid[-\s]?term\b|parcial|intermediate\s+exam/i;
  const sessionRe = /\b(?:session|sesi[oó]n|ses\.?)\s*(?:#?\s*)?(\d{1,3})\b|(?:\bS\s*(\d{1,3})\b)/gi;
  const rescheduleFromTo = /\b(?:moved|reschedul(?:ed|ing)|changed|shifted)\b[\s\S]{0,80}?\bfrom\b[\s\S]{0,40}?\bsession\s*(\d{1,3})\b[\s\S]{0,40}?\bto\b[\s\S]{0,40}?\bsession\s*(\d{1,3})\b/i;
  const rescheduleTo = /\b(?:changed|moved|reschedul(?:ed|ing))\b[\s\S]{0,80}?\bto\b[\s\S]{0,60}?\bsession\s*(\d{1,3})\b/i;

  for (const a of announcements) {
    const id = a.id ?? a.announcementId ?? "";
    const ts = a.updatedAt ?? a.modifiedDate ?? a.createdAt ?? a.createdDate ?? a.dateISO ?? "";
    const title = (a.title ?? "").trim();
    const body = (a.body ?? a.bodyText ?? "").trim();
    const combined = (title + "\n" + body).trim();

    if (!midtermRe.test(combined)) continue;

    let matchSession = null;
    let kind = "weak";
    let score = 0.5;
    let snippet = "";

    const rescheduleMatch = combined.match(rescheduleFromTo);
    if (rescheduleMatch) {
      const newSession = parseInt(rescheduleMatch[2], 10);
      const oldSession = parseInt(rescheduleMatch[1], 10);
      matchSession = newSession;
      kind = "reschedule_new";
      score = 0.99;
      snippet = rescheduleMatch[0].slice(0, 200);
      allMatches.push({ id, ts, session: newSession, score, kind: "reschedule_new", snippet });
      allMatches.push({ id, ts, session: oldSession, score: 0.3, kind: "reschedule_old", snippet });
      continue;
    }

    const rescheduleToMatch = combined.match(rescheduleTo);
    if (rescheduleToMatch) {
      matchSession = parseInt(rescheduleToMatch[1], 10);
      kind = "reschedule_new";
      score = 0.98;
      snippet = rescheduleToMatch[0].slice(0, 200);
      allMatches.push({ id, ts, session: matchSession, score, kind, snippet });
      continue;
    }

    const re1 = /\b(?:midterm|mid-term|parcial)\b[\s\S]{0,120}?\b(?:session|sesi[oó]n)\s*(?:#?\s*)?(\d{1,3})\b/gi;
    let m1;
    while ((m1 = re1.exec(combined)) !== null) {
      const num = parseInt(m1[1], 10);
      if (num >= 1 && num <= 200) {
        matchSession = num;
        kind = "explicit_session";
        score = 0.98;
        snippet = m1[0].slice(0, 150);
        allMatches.push({ id, ts, session: num, score, kind, snippet });
        break;
      }
    }

    if (!matchSession) {
      const re2 = /\b(?:session|sesi[oó]n)\s*(?:#?\s*)?(\d{1,3})\b[\s\S]{0,120}?\b(?:midterm|mid-term|parcial)\b/gi;
      let m2;
      while ((m2 = re2.exec(combined)) !== null) {
        const num = parseInt(m2[1], 10);
        if (num >= 1 && num <= 200) {
          matchSession = num;
          kind = "explicit_session";
          score = 0.98;
          snippet = m2[0].slice(0, 150);
          allMatches.push({ id, ts, session: num, score, kind, snippet });
          break;
        }
      }
    }

    if (!matchSession) {
      const midtermIdx = combined.toLowerCase().search(/\b(?:midterm|mid-term|parcial)\b/);
      if (midtermIdx >= 0) {
        const window = combined.slice(Math.max(0, midtermIdx - 40), midtermIdx + 120);
        const sMatch = window.match(/\b(?:S\s*)?(\d{1,3})\b/);
        if (sMatch && Math.abs(sMatch.index - (midtermIdx < 40 ? midtermIdx : 40)) <= 80) {
          const num = parseInt(sMatch[1], 10);
          if (num >= 1 && num <= 200) {
            matchSession = num;
            kind = "weak";
            score = 0.75;
            snippet = window.slice(0, 100);
            allMatches.push({ id, ts, session: num, score, kind, snippet });
          }
        }
      }
    }

    const ordNum = parseOrdinalSession(combined);
    if (!matchSession && ordNum) {
      matchSession = ordNum;
      kind = "weak";
      score = 0.7;
      snippet = combined.slice(0, 100);
      allMatches.push({ id, ts, session: ordNum, score, kind, snippet });
    }
  }

  if (allMatches.length === 0) return defaultResult;

  allMatches.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return (b.ts || "").localeCompare(a.ts || "");
  });

  const best = allMatches[0];
  const rescheduleBest = allMatches.find((x) => x.kind === "reschedule_new");
  const finalMatch = rescheduleBest || best;
  const candidates = [...new Set(allMatches.map((x) => x.session).filter((n) => n >= 1 && n <= 200 && n !== finalMatch.session))].sort((a, b) => a - b);

  const evidence = allMatches
    .filter((x) => x.session === finalMatch.session)
    .slice(0, 3)
    .map((x) => ({ id: x.id, createdAt: x.ts, text: x.snippet, signal: x.kind === "reschedule_new" ? "reschedule" : x.kind === "explicit_session" ? "explicit_session" : "weak" }));

  return {
    midterm_session: finalMatch.session,
    midterm_date: null,
    midterm_time: null,
    timezone: null,
    date_candidates: [],
    date_confidence: 0,
    candidates,
    confidence: finalMatch.score,
    reason: rescheduleBest ? "Reschedule statement found: midterm moved to session " + finalMatch.session + "." : "Announcement explicitly states midterm in session " + finalMatch.session + ".",
    evidence,
    all_matches: allMatches.slice(0, 5)
  };
}

/**
 * Extract midterm info from course messages (direct messages / inbox).
 * @param {Array<{id?:string, senderName?:string, subject?:string, body?:string, createdAt?:string, updatedAt?:string}>} messages
 * @returns {Object} message_result
 */
export function extractMidtermFromMessages(messages) {
  const defaultResult = {
    midterm_session: null,
    midterm_date: null,
    midterm_time: null,
    timezone: null,
    candidates: [],
    date_candidates: [],
    confidence: 0,
    date_confidence: 0,
    reason: "No midterm found in messages.",
    evidence: [],
    all_matches: []
  };

  if (!Array.isArray(messages) || messages.length === 0) return defaultResult;

  const midtermRe = /\bmid[-\s]?term\b|parcial|intermediate\s+exam/i;
  const sessionRe = /\b(?:session|sesi[oó]n|ses\.?)\s*(?:#?\s*)?(\d{1,3})\b|(?:\bS\s*(\d{1,3})\b)/gi;

  const allMatches = [];
  const dateCandidates = [];

  const datePatterns = [
    /\b(\d{4}-\d{2}-\d{2})\b/,
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(20\d{2}))?/gi,
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s*,?\s*(20\d{2}))?/gi,
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
    /\b(tuesday|monday|wednesday|thursday|friday|saturday|sunday)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(20\d{2}))?/gi
  ];

  const timePattern = /(\d{1,2})\s*[.:]\s*(\d{2})\s*(am|pm)?|(\d{1,2})\s*(am|pm)\b/gi;

  const reschedulePatterns = [
    /\b(?:moved|move)\b[\s\S]{0,80}?\bfrom\b[\s\S]{0,60}?\b(?:march|mar|jan|feb|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})[\s\S]{0,40}?\bto\b[\s\S]{0,60}?((?:march|mar|jan|feb|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/gi,
    /\breschedul(?:ed|ing)\b[\s\S]{0,80}?\bto\b[\s\S]{0,60}?((?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\s*(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}(?:st|nd|rd|th)?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/gi,
    /\bchanged\b[\s\S]{0,80}?\bto\b[\s\S]{0,60}?((?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\s*(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}(?:st|nd|rd|th)?|\d{4}-\d{2}-\d{2})/gi,
    /\bconfirm\b[\s\S]{0,60}?\bmid[-\s]?term\b[\s\S]{0,80}?\b(?:on|for)\b[\s\S]{0,80}?((?:tuesday|monday|wednesday|thursday|friday)\s+(?:march|mar|jan|feb|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}(?:st|nd|rd|th)?)/gi
  ];

  const heldOnPattern = /\bmid[-\s]?term\b[\s\S]{0,60}?\b(?:will\s+be\s+)?(?:held|scheduled)\s+(?:on|for)\b[\s\S]{0,100}?((?:tuesday|monday|wednesday|thursday|friday)\s+(?:march|mar|jan|feb|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+at\s+[\d.:\s]*(?:am|pm)?)?)/gi;

  for (const msg of messages) {
    const id = msg.id ?? msg.messageId ?? "";
    const ts = msg.updatedAt ?? msg.createdAt ?? msg.postDateISO ?? "";
    const body = (msg.body ?? msg.textPlain ?? "").trim();
    const combined = body;

    if (!midtermRe.test(combined)) continue;

    let matchSession = null;
    let matchDate = null;
    let matchTime = null;
    let kind = "weak";
    let score = 0.5;
    let snippet = "";
    let dateKind = "weak";

    if (/\bmidterm\s+review\b/i.test(combined) && !/\bmid[-\s]?term\s+(?:exam|will|held|scheduled)/i.test(combined)) {
      score = 0.4;
      kind = "weak";
    }

    for (const rp of reschedulePatterns) {
      const re = new RegExp(rp.source, rp.flags);
      const m = re.exec(combined);
      if (m && m[1]) {
        const dateStr = m[1];
        const parsedDate = parseDateToYYYYMMDD(dateStr.trim(), ts);
        if (parsedDate) {
          const timeM = combined.match(timePattern);
          matchTime = timeM ? parseTimeToHHMM(timeM[0]) : null;
          matchDate = parsedDate;
          kind = "reschedule_new";
          dateKind = "reschedule_new";
          score = 0.99;
          snippet = m[0].slice(0, 200);
          dateCandidates.push({
            date: parsedDate,
            time: matchTime,
            tz: extractTimezone(combined),
            kind: "reschedule_new",
            score: 0.99,
            id,
            ts,
            snippet: snippet.slice(0, 120)
          });
          allMatches.push({ id, ts, session: null, date: parsedDate, time: matchTime, score, kind, snippet });
          break;
        }
      }
    }

    const heldRe = new RegExp(heldOnPattern.source, heldOnPattern.flags);
    const heldMatch = heldRe.exec(combined);
    if (heldMatch && heldMatch[1] && !matchDate) {
      const dateStr = heldMatch[1].trim();
      const parsedDate = parseDateToYYYYMMDD(dateStr.replace(/\s+at\s+[\d.:]+\s*(?:am|pm)?/gi, "").trim(), ts);
      if (parsedDate) {
        const timeM = dateStr.match(/(\d{1,2})\s*[.:]?\s*(\d{0,2})\s*(am|pm)?/i);
        matchTime = timeM ? parseTimeToHHMM(timeM[0]) : null;
        matchDate = parsedDate;
        if (kind !== "reschedule_new") {
          kind = "explicit_date";
          dateKind = "explicit";
          score = 0.98;
          snippet = heldMatch[0].slice(0, 180);
          dateCandidates.push({
            date: parsedDate,
            time: matchTime,
            tz: extractTimezone(combined),
            kind: "explicit",
            score: 0.98,
            id,
            ts,
            snippet: snippet.slice(0, 120)
          });
          allMatches.push({ id, ts, session: null, date: parsedDate, time: matchTime, score, kind, snippet });
        }
      }
    }

    const explicitDateRe = /\bmid[-\s]?term\b[\s\S]{0,80}?\b(?:on|for)\b[\s\S]{0,80}?((?:tuesday|monday|wednesday|thursday|friday)\s+(?:march|mar|jan|feb|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+at\s+[\d.:\s]*(?:am|pm)?)?)/gi;
    let explicitM;
    while ((explicitM = explicitDateRe.exec(combined)) !== null && !matchDate) {
      const dateStr = explicitM[1];
      const parsedDate = parseDateToYYYYMMDD(dateStr.replace(/\s+at\s+[\d.:]+\s*(?:am|pm)?/gi, "").trim(), ts);
      if (parsedDate) {
        const timeM = dateStr.match(/(\d{1,2})\s*[.:]?\s*(\d{0,2})\s*(am|pm)?/i);
        matchTime = timeM ? parseTimeToHHMM(timeM[0]) : null;
        matchDate = parsedDate;
        if (kind !== "reschedule_new") {
          kind = "explicit_date";
          dateKind = "explicit";
          score = 0.98;
          snippet = explicitM[0].slice(0, 180);
          dateCandidates.push({
            date: parsedDate,
            time: matchTime,
            tz: extractTimezone(combined),
            kind: "explicit",
            score: 0.98,
            id,
            ts,
            snippet: snippet.slice(0, 120)
          });
          allMatches.push({ id, ts, session: null, date: parsedDate, time: matchTime, score, kind, snippet });
        }
      }
    }

    const conditionalRe = /\b(?:unless|otherwise)\b[\s\S]{0,80}?(?:will\s+be\s+)?reschedul(?:ed|ing)\s+to\s+((?:tuesday|monday|wednesday|thursday|friday)\s+(?:march|mar|jan|feb|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+at\s+[\d.:\s]*(?:am|pm)?)?)/gi;
    let condM;
    while ((condM = conditionalRe.exec(combined)) !== null && !matchDate) {
      const dateStr = condM[1];
      const parsedDate = parseDateToYYYYMMDD(dateStr.replace(/\s+at\s+[\d.:]+\s*(?:am|pm)?/gi, "").trim(), ts);
      if (parsedDate) {
        const timeM = dateStr.match(/(\d{1,2})\s*[.:]?\s*(\d{0,2})\s*(am|pm)?/i);
        matchTime = timeM ? parseTimeToHHMM(timeM[0]) : null;
        dateCandidates.push({
          date: parsedDate,
          time: matchTime,
          tz: extractTimezone(combined),
          kind: "conditional",
          score: 0.88,
          id,
          ts,
          snippet: condM[0].slice(0, 120)
        });
        if (!matchDate) {
          matchDate = parsedDate;
          kind = "conditional";
          score = 0.88;
          snippet = condM[0].slice(0, 180);
          allMatches.push({ id, ts, session: null, date: parsedDate, time: matchTime, score: 0.88, kind: "conditional", snippet });
        }
      }
    }

    const sessionRescheduleFromTo = /\b(?:moved|reschedul(?:ed|ing)|changed)\b[\s\S]{0,80}?\bfrom\b[\s\S]{0,40}?\bsession\s*(\d{1,3})\b[\s\S]{0,40}?\bto\b[\s\S]{0,40}?\bsession\s*(\d{1,3})\b/i;
    const sessionRescheduleTo = /\b(?:changed|moved|reschedul(?:ed|ing))\b[\s\S]{0,80}?\bto\b[\s\S]{0,60}?\bsession\s*(\d{1,3})\b/i;
    const sessFromTo = combined.match(sessionRescheduleFromTo);
    if (sessFromTo) {
      matchSession = parseInt(sessFromTo[2], 10);
      kind = "reschedule_new";
      score = 0.99;
      snippet = sessFromTo[0].slice(0, 200);
      allMatches.push({ id, ts, session: matchSession, date: null, time: null, score, kind, snippet });
    }
    const sessTo = !sessFromTo && combined.match(sessionRescheduleTo);
    if (sessTo) {
      matchSession = parseInt(sessTo[1], 10);
      kind = "reschedule_new";
      score = 0.98;
      snippet = sessTo[0].slice(0, 200);
      allMatches.push({ id, ts, session: matchSession, date: null, time: null, score, kind, snippet });
    }

    const re1 = /\b(?:midterm|mid-term|parcial)\b[\s\S]{0,120}?\b(?:session|sesi[oó]n)\s*(?:#?\s*)?(\d{1,3})\b/gi;
    let m1;
    while ((m1 = re1.exec(combined)) !== null && matchSession == null) {
      const num = parseInt(m1[1], 10);
      if (num >= 1 && num <= 200) {
        matchSession = num;
        kind = "explicit_session";
        score = 0.98;
        snippet = m1[0].slice(0, 150);
        allMatches.push({ id, ts, session: num, date: null, time: null, score, kind, snippet });
        break;
      }
    }

    const re2 = /\b(?:session|sesi[oó]n)\s*(?:#?\s*)?(\d{1,3})\b[\s\S]{0,120}?\b(?:midterm|mid-term|parcial)\b/gi;
    let m2;
    while ((m2 = re2.exec(combined)) !== null && matchSession == null) {
      const num = parseInt(m2[1], 10);
      if (num >= 1 && num <= 200) {
        matchSession = num;
        kind = "explicit_session";
        score = 0.98;
        snippet = m2[0].slice(0, 150);
        allMatches.push({ id, ts, session: num, date: null, time: null, score, kind, snippet });
        break;
      }
    }

    const ordNum = parseOrdinalSession(combined);
    if (!matchSession && ordNum) {
      matchSession = ordNum;
      kind = "weak";
      score = 0.7;
      snippet = combined.slice(0, 100);
      allMatches.push({ id, ts, session: ordNum, date: null, time: null, score, kind, snippet });
    }
  }

  if (allMatches.length === 0) return defaultResult;

  allMatches.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return (b.ts || "").localeCompare(a.ts || "");
  });

  dateCandidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return (b.ts || "").localeCompare(a.ts || "");
  });

  const best = allMatches[0];
  const bestDate = dateCandidates[0];
  const rescheduleBest = allMatches.find((x) => x.kind === "reschedule_new");
  const explicitDateBest = allMatches.find((x) => x.kind === "explicit_date");
  const finalMatch = rescheduleBest || explicitDateBest || best;

  const midterm_session = finalMatch.session;
  const midterm_date = finalMatch.date ?? bestDate?.date ?? null;
  const midterm_time = finalMatch.time ?? bestDate?.time ?? null;
  const timezone = bestDate?.tz ?? extractTimezone(best?.snippet ?? "");

  const date_confidence = bestDate?.score ?? (finalMatch.date ? finalMatch.score : 0);
  const session_confidence = finalMatch.session != null ? finalMatch.score : 0;
  const confidence = Math.max(session_confidence, date_confidence);

  const candidates = [...new Set(allMatches.map((x) => x.session).filter((n) => n >= 1 && n <= 200 && n !== midterm_session))].sort((a, b) => a - b);

  const evidence = allMatches
    .filter((x) => (x.session === midterm_session && midterm_session != null) || (x.date === midterm_date && midterm_date != null))
    .slice(0, 3)
    .map((x) => ({
      id: x.id,
      createdAt: x.ts,
      text: x.snippet,
      signal: x.kind === "reschedule_new" ? "reschedule" : x.kind === "explicit_date" ? "explicit_date" : x.kind === "explicit_session" ? "explicit_session" : x.kind === "conditional" ? "conditional" : "weak"
    }));

  const reason = rescheduleBest
    ? "Reschedule in message: " + (midterm_date ? midterm_date + (midterm_time ? " " + midterm_time : "") : "session " + midterm_session)
    : explicitDateBest
      ? "Message confirms midterm on " + (midterm_date || "") + (midterm_time ? " at " + midterm_time : "")
      : "Message states midterm " + (midterm_date ? "on " + midterm_date : "in session " + midterm_session);

  return {
    midterm_session,
    midterm_date,
    midterm_time,
    timezone,
    candidates,
    date_candidates: dateCandidates.slice(0, 5),
    confidence,
    date_confidence,
    reason,
    evidence,
    all_matches: allMatches.slice(0, 5)
  };
}

/**
 * Resolve final midterm from syllabus + announcements + messages. Messages and announcements override syllabus.
 * @param {string} syllabus_raw_text
 * @param {Array} announcements - [{ id, title, body/bodyText, createdAt, updatedAt }]
 * @param {Array} messages - [{ id, senderName, body, createdAt, updatedAt }] (optional)
 * @returns {Object} final resolution
 */
export function resolveMidtermSession(syllabus_raw_text, announcements, messages) {
  const syllabus_result = detectMidtermSession(syllabus_raw_text || "");
  const announcement_result = extractMidtermFromAnnouncements(announcements || []);
  const message_result = extractMidtermFromMessages(messages || []);

  const mapEvidence = (arr, src) => (arr || []).map((e) => ({ source: src, id: e.id ?? null, createdAt: e.createdAt ?? null, text: e.text ?? e.snippet ?? "", start: e.start ?? null, end: e.end ?? null }));
  const syllabusEvidence = (syllabus_result.evidence || []).map((e) => ({ source: "syllabus", id: null, createdAt: null, text: e.text, start: e.start, end: e.end }));

  const defaultFinal = {
    midterm_session: null,
    midterm_date: null,
    midterm_time: null,
    timezone: null,
    candidates: [],
    source: "none",
    reason: "No midterm session identified.",
    confidence: 0,
    evidence: [],
    debug: { syllabus_result, announcement_result, message_result, resolution_rule: "none" }
  };

  const msgReschedule = (message_result.all_matches || []).some((x) => x.kind === "reschedule_new");
  const annReschedule = (announcement_result.all_matches || []).some((x) => x.kind === "reschedule_new");
  const msgConf = message_result.confidence ?? 0;
  const annConf = announcement_result.confidence ?? 0;
  const msgDateConf = message_result.date_confidence ?? 0;
  const msgSession = message_result.midterm_session;
  const msgDate = message_result.midterm_date;
  const msgTime = message_result.midterm_time;
  const msgTz = message_result.timezone;
  const annSession = announcement_result.midterm_session;

  const getMsgTs = () => (message_result.evidence?.[0] || message_result.all_matches?.[0])?.createdAt ?? (message_result.all_matches?.[0])?.ts ?? "";
  const getAnnTs = () => (announcement_result.evidence?.[0] || announcement_result.all_matches?.[0])?.createdAt ?? (announcement_result.all_matches?.[0])?.ts ?? "";

  if (msgReschedule && (msgSession != null || msgDate != null) && msgConf >= 0.85) {
    const msgEvidence = mapEvidence(message_result.evidence || [], "message");
    return {
      midterm_session: msgSession,
      midterm_date: msgDate,
      midterm_time: msgTime,
      timezone: msgTz,
      candidates: message_result.candidates || [],
      source: "message",
      reason: "Message reschedule overrides all: " + (message_result.reason || ""),
      confidence: Math.max(0.99, msgConf),
      evidence: [...msgEvidence, ...syllabusEvidence].slice(0, 5),
      debug: { syllabus_result, announcement_result, message_result, resolution_rule: "message_reschedule_overrides" }
    };
  }

  if (annReschedule && annSession != null && annConf >= 0.85) {
    const annEvidence = mapEvidence(announcement_result.evidence || [], "announcement");
    return {
      midterm_session: annSession,
      midterm_date: null,
      midterm_time: null,
      timezone: null,
      candidates: announcement_result.candidates || [],
      source: "announcement",
      reason: "Announcement reschedule overrides: " + (announcement_result.reason || ""),
      confidence: 0.99,
      evidence: [...annEvidence, ...syllabusEvidence].slice(0, 5),
      debug: { syllabus_result, announcement_result, message_result, resolution_rule: "announcement_reschedule_overrides" }
    };
  }

  const msgAuthoritative = (msgSession != null || msgDate != null) && msgConf >= 0.85;
  const annAuthoritative = annSession != null && annConf >= 0.75;

  if (msgAuthoritative && annAuthoritative) {
    const msgScore = Math.max(msgConf, msgDateConf);
    const msgTs = getMsgTs();
    const annTs = getAnnTs();
    if (msgScore >= annConf - 0.05 || (msgTs && annTs && msgTs > annTs)) {
      const msgEvidence = mapEvidence(message_result.evidence || [], "message");
      return {
        midterm_session: msgSession,
        midterm_date: msgDate,
        midterm_time: msgTime,
        timezone: msgTz,
        candidates: message_result.candidates || [],
        source: "message",
        reason: message_result.reason || "Message indicates midterm.",
        confidence: msgConf,
        evidence: [...msgEvidence, ...syllabusEvidence].slice(0, 5),
        debug: { syllabus_result, announcement_result, message_result, resolution_rule: "message_over_announcement_recency" }
      };
    }
  }

  if (msgAuthoritative) {
    const msgEvidence = mapEvidence(message_result.evidence || [], "message");
    return {
      midterm_session: msgSession,
      midterm_date: msgDate,
      midterm_time: msgTime,
      timezone: msgTz,
      candidates: message_result.candidates || [],
      source: "message",
      reason: message_result.reason || "Message indicates midterm.",
      confidence: msgConf,
      evidence: [...msgEvidence, ...syllabusEvidence].slice(0, 5),
      debug: { syllabus_result, announcement_result, message_result, resolution_rule: "message_overrides_syllabus" }
    };
  }

  if (annSession != null && annConf >= 0.75) {
    const annEvidence = mapEvidence(announcement_result.evidence || [], "announcement");
    return {
      midterm_session: annSession,
      midterm_date: null,
      midterm_time: null,
      timezone: null,
      candidates: announcement_result.candidates || [],
      source: "announcement",
      reason: announcement_result.reason || "Announcement indicates midterm session.",
      confidence: annConf,
      evidence: [...annEvidence, ...syllabusEvidence].slice(0, 5),
      debug: { syllabus_result, announcement_result, message_result, resolution_rule: "announcement_overrides_syllabus" }
    };
  }

  const sylSession = syllabus_result.midterm_session;
  const sylConf = syllabus_result.confidence ?? 0;

  if (sylSession != null && sylConf >= 0.6) {
    let candidates = syllabus_result.candidates || [];
    if (annSession != null && annSession !== sylSession) candidates = [...new Set(candidates.concat(annSession))].filter((n) => n !== sylSession).sort((a, b) => a - b);
    if (msgSession != null && msgSession !== sylSession) candidates = [...new Set(candidates.concat(msgSession))].filter((n) => n !== sylSession).sort((a, b) => a - b);
    return {
      midterm_session: sylSession,
      midterm_date: null,
      midterm_time: null,
      timezone: null,
      candidates,
      source: "syllabus",
      reason: syllabus_result.reason + (annSession != null && annSession !== sylSession ? " (announcement suggested " + annSession + ")" : "") + (msgSession != null && msgSession !== sylSession ? " (message suggested " + msgSession + ")" : ""),
      confidence: sylConf,
      evidence: syllabusEvidence.slice(0, 5),
      debug: { syllabus_result, announcement_result, message_result, resolution_rule: "syllabus_used" }
    };
  }

  if (msgDate != null && msgDateConf >= 0.8) {
    const msgEvidence = mapEvidence(message_result.evidence || [], "message");
    return {
      midterm_session: null,
      midterm_date: msgDate,
      midterm_time: msgTime,
      timezone: msgTz,
      candidates: message_result.candidates || [],
      source: "message",
      reason: message_result.reason || "Message indicates midterm date (no session).",
      confidence: msgDateConf,
      evidence: [...msgEvidence, ...syllabusEvidence].slice(0, 5),
      debug: { syllabus_result, announcement_result, message_result, resolution_rule: "message_date_only" }
    };
  }

  return defaultFinal;
}
