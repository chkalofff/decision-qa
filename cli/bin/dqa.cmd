@echo off
setlocal
set "ROOT=%~dp0..\.."
set "PYTHON="
set "PYTHON_ARGS="
if exist "%ROOT%\.venv-test\Scripts\python.exe" set "PYTHON=%ROOT%\.venv-test\Scripts\python.exe"
if not defined PYTHON where py >nul 2>nul && (set "PYTHON=py" & set "PYTHON_ARGS=-3.12")
if not defined PYTHON where python >nul 2>nul && set "PYTHON=python"
if not defined PYTHON (
  echo dqa: Python 3.12+ not found. Install Python, then run dqa doctor 1>&2
  exit /b 69
)
set "PYTHONPATH=%ROOT%\cli;%ROOT%;%PYTHONPATH%"
"%PYTHON%" %PYTHON_ARGS% -c "import sys; assert sys.version_info >= (3, 12); import httpx, rfc8785" >nul 2>nul
if errorlevel 1 (
  echo dqa: Python 3.12+ and cli/requirements.txt dependencies are required. Run: python -m pip install -r "%ROOT%\cli\requirements.txt" 1>&2
  exit /b 69
)
"%PYTHON%" %PYTHON_ARGS% -m dqa %*
exit /b %ERRORLEVEL%
