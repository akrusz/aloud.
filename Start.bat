@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File start.ps1 --open
