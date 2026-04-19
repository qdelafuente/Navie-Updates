#!/usr/bin/env python3
"""
navie_updater.py — Native Messaging host for Navie Chrome Extension.

Receives a message from the extension with a download URL, downloads the ZIP,
extracts it to the extension folder, and responds with success/error.

Protocol: Chrome Native Messaging (4-byte length prefix, JSON payload).
"""

import sys
import json
import struct
import os
import zipfile
import shutil
import tempfile
import platform
import glob
import urllib.request


def read_message():
    """Read a native messaging message from stdin."""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        sys.exit(0)
    message_length = struct.unpack("=I", raw_length)[0]
    message = sys.stdin.buffer.read(message_length).decode("utf-8")
    return json.loads(message)


def send_message(msg):
    """Send a native messaging message to stdout."""
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def find_extension_dir(extension_id):
    """
    Find the unpacked extension directory on disk given its Chrome extension ID.
    Searches common Chrome profile locations.
    """
    system = platform.system()

    if system == "Darwin":
        base_paths = [
            os.path.expanduser("~/Library/Application Support/Google/Chrome"),
            os.path.expanduser("~/Library/Application Support/Google/Chrome Beta"),
            os.path.expanduser("~/Library/Application Support/Chromium"),
        ]
    elif system == "Windows":
        local_app = os.environ.get("LOCALAPPDATA", "")
        base_paths = [
            os.path.join(local_app, "Google", "Chrome", "User Data"),
            os.path.join(local_app, "Google", "Chrome Beta", "User Data"),
        ]
    else:
        home = os.path.expanduser("~")
        base_paths = [
            os.path.join(home, ".config", "google-chrome"),
            os.path.join(home, ".config", "chromium"),
        ]

    for base in base_paths:
        if not os.path.isdir(base):
            continue
        # Look for unpacked extension in Extensions folder under any profile
        pattern = os.path.join(base, "*", "Extensions", extension_id, "*")
        matches = glob.glob(pattern)
        for match in matches:
            if os.path.isdir(match) and os.path.isfile(os.path.join(match, "manifest.json")):
                return match

    return None


def download_and_extract(url, extension_dir):
    """Download ZIP from url and extract to extension_dir."""
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".zip")
    try:
        os.close(tmp_fd)
        # Download
        req = urllib.request.Request(url, headers={"User-Agent": "Navie-Updater/1.0"})
        with urllib.request.urlopen(req, timeout=60) as response, open(tmp_path, "wb") as f:
            shutil.copyfileobj(response, f)

        # Validate ZIP
        if not zipfile.is_zipfile(tmp_path):
            return False, "Downloaded file is not a valid ZIP"

        # Backup current extension to a temp dir (for rollback)
        backup_dir = tempfile.mkdtemp(prefix="navie_backup_")
        try:
            if os.path.isdir(extension_dir):
                shutil.copytree(extension_dir, backup_dir, dirs_exist_ok=True)

            with zipfile.ZipFile(tmp_path, "r") as zf:
                # Security: check for path traversal
                for member in zf.namelist():
                    if member.startswith("/") or ".." in member:
                        return False, f"Unsafe path in ZIP: {member}"
                zf.extractall(extension_dir)

        except Exception as e:
            # Attempt rollback
            try:
                shutil.copytree(backup_dir, extension_dir, dirs_exist_ok=True)
            except Exception:
                pass
            return False, f"Extraction failed: {str(e)}"
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
            send_message({"ok": True, "message": "pong"})
            return

        if action == "update":
            url = msg.get("url")
            extension_id = msg.get("extensionId")

            if not url:
                send_message({"ok": False, "error": "Missing url"})
                return
            if not extension_id:
                send_message({"ok": False, "error": "Missing extensionId"})
                return

            # Find extension directory
            extension_dir = find_extension_dir(extension_id)
            if not extension_dir:
                send_message({"ok": False, "error": f"Extension directory not found for ID: {extension_id}. Make sure the extension is installed as unpacked."})
                return

            success, message = download_and_extract(url, extension_dir)
            send_message({"ok": success, "message": message, "extensionDir": extension_dir})
            return

        send_message({"ok": False, "error": f"Unknown action: {action}"})

    except Exception as e:
        send_message({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
