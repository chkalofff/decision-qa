"""Small authenticated HTTP client with stable CLI error mapping."""

from __future__ import annotations

import time
from typing import Any

import httpx


class DqaError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class Client:
    def __init__(self, server: str, token: str | None = None, *, verbose: bool = False,
                 deadline: float | None = None):
        self.server = server.rstrip("/")
        self.token = token
        self.verbose = verbose
        self.deadline = deadline

    def _check_deadline(self) -> None:
        if self.deadline is not None and time.monotonic() >= self.deadline:
            raise DqaError(75, "Истёк --timeout во время HTTP-запроса подготовки.")

    def _timeout(self) -> httpx.Timeout:
        if self.deadline is None:
            return httpx.Timeout(30.0, connect=10.0)
        remaining = max(0.001, self.deadline - time.monotonic())
        return httpx.Timeout(min(30.0, remaining), connect=min(10.0, remaining))

    def get_json(self, path: str) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        self._check_deadline()
        try:
            with httpx.Client(timeout=self._timeout()) as http:
                response = http.get(self.server + path, headers=headers)
        except httpx.HTTPError as exc:
            self._check_deadline()
            raise DqaError(69, f"Не удаётся подключиться к {self.server} ({exc}). Проверьте сервер или --server.") from exc
        self._check_deadline()
        if self.verbose:
            import sys
            print(f"GET {path} → {response.status_code}", file=sys.stderr)
        if response.status_code in (401, 403):
            raise DqaError(77, "Сервер отклонил доступ (401/403). Проверьте DQA_TOKEN или токен активного профиля.")
        if response.status_code in (400, 409, 413, 422):
            raise DqaError(65, f"Сервер отклонил запрос ({response.status_code}): {_detail(response)}")
        if response.status_code != 200:
            raise DqaError(69, f"Сервер вернул HTTP {response.status_code} для {path}: {_detail(response)}")
        try:
            value = response.json()
        except ValueError as exc:
            raise DqaError(69, f"Сервер вернул не JSON для {path}. Проверьте совместимость версий.") from exc
        if not isinstance(value, dict):
            raise DqaError(69, f"Несовместимый ответ {path}: ожидался JSON-объект.")
        return value

    def capabilities(self) -> dict[str, Any]:
        value = self.get_json("/api/run/capabilities")
        required = {
            "min_schema": int, "max_schema": int, "pack_version": int,
            "fingerprint_version": int, "max_images": int,
            "max_images_b64_chars": int, "max_files_per_job": int,
            "max_threads": int, "default_threads": int,
        }
        for key, kind in required.items():
            if not isinstance(value.get(key), kind) or isinstance(value.get(key), bool):
                raise DqaError(69, f"Несовместимые capabilities: поле {key} отсутствует или имеет неверный тип.")
        if not isinstance(value.get("modes"), list) or not all(isinstance(mode, str) for mode in value["modes"]):
            raise DqaError(69, "Несовместимые capabilities: modes должен быть списком строк.")
        models = value.get("models")
        if models is not None and (not isinstance(models, list) or any(not isinstance(m, dict) for m in models)):
            raise DqaError(69, "Несовместимые capabilities: models должен быть списком объектов.")
        return value

    def version(self) -> dict[str, Any]:
        value = self.get_json("/api/version")
        if not isinstance(value.get("version"), str) or not value["version"]:
            raise DqaError(69, "Несовместимый /api/version: ожидалась непустая строка version.")
        return value


def _detail(response: httpx.Response) -> str:
    try:
        value = response.json()
        if isinstance(value, dict) and "detail" in value:
            return str(value["detail"])
    except ValueError:
        pass
    return response.text[:500] or "без описания"
