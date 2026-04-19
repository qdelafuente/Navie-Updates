# Midterm Messages Integration — Usage

## Overview

The midterm detection system now includes **course messages** as a third source, alongside syllabus and announcements. Messages have equal or higher priority than announcements when they are newer or explicitly reschedule the midterm.

## API

```javascript
import { extractMidtermFromMessages, resolveMidtermSession } from "./midtermSessionDetector.js";

// 1) Extract from messages only
const messages = [
  {
    id: "msg1",
    senderName: "Prof. Smith",
    body: "I confirm the midterm will be held on Tuesday March 03 at 11.00am.",
    createdAt: "2026-02-12T09:41:18.282Z",
    updatedAt: null
  }
];
const msgResult = extractMidtermFromMessages(messages);
// => { midterm_date: "2026-03-03", midterm_time: "11:00", confidence: 0.98, ... }

// 2) Resolve from all three sources (syllabus + announcements + messages)
const resolution = resolveMidtermSession(syllabusRawText, announcements, messages);
// => { midterm_session: null, midterm_date: "2026-03-03", midterm_time: "11:00",
//      source: "message", reason: "...", evidence: [...], debug: {...} }
```

## Message format

Messages must have at least:
- `id` (or `messageId`)
- `body` (or `textPlain`)
- `createdAt` (or `postDateISO`)

Optional: `updatedAt`, `senderName`, `subject`.

## Priority rules

1. **Reschedule** (move from X to Y) → highest priority, overrides everything
2. **Recency** → newer message/announcement wins over older when confidence is similar
3. **Explicitness** → "midterm will be held on March 03" overrides syllabus session
4. **Date without session** → if only date is found, returns `midterm_date` + `midterm_time`, `midterm_session` stays null

## Output schema (resolver)

```javascript
{
  midterm_session: int | null,
  midterm_date: "YYYY-MM-DD" | null,
  midterm_time: "HH:MM" | null,
  timezone: string | null,
  candidates: int[],
  source: "message" | "announcement" | "syllabus" | "none",
  reason: string,
  confidence: float,
  evidence: [...],
  debug: {
    syllabus_result: {...},
    announcement_result: {...},
    message_result: {...},
    resolution_rule: string
  }
}
```
