"""Unit-тесты менеджера моделей: RAM-гейт, статусы downloading/stopping,
PATCH-персистентность, credentials, remote-модели, скачивание/удаление."""

from __future__ import annotations

import json
import os
import stat

import httpx
import pytest

from backend import clef
from backend import credentials as creds
from backend import model_manager as mm
from backend.schemas import DecideRequest, Question


class FakeResponse:
    def __init__(self, status_code=200, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data
        self.text = text

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class FakeAsyncClient:
    post_calls: list[dict] = []
    get_calls: list[str] = []
    get_error = False
    post_response = FakeResponse(200, {"answers": {}, "usage": {}})

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, **kwargs):
        FakeAsyncClient.get_calls.append(url)
        if FakeAsyncClient.get_error:
            raise httpx.ConnectError("connection refused")
        return FakeResponse(200, {"data": [{"id": "m"}]})

    async def post(self, url, json=None, headers=None, **kwargs):
        FakeAsyncClient.post_calls.append({"url": url, "json": json, "headers": headers})
        return FakeAsyncClient.post_response


@pytest.fixture(autouse=True)
def base_mocks(monkeypatch, tmp_path):
    FakeAsyncClient.post_calls = []
    FakeAsyncClient.get_calls = []
    FakeAsyncClient.get_error = False
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(mm, "is_downloaded", lambda hf_id: False)
    monkeypatch.setattr(mm, "rss_gb", lambda port: None)
    mm._probe_cache.clear()
    # Персистентность — во временные файлы, реальные конфиг/креды не трогаем
    monkeypatch.setattr(mm, "CONFIG_PATH", tmp_path / "models_config.json")
    monkeypatch.setattr(creds, "CREDENTIALS_PATH", tmp_path / "credentials.json")
    yield


@pytest.fixture
def added():
    """Ключи remote-моделей, созданных тестом — удаляются из REGISTRY после."""
    keys = []
    yield keys
    for key in keys:
        mm.REGISTRY.pop(key, None)


# ---------------------------------------------------------------- RAM-гейт

def test_fit_gate(monkeypatch):
    monkeypatch.setattr(mm, "BUDGET_GB", 40.0)
    assert mm.ModelEntry("a", "A", "o/a", 30091, peak_gb=5.0).fit() == "ok"
    assert mm.ModelEntry("b", "B", "o/b", 30092, peak_gb=30.0).fit() == "tight"
    assert mm.ModelEntry("c", "C", "o/c", 30093, peak_gb=45.0).fit() == "no"
    remote = mm.ModelEntry("r", "R", "", 0, type="remote", api="systemone",
                           base_url="http://x")
    assert remote.fit() is None  # облако память устройства не ест


@pytest.mark.asyncio
async def test_fit_no_blocks_start(monkeypatch):
    monkeypatch.setattr(mm, "BUDGET_GB", 10.0)
    monkeypatch.setattr(mm, "TOTAL_RAM_GB", 16.0)
    FakeAsyncClient.get_error = True  # порт свободен
    entry = mm.ModelEntry("big", "Big", "o/big", 30094, peak_gb=20.0)
    error = await mm.budget_check(entry)
    assert error is not None and "не влезает" in error
    ok, err2 = await mm.start_model(entry)
    assert not ok and err2 == error


# ---------------------------------------------------------------- статусы

@pytest.mark.asyncio
async def test_status_stopping():
    entry = mm.ModelEntry("m", "M", "o/m", 30095)
    entry.stopping = True
    info = await mm.model_status(entry)  # порт отвечает (FakeAsyncClient 200)
    assert info["status"] == "stopping"

    FakeAsyncClient.get_error = True  # порт умер — остановка завершена
    info = await mm.model_status(entry)
    assert info["status"] == "not_downloaded"
    assert entry.stopping is False


class FakeProc:
    def __init__(self, returncode=None):
        self.returncode = returncode

    def poll(self):
        return self.returncode


