#!/usr/bin/env bash
# Запуск Decision-QA: uvicorn на :8000 (фон, лог server/logs/app.log) + браузер.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY="$ROOT/.venv-test/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "Нет .venv-test — сначала выполните: bash scripts/setup_mac.sh" >&2
  exit 1
fi

if curl -s -o /dev/null --max-time 2 http://127.0.0.1:8000/api/health; then
  echo "Уже запущен: http://127.0.0.1:8000"
else
  mkdir -p server/logs
  nohup "$PY" -m uvicorn backend.app:app --port 8000 > server/logs/app.log 2>&1 &
  echo "Запускаю backend (pid $!), лог: server/logs/app.log"
  for _ in $(seq 1 20); do
    sleep 0.5
    if curl -s -o /dev/null --max-time 2 http://127.0.0.1:8000/api/health; then
      break
    fi
  done
fi

if [[ "${DQ_NO_OPEN:-0}" != "1" ]]; then
  open http://127.0.0.1:8000
fi
