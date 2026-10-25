"""Bearer auth, loopback-совместимость и owner-isolation API на tmp-файлах."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import auth, preset_store


@pytest.fixture
def token_file(monkeypatch, tmp_path):
    path = tmp_path / "access_tokens.json"
    monkeypatch.setattr(auth, "ACCESS_TOKENS_PATH", path)
    monkeypatch.delenv("DQA_AUTH_REQUIRED", raising=False)
    return path


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def test_remote_valid_missing_bad_revoked_and_no_leak(token_file):
    alice, record = auth.create_token("alice")
    bob, _ = auth.create_token("bob")
    with TestClient(app_module.app, client=("203.0.113.10", 1234)) as client:
        assert client.get("/api/presets").status_code == 401
        bad = client.get("/api/presets", headers=bearer("not-valid"))
        assert bad.status_code == 401
        assert "not-valid" not in bad.text
        assert client.get("/api/auth/me").status_code == 401
        me = client.get("/api/auth/me", headers=bearer(alice))
        assert me.status_code == 200
        assert me.json() == {"owner": "alice", "auth_required": True}
        assert alice not in me.text
        assert client.get("/api/version").status_code == 200
        assert client.get("/").status_code == 200
        assert client.get("/api/presets", headers=bearer(bob)).status_code == 200
    assert auth.revoke_token(record["prefix"])["owner"] == "alice"
    with TestClient(app_module.app, client=("203.0.113.10", 1234)) as client:
        assert client.get("/api/presets", headers=bearer(alice)).status_code == 401

    data = json.loads(token_file.read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert alice not in token_file.read_text(encoding="utf-8")
    assert data["tokens"][0]["hash"] == auth.token_hash(alice)
    assert {r["owner"] for r in data["tokens"]} == {"alice", "bob"}
    assert all(r["revoked"] is None or isinstance(r["revoked"], str)
               for r in data["tokens"])
    if os.name == "posix":
        assert token_file.stat().st_mode & 0o777 == 0o600


def test_loopback_compatibility_forced_auth_and_forwarded_untrusted(token_file,
                                                                    monkeypatch):
    token, _ = auth.create_token("alice")
    client = TestClient(app_module.app)
    assert client.get("/api/auth/me").json() == {"owner": "local", "auth_required": False}
    assert client.get("/api/presets").status_code == 200
    assert client.get("/api/auth/me", headers=bearer("bad")).status_code == 401
    # Forwarded-заголовок не превращает ни loopback в remote, ни remote в loopback.
    assert client.get("/api/auth/me", headers={"X-Forwarded-For": "203.0.113.1"}).json()[
        "owner"] == "local"
    with TestClient(app_module.app, client=("198.51.100.4", 1234)) as remote:
        assert remote.get("/api/version", headers={"X-Forwarded-For": "127.0.0.1"}).status_code == 200
        assert remote.get("/api/presets", headers={"X-Forwarded-For": "127.0.0.1"}).status_code == 401

    monkeypatch.setenv("DQA_AUTH_REQUIRED", "1")
    assert client.get("/api/auth/me").json() == {"owner": "local", "auth_required": True}
    assert client.get("/api/presets").status_code == 401
    assert client.get("/api/auth/me", headers=bearer(token)).json()["owner"] == "alice"
    assert client.get("/api/presets", headers=bearer(token)).status_code == 200
    assert client.get("/api/version").status_code == 200


def test_two_owner_presets_isolated_and_builtins_common(token_file, monkeypatch,
                                                        tmp_path):
    builtin = tmp_path / "builtin"
    builtin.mkdir()
    (builtin / "common.json").write_text(json.dumps({
        "name": "Общий", "input": "текст",
        "questions": [{"id": "q1", "question": "Ок?", "type": "yes_no"}],
    }, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(preset_store, "BUILTIN_DIR", str(builtin))
    monkeypatch.setattr(preset_store, "USER_DIR", str(tmp_path / "legacy-user"))
    monkeypatch.setattr(preset_store, "STATE_USERS_DIR", str(tmp_path / "users"))
    alice, _ = auth.create_token("alice")
    bob, _ = auth.create_token("bob")
    body = {"name": "Личный", "page": "single", "payload": {
        "input": "текст", "questions": [{"id": "q1", "question": "Ок?", "type": "yes_no"}],
    }}
    with TestClient(app_module.app, client=("203.0.113.10", 1234)) as client:
        assert client.post("/api/presets", json=body, headers=bearer(alice)).status_code == 200
        alice_list = client.get("/api/presets", headers=bearer(alice)).json()
        bob_list = client.get("/api/presets", headers=bearer(bob)).json()
        assert {p["slug"] for p in alice_list} == {"common", "личный"}
        assert {p["slug"] for p in bob_list} == {"common"}
        assert client.patch("/api/presets/личный", json={"name": "Чужой"},
                            headers=bearer(bob)).status_code == 404
        assert client.delete("/api/presets/личный", headers=bearer(bob)).status_code == 404
        assert client.delete("/api/presets/личный", headers=bearer(alice)).status_code == 200
    # Прямые вызовы без owner сохраняют legacy local-каталог.
    preset, error = preset_store.create_preset(body)
    assert error is None and preset["slug"] == "личный"
    assert (tmp_path / "legacy-user" / "личный.json").exists()
    assert not (tmp_path / "users" / "local").exists()


def test_owner_safe_for_paths():
    for value in ("local", "alice", "A_1-2"):
        assert auth.safe_owner(value) == value
    for value in ("", "../alice", "a/b", "a\\b", "a b", "x" * 65, None):
        with pytest.raises(ValueError):
            auth.safe_owner(value)
    with pytest.raises(ValueError, match="зарезервирован"):
        auth.create_token("local")


def test_token_replace_retries_windows_sharing_violation(token_file, monkeypatch):
    from types import SimpleNamespace

    calls = []
    original = os.replace

    def replace(tmp, target):
        calls.append((tmp, target))
        if len(calls) < 3:
            error = OSError(32, "shared")
            error.winerror = 32
            raise error
        return original(tmp, target)

    monkeypatch.setattr(auth, "os", SimpleNamespace(name="nt", replace=replace, fdopen=os.fdopen, fsync=os.fsync))
    token, _ = auth.create_token("alice")
    assert token.startswith("dqa_") and len(calls) == 3


def test_token_cli_shows_raw_only_on_create(tmp_path):
    path = tmp_path / "cli-tokens.json"
    script = Path(__file__).resolve().parent.parent.parent / "scripts" / "dqa_token.py"
    def run(*args):
        return subprocess.run([sys.executable, str(script), "--file", str(path), *args],
                              check=True, capture_output=True, text=True)
    created = run("create", "cli-user")
    raw = created.stdout.strip()
    assert raw.startswith("dqa_") and raw not in created.stderr
    listed = run("list")
    assert "cli-user" in listed.stdout and raw not in listed.stdout + listed.stderr
    prefix = json.loads(path.read_text())["tokens"][0]["prefix"]
    revoked = run("revoke", prefix)
    assert raw not in revoked.stdout + revoked.stderr
    assert "revoked=" in run("list").stdout