@pytest.mark.asyncio
async def test_status_downloading():
    FakeAsyncClient.get_error = True
    entry = mm.ModelEntry("m", "M", "o/m", 30096, download_gb=4.5)
    entry.dl_proc = FakeProc(returncode=None)  # процесс жив
    entry.dl_progress = 0.42
    entry.dl_done_gb = 1.9
    info = await mm.model_status(entry)
    assert info["status"] == "downloading"
    assert info["progress"] == 0.42
    assert info["dl_done_gb"] == 1.9

    entry.dl_proc = FakeProc(returncode=0)  # завершился успешно
    info = await mm.model_status(entry)
    assert info["status"] == "stopped"

    entry.dl_proc = FakeProc(returncode=1)  # упал
    entry.dl_error = "network boom"
    info = await mm.model_status(entry)
    assert info["status"] == "error"
    assert "network boom" in info["error"]


# ---------------------------------------------------------------- tqdm-парсинг

def test_parse_tqdm_size():
    assert mm._parse_tqdm("Laya-Q8_0.gguf:  45%|███ | 1.23G/2.74G [00:10<00:12]") == (1.23, 2.74)
    assert mm._parse_tqdm("model.safetensors: 512M/4.10G") == (0.512, 4.10)


def test_parse_tqdm_pct_only():
    done, total = mm._parse_tqdm("Fetching 8 files:  33%|███")
    assert done == 0.33 and total == 1.0
    assert mm._parse_tqdm("no progress here") is None


# ---------------------------------------------------------------- скачивание/удаление

@pytest.mark.asyncio
async def test_start_download_argv(monkeypatch, tmp_path):
    FakeAsyncClient.get_error = True
    monkeypatch.setattr(mm, "LOG_DIR", tmp_path)
    monkeypatch.setattr(mm, "_find_hf_cli", lambda: "/fake/hf")
    monkeypatch.setattr(mm.threading, "Thread", lambda *a, **k: type("T", (), {"start": lambda s: None})())

    calls = {}

    class RecordingPopen:
        def __init__(self, args, **kwargs):
            calls["args"] = args
            self.stderr = None

        def poll(self):
            return 0

    monkeypatch.setattr(mm.subprocess, "Popen", RecordingPopen)
    entry = mm.ModelEntry("laya", "Laya", "ggml-org/Laya-GGUF", 30005,
                          type="llamacpp", gguf_file="Laya-Q8_0.gguf")
    status, _ = await mm.start_download(entry)
    assert status == 200
    assert calls["args"] == ["/fake/hf", "download", "ggml-org/Laya-GGUF",
                             "--include", "Laya-Q8_0.gguf"]


@pytest.mark.asyncio
async def test_start_download_already_downloaded(monkeypatch):
    monkeypatch.setattr(mm, "is_downloaded", lambda hf_id: True)
    entry = mm.ModelEntry("m", "M", "o/m", 30097)
    status, message = await mm.start_download(entry)
    assert status == 409 and "уже скачана" in message


@pytest.mark.asyncio
async def test_delete_model_blocked_when_running():
    entry = mm.ModelEntry("m", "M", "o/m", 30098)  # порт отвечает = running
    status, message = await mm.delete_model(entry)
    assert status == 409 and "остановите" in message


# ---------------------------------------------------------------- PATCH / персистентность

def test_update_model_persists(tmp_path):
    entry = mm.ModelEntry("m", "Old", "o/m", 30090, short_label="Old",
                          peak_gb=9.0, download_gb=4.5)
    mm.REGISTRY["m"] = entry
    try:
        mm.update_model(entry, {"label": "New", "short_label": "N", "enabled": False})
        saved = json.loads((tmp_path / "models_config.json").read_text(encoding="utf-8"))
        saved_m = next(c for c in saved if c["key"] == "m")
        assert saved_m["label"] == "New"
        assert saved_m["short_label"] == "N"
        assert saved_m["enabled"] is False
        assert saved_m["peak_gb"] == 9.0
        # base_url локальной модели не правится
        mm.update_model(entry, {"base_url": "http://evil"})
        assert entry.url == "http://127.0.0.1:30090"
    finally:
        mm.REGISTRY.pop("m", None)


# ---------------------------------------------------------------- роли

def test_roles_defaults_by_type():
    """Миграция: без поля roles дефолт по типу; sglang — прогоны + ассистент."""
    assert mm.ModelEntry("s", "S", "o/s", 30101, type="sglang").roles == ["decision", "chat"]
    assert mm.ModelEntry("b", "B", "o/b", 30100, type="bonsai").roles == ["chat"]
    for t in ("clef", "llamacpp", "remote", "unknown-type"):
        assert mm.ModelEntry("m", "M", "o/m", 30102, type=t).roles == ["decision"], t


