/**
 * Capa de inteligencia del syllabus: extracción estructurada, búsqueda y respuesta.
 * No modifica el sistema LTI de obtención del HTML.
 */

/**
 * Extraction map for the AI: how to locate and interpret syllabus sections.
 * Prepend this to syllabus context so the model knows where to find course info, faculty, objectives, methodology, AI policy, sessions, evaluation, re-sit, bibliography, and policies.
 */
const SYLLABUS_EXTRACTION_MAP = `SYLLABUS EXTRACTION MAP — Use this to locate and interpret sections in the syllabus content below.

General rules: Ignore head, scripts, CSS, modals, hidden inputs, UI controls. Focus on visible academic content. Prioritize content under clear section headers (e.g. <h1>/<h2>). If a section only references institutional policy, mark "Reference to institutional policy – no additional course-specific content." If a section is missing, say "Not specified." Do not invent information. Preserve original wording when extracting.

1) COURSE IDENTIFICATION (header): Course Title, Area, Degree/Program, Number of sessions, Academic year, Degree course level (FIRST, SECOND…), Credits, Semester, Category (BASIC, ELECTIVE…), Language.

2) FACULTY: Professor name(s), Email(s), Full biography, Office hours policy (including "on request" if applicable). If multiple professors, extract all.

3) SUBJECT DESCRIPTION: Section "SUBJECT DESCRIPTION" — full text (course purpose, structure, content focus, methodology).

4) LEARNING OBJECTIVES: Section "LEARNING OBJECTIVES" — full text; preserve structure (GOAL 1, GOAL 2…) and numbering.

5) TEACHING METHODOLOGY: Section "TEACHING METHODOLOGY" — methodology text, teaching approach, activity table (Learning Activity, Weighting %, Estimated hours, Total workload).

6) AI POLICY: Section "AI POLICY" — full policy, allowed uses, restrictions, consequences for misuse.

7) PROGRAM / SESSIONS: For each session (or grouped): Session number/range, type (e.g. LIVE IN-PERSON), topic/title, full description, sustainability/ESG if present. Materials: type (Book Chapter, Multimedia…), title/reference, source; note hyperlinks. If no materials: "No materials listed."

8) EVALUATION METHOD: Table — for each component: Name (e.g. Final Exam, Group Work, Participation), Percentage, Description, linked objectives if readable. Preserve percentage distribution.

9) RE-SIT / RE-TAKE POLICY: Full policy text, attendance impact, grade caps, call limitations, conditions for retakers.

10) BIBLIOGRAPHY: Compulsory and Recommended — Author(s), Year, Title, Edition, Publisher, ISBN, Format (Printed/Digital). Also external links (e.g. IE Library, Buy your Books).

11) POLICIES: BEHAVIOR RULES, ATTENDANCE POLICY, ETHICAL POLICY — course-specific text if provided; if only institutional link: "Institutional policy reference only."

Output structure when answering: Course Information | Faculty | Subject Description | Learning Objectives | Teaching Methodology | AI Policy | Program (Sessions) | Evaluation Method | Re-sit Policy | Bibliography | Policies. If a section is missing, state "Not specified."
---`;

