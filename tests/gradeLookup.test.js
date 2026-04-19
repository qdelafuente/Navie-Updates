/**
 * Unit tests for Assignment Grade Lookup: query parsing, fuzzy matching, response formatting.
 * Run: npm test  or  node tests/gradeLookup.test.js
 */
import assert from "node:assert";
import { parseAssignmentQuery, isAllGradesForCourseQuery, normalizeUserTextForGradeLookup, resolveCourseByMention, formatAllGradesResponse, buildGradeItemList, resolveCourseForAssignment, extractGradeFromEntry, getGradeForColumn, formatGradeResponse, getAssignmentGrade } from "../gradeLookupService.js";
import { normalizeForMatch, tokenize, tokenSetRatio, similarityScore, findBestMatch } from "../textMatch.js";

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
console.log("parseAssignmentQuery");
await run("strips what's my grade on", () => {
  const r = parseAssignmentQuery("What's my grade on the pendulum and freefall class participation?");
  assert.strictEqual(r.empty, false);
  assert.ok(r.assignmentQuery.toLowerCase().includes("pendulum"));
  assert.ok(r.assignmentQuery.toLowerCase().includes("freefall"));
});
await run("strips grade for", () => {
  const r = parseAssignmentQuery("Grade for Midterm Exam");
  assert.strictEqual(r.empty, false);
  assert.strictEqual(r.assignmentQuery.trim(), "Midterm Exam");
});
await run("phrase with no space after 'on' is not stripped", () => {
  const r = parseAssignmentQuery("What's my grade on?");
  assert.strictEqual(r.empty, false);
  assert.ok(r.assignmentQuery.length > 0); // no strip when no space after "on"
});
await run("empty for empty string", () => {
  const r = parseAssignmentQuery("");
  assert.strictEqual(r.empty, true);
});
await run("non-string returns empty", () => {
  const r = parseAssignmentQuery(null);
  assert.strictEqual(r.empty, true);
});

console.log("\nisAllGradesForCourseQuery & resolveCourseByMention");
await run("detects all assignments of [course]", () => {
  const r = isAllGradesForCourseQuery("whats my grade on all the assignments of fundamentals of data analysis?");
  assert.strictEqual(r.isAll, true);
  assert.strictEqual(r.courseMention, "fundamentals of data analysis");
});
await run("not all-grades query returns isAll false", () => {
  assert.strictEqual(isAllGradesForCourseQuery("What's my grade on the midterm?").isAll, false);
});
await run("detects 'the assignments of [course]' without 'all'", () => {
  const r = isAllGradesForCourseQuery("whats my grade on the assignments of cost accounting");
  assert.strictEqual(r.isAll, true);
  assert.strictEqual(r.courseMention, "cost accounting");
});
await run("detects 'what are my grades on the assignments of [course]'", () => {
  const r = isAllGradesForCourseQuery("what are my grades on the assignments of cost accounting?");
  assert.strictEqual(r.isAll, true);
  assert.strictEqual(r.courseMention, "cost accounting");
});
await run("detects assignments like only for [course] with filler words", () => {
  const r = isAllGradesForCourseQuery("hey what are my assignments like only for microecon?");
  assert.strictEqual(r.isAll, true);
  assert.ok(r.courseMention.toLowerCase().includes("micro"));
});
await run("detects give me all for [course] shorthand", () => {
  const r = isAllGradesForCourseQuery("give me all for microecon");
  assert.strictEqual(r.isAll, true);
  assert.ok(r.courseMention.toLowerCase().includes("micro"));
});
await run("normalizeUserTextForGradeLookup expands give me all for", () => {
  assert.ok(normalizeUserTextForGradeLookup("give me all for X").includes("all assignments for"));
});
await run("any assignments in [course] lists full gradebook for course", () => {
  const r = isAllGradesForCourseQuery("any assignments in microecon?");
  assert.strictEqual(r.isAll, true);
  assert.ok(r.courseMention.toLowerCase().includes("micro"));
});
await run("gimme the assigns in [course] normalizes and detects all-grades for course", () => {
  assert.ok(normalizeUserTextForGradeLookup("gimme the assigns in cost accounting").includes("give me"));
  assert.ok(normalizeUserTextForGradeLookup("gimme the assigns in cost accounting").includes("assignments"));
  const r = isAllGradesForCourseQuery("gimme the assigns in cost accounting");
  assert.strictEqual(r.isAll, true);
  assert.ok(String(r.courseMention).toLowerCase().includes("cost"));
});
await run("give me the ones in [course] lists full gradebook for course", () => {
  const r = isAllGradesForCourseQuery("give me the ones in microecon");
  assert.strictEqual(r.isAll, true);
  assert.ok(r.courseMention.toLowerCase().includes("micro"));
});
await run("resolveCourseByMention exact match", () => {
  const idByNorm = { "fundamentals of data analysis": "course_123" };
  const byId = { course_123: { name: "Fundamentals of Data Analysis" } };
  const r = resolveCourseByMention("fundamentals of data analysis", idByNorm, byId);
  assert.ok(r);
  assert.strictEqual(r.courseId, "course_123");
  assert.ok(r.courseName.includes("Fundamentals"));
});
await run("formatAllGradesResponse", () => {
  const out = formatAllGradesResponse("Physics", [
    { title: "Quiz 1", gradeText: "8/10", statusText: null },
    { title: "HW1", gradeText: null, statusText: "Submitted" }
  ]);
  assert.ok(out.includes("Here are your grades for Physics"));
  assert.ok(out.includes("Quiz 1"));
  assert.ok(out.includes("8/10"));
  assert.ok(out.includes("HW1"));
});

