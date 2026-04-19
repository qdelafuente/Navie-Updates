#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# install-native-host-mac.command
# Instala el actualizador automático de Navie en macOS.
# Ejecuta esto UNA SOLA VEZ. Las actualizaciones futuras son automáticas.
# No requiere contraseña de administrador.
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
PYTHON_SCRIPT="$EXTENSION_DIR/native-host/navie_updater.py"
INSTALL_DIR="$HOME/.local/share/navie"
HOST_BIN="$INSTALL_DIR/navie_host"
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

# ── Crear directorio de instalación ───────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
mkdir -p "$CHROME_HOSTS_DIR"

# ── Compilar binario Mach-O (Chrome no puede ejecutar scripts shell) ──────────
"$PYTHON3" - << PYEOF
import os, sys, subprocess, tempfile

python3 = "$PYTHON3"
script  = "$PYTHON_SCRIPT"
host    = "$HOST_BIN"

src = r"""
#include <unistd.h>
int main(int argc, char *argv[]) {
    char *python3 = "PYTHON3";
    char *script  = "SCRIPT";
    char *args[]  = { python3, script, (char*)0 };
    execv(python3, args);
    return 1;
}
""".replace("PYTHON3", python3).replace("SCRIPT", script)

tmp = tempfile.mktemp(suffix=".c")
open(tmp, "w").write(src)
ret = subprocess.call(["clang", "-o", host, tmp])
os.unlink(tmp)
if ret != 0:
    print("ERROR: no se pudo compilar el binario")
    sys.exit(1)
os.chmod(host, 0o755)
print("Binario compilado:", host)
PYEOF

if [ $? -ne 0 ]; then
  osascript -e 'display dialog "Error al compilar el actualizador.\n\nAsegúrate de tener Xcode Command Line Tools instalado:\nxcode-select --install" with title "Navie" buttons {"OK"} default button "OK" with icon stop'
  exit 1
fi

# ── Registrar en Chrome ───────────────────────────────────────────────────────
"$PYTHON3" - << PYEOF
import json
manifest = {
    "name": "com.navie.updater",
    "description": "Navie Extension Auto-Updater",
    "path": "$HOST_BIN",
    "type": "stdio",
    "allowed_origins": ["chrome-extension://omljpaaaikpbmpmcifkldfpjgogipmkp/"]
}
with open("$MANIFEST_PATH", "w") as f:
    json.dump(manifest, f, indent=2)
print("Manifest registrado:", "$MANIFEST_PATH")
PYEOF

# ── Listo ─────────────────────────────────────────────────────────────────────
osascript -e 'display dialog "✅ ¡Instalado!\n\nLas próximas actualizaciones de Navie se instalan automáticamente. Solo tendrás que recargar la extensión en chrome://extensions cuando te avise." with title "Navie" buttons {"OK"} default button "OK" with icon note'
echo "✅ Instalación completada."
echo "   Binario: $HOST_BIN"
echo "   Script:  $PYTHON_SCRIPT"
echo "   Carpeta de extensión: $EXTENSION_DIR"
