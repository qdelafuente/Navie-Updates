#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# install-native-host-mac.command
# Instala el actualizador automático de Navie en macOS.
# El usuario solo necesita hacer DOBLE CLIC en este archivo.
# No requiere contraseña de administrador.
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
PYTHON_SCRIPT="$EXTENSION_DIR/native-host/navie_updater.py"
WRAPPER="$EXTENSION_DIR/native-host/navie_updater_wrapper.sh"

NATIVE_HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$NATIVE_HOST_DIR/com.navie.updater.json"

# ── Verificar Python3 ─────────────────────────────────────────────────────────
PYTHON3_PATH="$(which python3)"
if [ -z "$PYTHON3_PATH" ]; then
  osascript -e 'display dialog "Python 3 no está instalado.\n\nInstálalo con:\nbrew install python3" with title "Navie" buttons {"OK"} default button "OK" with icon stop'
  exit 1
fi

# ── Confirmar instalación ─────────────────────────────────────────────────────
result=$(osascript -e 'button returned of (display dialog "Navie instalará el componente de actualizaciones automáticas.\n\n✓ No requiere contraseña de administrador." with title "Navie — Actualizaciones automáticas" buttons {"Cancelar", "Instalar"} default button "Instalar" with icon note)' 2>/dev/null)
if [ "$result" != "Instalar" ]; then
  exit 0
fi

# ── Crear wrapper shell con ruta absoluta a python3 ───────────────────────────
# Chrome lanza el host con un entorno reducido sin PATH completo,
# por eso el manifest apunta a un wrapper que tiene la ruta absoluta.
cat > "$WRAPPER" << WRAPPER_EOF
#!/bin/bash
exec "$PYTHON3_PATH" "$PYTHON_SCRIPT"
WRAPPER_EOF
chmod +x "$WRAPPER"

# ── Crear carpeta de native messaging hosts (usuario, sin admin) ──────────────
mkdir -p "$NATIVE_HOST_DIR"

# ── Escribir el manifest JSON apuntando al wrapper ────────────────────────────
python3 - <<PYEOF
import json

manifest = {
    "name": "com.navie.updater",
    "description": "Navie Extension Auto-Updater",
    "path": "$WRAPPER",
    "type": "stdio",
    "allowed_origins": [
        "chrome-extension://omljpaaaikpbmpmcifkldfpjgogipmkp/"
    ]
}

with open("$MANIFEST_PATH", "w") as f:
    json.dump(manifest, f, indent=2)
PYEOF

# ── Confirmación final ────────────────────────────────────────────────────────
osascript -e 'display dialog "✅ ¡Listo! Las actualizaciones de Navie ahora se instalan automáticamente.\n\nCuando haya una nueva versión, solo tendrás que recargar la extensión en chrome://extensions." with title "Navie — Instalación completada" buttons {"OK"} default button "OK" with icon note'

echo "✅ Native host instalado."
echo "   Wrapper: $WRAPPER"
echo "   Python:  $PYTHON3_PATH"
echo "   Script:  $PYTHON_SCRIPT"
