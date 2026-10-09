#!/usr/bin/env bash
# Удаление «Вердикта» с этого Mac.
#   bash scripts/uninstall_mac.sh [--yes]
# Останавливает backend, снимает автозапуск, удаляет каталог приложения.
# Кэш скачанных моделей (~/.cache/huggingface) НЕ трогаем без явного согласия.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" != "--yes" ]]; then
  echo "Это удалит «Вердикт» из каталога:"
  echo "  $ROOT"
  echo "Будут удалены: приложение, логи, автозапуск. API-ключи (credentials.json) будут удалены вместе с приложением."
  read -r -p "Продолжить? [y/N] " ans
  [[ "${ans:-N}" =~ ^[Yy] ]] || { echo "Отменено."; exit 0; }
fi

# 1. Остановка backend: pid процесса uvicorn, слушающего :8000 (если это наш)
PID="$(lsof -ti tcp:8000 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$PID" ]]; then
  CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"
  if [[ "$CMD" == *"uvicorn backend.app:app"* ]]; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
    echo "Остановлен backend (pid $PID)"
  else
    echo "Порт 8000 занят чужим процессом (pid $PID) — не трогаю его."
  fi
fi

# 2. Автозапуск
if [[ -x "$ROOT/scripts/autostart_mac.sh" ]]; then
  bash "$ROOT/scripts/autostart_mac.sh" off >/dev/null 2>&1 || true
  echo "Автозапуск снят"
fi
# На всякий случай — старые/альтернативные plist'ы, которые могли быть созданы вручную
for LEGACY_LABEL in com.chkalofff.decision-qa; do
  launchctl bootout "gui/$(id -u)/$LEGACY_LABEL" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
done

# 3. Каталог приложения
rm -rf "$ROOT"
echo "Каталог приложения удалён: $ROOT"

# 4. Модели
CACHE="$HOME/.cache/huggingface"
if [[ -d "$CACHE" ]]; then
  echo
  echo "Скачанные модели (~/.cache/huggingface) не удалены — этот кэш могут использовать другие приложения."
  read -r -p "Удалить и его? [y/N] " ans2
  if [[ "${ans2:-N}" =~ ^[Yy] ]]; then
    rm -rf "$CACHE"
    echo "Кэш моделей удалён."
  fi
fi

echo
echo "Вердикт удалён."
