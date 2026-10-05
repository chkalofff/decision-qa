# Обновление Decision-QA до последнего релиза (Windows).
#   powershell -ExecutionPolicy Bypass -File scripts\update.ps1
# Качает latest-релиз с GitHub, распаковывает поверх установки, сохраняя
# пользовательские данные (credentials.json, models_config.json, settings.json),
# затем доводит зависимости и перезапускает приложение.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$repo = "chkalofff/decision-qa"
$asset = "decision-qa-windows.zip"
$api = "https://api.github.com/repos/$repo/releases/latest"

function Info($msg) { Write-Host "== $msg" -ForegroundColor Bold }

$current = (Get-Content (Join-Path $root "VERSION") -TotalCount 1).Trim()
Info "Текущая версия: $current"

Info "Ищу последний релиз на GitHub"
$rel = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "decision-qa-updater" }
$tag = $rel.tag_name
$url = ($rel.assets | Where-Object { $_.name -eq $asset }).browser_download_url
if (-not $url) { throw "В релизе $tag нет ассета $asset" }
Write-Host "Последний релиз: $tag"

if ($tag -eq "v$current") {
  Write-Host "Уже актуальная версия — обновление не требуется."
  exit 0
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dq-update-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Info "Скачиваю $asset"
  Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp "release.zip") -UseBasicParsing

  Info "Распаковываю"
  Expand-Archive -Path (Join-Path $tmp "release.zip") -DestinationPath (Join-Path $tmp "extract") -Force

  Info "Сохраняю пользовательские данные"
  $bk = Join-Path $tmp "backup"
  New-Item -ItemType Directory -Force -Path $bk | Out-Null
  foreach ($f in @("backend\credentials.json", "backend\models_config.json", "backend\settings.json")) {
    $src = Join-Path $root $f
    if (Test-Path $src) {
      Copy-Item $src $bk
      Write-Host "  бэкап: $f"
    }
  }

  Info "Обновляю файлы в $root"
  Copy-Item -Path (Join-Path $tmp "extract\*") -Destination $root -Recurse -Force
  foreach ($f in @("backend\credentials.json", "backend\models_config.json", "backend\settings.json")) {
    $src = Join-Path $bk (Split-Path $f -Leaf)
    if (Test-Path $src) {
      Copy-Item $src (Join-Path $root $f) -Force
      Write-Host "  восстановлено: $f"
    }
  }

  $new = (Get-Content (Join-Path $root "VERSION") -TotalCount 1).Trim()
  Info "Версия после обновления: $new"

  Info "Довожу зависимости и перезапускаю"
  # останавливаем старый backend (run.ps1 сам не перезапускает работающий)
  $conn = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) {
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and $proc.Path -like "*$root*") {
      Stop-Process -Id $proc.Id -Force
      Write-Host "  остановлен старый backend (pid $($proc.Id))"
      Start-Sleep -Seconds 1
    }
  }
  & (Join-Path $root "scripts\run.ps1")

  Info "Обновлено до $tag. Приложение: http://127.0.0.1:8000"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
