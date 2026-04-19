(function (global) {
  "use strict";

  const ROUTES = {
    PROFILE_IDENTITY: "PROFILE_IDENTITY",
    SYLLABUS_LINK: "SYLLABUS_LINK",
    ATTENDANCE: "ATTENDANCE",
    ASSIGNMENT_GRADE: "ASSIGNMENT_GRADE",
    SINGLE_ASSIGNMENT_SUBMISSION_CHECK: "SINGLE_ASSIGNMENT_SUBMISSION_CHECK",
    COURSE_MESSAGES: "COURSE_MESSAGES",
    GLOBAL_SUBMISSION_STATUS: "GLOBAL_SUBMISSION_STATUS",
    SUBMISSION_STATUS: "SUBMISSION_STATUS",
    FINAL_DATE_SINGLE: "FINAL_DATE_SINGLE",
    MIDTERM_DATE_SINGLE: "MIDTERM_DATE_SINGLE",
    FINAL_DATES_ALL: "FINAL_DATES_ALL",
    MIDTERM_DATES_ALL: "MIDTERM_DATES_ALL",
    SYLLABUS_CONTENT: "SYLLABUS_CONTENT",
    SYLLABUS_QUESTION: "SYLLABUS_QUESTION",
    ANNOUNCEMENTS_ONLY: "ANNOUNCEMENTS_ONLY",
    COMBINED_COURSE_QUERY: "COMBINED_COURSE_QUERY",
    TEMPORAL_SESSION: "TEMPORAL_SESSION",
    OPENROUTER_CHAT: "OPENROUTER_CHAT"
  };

  const STOPWORDS = new Set([
    "de", "del", "la", "el", "the", "for", "of", "in", "por", "para", "en", "mi", "my", "curso", "course",
    "next", "this", "week", "today", "tomorrow", "hoy", "manana", "semana", "proxima",
    // Common English typos for time words — must not become a "course hint"
    "toda", "tody", "tommorow", "tommorrow", "scheduld"
  ]);

  function normalizeAccents(value) {
    return (value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function preprocessText(text) {
    const raw = String(text || "");
    const lowered = normalizeAccents(raw).toLowerCase();
    const synonymExpanded = lowered
      .replace(/\bwhens\b/gi, " when ")
      .replace(/\bannoun\w*ment\w*\b/gi, " announcements ")
      .replace(/\bfor\s+toda\b(?!\s+la\b)/gi, " for today ")
      .replace(/\bof\s+toda\b(?!\s+la\b)/gi, " of today ")
      .replace(/\bin\s+toda\b(?!\s+la\b)/gi, " in today ")
      .replace(/\b(sessions?|classes?)\s+toda\b/gi, "$1 today ")
      .replace(/\btody\b/g, " today ")
      .replace(/\bscheduld\b/g, " scheduled ")
      .replace(/\bannounc\w*\b/g, " announcements ")
      .replace(/\bclose+st\b/g, " closest ")
      .replace(/\bclose+e+st\b/g, " closest ")
      .replace(/\bmesages?\b/g, " messages ")
      .replace(/\bmsgs?\b/g, " messages ")
      .replace(/\brecieved\b/g, " received ")
      .replace(/\bparcial(es)?\b/g, " midterm ")
      .replace(/\bentrega(s)?\b/g, " assignment ")
      .replace(/\bentregar\b/g, " assignment ")
      .replace(/\bdeliver\b/g, " assignment ")
      .replace(/\btarea(s)?\b/g, " assignment ")
      .replace(/\bsesion(es)?\b/g, " session ")
      .replace(/\bclase(s)?\b/g, " class ")
      .replace(/\bavisos?\b/g, " announcements ")
      .replace(/\banuncios?\b/g, " announcements ")
      .replace(/\bque\b/g, " what ")
      .replace(/\bcuando\b/g, " when ")
      .replace(/\basignment(s)?\b/gi, " assignment ")
      .replace(/\bassignement(s)?\b/gi, " assignment ")
      .replace(/\bforr\b/gi, " for ")
      .replace(/\btday\b/gi, " today ")
      .replace(/\bassigns\b/gi, " assignments ")
      .replace(/\bmicrocecon\b/gi, " microeconomics ")
      .replace(/\bmicroecon\b/gi, " microeconomics ")
      .replace(/\bsupa\s+/gi, " ")
      .replace(/\battendnce\b/gi, " attendance ")
      .replace(/\battndace\b/gi, " attendance ")
      .replace(/\battendanc\b/gi, " attendance ")
      .replace(/\battendace\b/gi, " attendance ")
      .replace(/\batendance\b/gi, " attendance ")
      .replace(/\battendence\b/gi, " attendance ")
      .replace(/\battsndance\b/gi, " attendance ")
      .replace(/\bgimme\b/gi, " give me ")
      .replace(/\b(?:give|show|get)\s+me\s+all\s+for\s+/gi, " give me all assignments for ")
      .replace(/\b(?:give|show|get)\s+me\s+all\s+in\s+/gi, " give me all assignments in ")
      .replace(/\b(?:give|show|get)\s+me\s+all\s+of\s+/gi, " give me all assignments of ");
    const compact = synonymExpanded.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    return {
      original: raw,
      normalized: compact,
      tokens: compact ? compact.split(" ") : []
    };
  }

  const WEEKDAY_ONLY_HINTS = new Set([
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"
  ]);

  function extractCourseHint(normalized) {
    if (!normalized) return "";
    const match = normalized.match(/\b(?:de|del|of|for|in)\s+([a-z0-9][a-z0-9\s]{1,40})$/i)
      || normalized.match(/\b(?:de|del|of|for|in)\s+([a-z0-9][a-z0-9\s]{1,40})\b/i);
    if (!match) return "";
    const hint = match[1].trim().replace(/\s+/g, " ");
    const words = hint.split(" ").filter((w) => !STOPWORDS.has(w));
    const candidate = words.join(" ").trim();
    if (!candidate) return "";
    if (/^(next|this)\s+week$/.test(hint)) return "";
    if (/^(today|tomorrow|hoy|manana|toda|tody|tday|tmrw|tmr)$/.test(candidate)) return "";
    if (WEEKDAY_ONLY_HINTS.has(candidate)) return "";
    if (/^(this|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.test(candidate)) return "";
    // "in that session" / "for this class" → not a course name (prevents COMBINED_COURSE_QUERY on follow-ups)
    if (/^(that|this|the)\s+(session|class|course)\b/.test(candidate)) return "";
    if (/^(that|this|the)\s+(session|class)\b$/i.test(hint.trim())) return "";
    return candidate;
  }

  function extractEntities(input) {
    const pre = typeof input === "string" ? preprocessText(input) : input;
    const t = pre.normalized;
    const sessionMatch = t.match(/\b(?:session|class)\s*#?\s*(\d{1,2})\b/);
    const examType = /\bfinal\b/.test(t) ? "final" : (/\bmidterm\b/.test(t) ? "midterm" : "");
    const timeScope =
      /\bthis week\b|\besta semana\b/.test(t) ? "this_week"
        : /\bnext week\b|\bproxima semana\b/.test(t) ? "next_week"
          : /\btomorrow\b|\bmanana\b/.test(t) ? "tomorrow"
            : /\btoday\b|\bhoy\b/.test(t) ? "today"
              : "";
    return {
      courseHint: extractCourseHint(t),
      sessionNumber: sessionMatch ? Number(sessionMatch[1]) : null,
      examType,
      timeScope
    };
  }

  function boost(intents, route, score, reason) {
    intents.push({ route, confidence: score, reason });
  }

  function classifyIntent(text, entities) {
    const pre = typeof text === "string" ? preprocessText(text) : text;
    const e = entities || extractEntities(pre);
    const t = pre.normalized;
    const intents = [];

    if (/\b(email|student id|who am i|my name)\b/.test(t)) boost(intents, ROUTES.PROFILE_IDENTITY, 0.98, "profile identity terms");
    if (/\b(attendance|asistencia)\b/.test(t)) boost(intents, ROUTES.ATTENDANCE, 0.95, "attendance terms");
    if (/\b(attendance|asistencia)\b/.test(t) && e.courseHint) {
      boost(intents, ROUTES.ATTENDANCE, 0.97, "attendance with course mention");
    }
    if (/\b(syllabus|silabo)\b/.test(t) && /\b(link|enlace|open|download|show)\b/.test(t)) boost(intents, ROUTES.SYLLABUS_LINK, 0.95, "syllabus link request");
    if (/\b(submit|submitted|entregado|entregue)\b/.test(t) && /\bassignments?\b/.test(t)) boost(intents, ROUTES.SINGLE_ASSIGNMENT_SUBMISSION_CHECK, 0.92, "single submission check");
    const hasMessageDomain = /\b(message|messages|conversation|conversations|thread|threads|inbox|unread)\b/.test(t);
    const hasMessageActionOnly = /\b(received|sent)\b/.test(t) && /\b(last|latest|recent)\b/.test(t);
    if ((hasMessageDomain || hasMessageActionOnly) && !/\bannouncements?\b|\bannounc\w*\b/.test(t)) {
      boost(intents, ROUTES.COURSE_MESSAGES, 0.9, "course messages wording");
    }
    if (
      /\b(?:the\s+)?\d{1,2}\s+(?:latest|most\s+recent)\b/.test(t) &&
      !/\b(?:announcements?|notice|update)\b/i.test(t) &&
      !/\bannounc\w*\b/i.test(t)
    ) {
      boost(intents, ROUTES.COURSE_MESSAGES, 0.91, "N latest follow-up");
    }
    if (/\bneed to submit|pendiente|pending\b/.test(t) && /\b(all|todos)\b/.test(t)) boost(intents, ROUTES.GLOBAL_SUBMISSION_STATUS, 0.9, "global submission status");
    if (/\bneed to submit|pending|to do|to-do|incomplete|what do i have assignment\b/.test(t)) {
      boost(intents, ROUTES.SUBMISSION_STATUS, 0.88, "submission status wording");
    }
    if (/\b(grade|nota|calificacion)\b/.test(t)) {
      boost(intents, ROUTES.ASSIGNMENT_GRADE, 0.86, "grade wording");
    }
    if (/\bassignments?\b/.test(t) && e.courseHint) {
      boost(intents, ROUTES.ASSIGNMENT_GRADE, 0.94, "assignment with course hint");
    }
    if (/\b(?:give|show|list|get)\s+me\b/.test(t) && /\bassignments?\b/.test(t) && e.courseHint) {
      boost(intents, ROUTES.ASSIGNMENT_GRADE, 0.95, "give list assignments for course");
    }
    if (/\b(?:give|show|get)\s+me\s+all\s+assignments?\b/.test(t) && e.courseHint) {
      boost(intents, ROUTES.ASSIGNMENT_GRADE, 0.96, "give all assignments for course");
    }
    if (/\b(?:i\s+want|i\s+need)\s+(?:my\s+)?(?:last|first|next)\s+assignments?\b/.test(t) && e.courseHint) {
      boost(intents, ROUTES.ASSIGNMENT_GRADE, 0.95, "want last assignment for course");
    }
    if (/\b(?:are\s+there\s+)?any\s+assignments?\s+(?:in|for|of)\b/.test(t) && e.courseHint) {
      boost(intents, ROUTES.ASSIGNMENT_GRADE, 0.95, "any assignments in course");
    }
    if (/\b(?:give|show|get)\s+me\s+(?:the\s+)?(?:ones|those)\s+(?:in|for)\b/.test(t) && e.courseHint) {
      boost(intents, ROUTES.ASSIGNMENT_GRADE, 0.95, "ones/those in course referent");
    }
    if (/\b(?:and|or|also)\s+in\s+[a-z]/.test(t) && e.courseHint) {
      boost(intents, ROUTES.ASSIGNMENT_GRADE, 0.93, "and in course follow-up");
    }
    if (/\bannouncements?\b|\bannounc\w*\b|\bnotice\b|\bupdate\b|\banything new\b|\bhay algo nuevo\b/.test(t)) {
      boost(intents, ROUTES.ANNOUNCEMENTS_ONLY, 0.84, "announcements terms");
    }
    if ((/\b(when|date|fecha|cae|closest|nearest|next|last|latest|first|second|third)\b/.test(t) || /\bwhen is\b/.test(t)) && /\bfinal\b/.test(t) && e.courseHint) {
      boost(intents, ROUTES.FINAL_DATE_SINGLE, 0.9, "single final date");
    }
    if ((/\b(when|date|fecha|cae|closest|nearest|next|last|latest|first|second|third)\b/.test(t) || /\bwhen is\b/.test(t)) && /\bmidterm\b/.test(t) && e.courseHint) {
      boost(intents, ROUTES.MIDTERM_DATE_SINGLE, 0.9, "single midterm date");
    }
    if (/\b(final|finals|final exam)\b/.test(t) && /\b(closest|nearest|next|last|latest|first|second|third|close|soon)\b/.test(t)) {
      boost(intents, ROUTES.FINAL_DATES_ALL, 0.9, "final ranking query");
    }
    if (/\b(?:do\s+i\s+have|have\s+i\s+got)\s+any\s+(?:final|finals|final\s+exam)\b/.test(t)) {
      boost(intents, ROUTES.FINAL_DATES_ALL, 0.92, "any final exam soon");
    }
    if (/\b(midterm|mid-term|parcial)\b/.test(t) && /\b(closest|nearest|next|last|latest|first|second|third)\b/.test(t)) {
      boost(intents, ROUTES.MIDTERM_DATES_ALL, 0.88, "midterm ranking query");
    }
    if ((/\b(all|todos)\b/.test(t) || /\bdates\b/.test(t)) && /\bfinal\b/.test(t)) boost(intents, ROUTES.FINAL_DATES_ALL, 0.86, "all finals");
    if ((/\b(all|todos)\b/.test(t) || /\bdates\b/.test(t)) && /\bmidterm\b/.test(t)) boost(intents, ROUTES.MIDTERM_DATES_ALL, 0.86, "all midterms");
    if (
      (/\b(session|class)\b/.test(t) && /\babout\b/.test(t)) ||
      /\bprogram|evaluation|bibliography|objectives|professor\b/.test(t) ||
      /\bwhat toca en la\b/.test(t) ||
      /\btoca en la\s+\d+/.test(t)
    ) {
      boost(intents, ROUTES.SYLLABUS_CONTENT, 0.82, "syllabus content terms");
    }
    if (/\bsession\s+[\d\-]+\s+of\s+/i.test(t) && /\b(content|like|whats|what|about)\b/.test(t)) {
      boost(intents, ROUTES.SYLLABUS_CONTENT, 0.92, "session range syllabus content");
    }
    if (
      /\b(?:that|this|the)\s+session\b/.test(t) &&
      /\b(?:what|see|cover|covering|content|learn|study|going|toca|topics?|materials?)\b/.test(t)
    ) {
      boost(intents, ROUTES.SYLLABUS_CONTENT, 0.91, "session referent syllabus content");
    }
    if (/\bsyllabus|silabo\b/.test(t)) boost(intents, ROUTES.SYLLABUS_QUESTION, 0.8, "syllabus generic");
    if (
      /\b(when|today|tomorrow|this week|next week)\b/.test(t) &&
      /\b(sessions?|classes?|schedule|schedules|scheduled)\b/.test(t)
    ) {
      boost(intents, ROUTES.TEMPORAL_SESSION, 0.86, "temporal session wording");
    }
    if (
      /\b(sessions?|classes?|schedule|scheduled)\b/.test(t) &&
      /\b(this|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t)
    ) {
      boost(intents, ROUTES.TEMPORAL_SESSION, 0.89, "classes this or next weekday");
    }
    if (
      /\b(sessions?|classes?)\b/.test(t) &&
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t) &&
      /\b(the\s+)?next\s+one\b/.test(t)
    ) {
      boost(intents, ROUTES.TEMPORAL_SESSION, 0.9, "next one disambiguation");
    }
    if (e.courseHint) boost(intents, ROUTES.COMBINED_COURSE_QUERY, 0.74, "course hint detected");
    if (/\bassignments?\b/.test(t) && !e.courseHint) {
      // Global assignment queries should continue to OPENROUTER path with assignments context.
      boost(intents, ROUTES.OPENROUTER_CHAT, 0.8, "assignment without explicit course");
    }
    if (/\bassignments?\b/.test(t) && !hasMessageDomain && !e.courseHint) {
      // Prevent "last N assignments" from being hijacked by message intent.
      boost(intents, ROUTES.OPENROUTER_CHAT, 0.9, "assignment query prioritized over messages");
    }

    if (!intents.length) boost(intents, ROUTES.OPENROUTER_CHAT, 0.55, "default fallback");
    intents.sort((a, b) => b.confidence - a.confidence);
    return intents;
  }

  function chooseRoute(intents) {
    const sorted = Array.isArray(intents) ? intents.slice().sort((a, b) => b.confidence - a.confidence) : [];
    const top1 = sorted[0] || { route: ROUTES.OPENROUTER_CHAT, confidence: 0.0, reason: "no intents" };
    const top2 = sorted[1] || null;
    const scoreGap = top2 ? top1.confidence - top2.confidence : top1.confidence;
    const fallbackToLegacy = top1.confidence < 0.72 || scoreGap < 0.08;
    return {
      top1,
      top2,
      route: top1.route,
      confidence: top1.confidence,
      scoreGap,
      fallbackToLegacy
    };
  }

  global.IntentRouter = {
    ROUTES,
    preprocessText,
    extractEntities,
    classifyIntent,
    chooseRoute
  };
})(typeof window !== "undefined" ? window : globalThis);
