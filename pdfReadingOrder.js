/**
 * PDF reading-order pipeline using PDF.js text items with coordinates.
 * Produces: page-by-page, top-to-bottom, right-to-left within line.
 * No LlamaParse/OCR; layout reconstruction only.
 */

const PAGE_DELIMITER = "\x00[PAGE]\x00";
const HEADER_FOOTER_ZONE = 0.07;
const MIN_PAGES_FOR_REPEAT = 0.5;
const GAP_THRESHOLD_MULT = 1.8;
const INDENT_THRESHOLD_PAGE_RATIO = 0.08;
const CELL_GAP_PAGE_RATIO = 0.05;
const Y_OVERLAP_MIN = 0.3;
const Y_TOLERANCE_MEDIAN_RATIO = 0.5;

/**
 * Get tokens with normalized coordinates from a PDF.js page.
 * PDF coordinate system: origin often bottom-left; we normalize to top-left, y down.
 * @param {Object} page - PDF.js page
 * @param {{ width: number, height: number }} viewport
 * @returns {{ tokens: Array<{ str: string, x: number, y: number, width: number, height: number, fontSize?: number }>, pageWidth: number, pageHeight: number }}
 */
export async function getPageTokensWithCoords(page, viewport) {
  const content = await page.getTextContent();
  const pageHeight = viewport.height;
  const pageWidth = viewport.width;
  const tokens = [];

  for (const it of content.items || []) {
    const str = (it.str != null ? String(it.str) : "").trim();
    if (!str) continue;
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const x = tr[4];
    const yPdf = tr[5];
    const y = pageHeight - (yPdf + (it.height || 0));
    const w = it.width || 0;
    const h = it.height || 0;
    let fontSize = 0;
    if (it.fontName && it.height) fontSize = it.height;
    tokens.push({ str, x, y, width: w, height: h, fontSize });
  }

  return { tokens, pageWidth, pageHeight };
}

/**
 * Merge hyphenated line breaks: token ending with "-" + next line starting with lowercase → merge.
 */
function mergeHyphenated(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (t.str.endsWith("-") && next && /^[a-záéíóúñ]/.test(next.str)) {
      out.push({ ...t, str: t.str.slice(0, -1) + next.str });
      i++;
    } else {
      out.push(t);
    }
  }
  return out;
}

/**
 * Group tokens into lines by Y proximity. Returns array of lines; each line = { tokens, yBaseline, xMin, xMax, yMin, yMax }.
 */
function clusterLines(tokens, pageHeight) {
  if (tokens.length === 0) return [];
  const heights = tokens.map(t => t.height).filter(Boolean);
  const H = heights.length ? heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)] : 12;
  const yTolerance = Math.max(2, H * Y_TOLERANCE_MEDIAN_RATIO);

  const byY = [...tokens].sort((a, b) => a.y - b.y);
  const lines = [];
  let current = [byY[0]];
  let lineY = byY[0].y;

  for (let i = 1; i < byY.length; i++) {
    const t = byY[i];
    const overlap = Math.min(t.y + t.height, lineY + (current[0].height || 0)) - Math.max(t.y, lineY);
    const overlapRatio = (current[0].height || 1) > 0 ? overlap / (current[0].height || 1) : 0;
    const inLine = Math.abs(t.y - lineY) <= yTolerance || overlapRatio >= Y_OVERLAP_MIN;

    if (inLine) {
      current.push(t);
    } else {
      lines.push(current);
      current = [t];
      lineY = t.y;
    }
  }
  if (current.length) lines.push(current);

  return lines.map(tokensInLine => {
    const ys = tokensInLine.map(t => t.y);
    const yBaseline = ys.reduce((a, b) => a + b, 0) / ys.length;
    const xMin = Math.min(...tokensInLine.map(t => t.x));
    const xMax = Math.max(...tokensInLine.map(t => t.x + t.width));
    const yMin = Math.min(...tokensInLine.map(t => t.y));
    const yMax = Math.max(...tokensInLine.map(t => t.y + t.height));
    return {
      tokens: tokensInLine,
      yBaseline,
      xMin,
      xMax,
      xCenter: (xMin + xMax) / 2,
      yMin,
      yMax
    };
  });
}