console.log("\ntextMatch (normalize, similarity, findBestMatch)");
await run("normalizeForMatch lowercases and collapses", () => {
  assert.strictEqual(normalizeForMatch("  Hello   World  "), "hello world");
  assert.strictEqual(normalizeForMatch("A-1 (Quiz)"), "a1 quiz");
});
await run("tokenize splits on whitespace", () => {
  assert.deepStrictEqual(tokenize("a b c"), ["a", "b", "c"]);
  assert.deepStrictEqual(tokenize("  one   two  "), ["one", "two"]);
});
await run("similarityScore exact match", () => {
  assert.ok(similarityScore("midterm", "midterm") >= 0.99);
});
await run("similarityScore partial match", () => {
  assert.ok(similarityScore("midterm exam", "Midterm Exam 1") > 0.7);
});
await run("similarityScore unrelated low", () => {
  assert.ok(similarityScore("xyz abc", "Homework 5") < 0.5);
});
await run("findBestMatch returns best above threshold", () => {
  const items = [{ title: "Homework 1" }, { title: "Midterm Exam" }, { title: "Final" }];
  const m = findBestMatch("midterm", items, 0.5);
  assert.ok(m);
  assert.strictEqual(m.title, "Midterm Exam");
  assert.ok(m.score >= 0.5);
});
await run("findBestMatch returns null below threshold", () => {
  const items = [{ title: "Homework 1" }, { title: "Final" }];
  const m = findBestMatch("midterm exam", items, 0.9);
  assert.strictEqual(m, null);
});

console.log("\nbuildGradeItemList & resolveCourseForAssignment");
await run("buildGradeItemList from gradebookByCourseId", () => {
  const g = {
    c1: { courseName: "Physics", columns: [{ id: "col1", title: "Quiz 1" }], assignments: [{ title: "Quiz 1", columnId: "col1" }] },
    c2: { courseName: "Math", columns: [{ id: "col2", title: "Midterm" }] }
  };
  const list = buildGradeItemList(g);
  assert.ok(list.length >= 1);
  const q = list.find((i) => i.title === "Quiz 1");
  assert.ok(q);
  assert.strictEqual(q.courseId, "c1");
  assert.strictEqual(q.columnId, "col1");
});
await run("resolveCourseForAssignment finds best course", () => {
  const g = {
    c1: { courseName: "Physics", columns: [{ id: "col1", title: "Pendulum Lab" }], assignments: [{ title: "Pendulum Lab", columnId: "col1" }] }
  };
  const r = resolveCourseForAssignment("pendulum lab", g);
  assert.ok(r);
  assert.strictEqual(r.courseId, "c1");
  assert.strictEqual(r.columnId, "col1");
  assert.strictEqual(r.title, "Pendulum Lab");
});
await run("resolveCourseForAssignment returns null for no match", () => {
  const g = { c1: { courseName: "Physics", columns: [{ id: "col1", title: "Quiz 1" }] } };
  const r = resolveCourseForAssignment("nonexistent assignment xyz", g);
  assert.strictEqual(r, null);
});

console.log("\nextractGradeFromEntry & getGradeForColumn");
await run("extractGradeFromEntry displayGrade.text", () => {
  const entry = { grade: { displayGrade: { text: "8/10" }, columnId: "c1" } };
  const out = extractGradeFromEntry(entry);
  assert.strictEqual(out.gradeText, "8/10");
});
await run("extractGradeFromEntry displayGrade.score", () => {
  const entry = { grade: { displayGrade: { score: 85 }, columnId: "c1" } };
  const out = extractGradeFromEntry(entry);
  assert.strictEqual(out.gradeText, "85");
});
await run("getGradeForColumn finds column", () => {
  const results = [
    { grade: { columnId: "col2", displayGrade: { text: "A-" } } },
    { grade: { columnId: "col1", displayGrade: { text: "9/10" } } }
  ];
  const out = getGradeForColumn(results, "col1");
  assert.ok(out);
  assert.strictEqual(out.gradeText, "9/10");
});
await run("getGradeForColumn returns null for missing column", () => {
  const results = [{ grade: { columnId: "col1", displayGrade: { text: "10" } } }];
  assert.strictEqual(getGradeForColumn(results, "col99"), null);
});

console.log("\nformatGradeResponse");
await run("formats graded item", () => {
  const out = formatGradeResponse({ title: "Quiz 1", gradeText: "8/10", statusText: null });
  assert.ok(out.includes("Your grade for"));
  assert.ok(out.includes("Quiz 1"));
  assert.ok(out.includes("8/10"));
});
await run("formats not graded item", () => {
  const out = formatGradeResponse({ title: "HW2", gradeText: null, statusText: "Submitted" });
  assert.ok(out.includes("currently Submitted"));
});
await run("formats no grade yet", () => {
  const out = formatGradeResponse({ title: "Final", gradeText: "—", statusText: null });
  assert.ok(out.includes("does not have a grade yet"));
});

