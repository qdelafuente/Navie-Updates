/**
 * finalExamSessionDetector.js — Deterministic algorithm to identify the session number
 * where the FINAL EXAM occurs (syllabus, announcements, messages). Mirrors midtermSessionDetector.
 *
 * @typedef {{ source: "syllabus"|"announcement"|"message"|"calendar"|"none", id?: string|null, createdAt?: string|null, text: string }} FinalEvidence
 * @typedef {{ final_session: number|null, final_date: string|null, final_time: string|null, timezone: string|null, source: string, confidence: number, evidence: FinalEvidence[], debug?: object }} FinalResolution
 */

const SESSION_PATTERNS = [
  /\bSESSION\s+(\d{1,3})\b/gi,
  /\bSESION\s+(\d{1,3})\b/gi,
  /\bSession\s+(\d{1,3})\s*[:\-\)]/gi,
  /\bSESSION\s*(\d{1,3})\s*\([^)]*\)/gi,
  /\bSESSION\s*(\d{1,3})\s*\[[^\]]*\]/gi,
  /^\s*(\d{1,3})\)\s*(?:SESSION|Session|SESIÓN)\s+/gim,
  /\b(?:Week|Semana|Class|Clase)\s+(\d{1,3})\b/gi,
  /\bSES\.?\s*(\d{1,3})\b/gi
];

const FINAL_EXAM_KEYWORDS = [
  // English
  "final exam",
  "final examination",
  "final test",
  "final assessment",
  // Spanish
  "examen final",
  "examen de fin",
  "prueba final",
  "evaluación final",
  "evaluacion final",
  "test final",
  "exámen final",
  "exam final"
];

const FINAL_NEGATIVE_KEYWORDS = [
  "final project",
  "final presentation",
  "final presentations",
  "final report",
  "final paper",
  "final submission",
  "final version",
  "final grade",
  "final review",
  "review for the final",
  "course review",
  // Spanish negatives
  "proyecto final",
  "presentación final",
  "presentacion final",
  "entrega final",
  "trabajo final"
];

const FINAL_EXAM_REGEX = /\bFINAL\s+(EXAM|EXAMINATION|TEST|ASSESSMENT)\b|\bEXAMEN\s+FINAL\b|\bPRUEBA\s+FINAL\b|\bEVALUACI[OÓ]N\s+FINAL\b|\bTEST\s+FINAL\b/i;
const FINAL_NEGATIVE_REGEX = /\bFINAL\s+(PROJECT|PRESENTATION|PRESENTATIONS|REPORT|PAPER)\b|\bPROYECTO\s+FINAL\b|\bPRESENTACI[OÓ]N\s+FINAL\b|\bENTREGA\s+FINAL\b|\bTRABAJO\s+FINAL\b/i;
const REVIEW_FINAL_REGEX = /\b(REVIEW|REVISION|REPASO)\b[\s\S]{0,60}?\b(FINAL\s+EXAM|EXAMEN\s+FINAL)\b/i;

function normalizeText(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/&nbsp;|&\s*times;|&#\d+;/gi, " ")
    .replace(/ +/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Dedupe only when the same logical heading is matched by multiple patterns (overlap or within 5 chars).
const DEDUPE_POSITION_THRESHOLD = 5;

function findSessionHeadings(text) {
  const headings = [];
  const seenByPos = new Map(); // start index -> num (dedupe same heading, keep distinct sessions)
  for (const re of SESSION_PATTERNS) {
    const pattern = new RegExp(re.source, re.flags);
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const num = parseInt(m[1], 10);
      if (isNaN(num) || num < 1 || num > 200) continue;
      const pos = m.index;
      const existing = [...seenByPos.entries()].find(([s]) => Math.abs(s - pos) <= DEDUPE_POSITION_THRESHOLD);
      if (existing) continue; // same heading matched by another pattern
      seenByPos.set(pos, num);
      headings.push({ num, start: pos, end: pos + m[0].length, heading: m[0] });
    }
  }
  return headings.sort((a, b) => a.start - b.start);
}

function buildSessions(text, headings) {
  const sessions = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const contentEnd = i + 1 < headings.length ? headings[i + 1].start : text.length;
    const contentStart = h.end;
    const content = text.slice(contentStart, contentEnd);
    sessions.push({
      num: h.num,
      headingStart: h.start,
      headingEnd: h.end,
      contentStart,
      contentEnd,
      heading: text.slice(h.start, h.end),
      content,
      fullBlock: text.slice(h.start, contentEnd),
      fullStart: h.start,
      fullEnd: contentEnd
    });
  }
  return sessions;
}

