@echo off
rem Запуск «Вердикта» (Windows, режим облачных моделей).
rem Двойной клик после распаковки архива.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\run.ps1"
pause
