"""Пользовательские настройки backend: персист в backend/settings.json.

Сейчас хранится одна настройка — budget_fraction (доля RAM под бюджет
моделей). Приоритет при загрузке: файл > env MODELS_BUDGET_FRACTION > дефолт.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
SETTINGS_PATH = BACKEND_DIR / "settings.json"

DEFAULT_BUDGET_FRACTION = 0.65
MIN_BUDGET_FRACTION = 0.3
MAX_BUDGET_FRACTION = 0.95
ENV_BUDGET_FRACTION = "MODELS_BUDGET_FRACTION"


def _read_file_fraction() -> float | None:
    """budget_fraction из settings.json; None, если файла нет или значение битое."""
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            fraction = float(json.load(f).get("budget_fraction"))
    except (OSError, ValueError, TypeError, AttributeError):
        return None
    if MIN_BUDGET_FRACTION <= fraction <= MAX_BUDGET_FRACTION:
        return fraction
    return None


def load_budget_fraction() -> float:
    """Доля RAM под бюджет моделей: файл > env > дефолт."""
    from_file = _read_file_fraction()
    if from_file is not None:
        return from_file
    env = os.environ.get(ENV_BUDGET_FRACTION)
    if env:
        try:
            return float(env)
        except ValueError:
            pass
    return DEFAULT_BUDGET_FRACTION


def save_budget_fraction(fraction: float) -> None:
    """Атомарная запись (tmp + rename), как save_registry в model_manager."""
    tmp = SETTINGS_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"budget_fraction": fraction}, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, SETTINGS_PATH)
