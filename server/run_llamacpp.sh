#!/usr/bin/env bash
# Запуск GGUF-модели через llama-server (llama.cpp), протокол /v1/systemone.
# Бинарник: сборка из master в server/llama.cpp (brew-версия старая и не грузит
# Laya — см. README.md, раздел «Laya»). Фолбэк: llama-server из PATH.
# Переменные: MODEL (hf-репо GGUF), GGUF_FILE (файл внутри репо), PORT.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/llama.cpp/build/bin/llama-server"

if [[ ! -x "$BIN" ]]; then
  BIN="$(command -v llama-server || true)"
fi
if [[ -z "$BIN" ]]; then
  echo "llama-server не найден. Соберите из master (см. README.md, раздел «Laya»):" >&2
  echo "  git clone --depth 1 https://github.com/ggml-org/llama.cpp server/llama.cpp" >&2
  echo "  cmake -B server/llama.cpp/build -S server/llama.cpp -DGGML_METAL=ON" >&2
  echo "  cmake --build server/llama.cpp/build -j --target llama-server" >&2
  exit 1
fi

VENV="$SCRIPT_DIR/clef/.venv"
HF="$VENV/bin/hf"
if [[ ! -x "$HF" ]]; then
  HF="$(command -v hf || true)"
fi
if [[ -z "$HF" ]]; then
  echo "Не найден hf CLI (нужен huggingface_hub; см. README.md, раздел «Clef»)." >&2
  exit 1
fi

MODEL="${MODEL:-ggml-org/Laya-GGUF}"
GGUF_FILE="${GGUF_FILE:-Laya-Q8_0.gguf}"
PORT="${PORT:-30005}"

# Скачивает файл при первом старте (идемпотентно), печатает путь к снапшоту.
SNAPSHOT="$("$HF" download "$MODEL" --include "$GGUF_FILE" --quiet)"

# -b/-ub 8192: дефолтный physical batch 512 меньше типичного промпта Laya —
# без этого запросы падают с 500 «physical batch size».
exec "$BIN" -m "$SNAPSHOT/$GGUF_FILE" --port "$PORT" --host 127.0.0.1 \
  -b 8192 -ub 8192 -c 16384
