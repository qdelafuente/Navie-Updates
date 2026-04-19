#!/bin/bash

# ─────────────────────────────────────────────────────────────────
# Navie - Script de actualización (Mac)
# Descarga la última versión y la instala automáticamente.
# ─────────────────────────────────────────────────────────────────

REPO="qdelafuente/Navie-Updates"
INSTALL_DIR="$HOME/Library/Application Support/NavieExtension"
ZIP_FILE="/tmp/navie-extension.zip"
DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download/navie-extension.zip"

# Diálogo de inicio
osascript -e 'display dialog "Descargando la última versión de Navie...\n\nEsto tardará unos segundos." with title "Navie — Actualizando" buttons {"OK"} default button "OK" with icon note' &>/dev/null

# Crear carpeta de instalación si no existe
mkdir -p "$INSTALL_DIR"

# Descargar ZIP
curl -L --silent --show-error "$DOWNLOAD_URL" -o "$ZIP_FILE"

# Comprobar descarga
if [ ! -f "$ZIP_FILE" ]; then
  osascript -e 'display dialog "Error al descargar la actualización.\nComprueba tu conexión a internet e inténtalo de nuevo." with title "Navie — Error" buttons {"Cerrar"} default button "Cerrar" with icon stop' &>/dev/null
  exit 1
fi

# Descomprimir y sobrescribir
unzip -o "$ZIP_FILE" -d "$INSTALL_DIR" &>/dev/null

# Borrar ZIP temporal
rm -f "$ZIP_FILE"

# Abrir chrome://extensions automáticamente
open -a "Google Chrome" "chrome://extensions"

# Diálogo de éxito
osascript -e 'display dialog "✓ Actualización descargada correctamente.\n\nAhora en Chrome:\n1. Busca la extensión Navie\n2. Haz clic en el botón Recargar (⟲)\n\n¡Listo!" with title "Navie — Actualización lista" buttons {"Perfecto"} default button "Perfecto" with icon note' &>/dev/null
