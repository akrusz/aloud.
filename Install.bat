@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
echo.
echo   Done! Double-click Start.bat to launch.
echo   Press any key to close...
pause >nul
