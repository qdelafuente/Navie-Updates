/**
 * Tests for midtermSessionDetector.js
 */
import { detectMidtermSession, extractMidtermFromAnnouncements, extractMidtermFromMessages, resolveMidtermSession } from "../midtermSessionDetector.js";

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
  console.log("midtermSessionDetector tests\n");

  await run("Example A: explicit SESSION 14 MID-TERM EXAM", () => {
    const text = `
Program / Sessions
SESSION 1 (LIVE IN-PERSON)
Introduction
SESSION 14 (LIVE IN-PERSON)

MID-TERM EXAM

Scope: All content learned so far
SESSION 15
Continue...
`;
    const r = detectMidtermSession(text);
    if (r.midterm_session !== 14) throw new Error("Expected midterm_session 14, got " + r.midterm_session);
    if (r.confidence < 0.9) throw new Error("Expected high confidence, got " + r.confidence);
    if (!r.reason.toLowerCase().includes("mid-term") && !r.reason.toLowerCase().includes("exam")) throw new Error("Reason should mention midterm/exam");
  });

  await run("Example B: SESSION 20 MIDTERM EXAM with alternatives 18 or 19", () => {
    const text = `
SESSION 20: MIDTERM EXAM (Exam via BlackBoard Ultra)
Module 1: Topics covered...
Please note that this date is tentative. Depending on the class pace the midterm exam could take place either in session 18 or in session 19.
`;
    const r = detectMidtermSession(text);
    if (r.midterm_session !== 20 && r.midterm_session !== 18) throw new Error("Expected 20 or 18 as primary, got " + r.midterm_session);
    const hasAlt = (r.candidates && r.candidates.includes(18)) || (r.candidates && r.candidates.includes(19));
    if (!hasAlt && r.midterm_session === 20) throw new Error("Expected 18 or 19 in candidates when primary is 20");
  });

  await run("Explicit sentence: midterm will take place in session 20", () => {
    const text = "The midterm exam will take place in session 20. Please be prepared.";
    const r = detectMidtermSession(text);
    if (r.midterm_session !== 20) throw new Error("Expected 20, got " + r.midterm_session);
    if (r.confidence < 0.9) throw new Error("Expected high confidence");
  });

  await run("No midterm: empty or short text returns null", () => {
    const r1 = detectMidtermSession("");
    if (r1.midterm_session != null) throw new Error("Empty should return null");
    const r2 = detectMidtermSession("Session 1: Introduction. Session 2: Basics.");
    if (r2.midterm_session != null) throw new Error("No midterm mention should return null");
  });

  await run("Spanish: parcial in session", () => {
    const text = "SESIÓN 15: EXAMEN PARCIAL. Alcance: todo el contenido.";
    const r = detectMidtermSession(text);
    if (r.midterm_session !== 15) throw new Error("Expected 15, got " + r.midterm_session);
  });

  console.log("\nresolveMidtermSession tests\n");

  await run("1) Announcement explicit session overrides syllabus", () => {
    const syllabus = "SESSION 14 (LIVE) MID-TERM EXAM scope";
    const announcements = [
      { id: "a1", title: "Midterm Exam Instructions – Session 15", body: "midterm exam in Session 15", createdAt: "2026-02-27T09:28:37.150Z" }
    ];
    const r = resolveMidtermSession(syllabus, announcements);
    if (r.midterm_session !== 15) throw new Error("Expected 15 (announcement), got " + r.midterm_session);
    if (r.source !== "announcement") throw new Error("Expected source=announcement, got " + r.source);
    if (r.confidence < 0.75) throw new Error("Expected high confidence");
  });

  await run("2) Reschedule from X to Y overrides everything", () => {
    const syllabus = "SESSION 14 MID-TERM EXAM";
    const announcements = [
      { id: "a1", title: "Update", body: "The midterm has been moved from session 14 to session 18. Please note the change.", createdAt: "2026-03-01T10:00:00Z" }
    ];
    const r = resolveMidtermSession(syllabus, announcements);
    if (r.midterm_session !== 18) throw new Error("Expected 18 (new session), got " + r.midterm_session);
    if (r.source !== "announcement") throw new Error("Expected source=announcement");
    if (r.confidence < 0.9) throw new Error("Expected very high confidence");
  });

  await run("3) Announcement ambiguous - choose most recent/high score", () => {
    const announcements = [
      { id: "a1", title: "Midterm session", body: "midterm in session 10", createdAt: "2026-02-20T10:00:00Z" },
      { id: "a2", title: "Midterm update", body: "midterm will be in session 12", createdAt: "2026-02-25T10:00:00Z" }
    ];
    const r = resolveMidtermSession("", announcements);
    if (r.midterm_session !== 12) throw new Error("Expected 12 (more recent), got " + r.midterm_session);
  });

  await run("4) Midterm review does NOT override unless explicit session", () => {
    const syllabus = "SESSION 14 MID-TERM EXAM";
    const announcements = [
      { id: "a1", title: "Midterm review", body: "Remember to study for the midterm. Good luck!", createdAt: "2026-02-27T10:00:00Z" }
    ];
    const r = resolveMidtermSession(syllabus, announcements);
    if (r.midterm_session !== 14) throw new Error("Expected 14 (syllabus), got " + r.midterm_session);
    if (r.source !== "syllabus") throw new Error("Expected source=syllabus");
  });

  await run("5) No mention anywhere -> null", () => {
    const r = resolveMidtermSession("Session 1: Intro. Session 2: Basics.", []);
    if (r.midterm_session != null) throw new Error("Expected null, got " + r.midterm_session);
    if (r.source !== "none") throw new Error("Expected source=none");
  });

  await run("6) Empty announcements uses syllabus", () => {
    const syllabus = "SESSION 14 (LIVE) MID-TERM EXAM scope";
    const r = resolveMidtermSession(syllabus, []);
    if (r.midterm_session !== 14) throw new Error("Expected 14, got " + r.midterm_session);
    if (r.source !== "syllabus") throw new Error("Expected source=syllabus");
  });

  console.log("\nextractMidtermFromMessages tests\n");

  const messageA = {
    id: "msgA",
    body: "Dear All, I just want to confirm that the midterm will be held on Tuesday March 03 at 11.00am.",
    createdAt: "2026-02-12T09:41:18.282Z"
  };
  const messageB = {
    id: "msgB",
    body: "... move the midterm from the scheduled March 2 date to March 3 ... otherwise the midterm will be rescheduled to Tuesday March 03 at 11.00am.",
    createdAt: "2026-02-04T10:48:15.018Z"
  };

  await run("extractMidtermFromMessages: Message A returns midterm_date=2026-03-03, midterm_time=11:00", () => {
    const r = extractMidtermFromMessages([messageA]);
    if (r.midterm_date !== "2026-03-03") throw new Error("Expected midterm_date 2026-03-03, got " + r.midterm_date);
    if (r.midterm_time !== "11:00") throw new Error("Expected midterm_time 11:00, got " + r.midterm_time);
    if (r.confidence < 0.9) throw new Error("Expected high confidence, got " + r.confidence);
  });

  await run("extractMidtermFromMessages: Message B (conditional) also extracts date", () => {
    const r = extractMidtermFromMessages([messageB]);
    if (!r.midterm_date || !r.midterm_date.includes("2026-03")) throw new Error("Expected midterm_date from Message B, got " + r.midterm_date);
  });

  await run("resolveMidtermSession: Message explicit date overrides syllabus session", () => {
    const syllabus = "SESSION 14 (LIVE) MID-TERM EXAM scope";
    const r = resolveMidtermSession(syllabus, [], [messageA]);
    if (r.midterm_date !== "2026-03-03") throw new Error("Expected midterm_date 2026-03-03, got " + r.midterm_date);
    if (r.midterm_time !== "11:00") throw new Error("Expected midterm_time 11:00, got " + r.midterm_time);
    if (r.source !== "message") throw new Error("Expected source=message, got " + r.source);
    if (r.midterm_session != null) throw new Error("Expected midterm_session null (date only), got " + r.midterm_session);
  });

  await run("resolveMidtermSession: Message reschedule from March 2 to March 3 overrides everything", () => {
    const syllabus = "SESSION 14 MID-TERM EXAM";
    const messages = [{
      id: "m1",
      body: "The midterm has been moved from March 2 to March 3. Please note.",
      createdAt: "2026-02-15T10:00:00Z"
    }];
    const r = resolveMidtermSession(syllabus, [], messages);
    if (r.midterm_date !== "2026-03-03") throw new Error("Expected midterm_date 2026-03-03, got " + r.midterm_date);
    if (r.source !== "message") throw new Error("Expected source=message, got " + r.source);
  });

  await run("resolveMidtermSession: Conditional reschedule then confirmation - later message wins", () => {
    const syllabus = "SESSION 14 MID-TERM EXAM";
    const messages = [
      { id: "m1", body: "Unless anyone objects, the midterm will be rescheduled to Tuesday March 03 at 11.00am.", createdAt: "2026-02-04T10:00:00Z" },
      { id: "m2", body: "I confirm the midterm will be held on Tuesday March 03 at 11.00am.", createdAt: "2026-02-12T09:41:00Z" }
    ];
    const r = resolveMidtermSession(syllabus, [], messages);
    if (r.midterm_date !== "2026-03-03") throw new Error("Expected midterm_date 2026-03-03, got " + r.midterm_date);
    if (r.source !== "message") throw new Error("Expected source=message, got " + r.source);
  });

  await run("resolveMidtermSession: Message + announcement conflict - newer wins", () => {
    const syllabus = "SESSION 14 MID-TERM EXAM";
    const announcements = [{ id: "a1", title: "Midterm", body: "midterm in session 15", createdAt: "2026-02-10T10:00:00Z" }];
    const messages = [{ id: "m1", body: "The midterm will be held in session 18.", createdAt: "2026-02-20T10:00:00Z" }];
    const r = resolveMidtermSession(syllabus, announcements, messages);
    if (r.midterm_session !== 18) throw new Error("Expected 18 (newer message), got " + r.midterm_session);
    if (r.source !== "message") throw new Error("Expected source=message, got " + r.source);
  });

  await run("resolveMidtermSession: Midterm review with date should NOT override (low confidence)", () => {
    const syllabus = "SESSION 14 MID-TERM EXAM";
    const messages = [{ id: "m1", body: "Midterm review session on March 5. Bring your notes.", createdAt: "2026-02-20T10:00:00Z" }];
    const r = resolveMidtermSession(syllabus, [], messages);
    if (r.midterm_session !== 14) throw new Error("Expected 14 (syllabus), midterm review should not override. Got " + r.midterm_session);
    if (r.source !== "syllabus") throw new Error("Expected source=syllabus, got " + r.source);
  });

  await run("resolveMidtermSession: No signals anywhere returns nulls", () => {
    const r = resolveMidtermSession("Session 1: Intro.", [], []);
    if (r.midterm_session != null) throw new Error("Expected null midterm_session, got " + r.midterm_session);
    if (r.midterm_date != null) throw new Error("Expected null midterm_date, got " + r.midterm_date);
    if (r.source !== "none") throw new Error("Expected source=none, got " + r.source);
  });

  await run("resolveMidtermSession: backward compat - two args still works", () => {
    const syllabus = "SESSION 14 (LIVE) MID-TERM EXAM scope";
    const announcements = [{ id: "a1", title: "Midterm", body: "midterm in session 15", createdAt: "2026-02-27T09:28:37.150Z" }];
    const r = resolveMidtermSession(syllabus, announcements);
    if (r.midterm_session !== 15) throw new Error("Expected 15 (announcement), got " + r.midterm_session);
    if (r.source !== "announcement") throw new Error("Expected source=announcement");
  });

  console.log("\nAll midtermSessionDetector tests passed.");
})();
