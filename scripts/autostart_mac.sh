#!/usr/bin/env bash
# Автозапуск Decision-QA при входе в систему (macOS, LaunchAgent).
#   bash scripts/autostart_mac.sh on|off|status
#   bash scripts/autostart_mac.sh on   # включить и запустить сейчас
#   bash scripts/autostart_mac.sh off  # выключить автозапуск (backend не трогает)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="ai.decision-qa"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

usage() { echo "Использование: bash scripts/autostart_mac.sh on|off|status" >&2; exit 2; }

case "${1:-}" in
  on)
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/scripts/run.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict><key>DQ_NO_OPEN</key><string>1</string></dict>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StandardOutPath</key><string>$ROOT/server/logs/autostart.log</string>
  <key>StandardErrorPath</key><string>$ROOT/server/logs/autostart.log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Автозапуск включён: Decision-QA будет стартовать при входе (порт 8000) и перезапускаться при падении."
    echo "Сейчас: $(bash "$ROOT/scripts/run.sh" >/dev/null 2>&1 && echo 'приложение запущено' || echo 'не удалось запустить — см. server/logs/autostart.log')"
    ;;
  off)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Автозапуск отключён (работающий сейчас backend не остановлен)."
    ;;
  status)
    if [[ -f "$PLIST" ]] && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
      echo "Автозапуск: ВКЛЮЧЁН ($PLIST)"
    elif [[ -f "$PLIST" ]]; then
      echo "Автозапуск: plist есть, но агент не загружен — выполните: bash scripts/autostart_mac.sh on"
    else
      echo "Автозапуск: выключен"
    fi
    ;;
  *) usage ;;
esac
