import assert from "node:assert";
import {
  classifyCourse,
  classifyMemberships,
  currentSemester,
  normalizeMembership,
  normalizeText
} from "../courseClassifier.js";

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
  console.log("courseClassifier.normalizeText");
  await run("uppercases and collapses whitespace", () => {
    assert.strictEqual(normalizeText("  first   q1 "), "FIRST Q1");
    assert.strictEqual(normalizeText("First   Annual  course"), "FIRST ANNUAL COURSE");
  });

  console.log("\ncourseClassifier.classifyCourse");
  await run("term.name contains FIRST Q2 → Q2", () => {
    const course = { term: { name: "IE-IMPACT 25-26 FIRST Q2" } };
    assert.strictEqual(classifyCourse(course), "Q2");
  });

  await run("term.name contains FIRST Q1 → Q1", () => {
    const course = { term: { name: "IE-IMPACT 25-26 FIRST Q1" } };
    assert.strictEqual(classifyCourse(course), "Q1");
  });

  await run("term.name contains FIRST Annual → ANNUAL", () => {
    const course = { term: { name: "Bachelor in X FIRST Annual" } };
    assert.strictEqual(classifyCourse(course), "ANNUAL");
  });

  await run("description contains Annual → ANNUAL", () => {
    const course = { description: "This is an annual course" };
    assert.strictEqual(classifyCourse(course), "ANNUAL");
  });

  await run("serviceLevelType COMMUNITY wins over Q1/Q2", () => {
    const course = { serviceLevelType: "COMMUNITY", term: { name: "IE Something FIRST Q1" } };
    assert.strictEqual(classifyCourse(course), "ORGANIZATION_COMMUNITY");
  });

  await run("isOrganization true wins over Q1/Q2", () => {
    const course = { isOrganization: true, term: { name: "IE Something FIRST Q2" } };
    assert.strictEqual(classifyCourse(course), "ORGANIZATION_COMMUNITY");
  });

  await run("missing term/name fields → OTHER", () => {
    const course = {};
    assert.strictEqual(classifyCourse(course), "OTHER");
  });

  await run("case-insensitivity: 'first q1' → Q1", () => {
    const course = { term: { name: "bsc data science first q1 cohort" } };
    assert.strictEqual(classifyCourse(course), "Q1");
  });

  console.log("\ncourseClassifier.normalizeMembership & classifyMemberships");
  await run("normalizeMembership basic mapping", () => {
    const membership = {
      id: "_m1_1",
      userId: "_u1_1",
      courseId: "_c1_1",
      lastAccessDate: "2025-02-01T10:00Z",
      isAvailable: true,
      course: {
        id: "_c1_1",
        displayName: "Test Course",
        term: { name: "FIRST Q1 25-26" },
        serviceLevelType: "COURSE",
        isOrganization: false,
        externalAccessUrl: "https://blackboard.ie.edu/ultra/courses/_c1_1/outline"
      }
    };
    const norm = normalizeMembership(membership, { keepRaw: false });
    assert.ok(norm);
    assert.strictEqual(norm.membershipId, "_m1_1");
    assert.strictEqual(norm.userId, "_u1_1");
    assert.strictEqual(norm.courseId, "_c1_1");
    assert.strictEqual(norm.courseDisplayName, "Test Course");
    assert.strictEqual(norm.termName, "FIRST Q1 25-26");
    assert.strictEqual(norm.serviceLevelType, "COURSE");
    assert.strictEqual(norm.isOrganization, false);
    assert.strictEqual(norm.category, "Q1");
    assert.strictEqual(norm.externalAccessUrl, "https://blackboard.ie.edu/ultra/courses/_c1_1/outline");
    assert.strictEqual(norm.isAvailable, true);
    assert.strictEqual(norm.lastAccessDate, "2025-02-01T10:00Z");
  });

  await run("classifyMemberships aggregates totals correctly", () => {
    const responseJson = {
      results: [
        {
          id: "m1",
          userId: "u1",
          courseId: "c_q1",
          course: { id: "c_q1", term: { name: "FIRST Q1 25-26" } }
        },
        {
          id: "m2",
          userId: "u1",
          courseId: "c_q2",
          course: { id: "c_q2", term: { name: "FIRST Q2 25-26" } }
        },
        {
          id: "m3",
          userId: "u1",
          courseId: "c_annual",
          course: { id: "c_annual", term: { name: "Annual 25-26" } }
        },
        {
          id: "m4",
          userId: "u1",
          courseId: "c_org",
          course: { id: "c_org", serviceLevelType: "COMMUNITY" }
        },
        {
          id: "m5",
          userId: "u1",
          courseId: "c_other",
          course: { id: "c_other", name: "Some other course" }
        }
      ]
    };
    const { totals, items } = classifyMemberships(responseJson, { keepRaw: false });
    assert.strictEqual(items.length, 5);
    assert.strictEqual(totals.Q1, 1);
    assert.strictEqual(totals.Q2, 1);
    assert.strictEqual(totals.ANNUAL, 1);
    assert.strictEqual(totals.ORGANIZATION_COMMUNITY, 1);
    assert.strictEqual(totals.OTHER, 1);
  });

  await run("classifyMemberships handles missing results safely", () => {
    const { totals, items } = classifyMemberships({}, { keepRaw: false });
    assert.strictEqual(items.length, 0);
    assert.strictEqual(totals.Q1, 0);
    assert.strictEqual(totals.Q2, 0);
    assert.strictEqual(totals.ANNUAL, 0);
    assert.strictEqual(totals.ORGANIZATION_COMMUNITY, 0);
    assert.strictEqual(totals.OTHER, 0);
  });

  console.log("\ncourseClassifier.currentSemester");
  await run("0 Q2 → first semester", () => {
    assert.strictEqual(currentSemester({ Q2: 0 }), "first");
    assert.strictEqual(currentSemester({ Q1: 5, Q2: 0 }), "first");
  });
  await run("more than 0 Q2 → second semester", () => {
    assert.strictEqual(currentSemester({ Q2: 1 }), "second");
    assert.strictEqual(currentSemester({ Q1: 2, Q2: 3 }), "second");
  });
  await run("missing or invalid totals → first semester", () => {
    assert.strictEqual(currentSemester({}), "first");
    assert.strictEqual(currentSemester(null), "first");
  });

  console.log("\nAll courseClassifier tests passed.");
})();

