# Запуск «Вердикта» на Windows (remote-only режим, см. docs/windows.md).
# Локальные модели (SGLang/Clef/llama.cpp) на Windows недоступны.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:DQA_REMOTE_ONLY = "1"

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

function Test-Python {
    param([Parameter(Mandatory = $true)][string]$Code)
    $previousPreference = $ErrorActionPreference
    $probeExitCode = 1
    $ErrorActionPreference = "Continue"
    try {
        & $py -c $Code 2>$null
        $probeExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return $probeExitCode -eq 0
}

$pythonOk = $false
if (Test-Path -LiteralPath $py) {
    $pythonOk = Test-Python "import sys; assert sys.version_info >= (3, 12)"
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
$importCheck = "import sys; assert sys.version_info >= (3, 12); import fastapi, uvicorn, httpx, psutil, pytest, pytest_asyncio, rfc8785"
if (-not (Test-Python $importCheck)) {
    $needsInstall = $true
}

if ($needsInstall) {
    Write-Host "Устанавливаю зависимости приложения и CLI..."
    & $uv --no-config pip install --python $py --only-binary=:all: --strict `
        --requirements $backendRequirements --requirements $cliRequirements
    if ($LASTEXITCODE -ne 0) {
        throw "Не удалось установить зависимости. Проверьте интернет и повторите install.bat."
    }
    if (-not (Test-Python $importCheck)) {
        throw "Установленная среда Python не прошла проверку импортов."
    }
    Set-Content -LiteralPath $stamp -Value $fingerprint -Encoding ASCII -NoNewline
}

$versionUrl = "http://127.0.0.1:8000/api/version"
$alreadyRunning = $false
try {
    $null = Invoke-WebRequest -Uri $versionUrl -TimeoutSec 2 -UseBasicParsing
    $alreadyRunning = $true
} catch {}

if ($alreadyRunning) {
    Write-Host "Уже запущен: http://127.0.0.1:8000"
} else {
    New-Item -ItemType Directory -Force -Path server\logs | Out-Null
    $errorLog = Join-Path $root "server\logs\app.err.log"
    $backendProcess = Start-Process -FilePath $py `
        -ArgumentList "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", "8000" `
        -WorkingDirectory $root -RedirectStandardOutput (Join-Path $root "server\logs\app.log") `
        -RedirectStandardError $errorLog -WindowStyle Hidden -PassThru
    Write-Host "Запускаю backend, лог: server\logs\app.log"
    $healthy = $false
    foreach ($i in 1..120) {
        if ($backendProcess.HasExited) {
            break
        }
        Start-Sleep -Milliseconds 500
        try {
            $null = Invoke-WebRequest -Uri $versionUrl -TimeoutSec 2 -UseBasicParsing
            $healthy = $true
            break
        } catch {}
    }
    if (-not $healthy) {
        if (Test-Path -LiteralPath $errorLog) {
            Write-Host "Последние строки server\logs\app.err.log:"
            Get-Content -LiteralPath $errorLog -Tail 20 | Write-Host
        }
        throw "Backend не запустился. Подробности: server\logs\app.err.log"
    }
}

Start-Process "http://127.0.0.1:8000"