function stripHtmlTags(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

function extractTextFromHtml(html) {
  if (!html || typeof html !== "string") return "";
  let stripped = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  stripped = stripped.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  stripped = stripped.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
  return stripHtmlTags(stripped);
}

/** JS/CSS/UI leaked into plain text (LTI pages often bundle scripts). */
function looksLikeWebOrCodeArtifact(text) {
  if (!text || typeof text !== "string" || text.length < 40) return false;
  const t = text.slice(0, 4000);
  if (
    /function\s*\(|\.size\(\)|\/\*[\s\S]{15,}\*\/|var\s+\w+\s*=|let\s+\w+\s*=|-->|\baddEventListener\b|document\.|window\.|chrome\.|\bfor\s*\([^)]*\)\s*\{|\bloop\b.*\biteration\b|\bProgram\s+IE\s+Knowledge\b|Cerrar\s*-->|\/\*[\s\S]*?Sergio/i.test(t)
  ) {
    return true;
  }
  const badTokens = (t.match(/\b(?:function|var|let|const)\b/g) || []).length;
  return badTokens >= 3;
}

function sanitizeSyllabusPlainText(raw) {
  if (!raw || raw.length < 30) return raw;
  let t = raw.replace(/\/\*[\s\S]*?\*\//g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** h1/h2 that are section labels, not the course name (IE syllabi). */
function isSectionHeadingNotCourseName(t) {
  const s = (t || "").trim();
  if (s.length < 3) return true;
  return (
    /^(SUBJECT\s+DESCRIPTION|LEARNING\s+OBJECTIVES|TEACHING\s+METHODOLOGY|AI\s+POLICY|EVALUATION\s+METHOD|BIBLIOGRAPHY|PROGRAM|SYLLABUS|COURSE\s+INFORMATION|FACULTY|POLICIES|ATTENDANCE(\s+POLICY)?|BEHAVIOR\s+RULES|ETHICAL\s+POLICY|RE-?SIT|CONTENTS?|OVERVIEW|INTRODUCTION)$/i.test(
      s
    ) ||
    /^(WEEK|SESSION|SESIÓN|TEMA)\s*\d*$/i.test(s) ||
    /^PROFESSOR|^FACULTY|^INSTRUCTOR|^BIO\b/i.test(s) ||
    /^insert\s+title\s+here$/i.test(s) ||
    /^lorem\s+ipsum/i.test(s)
  );
}

function sliceSessionBlockFromIndex(head, startIdx, sessionNum) {
  const n = sessionNum;
  const fromStart = head.slice(startIdx);
  const nextHdr = fromStart.slice(1).search(
    new RegExp(
      `(?:^|[\\n\\r\\u2028\\u2029])[\\s]*(?:Session|SESSION|Sesión|SESIÓN|Ses\\.?|Class|Lesson|Module|Topic|TEMA|Week|WEEK|Semana)\\s*(?!${n}\\b)(\\d{1,2})\\b`,
      "im"
    )
  );
  const maxLen = 8000;
  if (nextHdr < 0) return fromStart.slice(0, maxLen).trim();
  return fromStart.slice(0, Math.min(1 + nextHdr, maxLen)).trim();
}

/**
 * If the syllabus uses "Ses. 27", tables, or "27)" lines instead of "Session 27".
 */
function extractSessionBlockFromRawText(rawText, sessionNum) {
  if (!rawText || sessionNum == null || sessionNum < 1) return "";
  const n = sessionNum;
  const head = rawText;

  let startIdx = -1;
  const patterns = [
    new RegExp(
      `(?:^|[\\n\\r\\u2028\\u2029])[\\s]*(?:Session|SESSION|Sesión|SESIÓN|Topic|TEMA|Week|WEEK|Semana)\\s*${n}\\b`,
      "im"
    ),
    new RegExp(`\\b(?:Session|SESSION|Sesión|SESIÓN|Topic|TEMA|Week|WEEK|Semana)\\s*${n}\\b`, "i"),
    new RegExp(`\\b(?:Session|Sesión|SESSION)\\s*${n}\\s*[\\:\\-\\—\\.\\)\\]]`, "i"),
    new RegExp(`\\bSes\\.?\\s*${n}\\b`, "i"),
    new RegExp(`\\b(?:Class|Lesson|Module|Unit)\\s*${n}\\b`, "i"),
    new RegExp(`\\bS\\s*${n}(?=\\s*[\\:\\-\\—\\.\\)])`, "i"),
    new RegExp(`(?:^|[\\n\\r])[\\s]*${n}\\s*[\\.\\)\\:\\-—–]\\s+\\S`, "m"),
    new RegExp(`\\(\\s*${n}\\s*\\)\\s*[A-Za-zÁÉÍÓÚÑáéíóúñ]`, "m"),
    new RegExp(`\\bLIVE\\s+[^\\n]{0,40}\\b${n}\\b`, "i")
  ];
  for (const re of patterns) {
    const m = head.match(re);
    if (m && m.index != null) {
      startIdx = m.index;
      break;
    }
  }

  if (startIdx >= 0) {
    const block = sliceSessionBlockFromIndex(head, startIdx, n);
    if (!looksLikeWebOrCodeArtifact(block)) return block;
  }

  const fuzzy = extractSessionBlockFuzzyFallback(head, n);
  if (fuzzy.length >= 25 && !looksLikeWebOrCodeArtifact(fuzzy)) return fuzzy;

  return extractSessionAggressive(head, n);
}

/**
 * Last resort: find session number near program/session vocabulary (tables, odd formatting).
 */
function extractSessionBlockFuzzyFallback(rawText, sessionNum) {
  const n = sessionNum;
  const re = new RegExp(`\\b${n}\\b`, "g");
  const ctxOk =
    /\b(?:session|sesi[oó]n|ses\.|week|semana|class|lesson|tema|topic|module|live|contenid|material|reading|bibliograph|schedule|calend|outline)\b|(?:^|[\s])(?:program|programme)\b/i;
  let m;
  let best = "";
  while ((m = re.exec(rawText)) !== null) {
    const i = m.index;
    const extended = rawText.slice(Math.max(0, i - 220), Math.min(rawText.length, i + 220));
    if (!ctxOk.test(extended)) {
      const probe = rawText.slice(Math.max(0, i - 40), Math.min(rawText.length, i + 45));
      const programLine = new RegExp(
        `(?:^|[\\n\\r\\u2028\\u2029])[\\s]*${n}\\s*[\\.\\)\\:\\-—–]\\s+\\S`
      ).test(probe);
      if (!programLine) continue;
    }
    const block = rawText.slice(Math.max(0, i - 100), Math.min(rawText.length, i + 7500)).trim();
    if (looksLikeWebOrCodeArtifact(block)) continue;
    if (block.length > best.length) best = block;
  }
  return best.length >= 25 ? best : "";
}

/**
 * Last resort: extra patterns (compressed HTML, tables) + scored windows around \\bN\\b.
 */
function extractSessionAggressive(rawText, sessionNum) {
  if (!rawText || sessionNum == null || sessionNum < 1) return "";
  const n = sessionNum;
  const ns = String(n);
  const head = rawText.length > 180000 ? rawText.slice(0, 180000) : rawText;

  const extraPatterns = [
    new RegExp(`\\bSession\\s*${ns}\\s*[\\:\\-\\—\\.\\)]`, "i"),
    new RegExp(`\\bWeek\\s*${ns}\\b`, "i"),
    new RegExp(`\\bSes\\.?\\s*${ns}\\b`, "i"),
    new RegExp(`[#\\[]\\s*${ns}\\s*[\\]#\\)]`, "i"),
    new RegExp(`\\b${ns}\\s*\\(\\s*[A-Za-zÁÉÍÓÚÑáéíóúñ]`, "i"),
    new RegExp(`\\bLec(?:ture)?\\.?\\s*${ns}\\b`, "i"),
    new RegExp(`\\b(?:Tema|TEMA)\\s*${ns}\\b`, "i"),
    new RegExp(`(?:^|[\\n\\r])[\\s]*${ns}\\s+[\\u2013\\u2014\\-]\\s+\\S`, "m"),
    new RegExp(`Session${ns}\\b`, "i"),
    new RegExp(`Ses\\.${ns}\\b`, "i")
  ];
  for (const re of extraPatterns) {
    const m = head.match(re);
    if (m && m.index != null) {
      const block = sliceSessionBlockFromIndex(head, m.index, n);
      if (block.length >= 40 && !looksLikeWebOrCodeArtifact(block)) return block;
    }
  }

  const academicWords =
    /\b(?:session|sesi[oó]n|week|semana|tema|topic|class|chapter|unit|module|material|reading|lecture|discussion|case|quiz|exam|learning|objective|sustainab|in-person|online|required|optional|activity|workshop|seminar)\b/gi;
  const reNum = new RegExp(`\\b${ns}\\b`, "g");
  let best = "";
  let bestScore = 0;
  let m;
  while ((m = reNum.exec(head)) !== null) {
    const i = m.index;
    const afterPct = head.slice(i + ns.length, i + ns.length + 4);
    if (/^\s*%/.test(afterPct)) continue;
    const slice = head.slice(Math.max(0, i - 120), Math.min(head.length, i + 7200));
    if (looksLikeWebOrCodeArtifact(slice)) continue;
    const words = (slice.match(academicWords) || []).length;
    const score = words * 4 + Math.min(slice.length / 500, 12);
    if (words >= 2 && score > bestScore) {
      bestScore = score;
      best = slice;
    } else if (words === 1 && slice.length >= 400 && score > bestScore) {
      bestScore = score;
      best = slice;
    }
  }
  if (best.length < 45) {
    reNum.lastIndex = 0;
    while ((m = reNum.exec(head)) !== null) {
      const i = m.index;
      const afterPct = head.slice(i + ns.length, i + ns.length + 4);
      if (/^\s*%/.test(afterPct)) continue;
      const slice = head.slice(Math.max(0, i - 90), Math.min(head.length, i + 5500));
      if (looksLikeWebOrCodeArtifact(slice)) continue;
      if (slice.length >= 200 && slice.length > best.length) best = slice;
    }
  }
  return best.length >= 45 ? best : "";
}

/**
 * IE syllabi: never use indexOf("program") — it matches inside "Programa" and can point at JS/UI.
 * Use word-boundary regexes only; reject slices that look like leaked script.
 */
function extractProgramSectionFallback(rawText, sessionNum) {
  if (!rawText || rawText.length < 200) return "";
  const sectionPatterns = [
    /\bweekly\s+schedule\b/i,
    /\bcourse\s+outline\b/i,
    /\bsession\s+schedule\b/i,
    /\bcourse\s+schedule\b/i,
    /\bcalendario\s+de\s+sesiones\b/i,
    /\bcontenidos\s+del\s+curso\b/i,
    /\bweekly\s+outline\b/i,
    /\bclass\s+schedule\b/i,
    /\bteaching\s+schedule\b/i,
    /\bacademic\s+schedule\b/i,
    /\bprogram\s+of\s+(?:studies|sessions)\b/i,
    /\bprogram\s+content\b/i,
    /\bprograma\s+acad[eé]mico\b/i,
    /\btemario\b/i,
    /\bSESSION\s+LIST\b/,
    /\bPROGRAM\s+SESSIONS\b/
  ];
  let bestStart = -1;
  for (const re of sectionPatterns) {
    const m = rawText.match(re);
    if (m && m.index != null && (bestStart < 0 || m.index < bestStart)) bestStart = m.index;
  }
  if (bestStart < 0) return "";
  const slice = rawText.slice(bestStart, bestStart + 18000);
  if (looksLikeWebOrCodeArtifact(slice)) return "";
  const n = sessionNum;
  const posInSlice = slice.search(new RegExp(`\\b${n}\\b`));
  if (posInSlice < 0) {
    if (looksLikeWebOrCodeArtifact(slice)) return "";
    return slice.trim().slice(0, 8000);
  }
  const chunk = slice.slice(Math.max(0, posInSlice - 400), Math.min(slice.length, posInSlice + 6500)).trim();
  return looksLikeWebOrCodeArtifact(chunk) ? "" : chunk;
}

/**
 * Parsea el HTML del syllabus en una estructura consultable.
 * @param {string} html
 * @returns {{ courseTitle: string, sessions: Array<{number: number, title: string, content: string}>, evaluation: Array<{name: string, weight: string}>, bibliography: string[], policies: string[], rawText: string }}
 */
function parseSyllabusHtml(html) {
  const result = {
    courseTitle: "",
    sessions: [],
    evaluation: [],
    bibliography: [],
    policies: [],
    rawText: ""
  };
  if (!html || typeof html !== "string") return result;

  result.rawText = sanitizeSyllabusPlainText(extractTextFromHtml(html));

  const lower = html.toLowerCase();
  const facultyLike = /^(professor|faculty|instructor|bio\b|office\s+hours|contact|teaching\s+staff)\b/i;
  let title = "";
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag) {
    const fullTitleText = stripHtmlTags(titleTag[1]).trim();
    const titleParts = fullTitleText.split(/[|\-–—]/).map((p) => p.trim()).filter((p) => p.length > 3);
    // Generic institution/platform names that should NOT be used as the course title.
    const isGenericPlatformName = (s) =>
      /\b(university|universidad|school|escuela|college|institute|instituto|campus|etools|portal|platform|blackboard|esyllabus|lti)\b/i.test(s) ||
      /^IE\b/i.test(s);
    // Prefer: a part that looks like a course name (not a generic institution or section heading).
    let bestPart = "";
    for (const part of titleParts) {
      if (!isSectionHeadingNotCourseName(part) && !isGenericPlatformName(part)) {
        bestPart = part;
        break;
      }
    }
    // Fallback: first part that isn't a section heading (even if it's institutional).
    if (!bestPart) {
      for (const part of titleParts) {
        if (!isSectionHeadingNotCourseName(part)) { bestPart = part; break; }
      }
    }
    if (bestPart.length > 3 && !isSectionHeadingNotCourseName(bestPart)) title = bestPart;
  }
  const h1All = typeof html.matchAll === "function" ? [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)] : [];
  if (!title) {
    for (const h of h1All) {
      const t = stripHtmlTags(h[1]).trim();
      if (t.length > 3 && !facultyLike.test(t) && !isSectionHeadingNotCourseName(t)) {
        title = t;
        break;
      }
    }
  }
  if (!title && h1All[0]) {
    const fallbackH1 = stripHtmlTags(h1All[0][1]).trim();
    if (!facultyLike.test(fallbackH1) && !isSectionHeadingNotCourseName(fallbackH1)) title = fallbackH1;
  }
  if (isSectionHeadingNotCourseName(title) || (title && title.length < 4)) {
    const h2All = typeof html.matchAll === "function" ? [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)] : [];
    for (const h of h2All) {
      const t = stripHtmlTags(h[1]).trim();
      if (t.length > 5 && !facultyLike.test(t) && !isSectionHeadingNotCourseName(t)) {
        title = t;
        break;
      }
    }
  }
  result.courseTitle = title;

  const sessionPatterns = [
    /(?:session|sesi[oó]n|week|semana|topic|tema)\s*(\d+)[\s:\-]*([^<\n]*)/gi,
    /(?:session|sesi[oó]n)\s*(\d+)/gi
  ];
  const headingBlockRe = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>\s*([\s\S]*?)(?=<h[1-4]|$)/gi;
  let m;
  const seenNumbers = new Set();
  while ((m = headingBlockRe.exec(html)) !== null) {
    const heading = stripHtmlTags(m[1]).trim();
    const body = stripHtmlTags(m[2]).trim();
    const headingLower = heading.toLowerCase();
    if (/\b(AI\s*policy|attendance\s*policy|re-sit|re-take|behavior\s*rules|ethical\s*policy)\b/i.test(headingLower) && body.length > 10) {
      result.policies.push({ name: heading, content: body });
    }
    const sessionNumMatch = heading.match(/(?:session|sesi[oó]n|week|semana|topic|tema)\s*(\d+)/i) || heading.match(/^(\d+)\s*[-.:]/);
    if (sessionNumMatch) {
      const num = parseInt(sessionNumMatch[1], 10);
      if (!seenNumbers.has(num)) {
        seenNumbers.add(num);
        result.sessions.push({
          number: num,
          title: heading,
          content: body
        });
      }
    }
  }
  const looseSessionRe = /(?:session|sesi[oó]n|week)\s*(\d+)[\s:\-]*([^\n<]{5,200})/gi;
  while ((m = looseSessionRe.exec(html)) !== null) {
    const num = parseInt(m[1], 10);
    if (seenNumbers.has(num)) continue;
    const title = stripHtmlTags(m[2]).trim();
    if (title.length < 3) continue;
    seenNumbers.add(num);
    const contentMatch = html.slice(m.index).match(/[\s\S]{0,800}?(?=(?:session|sesi[oó]n|week)\s*\d+|$)/i);
    result.sessions.push({
      number: num,
      title,
      content: contentMatch ? stripHtmlTags(contentMatch[0]).trim().slice(0, 1500) : ""
    });
  }
  result.sessions.sort((a, b) => a.number - b.number);

  const tableRe = /<table[\s\S]*?<\/table>/gi;
  while ((m = tableRe.exec(html)) !== null) {
    const table = m[0];
    if (!/\d+\s*%|weight|peso|assessment|evaluaci[oó]n|grade|nota/i.test(table)) continue;
    const rows = table.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi);
      if (!cells || cells.length < 2) continue;
      const texts = cells.map((c) => stripHtmlTags(c).trim());
      const weightMatch = texts.join(" ").match(/(\d+)\s*%|(\d+)\s*percent/);
      const name = texts[0] || texts[1] || "";
      if (name && (weightMatch || /midterm|final|exam|quiz|participation|assignment|essay|project/i.test(name))) {
        const weight = weightMatch ? (weightMatch[1] || weightMatch[2]) + "%" : texts.find((t) => /\d+\s*%/.test(t)) || "";
        result.evaluation.push({ name, weight });
      }
    }
  }
  const pctRe = /([^\n<]{10,120})\s*(\d+)\s*%/g;
  let pm;
  while ((pm = pctRe.exec(html)) !== null) {
    const line = stripHtmlTags(pm[0]).trim();
    if (line.length > 15 && !result.evaluation.some((e) => e.name === line.slice(0, 50))) result.evaluation.push({ name: line.replace(/\d+\s*%/, "").trim(), weight: (pm[2] || "") + "%" });
  }

  const bibKeywords = /bibliograf[ií]a|references?|readings?|lecturas?\s+(?:compulsory|required|recommended)/i;
  const bibMatch = lower.match(bibKeywords);
  if (bibMatch) {
    const idx = lower.indexOf(bibMatch[0].toLowerCase());
    const after = html.slice(idx);
    const chunk = stripHtmlTags(after.slice(0, 15000)).trim();
    const bullets = chunk.split(/\n|\d+\.\s+|[-*•]/).map((s) => s.trim()).filter((s) => s.length > 15);
    result.bibliography = bullets.slice(0, 80);
  }
  if (result.bibliography.length === 0 && /readings?|bibliography|bibliograf/i.test(lower)) {
    const a = lower.indexOf("bibliography");
    const b = lower.indexOf("bibliograf");
    const c = lower.indexOf("readings");
    const d = lower.indexOf("reading");
    const idx = [a, b, c, d].filter((i) => i !== -1).sort((x, y) => x - y)[0];
    if (idx !== undefined) {
      const after = html.slice(idx);
      const chunk = stripHtmlTags(after.slice(0, 15000)).trim();
      const bullets = chunk.split(/\n|\d+\.\s+|[-*•]/).map((s) => s.trim()).filter((s) => s.length > 15);
      result.bibliography = bullets.slice(0, 80);
    }
  }

  if (result.rawText.length > 0 && result.sessions.length === 0 && result.evaluation.length === 0) {
    const parts = result.rawText.split(/\n\n+/).filter((p) => p.length > 30);
    result.sessions = parts.slice(0, 30).map((p, i) => ({ number: i + 1, title: "", content: p.slice(0, 1200) }));
  } else if (result.rawText.length > 80) {
    supplementSessionsFromRawText(result);
  }

  return result;
}

