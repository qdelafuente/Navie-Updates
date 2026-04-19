/**
 * Course Messages (Conversations) retrieval system for Blackboard Ultra.
 * Optimized: single normalization, in-memory indexes, TTL cache. No changes to other systems.
 */

const TTL_NORMAL_MS = 120000;       // 120 s
const TTL_FAST_REFRESH_MS = 45000;  // 45 s for latest/unread/today
const TEXT_PREVIEW_LEN = 350;
const MAX_REFS_PER_KEYWORD = 50;
const KEYWORD_MIN_LEN = 3;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "must", "can", "this", "that", "these", "those",
  "it", "its", "as", "if", "then", "than", "so", "just", "also", "only", "not", "no", "yes",
  "el", "la", "los", "las", "un", "una", "de", "del", "en", "con", "por", "para", "que", "es", "son",
  "se", "lo", "al", "como", "pero", "sus", "le", "ya", "o", "fue", "este", "ha", "si", "sí"
]);

const courseMessageCache = new Map();

function stripHtml(html) {
  if (typeof html !== "string") return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isoToEpoch(iso) {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Normalize API response once. No HTML parsing on later queries.
 */
function normalizeConversations(rawResults) {
  const messages = [];
  const conversations = [];

  if (!Array.isArray(rawResults)) return { messages, conversations };

  for (const conv of rawResults) {
    const conversationId = conv?.id ?? "";
    const updatedDateEpoch = isoToEpoch(conv?.updatedDate);
    const unreadCount = Math.max(0, Number(conv?.unreadCount) || 0);
    const totalCount = Math.max(0, Number(conv?.totalCount) || 0);
    const convMessages = Array.isArray(conv?.messages) ? conv.messages : [];
    let lastMessageRef = null;
    let lastEpoch = 0;

    for (const m of convMessages) {
      const sender = m?.sender ?? {};
      const givenName = (sender?.givenName ?? "").trim();
      const familyName = (sender?.familyName ?? "").trim();
      const senderName = [givenName, familyName].filter(Boolean).join(" ").trim() || (sender?.userName ?? "") || "";
      const senderUsername = (sender?.userName ?? "").trim();
      const senderId = sender?.id ?? "";

      const body = m?.body ?? {};
      let textRaw = (body?.rawText ?? body?.displayText ?? "").trim();
      if (!textRaw && body?.displayText != null) textRaw = String(body.displayText);
      const textPlain = stripHtml(textRaw).replace(/\s+/g, " ").trim();
      const textPreview = textPlain.length > TEXT_PREVIEW_LEN ? textPlain.slice(0, TEXT_PREVIEW_LEN) + "…" : textPlain;

      const postDateISO = m?.postDate ?? "";
      const postDateEpoch = isoToEpoch(postDateISO);
      const messageId = m?.id ?? "";
      const webLocation = (m?.webLocation ?? "").trim();
      const isRead = Boolean(m?.isRead);

      const msg = {
        messageId,
        conversationId,
        postDateEpoch,
        postDateISO,
        senderName,
        senderUsername,
        senderId,
        textPlain,
        textPreview,
        webLocation,
        isRead
      };
      messages.push(msg);
      if (postDateEpoch > lastEpoch) {
        lastEpoch = postDateEpoch;
        lastMessageRef = messageId;
      }
    }

    conversations.push({
      conversationId,
      updatedDateEpoch,
      unreadCount,
      totalCount,
      lastMessageRef
    });
  }

  return { messages, conversations };
}

function normalizeSenderForIndex(nameOrUsername) {
  if (typeof nameOrUsername !== "string") return "";
  return nameOrUsername
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForKeywordIndex(text) {
  if (typeof text !== "string") return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= KEYWORD_MIN_LEN && !STOPWORDS.has(t));
}

/**
 * Build indexes for fast lookup. Message ref = index into messages array.
 */
function buildIndexes(normalized) {
  const { messages } = normalized;
  const byDate = messages.map((m, i) => ({ i, postDateEpoch: m.postDateEpoch }))
    .sort((a, b) => b.postDateEpoch - a.postDateEpoch);

  const bySender = new Map();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const key = normalizeSenderForIndex(m.senderName) || normalizeSenderForIndex(m.senderUsername);
    if (!key) continue;
    if (!bySender.has(key)) bySender.set(key, []);
    bySender.get(key).push({ i, postDateEpoch: m.postDateEpoch });
  }
  for (const arr of bySender.values()) {
    arr.sort((a, b) => b.postDateEpoch - a.postDateEpoch);
  }

  const invertedKeywordIndex = new Map();
  for (let i = 0; i < messages.length; i++) {
    const tokens = tokenizeForKeywordIndex(messages[i].textPlain);
    const seen = new Set();
    for (const tok of tokens) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      if (!invertedKeywordIndex.has(tok)) invertedKeywordIndex.set(tok, []);
      const list = invertedKeywordIndex.get(tok);
      if (list.length < MAX_REFS_PER_KEYWORD) list.push({ i, postDateEpoch: messages[i].postDateEpoch });
    }
  }
  for (const arr of invertedKeywordIndex.values()) {
    arr.sort((a, b) => b.postDateEpoch - a.postDateEpoch);
  }

  return { byDate, bySender, invertedKeywordIndex };
}

/**
 * Get or fetch conversations for a course. Uses cache with TTL; forceRefresh for latest/unread/today.
 */