/**
 * Order tokens within a line: left to right (x ascending) for natural reading; join with spaces (punctuation no space before).
 */
function lineToTextRTL(line) {
  const sorted = [...line.tokens].sort((a, b) => a.x - b.x);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i].str;
    const next = sorted[i + 1]?.str;
    parts.push(s);
    if (next != null && next.length > 0 && !/^[.,;:!?)\]]/.test(next) && !/[-(\[]$/.test(s)) {
      parts.push(" ");
    }
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

/**
 * Detect column clusters by xCenter. Returns array of column descriptors, sorted right-to-left (desc xCenter).
 */
function detectColumns(lines) {
  if (lines.length === 0) return [];
  const centers = lines.map(l => l.xCenter);
  const sorted = [...centers].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push({ gap: sorted[i] - sorted[i - 1], mid: (sorted[i] + sorted[i - 1]) / 2 });
  }
  const medGap = gaps.length ? gaps.map(g => g.gap).sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
  const threshold = Math.max(30, medGap * 1.5);
  const columnBoundaries = [sorted[0]];
  for (const g of gaps) {
    if (g.gap >= threshold) columnBoundaries.push(g.mid);
  }
  columnBoundaries.push(sorted[sorted.length - 1] + 1);

  const columnRanges = [];
  for (let i = 0; i < columnBoundaries.length - 1; i++) {
    const low = columnBoundaries[i];
    const high = columnBoundaries[i + 1];
    const colLines = lines.filter(l => l.xCenter >= low && l.xCenter < high);
    const avgX = colLines.length ? colLines.reduce((s, l) => s + l.xCenter, 0) / colLines.length : (low + high) / 2;
    columnRanges.push({ low, high, avgX, lines: colLines });
  }
  columnRanges.sort((a, b) => b.avgX - a.avgX);
  return columnRanges;
}

/**
 * Order lines: right column first (top to bottom), then next column (top to bottom).
 */
function orderLinesByColumns(lines, pageWidth) {
  const columns = detectColumns(lines);
  if (columns.length <= 1) {
    return [...lines].sort((a, b) => a.yBaseline - b.yBaseline);
  }
  const ordered = [];
  for (const col of columns) {
    const sorted = [...col.lines].sort((a, b) => a.yBaseline - b.yBaseline);
    ordered.push(...sorted);
  }
  return ordered;
}

/**
 * Build paragraphs from ordered lines (gap / indent / heading).
 */
function linesToParagraphs(orderedLines, pageWidth, pageHeight) {
  const lineGaps = [];
  for (let i = 1; i < orderedLines.length; i++) {
    lineGaps.push(orderedLines[i].yMin - orderedLines[i - 1].yMax);
  }
  const lineGapMedian = lineGaps.length ? lineGaps.sort((a, b) => a - b)[Math.floor(lineGaps.length / 2)] : 12;
  const gapThreshold = Math.max(8, lineGapMedian * GAP_THRESHOLD_MULT);
  const indentThreshold = pageWidth * INDENT_THRESHOLD_PAGE_RATIO;

  const paragraphs = [];
  let current = [];
  let lastXMin = -1;

  for (const line of orderedLines) {
    const text = lineToTextRTL(line);
    if (!text) continue;

    const gap = current.length ? line.yMin - (current[current.length - 1].yMax || 0) : 0;
    const indentChange = lastXMin >= 0 ? Math.abs(line.xMin - lastXMin) : 0;
    const looksLikeHeading = /^[A-ZÁÉÍÓÚÑ\s\-–—:]+$/.test(text) && text.length < 120;

    const newParagraph = current.length > 0 && (
      gap > gapThreshold ||
      indentChange > indentThreshold ||
      looksLikeHeading
    );

    if (newParagraph && current.length > 0) {
      paragraphs.push(current);
      current = [];
    }
    current.push({ ...line, text });
    lastXMin = line.xMin;
  }
  if (current.length > 0) paragraphs.push(current);

  return paragraphs;
}

