import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function loadIntentRouter() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.join(currentDir, "..", "intentRouter.js");
  const source = fs.readFileSync(scriptPath, "utf8");
  const sandbox = { window: {}, globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "intentRouter.js" });
  return sandbox.IntentRouter || sandbox.window.IntentRouter;
}

function topRoute(router, text) {
  const pre = router.preprocessText(text);
  const entities = router.extractEntities(pre);
  const intents = router.classifyIntent(pre, entities);
  return router.chooseRoute(intents).route;
}

(async () => {
  const router = loadIntentRouter();
  assert.ok(router, "intent router should be loaded");

  console.log("intentRouter natural language routing");
  await run("que toca en la 5 de micro -> syllabus content", () => {
    assert.strictEqual(topRoute(router, "qué toca en la 5 de micro?"), "SYLLABUS_CONTENT");
  });
  await run("cuando cae el parcial de X -> single midterm date", () => {
    assert.strictEqual(topRoute(router, "cuándo cae el parcial de microeconomia?"), "MIDTERM_DATE_SINGLE");
  });
  await run("hay algo nuevo en X -> announcements", () => {
    assert.strictEqual(topRoute(router, "hay algo nuevo en microeconomia?"), "ANNOUNCEMENTS_ONLY");
  });
  await run("que tengo para entregar de X esta semana -> assignment grade/submission", () => {
    const route = topRoute(router, "qué tengo para entregar de micro esta semana?");
    assert.ok(["ASSIGNMENT_GRADE", "SUBMISSION_STATUS"].includes(route));
  });
  await run("what assignments I have for next week -> global assignment flow", () => {
    assert.strictEqual(topRoute(router, "what assignments I have for next week?"), "OPENROUTER_CHAT");
  });
  await run("what are my messages from yesterday -> messages flow", () => {
    assert.strictEqual(topRoute(router, "now what are my messages from yesterday"), "COURSE_MESSAGES");
  });
  await run("what are the last mesages I recieved -> messages flow with typos", () => {
    assert.strictEqual(topRoute(router, "what are the last mesages I recieved?"), "COURSE_MESSAGES");
  });
  await run("and announcement -> announcements flow", () => {
    assert.strictEqual(topRoute(router, "and announcement?"), "ANNOUNCEMENTS_ONLY");
  });
  await run("last 3 announc -> announcements flow with abbreviation", () => {
    assert.strictEqual(topRoute(router, "what are like my last 3 announc"), "ANNOUNCEMENTS_ONLY");
  });
  await run("announsement typo normalizes to announcements route", () => {
    assert.strictEqual(topRoute(router, "give me my last 3 announsementsss"), "ANNOUNCEMENTS_ONLY");
  });
  await run("the 2 latest routes to course messages", () => {
    assert.strictEqual(topRoute(router, "the 2 latest"), "COURSE_MESSAGES");
  });
  await run("which final is the closest -> finals route", () => {
    const route = topRoute(router, "and like which final is the closeeest?");
    assert.ok(["FINAL_DATES_ALL", "FINAL_DATE_SINGLE"].includes(route));
  });
  await run("which one was my third midterm -> midterms route", () => {
    const route = topRoute(router, "which one was my third midterm");
    assert.ok(["MIDTERM_DATES_ALL", "MIDTERM_DATE_SINGLE"].includes(route));
  });
  await run("whens my last final exam -> finals route", () => {
    const route = topRoute(router, "whens my last final exam");
    assert.ok(["FINAL_DATES_ALL", "FINAL_DATE_SINGLE"].includes(route));
  });
  await run("whens my last final -> finals route", () => {
    const route = topRoute(router, "whens my last final");
    assert.ok(["FINAL_DATES_ALL", "FINAL_DATE_SINGLE"].includes(route));
  });
  await run("last 3 assignments should not route to messages", () => {
    const route = topRoute(router, "last 3 assignments");
    assert.notStrictEqual(route, "COURSE_MESSAGES");
  });

  console.log("\nintentRouter entities");
  await run("extracts course/session/exam/time entities", () => {
    const pre = router.preprocessText("Cuando es la session 5 del parcial de Micro esta semana?");
    const e = router.extractEntities(pre);
    assert.strictEqual(e.sessionNumber, 5);
    assert.strictEqual(e.examType, "midterm");
    assert.strictEqual(e.timeScope, "this_week");
    assert.ok(e.courseHint.includes("micro"));
  });

  console.log("\nintentRouter legacy no-regression");
  await run("legacy SYLLABUS_QUESTION still recognized", () => {
    assert.strictEqual(topRoute(router, "summarize the syllabus of microeconomics"), "SYLLABUS_QUESTION");
  });
  await run("legacy COMBINED_COURSE_QUERY still recognized", () => {
    assert.strictEqual(topRoute(router, "what happened in cost accounting?"), "COMBINED_COURSE_QUERY");
  });
  await run("that session content follow-up is syllabus not combined (no fake course hint)", () => {
    const q = "and what are we going to see in that session?";
    const pre = router.preprocessText(q);
    const e = router.extractEntities(pre);
    assert.strictEqual(e.courseHint, "");
    assert.strictEqual(topRoute(router, q), "SYLLABUS_CONTENT");
  });
  await run("sessions for toda typo routes to calendar not combined course", () => {
    assert.strictEqual(topRoute(router, "hey are there any sessions scheduld for toda?"), "TEMPORAL_SESSION");
    const pre = router.preprocessText("hey are there any sessions scheduld for toda?");
    const e = router.extractEntities(pre);
    assert.strictEqual(e.courseHint, "");
  });
  await run("classes for this friday is calendar not course resolution", () => {
    assert.strictEqual(topRoute(router, "classes for this friday?"), "TEMPORAL_SESSION");
    const pre = router.preprocessText("classes for this friday?");
    const e = router.extractEntities(pre);
    assert.strictEqual(e.courseHint, "");
  });
  await run("classes on monday the next one routes to temporal", () => {
    assert.strictEqual(topRoute(router, "classes on monday? the next one"), "TEMPORAL_SESSION");
  });
  await run("legacy ANNOUNCEMENTS_ONLY still recognized", () => {
    assert.strictEqual(topRoute(router, "show latest announcements"), "ANNOUNCEMENTS_ONLY");
  });
  await run("fallback defaults to OPENROUTER_CHAT", () => {
    assert.strictEqual(topRoute(router, "hello there"), "OPENROUTER_CHAT");
  });

  console.log("\nintentRouter assignment course routing");
  await run("give me all assignments of microecon -> ASSIGNMENT_GRADE", () => {
    assert.strictEqual(topRoute(router, "give me all the assignments of microecon"), "ASSIGNMENT_GRADE");
  });
  await run("give me all for microecon shorthand -> ASSIGNMENT_GRADE", () => {
    assert.strictEqual(topRoute(router, "give me all for microecon"), "ASSIGNMENT_GRADE");
  });
  await run("typo asignment with course -> ASSIGNMENT_GRADE", () => {
    assert.strictEqual(topRoute(router, "what are all the asignments for microeconomics"), "ASSIGNMENT_GRADE");
  });
  await run("forr microcecon typo -> ASSIGNMENT_GRADE", () => {
    assert.strictEqual(topRoute(router, "what are all the assignments forr microcecon"), "ASSIGNMENT_GRADE");
  });
  await run("i want last assignment of microecon -> ASSIGNMENT_GRADE", () => {
    assert.strictEqual(topRoute(router, "I want my last assignment of microecon"), "ASSIGNMENT_GRADE");
  });
  await run("casual assigns for tday is not combined course (no fake course hint)", () => {
    const pre = router.preprocessText("yo bro any assigns for tday?");
    const e = router.extractEntities(pre);
    assert.strictEqual(e.courseHint, "");
    assert.notStrictEqual(topRoute(router, "yo bro any assigns for tday?"), "COMBINED_COURSE_QUERY");
  });

  console.log("\nAll intentRouter tests passed.");
})();