export async function getOrFetchConversations(courseId, fetchFn, options = {}) {
  const { forceRefresh = false } = options;
  const cached = courseMessageCache.get(courseId);
  const now = Date.now();
  const ttl = forceRefresh ? TTL_FAST_REFRESH_MS : TTL_NORMAL_MS;
  if (cached && (now - cached.fetchedAt) < ttl && !forceRefresh) {
    return { normalized: cached.normalized, indexes: cached.indexes };
  }

  const res = await fetchFn(courseId);
  if (!res?.ok || !Array.isArray(res.results)) {
    throw new Error(res?.error || "Failed to load course conversations.");
  }
  const normalized = normalizeConversations(res.results);
  const indexes = buildIndexes(normalized);
  courseMessageCache.set(courseId, {
    normalized,
    indexes,
    fetchedAt: now
  });
  return { normalized, indexes };
}

/**
 * Execute the AI plan deterministically. Returns { messages: normalized messages[], responseStyle }.
 */
export function executePlan(plan, normalized, indexes) {
  const { messages } = normalized;
  const { byDate, bySender, invertedKeywordIndex } = indexes;
  const intent = (plan?.intent ?? "").toUpperCase().replace(/\s/g, "_");
  const limit = Math.min(50, Math.max(1, Number(plan?.limit) || 5));
  const unreadOnly = Boolean(plan?.filters?.unreadOnly);
  const senderQuery = (plan?.filters?.sender ?? "").trim();
  const keywords = Array.isArray(plan?.query?.keywords) ? plan.query.keywords : [];
  const dateFrom = plan?.dateRange?.from ? isoToEpoch(plan.dateRange.from) : 0;
  const dateTo = plan?.dateRange?.to ? isoToEpoch(plan.dateRange.to) : Infinity;

  let indices = [];

  switch (intent) {
    case "GET_LAST_MESSAGE":
      indices = byDate.slice(0, 1).map((x) => x.i);
      break;
    case "GET_RECENT_MESSAGES":
      indices = byDate.slice(0, limit).map((x) => x.i);
      break;
    case "CHECK_ANY_MESSAGES":
    case "CHECK_UNREAD":
      indices = byDate.map((x) => x.i);
      if (intent === "CHECK_UNREAD" || unreadOnly) {
        indices = indices.filter((i) => !messages[i].isRead);
      }
      indices = indices.slice(0, limit);
      break;
    case "SEARCH_BY_SENDER": {
      if (!senderQuery) break;
      const key = normalizeSenderForIndex(senderQuery);
      const bySenderList = key ? bySender.get(key) : null;
      if (!bySenderList) {
        const keyLower = key.toLowerCase();
        for (const [k, list] of bySender.entries()) {
          if (k.includes(keyLower) || keyLower.includes(k)) {
            indices = list.slice(0, limit).map((x) => x.i);
            break;
          }
        }
      } else {
        indices = bySenderList.slice(0, limit).map((x) => x.i);
      }
      break;
    }
    case "SEARCH_BY_KEYWORD": {
      if (keywords.length === 0 && plan?.query?.raw) {
        const raw = String(plan.query.raw).trim();
        keywords.push(...tokenizeForKeywordIndex(raw));
      }
      if (keywords.length === 0) break;
      const scoreMap = new Map();
      for (const kw of keywords) {
        const tok = kw.toLowerCase().replace(/[^\w]/g, "");
        if (tok.length < KEYWORD_MIN_LEN) continue;
        const list = invertedKeywordIndex.get(tok) ?? [];
        for (const { i, postDateEpoch } of list) {
          scoreMap.set(i, (scoreMap.get(i) ?? 0) + 1 + (postDateEpoch / 1e13));
        }
      }
      indices = [...scoreMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([i]) => i);
      break;
    }
    case "SEARCH_BY_DATE_RANGE": {
      for (const { i, postDateEpoch } of byDate) {
        if (postDateEpoch >= dateFrom && postDateEpoch <= dateTo) {
          indices.push(i);
          if (indices.length >= limit) break;
        }
      }
      break;
    }
    case "SUMMARIZE_LAST":
    case "SUMMARIZE_RESULTS":
    case "EXTRACT_DETAILS":
    default:
      indices = byDate.slice(0, limit).map((x) => x.i);
      break;
  }

  const outMessages = indices.map((i) => messages[i]).filter(Boolean);
  return {
    messages: outMessages,
    responseStyle: plan?.responseStyle ?? "brief"
  };
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch (_) {
    return iso;
  }
}

/**
 * Format execution result for the user. Includes course name, date, sender, preview, link, read status.
 */
export function formatResponse(plan, result, courseName) {
  const { messages, responseStyle } = result;
  const courseLabel = courseName || (plan?.course?.name ?? "this course");

  if (!messages || messages.length === 0) {
    const intent = (plan?.intent ?? "").toUpperCase();
    if (intent === "CHECK_UNREAD" || plan?.filters?.unreadOnly) {
      return "You have no unread messages in " + courseLabel + ".";
    }
    if (intent === "CHECK_ANY_MESSAGES") {
      return "There are no messages in " + courseLabel + ".";
    }
    return "No messages found in " + courseLabel + " for your query.";
  }

  const lines = [];
  for (const m of messages) {
    const dateStr = formatDate(m.postDateISO);
    const sender = m.senderName || m.senderUsername || "Unknown";
    const preview = m.textPreview || "(no text)";
    const readStatus = m.isRead ? "Read" : "Unread";
    const link = m.webLocation ? "\nLink: " + m.webLocation : "";
    lines.push(`${dateStr} — ${sender}\n"${preview}"\nStatus: ${readStatus}${link}`);
  }

  const header = messages.length === 1
    ? "Last message in " + courseLabel + ":"
    : `Latest ${messages.length} message(s) in ${courseLabel}:`;
  return header + "\n\n" + lines.join("\n\n---\n\n");
}

/**
 * Invalidate cache for a course (e.g. after sending a message). Optional use.
 */
export function invalidateCourseCache(courseId) {
  if (courseId) courseMessageCache.delete(courseId);
  else courseMessageCache.clear();
}