/**
 * Table-like rows: same y-band, multiple horizontal gaps → join with " | ".
 */
function formatTableLikeLines(paragraphLines, pageWidth) {
  const cellGap = pageWidth * CELL_GAP_PAGE_RATIO;
  const out = [];
  for (const line of paragraphLines) {
    const tokens = [...line.tokens].sort((a, b) => b.x - a.x);
    const cells = [];
    let cell = [];
    let lastX = Infinity;
    for (const t of tokens) {
      const gap = lastX === Infinity ? 0 : lastX - (t.x + t.width);
      if (gap > cellGap && cell.length > 0) {
        cells.push(cell.map(c => c.str).join(" ").trim());
        cell = [];
      }
      cell.push(t);
      lastX = t.x;
    }
    if (cell.length) cells.push(cell.map(c => c.str).join(" ").trim());
    if (cells.length > 1) {
      out.push(cells.join(" | "));
    } else {
      out.push(lineToTextRTL(line));
    }
  }
  return out;
}

/**
 * Detect repeated header/footer lines across pages and return sets to remove + counts.
 */
function computeHeaderFooterRemoval(pagesOrderedText) {
  const headerLinesByText = new Map();
  const footerLinesByText = new Map();

  for (const p of pagesOrderedText) {
    const pageH = p.pageHeight || 792;
    const headerZone = pageH * HEADER_FOOTER_ZONE;
    const footerZone = pageH * (1 - HEADER_FOOTER_ZONE);
    for (const block of p.blocks || []) {
      for (const line of block.lines || []) {
        const text = (line.text || "").trim();
        if (!text) continue;
        const y = line.yBaseline != null ? line.yBaseline : 0;
        if (y < headerZone) {
          headerLinesByText.set(text, (headerLinesByText.get(text) || 0) + 1);
        } else if (y > footerZone) {
          footerLinesByText.set(text, (footerLinesByText.get(text) || 0) + 1);
        }
      }
    }
  }

  const numPages = Math.max(1, pagesOrderedText.length);
  const removeHeader = new Set();
  const removeFooter = new Set();
  for (const [text, count] of headerLinesByText) {
    if (count >= numPages * MIN_PAGES_FOR_REPEAT) removeHeader.add(text);
  }
  for (const [text, count] of footerLinesByText) {
    if (count >= numPages * MIN_PAGES_FOR_REPEAT) removeFooter.add(text);
  }
  return {
    removeHeader,
    removeFooter,
    headersRemoved: removeHeader.size,
    footersRemoved: removeFooter.size
  };
}

const STRIP_PATTERNS = [
  /^\s*\d{1,3}\s*$/,
  /^\s*\d{1,2}(st|nd|rd|th)\s+\w+\s+\d{4}\s*$/i,
  /^\s*Edited by Documentation\s*$/i
];

function shouldStripLine(text, yBaseline, pageHeight, removeHeader, removeFooter) {
  const t = (text || "").trim();
  if (!t) return true;
  if (STRIP_PATTERNS.some(r => r.test(t))) return true;
  const headerZone = pageHeight * HEADER_FOOTER_ZONE;
  const footerZone = pageHeight * (1 - HEADER_FOOTER_ZONE);
  if (yBaseline < headerZone && removeHeader.has(t)) return true;
  if (yBaseline > footerZone && removeFooter.has(t)) return true;
  return false;
}

/**
 * Full page pipeline: tokens → lines → columns → paragraphs → text.
 */
