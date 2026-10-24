"""TOML profiles, precedence and secret-safe effective configuration."""

from __future__ import annotations

import json
import os
import stat
import tempfile
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .client import DqaError

DEFAULT_SERVER = "http://localhost:8000"


@dataclass
class EffectiveConfig:
    server: str
    profile: str
    token: str | None
    path: Path
    sources: dict[str, str]


def config_dir(env: dict[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    if env.get("DQA_CONFIG_DIR"):
        return Path(env["DQA_CONFIG_DIR"]).expanduser()
    if os.name == "nt" and env.get("APPDATA"):
        return Path(env["APPDATA"]) / "dqa"
    return Path.home() / ".config" / "dqa"


def config_path(env: dict[str, str] | None = None) -> Path:
    return config_dir(env) / "config.toml"


def load_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"default_profile": "local", "profiles": {}}
    try:
        with path.open("rb") as stream:
            data = tomllib.load(stream)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise DqaError(65, f"Не удалось прочитать {path}: {exc}. Исправьте TOML или DQA_CONFIG_DIR.") from exc
    if set(data) - {"default_profile", "profiles"}:
        raise DqaError(65, f"{path}: допустимы только default_profile и profiles.")
    default = data.get("default_profile", "local")
    profiles = data.get("profiles", {})
    if not isinstance(default, str) or not default or not isinstance(profiles, dict):
        raise DqaError(65, f"{path}: default_profile и profiles имеют неверную форму.")
    for name, profile in profiles.items():
        if not isinstance(name, str) or not name or not isinstance(profile, dict) or set(profile) - {"server", "token"}:
            raise DqaError(65, f"{path}: неверный профиль {name!r}; допустимы server и token.")
        if any(not isinstance(value, str) for value in profile.values()):
            raise DqaError(65, f"{path}: значения профиля {name!r} должны быть строками.")
    return {"default_profile": default, "profiles": profiles}


def resolve(*, server: str | None = None, profile: str | None = None,
            env: dict[str, str] | None = None) -> EffectiveConfig:
    env = os.environ if env is None else env
    path = config_path(env)
    data = load_file(path)
    selected = profile or env.get("DQA_PROFILE") or data["default_profile"]
    profile_source = "flag --profile" if profile else ("env DQA_PROFILE" if env.get("DQA_PROFILE") else "config default_profile")
    values = data["profiles"].get(selected)
    if values is None:
        if profile or env.get("DQA_PROFILE"):
            raise DqaError(64, f"Профиль {selected!r} не найден в {path}. Создайте его через dqa config set.")
        values = {}
        profile_source = "default local"
    if server:
        actual_server, server_source = server, "flag --server"
    elif env.get("DQA_SERVER"):
        actual_server, server_source = env["DQA_SERVER"], "env DQA_SERVER"
    elif values.get("server"):
        actual_server, server_source = values["server"], f"profile {selected}"
    else:
        actual_server, server_source = DEFAULT_SERVER, "default"
    if env.get("DQA_TOKEN"):
        token, token_source = env["DQA_TOKEN"], "env DQA_TOKEN"
    elif values.get("token"):
        token, token_source = values["token"], f"profile {selected}"
    else:
        token, token_source = None, "unset"
    if not actual_server.startswith(("http://", "https://")):
        raise DqaError(64, "Адрес сервера должен начинаться с http:// или https://.")
    return EffectiveConfig(actual_server.rstrip("/"), selected, token, path, {
        "server": server_source, "profile": profile_source, "token": token_source,
    })


def mask_token(token: str | None) -> str | None:
    if not token:
        return None
    prefix = token[:4] if token.startswith("dqa_") else ""
    return f"{prefix}…{token[-4:]}" if len(token) > 4 else "…"


def show(config: EffectiveConfig) -> dict[str, Any]:
    return {
        "config_path": str(config.path), "profile": config.profile,
        "server": config.server, "token": mask_token(config.token),
        "sources": config.sources,
    }


def initialize(path: Path, server: str = DEFAULT_SERVER) -> dict[str, Any]:
    if path.exists():
        raise DqaError(65, f"Конфиг уже существует: {path}. Используйте dqa config set.")
    data = {"default_profile": "local", "profiles": {"local": {"server": server}}}
    write_file(path, data)
    return data


def set_value(path: Path, profile: str | None, key: str, value: str) -> dict[str, Any]:
    data = load_file(path)
    if key == "default_profile":
        if value not in data["profiles"]:
            raise DqaError(64, f"Профиль {value!r} ещё не существует; сначала задайте его server.")
        data["default_profile"] = value
    elif key in {"server", "token"}:
        name = profile or data["default_profile"]
        if key == "server" and not value.startswith(("http://", "https://")):
            raise DqaError(64, "server должен начинаться с http:// или https://.")
        data["profiles"].setdefault(name, {})[key] = value
    else:
        raise DqaError(64, "config set принимает ключ server, token или default_profile.")
    write_file(path, data)
    return data


def write_file(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "posix":
        path.parent.chmod(0o700)
    lines = [f"default_profile = {_toml_string(data['default_profile'])}", ""]
    for name in sorted(data["profiles"]):
        values = data["profiles"][name]
        lines.append(f"[profiles.{_toml_key(name)}]")
        for key in ("server", "token"):
            if key in values:
                lines.append(f"{key} = {_toml_string(values[key])}")
        lines.append("")
    payload = "\n".join(lines).encode("utf-8")
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=".config.", dir=path.parent)
        if os.name == "posix":
            os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
    except OSError as exc:
        raise DqaError(70, f"Не удалось записать {path}: {exc}") from exc
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _toml_key(value: str) -> str:
    return value if value.replace("_", "").replace("-", "").isalnum() else _toml_string(value)
