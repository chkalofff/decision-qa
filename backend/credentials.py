"""Хранение API-ключей удалённых моделей в backend/credentials.json (chmod 600).

Ключи никогда не возвращаются наружу через API — только флаг has().
"""

from __future__ import annotations

import json
import os
from pathlib import Path

CREDENTIALS_PATH = Path(__file__).resolve().parent / "credentials.json"


def load() -> dict:
    try:
        with open(CREDENTIALS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def get(model_key: str) -> str | None:
    value = load().get(model_key)
    return value if isinstance(value, str) and value else None


def has(model_key: str) -> bool:
    return get(model_key) is not None


def _write(data: dict) -> None:
    tmp = CREDENTIALS_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, CREDENTIALS_PATH)


def save(model_key: str, api_key: str) -> None:
    data = load()
    data[model_key] = api_key
    _write(data)


def delete(model_key: str) -> bool:
    data = load()
    if model_key not in data:
        return False
    del data[model_key]
    _write(data)
    return True