/**
 * Adds sessions found in plain text but missed by heading/loose HTML passes (IE syllabi often use tables).
 */
function supplementSessionsFromRawText(result) {
  const raw = result.rawText;
  if (!raw || raw.length < 100) return;
  const seen = new Set(result.sessions.map((s) => s.number));
  const re = /\b(?:Session|SESSION|Sesión|SESIÓN|Ses\.?|Class|Lesson|Module)\s+(\d{1,2})\b/gi;
  let m;
  const candidateNums = new Set();
  while ((m = re.exec(raw)) !== null) {
    const num = parseInt(m[1], 10);
    if (num >= 1 && num <= 90 && !seen.has(num)) candidateNums.add(num);
  }
  for (const num of Array.from(candidateNums).sort((a, b) => a - b).slice(0, 40)) {
    if (result.sessions.length >= 55) break;
    const block = extractSessionBlockFromRawText(raw, num);
    if (block.length >= 35) {
      seen.add(num);
      result.sessions.push({
        number: num,
        title: "Session " + num,
        content: block.slice(0, 5500)
      });
    }
  }
  result.sessions.sort((a, b) => a.number - b.number);
}

/**
 * Clasifica la intención de la pregunta.
 * @param {string} text
 * @returns {{ type: 'session'|'evaluation'|'percentage'|'bibliography'|'general', sessionNumber?: number }}
 */
