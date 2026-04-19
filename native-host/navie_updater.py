#!/usr/bin/env python3
"""
navie_updater.py — Native Messaging host for Navie Chrome Extension.

Este script vive dentro de la carpeta de la extensión (native-host/).
Sabe dónde está la extensión porque puede calcular su propia ubicación.

Protocol: Chrome Native Messaging (4-byte length prefix, JSON payload).
"""

import sys
import json
import struct
import os
import zipfile
import shutil
import tempfile
import urllib.request

# La extensión está un nivel arriba de este script (native-host/ → raíz)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
EXTENSION_DIR = os.path.dirname(SCRIPT_DIR)


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        sys.exit(0)
    message_length = struct.unpack("=I", raw_length)[0]
    message = sys.stdin.buffer.read(message_length).decode("utf-8")
    return json.loads(message)


def send_message(msg):
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def download_and_extract(url):
    """Descarga el ZIP desde url y lo extrae sobre EXTENSION_DIR."""
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".zip")
    try:
        os.close(tmp_fd)
        req = urllib.request.Request(url, headers={"User-Agent": "Navie-Updater/1.0"})
        with urllib.request.urlopen(req, timeout=60) as response, open(tmp_path, "wb") as f:
            shutil.copyfileobj(response, f)

        if not zipfile.is_zipfile(tmp_path):
            return False, "El archivo descargado no es un ZIP válido"

        # Backup por si falla la extracción
        backup_dir = tempfile.mkdtemp(prefix="navie_backup_")
        try:
            shutil.copytree(EXTENSION_DIR, backup_dir, dirs_exist_ok=True)

            with zipfile.ZipFile(tmp_path, "r") as zf:
                for member in zf.namelist():
                    if member.startswith("/") or ".." in member:
                        return False, f"Ruta insegura en el ZIP: {member}"
                zf.extractall(EXTENSION_DIR)

        except Exception as e:
            try:
                shutil.copytree(backup_dir, EXTENSION_DIR, dirs_exist_ok=True)
            except Exception:
                pass
            return False, f"Error al extraer: {str(e)}"
        finally:
            shutil.rmtree(backup_dir, ignore_errors=True)

        return True, "OK"
    except Exception as e:
        return False, str(e)
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


def main():
    try:
        msg = read_message()
        action = msg.get("action")

        if action == "ping":
            send_message({"ok": True, "message": "pong", "extensionDir": EXTENSION_DIR})
            return

        if action == "update":
            url = msg.get("url")
            if not url:
                send_message({"ok": False, "error": "Falta la URL del ZIP"})
                return

            # Verificar que tenemos manifest.json (sanity check)
            if not os.path.isfile(os.path.join(EXTENSION_DIR, "manifest.json")):
                send_message({"ok": False, "error": f"manifest.json no encontrado en {EXTENSION_DIR}"})
                return

            success, message = download_and_extract(url)
            send_message({"ok": success, "message": message, "extensionDir": EXTENSION_DIR})
            return

        send_message({"ok": False, "error": f"Acción desconocida: {action}"})

    except Exception as e:
        send_message({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
