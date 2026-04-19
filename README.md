# BB Syllabus Finder

Extensión Chrome (Manifest V3) que obtiene los syllabus de tus cursos en Blackboard IE.

## Cómo funciona

- **XSRF:** Se lee el token desde la cookie `BbRouter` (valor `xsrf:...`). Necesitas estar logueado en Blackboard en el mismo navegador.
- **Cursos:** `GET /learn/api/public/v1/users/me/courses?limit=200&offset=0`
- **Contenidos:** Recorre cada curso desde ROOT con paginación (`paging.nextPage`), detecta ítems LTI tipo IESyllabus y construye la URL con `from_ultra=true`.

## Instalación (unpacked)

1. Chrome → `chrome://extensions`
2. Activa **Developer mode**
3. **Load unpacked** → carpeta del proyecto

## Uso

1. Inicia sesión en https://blackboard.ie.edu
2. Abre el popup de la extensión → **Sincronizar syllabi**
3. La lista muestra cada curso y su enlace al syllabus (o "No encontrado" si no hay)

## Si sale "No pude obtener XSRF (cookie BbRouter)"

Asegúrate de estar logueado en Blackboard en ese navegador y de haber entrado en https://blackboard.ie.edu (para que exista la cookie BbRouter).