function containsKeyword(text, keywords) {
  const lower = (text || "").toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

function extractEvidenceSnippet(text, start, end, maxLen = 350) {
  const snippet = text.slice(Math.max(0, start), Math.min(text.length, end));
  const trimmed = snippet.length > maxLen ? snippet.slice(0, maxLen) + "…" : snippet;
  return { text: trimmed.replace(/\n/g, " ").trim(), start, end };
}

function scoreSessionBlock(session, text, numberOfSessions) {
  const block = session.heading + " " + session.content.slice(0, 200);
  const blockUpper = block.toUpperCase();
  const reasons = [];
  let score = 0;

  if (FINAL_NEGATIVE_REGEX.test(block) || containsKeyword(block, FINAL_NEGATIVE_KEYWORDS)) {
    score -= 10;
    reasons.push("negative: final project/presentation/report");
  }
  if (REVIEW_FINAL_REGEX.test(block)) {
    score -= 8;
    reasons.push("review session for final exam");
  }
  const examInTitleOrFirst200 = block.slice(0, 200).match(FINAL_EXAM_REGEX);
  if (examInTitleOrFirst200) {
    score += 10;
    reasons.push("FINAL EXAM in title/first 200 chars");
  } else if (FINAL_EXAM_REGEX.test(block)) {
    score += 7;
    reasons.push("FINAL EXAM elsewhere in block");
  }
  const headerLike = (session.heading + " " + session.content.slice(0, 80)).match(FINAL_EXAM_REGEX);
  if (headerLike) {
    score += 3;
    reasons.push("header-like match");
  }
  if (numberOfSessions != null && session.num >= numberOfSessions * 0.8) {
    score += 2;
    reasons.push("in last 20% of sessions");
  }
  return { score, reasons, matchType: examInTitleOrFirst200 ? "title_or_first200" : "block" };
}

function parseNumberOfSessions(text) {
  const m = text.match(/\b(?:number\s+of\s+)?sessions?\s*[:\s]*(\d{1,3})\b/i)
    || text.match(/\b(\d{1,3})\s*sessions?\b/i);
  return m ? parseInt(m[1], 10) : null;
}

function findLastSessionFinalMention(text) {
  const lastSessionRe = /(?:final\s+exam|final\s+examination|examen\s+final|prueba\s+final)\s+(?:will\s+be\s+)?(?:taken\s+)?(?:in\s+)?(?:the\s+)?(?:last|[uú]ltim[ao])\s+session/i;
  const m = text.match(lastSessionRe);
  return !!m;
}

/**
 * Syllabus-only: resolve final exam session from raw syllabus text.
 * @param {string} syllabusRawText
 * @returns {FinalResolution}
 */
export function resolveFinalFromSyllabus(syllabusRawText) {
  const defaultResult = {
    final_session: null,
    final_date: null,
    final_time: null,
    timezone: null,
    source: "none",
    confidence: 0,
    evidence: [],
    debug: { candidates: [], numberOfSessionsParsed: null }
  };

  if (!syllabusRawText || typeof syllabusRawText !== "string" || syllabusRawText.trim().length < 20) {
    return { ...defaultResult, evidence: [] };
  }

  const text = normalizeText(syllabusRawText);
  const textUpper = text.toUpperCase();
  const numberOfSessions = parseNumberOfSessions(text);
  const evidence = [];

  // Check for explicit final exam session number in structured contexts (JSON/HTML)
  // Pattern: aplStartSession or order or similar fields followed by a number near FINAL EXAM
  const structuredSessionMatch = text.match(
    /\bFINAL\s+(?:EXAM|EXAMINATION|TEST|ASSESSMENT|EXAMEN)\b[\s\S]{0,300}?\b(?:aplStartSession|aplEndSession|"order"|orden)\s*"?\s*:\s*(\d{1,3})\b/i
  ) || text.match(
    /\b(?:aplStartSession|aplEndSession|"order"|orden)\s*"?\s*:\s*(\d{1,3})[\s\S]{0,300}?\bFINAL\s+(?:EXAM|EXAMINATION|TEST|ASSESSMENT|EXAMEN)\b/i
  );

  if (structuredSessionMatch) {
    const sessionNum = parseInt(structuredSessionMatch[1], 10);
    if (sessionNum >= 1 && sessionNum <= 200) {
      const snippet = (text.slice(Math.max(0, structuredSessionMatch.index - 100), structuredSessionMatch.index + 250)).replace(/\n/g, " ").trim();
      evidence.push({ source: "syllabus", text: snippet });
      return {
        final_session: sessionNum,
        final_date: null,
        final_time: null,
        timezone: null,
        source: "syllabus",
        confidence: 0.92,
        evidence,
        debug: { candidates: [{ session: sessionNum, reason: "structured_session_field" }], numberOfSessionsParsed: numberOfSessions }
      };
    }
  }

  const headings = findSessionHeadings(text);
  const sessions = buildSessions(text, headings);

  if (sessions.length === 0) {
    if (findLastSessionFinalMention(text) && numberOfSessions != null && numberOfSessions >= 1 && numberOfSessions <= 200) {
      evidence.push({ source: "syllabus", text: text.slice(0, 400).replace(/\n/g, " ") });
      return {
        final_session: numberOfSessions,
        final_date: null,
        final_time: null,
        timezone: null,
        source: "syllabus",
        confidence: 0.75,
        evidence,
        debug: { candidates: [], numberOfSessionsParsed: numberOfSessions }
      };
    }
    return defaultResult;
  }

  const candidates = [];
  for (const s of sessions) {
    const { score, reasons, matchType } = scoreSessionBlock(s, text, numberOfSessions);
    if (score >= 7) {
      const snippet = (s.heading + " " + s.content.slice(0, 200)).replace(/\n/g, " ").trim();
      candidates.push({ session: s.num, snippet, score, reasons, matchType });
    }
  }

  if (candidates.length === 0) {
    if (findLastSessionFinalMention(text) && numberOfSessions != null && numberOfSessions >= 1 && numberOfSessions <= 200) {
      evidence.push({ source: "syllabus", text: text.slice(0, 400).replace(/\n/g, " ") });
      return {
        final_session: numberOfSessions,
        final_date: null,
        final_time: null,
        timezone: null,
        source: "syllabus",
        confidence: 0.75,
        evidence,
        debug: { candidates: [], numberOfSessionsParsed: numberOfSessions }
      };
    }
    return defaultResult;
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.session - a.session;
  });
  const best = candidates[0];
  const bestSession = sessions.find((ss) => ss.num === best.session);
  if (bestSession) {
    evidence.push({
      source: "syllabus",
      text: extractEvidenceSnippet(text, bestSession.fullStart, bestSession.fullEnd, 350).text
    });
  }
  return {
    final_session: best.session,
    final_date: null,
    final_time: null,
    timezone: null,
    source: "syllabus",
    confidence: best.score >= 10 ? 0.95 : 0.9,
    evidence,
    debug: { candidates, numberOfSessionsParsed: numberOfSessions }
  };
}

