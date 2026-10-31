@echo off
rem Установка и запуск «Вердикта» (Windows, режим облачных моделей).
rem Двойной клик после распаковки архива. Права администратора не нужны.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\run.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