def test_load_registry_migrates_missing_roles(tmp_path):
    """Конфиг без поля roles получает дефолты по типу; явные роли сохраняются."""
    (tmp_path / "models_config.json").write_text(json.dumps([
        {"key": "s", "label": "S", "type": "sglang", "hf_id": "o/s", "port": 30103},
        {"key": "l", "label": "L", "type": "llamacpp", "hf_id": "o/l", "port": 30104},
        {"key": "x", "label": "X", "type": "sglang", "hf_id": "o/x", "port": 30105,
         "roles": ["chat"]},
    ]), encoding="utf-8")
    reg = mm.load_registry()
    assert reg["s"].roles == ["decision", "chat"]
    assert reg["l"].roles == ["decision"]
    assert reg["x"].roles == ["chat"]


def test_validate_roles():
    assert mm.validate_roles(["decision"]) is None
    assert mm.validate_roles(["decision", "chat"]) is None
    assert mm.validate_roles([]) is not None
    assert mm.validate_roles("chat") is not None
    assert mm.validate_roles(["bogus"]) is not None


def test_update_model_roles_persist(tmp_path):
    entry = mm.ModelEntry("m", "M", "o/m", 30106, type="sglang")
    mm.REGISTRY["m"] = entry
    try:
        mm.update_model(entry, {"roles": ["chat"]})
        assert entry.roles == ["chat"]
        saved = json.loads((tmp_path / "models_config.json").read_text(encoding="utf-8"))
        saved_m = next(c for c in saved if c["key"] == "m")
        assert saved_m["roles"] == ["chat"]
        for bad in ([], "chat", ["bogus"]):
            with pytest.raises(ValueError):
                mm.update_model(entry, {"roles": bad})
        assert entry.roles == ["chat"]  # невалидные роли не применились
    finally:
        mm.REGISTRY.pop("m", None)


# ---------------------------------------------------------------- context_length

def test_update_model_context_length(tmp_path):
    entry = mm.ModelEntry("m", "M", "o/m", 30107, type="sglang")
    mm.REGISTRY["m"] = entry
    try:
        mm.update_model(entry, {"context_length": 65536})
        assert entry.context_length == 65536
        saved = json.loads((tmp_path / "models_config.json").read_text(encoding="utf-8"))
        saved_m = next(c for c in saved if c["key"] == "m")
        assert saved_m["context_length"] == 65536
        mm.update_model(entry, {"context_length": None})  # пусто → дефолт раннера
        assert entry.context_length is None
        saved = json.loads((tmp_path / "models_config.json").read_text(encoding="utf-8"))
        saved_m = next(c for c in saved if c["key"] == "m")
        assert "context_length" not in saved_m
        for bad in (-1, 512, "65536", True):
            with pytest.raises(ValueError):
                mm.update_model(entry, {"context_length": bad})
        clef_entry = mm.ModelEntry("c", "C", "o/c", 30108, type="clef")
        with pytest.raises(ValueError):
            mm.update_model(clef_entry, {"context_length": 8192})  # только sglang
    finally:
        mm.REGISTRY.pop("m", None)


@pytest.mark.asyncio
async def test_start_model_env_context_default(monkeypatch, tmp_path):
    """sglang стартует с CONTEXT_LENGTH/MAX_TOTAL_TOKENS 32768 по умолчанию,
    context_length модели переопределяет."""
    FakeAsyncClient.get_error = True  # порты свободны
    monkeypatch.setattr(mm, "LOG_DIR", tmp_path)
    calls = {}

    class RecordingPopen:
        def __init__(self, args, **kwargs):
            calls["env"] = kwargs["env"]

        def poll(self):
            return None  # процесс «жив»

    monkeypatch.setattr(mm.subprocess, "Popen", RecordingPopen)
    entry = mm.ModelEntry("m", "M", "o/m", 30109, type="sglang", peak_gb=5.0)
    ok, err = await mm.start_model(entry)
    assert ok, err
    assert calls["env"]["CONTEXT_LENGTH"] == "32768"
    assert calls["env"]["MAX_TOTAL_TOKENS"] == "32768"

    entry2 = mm.ModelEntry("m2", "M2", "o/m2", 30110, type="sglang",
                           peak_gb=5.0, context_length=49152)
    ok, err = await mm.start_model(entry2)
    assert ok, err
    assert calls["env"]["CONTEXT_LENGTH"] == "49152"


