#!/usr/bin/env bash
# Запуск Bonsai-2 27B 2bit (эксперимент): кастомный Hadamard MLX-рантайм из
# репо модели (runtime/ внутри снапшота) + OpenAI-совместимый сервер
# server/bonsai/serve.py (GET /health, /v1/models, POST /v1/chat/completions).
# Стандартные mlx-lm/SGLang пак не загружают — см. PACK-RUNTIME.md в снапшоте.
# Установка venv (один раз):
#   uv venv -p 3.12 server/bonsai/.venv
#   uv pip install -p server/bonsai/.venv -r server/bonsai/requirements.txt
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/bonsai/.venv"

if [[ ! -d "$VENV" ]]; then
  echo "Виртуальное окружение не найдено: $VENV" >&2
  echo "Сначала выполните установку (см. README.md, раздел «Bonsai»)." >&2
  exit 1
fi
source "$VENV/bin/activate"

MODEL="${MODEL:-prism-ml/Ternary-Bonsai-2-27B-mlx-2bit}"
PORT="${PORT:-30006}"
# Зафиксированная ревизия пака (см. README.md, раздел «Bonsai»).
REVISION="${REVISION:-fcba37d2117a7077eac6b613b2668d14d9779edd}"

# Скачивает снапшот при первом старте (идемпотентно), печатает путь к нему.
SNAPSHOT="$(hf download "$MODEL" --revision "$REVISION" --quiet)"
MODEL_PATH="$SNAPSHOT" \
MODEL_ID="${MODEL_ID:-bonsai}" \
PORT="$PORT" \
exec python "$SCRIPT_DIR/bonsai/serve.py"
