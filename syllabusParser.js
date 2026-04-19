/**
 * syllabusParser.js — Robust syllabus PDF text parser.
 *
 * Handles the common PDF extraction artifact where session headers are clumped
 * together (all headers first, then all content later) due to column-based PDF layout.
 * Detects this pattern and reconstructs correct session-to-content mapping.
 */

// ——————————————————————————————————————————————
// Constants
// ——————————————————————————————————————————————

const SESSION_KW_RE = /^[ \t]*(?:SESSION|SESI[OÓ]N|CLASS|WEEK|LECTURE)\s+#?\s*(\d+)\s*(?:\(([^)]*)\))?/i;
const SESSION_HEADER_LINE_RE = /^[ \t]*(?:SESSION|SESI[OÓ]N|CLASS|WEEK|LECTURE)\s+#?\s*\d+/i;

const SECTION_HEADINGS = [
  "PROGRAM", "PROGRAMME",
  "SUBJECT DESCRIPTION", "COURSE DESCRIPTION",
  "LEARNING OBJECTIVES", "LEARNING OUTCOMES",
  "TEACHING METHODOLOGY",
  "AI POLICY",
  "EVALUATION CRITERIA", "EVALUATION", "ASSESSMENT",
  "ATTENDANCE POLICY",
  "RE-SIT", "RE-TAKE", "RETAKE", "RE-SIT / RE-TAKE POLICY", "RE-SIT/RE-TAKE POLICY",
  "ETHICAL POLICY",
  "BEHAVIOR RULES", "BEHAVIOUR RULES",
  "OFFICE HOURS",
  "BIBLIOGRAPHY", "REFERENCES", "READINGS", "REQUIRED READINGS", "RECOMMENDED READINGS",
  "PROFESSOR", "FACULTY", "INSTRUCTOR"
];

const SECTION_RE = new RegExp(
  "^\\s*(" + SECTION_HEADINGS.map(h => h.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&")).join("|") + ")\\b",
  "i"
);

const FOOTER_RE = /^\s*(\d{1,3}\s*$|Edited by Documentation|^\d{1,2}(st|nd|rd|th)\s+\w+\s+\d{4}\s*$)/i;
const PAGE_NUM_RE = /^\s*\d{1,3}\s*$/;
const DATE_FOOTER_RE = /^\s*\d{1,2}(st|nd|rd|th)\s+\w+\s+\d{4}\s*$/i;

const CLUMP_THRESHOLD_AVG_LINES = 2;
const CLUMP_MIN_HEADERS = 3;

// ——————————————————————————————————————————————
// Input normalization
// ——————————————————————————————————————————————

function normalizeLines(rawText) {
  if (!rawText || typeof rawText !== "string") return [];
  let text = rawText.replace(/<[^>]+>/g, " ");
  return text.split(/\r?\n/).map(l => l.replace(/\t/g, "  ").replace(/ {3,}/g, "  ").trimEnd());
}

function isFooterLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (PAGE_NUM_RE.test(t)) return true;
  if (DATE_FOOTER_RE.test(t)) return true;
  if (/^Edited by Documentation/i.test(t)) return true;
  return false;
}

function stripFooters(lines) {
  return lines.filter(l => !isFooterLine(l));
}

function isSessionHeader(line) {
  return SESSION_KW_RE.test((line || "").trim());
}

function parseSessionHeader(line) {
  const m = (line || "").trim().match(SESSION_KW_RE);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  const modeRaw = (m[2] || "").trim().toLowerCase();
  let mode = null;
  if (/in.?person/i.test(modeRaw)) mode = "live_in_person";
  else if (/online/i.test(modeRaw)) mode = "online";
  else if (/hybrid/i.test(modeRaw)) mode = "hybrid";
  else if (modeRaw) mode = modeRaw;
  return { number: num, mode, rawHeader: line.trim() };
}

function isSectionHeading(line) {
  return SECTION_RE.test((line || "").trim());
}

function getSectionName(line) {
  const m = (line || "").trim().match(SECTION_RE);
  return m ? m[1].toUpperCase() : null;
}

function isMeaningfulLine(line) {
  const t = (line || "").trim();
  return t.length > 0 && !isFooterLine(t);
}

// ——————————————————————————————————————————————
// Section splitting
// ——————————————————————————————————————————————

function splitIntoSections(lines) {
  const sections = [];
  let current = { name: "PREAMBLE", startIdx: 0, lines: [] };

  for (let i = 0; i < lines.length; i++) {
    const secName = getSectionName(lines[i]);
    if (secName) {
      if (current.lines.length > 0 || current.name !== "PREAMBLE") {
        sections.push(current);
      }
      current = { name: secName, startIdx: i, lines: [lines[i]] };
    } else {
      current.lines.push(lines[i]);
    }
  }
  if (current.lines.length > 0) sections.push(current);
  return sections;
}

