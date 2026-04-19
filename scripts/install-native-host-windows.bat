@echo off
REM ─────────────────────────────────────────────────────────────────────────
REM install-native-host-windows.bat
REM Instala el Native Messaging host de Navie en Windows.
REM Ejecuta este script UNA VEZ después de instalar la extensión.
REM ─────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

REM Obtener el directorio de la extensión (un nivel arriba de scripts\)
set "SCRIPT_DIR=%~dp0"
set "EXTENSION_DIR=%SCRIPT_DIR:~0,-8%"
REM Quitar la barra final
if "%EXTENSION_DIR:~-1%"=="\" set "EXTENSION_DIR=%EXTENSION_DIR:~0,-1%"

set "PYTHON_HOST=%EXTENSION_DIR%\native-host\navie_updater.py"
set "DEST_DIR=%LOCALAPPDATA%\Navie\native-host"
set "DEST_SCRIPT=%DEST_DIR%\navie_updater.py"
set "REG_KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\com.navie.updater"
set "MANIFEST_PATH=%DEST_DIR%\com.navie.updater.json"

REM ── Verificar Python3 ──────────────────────────────────────────────────────
python --version >nul 2>&1
if errorlevel 1 (
  powershell -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Python 3 no está instalado.`n`nDescárgalo desde python.org', 'Navie Updater', 'OK', 'Error')"
  exit /b 1
)

REM ── Confirmar instalación ──────────────────────────────────────────────────
powershell -Command "$r = [System.Windows.Forms.MessageBox]::Show('Navie necesita instalar un componente para las actualizaciones automáticas.', 'Navie — Instalar actualizador', [System.Windows.Forms.MessageBoxButtons]::OKCancel, [System.Windows.Forms.MessageBoxIcon]::Information); if ($r -ne 'OK') { exit 1 }" 2>nul
if errorlevel 1 (
  echo Instalación cancelada.
  exit /b 0
)

REM ── Crear carpeta de destino ───────────────────────────────────────────────
if not exist "%DEST_DIR%" mkdir "%DEST_DIR%"

REM ── Copiar el script Python ────────────────────────────────────────────────
copy /Y "%PYTHON_HOST%" "%DEST_SCRIPT%" >nul

REM ── Escribir el manifest JSON ──────────────────────────────────────────────
python -c "
import json, os
manifest = {
    'name': 'com.navie.updater',
    'description': 'Navie Extension Auto-Updater',
    'path': r'%DEST_SCRIPT%',
    'type': 'stdio',
    'allowed_origins': ['chrome-extension://omljpaaaikpbmpmcifkldfpjgogipmkp/']
}
with open(r'%MANIFEST_PATH%', 'w') as f:
    json.dump(manifest, f, indent=2)
print('Manifest escrito')
"

REM ── Registrar en el registro de Windows ───────────────────────────────────
reg add "%REG_KEY%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul

powershell -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Actualizador de Navie instalado correctamente.`n`nA partir de ahora las actualizaciones se instalan automaticamente.', 'Navie — Instalacion completada', 'OK', 'Asterisk')"

echo Instalacion completada.
endlocal
