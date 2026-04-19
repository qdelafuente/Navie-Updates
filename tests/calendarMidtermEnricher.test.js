/**
 * Tests for calendarMidtermEnricher.js
 */
import {
  buildCalendarWindow,
  normalizeText,
  parseCalendarSessionTokens,
  enrichMidtermWithCalendar,
  resolveMidterm
} from "../calendarMidtermEnricher.js";
import { resolveMidtermSession } from "../midtermSessionDetector.js";

async function run(name, fn) {
  try {
    await fn();
    console.log("✓", name);
  } catch (e) {
    console.error("✗", name, e);
    throw e;
  }
}

(async () => {
  console.log("calendarMidtermEnricher tests\n");

  await run("buildCalendarWindow returns sinceISO/untilISO 70 days around now", () => {
    const now = new Date("2026-03-08T12:00:00.000Z");
    const w = buildCalendarWindow(now, 70);
    const since = new Date(w.sinceISO);
    const until = new Date(w.untilISO);
    if (since.getTime() !== now.getTime() - 70 * 24 * 60 * 60 * 1000) throw new Error("since should be 70 days before");
    if (until.getTime() !== now.getTime() + 70 * 24 * 60 * 60 * 1000) throw new Error("until should be 70 days after");
  });

  await run("normalizeText collapses spaces and uppercases", () => {
    if (normalizeText("  PRINCIPLES  of  Programming  ") !== "PRINCIPLES OF PROGRAMMING") throw new Error("normalize mismatch");
  });

  await run('parseCalendarSessionTokens "(Ses. 17)" => [17]', () => {
    const r = parseCalendarSessionTokens("Class (Ses. 17)");
    if (!r.sessions.includes(17)) throw new Error("Expected 17 in sessions: " + JSON.stringify(r.sessions));
  });

  await run('parseCalendarSessionTokens "(Ses. 6-7)" => 6 and 7', () => {
    const r = parseCalendarSessionTokens("Topic (Ses. 6-7)");
    if (!r.sessions.includes(6) || !r.sessions.includes(7)) throw new Error("Expected 6 and 7: " + JSON.stringify(r.sessions));
  });

  await run('parseCalendarSessionTokens "Session 13 & 14" => 13 and 14', () => {
    const r = parseCalendarSessionTokens("Session 13 & 14");
    if (!r.sessions.includes(13) || !r.sessions.includes(14)) throw new Error("Expected 13 and 14: " + JSON.stringify(r.sessions));
  });

  await run("When message provides date, calendar is NOT called", async () => {
    let calendarCalled = false;
    const calendarClient = {
      getCalendarItems: async () => {
        calendarCalled = true;
        return { ok: true, items: [] };
      }
    };
    const syllabus = "SESSION 14 MID-TERM EXAM";
    const messages = [
      { id: "m1", body: "The midterm has been rescheduled to 2026-04-15. Please note.", createdAt: "2026-03-01T00:00:00Z" }
    ];
    const detector = { resolveMidtermSession };
    const result = await resolveMidterm(syllabus, [], messages, calendarClient, { courseId: "c1", courseTitle: "Course" }, detector);
    if (result.midterm_date !== "2026-04-15") throw new Error("Expected date from message, got " + result.midterm_date);
    if (calendarCalled) throw new Error("Calendar must not be called when date already exists");
    if (result.calendar_inferred !== false) throw new Error("calendar_inferred should be false");
  });

  await run("When no date but session exists, calendar is called and correct item matched", async () => {
    let callArgs = null;
    const calendarClient = {
      getCalendarItems: async (opts) => {
        callArgs = opts;
        return {
          ok: true,
          items: [
            {
              title: "PRINCIPLES OF PROGRAMMING (Ses. 14)",
              startDate: "2026-04-20T09:00:00.000Z",
              endDate: "2026-04-20T10:30:00.000Z",
              calendarNameLocalizable: { rawValue: "PRINCIPLES OF PROGRAMMING" },
              calendarId: "cal1"
            }
          ]
        };
      }
    };
    const resolved = {
      midterm_session: 14,
      midterm_date: null,
      midterm_time: null,
      timezone: null,
      evidence: [],
      reason: "syllabus"
    };
    const courseContext = { courseId: "c1", courseTitle: "PRINCIPLES OF PROGRAMMING", calendarId: null };
    const result = await enrichMidtermWithCalendar(resolved, calendarClient, courseContext);
    if (!callArgs || !callArgs.sinceISO || !callArgs.untilISO) throw new Error("Calendar should be called with sinceISO/untilISO");
    const since = new Date(callArgs.sinceISO);
    const until = new Date(callArgs.untilISO);
    const daysSpan = (until.getTime() - since.getTime()) / (24 * 60 * 60 * 1000);
    if (daysSpan < 155 || daysSpan > 165) throw new Error("Window should be ~160 days (20 back + 140 forward), got " + daysSpan);
    if (result.midterm_date !== "2026-04-20") throw new Error("Expected 2026-04-20, got " + result.midterm_date);
    if (result.midterm_time !== "09:00") throw new Error("Expected 09:00, got " + result.midterm_time);
    if (!result.calendar_inferred || !result.calendar_match?.matched) throw new Error("calendar_inferred and calendar_match.matched should be true");
  });

  await run("Duplicate calendar items: choose earliest startDate, candidateCount reflects duplicates", async () => {
    const calendarClient = {
      getCalendarItems: async () => ({
        ok: true,
        items: [
          { title: "Course (Ses. 10)", startDate: "2026-04-25T10:00:00.000Z", calendarNameLocalizable: { rawValue: "Course" }, calendarId: "c1" },
          { title: "Course (Ses. 10)", startDate: "2026-04-24T09:00:00.000Z", calendarNameLocalizable: { rawValue: "Course" }, calendarId: "c1" }
        ]
      })
    };
    const resolved = { midterm_session: 10, midterm_date: null, midterm_time: null, evidence: [], reason: "" };
    const result = await enrichMidtermWithCalendar(resolved, calendarClient, { courseId: "c1", courseTitle: "Course" });
    if (result.midterm_date !== "2026-04-24") throw new Error("Expected earliest 2026-04-24, got " + result.midterm_date);
    if (result.calendar_match?.candidateCount !== 2) throw new Error("Expected candidateCount 2, got " + result.calendar_match?.candidateCount);
  });

  await run("Wrong course calendar items ignored when session matches", async () => {
    const calendarClient = {
      getCalendarItems: async () => ({
        ok: true,
        items: [
          { title: "Other Course (Ses. 14)", startDate: "2026-04-20T09:00:00.000Z", calendarNameLocalizable: { rawValue: "Other Course" }, calendarId: "other" }
        ]
      })
    };
    const resolved = { midterm_session: 14, midterm_date: null, midterm_time: null, evidence: [], reason: "" };
    const result = await enrichMidtermWithCalendar(resolved, calendarClient, { courseId: "c1", courseTitle: "PRINCIPLES OF PROGRAMMING" });
    if (result.midterm_date != null) throw new Error("Expected null date (wrong course), got " + result.midterm_date);
    if (result.calendar_match?.matched !== false) throw new Error("calendar_match.matched should be false");
  });

  await run("No matching calendar item => date null, calendar_match.matched=false", async () => {
    const calendarClient = {
      getCalendarItems: async () => ({ ok: true, items: [] })
    };
    const resolved = { midterm_session: 99, midterm_date: null, midterm_time: null, evidence: [], reason: "" };
    const result = await enrichMidtermWithCalendar(resolved, calendarClient, { courseId: "c1", courseTitle: "Course" });
    if (result.midterm_date != null) throw new Error("Expected null date, got " + result.midterm_date);
    if (result.calendar_match?.matched !== false) throw new Error("calendar_match.matched should be false");
  });

  console.log("\nAll calendarMidtermEnricher tests passed.");
})();
