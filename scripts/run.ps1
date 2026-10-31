# Запуск «Вердикта» на Windows (remote-only режим, см. docs/windows.md).
# Локальные модели (SGLang/Clef/llama.cpp) на Windows недоступны.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Для «Вердикта» требуется 64-разрядная Windows."
}

$uv = Join-Path $root "runtime\uv.exe"
if (-not (Test-Path -LiteralPath $uv)) {
    throw "Не найден встроенный runtime\uv.exe. Распакуйте релизный архив целиком."
}

$venv = Join-Path $root ".venv"
$py = Join-Path $venv "Scripts\python.exe"
$env:UV_PYTHON_INSTALL_DIR = Join-Path $root ".runtime\python"
$env:UV_CACHE_DIR = Join-Path $root ".cache\uv"

$pythonOk = $false
if (Test-Path -LiteralPath $py) {
    & $py -c "import sys; assert sys.version_info >= (3, 12)" 2>$null
    $pythonOk = $LASTEXITCODE -eq 0
}
if (-not $pythonOk) {
    Write-Host "Устанавливаю переносимый Python 3.12 и создаю .venv..."
    & $uv --no-config venv --python 3.12 --managed-python --clear $venv
    if ($LASTEXITCODE -ne 0) {
        throw "Не удалось создать среду Python. Проверьте интернет и повторите install.bat."
    }
}

$backendRequirements = Join-Path $root "backend\requirements.txt"
$cliRequirements = Join-Path $root "cli\requirements.txt"
$requirements = @($backendRequirements, $cliRequirements)
$fingerprint = (($requirements | ForEach-Object {
    (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash
}) -join "|")
$stamp = Join-Path $venv ".dqa-requirements.sha256"
$installedFingerprint = ""
if (Test-Path -LiteralPath $stamp) {
    $installedFingerprint = (Get-Content -LiteralPath $stamp -Raw).Trim()
}
$needsInstall = $installedFingerprint -ne $fingerprint

& $py -c "import sys; assert sys.version_info >= (3, 12); import fastapi, uvicorn, httpx, psutil, pytest, pytest_asyncio, rfc8785" 2>$null
if ($LASTEXITCODE -ne 0) {
    $needsInstall = $true
}

if ($needsInstall) {
    Write-Host "Устанавливаю зависимости приложения и CLI..."
    & $uv --no-config pip install --python $py --only-binary=:all: --strict `
        --requirements $backendRequirements --requirements $cliRequirements
    if ($LASTEXITCODE -ne 0) {
        throw "Не удалось установить зависимости. Проверьте интернет и повторите install.bat."
    }
    & $py -c "import sys; assert sys.version_info >= (3, 12); import fastapi, uvicorn, httpx, psutil, pytest, pytest_asyncio, rfc8785"
    if ($LASTEXITCODE -ne 0) {
        throw "Установленная среда Python не прошла проверку импортов."
    }
    Set-Content -LiteralPath $stamp -Value $fingerprint -Encoding ASCII -NoNewline
}

$alreadyRunning = $false
try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/health" -TimeoutSec 2 -UseBasicParsing
    $alreadyRunning = $true
} catch {}

if ($alreadyRunning) {
    Write-Host "Уже запущен: http://127.0.0.1:8000"
} else {
    New-Item -ItemType Directory -Force -Path server\logs | Out-Null
    Start-Process -FilePath $py -ArgumentList "-m", "uvicorn", "backend.app:app", "--port", "8000" `
        -WorkingDirectory $root -RedirectStandardOutput (Join-Path $root "server\logs\app.log") `
        -RedirectStandardError (Join-Path $root "server\logs\app.err.log") -WindowStyle Hidden
    Write-Host "Запускаю backend, лог: server\logs\app.log"
    $healthy = $false
    foreach ($i in 1..20) {
        Start-Sleep -Milliseconds 500
        try {
            $null = Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/health" -TimeoutSec 2 -UseBasicParsing
            $healthy = $true
            break
        } catch {}
    }
    if (-not $healthy) {
        throw "Backend не запустился. Подробности: server\logs\app.err.log"
    }
}

Start-Process "http://127.0.0.1:8000"