// ─── Announcements ───────────────────────────────────────────────────────────

const finalRe = /\bfinal\s+exam\b|\bfinal\s+examination\b|\bfinal\s+test\b/i;
const sessionRe = /\b(?:session|sesi[oó]n|ses\.?)\s*(?:#?\s*)?(\d{1,3})\b|(?:\bS\s*(\d{1,3})\b)/gi;
const rescheduleFromToFinal = /\b(?:moved|reschedul(?:ed|ing)|changed)\b[\s\S]{0,80}?\bfrom\b[\s\S]{0,40}?\bsession\s*(\d{1,3})\b[\s\S]{0,40}?\bto\b[\s\S]{0,40}?\bsession\s*(\d{1,3})\b/i;
const rescheduleToFinal = /\b(?:changed|moved|reschedul(?:ed|ing))\b[\s\S]{0,80}?\bto\b[\s\S]{0,60}?\bsession\s*(\d{1,3})\b/i;

/**
 * @param {Array<{id?:string, title?:string, body?:string, bodyText?:string, createdAt?:string, dateISO?:string}>} announcements
 */
export function extractFinalFromAnnouncements(announcements) {
  const out = {
    final_session: null,
    final_date: null,
    final_time: null,
    timezone: null,
    candidates: [],
    confidence: 0,
    reason: "No final exam session found in announcements.",
    evidence: [],
    all_matches: []
  };
  if (!Array.isArray(announcements) || announcements.length === 0) return out;

  const allMatches = [];
  for (const a of announcements) {
    const combined = ((a.title || "") + "\n" + (a.body || a.bodyText || "")).trim();
    if (!finalRe.test(combined)) continue;
    if (FINAL_NEGATIVE_REGEX.test(combined) && !FINAL_EXAM_REGEX.test(combined)) continue;

    let matchSession = null;
    let score = 0.5;
    let snippet = "";

    const fromTo = combined.match(rescheduleFromToFinal);
    if (fromTo) {
      matchSession = parseInt(fromTo[2], 10);
      score = 0.99;
      snippet = fromTo[0].slice(0, 200);
      allMatches.push({ id: a.id, ts: a.createdAt || a.dateISO, session: matchSession, score, kind: "reschedule_new", snippet });
      continue;
    }
    const toOnly = combined.match(rescheduleToFinal);
    if (toOnly) {
      matchSession = parseInt(toOnly[1], 10);
      score = 0.98;
      snippet = toOnly[0].slice(0, 200);
      allMatches.push({ id: a.id, ts: a.createdAt || a.dateISO, session: matchSession, score, kind: "reschedule_new", snippet });
      continue;
    }

    const re1 = /\bfinal\s+(?:exam|examination|test)\b[\s\S]{0,120}?\b(?:session|sesi[oó]n)\s*(?:#?\s*)?(\d{1,3})\b/gi;
    let m1;
    while ((m1 = re1.exec(combined)) !== null) {
      const num = parseInt(m1[1], 10);
      if (num >= 1 && num <= 200) {
        matchSession = num;
        score = 0.98;
        snippet = m1[0].slice(0, 150);
        allMatches.push({ id: a.id, ts: a.createdAt || a.dateISO, session: num, score, kind: "explicit_session", snippet });
        break;
      }
    }
    if (!matchSession) {
      const re2 = /\b(?:session|sesi[oó]n)\s*(?:#?\s*)?(\d{1,3})\b[\s\S]{0,120}?\bfinal\s+(?:exam|examination|test)\b/gi;
      let m2;
      while ((m2 = re2.exec(combined)) !== null) {
        const num = parseInt(m2[1], 10);
        if (num >= 1 && num <= 200) {
          matchSession = num;
          score = 0.98;
          snippet = m2[0].slice(0, 150);
          allMatches.push({ id: a.id, ts: a.createdAt || a.dateISO, session: num, score, kind: "explicit_session", snippet });
          break;
        }
      }
    }
  }

  if (allMatches.length === 0) return out;
  allMatches.sort((a, b) => (b.score - a.score) || (b.ts || "").localeCompare(a.ts || ""));
  const best = allMatches.find((x) => x.kind === "reschedule_new") || allMatches[0];
  const candidates = [...new Set(allMatches.map((x) => x.session).filter((n) => n >= 1 && n <= 200 && n !== best.session))].sort((a, b) => a - b);
  return {
    final_session: best.session,
    final_date: null,
    final_time: null,
    timezone: null,
    candidates,
    confidence: best.score,
    reason: best.kind === "reschedule_new" ? "Final exam reschedule to session " + best.session + "." : "Announcement states final exam in session " + best.session + ".",
    evidence: allMatches.filter((x) => x.session === best.session).slice(0, 3).map((x) => ({ source: "announcement", id: x.id, createdAt: x.ts, text: x.snippet })),
    all_matches: allMatches.slice(0, 5)
  };
}

/**
 * @param {Array<{id?:string, body?:string, createdAt?:string}>} messages
 */
export function extractFinalFromMessages(messages) {
  const out = {
    final_session: null,
    final_date: null,
    final_time: null,
    timezone: null,
    candidates: [],
    confidence: 0,
    reason: "No final exam found in messages.",
    evidence: [],
    all_matches: []
  };
  if (!Array.isArray(messages) || messages.length === 0) return out;

  const allMatches = [];
  for (const msg of messages) {
    const combined = (msg.body || "").trim();
    if (!finalRe.test(combined)) continue;
    if (FINAL_NEGATIVE_REGEX.test(combined) && !FINAL_EXAM_REGEX.test(combined)) continue;

    let matchSession = null;
    let score = 0.5;
    let snippet = "";

    const fromTo = combined.match(rescheduleFromToFinal);
    if (fromTo) {
      matchSession = parseInt(fromTo[2], 10);
      score = 0.99;
      snippet = fromTo[0].slice(0, 200);
      allMatches.push({ id: msg.id, ts: msg.createdAt, session: matchSession, score, kind: "reschedule_new", snippet });
      continue;
    }
    const toOnly = combined.match(rescheduleToFinal);
    if (toOnly) {
      matchSession = parseInt(toOnly[1], 10);
      score = 0.98;
      snippet = toOnly[0].slice(0, 200);
      allMatches.push({ id: msg.id, ts: msg.createdAt, session: matchSession, score, kind: "reschedule_new", snippet });
      continue;
    }

    const re1 = /\bfinal\s+(?:exam|examination|test)\b[\s\S]{0,120}?\b(?:session|sesi[oó]n)\s*(?:#?\s*)?(\d{1,3})\b/gi;
    let m1;
    while ((m1 = re1.exec(combined)) !== null) {
      const num = parseInt(m1[1], 10);
      if (num >= 1 && num <= 200) {
        matchSession = num;
        score = 0.98;
        snippet = m1[0].slice(0, 150);
        allMatches.push({ id: msg.id, ts: msg.createdAt, session: num, score, kind: "explicit_session", snippet });
        break;
      }
    }
    if (!matchSession) {
      const re2 = /\b(?:session|sesi[oó]n)\s*(?:#?\s*)?(\d{1,3})\b[\s\S]{0,120}?\bfinal\s+(?:exam|examination|test)\b/gi;
      let m2;
      while ((m2 = re2.exec(combined)) !== null) {
        const num = parseInt(m2[1], 10);
        if (num >= 1 && num <= 200) {
          matchSession = num;
          score = 0.98;
          snippet = m2[0].slice(0, 150);
          allMatches.push({ id: msg.id, ts: msg.createdAt, session: num, score, kind: "explicit_session", snippet });
          break;
        }
      }
    }
  }

  if (allMatches.length === 0) return out;
  allMatches.sort((a, b) => (b.score - a.score) || (b.ts || "").localeCompare(a.ts || ""));
  const best = allMatches.find((x) => x.kind === "reschedule_new") || allMatches[0];
  const candidates = [...new Set(allMatches.map((x) => x.session).filter((n) => n >= 1 && n <= 200 && n !== best.session))].sort((a, b) => a - b);
  return {
    final_session: best.session,
    final_date: null,
    final_time: null,
    timezone: null,
    candidates,
    confidence: best.score,
    reason: best.kind === "reschedule_new" ? "Final exam reschedule to session " + best.session + "." : "Message states final exam in session " + best.session + ".",
    evidence: allMatches.filter((x) => x.session === best.session).slice(0, 3).map((x) => ({ source: "message", id: x.id, createdAt: x.ts, text: x.snippet })),
    all_matches: allMatches.slice(0, 5)
  };
}

/**
 * Resolve final exam from syllabus + announcements + messages. Messages override announcements override syllabus.
 * @param {string} syllabus_raw_text
 * @param {Array} announcements
 * @param {Array} messages
 * @returns {Object} { final_session, final_date, final_time, timezone, source, confidence, evidence, debug, candidates, reason }
 */
export function resolveFinalSession(syllabus_raw_text, announcements, messages) {
  const syllabusResult = resolveFinalFromSyllabus(syllabus_raw_text || "");
  const annResult = extractFinalFromAnnouncements(announcements || []);
  const msgResult = extractFinalFromMessages(messages || []);

  const mapEvidence = (arr, src) => (arr || []).map((e) => ({ source: src, id: e.id ?? null, createdAt: e.createdAt ?? null, text: e.text ?? e.snippet ?? "" }));
  const syllabusEvidence = (syllabusResult.evidence || []).map((e) => ({ source: "syllabus", id: null, createdAt: null, text: e.text }));

  const defaultFinal = {
    final_session: null,
    final_date: null,
    final_time: null,
    timezone: null,
    candidates: [],
    source: "none",
    reason: "No final exam session identified.",
    confidence: 0,
    evidence: [],
    debug: { syllabus_result: syllabusResult, announcement_result: annResult, message_result: msgResult }
  };

  const msgSession = msgResult.final_session;
  const annSession = annResult.final_session;
  const sylSession = syllabusResult.final_session;
  const msgReschedule = (msgResult.all_matches || []).some((x) => x.kind === "reschedule_new");
  const annReschedule = (annResult.all_matches || []).some((x) => x.kind === "reschedule_new");

  if (msgReschedule && msgSession != null && msgResult.confidence >= 0.85) {
    return {
      final_session: msgSession,
      final_date: null,
      final_time: null,
      timezone: null,
      candidates: msgResult.candidates || [],
      source: "message",
      reason: "Message reschedule overrides: " + (msgResult.reason || ""),
      confidence: 0.99,
      evidence: [...mapEvidence(msgResult.evidence || [], "message"), ...syllabusEvidence].slice(0, 5),
      debug: { syllabus_result: syllabusResult, announcement_result: annResult, message_result: msgResult, resolution_rule: "message_reschedule" }
    };
  }
  if (annReschedule && annSession != null && annResult.confidence >= 0.85) {
    return {
      final_session: annSession,
      final_date: null,
      final_time: null,
      timezone: null,
      candidates: annResult.candidates || [],
      source: "announcement",
      reason: "Announcement reschedule overrides: " + (annResult.reason || ""),
      confidence: 0.99,
      evidence: [...mapEvidence(annResult.evidence || [], "announcement"), ...syllabusEvidence].slice(0, 5),
      debug: { syllabus_result: syllabusResult, announcement_result: annResult, message_result: msgResult, resolution_rule: "announcement_reschedule" }
    };
  }
  if (msgSession != null && msgResult.confidence >= 0.85) {
    return {
      final_session: msgSession,
      final_date: null,
      final_time: null,
      timezone: null,
      candidates: msgResult.candidates || [],
      source: "message",
      reason: msgResult.reason || "Message states final exam session.",
      confidence: msgResult.confidence,
      evidence: [...mapEvidence(msgResult.evidence || [], "message"), ...syllabusEvidence].slice(0, 5),
      debug: { syllabus_result: syllabusResult, announcement_result: annResult, message_result: msgResult, resolution_rule: "message" }
    };
  }
  if (annSession != null && annResult.confidence >= 0.75) {
    return {
      final_session: annSession,
      final_date: null,
      final_time: null,
      timezone: null,
      candidates: annResult.candidates || [],
      source: "announcement",
      reason: annResult.reason || "Announcement states final exam session.",
      confidence: annResult.confidence,
      evidence: [...mapEvidence(annResult.evidence || [], "announcement"), ...syllabusEvidence].slice(0, 5),
      debug: { syllabus_result: syllabusResult, announcement_result: annResult, message_result: msgResult, resolution_rule: "announcement" }
    };
  }
  if (sylSession != null && syllabusResult.confidence >= 0.7) {
    return {
      final_session: sylSession,
      final_date: null,
      final_time: null,
      timezone: null,
      candidates: syllabusResult.debug?.candidates?.map((c) => c.session) || [],
      source: "syllabus",
      reason: "Syllabus indicates final exam in session " + sylSession + ".",
      confidence: syllabusResult.confidence,
      evidence: syllabusEvidence.slice(0, 5),
      debug: { syllabus_result: syllabusResult, announcement_result: annResult, message_result: msgResult, resolution_rule: "syllabus" }
    };
  }
  return defaultFinal;
}

// --- Usage example ---
// const { resolveFinalFromSyllabus, resolveFinalSession } = require("./finalExamSessionDetector.js");
// const { enrichFinalWithCalendar } = require("./calendarMidtermEnricher.js");
//
// const syllabusText = "PROGRAM\nSESSION 30 Final Exam. Comprehensive.";
// const r = resolveFinalFromSyllabus(syllabusText);
// console.log(r.final_session, r.confidence); // 30, 0.95
//
// const enriched = resolveFinalSession(syllabusText, [], []);
// if (enriched.final_session && calendarClient) {
//   enrichFinalWithCalendar(enriched, calendarClient, { courseId: "...", now: new Date() });
// }
