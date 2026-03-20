@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File scripts\setup-local.ps1
echo.
echo   Done! Double-click Start-Windows.bat to launch.
echo   Press any key to close...
pause >nul
