# Sistema de assignments/entregas (módulo aislado)

Este sistema está **aislado** y funciona correctamente. No debe modificarse al cambiar otras partes de la extensión (calendario, syllabi, UI, etc.), salvo que se pidan explícitamente cambios en los assignments.

## Fuente de datos

- **Gradebook** (sincronizado con «Sincronizar syllabi» o al abrir la extensión): `gradebookByCourseId`, `gradebookColumns`.
- Los assignments que ve el usuario y la IA vienen de ahí; **no** del calendario.

## Archivos y funciones (sidepanel.js)

| Función / bloque | Qué hace |
|------------------|----------|
| `getAssignmentsContextBlock(gradebookByCourseId)` | **Único punto de integración.** Devuelve el bloque `[ASSIGNMENTS_CONTEXT]` para el system prompt. |
| `getNextThreeUpcoming(gradebookByCourseId)` | Próximas 3 entregas (widget). |
| `getUpcomingAssignmentsAll(gradebookByCourseId, limit)` | Próximas N entregas para el prompt. |
| `getUpcomingAssignmentsForCourse`, `getUpcomingAssignments` | Entregas por curso (resolución por nombre). |
| `buildGradebookContext(...)` | Texto "Gradebook: ..." en el prompt. |
| `isAssignmentQuery(text)`, `isAssignmentOnlyQuery(text)` | Detección de preguntas de entregas; la segunda evita inyectar calendario. |
| `renderUpcomingWidget(assignments)` | Pinta el widget de próximas entregas. |
| En `buildSystemPrompt` | Añade gradebookBlob, "Entregas próximas (curso)" si hay curso resuelto, y la instrucción de usar solo `[ASSIGNMENTS_CONTEXT]`. |
| En `sendChatMessage` | `assignmentsBlock = getAssignmentsContextBlock(gradebookByCourseId)` y se concatena al prompt. |

## Punto de integración en el chat

En `sendChatMessage()`:

```js
const assignmentsBlock = getAssignmentsContextBlock(gradebookByCourseId);
// ...
systemPrompt += assignmentsBlock + "\n\n";
```

Y para no inyectar calendario cuando la pregunta es solo de entregas:

```js
const calendarBlock = isAssignmentOnlyQuery(text) ? "" : await getCalendarContextForUserQuery(text);
```

No modificar esta lógica ni unirla con otros módulos.

## Otros archivos

- **contentScript.js**: sincronización de gradebook (endpoints de courses/gradebook).
- **background.js**: reenvío de mensajes de sync (syllabi/gradebook).

## Regla Cursor

Existe una regla en `.cursor/rules/do-not-modify-assignments.mdc` que indica no tocar este sistema al trabajar en otras funciones.
