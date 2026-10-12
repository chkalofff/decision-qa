#!/usr/bin/env bash
# Автозапуск «Вердикта» при входе в систему (macOS, LaunchAgent).
#   bash scripts/autostart_mac.sh          # показать статус и предложить on/off
#   bash scripts/autostart_mac.sh on       # включить и запустить сейчас
#   bash scripts/autostart_mac.sh off      # выключить автозапуск (backend не трогает)
#   bash scripts/autostart_mac.sh status   # только статус
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="ai.decision-qa"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

usage() { echo "Использование: bash scripts/autostart_mac.sh [on|off|status]" >&2; exit 2; }

show_status() {
  if [[ -f "$PLIST" ]] && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    echo "Автозапуск: ВКЛЮЧЁН ($PLIST)"
  elif [[ -f "$PLIST" ]]; then
    echo "Автозапуск: plist есть, но агент не загружен — выполните: bash scripts/autostart_mac.sh on"
  else
    echo "Автозапуск: ВЫКЛЮЧЕН"
  fi
}

enable_autostart() {
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ROOT/.venv-test/bin/python</string>
    <string>-m</string>
    <string>uvicorn</string>
    <string>backend.app:app</string>
    <string>--port</string>
    <string>8000</string>
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
  echo "Автозапуск включён: «Вердикт» будет стартовать при входе (порт 8000) и перезапускаться при падении."
  for _ in $(seq 1 20); do
    if curl -s -o /dev/null --max-time 2 http://127.0.0.1:8000/api/health; then
      echo "Сейчас: приложение запущено (http://127.0.0.1:8000)"
      return 0
    fi
    sleep 0.5
  done
  echo "Сейчас: не удалось дождаться запуска — см. $ROOT/server/logs/autostart.log" >&2
  return 1
}

disable_autostart() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Автозапуск отключён (работающий сейчас backend не остановлен)."
}

interactive() {
  show_status
  echo
  echo "Выберите действие:"
  echo "  1 — включить автозапуск"
  echo "  2 — выключить автозапуск"
  echo "  3 или Enter — отмена"
  read -r -p "Ваш выбор [1/2/3]: " ans
  case "${ans:-3}" in
    1|on|вкл|включить) enable_autostart ;;
    2|off|выкл|выключить) disable_autostart ;;
    3|""|cancel|отмена) echo "Отмена." ;;
    *) echo "Неизвестный выбор. Используйте: bash scripts/autostart_mac.sh on|off|status" >&2; exit 2 ;;
  esac
}

case "${1:-}" in
  on) enable_autostart ;;
  off) disable_autostart ;;
  status) show_status ;;
  "") interactive ;;
  *) usage ;;
esac