console.log("\ngetAssignmentGrade (mocked)");
await run("empty query returns clarification", async () => {
  // Empty string yields empty: true; service returns clarification (need non-empty gradebook to reach parse step)
  const { assignmentQuery, empty } = parseAssignmentQuery("");
  assert.strictEqual(empty, true);
  const out = await getAssignmentGrade("", {
    gradebookByCourseId: { c1: { courseName: "X", columns: [] } },
    userId: "u1",
    fetchGrades: async () => ({ ok: true, results: [] })
  });
  assert.ok(out.toLowerCase().includes("which assignment"), "expected clarification message, got: " + out);
});
await run("no userId asks to log in", async () => {
  const out = await getAssignmentGrade("Grade for Quiz 1", {
    gradebookByCourseId: { c1: { courseName: "X", columns: [{ id: "col1", title: "Quiz 1" }] } },
    userId: null,
    fetchGrades: async () => ({})
  });
  assert.ok(out.toLowerCase().includes("open blackboard") || out.toLowerCase().includes("logged in"));
});
await run("empty gradebook asks to sync", async () => {
  const out = await getAssignmentGrade("Grade for Quiz 1", {
    gradebookByCourseId: {},
    userId: "u1",
    fetchGrades: async () => ({})
  });
  assert.ok(out.toLowerCase().includes("sync"));
});
await run("match and fetch returns formatted grade", async () => {
  const gradebookByCourseId = {
    c1: { courseName: "Physics", columns: [{ id: "col1", title: "Quiz 1" }], assignments: [{ title: "Quiz 1", columnId: "col1" }] }
  };
  const out = await getAssignmentGrade("What's my grade on Quiz 1?", {
    gradebookByCourseId,
    userId: "u1",
    fetchGrades: async (courseId) => {
      assert.strictEqual(courseId, "c1");
      return { ok: true, results: [{ grade: { columnId: "col1", displayGrade: { text: "9/10" } } }] };
    }
  });
  assert.ok(out.includes("Your grade for"));
  assert.ok(out.includes("Quiz 1"));
  assert.ok(out.includes("9/10"));
});
await run("all grades for course returns full list", async () => {
  const gradebookByCourseId = {
    c1: {
      courseName: "Fundamentals of Data Analysis",
      columns: [
        { id: "col1", title: "Quiz 1" },
        { id: "col2", title: "Assignment 1" }
      ]
    }
  };
  const courseIdByNormalizedName = { "fundamentals of data analysis": "c1" };
  const coursesByCourseId = { c1: { name: "Fundamentals of Data Analysis" } };
  const out = await getAssignmentGrade("whats my grade on all the assignments of fundamentals of data analysis?", {
    gradebookByCourseId,
    userId: "u1",
    fetchGrades: async (courseId) => {
      assert.strictEqual(courseId, "c1");
      return {
        ok: true,
        results: [
          { grade: { columnId: "col1", displayGrade: { text: "9/10" } } },
          { grade: { columnId: "col2", displayGrade: { text: "85%" } } }
        ]
      };
    },
    courseIdByNormalizedName,
    coursesByCourseId
  });
  const text = typeof out === "object" && out != null && typeof out.text === "string" ? out.text : String(out);
  assert.ok(text.includes("Here are your grades for"));
  assert.ok(text.includes("Fundamentals of Data Analysis"));
  assert.ok(text.includes("Quiz 1"));
  assert.ok(text.includes("9/10"));
  assert.ok(text.includes("Assignment 1"));
  assert.ok(text.includes("85%"));
});
await run("gimme the assigns in [course] returns full list via all-grades path", async () => {
  const gradebookByCourseId = {
    c1: {
      courseName: "Cost Accounting",
      columns: [
        { id: "col1", title: "HW1" },
        { id: "col2", title: "Midterm" }
      ]
    }
  };
  const courseIdByNormalizedName = { "cost accounting": "c1" };
  const coursesByCourseId = { c1: { name: "Cost Accounting" } };
  const out = await getAssignmentGrade("gimme the assigns in cost accounting", {
    gradebookByCourseId,
    userId: "u1",
    fetchGrades: async (courseId) => {
      assert.strictEqual(courseId, "c1");
      return {
        ok: true,
        results: [
          { grade: { columnId: "col1", displayGrade: { text: "10/10" } } },
          { grade: { columnId: "col2", displayGrade: { text: "B+" } } }
        ]
      };
    },
    courseIdByNormalizedName,
    coursesByCourseId
  });
  const text = typeof out === "object" && out != null && typeof out.text === "string" ? out.text : String(out);
  assert.ok(text.includes("Here are your grades for"));
  assert.ok(text.includes("Cost Accounting"));
  assert.ok(text.includes("HW1"));
  assert.ok(text.includes("Midterm"));
});

console.log("\nAll tests passed.");
})();