export function buildOrderedTextForPage(tokens, pageWidth, pageHeight) {
  let cleaned = tokens.filter(t => t.str != null && String(t.str).trim());
  cleaned = mergeHyphenated(cleaned);

  const lineObjs = clusterLines(cleaned, pageHeight);
  const orderedLines = orderLinesByColumns(lineObjs, pageWidth);
  const paragraphs = linesToParagraphs(orderedLines, pageWidth, pageHeight);

  const blockOut = [];
  const pageLines = [];
  for (const para of paragraphs) {
    const lineTexts = formatTableLikeLines(para, pageWidth);
    const lineObjs = para.map(l => ({ ...l, text: lineToTextRTL(l) }));
    blockOut.push({ lines: lineObjs });
    pageLines.push(...lineTexts);
  }

  const orderedText = pageLines.join("\n");
  return { orderedText, blocks: blockOut, lines: orderedLines };
}

/**
 * Program reconstruction: detect clumped SESSION headers and reassign content blocks 1-to-1.
 */
export function reconstructProgramSection(orderedText) {
  const lines = orderedText.split(/\n/).map(l => l.trim()).filter(Boolean);
  const programStart = lines.findIndex(l => /^\s*PROGRAM(ME)?\s*$/i.test(l));
  if (programStart < 0) return { orderedText, reconstructed: false, programText: null };

  const sectionHeadings = /^\s*(EVALUATION|RE-SIT|RE-TAKE|RETAKE|BEHAVIOR|BEHAVIOUR|ATTENDANCE|ETHICAL|BIBLIOGRAPHY|REFERENCES)\b/i;
  let programEnd = lines.length;
  for (let i = programStart + 1; i < lines.length; i++) {
    if (sectionHeadings.test(lines[i])) {
      programEnd = i;
      break;
    }
  }

  const programLines = lines.slice(programStart, programEnd);
  const sessionHeaderRe = /^\s*SESSION\s+(\d+)\s*(?:\([^)]*\))?\s*$/i;
  const sessionIndices = [];
  for (let i = 0; i < programLines.length; i++) {
    if (sessionHeaderRe.test(programLines[i])) {
      const n = parseInt(programLines[i].match(sessionHeaderRe)[1], 10);
      sessionIndices.push({ index: i, number: n, line: programLines[i] });
    }
  }

  if (sessionIndices.length < 3) {
    return {
      orderedText,
      reconstructed: false,
      programText: programLines.join("\n"),
      originalProgramText: programLines.join("\n")
    };
  }

  const contentBetween = [];
  for (let i = 0; i < sessionIndices.length; i++) {
    const start = sessionIndices[i].index + 1;
    const end = i + 1 < sessionIndices.length ? sessionIndices[i + 1].index : programLines.length;
    const slice = programLines.slice(start, end).filter(l => l && !sessionHeaderRe.test(l));
    contentBetween.push(slice.length);
  }
  const avgContent = contentBetween.reduce((a, b) => a + b, 0) / contentBetween.length;
  const clumped = avgContent < 2;

  if (!clumped) {
    return {
      orderedText,
      reconstructed: false,
      programText: programLines.join("\n"),
      originalProgramText: programLines.join("\n")
    };
  }

  const headerBlockEnd = sessionIndices[sessionIndices.length - 1].index + 1;
  const contentStream = programLines.slice(headerBlockEnd).filter(l => l && !sessionHeaderRe.test(l));
  const K = sessionIndices.length;
  const chunkSize = Math.max(1, Math.floor(contentStream.length / K));
  const chunks = [];
  for (let i = 0; i < K; i++) {
    const start = i * chunkSize;
    const end = i + 1 === K ? contentStream.length : (i + 1) * chunkSize;
    chunks.push(contentStream.slice(start, end));
  }

  const reconstructedProgram = [];
  reconstructedProgram.push(programLines[programStart]);
  for (let i = 0; i < sessionIndices.length; i++) {
    reconstructedProgram.push(sessionIndices[i].line);
    reconstructedProgram.push(...(chunks[i] || []));
    reconstructedProgram.push("");
  }

  const newProgramText = reconstructedProgram.join("\n");
  const before = lines.slice(0, programStart).join("\n");
  const after = lines.slice(programEnd).join("\n");
  const fullOrdered = [before, newProgramText, after].filter(Boolean).join("\n\n");

  return {
    orderedText: fullOrdered,
    reconstructed: true,
    programText: newProgramText,
    originalProgramText: programLines.join("\n"),
    sessionCount: K,
    contentChunkCount: chunks.length
  };
}

