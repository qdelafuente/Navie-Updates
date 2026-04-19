/**
 * Tests for finalExamSessionDetector.js
 */
import {
  resolveFinalFromSyllabus,
  extractFinalFromAnnouncements,
  extractFinalFromMessages,
  resolveFinalSession
} from "../finalExamSessionDetector.js";

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
  console.log("finalExamSessionDetector tests\n");

  await run("SESSION 30 … Final Exam -> 30", () => {
    const text = `
PROGRAM
SESSION 1 Introduction
SESSION 29 Review
SESSION 30 Final Exam
Scope: All content.
`;
    const r = resolveFinalFromSyllabus(text);
    if (r.final_session !== 30) throw new Error("Expected final_session 30, got " + r.final_session);
    if (r.source !== "syllabus") throw new Error("Expected source syllabus");
    if (r.confidence < 0.9) throw new Error("Expected high confidence");
  });

  await run("Review for the final exam -> null (no explicit final exam session)", () => {
    const text = `
SESSION 15 Review for the final exam. Bring questions.
SESSION 16 TBD
`;
    const r = resolveFinalFromSyllabus(text);
    if (r.final_session != null) throw new Error("Expected null (review only), got " + r.final_session);
  });

  await run("Final project -> null", () => {
    const text = `
SESSION 28 Final project presentation
SESSION 29 Final project submission
`;
    const r = resolveFinalFromSyllabus(text);
    if (r.final_session != null) throw new Error("Expected null (final project), got " + r.final_session);
  });

  await run("Noisy HTML-ish: SESSION 30 [PRACTICE]: Final exam -> 30", () => {
    const text = "SESSION 30 [PRACTICE]: Final exam. Date TBD.";
    const r = resolveFinalFromSyllabus(text);
    if (r.final_session !== 30) throw new Error("Expected 30, got " + r.final_session);
  });

  await run("Fallback: final exam in the last session + Number of sessions: 30 -> 30", () => {
    const text = `
Program overview. Number of sessions: 30.
The final exam will be taken in the last session.
`;
    const r = resolveFinalFromSyllabus(text);
    if (r.final_session !== 30) throw new Error("Expected 30 (last session), got " + r.final_session);
    if (r.confidence < 0.7) throw new Error("Expected confidence >= 0.75");
  });

  await run("Only evaluation criteria 'Final Exam 50%' -> null", () => {
    const text = `
Evaluation:
Midterm 30%
Final Exam 50%
Participation 20%
`;
    const r = resolveFinalFromSyllabus(text);
    if (r.final_session != null) throw new Error("Expected null (evaluation only), got " + r.final_session);
  });

  await run("Final Examination (Session 12) style", () => {
    const text = `
SESSION 11 Recap. Q&A.

SESSION 12 Final Examination. Comprehensive.
`;
    const r = resolveFinalFromSyllabus(text);
    if (r.final_session !== 12) throw new Error("Expected 12, got " + r.final_session);
  });

  await run("extractFinalFromAnnouncements: reschedule to session 20", () => {
    const ann = [
      { id: "a1", title: "Final exam", body: "The final exam has been moved to session 20.", createdAt: "2026-03-01T00:00:00Z" }
    ];
    const r = extractFinalFromAnnouncements(ann);
    if (r.final_session !== 20) throw new Error("Expected 20, got " + r.final_session);
  });

  await run("resolveFinalSession: message overrides syllabus", () => {
    const syllabus = "SESSION 25 Final Exam.";
    const messages = [
      { id: "m1", body: "Final exam rescheduled to session 26. Please note.", createdAt: "2026-03-10T00:00:00Z" }
    ];
    const r = resolveFinalSession(syllabus, [], messages);
    if (r.final_session !== 26) throw new Error("Expected 26 (message), got " + r.final_session);
    if (r.source !== "message") throw new Error("Expected source message");
  });

  console.log("\nAll finalExamSessionDetector tests passed.");
})();
