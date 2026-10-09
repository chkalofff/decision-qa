#!/usr/bin/env bash
# Идемпотентная установка «Вердикта» на macOS (Apple Silicon).
#   bash scripts/setup_mac.sh          — установить/довести окружение
#   bash scripts/setup_mac.sh --force  — перезаписать enabled-профиль в
#                                        backend/models_config.json даже если
#                                        конфиг правили вручную после прошлого setup
#
# Что делает:
#   1. Проверяет uv (или python3.12+) и git (не ставит их молча — печатает подсказки).
#   2. Создаёт venv'ы и ставит зависимости: backend (.venv-test) и clef
#      (server/clef/.venv). Повторный запуск — быстрая no-op переустановка.
#   3. SGLang НЕ ставит автоматически (тяжёлый source-чекаут): если
#      server/sglang отсутствует — печатает инструкцию и выключает sglang-модели.
#   4. По объёму RAM выбирает профиль enabled в backend/models_config.json:
#      >= 48 ГБ — всё как в конфиге; 24–48 — выключает 27B/35B; < 24 — remote-only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "Неизвестный аргумент: $arg (поддерживается только --force)" >&2; exit 2 ;;
  esac
done

info() { printf '\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*" >&2; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  warn "Этот скрипт рассчитан на macOS. Для Windows см. docs/windows.md."
fi

# --- 1. Проверки окружения -------------------------------------------------

UV=""
if command -v uv >/dev/null 2>&1; then
  UV="$(command -v uv)"
else
  warn "uv не найден. Рекомендуется: brew install uv"
  warn "Продолжаю через системный python3 (медленнее, нужен python3 >= 3.12)."
fi

PY=""
if [[ -n "$UV" ]]; then
  PY="uv"  # venv'ы создаёт uv, интерпретатор 3.12 он скачает сам
elif command -v python3 >/dev/null 2>&1; then
  PYVER="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  if python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)'; then
    PY="$(command -v python3)"
  else
    echo "ОШИБКА: python3 $PYVER слишком старый, нужен 3.12+." >&2
    echo "Поставьте uv (brew install uv) или Python 3.12 (brew install python@3.12)." >&2
    exit 1
  fi
else
  echo "ОШИБКА: нет ни uv, ни python3. Поставьте uv: brew install uv" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  warn "git не найден — он понадобится для SGLang/llama.cpp (xcode-select --install)."
fi

venv_install() { # $1 = каталог venv, $2 = requirements.txt
  local dir="$1" req="$2"
  if [[ -n "$UV" ]]; then
    [[ -d "$dir" ]] || "$UV" venv -p 3.12 "$dir"
    "$UV" pip install -p "$dir" -r "$req" --quiet
  else
    [[ -d "$dir" ]] || "$PY" -m venv "$dir"
    "$dir/bin/pip" install --quiet --disable-pip-version-warning -r "$req"
  fi
}

# --- 2. Venv'ы и зависимости ------------------------------------------------

info "Backend (.venv-test, backend/requirements.txt)"
venv_install .venv-test backend/requirements.txt

if [[ -f server/clef/requirements.txt ]]; then
  info "Clef (server/clef/.venv)"
  venv_install server/clef/.venv server/clef/requirements.txt
else
  warn "Нет server/clef/requirements.txt — пропускаю clef-venv."
fi

PYBIN="$ROOT/.venv-test/bin/python"
[[ -x "$PYBIN" ]] || PYBIN="python3"

# --- 3. SGLang и llama.cpp: только проверки и подсказки ----------------------

SGLANG_MISSING=0
if [[ ! -f server/sglang/python/sglang/__init__.py ]]; then
  SGLANG_MISSING=1
  warn "SGLang не найден (server/sglang). Автоматически не ставится — тяжёлый"
  warn "source-чекаут. Установка (README.md, «Установка SGLang»):"
  cat >&2 <<'EOF'
    git clone https://github.com/sgl-project/sglang.git server/sglang
    cd server/sglang
    uv venv -p 3.12 .venv && source .venv/bin/activate
    rm -f python/pyproject.toml && mv python/pyproject_other.toml python/pyproject.toml
    uv pip install -e "python[all_mps]"
EOF
  warn "sglang-модели будут выключены в конфиге (enabled=false)."
elif [[ ! -d server/sglang/.venv ]]; then
  warn "server/sglang есть, но нет server/sglang/.venv — доустановите по README"
  warn "(«Установка SGLang»). sglang-модели будут выключены в конфиге."
  SGLANG_MISSING=1
fi

if [[ ! -x server/llama.cpp/build/bin/llama-server ]] && ! command -v llama-server >/dev/null 2>&1; then
  warn "llama-server не найден. Laya не запустится, пока не соберёте llama.cpp"
  warn "(README.md, «Установка Laya»):"
  cat >&2 <<'EOF'
    git clone --depth 1 https://github.com/ggml-org/llama.cpp server/llama.cpp
    cmake -B server/llama.cpp/build -S server/llama.cpp -DGGML_METAL=ON
    cmake --build server/llama.cpp/build -j --target llama-server
EOF
fi

# --- 4. Профиль RAM → enabled в models_config.json ---------------------------

MEM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
RAM_GB=$(( MEM_BYTES / 1073741824 ))
info "RAM устройства: ${RAM_GB} ГБ"

if [[ ! -f backend/models_config.json ]]; then
  warn "backend/models_config.json не найден — пропускаю профиль RAM."
elif (( RAM_GB >= 48 )) && (( SGLANG_MISSING == 0 )); then
  info "RAM >= 48 ГБ и SGLang на месте — профиль моделей не меняется."
else
  RAM_GB="$RAM_GB" SGLANG_MISSING="$SGLANG_MISSING" FORCE="$FORCE" \
  "$PYBIN" - <<'PYEOF'
import hashlib
import json
import os
import sys
from pathlib import Path

config_path = Path("backend/models_config.json")
sidecar_path = Path("backend/.setup_state.json")
ram_gb = int(os.environ["RAM_GB"])
sglang_missing = os.environ["SGLANG_MISSING"] == "1"
force = os.environ["FORCE"] == "1"

data = json.loads(config_path.read_text(encoding="utf-8"))
sha = hashlib.sha256(config_path.read_bytes()).hexdigest()

# Не затираем ручные правки: если конфиг менялся вне setup и нет --force —
# только предупреждение.
if not force:
    recorded = None
    if sidecar_path.exists():
        try:
            recorded = json.loads(sidecar_path.read_text(encoding="utf-8")).get("config_sha")
        except Exception:
            recorded = None
    if recorded != sha:
        print("!! backend/models_config.json не совпадает с состоянием после прошлого setup", file=sys.stderr)
        print("!! (правился вручную или setup ещё не запускался). Профиль RAM не применяю.", file=sys.stderr)
        print("!! Чтобы применить: bash scripts/setup_mac.sh --force", file=sys.stderr)
        sys.exit(0)

changed = []
if ram_gb < 24:
    for m in data:
        if m.get("type") != "remote" and m.get("enabled"):
            m["enabled"] = False
            changed.append(m["key"])
    for m in data:
        if m.get("key") == "jev-latest":
            m["enabled"] = True
    print(f"RAM {ram_gb} ГБ < 24 — режим только облачных моделей: локальные выключены"
          f" ({', '.join(changed) or '—'}).")
    print("Введите API-ключ Jev: страница «Модели» → карточка Jev → «Сохранить ключ».")
elif ram_gb < 48:
    for m in data:
        if m.get("type") != "remote" and m.get("peak_gb", 0) > 15 and m.get("enabled"):
            m["enabled"] = False
            changed.append(m["key"])
    if changed:
        print(f"RAM {ram_gb} ГБ (24–48) — не хватает RAM для тяжёлых моделей,"
              f" выключены: {', '.join(changed)}. Включите позже на странице «Модели».")

if sglang_missing:
    off = [m["key"] for m in data if m.get("type") == "sglang" and m.get("enabled")]
    for m in data:
        if m.get("type") == "sglang":
            m["enabled"] = False
    if off:
        print(f"SGLang не установлен — выключены sglang-модели: {', '.join(off)}.")

tmp = config_path.with_suffix(".json.tmp")
tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
os.replace(tmp, config_path)
sidecar_path.write_text(json.dumps({"config_sha": hashlib.sha256(
    config_path.read_bytes()).hexdigest()}) + "\n", encoding="utf-8")
print("Профиль применён, backend/models_config.json обновлён.")
PYEOF
fi

info "Готово. Запуск: bash scripts/run.sh"
