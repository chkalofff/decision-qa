# Удаление «Вердикта» (Windows).
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall_windows.ps1 [-Yes]
param([switch]$Yes)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if (-not $Yes) {
  Write-Host "Это удалит «Вердикт» из каталога:"
  Write-Host "  $root"
  Write-Host "Будут удалены: приложение, логи, задача автозапуска. API-ключи будут удалены вместе с приложением."
  $ans = Read-Host "Продолжить? [y/N]"
  if ($ans -notmatch '^[Yy]') { Write-Host "Отменено."; exit 0 }
}

# 1. Остановка backend: процесс, слушающий :8000 (только если это наш uvicorn)
$conn = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
  if ($proc -and $proc.Path -like "*$root*") {
    Stop-Process -Id $proc.Id -Force
    Write-Host "Остановлен backend (pid $($proc.Id))"
  } else {
    Write-Host "Порт 8000 занят чужим процессом — не трогаю его."
  }
}

# 2. Автозапуск
Unregister-ScheduledTask -TaskName "Decision-QA" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Автозапуск снят"

# 3. Каталог приложения
Remove-Item -Recurse -Force $root
Write-Host "Каталог приложения удалён: $root"

Write-Host ""
Write-Host "Вердикт удалён."
