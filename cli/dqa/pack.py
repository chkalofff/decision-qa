"""Config-pack facade shared by validation, diagnostics and runs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from dqa_common import AGGREGATION_POLICY, FINGERPRINT_VERSION, PACK_VERSION
from dqa_common.config_pack import ConfigPackError, effective_pack, load_pack

from .client import Client, DqaError


@dataclass
class LoadedPack:
    path: str
    original: dict[str, Any]
    effective: dict[str, Any]
    models_overridden: bool
    mode_overridden: bool

    @property
    def models(self) -> list[str]:
        return self.effective["settings"]["models"]

    @property
    def mode(self) -> str:
        return self.effective["settings"]["mode"]

    def summary(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "name": self.original.get("name"),
            "version": self.original["version"],
            "fingerprint_version": self.original["fingerprint_version"],
            "questions": [
                {"id": q["id"], "type": q["type"], "question": q.get("question", "")}
                for q in self.original["questions"]
            ],
            "outcome_ids": [o["id"] for o in self.original["decision"]["outcomes"]],
            "outcomes": [
                {"id": o["id"], "label": o["label"], "is_default": o["isDefault"]}
                for o in self.original["decision"]["outcomes"]
            ],
            "models_pack": self.original["settings"]["models"],
            "models": self.models,
            "mode_pack": self.original["settings"]["mode"],
            "mode": self.mode,
            "models_overridden": self.models_overridden,
            "mode_overridden": self.mode_overridden,
            "hash": self.original["hash"],
            "fingerprint": self.original["fingerprint"],
            "effective_hash": self.effective["hash"],
            "effective_fingerprint": self.effective["fingerprint"],
            "aggregation": self.effective["settings"]["aggregation"],
        }


def load(path: str, models: str | None = None, mode: str | None = None) -> LoadedPack:
    model_list = _models(models) if models is not None else None
    try:
        original = load_pack(path, require_decision=True, check_hashes=True)
        effective = effective_pack(original, models=model_list, mode=mode)
    except (OSError, UnicodeError) as exc:
        raise DqaError(65, f"Не удалось прочитать конфиг-пакет {path}: {exc}") from exc
    except ConfigPackError as exc:
        raise DqaError(65, f"Конфиг-пакет {path} не прошёл проверку: {exc}. Переэкспортируйте его из веба.") from exc
    return LoadedPack(path, original, effective, model_list is not None, mode is not None)


def check_server(pack: LoadedPack, capabilities: dict[str, Any], *, require_running: bool = True) -> None:
    if not pack.models:
        raise DqaError(65, "В effective config нет моделей. Выберите модель в вебе или передайте --models.")
    if capabilities["pack_version"] != PACK_VERSION:
        raise DqaError(69, "Сервер не поддерживает config pack v1. Обновите сервер или CLI.")
    if capabilities["fingerprint_version"] != FINGERPRINT_VERSION:
        raise DqaError(69, "Несовместимая версия fingerprint. Обновите сервер или CLI.")
    if capabilities.get("aggregation") != AGGREGATION_POLICY:
        raise DqaError(69, "Сервер не поддерживает mean_probability_v1. Обновите сервер или CLI.")
    if pack.mode not in capabilities["modes"]:
        raise DqaError(65, f"Режим {pack.mode} не поддержан сервером. Доступны: {', '.join(capabilities['modes'])}.")
    models = capabilities.get("models")
    if models is None:
        if capabilities.get("auth_required"):
            raise DqaError(77, "Сервер требует авторизацию для списка моделей. Задайте DQA_TOKEN.")
        raise DqaError(69, "Capabilities не содержат models; обновите сервер.")
    available = {model.get("key"): model for model in models}
    unknown = [key for key in pack.models if key not in available]
    if unknown:
        keys = ", ".join(sorted(str(key) for key in available))
        raise DqaError(65, f"Неизвестные модели: {', '.join(unknown)}. Доступные: {keys or '(нет)'}.")
    if require_running:
        stopped = [key for key in pack.models if available[key].get("status") != "running"]
        if stopped:
            details = ", ".join(f"{key} ({available[key].get('status')})" for key in stopped)
            raise DqaError(69, f"Модели не запущены: {details}. Запустите их в веб-интерфейсе и повторите.")


def validate_fail_on(pack: LoadedPack, value: str) -> None:
    if value in {"error", "any", "none"}:
        return
    outcomes = {outcome["id"] for outcome in pack.original["decision"]["outcomes"]}
    requested = value.split(",")
    unknown = [item for item in requested if not item or item not in outcomes]
    if unknown:
        raise DqaError(64, f"--fail-on: нет исхода {unknown[0]!r}. Исходы пакета: {', '.join(sorted(outcomes))}.")


def _models(value: str) -> list[str]:
    models = value.split(",")
    if not models or any(not model for model in models) or len(set(models)) != len(models):
        raise DqaError(64, "--models ожидает уникальные непустые ключи через запятую.")
    return models



def schema_check(capabilities: dict[str, Any], schema: int) -> None:
    if not capabilities["min_schema"] <= schema <= capabilities["max_schema"]:
        raise DqaError(69, f"Схема CLI {schema} вне диапазона сервера {capabilities['min_schema']}..{capabilities['max_schema']}. Обновите CLI или сервер.")


def capabilities_for(client: Client, pack: LoadedPack, schema: int, *, require_running: bool = True) -> dict[str, Any]:
    capabilities = client.capabilities()
    schema_check(capabilities, schema)
    check_server(pack, capabilities, require_running=require_running)
    return capabilities
