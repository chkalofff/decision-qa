#!/usr/bin/env bash
# Запуск SGLang с MLX-бэкендом (Apple Silicon) и моделью Qwen3.8-27B-4bit.
# Установка: см. README.md (раздел «Установка SGLang»).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/sglang/.venv"

if [[ ! -d "$VENV" ]]; then
  echo "Виртуальное окружение не найдено: $VENV" >&2
  echo "Сначала выполните установку SGLang (см. README.md)." >&2
  exit 1
fi
source "$VENV/bin/activate"

MODEL="${MODEL:-mlx-community/Qwen3.8-27B-4bit}"
PORT="${PORT:-30000}"
# Доля GPU-памяти под модель+KV. При двух серверах одновременно сумма должна
# быть заметно ниже 1.0 (Metal working set общий), иначе OOM на prefill.
MEM_FRACTION="${MEM_FRACTION:-0.85}"

# SGLANG_USE_MLX=1        — MLX-бэкенд вместо torch.mps
# --disable-cuda-graph    — CUDA graph на Metal неприменим
# SGLANG_MLX_CLEAR_CACHE_STEPS=64 — чаще чистить MLX-кэш (защита от роста памяти)
# RADIX_CACHE=0 (default) отключает radix cache — на MLX есть баг mamba-компонента.
# RADIX_CACHE=1 включает кэш префиксов (быстрее на повторных контекстах).
EXTRA_ARGS=()
if [[ "${RADIX_CACHE:-0}" != "1" ]]; then
  EXTRA_ARGS+=(--disable-radix-cache)
fi

SGLANG_USE_MLX=1 \
SGLANG_MLX_CLEAR_CACHE_STEPS="${SGLANG_MLX_CLEAR_CACHE_STEPS:-64}" \
python -m sglang.launch_server \
  --model-path "$MODEL" \
  --disable-cuda-graph \
  --mamba-radix-cache-strategy no_buffer \
  --disable-overlap-schedule \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} \
  --mlx-enable-sampling \
  --context-length "${CONTEXT_LENGTH:-32768}" \
  --mem-fraction-static "$MEM_FRACTION" \
  --chunked-prefill-size "${CHUNKED_PREFILL:-1024}" \
  --max-running-requests "${MAX_RUNNING:-8}" \
  --max-total-tokens "${MAX_TOTAL_TOKENS:-32768}" \
  --host 127.0.0.1 \
  --port "$PORT"
