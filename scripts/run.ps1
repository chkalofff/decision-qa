# Запуск Decision-QA на Windows (remote-only режим, см. docs/windows.md).
# Локальные модели (SGLang/Clef/llama.cpp) на Windows недоступны.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$py = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "Создаю .venv и ставлю зависимости backend..."
    py -3.12 -m venv .venv
    & $py -m pip install -r backend\requirements.txt
}

try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/health" -TimeoutSec 2 -UseBasicParsing
    Write-Host "Уже запущен: http://127.0.0.1:8000"
} catch {
    New-Item -ItemType Directory -Force -Path server\logs | Out-Null
    Start-Process -FilePath $py -ArgumentList "-m", "uvicorn", "backend.app:app", "--port", "8000" `
        -WorkingDirectory $root -RedirectStandardOutput (Join-Path $root "server\logs\app.log") `
        -RedirectStandardError (Join-Path $root "server\logs\app.err.log") -WindowStyle Hidden
    Write-Host "Запускаю backend, лог: server\logs\app.log"
    foreach ($i in 1..20) {
        Start-Sleep -Milliseconds 500
        try {
            $null = Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/health" -TimeoutSec 2 -UseBasicParsing
            break
        } catch {}
    }
}

Start-Process "http://127.0.0.1:8000"
