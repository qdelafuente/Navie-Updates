@echo off
REM ─────────────────────────────────────────────────────────────────────────
REM install-native-host-windows.bat
REM Instala el actualizador automático de Navie en Windows.
REM El usuario solo necesita hacer DOBLE CLIC en este archivo.
REM No requiere permisos de administrador.
REM ─────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

REM Ruta del script Python (dentro de la extensión, no hay que copiar nada)
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "EXTENSION_DIR=%SCRIPT_DIR:~0,-8%"
if "%EXTENSION_DIR:~-1%"=="\" set "EXTENSION_DIR=%EXTENSION_DIR:~0,-1%"

set "PYTHON_SCRIPT=%EXTENSION_DIR%\native-host\navie_updater.py"
set "MANIFEST_DIR=%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts"
set "MANIFEST_PATH=%MANIFEST_DIR%\com.navie.updater.json"
set "REG_KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\com.navie.updater"

REM ── Verificar Python ──────────────────────────────────────────────────────
python --version >nul 2>&1
if errorlevel 1 (
  powershell -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Python 3 no esta instalado.`nDescargalo desde python.org', 'Navie', 'OK', 'Error')"
  exit /b 1
)

REM ── Confirmar ────────────────────────────────────────────────────────────
powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $r = [System.Windows.Forms.MessageBox]::Show('Navie instalara el componente de actualizaciones automaticas.`n`n✓ No requiere contrasena de administrador.', 'Navie — Actualizaciones automaticas', [System.Windows.Forms.MessageBoxButtons]::OKCancel, [System.Windows.Forms.MessageBoxIcon]::Information); if ($r -ne 'OK') { exit 1 }"
if errorlevel 1 exit /b 0

REM ── Crear carpeta de native messaging hosts (usuario, sin admin) ──────────
if not exist "%MANIFEST_DIR%" mkdir "%MANIFEST_DIR%"

REM ── Escribir manifest JSON apuntando al script en la extensión ────────────
python -c "
import json
manifest = {
    'name': 'com.navie.updater',
    'description': 'Navie Extension Auto-Updater',
    'path': r'%PYTHON_SCRIPT%',
    'type': 'stdio',
    'allowed_origins': ['chrome-extension://omljpaaaikpbmpmcifkldfpjgogipmkp/']
}
with open(r'%MANIFEST_PATH%', 'w') as f:
    json.dump(manifest, f, indent=2)
"

REM ── Registrar en HKCU (sin admin) ────────────────────────────────────────
reg add "%REG_KEY%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul

powershell -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Las actualizaciones de Navie ahora se instalan automaticamente.`n`nCuando haya una nueva version, solo tendras que recargar la extension en chrome://extensions.', 'Navie — Instalacion completada', 'OK', 'Asterisk')"

endlocal
