#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# install-native-host-mac.sh
# Instala el Native Messaging host de Navie en macOS.
# Ejecuta este script UNA VEZ después de instalar la extensión.
# ─────────────────────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"

PYTHON_HOST="$EXTENSION_DIR/native-host/navie_updater.py"
HOST_MANIFEST="$EXTENSION_DIR/native-host/com.navie.updater.json"

INSTALL_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
DEST_SCRIPT="/usr/local/bin/navie_updater.py"
DEST_MANIFEST="$INSTALL_DIR/com.navie.updater.json"

# ── Verificar que Python3 está disponible ────────────────────────────────────
if ! command -v python3 &>/dev/null; then
  osascript -e 'display dialog "Python 3 no está instalado.\n\nInstálalo desde python.org o con Homebrew:\nbrew install python3" with title "Navie Updater" buttons {"OK"} default button "OK" with icon stop'
  exit 1
fi

# ── Instalar el script Python en /usr/local/bin ──────────────────────────────
osascript -e 'display dialog "Navie necesita instalar un componente para las actualizaciones automáticas.\n\nSe pedirá tu contraseña de administrador." with title "Navie — Instalar actualizador" buttons {"Cancelar", "Continuar"} default button "Continuar" with icon note' 2>/dev/null

if [ $? -ne 0 ]; then
  echo "Instalación cancelada por el usuario."
  exit 0
fi

sudo cp "$PYTHON_HOST" "$DEST_SCRIPT"
sudo chmod +x "$DEST_SCRIPT"

# ── Crear directorio de Native Messaging hosts ───────────────────────────────
mkdir -p "$INSTALL_DIR"

# ── Escribir el manifest JSON con el path correcto ───────────────────────────
python3 - <<PYEOF
import json

manifest = {
    "name": "com.navie.updater",
    "description": "Navie Extension Auto-Updater",
    "path": "$DEST_SCRIPT",
    "type": "stdio",
    "allowed_origins": [
        "chrome-extension://omljpaaaikpbmpmcifkldfpjgogipmkp/"
    ]
}

with open("$DEST_MANIFEST", "w") as f:
    json.dump(manifest, f, indent=2)
print("Manifest escrito en: $DEST_MANIFEST")
PYEOF

osascript -e 'display dialog "✅ Actualizador de Navie instalado correctamente.\n\nA partir de ahora las actualizaciones se instalarán automáticamente." with title "Navie — Instalación completada" buttons {"OK"} default button "OK" with icon note'

echo "✅ Native host instalado correctamente."