// ——————————————————————————————————————————————
// PROGRAM section: detect clumping and parse
// ——————————————————————————————————————————————

/**
 * Given the lines of the PROGRAM section, find all session header positions.
 */
function findSessionPositions(lines) {
  const positions = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseSessionHeader(lines[i]);
    if (parsed) positions.push({ ...parsed, lineIdx: i });
  }
  return positions;
}

/**
 * Detect whether session headers are clumped (many in a row with little content between them).
 * Returns true if the average meaningful content lines between consecutive headers is below threshold.
 */
function detectClumping(lines, headerPositions) {
  if (headerPositions.length < CLUMP_MIN_HEADERS) return false;

  let totalContentLines = 0;
  let gaps = 0;
  for (let i = 0; i < headerPositions.length - 1; i++) {
    const startLine = headerPositions[i].lineIdx + 1;
    const endLine = headerPositions[i + 1].lineIdx;
    let meaningful = 0;
    for (let j = startLine; j < endLine; j++) {
      if (isMeaningfulLine(lines[j]) && !isSessionHeader(lines[j])) meaningful++;
    }
    totalContentLines += meaningful;
    gaps++;
  }
  const avg = gaps > 0 ? totalContentLines / gaps : 0;
  return avg < CLUMP_THRESHOLD_AVG_LINES;
}

/**
 * Mode A — Normal sequential: each header owns the content lines until the next header.
 */
function parseNormalMode(lines, headerPositions) {
  const sessions = [];
  for (let i = 0; i < headerPositions.length; i++) {
    const hp = headerPositions[i];
    const startLine = hp.lineIdx + 1;
    const endLine = i + 1 < headerPositions.length
      ? headerPositions[i + 1].lineIdx
      : lines.length;

    const contentLines = [];
    for (let j = startLine; j < endLine; j++) {
      if (isMeaningfulLine(lines[j])) contentLines.push(lines[j].trim());
    }

    const title = contentLines[0] || null;
    const subtopicLines = contentLines.slice(1);

    sessions.push({
      sessionNumber: hp.number,
      title,
      mode: hp.mode,
      topics: title ? [title] : [],
      subtopics: subtopicLines,
      rawText: contentLines.join("\n"),
      needsReview: contentLines.length === 0,
      confidence: contentLines.length > 0 ? 0.9 : 0.3
    });
  }
  return sessions;
}

/**
 * Detect if a line looks like a "topic title" — a short line that starts a new session chunk
 * in the content stream when headers are clumped.
 */
function looksLikeTopicTitle(line, nextLine) {
  const t = (line || "").trim();
  if (!t || t.length < 2) return false;
  if (isSessionHeader(t)) return false;
  if (isSectionHeading(t)) return false;
  if (isFooterLine(t)) return false;
  if (t.length > 120) return false;

  const isAllCapsOrTitleCase = /^[A-ZÁÉÍÓÚÑ\s:,&\-–—/()\d.]+$/.test(t) || /^[A-ZÁÉÍÓÚÑ]/.test(t);
  const endsWithPunctuation = /[.;,]$/.test(t);
  const isShort = t.length <= 80;

  if (isShort && isAllCapsOrTitleCase && !endsWithPunctuation) return true;
  if (/^(?:MID[- ]?TERM|MIDTERM|FINAL)\s/i.test(t)) return true;
  if (/^(?:Project|Review|Exam|Presentation|Introduction|Lab)/i.test(t)) return true;

  if (isShort && !endsWithPunctuation && nextLine) {
    const nt = (nextLine || "").trim();
    if (nt && (nt.length > t.length || /^[a-záéíóú]/.test(nt) || /^[-•]/.test(nt))) return true;
  }

  return false;
}

/**
 * Mode B — Clumped headers: session headers are grouped, content follows after.
 * Extracts the content stream and splits it into chunks, then aligns to headers by order.
 */
function parseClumpedMode(lines, headerPositions) {
  const headerBlockEnd = findHeaderBlockEnd(lines, headerPositions);
  const contentStreamEnd = findContentStreamEnd(lines, headerBlockEnd);

  const contentLines = [];
  for (let i = headerBlockEnd; i < contentStreamEnd; i++) {
    if (!isSessionHeader(lines[i]) && !isFooterLine(lines[i])) {
      contentLines.push({ text: lines[i].trim(), origIdx: i });
    }
  }

  const chunks = splitContentIntoChunks(contentLines, headerPositions.length);

  const sessions = [];
  for (let i = 0; i < headerPositions.length; i++) {
    const hp = headerPositions[i];
    const chunk = i < chunks.length ? chunks[i] : null;
    const chunkLines = chunk ? chunk.map(c => c.text).filter(t => t.length > 0) : [];

    const title = chunkLines[0] || null;
    const subtopicLines = chunkLines.slice(1);

    const isEmpty = chunkLines.length === 0;
    const isSuspicious = chunkLines.length <= 1 && i < headerPositions.length - 1;

    sessions.push({
      sessionNumber: hp.number,
      title,
      mode: hp.mode,
      topics: title ? [title] : [],
      subtopics: subtopicLines,
      rawText: chunkLines.join("\n"),
      needsReview: isEmpty || isSuspicious,
      confidence: isEmpty ? 0.2 : isSuspicious ? 0.6 : 0.85
    });
  }
  return sessions;
}

