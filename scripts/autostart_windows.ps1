# Автозапуск «Вердикта» при входе пользователя (Windows, Планировщик задач).
#   powershell -ExecutionPolicy Bypass -File scripts\autostart_windows.ps1 -Action on|off|status
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("on", "off", "status")]
  [string]$Action
)

$ErrorActionPreference = "Stop"
$taskName = "Decision-QA"
$root = Split-Path -Parent $PSScriptRoot
$runPs1 = Join-Path $root "scripts\run.ps1"

switch ($Action) {
  "on" {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
      -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runPs1`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
      -Principal $principal -Description "Автозапуск Decision-QA (http://127.0.0.1:8000)" -Force | Out-Null
    Write-Host "Автозапуск включён: задача '$taskName' в Планировщике (при входе пользователя)."
  }
  "off" {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Автозапуск отключён (работающий backend не остановлен)."
  }
  "status" {
    $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($t) { Write-Host "Автозапуск: ВКЛЮЧЁН (задача '$taskName', состояние: $($t.State))" }
    else { Write-Host "Автозапуск: выключен" }
  }
}
