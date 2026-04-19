/**
 * navieClassifier.js — LLM-based intent classifier for NAVIE.
 *
 * Replaces all regex-based routing (intentRouter.js + 44 is* functions in sidepanel.js).
 * The LLM understands any phrasing, any word order, any language, any synonym.
 *
 * Returns: { intent, courseName, examType, scope, timeScope, confidence }
 */
(function (global) {
  "use strict";

  /**
   * All intents NAVIE can handle, with natural-language descriptions and examples
   * that let the LLM understand without requiring exact keywords.
   */
  const INTENTS = [
    {
      id: "FINAL_EXAM_DATE",
      description:
        "Student asks about the date, schedule, or when their FINAL exam takes place for ONE specific course. " +
        "Examples: 'When is my data analysis final?', 'What day is the final exam of microeconomics?', " +
        "'My programming final exam date?', 'Fecha del examen final de estadística?', " +
        "'Can you tell me when the data analysis final exam is?', 'I need to know when my final for cost accounting is', " +
        "'What's the date of my final exam of data analysis?'"
    },
    {
      id: "ALL_FINALS",
      description:
        "Student asks about all their final exam dates across all courses, or wants a list/ranking of finals. " +
        "Examples: 'When are all my finals?', 'Show me my final exam dates', 'Which final is closest?', " +
        "'All my finals', 'My next final exam', 'Do I have any finals soon?', 'Mis finales'"
    },
    {
      id: "MIDTERM_DATE",
      description:
        "Student asks about the date or schedule of their MIDTERM / parcial / intermediate exam for ONE specific course. " +
        "Examples: 'When is my data analysis midterm?', 'Date of the parcial of cost accounting?', " +
        "'Fecha del parcial de microeconomía?', 'When is my intermediate exam for physics?'"
    },
    {
      id: "ALL_MIDTERMS",
      description:
        "Student asks about all their midterm dates across all courses. " +
        "Examples: 'When are all my midterms?', 'Midterm dates', 'My parciales', 'All midterms', " +
        "'Cuándo son mis parciales?', 'My next midterm'"
    },
    {
      id: "ASSIGNMENT_GRADE",
      description:
        "Student asks about their own grades/scores on assignments, OR wants to list their assignments/tasks for a course. " +
        "ONLY use when the student wants to see grade values, scores, or a list of gradebook items. " +
        "Examples: 'What are my assignments in physics?', 'My grade in the last deliverable', " +
        "'Show me assignments for cost accounting', 'Grades for microeconomics', " +
        "'What score did I get on case study 2?', 'My nota in data analysis'. " +
        "NEVER use for questions asking WHEN/WHAT DATE something takes place (retakes, quizzes, tests, presentations) — " +
        "those are scheduling questions → use ANNOUNCEMENTS or GENERAL_CHAT instead. " +
        "NEVER use if the question contains 'when is', 'what date', 'cuándo', 'fecha' about a test/quiz/retake."
    },
    {
      id: "SUBMISSION_STATUS",
      description:
        "Student asks what they still need to submit, what is pending, incomplete, or overdue. " +
        "Examples: 'Do I have anything left to submit?', 'What assignments are pending?', 'What did I miss?', " +
        "'Is there anything I haven\\'t submitted?', 'What do I still need to turn in?', " +
        "'Qué me falta entregar?', 'Anything overdue?'"
    },
    {
      id: "SINGLE_SUBMISSION_CHECK",
      description:
        "Student asks whether they already submitted ONE specific assignment. " +
        "Examples: 'Did I already submit assignment 3?', 'Have I turned in the final project?', " +
        "'Did I hand in the homework?', 'Have I submitted the case study?'"
    },
    {
      id: "ATTENDANCE",
      description:
        "Student asks about their attendance percentage or attendance record for a course. " +
        "Examples: 'What is my attendance in microeconomics?', 'How is my attendance?', " +
        "'My asistencia in data analysis', 'Attendance score for physics?', " +
        "'How often have I shown up to class?', 'Mi porcentaje de asistencia', " +
        "'What\\'s my attendance percentage?', 'Am I above the attendance threshold?'"
    },
    {
      id: "CALENDAR_TEMPORAL",
      description:
        "Student asks when their classes or sessions are on a specific date or time period. " +
        "Examples: 'Do I have class tomorrow?', 'What sessions do I have on Monday?', " +
        "'My schedule for next week', 'What classes do I have today?', 'When is session 5?', " +
        "'Is there class on Friday?', 'Do I have anything this Thursday?', " +
        "'Tengo clase mañana?', 'What do I have next week?'"
    },
    {
      id: "SYLLABUS_CONTENT",
      description:
        "Student asks about course content, session topics, professor info (name, email, phone, office hours, contact details), " +
        "grading policy, AI policy, bibliography, evaluation criteria, learning objectives, methodology, or syllabus details. " +
        "Also use for follow-up questions about a professor such as 'what is his email?', 'how can I contact him?', 'what are his office hours?'. " +
        "Examples: 'What is session 5 about?', 'Who is the professor of physics?', " +
        "'What is his email?', 'Whats the professor email?', 'How can I contact the professor?', " +
        "'How is microeconomics graded?', 'Bibliography for data analysis', " +
        "'What topics are covered in cost accounting?', 'AI policy for statistics', " +
        "'What will I learn in session 3?', 'Evaluation criteria for programming', " +
        "'What is the re-sit policy?', 'Course description of data analysis'"
    },
    {
      id: "SYLLABUS_LINK",
      description:
        "Student specifically wants to open or get the URL/link to the syllabus PDF of a course. " +
        "They want a clickable link or URL, not content. " +
        "Examples: 'Give me the syllabus link for physics', 'Open the silabo of microeconomics', " +
        "'Where is the syllabus for data analysis?', 'Download the syllabus of cost accounting', " +
        "'Show me the syllabus link'"
    },
    {
      id: "ANNOUNCEMENTS",
      description:
        "Student asks about announcements, notices, or updates posted by professors in Blackboard. " +
        "Also use when a student asks about scheduling information likely posted by a professor " +
        "(retake dates, test reschedules, quiz dates, presentation dates, deadline changes). " +
        "Examples: 'Are there any announcements in cost accounting?', 'Latest announcement from my professors', " +
        "'What did the professor post?', 'Any notices from my teachers?', 'Avisos recientes', " +
        "'New announcements?', 'What has been announced in physics?', " +
        "'When is the retake for mini test 02 of cost accounting?', " +
        "'What date is the make-up quiz for data analysis?', 'Did the professor reschedule the test?', " +
        "'When is the presentation for operations management?', 'Is there a retake for the midterm?'"
    },
    {
      id: "COURSE_MESSAGES",
      description:
        "Student asks about direct messages or conversations in a course inbox (not announcements). " +
        "ONLY use when asking about inbox messages, conversations, or unread items. " +
        "NEVER use for questions about professor email address, phone number, office hours, or contact details — those go to SYLLABUS_CONTENT or GENERAL_CHAT. " +
        "Examples: 'Do I have any messages in microeconomics?', 'Last message in physics', " +
        "'Any unread messages?', 'Did the professor send me anything in my inbox?', " +
        "'Mensajes en el curso de estadística'. " +
        "NOT for: 'what is the professor email?', 'whats his email?', 'how can I contact the professor?'"
    },
    {
      id: "PROFILE_IDENTITY",
      description:
        "Student asks for their own personal data: name, email, or student ID. " +
        "Examples: 'What is my name?', 'What is my email?', 'My student ID', " +
        "'Who am I?', 'What email is registered?', 'Mi nombre', 'Mi ID de estudiante'"
    },
    {
      id: "GENERAL_CHAT",
      description:
        "General question, greeting, or anything that does not fit the specific Blackboard data categories above. " +
        "Use this as a fallback only when no other intent clearly fits."
    }
  ];

  const INTENTS_DESCRIPTION = INTENTS.map((i) => `- ${i.id}: ${i.description}`).join("\n\n");

  /**
   * Classify the user's message using the LLM.
   *
   * @param {string} userText - The user's current message
   * @param {Array<{role:string,content:string}>} recentHistory - Last few chat messages for context
   * @param {string} apiKey - OpenRouter API key
   * @param {string} openrouterUrl - OpenRouter endpoint URL
   * @param {string} model - Model ID to use
   * @returns {Promise<{intent:string, courseName:string|null, examType:string|null, scope:string, timeScope:string|null, confidence:number}>}
   */
  async function classify(userText, recentHistory, apiKey, openrouterUrl, model) {
    const fallback = {
      intent: "GENERAL_CHAT",
      courseName: null,
      examType: null,
      scope: "all_courses",
      timeScope: null,
      confidence: 0
    };

    if (!userText || !apiKey) return fallback;

    const contextBlock =
      Array.isArray(recentHistory) && recentHistory.length > 0
        ? "Recent conversation for context:\n" +
          recentHistory
            .slice(-4)
            .map((m) => m.role + ": " + m.content)
            .join("\n") +
          "\n\n"
        : "";

    const systemPrompt =
      "You are an intent classifier for NAVIE, a university Blackboard course assistant. " +
      "Your job: classify the student's message into exactly one intent and extract key entities. " +
      "Output ONLY a valid JSON object — no explanation, no markdown, no extra text.\n\n" +
      "AVAILABLE INTENTS:\n" +
      INTENTS_DESCRIPTION +
      "\n\nCRITICAL ROUTING RULES (apply before choosing an intent):\n" +
      "1. If the question asks WHEN something takes place (date, time, schedule) for a test/quiz/retake/presentation/make-up " +
      "→ use ANNOUNCEMENTS (professors post scheduling changes there) or GENERAL_CHAT. NEVER ASSIGNMENT_GRADE.\n" +
      "2. ASSIGNMENT_GRADE is ONLY for: 'what is my grade on X', 'show me my grades', 'list my assignments'. " +
      "Never for scheduling or date questions.\n" +
      "3. If no specific intent fits and a course is mentioned → use GENERAL_CHAT " +
      "(the system will search all course sources: syllabus, announcements, and messages).\n\n" +
      "EXTRACTION RULES:\n" +
      "- courseName: the course or subject the student mentioned (e.g. 'data analysis', 'microeconomics', 'physics'). " +
      "Extract from ANYWHERE in the sentence regardless of word order or prepositions. " +
      "Use null if no specific course is mentioned or if asking about all courses.\n" +
      "- examType: 'final' if about final exam, 'midterm' if about midterm/parcial/intermediate exam, null otherwise.\n" +
      "- scope: 'single_course' if a specific course is clearly mentioned or implied, 'all_courses' if asking generally about all courses.\n" +
      "- timeScope: 'today', 'tomorrow', 'this_week', 'next_week', or null.\n" +
      "- confidence: your confidence from 0.0 to 1.0.\n\n" +
      "OUTPUT FORMAT (exactly this JSON, no extra fields):\n" +
      '{"intent":"INTENT_ID","courseName":null,"examType":null,"scope":"all_courses","timeScope":null,"confidence":0.9}';

    const userPrompt = contextBlock + "Student message: " + userText;

    try {
      const response = await fetch(openrouterUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          max_tokens: 120,
          temperature: 0
        })
      });

      if (!response.ok) {
        console.warn("[NavieClassifier] HTTP " + response.status);
        return fallback;
      }

      const data = await response.json();
      const raw = (data?.choices?.[0]?.message?.content || "").trim();
      const jsonStr = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      const parsed = JSON.parse(jsonStr);

      // Validate intent ID
      const validIntent = INTENTS.find((i) => i.id === parsed.intent);
      return {
        intent: validIntent ? parsed.intent : "GENERAL_CHAT",
        courseName: typeof parsed.courseName === "string" && parsed.courseName.trim() ? parsed.courseName.trim() : null,
        examType: parsed.examType || null,
        scope: parsed.scope === "single_course" ? "single_course" : "all_courses",
        timeScope: parsed.timeScope || null,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.8
      };
    } catch (e) {
      console.warn("[NavieClassifier] Classification failed:", e?.message || e);
      return fallback;
    }
  }

  global.NavieClassifier = { classify, INTENTS };
})(typeof window !== "undefined" ? window : globalThis);
