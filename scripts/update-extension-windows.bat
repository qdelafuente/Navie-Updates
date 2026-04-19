@echo off
setlocal

:: ─────────────────────────────────────────────────────────────────
:: Navie - Script de actualización (Windows)
:: Descarga la última versión y la instala automáticamente.
:: ─────────────────────────────────────────────────────────────────

set REPO=qdelafuente/Navie-Updates
set INSTALL_DIR=%LOCALAPPDATA%\NavieExtension
set ZIP_FILE=%TEMP%\navie-extension.zip
set DOWNLOAD_URL=https://github.com/%REPO%/releases/latest/download/navie-extension.zip

:: Mostrar ventana de inicio con diálogo gráfico
powershell -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Descargando la última versión de Navie...`n`nEsto tardará unos segundos.', 'Navie — Actualizando', 'OK', 'Information')" >nul 2>&1

:: Crear carpeta de instalación si no existe
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

:: Descargar ZIP
powershell -Command "Invoke-WebRequest -Uri '%DOWNLOAD_URL%' -OutFile '%ZIP_FILE%'" >nul 2>&1

if not exist "%ZIP_FILE%" (
    powershell -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Error al descargar la actualización.`nComprueba tu conexión a internet e inténtalo de nuevo.', 'Navie — Error', 'OK', 'Error')" >nul 2>&1
    exit /b 1
)

:: Descomprimir y sobrescribir archivos anteriores
powershell -Command "Expand-Archive -Path '%ZIP_FILE%' -DestinationPath '%INSTALL_DIR%' -Force" >nul 2>&1

:: Borrar ZIP temporal
del "%ZIP_FILE%" >nul 2>&1

:: Abrir chrome://extensions automáticamente para que el usuario recargue
start chrome "chrome://extensions"

:: Mostrar ventana de éxito
powershell -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('✓ Actualización descargada correctamente.`n`nAhora en Chrome:`n1. Busca la extensión Navie`n2. Haz clic en el botón Recargar (⟲)`n`nListo!', 'Navie — Actualización lista', 'OK', 'Information')" >nul 2>&1

endlocal