function classifySyllabusQuestion(text) {
  const t = (text || "").toLowerCase();
  const sessionNumMatch = t.match(/(?:sesi[oó]n|session)\s*(\d+)|(\d+)\s*(?:sesi[oó]n|session)/i) || t.match(/(?:la\s+)?sesi[oó]n\s*(\d+)/i);
  if (sessionNumMatch) {
    const num = parseInt(sessionNumMatch[1] || sessionNumMatch[2], 10);
    if (!isNaN(num)) return { type: "session", sessionNumber: num };
  }
  if (/bibliograf[ií]a|referencias|references|reading|lecturas|obligatoria/i.test(t)) return { type: "bibliography" };
  if (/\d+\s*%|porcentaje|percent|peso|weight|cuenta|cuánto\s+porcentaje|midterm|final\s+exam|quiz|evaluaci[oó]n/i.test(t)) return { type: "evaluation" };
  if (/%|porcentaje/i.test(t)) return { type: "percentage" };
  return { type: "general" };
}

/**
 * Follow-up like "content of that session" without a number in the same message — session must come from prior turns.
 */
function looksLikeSessionContentFollowUpWithoutSessionNumber(userText) {
  const t = (userText || "").trim();
  if (!t) return false;
  if (/\b(?:session|sesión)\s*\d+/i.test(t)) return false;
  const lower = t.toLowerCase();
  const refersToSessionOrClass = /\b(?:that|this|the)\s+(?:session|class)\b/i.test(lower);
  const contentish =
    /\b(?:content|cover|see|topic|material|about|what|syllabus|read|objectives|program|going|learn|seeing|doing|teaching)\b/i.test(lower);
  if (refersToSessionOrClass && (contentish || /\?/.test(t))) return true;
  if (/\bwhat\s+(?:are\s+we|do\s+we)\s+(?:seeing|covering|doing)\b/i.test(lower)) return true;
  return false;
}

