@echo off
REM Setup is now handled automatically on first run.
cd /d "%~dp0\.."
powershell -ExecutionPolicy Bypass -File scripts\start.ps1 --open
