#!/usr/bin/env bash
# Сборка релизных архивов Decision-QA.
#   scripts/build_release.sh [версия]   — по умолчанию версия из VERSION + суффикс -local
# Архивы кладутся в dist/. Не требует git — собирает из рабочего дерева.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION_FILE="$ROOT/VERSION"
VERSION="${1:-$(head -1 "$VERSION_FILE" | tr -d '[:space:]')}-local"
VERSION="$(echo "$VERSION" | sed 's/^v//')"
DIST="$ROOT/dist"
MAC_ZIP="decision-qa-mac-arm64.zip"
WIN_ZIP="decision-qa-windows.zip"

info() { printf '\033[1m== %s\033[0m\n' "$*"; }

command -v zip >/dev/null 2>&1 || { echo "Нужен zip (brew install zip)" >&2; exit 1; }

rm -rf "$DIST"
mkdir -p "$DIST/stage-mac" "$DIST/stage-win"

stage_common() {  # $1 — каталог стейджа
  local s="$1"
  mkdir -p "$s/backend" "$s/frontend/static" "$s/scripts" "$s/server" "$s/docs"
  # backend: код, конфиги, пресеты — без тестов и кэша (tar — переносимо, cp --parents на macOS нет)
  (cd backend && tar cf - --exclude='./tests' --exclude='__pycache__' --exclude='*.pyc' .) | (cd "$s/backend" && tar xf -)
  cp -R frontend/static "$s/frontend/"
  find "$s" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true
  find "$s" -name ".DS_Store" -delete 2>/dev/null || true
  cp VERSION README.md "$s/"
  # раннеры моделей и зависимости clef-venv (hf CLI нужен для скачивания моделей)
  cp server/run_server.sh server/run_clef.sh server/run_llamacpp.sh "$s/server/"
  mkdir -p "$s/server/clef"
  cp server/clef/requirements.txt "$s/server/clef/"
  # секреты и локальное состояние в архив не попадают (файлов нет в дереве/черный список)
  rm -f "$s/backend/credentials.json" "$s/backend/.setup_state.json"
}

# ---------------- mac ----------------
info "Собираю $MAC_ZIP (v$VERSION)"
stage_common "$DIST/stage-mac"
mkdir -p "$DIST/stage-mac/server/logs"
cp scripts/install_prereqs_mac.sh scripts/setup_mac.sh scripts/run.sh \
   scripts/update_mac.sh scripts/autostart_mac.sh scripts/uninstall_mac.sh \
   "$DIST/stage-mac/scripts/"
cp scripts/install.command "$DIST/stage-mac/"
chmod +x "$DIST/stage-mac/install.command" "$DIST/stage-mac/scripts/"*.sh
(cd "$DIST/stage-mac" && zip -q -r "$DIST/$MAC_ZIP" . -x "*.DS_Store")

# ---------------- windows ----------------
info "Собираю $WIN_ZIP (v$VERSION)"
stage_common "$DIST/stage-win"
cp scripts/run.ps1 scripts/update.ps1 scripts/autostart_windows.ps1 \
   scripts/uninstall_windows.ps1 "$DIST/stage-win/scripts/"
cp scripts/install.bat "$DIST/stage-win/"
cp docs/windows.md "$DIST/stage-win/docs/"
unix2dos_q() { if command -v unix2dos >/dev/null 2>&1; then unix2dos -q "$1"; else sed -i '' -e 's/$/\r/' "$1"; fi; }
unix2dos_q "$DIST/stage-win/install.bat"
(cd "$DIST/stage-win" && zip -q -r "$DIST/$WIN_ZIP" . -x "*.DS_Store")

rm -rf "$DIST/stage-mac" "$DIST/stage-win"

info "Готово:"
ls -lh "$DIST/"*.zip | awk '{print "  " $9 " (" $5 ")"}'
echo
echo "Проверка состава (секреты не должны попасть):"
for z in "$DIST/$MAC_ZIP" "$DIST/$WIN_ZIP"; do
  # ищем именно файлы секретов: credentials.json, .env*, *secret* — не код (credentials.py — модуль)
  if unzip -l "$z" | awk '{print $4}' | grep -viE '\.py$' | grep -qiE 'credentials\.json|(^|/)\.env|secret'; then
    echo "  ВНИМАНИЕ: в $(basename "$z") найдено подозрительное!" >&2
    unzip -l "$z" | awk '{print $4}' | grep -iE 'credentials\.json|(^|/)\.env|secret' >&2
    exit 1
  fi
done
echo "  OK: секретов в архивах нет"