/**
 * Scan prior user/assistant text for "Session N of …" / "session N of …" (calendar + syllabus phrasing). Uses last match (most recent).
 */
function extractSessionNumberFromRecentChat(blob) {
  if (!blob || typeof blob !== "string" || blob.length < 8) return null;
  const patterns = [/\bSession\s+(\d{1,3})\s+of\s+/gi, /\bsession\s+(\d{1,3})\s+of\s+/gi, /\bsession\s+(\d{1,3})\s+for\s+/gi];
  let last = null;
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(blob)) !== null) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n >= 1 && n <= 120) last = n;
    }
  }
  return last;
}

/**
 * Same as classifySyllabusQuestion, but infers session number from recent chat when the user says "that session" etc.
 * @param {string} userText
 * @param {string} recentChatBlob Prior turns concatenated (e.g. from flattenRecentMessagesForCourseResolution).
 */
function classifySyllabusQuestionWithContext(userText, recentChatBlob) {
  const base = classifySyllabusQuestion(userText);
  if (base.type === "session" && base.sessionNumber != null) return base;
  const blob = (recentChatBlob || "").trim();
  if (!blob || !looksLikeSessionContentFollowUpWithoutSessionNumber(userText)) return base;
  const n = extractSessionNumberFromRecentChat(blob);
  if (n == null) return base;
  return { type: "session", sessionNumber: n };
}