/**
 * Run full pipeline on a PDF.js document. Call from sidepanel with pdfjsLib and doc.
 */
export async function runPdfReadingOrderPipeline(doc) {
  const numPages = doc.numPages;
  const pagesOrderedText = [];
  const allBlocks = [];
  let rawFallback = "";
  const diagnostics = { warnings: [], headersRemoved: 0, footersRemoved: 0, multiColumnDetected: false, numColumns: 1 };

  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const { tokens, pageWidth, pageHeight } = await getPageTokensWithCoords(page, viewport);
    rawFallback += tokens.map(t => t.str).join(" ") + "\n\n";

    const { orderedText, blocks, lines } = buildOrderedTextForPage(tokens, pageWidth, pageHeight);
    pagesOrderedText.push({
      pageNumber: i,
      orderedText,
      blocks: blocks.map(b => ({
        lines: (b.lines || []).map(l => ({ text: l.text || lineToTextRTL(l), yBaseline: l.yBaseline, xMin: l.xMin }))
      })),
      pageWidth,
      pageHeight,
      lines
    });
    allBlocks.push(...blocks);
  }

  const columnCount = pagesOrderedText.some(p => (p.lines || []).length > 0 && detectColumns(p.lines).length > 1) ? 2 : 1;
  diagnostics.multiColumnDetected = columnCount > 1;
  diagnostics.numColumns = columnCount;

  const { removeHeader, removeFooter, headersRemoved, footersRemoved } = computeHeaderFooterRemoval(pagesOrderedText);
  diagnostics.headersRemoved = headersRemoved;
  diagnostics.footersRemoved = footersRemoved;

  const pagesFiltered = pagesOrderedText.map(p => {
    const pageH = p.pageHeight || 792;
    const outLines = [];
    for (const block of p.blocks || []) {
      for (const line of block.lines || []) {
        const text = (line.text || "").trim();
        if (!text) continue;
        if (shouldStripLine(text, line.yBaseline, pageH, removeHeader, removeFooter)) continue;
        outLines.push(text);
      }
    }
    return { ...p, orderedText: outLines.join("\n") };
  });

  const fullOrderedNoProgram = pagesFiltered.map(p => p.orderedText).join("\n");
  const result = reconstructProgramSection(fullOrderedNoProgram);

  let orderedTextFinal = result.orderedText;
  if (result.reconstructed) {
    diagnostics.programReconstructed = true;
    diagnostics.programClumpedDetected = true;
  }

  const parseQuality = {
    multiColumnDetected: diagnostics.multiColumnDetected,
    numColumns: diagnostics.numColumns,
    headersRemoved: headersRemoved,
    footersRemoved: footersRemoved,
    programReconstructed: result.reconstructed || false,
    programClumpedDetected: result.reconstructed || false,
    tableDetected: false,
    warnings: diagnostics.warnings || [],
    confidence: result.reconstructed ? 0.85 : 0.7
  };

  return {
    orderedText: orderedTextFinal.replace(/\n{3,}/g, "\n\n").trim(),
    pagesOrderedText: pagesOrderedText.map(p => ({ pageNumber: p.pageNumber, orderedText: p.orderedText })),
    blocks: allBlocks,
    rawFallback: rawFallback.replace(/\s+/g, " ").trim(),
    diagnostics: {
      ...diagnostics,
      originalProgramText: result.originalProgramText,
      reconstructedProgramText: result.programText
    },
    parseQuality
  };
}

/**
 * Strip page delimiter from text before sending to AI (so it never leaks to user).
 */
export function stripPageDelimiter(text) {
  if (typeof text !== "string") return text;
  return text.split(PAGE_DELIMITER).join("\n");
}

if (typeof window !== "undefined") {
  window.runPdfReadingOrderPipeline = runPdfReadingOrderPipeline;
  window.stripPageDelimiter = stripPageDelimiter;
}
