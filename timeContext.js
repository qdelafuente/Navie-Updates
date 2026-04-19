/**
 * Time Context global — fuente de verdad = reloj del dispositivo.
 * getNowContext(), parseBbDateToEpoch(), inyección al prompt de la IA.
 */
(function (global) {
  "use strict";

  const STORAGE_KEY_CONTEXT = "timeContext_nowContext";
  const STORAGE_KEY_UPDATED = "timeContext_lastUpdated";

  /**
   * Devuelve el contexto de fecha/hora actual del dispositivo.
   * @returns {{ nowIso: string, timezone: string, offsetMinutes: number, localIso: string, epochMs: number }}
   */
  function getNowContext() {
    const now = new Date();
    const opts = Intl.DateTimeFormat().resolvedOptions();
    const timezone = opts.timeZone || "";
    const offsetMinutes = now.getTimezoneOffset();
    const localIso = now.toLocaleString("sv-SE", { timeZone: timezone });
    return {
      nowIso: now.toISOString(),
      timezone,
      offsetMinutes,
      localIso,
      epochMs: Date.now()
    };
  }

  /**
   * Parsea una fecha de Blackboard a epoch ms.
   * Si viene ISO con zona (Z o ±HH:MM), se usa tal cual.
   * Si viene sin zona, se interpreta como timezone del usuario (local).
   * @param {string} dueDateString - Fecha en ISO o similar
   * @returns {number|null} epoch en ms o null si no parseable
   */
  function parseBbDateToEpoch(dueDateString) {
    if (dueDateString == null || dueDateString === "") return null;
    const s = String(dueDateString).trim();
    if (!s) return null;
    const hasOffset = /[Zz+-]\d{2}:?\d{2}$/.test(s) || s.endsWith("Z");
    let ms;
    if (hasOffset) {
      ms = new Date(s).getTime();
    } else {
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return null;
      ms = d.getTime();
    }
    return Number.isNaN(ms) ? null : ms;
  }

  /**
   * Formato legible de hora (ej. "12:10") y fecha (ej. "17 de febrero de 2025") desde localIso.
   */
  function formatTimeForResponse(localIso, timezone) {
    if (!localIso) return { time: "", date: "" };
    const d = new Date(localIso.replace(" ", "T"));
    if (Number.isNaN(d.getTime())) return { time: localIso, date: "" };
    const time = d.toLocaleTimeString("en-US", { timeZone: timezone || undefined, hour: "2-digit", minute: "2-digit" });
    const date = d.toLocaleDateString("en-US", { timeZone: timezone || undefined, weekday: "long", day: "numeric", month: "long", year: "numeric" });
    return { time, date };
  }

  /**
   * Compact time block for the prompt (English).
   */
  function buildTimeContextBlock(ctx) {
    if (!ctx) ctx = getNowContext();
    const { time, date } = formatTimeForResponse(ctx.localIso, ctx.timezone);
    const timeForResponse = time && date ? "It is " + time + " on " + date : ctx.localIso;
    return (
      "[TIME_CONTEXT] nowIso=" + ctx.nowIso + " localTime=" + ctx.localIso + " timezone=" + ctx.timezone +
      " epochMs=" + ctx.epochMs + " | For time/date say: " + timeForResponse + " [/TIME_CONTEXT]"
    );
  }

  async function persistNowContext() {
    const ctx = getNowContext();
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local) {
        await chrome.storage.local.set({
          [STORAGE_KEY_CONTEXT]: ctx,
          [STORAGE_KEY_UPDATED]: ctx.epochMs
        });
      }
    } catch (_) {}
    return ctx;
  }

  async function getStoredNowContext() {
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local) {
        const o = await chrome.storage.local.get([STORAGE_KEY_CONTEXT, STORAGE_KEY_UPDATED]);
        return o[STORAGE_KEY_CONTEXT] || null;
      }
    } catch (_) {}
    return null;
  }

  const TZ_MADRID = "Europe/Madrid";

  /** Último domingo de marzo y octubre para DST Madrid (aproximado). */
  function lastSunday(year, month) {
    const d = new Date(Date.UTC(year, month, 1, 12, 0, 0));
    const last = new Date(Date.UTC(year, month + 1, 0, 12, 0, 0));
    let day = last.getUTCDay();
    const diff = day === 0 ? 0 : 7 - day;
    return last.getUTCDate() - diff;
  }

  function getMadridOffsetMs(year, monthZeroBased, day) {
    const lastMar = lastSunday(year, 2);
    const lastOct = lastSunday(year, 9);
    const d = day;
    const m = monthZeroBased + 1;
    if (m < 3 || (m === 3 && d < lastMar)) return 3600000;
    if (m > 10 || (m === 10 && d > lastOct)) return 3600000;
    return 7200000;
  }

  /** Fecha “hoy” en Madrid como { year, month (1-12), day }. */
  function getTodayInMadrid() {
    const now = new Date();
    const s = now.toLocaleDateString("en-CA", { timeZone: TZ_MADRID });
    const [y, m, d] = s.split("-").map(Number);
    return { year: y, month: m, day: d };
  }

  function addDays(y, m, d, days) {
    const date = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }

  /** Convierte medianoche Madrid (y,m,d) a ISO UTC. */
  function midnightMadridToISO(y, m, d, endOfDay) {
    const offsetMs = getMadridOffsetMs(y, m - 1, d);
    if (!endOfDay) {
      return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - offsetMs).toISOString();
    }
    return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - offsetMs).toISOString();
  }

  /** Hoy: [hoy 00:00 Madrid, mañana 00:00 Madrid) en UTC. */
  function rangeToday() {
    const t = getTodayInMadrid();
    const tomorrow = addDays(t.year, t.month, t.day, 1);
    return {
      since: midnightMadridToISO(t.year, t.month, t.day, false),
      until: midnightMadridToISO(tomorrow.year, tomorrow.month, tomorrow.day, false)
    };
  }

  /** Mañana: [mañana 00:00 Madrid, pasado mañana 00:00 Madrid) en UTC. */
  function rangeTomorrow() {
    const t = getTodayInMadrid();
    const tom = addDays(t.year, t.month, t.day, 1);
    const dayAfter = addDays(tom.year, tom.month, tom.day, 1);
    return {
      since: midnightMadridToISO(tom.year, tom.month, tom.day, false),
      until: midnightMadridToISO(dayAfter.year, dayAfter.month, dayAfter.day, false)
    };
  }

  /** Lunes de la semana (Madrid) que contiene el día (y,m,d) en Madrid. */
  function getMondayOfWeek(y, m, d) {
    const offsetMs = getMadridOffsetMs(y, m - 1, d);
    const midnightUtc = Date.parse(midnightMadridToISO(y, m, d, false));
    const madridWeekday = new Date(midnightUtc + offsetMs).getUTCDay();
    const daysBack = madridWeekday === 0 ? 6 : madridWeekday - 1;
    return addDays(y, m, d, -daysBack);
  }

  function rangeThisWeek() {
    const t = getTodayInMadrid();
    const mon = getMondayOfWeek(t.year, t.month, t.day);
    const sun = addDays(mon.year, mon.month, mon.day, 6);
    return {
      since: midnightMadridToISO(mon.year, mon.month, mon.day, false),
      until: midnightMadridToISO(sun.year, sun.month, sun.day, true)
    };
  }

  function rangeNextWeek() {
    const t = getTodayInMadrid();
    const mon = getMondayOfWeek(t.year, t.month, t.day);
    const nextMon = addDays(mon.year, mon.month, mon.day, 7);
    const nextSun = addDays(nextMon.year, nextMon.month, nextMon.day, 6);
    return {
      since: midnightMadridToISO(nextMon.year, nextMon.month, nextMon.day, false),
      until: midnightMadridToISO(nextSun.year, nextSun.month, nextSun.day, true)
    };
  }

  function rangeCustom(daysAhead) {
    const now = new Date();
    const since = now.toISOString();
    const end = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    const until = end.toISOString();
    return { since, until };
  }

  /** Próximos X días: desde ahora hasta now + X días (UTC). Para "próximos assignments". */
  function rangeFromNow(daysAhead) {
    const now = new Date();
    const until = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    return { since: now.toISOString(), until: until.toISOString() };
  }

  const api = {
    getNowContext,
    parseBbDateToEpoch,
    buildTimeContextBlock,
    persistNowContext,
    getStoredNowContext,
    rangeToday,
    rangeTomorrow,
    rangeThisWeek,
    rangeNextWeek,
    rangeCustom,
    rangeFromNow,
    TZ_MADRID,
    STORAGE_KEY_CONTEXT,
    STORAGE_KEY_UPDATED
  };

  if (typeof global !== "undefined") {
    global.TimeContext = api;
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : this);
