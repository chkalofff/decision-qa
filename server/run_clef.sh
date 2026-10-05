#!/usr/bin/env bash
# Запуск Clef (decision-модель Cloudflare) локально: MLX-конвертация mlx-community,
# сервер POST /v1/systemone (Jev-совместимый) + GET /v1/models, /health.
# Установка venv (один раз):
#   uv venv -p 3.12 server/clef/.venv
#   uv pip install -p server/clef/.venv -r server/clef/requirements.txt
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/clef/.venv"

if [[ ! -d "$VENV" ]]; then
  echo "Виртуальное окружение не найдено: $VENV" >&2
  echo "Сначала выполните установку (см. README.md, раздел «Clef»)." >&2
  exit 1
fi
source "$VENV/bin/activate"

MODEL="${MODEL:-mlx-community/clef-flash-4bit}"
PORT="${PORT:-30003}"

# Скачивает снапшот при первом старте (идемпотентно), печатает путь к нему.
SNAPSHOT="$(hf download "$MODEL" --quiet)"
cd "$SNAPSHOT"
exec python clef_mlx.py serve --port "$PORT"
