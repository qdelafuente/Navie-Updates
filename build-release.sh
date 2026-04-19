#!/bin/bash
# ─────────────────────────────────────────────────────────────
# build-release.sh — Genera el ZIP listo para subir a GitHub
# Uso: bash build-release.sh
# ─────────────────────────────────────────────────────────────

# Leer versión del manifest.json automáticamente
VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUTPUT="releases/navie-extension-v${VERSION}.zip"

echo "📦 Generando release v${VERSION}..."

mkdir -p releases

# Eliminar zip anterior de la misma versión si existe
rm -f "$OUTPUT"

zip -r "$OUTPUT" \
  manifest.json \
  background.js \
  contentScript.js \
  sidepanel.js sidepanel.html sidepanel.css \
  popup.js popup.html popup.css \
  timeContext.js \
  courseRegistry.js \
  updateManager.js \
  update.html \
  update.js \
  intentRouter.js \
  syllabusIntelligence.js syllabusManager.js syllabusParser.js \
  attendance.js \
  announcements.js \
  calendar.js calendarMidtermEnricher.js \
  midtermDates.js midtermSessionDetector.js \
  finalExamSessionDetector.js \
  gradeLookupService.js \
  courseQueryOrchestrator.js \
  courseMessagesService.js \
  navieClassifier.js \
  pdfReadingOrder.js \
  promptRules.js \
  textMatch.js \
  userIdentity.js \
  Logo.png \
  scripts/ \
  native-host/ \
  lib/ \
  assets/ \
  src/ \
  -x "src/courseClassifier/__tests__/*" \
  -q

echo "✅ ZIP creado: $OUTPUT ($(du -sh "$OUTPUT" | cut -f1))"
echo ""
echo "Pasos siguientes:"
echo "  1. git add . && git commit -m 'release v${VERSION}' && git push"
echo "  2. Sube $OUTPUT a GitHub → Releases → v${VERSION}"
