#!/bin/zsh
# Установка и запуск Decision-QA двойным кликом в Finder.
# Открывает Terminal, ставит зависимости (если нужно) и запускает приложение.
set -e

cd "$(dirname "$0")"

echo "=== Decision-QA: установка и запуск ==="
bash scripts/install_prereqs_mac.sh
bash scripts/setup_mac.sh
bash scripts/run.sh

echo
echo "Готово. Приложение: http://127.0.0.1:8000"
echo "В следующий раз запускайте этот же install.command (или scripts/run.sh)."