/**
 * Expand vague follow-ups so chunk search and the chat model see an explicit session + course (matches direct questions).
 * @param {string} userText
 * @param {string} courseName Resolved Blackboard course name
 * @param {{ type: string, sessionNumber?: number }} intent
 */
function buildEffectiveSyllabusUserText(userText, courseName, intent) {
  const t = (userText || "").trim();
  if (!t || !courseName) return t;
  if (intent.type !== "session" || intent.sessionNumber == null) return t;
  if (!looksLikeSessionContentFollowUpWithoutSessionNumber(t)) return t;
  return "What is the content of session " + intent.sessionNumber + " of " + courseName + "?";
}

/**
 * Busca en la estructura y devuelve fragmentos de texto relevantes para la pregunta.
 * @param {ReturnType<parseSyllabusHtml>} structured
 * @param {string} question
 * @param {{ type: string, sessionNumber?: number }} intent
 * @returns {string}
 */
function searchSyllabusStructure(structured, question, intent) {
  const parts = [];
  const ct = (structured.courseTitle || "").trim();
  if (ct && !/insert\s+title|lorem\s+ipsum|^[\s\-–—|]+$/i.test(ct) && !isSectionHeadingNotCourseName(ct)) {
    parts.push("Curso: " + ct);
  }

  const minSessionBlock = 20;
  if (intent.type === "session" && intent.sessionNumber != null) {
    const session = structured.sessions.find((s) => s.number === intent.sessionNumber);
    if (session && (session.content || "").length >= minSessionBlock) {
      parts.push("\n--- Session " + session.number + " ---");
      if (session.title) parts.push(session.title);
      parts.push(session.content || "(No content extracted)");
    } else {
      const fromRaw = extractSessionBlockFromRawText(structured.rawText || "", intent.sessionNumber);
      if (fromRaw.length >= minSessionBlock) {
        parts.push("\n--- Session " + intent.sessionNumber + " (from full syllabus text) ---");
        parts.push(fromRaw);
      } else if (session) {
        parts.push("\n--- Session " + session.number + " ---");
        if (session.title) parts.push(session.title);
        parts.push(session.content || "(No content extracted)");
        } else {
          const prog = extractProgramSectionFallback(structured.rawText || "", intent.sessionNumber);
          const aggressive = extractSessionAggressive(structured.rawText || "", intent.sessionNumber);
          if (prog.length >= minSessionBlock) {
            parts.push("\n--- Session " + intent.sessionNumber + " (program / schedule excerpt) ---");
            parts.push(prog);
          } else if (aggressive.length >= minSessionBlock) {
            parts.push("\n--- Session " + intent.sessionNumber + " (matched in full syllabus text) ---");
            parts.push(aggressive);
          } else {
            parts.push("\nNo se encontró un bloque explícito para la sesión " + intent.sessionNumber + ".");
          if (structured.sessions.length > 0) {
            parts.push("Sesiones indexadas: " + structured.sessions.map((s) => s.number).join(", "));
          }
          if ((structured.rawText || "").length > 2500) {
            parts.push(
              "\nThe COMPLETE syllabus text is included below in CONTENIDO COMPLETO. Find session/week " +
                intent.sessionNumber +
                " there (formats: Session, Ses., Week, or numbered lines in the program table)."
            );
          }
        }
      }
    }
    return parts.join("\n");
  }

  if (intent.type === "evaluation" || intent.type === "percentage") {
    if (structured.evaluation.length > 0) {
      parts.push("\n--- Evaluación ---");
      structured.evaluation.forEach((e) => parts.push("- " + e.name + (e.weight ? " " + e.weight : "")));
    }
    const isExamDateQuery = /\b(when|when's|whens|when\s+is|date|fecha|cu[aá]ndo)\b/i.test(question || "") && /\b(midterm|mid-term|final|exam)\b/i.test(question || "");
    if (isExamDateQuery && structured.sessions && structured.sessions.length > 0) {
      const examSessionRe = /midterm|mid-term|final\s*exam|final\s*examination|exam|examen|evaluaci[oó]n\s*(?:final|integral)/i;
      const examSessions = structured.sessions.filter((s) => examSessionRe.test((s.title || "") + " " + (s.content || "")));
      if (examSessions.length > 0) {
        parts.push("\n--- Sessions that are exams (use this to get the SESSION NUMBER for the calendar) ---");
        examSessions.forEach((s) => parts.push("- Session " + s.number + (s.title ? ": " + s.title : "") + (s.content ? " — " + s.content.slice(0, 150) : "")));
      }
    }
    const pctInRaw = structured.rawText.match(/.{0,80}\d+\s*%.{0,80}/g);
    if (pctInRaw && pctInRaw.length > 0) parts.push("\nFragmentos con porcentajes:\n" + pctInRaw.slice(0, 10).join("\n"));
  }

  if (intent.type === "bibliography") {
    if (structured.bibliography.length > 0) {
      parts.push("\n--- Bibliografía / Referencias ---");
      structured.bibliography.forEach((b) => parts.push("- " + b));
    } else {
      const bibBlock = structured.rawText.match(/(?:bibliograf[ií]a|references?|readings?)[\s\S]{0,2000}/i);
      if (bibBlock) parts.push("\n" + stripHtmlTags(bibBlock[0]));
    }
  }

  if (intent.type === "general" || parts.length <= 1) {
    const qWords = (question || "").toLowerCase().match(/\b[\wáéíóúñ]{3,}\b/g) || [];
    const sentences = structured.rawText.split(/[.!?]\s+/).filter((s) => s.length > 20);
    const relevant = sentences.filter((s) => qWords.some((w) => s.toLowerCase().includes(w))).slice(0, 15);
    if (relevant.length > 0) parts.push("\nFragmentos relevantes:\n" + relevant.join("\n"));
    else if (structured.rawText.length > 0) parts.push("\nTexto del syllabus (resumen):\n" + structured.rawText.slice(0, 3000));
  }

  if (parts.length <= 1 && structured.rawText) parts.push("\nContexto:\n" + structured.rawText.slice(0, 2500));
  return parts.join("\n") || "No hay contenido extraído del syllabus.";
}

const MAX_SYLLABUS_CONTEXT_CHARS = 90000;

/**
 * Construye el contexto COMPLETO del syllabus para la IA: mapa de extracción + contenido extraído del HTML.
 * La IA usa SYLLABUS_EXTRACTION_MAP para localizar e interpretar secciones (course info, faculty, objectives, methodology, AI policy, sessions, evaluation, re-sit, bibliography, policies).
 * @param {ReturnType<parseSyllabusHtml>} structured
 * @param {{ canonicalCourseName?: string }} [opts]
 * @returns {string}
 */
function buildFullSyllabusContext(structured, opts = {}) {
  const parts = [SYLLABUS_EXTRACTION_MAP, "\n--- EXTRACTED SYLLABUS CONTENT ---"];
  const canonical = (opts.canonicalCourseName || "").trim();
  if (canonical) parts.push("Nombre del curso (Blackboard / registro): " + canonical);
  if (
    structured.courseTitle &&
    !/insert\s+title|lorem\s+ipsum/i.test(structured.courseTitle)
  ) {
    parts.push("Título del curso (documento): " + structured.courseTitle);
  }
  if (structured.sessions.length > 0) {
    parts.push("\n--- SESIONES ---");
    for (const s of structured.sessions) {
      parts.push("\nSesión " + s.number + (s.title ? ": " + s.title : ""));
      if (s.content) parts.push(s.content);
    }
  }
  if (structured.evaluation.length > 0) {
    parts.push("\n--- EVALUACIÓN ---");
    structured.evaluation.forEach((e) => parts.push("- " + e.name + (e.weight ? " " + e.weight : "")));
  }
  if (structured.bibliography.length > 0) {
    parts.push("\n--- BIBLIOGRAFÍA / REFERENCIAS / READINGS ---");
    structured.bibliography.forEach((b) => parts.push("- " + b));
  }
  if (structured.policies && structured.policies.length > 0) {
    parts.push("\n--- POLICIES (AI Policy, Attendance, Re-sit, Behavior, Ethical) ---");
    structured.policies.forEach((p) => {
      parts.push("\n" + (p.name || "Policy") + ":");
      parts.push(p.content || "");
    });
  }
  parts.push("\n--- CONTENIDO COMPLETO DEL SYLLABUS (texto extraído del HTML) ---");
  let fullText = structured.rawText || "(Sin texto)";
  if (fullText.length > MAX_SYLLABUS_CONTEXT_CHARS) {
    fullText = fullText.slice(0, MAX_SYLLABUS_CONTEXT_CHARS) + "\n\n[ ... documento truncado por longitud; se muestra el inicio completo del syllabus ... ]";
  }
  parts.push(fullText);
  return parts.join("\n");
}

function stripHtmlTagsExport(html) {
  return stripHtmlTags(html);
}

export {
  parseSyllabusHtml,
  classifySyllabusQuestion,
  classifySyllabusQuestionWithContext,
  buildEffectiveSyllabusUserText,
  searchSyllabusStructure,
  buildFullSyllabusContext,
  stripHtmlTagsExport as stripHtmlTags,
  SYLLABUS_EXTRACTION_MAP
};
