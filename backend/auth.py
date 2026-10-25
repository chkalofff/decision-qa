"""Bearer-аутентификация и безопасные идентификаторы владельцев данных."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse

LOCAL_OWNER = "local"
ACCESS_TOKENS_PATH = (Path(__file__).resolve().parent / "access_tokens.json")
_OWNER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "testclient", "testserver"}
_PUBLIC_API_PATHS = {
    "/api/version", "/api/health", "/api/auth/me", "/api/run/capabilities",
}


def auth_required() -> bool:
    return os.environ.get("DQA_AUTH_REQUIRED") == "1"


def safe_owner(owner: str) -> str:
    """Проверенный id, пригодный для одного path segment."""
    if not isinstance(owner, str) or not _OWNER_RE.fullmatch(owner):
        raise ValueError("owner: 1–64 символа A–Z/a–z/0–9/_/-, начало — буква или цифра")
    if owner in {".", ".."}:
        raise ValueError("Недопустимый owner")
    return owner


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _chmod_private(path: Path) -> None:
    if os.name == "posix":
        os.chmod(path, 0o600)


def load_tokens(path: str | Path | None = None) -> list[dict]:
    token_path = Path(path) if path is not None else ACCESS_TOKENS_PATH
    try:
        data = json.loads(token_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, json.JSONDecodeError) as e:
        raise RuntimeError("Не удалось прочитать access_tokens.json") from e
    if not isinstance(data, dict) or data.get("version") != 1 \
            or not isinstance(data.get("tokens"), list):
        raise RuntimeError("Неподдерживаемый формат access_tokens.json")
    return data["tokens"]


def _replace_token_file(tmp: Path, token_path: Path) -> None:
    for attempt in range(20):
        try:
            os.replace(tmp, token_path)
            return
        except OSError as exc:
            if os.name == "posix" or getattr(exc, "winerror", None) not in {32, 33} or attempt == 19:
                raise
            time.sleep(0.05)


def save_tokens(records: list[dict], path: str | Path | None = None) -> None:
    token_path = Path(path) if path is not None else ACCESS_TOKENS_PATH
    token_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"version": 1, "tokens": records},
                         ensure_ascii=False, indent=2) + "\n"
    fd, tmp_name = tempfile.mkstemp(prefix=token_path.name + ".",
                                   dir=token_path.parent)
    tmp = Path(tmp_name)
    try:
        _chmod_private(tmp)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        _replace_token_file(tmp, token_path)
        _chmod_private(token_path)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def create_token(owner: str, path: str | Path | None = None) -> tuple[str, dict]:
    owner = safe_owner(owner)
    if owner == LOCAL_OWNER:
        raise ValueError("owner local зарезервирован для прозрачного loopback-доступа")
    token = "dqa_" + secrets.token_urlsafe(32)
    record = {"owner": owner, "hash": token_hash(token), "prefix": token[:12],
              "created": _now(), "revoked": None}
    records = load_tokens(path)
    records.append(record)
    save_tokens(records, path)
    return token, record


def revoke_token(prefix: str, path: str | Path | None = None) -> dict | None:
    records = load_tokens(path)
    matches = [r for r in records if r.get("prefix") == prefix and not r.get("revoked")]
    if len(matches) != 1:
        return None
    matches[0]["revoked"] = _now()
    save_tokens(records, path)
    return matches[0]


def authenticate(token: str, path: str | Path | None = None) -> str | None:
    supplied = token_hash(token)
    for record in load_tokens(path):
        if record.get("revoked"):
            continue
        try:
            owner = safe_owner(record.get("owner"))
            if owner == LOCAL_OWNER:
                continue
        except (TypeError, ValueError):
            continue
        if hmac.compare_digest(str(record.get("hash") or ""), supplied):
            return owner
    return None


def _bearer_token(request: Request) -> str | None:
    value = request.headers.get("Authorization")
    if value is None:
        return None
    scheme, _, token = value.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return ""
    return token.strip()


async def authenticate_request(request: Request, call_next):
    """Внешний API требует Bearer; loopback без токена остаётся ``local``."""
    path = request.url.path
    required = auth_required()
    token = _bearer_token(request)
    owner = authenticate(token) if token else None
    host = request.client.host if request.client else None
    loopback = host in _LOOPBACK_HOSTS
    request.state.auth_required = required or not loopback
    if token is not None and owner is None:
        return JSONResponse(status_code=401, content={"detail": "Недействительный access token"},
                            headers={"WWW-Authenticate": "Bearer"})
    if not path.startswith("/api/"):
        request.state.owner = owner or LOCAL_OWNER
        return await call_next(request)

    if owner is None and loopback and not required:
        owner = LOCAL_OWNER
    if owner is None and (path not in _PUBLIC_API_PATHS
                          or (path == "/api/auth/me" and not loopback)):
        return JSONResponse(status_code=401, content={"detail": "Требуется Bearer access token"},
                            headers={"WWW-Authenticate": "Bearer"})
    request.state.owner = owner or LOCAL_OWNER
    return await call_next(request)
