"""Actionable environment, server, authentication and pack diagnostics."""

from __future__ import annotations

import platform
import sys
from typing import Any

from . import SCHEMA, cli_version
from .client import Client, DqaError
from .config import EffectiveConfig
from .pack import capabilities_for, load


def run(config: EffectiveConfig, pack_path: str | None, *, as_json: bool = False) -> tuple[int, list[dict[str, Any]]]:
    checks: list[dict[str, Any]] = []

    def check(name: str, ok: bool, message: str, code: int = 69) -> bool:
        checks.append({"name": name, "status": "OK" if ok else "FAIL", "message": message, "code": 0 if ok else code})
        return ok

    check("python", sys.version_info >= (3, 12), f"Python {platform.python_version()} на {platform.system()} {platform.machine()}; требуется 3.12+.")
    try:
        import httpx
        import rfc8785
        check("dependencies", True, f"httpx {httpx.__version__}; rfc8785 загружен из {rfc8785.__file__}.")
    except ImportError as exc:
        check("dependencies", False, f"Нет зависимости: {exc}. Выполните pip install -r cli/requirements.txt.")
        return _result(checks, as_json)
    client = Client(config.server, config.token)
    try:
        server_version = client.version()["version"]
        check("server", True, f"{config.server}; server {server_version}, CLI {cli_version()}.")
        capabilities = client.capabilities()
        from .pack import schema_check
        schema_check(capabilities, SCHEMA)
        check("capabilities", True, f"schema {capabilities['min_schema']}..{capabilities['max_schema']}; max_files={capabilities['max_files_per_job']}, max_images={capabilities['max_images']}, threads={capabilities['default_threads']}/{capabilities['max_threads']}.")
        if capabilities.get("auth_required") and not config.token:
            check("auth", False, "Сервер требует Bearer; задайте DQA_TOKEN.", 77)
        else:
            check("auth", True, "Bearer передан." if config.token else "Сервер не требует Bearer.")
        models = capabilities.get("models")
        if models is None:
            check("models", False, "Список моделей недоступен; проверьте auth и версию сервера.", 77 if capabilities.get("auth_required") else 69)
        else:
            for model in models:
                key = model.get("key", "?")
                status = model.get("status")
                check(f"model:{key}", status == "running", f"{key}: {status}; " + ("готова." if status == "running" else "запустите в веб-интерфейсе."))
            if not models:
                check("models", False, "На сервере нет enabled decision-моделей; включите модель в веб-интерфейсе.")
        if pack_path:
            loaded = load(pack_path)
            capabilities_for(client, loaded, SCHEMA)
            check("pack", True, f"{pack_path}: {len(loaded.original['questions'])} вопросов; исходы {', '.join(o['id'] for o in loaded.original['decision']['outcomes'])}.")
    except DqaError as exc:
        name = "pack" if pack_path and checks and checks[-1]["name"].startswith("model") else "server"
        check(name, False, exc.message, exc.code)
    return _result(checks, as_json)


def _result(checks: list[dict[str, Any]], as_json: bool) -> tuple[int, list[dict[str, Any]]]:
    code = next((check["code"] for check in checks if check["status"] == "FAIL"), 0)
    if not as_json:
        for check in checks:
            print(f"{check['status']} {check['name']}: {check['message']}", file=sys.stderr if check["status"] == "FAIL" else sys.stdout)
    return code, checks