# ---------------------------------------------------------------- credentials

def test_credentials_roundtrip_and_permissions(tmp_path):
    path = tmp_path / "credentials.json"
    assert creds.get("m") is None and not creds.has("m")
    creds.save("m", "secret-key")
    assert creds.get("m") == "secret-key" and creds.has("m")
    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode == 0o600
    assert creds.delete("m") is True
    assert creds.get("m") is None
    assert creds.delete("m") is False


def test_auth_headers(tmp_path):
    entry = mm.ModelEntry("r", "R", "", 0, type="remote", api="systemone",
                          base_url="http://x")
    assert mm._auth_headers(entry) == {}
    creds.save("r", "k")
    assert mm._auth_headers(entry) == {"Authorization": "Bearer k"}


# ---------------------------------------------------------------- remote-модели

def test_create_remote_model(added):
    entry, error = mm.create_remote_model({
        "label": "Моя облачная", "base_url": "https://api.example.com/",
        "api": "systemone", "api_model": "clef-flash", "api_key": "sk-1",
    })
    assert error is None
    added.append(entry.key)
    assert entry.key.startswith("remote-")
    assert entry.type == "remote" and not entry.managed
    assert entry.api == "systemone"
    assert entry.url == "https://api.example.com"  # trailing slash срезан
    assert creds.get(entry.key) == "sk-1"

    # ключ уникализируется
    entry2, _ = mm.create_remote_model({
        "label": "Моя облачная", "base_url": "http://x", "api": "decisions"})
    added.append(entry2.key)
    assert entry2.key != entry.key

    # валидация
    _, e1 = mm.create_remote_model({"label": "", "base_url": "http://x", "api": "systemone"})
    _, e2 = mm.create_remote_model({"label": "L", "base_url": "ftp://x", "api": "systemone"})
    _, e3 = mm.create_remote_model({"label": "L", "base_url": "http://x", "api": "chat"})
    assert e1 and e2 and e3


def test_delete_remote_model(added):
    entry, _ = mm.create_remote_model({
        "label": "Temp", "base_url": "http://x", "api": "decisions", "api_key": "k"})
    added.append(entry.key)
    status, _ = mm.delete_remote_model(entry)
    assert status == 200
    assert entry.key not in mm.REGISTRY
    assert creds.get(entry.key) is None  # креды удаляются вместе с моделью

    local = mm.ModelEntry("loc", "L", "o/l", 30089)
    status, _ = mm.delete_remote_model(local)
    assert status == 422


@pytest.mark.asyncio
async def test_remote_statuses():
    entry = mm.ModelEntry("r", "R", "", 0, type="remote", api="systemone",
                          base_url="http://x")
    info = await mm.model_status(entry)
    assert info["status"] == "no_credentials"  # нет ключа

    creds.save("r", "k")
    info = await mm.model_status(entry)
    assert info["status"] == "running"  # фейковый probe отвечает 200
    assert info["has_credentials"] is True

    mm.invalidate_remote_probe("r")
    FakeAsyncClient.get_error = True
    info = await mm.model_status(entry)
    assert info["status"] == "unreachable"


@pytest.mark.asyncio
async def test_remote_probe_cached_by_ttl():
    """Повторные статусы в пределах TTL не ходят во внешний API повторно."""
    entry = mm.ModelEntry("r", "R", "", 0, type="remote", api="systemone",
                          base_url="http://x")
    creds.save("r", "k")
    await mm.model_status(entry)
    await mm.model_status(entry)
    gets = [u for u in FakeAsyncClient.get_calls if u.startswith("http://x/")]
    assert len(gets) == 1  # вторая проверка — из кэша

    FakeAsyncClient.get_error = True
    info = await mm.model_status(entry)
    assert info["status"] == "running"  # кэш ещё жив

    mm.invalidate_remote_probe("r")
    info = await mm.model_status(entry)
    assert info["status"] == "unreachable"  # после инвалидации — свежая проба


