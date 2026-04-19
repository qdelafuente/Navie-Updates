/**
 * Calendario: flujo simple.
 * Cuando el usuario pregunta por sesiones/clases en un día (today, tomorrow, next Monday, session X of course Y, etc.):
 * 1. Se obtienen since y until en formato YYYY-MM-DDT00:00Z y YYYY-MM-DDT22:59Z.
 * 2. GET a .../calendarItems?since=&until=
 * 3. El JSON se pasa a la IA para que extraiga la información y responda.
 */
(function (global) {
  "use strict";

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function addDays(d, n) {
    const out = new Date(d);
    out.setDate(out.getDate() + n);
    return out;
  }

  /** Formato API: since=YYYY-MM-DDT00:00Z&until=YYYY-MM-DDT22:59Z */
  function toSince(y, m, d) {
    return y + "-" + pad2(m + 1) + "-" + pad2(d) + "T00:00Z";
  }
  function toUntil(y, m, d) {
    return y + "-" + pad2(m + 1) + "-" + pad2(d) + "T22:59Z";
  }

  const WEEKDAY = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6 };
  /** Normalize common temporal-word typos so calendar detection and date range still work. */
  function normalizeTemporalSpelling(text) {
    if (!text || typeof text !== "string") return text;
    let t = text;
    const replacements = [
      [/\btmorrow\b/gi, "tomorrow"],
      [/\btomorow\b/gi, "tomorrow"],
      [/\btommorow\b/gi, "tomorrow"],
      [/\btommorrow\b/gi, "tomorrow"],
      [/\b2morrow\b/gi, "tomorrow"],
      [/\btmrw\b/gi, "tomorrow"],
      [/\btomorroy\b/gi, "tomorrow"],
      [/\btodat\b/gi, "today"],
      [/\btody\b/gi, "today"],
      [/\btooday\b/gi, "today"],
      [/\byesteray\b/gi, "yesterday"],
      [/\byesteday\b/gi, "yesterday"],
      [/\byesturday\b/gi, "yesterday"],
      [/\bnext\s+wek\b/gi, "next week"],
      [/\bthis\s+wek\b/gi, "this week"],
      [/\bteh\s+week\b/gi, "the week"]
    ];
    for (const [re, replacement] of replacements) {
      t = t.replace(re, replacement);
    }
    return t;
  }

  const MES = {
    // Spanish
    enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
    // English
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
  };

  /**
   * Detecta "session X of course Y" / "sesión X de curso Y": extrae sessionNumber y courseQuery.
   * Solo aplica cuando hay número de sesión Y texto de curso. Variantes: session 13, Ses. 13, sesión 13, etc.
   * @returns {{ sessionNumber: number, courseQuery: string } | null}
   */
  function parseSessionXOfCourseY(text) {
    if (!text || typeof text !== "string") return null;
    const t = text.trim();
    // Session number: "session 13", "Ses. 13", "Ses 13", "session number 13", "sesión 13"
    const sessionNumMatch = t.match(/\b(?:session|ses\.?|sesi[oó]n)\s*(?:number\s*)?#?\s*(\d+)\b/i) ||
      t.match(/\b(\d+)\s*(?:st|nd|rd|th)?\s*(?:session|ses\.?|sesi[oó]n)\b/i);
    const sessionNumber = sessionNumMatch ? parseInt(sessionNumMatch[1], 10) : null;
    if (sessionNumber == null || sessionNumber < 1) return null;
    // Course: "of Cost Accounting", "of course Physics", "in Microeconomics", "de contabilidad", "del curso X"
    const ofMatch = t.match(/\b(?:of\s+(?:the\s+)?(?:course\s+)?|in\s+|for\s+|de\s+|del?\s+curso?\s*)([^.?]+?)(?:\s*\?|$|\.)/i) ||
      t.match(/\b(?:of|in|for|de)\s+([^.?]+)/i);
    const courseQuery = ofMatch ? ofMatch[1].trim() : "";
    if (!courseQuery || courseQuery.length < 2) return null;
    return { sessionNumber, courseQuery };
  }

  /**
   * Detects questions about asynchronous sessions/classes shown in the Blackboard calendar.
   * These events are identified by the word "Asynchronous" in the calendar item title.
   */
  function isAsynchronousSessionQuery(text) {
    if (!text || typeof text !== "string") return false;
    const t = normalizeTemporalSpelling(text).toLowerCase().trim();
    const mentionsAsync =
      /\basynchronous\b/i.test(t) ||
      /\basync\b/i.test(t);
    const asksCalendarInfo =
      /\bwhen\b/i.test(t) ||
      /\bnext\b/i.test(t) ||
      /\bdate\b|\bdates\b/i.test(t) ||
      /\bwhat\b/i.test(t) ||
      /\blist\b/i.test(t) ||
      /\bshow\b/i.test(t) ||
      /\bdo\s+i\s+have\b/i.test(t) ||
      /\bmy\b/i.test(t) ||
      /\bsession\b|\bsessions\b|\bclass\b|\bclasses\b/i.test(t);
    return mentionsAsync && asksCalendarInfo;
  }

  /**
   * Detects questions about the user's free weekdays.
   * A free day is a weekday with no classes, or with only asynchronous sessions.
   */
  function isFreeDayQuery(text) {
    if (!text || typeof text !== "string") return false;
    const t = normalizeTemporalSpelling(text).toLowerCase().trim();
    return (
      /\bfree\s+day\b|\bfree\s+days\b/i.test(t) ||
      /\bday\s+off\b|\bdays\s+off\b/i.test(t) ||
      /\bwhen\s+am\s+i\s+free\b/i.test(t) ||
      /\bwhich\s+days?\s+am\s+i\s+free\b/i.test(t) ||
      /\bwhat\s+days?\s+am\s+i\s+free\b/i.test(t) ||
      /\bwhich\s+days?\s+do\s+i\s+have\s+free\b/i.test(t) ||
      /\bwhat\s+days?\s+do\s+i\s+have\s+free\b/i.test(t) ||
      /\bnext\s+free\s+day\b/i.test(t) ||
      /\bno\s+classes\b/i.test(t) ||
      /\bwithout\s+classes\b/i.test(t)
    );
  }

  /**
   * Detecta si es una pregunta de calendario (sesiones/clases en un día, cuándo es la sesión X, etc.).
   * Normaliza typos en palabras temporales (tmorrow→tomorrow, etc.) para no fallar por errores de escritura.
   */
  function isCalendarQuery(text) {
    if (parseSessionXOfCourseY(text)) return true;
    if (isAsynchronousSessionQuery(text)) return true;
    if (isFreeDayQuery(text)) return true;
    const normalized = normalizeTemporalSpelling(text || "");
    const t = normalized.toLowerCase();
    const hasSessionClassWord =
      /\b(session|sessions|class|classes|clase|clases|sesi[oó]n|sesiones)\b/i.test(t) ||
      /\b(what\s+do\s+I\s+have|what\s+do\s+we\s+have|what('s| is)\s+on|my\s+schedule|schedule\s+for)\b/i.test(t);
    const hasTimeExpr =
      /\b(tomorrow|today|yesterday|next\s+week|this\s+week|mañana|hoy|ayer)\b/i.test(t) ||
      /\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|mi[eé]rcoles|jueves|viernes)\b/i.test(t) ||
      /\bwhen\s+(is|do)\b|\bwhat\s+(sessions|classes)\s+(do\s+i\s+have|we\s+have)\b/i.test(t) ||
      /\bwhat\s+day\s+is\b/i.test(t) ||
      /\bcu[aá]ndo\s+(es|tenemos)\b|\bqu[eé]\s+(sesiones|clases)\s+(tengo|tenemos)\b/i.test(t) ||
      /\bday\s+after\s+tomorrow\b|\bpasado\s+ma[nñ]ana\b/i.test(t);
    return hasSessionClassWord && hasTimeExpr;
  }

  /**
   * A partir de la pregunta del usuario, devuelve { since, until } para el GET.
   * Usa refDate como "hoy" (fecha del TimeContext) para mañana, semana que viene, etc.
   * refDate: Date o { epochMs } (si no se pasa, se usa new Date()).
   * Para "session X of course Y" se fuerza since = now-120d, until = now+120d.
   */
  function getParamsForCalendarQuestion(text, refDate) {
    const normalized = normalizeTemporalSpelling((text || "").trim());
    const t = normalized.toLowerCase();
    const now = refDate instanceof Date ? refDate : (refDate && (refDate.epochMs != null || refDate.nowIso)) ? new Date(refDate.epochMs != null ? refDate.epochMs : refDate.nowIso) : new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate();

    const sessionXOfCourseY = parseSessionXOfCourseY(text);
    if (sessionXOfCourseY) {
      const fromDate = addDays(now, -120);
      const toDate = addDays(now, 120);
      return {
        since: toSince(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate()),
        until: toUntil(toDate.getFullYear(), toDate.getMonth(), toDate.getDate())
      };
    }

    if (isAsynchronousSessionQuery(text)) {
      const fromDate = addDays(now, -20);
      const toDate = addDays(now, 120);
      return {
        since: toSince(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate()),
        until: toUntil(toDate.getFullYear(), toDate.getMonth(), toDate.getDate())
      };
    }

    if (isFreeDayQuery(text)) {
      const fromDate = addDays(now, -20);
      const toDate = addDays(now, 100);
      return {
        since: toSince(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate()),
        until: toUntil(toDate.getFullYear(), toDate.getMonth(), toDate.getDate())
      };
    }

    if (/\btoday\b|^hoy\b|\bhoy\s/i.test(t)) {
      return { since: toSince(y, m, d), until: toUntil(y, m, d) };
    }
    // "yesterday" / "ayer" → día inmediatamente anterior.
    if (/\byesterday\b|\bayer\b/i.test(t)) {
      const yest = addDays(now, -1);
      const yy = yest.getFullYear(), ym = yest.getMonth(), yd = yest.getDate();
      return { since: toSince(yy, ym, yd), until: toUntil(yy, ym, yd) };
    }
    if (/\btomorrow\b|ma[nñ]ana\b|manana\b/i.test(t)) {
      const tom = addDays(now, 1);
      const ty = tom.getFullYear(), tm = tom.getMonth(), td = tom.getDate();
      return { since: toSince(ty, tm, td), until: toUntil(ty, tm, td) };
    }
    if (/\bday\s+after\s+tomorrow\b|pasado\s+ma[nñ]ana\b/i.test(t)) {
      const dat = addDays(now, 2);
      const ty = dat.getFullYear(), tm = dat.getMonth(), td = dat.getDate();
      return { since: toSince(ty, tm, td), until: toUntil(ty, tm, td) };
    }
    // "last Monday", "past Monday", "lunes pasado", etc. → el día de esa semana anterior (nunca el futuro).
    if (/\b(last|past)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t) ||
      /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s+pasado\b/i.test(t)) {
      const engMatch = t.match(/\b(last|past)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
      const esMatch = !engMatch && t.match(/\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s+pasado\b/i);
      let name = "";
      if (engMatch) {
        name = (engMatch[2] || "").toLowerCase();
      } else if (esMatch) {
        name = (esMatch[1] || "").toLowerCase().replace(/é/g, "e").replace(/á/g, "a");
      }
      const targetDow = WEEKDAY[name];
      if (targetDow != null) {
        const cur = now.getDay();
        let daysBack = cur - targetDow;
        if (daysBack <= 0) daysBack += 7;
        const target = addDays(now, -daysBack);
        const ty = target.getFullYear(), tm = target.getMonth(), td = target.getDate();
        return { since: toSince(ty, tm, td), until: toUntil(ty, tm, td) };
      }
    }
    if (/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t)) {
      const match = t.match(/next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
      const targetDow = WEEKDAY[(match && match[1] || "").toLowerCase()];
      if (targetDow != null) {
        const cur = now.getDay();
        let days = targetDow - cur;
        if (days <= 0) days += 7;
        const target = addDays(now, days);
        const ty = target.getFullYear(), tm = target.getMonth(), td = target.getDate();
        return { since: toSince(ty, tm, td), until: toUntil(ty, tm, td) };
      }
    }
    if (/\b(on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t)) {
      const match = t.match(/(?:on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
      const name = (match && match[1] || "").toLowerCase();
      const targetDow = WEEKDAY[name];
      if (targetDow != null) {
        const cur = now.getDay();
        let days;
        if (/\bnext\s+week\b|\bthis\s+week\b/i.test(t)) {
          const nextMondayDays = cur === 0 ? 1 : cur === 1 ? 7 : 8 - cur;
          days = nextMondayDays + (targetDow === 0 ? 6 : targetDow - 1);
        } else {
          days = targetDow - cur;
          if (days < 0) days += 7;
          if (days === 0) days = 7;
        }
        const target = addDays(now, days);
        const ty = target.getFullYear(), tm = target.getMonth(), td = target.getDate();
        return { since: toSince(ty, tm, td), until: toUntil(ty, tm, td) };
      }
    }
    if (/\b(el\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i.test(t)) {
      const match = t.match(/(?:el\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)/i);
      const name = (match && match[1] || "").toLowerCase().replace(/é/g, "e").replace(/á/g, "a");
      const targetDow = WEEKDAY[name];
      if (targetDow != null) {
        const cur = now.getDay();
        let days;
        if (/\bsemana\s+que\s+viene\b|pr[oó]xima\s+semana\b/i.test(t)) {
          const nextMondayDays = cur === 0 ? 1 : cur === 1 ? 7 : 8 - cur;
          days = nextMondayDays + (targetDow === 0 ? 6 : targetDow - 1);
        } else {
          days = targetDow - cur;
          if (days < 0) days += 7;
          if (days === 0) days = 7;
        }
        const target = addDays(now, days);
        const ty = target.getFullYear(), tm = target.getMonth(), td = target.getDate();
        return { since: toSince(ty, tm, td), until: toUntil(ty, tm, td) };
      }
    }
    if (/\b\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i.test(t)) {
      const match = t.match(/(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i);
      if (match) {
        const day = parseInt(match[1], 10);
        const mesStr = (match[2] || "").toLowerCase().replace(/í/g, "i");
        const month = MES[mesStr];
        if (month != null && day >= 1 && day <= 31) {
          let year = y;
          const that = new Date(year, month, day);
          if (that < now && that.getMonth() === month && that.getDate() === day) year += 1;
          return { since: toSince(year, month, day), until: toUntil(year, month, day) };
        }
      }
    }
    // English date patterns: "March 18", "18 March", "18 of March"
    if (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/i.test(t)) {
      const match = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\b/i);
      if (match) {
        const monthStr = (match[1] || "").toLowerCase();
        const day = parseInt(match[2], 10);
        const month = MES[monthStr];
        if (month != null && day >= 1 && day <= 31) {
          let year = y;
          const that = new Date(year, month, day);
          if (that < now && that.getMonth() === month && that.getDate() === day) year += 1;
          return { since: toSince(year, month, day), until: toUntil(year, month, day) };
        }
      }
    }
    if (/\b\d{1,2}\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(t)) {
      const match = t.match(/(\d{1,2})\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\b/i);
      if (match) {
        const day = parseInt(match[1], 10);
        const monthStr = (match[2] || "").toLowerCase();
        const month = MES[monthStr];
        if (month != null && day >= 1 && day <= 31) {
          let year = y;
          const that = new Date(year, month, day);
          if (that < now && that.getMonth() === month && that.getDate() === day) year += 1;
          return { since: toSince(year, month, day), until: toUntil(year, month, day) };
        }
      }
    }
    if (/\bsession\s*\d+|sesi[oó]n\s*\d+|when\s+is\s+the\s+next\s+session\b/i.test(t)) {
      const end = addDays(now, 60);
      const ey = end.getFullYear(), em = end.getMonth(), ed = end.getDate();
      return { since: toSince(y, m, d), until: toUntil(ey, em, ed) };
    }
    return { since: toSince(y, m, d), until: toUntil(y, m, d) };
  }

  global.Calendar = {
    isCalendarQuery,
    getParamsForCalendarQuestion,
    parseSessionXOfCourseY,
    isAsynchronousSessionQuery,
    isFreeDayQuery
  };
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : this);
