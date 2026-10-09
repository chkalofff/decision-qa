#!/usr/bin/env bash
# Быстрая установка базовых зависимостей для «Вердикта» на macOS.
#   bash scripts/install_prereqs_mac.sh
# Ставит: git, uv, python@3.12 (через Homebrew). Повторный запуск безопасен.
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || { echo "Скрипт только для macOS" >&2; exit 1; }

info()  { printf '\033[1m== %s\033[0m\n' "$*"; }
ok()    { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn()  { printf '\033[33m! %s\033[0m\n' "$*" >&2; }

install_brew() {
  if command -v brew >/dev/null 2>&1; then
    ok "Homebrew уже установлен: $(brew --version | head -1)"
    return 0
  fi
  warn "Homebrew не найден"
  read -r -p "Установить Homebrew? [Y/n] " ans
  if [[ "${ans:-Y}" =~ ^[Yy] ]]; then
    info "Устанавливаю Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
    ok "Homebrew установлен"
  else
    echo "Без Homebrew скрипт не может продолжить" >&2
    exit 1
  fi
}

brew_ensure() {
  local pkg="$1"
  if brew list "$pkg" >/dev/null 2>&1; then
    ok "$pkg уже установлен ($(brew list --versions "$pkg" | head -1))"
  else
    info "Устанавливаю $pkg..."
    brew install "$pkg"
    ok "$pkg установлен"
  fi
}

info "Проверяю Homebrew"
install_brew

info "Проверяю git, uv, python@3.12"
brew_ensure git
brew_ensure uv
brew_ensure python@3.12

info "Итоговые версии"
command -v git  >/dev/null && ok "git:  $(git --version)"
command -v uv   >/dev/null && ok "uv:   $(uv --version)"
command -v python3.12 >/dev/null && ok "python3.12: $(python3.12 --version)"

info "Готово. Теперь можно запускать: bash scripts/setup_mac.sh"
