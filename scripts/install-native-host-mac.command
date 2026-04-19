#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# install-native-host-mac.command — Instalación única del actualizador de Navie.
# El usuario ejecuta esto UNA VEZ. Las actualizaciones futuras son automáticas.
# No requiere contraseña de administrador.
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
PYTHON_SCRIPT="$EXTENSION_DIR/native-host/navie_updater.py"

# Directorio de instalación SIN espacios (Chrome lo necesita)
INSTALL_DIR="$HOME/.local/share/navie"
HOST_SCRIPT="$INSTALL_DIR/navie_host.sh"

CHROME_HOSTS_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$CHROME_HOSTS_DIR/com.navie.updater.json"

# ── Verificar Python3 ─────────────────────────────────────────────────────────
PYTHON3="$(which python3)"
if [ -z "$PYTHON3" ]; then
  osascript -e 'display dialog "Python 3 no está instalado.\n\nInstálalo con: brew install python3" with title "Navie" buttons {"OK"} default button "OK" with icon stop'
  exit 1
fi

# ── Confirmar ─────────────────────────────────────────────────────────────────
result=$(osascript -e 'button returned of (display dialog "Navie instalará el componente de actualizaciones automáticas.\n\n✓ No requiere contraseña de administrador.\n✓ Solo necesitas hacerlo una vez." with title "Navie — Actualizaciones automáticas" buttons {"Cancelar", "Instalar"} default button "Instalar" with icon note)' 2>/dev/null)
[ "$result" != "Instalar" ] && exit 0

# ── Crear directorio de instalación (sin espacios en la ruta) ─────────────────
mkdir -p "$INSTALL_DIR"

# ── Crear script lanzador con rutas absolutas ─────────────────────────────────
# El manifest de Chrome apunta aquí (ruta sin espacios).
# Internamente llama al Python con la ruta real de la extensión.
cat > "$HOST_SCRIPT" << LAUNCHER
#!/bin/bash
exec "$PYTHON3" "$PYTHON_SCRIPT"
LAUNCHER
chmod +x "$HOST_SCRIPT"

# ── Registrar en Chrome ───────────────────────────────────────────────────────
mkdir -p "$CHROME_HOSTS_DIR"
"$PYTHON3" - << PYEOF
import json
manifest = {
    "name": "com.navie.updater",
    "description": "Navie Extension Auto-Updater",
    "path": "$HOST_SCRIPT",
    "type": "stdio",
    "allowed_origins": ["chrome-extension://omljpaaaikpbmpmcifkldfpjgogipmkp/"]
}
with open("$MANIFEST_PATH", "w") as f:
    json.dump(manifest, f, indent=2)
PYEOF

# ── Listo ─────────────────────────────────────────────────────────────────────
osascript -e 'display dialog "✅ ¡Instalado!\n\nLas próximas actualizaciones de Navie se instalarán automáticamente. Solo tendrás que hacer clic en ⟲ Reload en chrome://extensions." with title "Navie" buttons {"OK"} default button "OK" with icon note'

echo "✅ Instalado correctamente."
echo "   Launcher: $HOST_SCRIPT"
echo "   Python:   $PYTHON3"
echo "   Manifest: $MANIFEST_PATH"