/**
 * Find where the header block ends: the first non-header, non-empty line after the first header.
 */
function findHeaderBlockEnd(lines, headerPositions) {
  if (headerPositions.length === 0) return 0;
  const lastHeaderIdx = headerPositions[headerPositions.length - 1].lineIdx;
  for (let i = lastHeaderIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t && !isSessionHeader(lines[i]) && !isFooterLine(lines[i])) return i;
  }
  return lastHeaderIdx + 1;
}

/**
 * Find where content stream ends: at the next major section heading or end of lines.
 */
function findContentStreamEnd(lines, startIdx) {
  for (let i = startIdx; i < lines.length; i++) {
    const name = getSectionName(lines[i]);
    if (name && name !== "PROGRAM" && name !== "PROGRAMME") return i;
  }
  return lines.length;
}

/**
 * Split a content stream into exactly N chunks (one per session header).
 * Uses equal split by line count so every session gets content; no empty chunks.
 * Optionally refines boundaries at topic-title lines when we have enough of them.
 */
function splitContentIntoChunks(contentLines, targetCount) {
  if (contentLines.length === 0) return [];
  if (targetCount <= 1) return [contentLines];

  const N = contentLines.length;
  const K = Math.min(targetCount, N);

  // Build boundaries so we get exactly K chunks, each with at least one line.
  const boundaries = [0];
  for (let i = 1; i < K; i++) {
    boundaries.push(Math.floor((i * N) / K));
  }
  boundaries.sort((a, b) => a - b);

  // Optional: nudge boundaries to topic-title lines so we don't cut mid-topic.
  for (let i = 1; i < boundaries.length; i++) {
    const ideal = boundaries[i];
    const prev = boundaries[i - 1];
    const maxBack = Math.max(prev + 1, ideal - 5);
    const maxFwd = Math.min(ideal + 5, N - 1);
    let best = ideal;
    let bestScore = -1;
    for (let j = maxBack; j <= maxFwd; j++) {
      if (j >= N) continue;
      const line = contentLines[j]?.text || "";
      const nextLine = contentLines[j + 1]?.text || "";
      if (looksLikeTopicTitle(line, nextLine)) {
        const score = Math.abs(j - ideal);
        if (bestScore === -1 || score < bestScore) {
          bestScore = score;
          best = j;
        }
      }
    }
    boundaries[i] = Math.max(prev + 1, Math.min(best, N - 1));
  }

  const chunks = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : N;
    chunks.push(contentLines.slice(start, end));
  }
  return chunks;
}

// ——————————————————————————————————————————————
// Iterative PROGRAM parsing (handles multi-page header blocks)
// ——————————————————————————————————————————————

function parseProgramSection(programLines) {
  const allHeaderPositions = findSessionPositions(programLines);
  if (allHeaderPositions.length === 0) return { sessions: [], mode: "no_sessions" };

  let allSessions = [];
  let overallMode = "normal";
  let processed = 0;
  let searchFrom = 0;

  while (processed < allHeaderPositions.length) {
    const remaining = allHeaderPositions.slice(processed);
    const blockHeaders = [];
    let blockStart = remaining[0].lineIdx;

    for (let i = 0; i < remaining.length; i++) {
      blockHeaders.push(remaining[i]);
      const nextIdx = i + 1 < remaining.length ? remaining[i + 1].lineIdx : programLines.length;
      let contentBetween = 0;
      for (let j = remaining[i].lineIdx + 1; j < nextIdx; j++) {
        if (isMeaningfulLine(programLines[j]) && !isSessionHeader(programLines[j])) contentBetween++;
      }
      if (contentBetween >= CLUMP_THRESHOLD_AVG_LINES && i < remaining.length - 1) {
        break;
      }
    }

    const isClumped = detectClumping(programLines, blockHeaders);

    let sessions;
    if (isClumped) {
      overallMode = overallMode === "normal" ? "clumped" : "mixed";
      sessions = parseClumpedMode(programLines, blockHeaders);
    } else {
      sessions = parseNormalMode(programLines, blockHeaders);
    }
    allSessions = allSessions.concat(sessions);
    processed += blockHeaders.length;
  }

  allSessions.sort((a, b) => a.sessionNumber - b.sessionNumber);

  return { sessions: allSessions, mode: overallMode };
}

