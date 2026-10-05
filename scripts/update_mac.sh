#!/usr/bin/env bash
# Обновление Decision-QA до последнего релиза (macOS).
#   bash scripts/update_mac.sh
# Качает latest-релиз с GitHub, распаковывает поверх установки, сохраняя
# пользовательские данные (credentials.json, models_config.json, settings.json),
# затем доводит зависимости и перезапускает приложение.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="chkalofff/decision-qa"
ASSET="decision-qa-mac-arm64.zip"
API="https://api.github.com/repos/$REPO/releases/latest"

info() { printf '\033[1m== %s\033[0m\n' "$*"; }

command -v curl >/dev/null 2>&1 || { echo "Нужен curl" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "Нужен python3 для распаковки" >&2; exit 1; }

CURRENT="$(head -1 "$ROOT/VERSION" 2>/dev/null | tr -d '[:space:]' || echo '?')"
info "Текущая версия: $CURRENT"

info "Ищу последний релиз на GitHub"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$API" -o "$TMP/release.json"
TAG="$(python3 -c "import json;print(json.load(open('$TMP/release.json'))['tag_name'])")"
URL="$(python3 -c "
import json
rel = json.load(open('$TMP/release.json'))
for a in rel.get('assets', []):
    if a.get('name') == '$ASSET':
        print(a['browser_download_url']); break
")"
[[ -n "$URL" ]] || { echo "В релизе $TAG нет ассета $ASSET" >&2; exit 1; }
echo "Последний релиз: $TAG"

if [[ "$TAG" == "v$CURRENT" ]]; then
  echo "Уже актуальная версия — обновление не требуется."
  exit 0
fi

info "Скачиваю $ASSET"
curl -fSL --progress-bar "$URL" -o "$TMP/release.zip"

info "Распаковываю"
python3 -m zipfile -e "$TMP/release.zip" "$TMP/extract"

info "Сохраняю пользовательские данные"
BK="$TMP/backup"
mkdir -p "$BK"
for f in backend/credentials.json backend/models_config.json backend/settings.json; do
  if [[ -f "$ROOT/$f" ]]; then cp "$ROOT/$f" "$BK/$(basename "$f")"; echo "  бэкап: $f"; fi
done

info "Обновляю файлы в $ROOT"
# копируем поверх; бэкапленные файлы вернём после
(cd "$TMP/extract" && tar cf - .) | (cd "$ROOT" && tar xf -)
for f in backend/credentials.json backend/models_config.json backend/settings.json; do
  if [[ -f "$BK/$(basename "$f")" ]]; then
    cp "$BK/$(basename "$f")" "$ROOT/$f"
    echo "  восстановлено: $f"
  fi
done

NEW="$(head -1 "$ROOT/VERSION" | tr -d '[:space:]')"
info "Версия после обновления: $NEW"

info "Довожу зависимости и перезапускаю"
# останавливаем старый backend (run.sh сам не перезапускает работающий)
OLD_PID="$(lsof -ti tcp:8000 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$OLD_PID" ]] && [[ "$(ps -p "$OLD_PID" -o command= 2>/dev/null || true)" == *"uvicorn backend.app:app"* ]]; then
  kill "$OLD_PID" 2>/dev/null || true
  sleep 1
  echo "  остановлен старый backend (pid $OLD_PID)"
fi
bash "$ROOT/scripts/setup_mac.sh"
bash "$ROOT/scripts/run.sh"

info "Обновлено до $TAG. Приложение: http://127.0.0.1:8000"