@pytest.mark.asyncio
async def test_remote_decide_sends_authorization():
    """clef.run для remote-модели шлёт Bearer из credentials и api_model из конфига."""
    entry = mm.ModelEntry("r", "R", "", 0, type="remote", api="systemone",
                          base_url="http://cloud:9000/", api_model="laya")
    creds.save("r", "sk-test")
    req = DecideRequest(input="Текст.", models=["r"],
                        questions=[Question(id="q1", question="Да?", type="yes_no")])
    FakeAsyncClient.post_response = FakeResponse(200, {
        "answers": {"q1": {"type": "noul", "noul": 0.5}}, "usage": {"input_tokens": 10},
    })
    result = await clef.run(entry, req)
    assert result["ok"] is True
    call = FakeAsyncClient.post_calls[0]
    assert call["url"] == "http://cloud:9000/v1/systemone"
    assert call["headers"] == {"Authorization": "Bearer sk-test"}
    assert call["json"]["model"] == "laya"
    assert result["metrics"]["rss_gb"] is None  # у remote нет RSS


def test_not_running_message():
    local = mm.ModelEntry("loc", "L", "o/l", 30088)
    assert "start" in mm.not_running_message(local, "stopped")
    remote = mm.ModelEntry("r", "R", "", 0, type="remote", api="decisions",
                           base_url="http://x")
    msg = mm.not_running_message(remote, "unreachable")
    assert "base_url" in msg and "start" not in msg


# ---------------------------------------------------------------- total_ram_gb (кроссплатформенность)

def test_total_ram_gb_prefers_psutil(monkeypatch):
    """psutil — основной источник (работает на Windows/Linux/macOS), sysctl не дёргается."""
    class VM:
        total = 48 * 1024**3
    monkeypatch.setattr(mm, "psutil",
                        type("P", (), {"virtual_memory": staticmethod(lambda: VM())}))
    def forbidden_run(*a, **k):
        raise AssertionError("sysctl не должен вызываться при живом psutil")
    monkeypatch.setattr(mm.subprocess, "run", forbidden_run)
    assert mm.total_ram_gb() == 48.0


def test_total_ram_gb_sysctl_fallback(monkeypatch):
    """Без psutil — sysctl hw.memsize (macOS)."""
    monkeypatch.setattr(mm, "psutil", None)

    class Out:
        stdout = str(64 * 1024**3)
    monkeypatch.setattr(mm.subprocess, "run", lambda *a, **k: Out())
    assert mm.total_ram_gb() == 64.0


def test_total_ram_gb_psutil_error_falls_to_sysctl(monkeypatch):
    """psutil есть, но virtual_memory упал — фолбэк на sysctl."""
    def boom():
        raise RuntimeError("no /proc")
    monkeypatch.setattr(mm, "psutil",
                        type("P", (), {"virtual_memory": staticmethod(boom)}))

    class Out:
        stdout = str(16 * 1024**3)
    monkeypatch.setattr(mm.subprocess, "run", lambda *a, **k: Out())
    assert mm.total_ram_gb() == 16.0


def test_total_ram_gb_conservative_default(monkeypatch):
    """Ни psutil, ни sysctl — консервативные 32 ГБ."""
    monkeypatch.setattr(mm, "psutil", None)

    def no_sysctl(*a, **k):
        raise FileNotFoundError("sysctl")
    monkeypatch.setattr(mm.subprocess, "run", no_sysctl)
    assert mm.total_ram_gb() == 32.0


# ---------------------------------------------------------------- не-POSIX ОС

@pytest.mark.asyncio
async def test_start_model_non_posix(monkeypatch):
    """На не-POSIX (Windows) запуск локальной модели отклоняется до проб/бюджета."""
    monkeypatch.setattr(mm.os, "name", "nt")
    entry = mm.ModelEntry("m", "M", "o/m", 30087)
    ok, err = await mm.start_model(entry)
    assert not ok and "macOS/Linux" in err


@pytest.mark.asyncio
async def test_stop_model_non_posix(monkeypatch):
    """На не-POSIX остановка отклоняется без os.killpg."""
    monkeypatch.delattr(mm.os, "killpg")
    entry = mm.ModelEntry("m", "M", "o/m", 30086)
    status, msg = await mm.stop_model(entry)
    assert status == 422 and "POSIX" in msg
