# Sistema de calendario y sesiones (módulo aislado)

Este sistema está **aislado** y funciona correctamente. No debe modificarse al cambiar otras partes de la extensión (syllabi, gradebook, UI, etc.), salvo que se pidan explícitamente cambios en el calendario.

## Archivos del módulo

| Archivo | Qué hace |
|--------|----------|
| **calendar.js** | Lógica completa: rangos (hoy/mañana/ayer/semana), normalización CalendarEntry, dedupe, `calendar.query`, detección de preguntas de calendario. |
| **contentScript.js** | Handler `GET_CALENDAR_ITEMS` y función `fetchCalendarItems` (GET al endpoint con credentials). |
| **background.js** | Bloque que reenvía `GET_CALENDAR_ITEMS` al content script (con XSRF). |
| **sidepanel.js** | Una sola función de integración: `getCalendarContextForUserQuery(text)`. El flujo del chat solo llama a esta función y concatena el resultado al prompt. |

## Punto de integración en sidepanel

En `sendChatMessage()` el único uso del calendario es:

```js
const calendarBlock = await getCalendarContextForUserQuery(text);
// ...
if (calendarBlock) systemPrompt += calendarBlock + "\n\n";
```

Y para no resolver curso cuando es pregunta de calendario:

```js
const isCalendarQ = typeof window.Calendar !== "undefined" && window.Calendar.isCalendarQuery(text);
const resolvedCourse = isCalendarQ ? null : resolveCourseForPrompt(...);
```

No refactorizar ni unir esta lógica con syllabus, course resolution, etc. Mantener el calendario como módulo aparte.

## Regla Cursor

Existe una regla en `.cursor/rules/do-not-modify-calendar.mdc` que indica no tocar este sistema al trabajar en otras funciones.
