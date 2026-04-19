import assert from "node:assert";
import { detectMidtermQuery, gatherMidtermEvidence } from "../midtermDates.js";

function run(name, fn) {
  return (async () => {
    try {
      await Promise.resolve(fn());
      console.log("  ok " + name);
    } catch (e) {
      console.error("  FAIL " + name);
      throw e;
    }
  })();
}

(async () => {
  console.log("midtermDates.detectMidtermQuery");
  await run("all midterms — 'when are all my midterms'", () => {
    const r = detectMidtermQuery("when are all my midterms?");
    assert.ok(r);
    assert.strictEqual(r.isAll, true);
  });
  await run("all midterms — 'midterm dates'", () => {
    const r = detectMidtermQuery("midterm dates");
    assert.ok(r);
    assert.strictEqual(r.isAll, true);
  });
  await run("all midterms — 'when are the midterms'", () => {
    const r = detectMidtermQuery("when are the midterms?");
    assert.ok(r);
    assert.strictEqual(r.isAll, true);
  });
  await run("all midterms — 'all intermediate exams'", () => {
    const r = detectMidtermQuery("show me all my intermediate exam dates");
    assert.ok(r);
    assert.strictEqual(r.isAll, true);
  });
  await run("all midterms — Spanish 'cuando son los parciales'", () => {
    const r = detectMidtermQuery("cuando son los parciales?");
    assert.ok(r);
    assert.strictEqual(r.isAll, true);
  });
  await run("single midterm — 'when is the midterm of statistics'", () => {
    const r = detectMidtermQuery("when is the midterm of statistics?");
    assert.ok(r);
    assert.strictEqual(r.isSingle, true);
    assert.strictEqual(r.isAll, false);
  });
  await run("single midterm — 'date of the intermediate exam for finance'", () => {
    const r = detectMidtermQuery("date of the intermediate exam for finance");
    assert.ok(r);
    assert.strictEqual(r.isSingle, true);
  });
  await run("not a midterm query", () => {
    assert.strictEqual(detectMidtermQuery("what is the syllabus about?"), null);
    assert.strictEqual(detectMidtermQuery("when is the next class?"), null);
  });

  console.log("\nmidtermDates.gatherMidtermEvidence");
  await run("gathers evidence and returns prompt", async () => {
    const courses = [
      { courseId: "c1", courseName: "Statistics" },
      { courseId: "c2", courseName: "Finance" }
    ];
    const deps = {
      fetchSyllabusStructured: async () => ({
        rawText: "Session 15: Midterm Exam",
        sessions: [{ sessionNumber: 15, title: "Midterm Exam", description: "In-class exam" }],
        evaluation: [{ name: "Midterm", percentage: "30%", description: "Written exam" }]
      }),
      fetchCalendar: async () => ({
        ok: true,
        items: [{
          title: "Session 15",
          calendarName: "X: Statistics",
          startDate: "2025-03-15T09:00:00Z"
        }]
      }),
      fetchAnnouncements: async () => ({ list: [] })
    };
    const result = await gatherMidtermEvidence("when are all my midterms", courses, new Date(), deps);
    assert.strictEqual(result.ok, true);
    assert.ok(result.systemContent.includes("Statistics"));
    assert.ok(result.systemContent.includes("Finance"));
    assert.ok(result.systemContent.includes("Midterm Exam"));
    assert.ok(result.systemContent.includes("Session 15"));
    assert.ok(result.systemContent.includes("[RESOLVED]"), "syllabus→calendar matching must produce [RESOLVED]");
    assert.ok(result.systemContent.includes("March 15, 2025"), "matched date must appear in prompt");
    assert.strictEqual(result.userContent, "when are all my midterms");
  });

  await run("handles empty courses", async () => {
    const result = await gatherMidtermEvidence("midterms", [], new Date(), {});
    assert.strictEqual(result.ok, false);
  });

  await run("handles syllabus error gracefully", async () => {
    const deps = {
      fetchSyllabusStructured: async () => { throw new Error("fail"); },
      fetchCalendar: async () => ({ ok: true, items: [] }),
      fetchAnnouncements: async () => ({ list: [] })
    };
    const result = await gatherMidtermEvidence("midterms", [{ courseId: "c1", courseName: "X" }], new Date(), deps);
    assert.strictEqual(result.ok, true);
    assert.ok(result.systemContent.includes("not available"));
  });

  console.log("\nAll midtermDates tests passed.");
})();