// ——————————————————————————————————————————————
// Top-level parse function
// ——————————————————————————————————————————————

/**
 * Parse extracted PDF text into a structured syllabus object.
 * Handles both normal and clumped-header patterns.
 *
 * @param {string} rawText - The raw text extracted from the PDF.
 * @param {{ courseId?: string }} options
 * @returns {ParsedSyllabus}
 */
export function parseSyllabusFromText(rawText, options = {}) {
  const courseId = options.courseId || "";
  const warnings = [];

  if (!rawText || typeof rawText !== "string" || rawText.trim().length < 50) {
    return {
      courseId,
      sections: [],
      sessions: [],
      raw: { rawText: rawText || "", linearizedText: "" },
      diagnostics: { programParsingMode: "none", detectedHeaderBlocks: 0, warnings: ["Text too short or empty."] }
    };
  }

  const rawLines = normalizeLines(rawText);
  const cleanLines = stripFooters(rawLines);
  const linearizedText = cleanLines.join("\n");

  const allSections = splitIntoSections(cleanLines);

  const sectionOutput = [];
  let programSection = null;

  for (const sec of allSections) {
    const secName = sec.name;
    const secText = sec.lines.join("\n").trim();
    if (/^PROGRAM/i.test(secName)) {
      programSection = sec;
    }
    sectionOutput.push({ name: secName, text: secText });
  }

  let sessions = [];
  let programParsingMode = "none";
  let detectedHeaderBlocks = 0;

  if (programSection) {
    const result = parseProgramSection(programSection.lines);
    sessions = result.sessions;
    programParsingMode = result.mode;
    detectedHeaderBlocks = result.mode === "no_sessions" ? 0 : 1;

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      if (s.rawText.length === 0) {
        warnings.push("Session " + s.sessionNumber + " has no content.");
      }
      if (i > 0 && sessions[i - 1].rawText === s.rawText && s.rawText.length > 5) {
        warnings.push("Sessions " + sessions[i - 1].sessionNumber + " and " + s.sessionNumber + " have identical content.");
        s.needsReview = true;
        sessions[i - 1].needsReview = true;
      }
    }
  } else {
    const allLines = cleanLines;
    const headerPositions = findSessionPositions(allLines);
    if (headerPositions.length > 0) {
      const isClumped = detectClumping(allLines, headerPositions);
      if (isClumped) {
        sessions = parseClumpedMode(allLines, headerPositions);
        programParsingMode = "clumped";
      } else {
        sessions = parseNormalMode(allLines, headerPositions);
        programParsingMode = "normal";
      }
      detectedHeaderBlocks = 1;
    } else {
      warnings.push("No session headers found in document.");
      programParsingMode = "no_sessions";
    }
  }

  return {
    courseId,
    sections: sectionOutput,
    sessions,
    raw: { rawText, linearizedText },
    diagnostics: { programParsingMode, detectedHeaderBlocks, warnings }
  };
}

/**
 * Convert the parsed syllabus into the structured format expected by the rest of the extension
 * (same shape as parseSyllabusHtml from syllabusIntelligence.js).
 *
 * @param {ReturnType<parseSyllabusFromText>} parsed
 * @param {string} [courseTitle]
 * @returns {{ rawText: string, courseTitle: string, sessions: Array, evaluation: Array, bibliography: Array, policies: Array }}
 */
export function toStructuredFormat(parsed, courseTitle) {
  const sessions = (parsed.sessions || []).map(s => ({
    number: s.sessionNumber,
    title: s.title || "",
    content: s.rawText || ""
  }));

  const evaluation = [];
  const bibliography = [];
  const policies = [];

  for (const sec of parsed.sections || []) {
    const name = (sec.name || "").toUpperCase();
    if (/EVALUATION|ASSESSMENT/.test(name)) {
      evaluation.push({ name: sec.name, weight: "", rawText: sec.text });
    } else if (/BIBLIOGRAPHY|REFERENCES|READINGS/.test(name)) {
      bibliography.push(sec.text);
    } else if (/POLICY|RULES|RE-SIT|RE-TAKE|RETAKE|ATTENDANCE|ETHICAL|BEHAVIOR|BEHAVIOUR/.test(name)) {
      policies.push({ name: sec.name, content: sec.text });
    }
  }

  return {
    rawText: parsed.raw?.linearizedText || parsed.raw?.rawText || "",
    courseTitle: courseTitle || "",
    sessions,
    evaluation,
    bibliography,
    policies
  };
}
