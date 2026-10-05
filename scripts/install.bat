@echo off
rem Запуск Decision-QA (Windows, режим облачных моделей).
rem Двойной клик после распаковки архива.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\run.ps1"
pause
