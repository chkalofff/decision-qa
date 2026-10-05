"""Unit-тесты model_manager: статусы, запуск, остановка, RSS."""

from __future__ import annotations

import httpx
import pytest

from backend import model_manager as mm


class FakeResponse:
    def __init__(self, status_code=200):
        self.status_code = status_code

    def json(self):
        return {"data": [{"id": "m"}]}


class FakeAsyncClient:
    get_error = False

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, **kwargs):
        if FakeAsyncClient.get_error:
            raise httpx.ConnectError("connection refused")
        return FakeResponse(200)


@pytest.fixture(autouse=True)
def base_mocks(monkeypatch):
    FakeAsyncClient.get_error = False
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(mm, "is_downloaded", lambda hf_id: False)
    monkeypatch.setattr(mm, "rss_gb", lambda port: 12.3)
    # бюджет памяти проверяется отдельными тестами; здесь он бы мешал
    # (фейковый health-probe отвечает 200 на всех портах реестра)
    async def no_budget_error(entry):
        return None
    monkeypatch.setattr(mm, "budget_check", no_budget_error)
    for entry in mm.REGISTRY.values():
        entry.proc = None
        entry.started_at = None
    yield


def make_entry(key="test-model", port=30099):
    return mm.ModelEntry(key, "Test Model", "org/test-model", port)


# ---------------------------------------------------------------- статусы

@pytest.mark.asyncio
async def test_status_not_downloaded():
    FakeAsyncClient.get_error = True
    info = await mm.model_status(make_entry())
    assert info["status"] == "not_downloaded"
    assert info["rss_gb"] is None


@pytest.mark.asyncio
async def test_status_stopped(monkeypatch):
    FakeAsyncClient.get_error = True
    monkeypatch.setattr(mm, "is_downloaded", lambda hf_id: True)
    info = await mm.model_status(make_entry())
    assert info["status"] == "stopped"


@pytest.mark.asyncio
async def test_status_running_adopted():
    entry = make_entry()  # proc=None, но порт отвечает → подхвачен чужой сервер
    info = await mm.model_status(entry)
    assert info["status"] == "running"
    assert info["rss_gb"] == 12.3


class FakeProc:
    def __init__(self, returncode=None, pid=4242):
        self._returncode = returncode
        self.pid = pid

    @property
    def returncode(self):
        return self._returncode

    def poll(self):
        return self._returncode


@pytest.mark.asyncio
async def test_status_starting():
    FakeAsyncClient.get_error = True
    entry = make_entry()
    entry.proc = FakeProc(returncode=None)
    info = await mm.model_status(entry)
    assert info["status"] == "starting"


@pytest.mark.asyncio
async def test_status_error_with_log_tail(monkeypatch, tmp_path):
    FakeAsyncClient.get_error = True
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    (log_dir / "test-model.log").write_text("\n".join(f"line{i}" for i in range(10)))
    monkeypatch.setattr(mm, "LOG_DIR", log_dir)
    entry = make_entry()
    entry.proc = FakeProc(returncode=1)
    info = await mm.model_status(entry)
    assert info["status"] == "error"
    assert "кодом 1" in info["error"]
    assert "line9" in info["error"]
    assert "line5" in info["error"]  # только последние ~5 строк
    assert "line4" not in info["error"]
    assert entry.proc is None  # мёртвый процесс сброшен


# ---------------------------------------------------------------- start

@pytest.mark.asyncio
async def test_start_spawns_popen(monkeypatch, tmp_path):
    FakeAsyncClient.get_error = True
    monkeypatch.setattr(mm, "LOG_DIR", tmp_path)
    popen_calls = {}

    class RecordingPopen(FakeProc):
        def __init__(self, cmd, env=None, stdout=None, stderr=None, start_new_session=False):
            super().__init__(returncode=None, pid=7777)
            popen_calls.update(cmd=cmd, env=env, start_new_session=start_new_session,
                               stdout=stdout, stderr=stderr)

    monkeypatch.setattr(mm.subprocess, "Popen", RecordingPopen)
    entry = make_entry()
    ok, error = await mm.start_model(entry)
    assert ok and error is None
    assert popen_calls["cmd"] == ["bash", str(mm.RUN_SERVER)]
    assert popen_calls["env"]["MODEL"] == "org/test-model"
    assert popen_calls["env"]["PORT"] == "30099"
    assert popen_calls["start_new_session"] is True
    assert entry.proc.pid == 7777
    popen_calls["stdout"].close()


@pytest.mark.asyncio
async def test_start_idempotent_when_already_starting(monkeypatch, tmp_path):
    FakeAsyncClient.get_error = True
    monkeypatch.setattr(mm, "LOG_DIR", tmp_path)

    def boom(*args, **kwargs):
        raise AssertionError("Popen не должен вызываться повторно")

    monkeypatch.setattr(mm.subprocess, "Popen", boom)
    entry = make_entry()
    entry.proc = FakeProc(returncode=None)
    ok, _ = await mm.start_model(entry)
    assert ok


@pytest.mark.asyncio
async def test_start_idempotent_when_running():
    entry = make_entry()  # порт отвечает → running
    ok, _ = await mm.start_model(entry)
    assert ok
    assert entry.proc is None  # чужой процесс не подхватываем


# ---------------------------------------------------------------- stop

@pytest.mark.asyncio
async def test_stop_own_process_via_killpg(monkeypatch):
    killed = []
    monkeypatch.setattr(mm.os, "getpgid", lambda pid: 555)
    monkeypatch.setattr(mm.os, "killpg", lambda pgid, sig: killed.append((pgid, sig)))
    entry = make_entry()
    entry.proc = FakeProc(returncode=None, pid=7777)
    status, message = await mm.stop_model(entry)
    assert status == 200
    assert killed == [(555, mm.signal.SIGTERM)]


@pytest.mark.asyncio
async def test_stop_adopted_model_process(monkeypatch):
    """Сервер пережил перезапуск бэкенда (proc=None, порт отвечает) — останавливаем по cmdline."""
    killed = []
    monkeypatch.setattr(mm, "adopted_pids", lambda port: [7777, 7778])
    monkeypatch.setattr(mm.os, "getpgid", lambda pid: 555 if pid == 7777 else 556)
    monkeypatch.setattr(mm.os, "killpg", lambda pgid, sig: killed.append((pgid, sig)))
    entry = make_entry()
    status, message = await mm.stop_model(entry)
    assert status == 200
    assert sorted(killed) == [(555, mm.signal.SIGTERM), (556, mm.signal.SIGTERM)]


@pytest.mark.asyncio
async def test_stop_foreign_process_conflict(monkeypatch):
    """Порт занят, но процесс не похож на модельный — не трогаем."""
    monkeypatch.setattr(mm, "adopted_pids", lambda port: [])
    entry = make_entry()  # proc=None, порт отвечает
    status, message = await mm.stop_model(entry)
    assert status == 409
    assert "неизвестным процессом" in message


@pytest.mark.asyncio
async def test_stop_when_not_running():
    FakeAsyncClient.get_error = True
    entry = make_entry()
    status, _ = await mm.stop_model(entry)
    assert status == 200


# ---------------------------------------------------------------- clef-раннер

@pytest.mark.asyncio
async def test_start_clef_uses_run_clef(monkeypatch, tmp_path):
    FakeAsyncClient.get_error = True
    monkeypatch.setattr(mm, "LOG_DIR", tmp_path)
    popen_calls = {}

    class RecordingPopen(FakeProc):
        def __init__(self, cmd, env=None, stdout=None, stderr=None, start_new_session=False):
            super().__init__(returncode=None, pid=7778)
            popen_calls.update(cmd=cmd, env=env)

    monkeypatch.setattr(mm.subprocess, "Popen", RecordingPopen)
    entry = mm.ModelEntry("clef-flash-9b-4bit", "Clef-Flash 9B", "mlx-community/clef-flash-4bit",
                          30003, 0.14, "clef")
    ok, error = await mm.start_model(entry)
    assert ok and error is None
    assert popen_calls["cmd"] == ["bash", str(mm.RUN_CLEF)]
    assert popen_calls["env"]["MODEL"] == "mlx-community/clef-flash-4bit"
    assert popen_calls["env"]["PORT"] == "30003"
    assert "MEM_FRACTION" not in popen_calls["env"]  # у clef нет статического резервирования


# ---------------------------------------------------------------- бюджет памяти

# Настоящая функция (base_mocks подменяет mm.budget_check на заглушку)
from backend.model_manager import budget_check as REAL_BUDGET_CHECK


@pytest.mark.asyncio
async def test_budget_blocks_over_limit(monkeypatch):
    async def fake_port_running(port):
        return port in (30001, 30002)  # запущены qwen 27B (~17 ГБ) и 35B (~24 ГБ)

    monkeypatch.setattr(mm, "port_running", fake_port_running)
    monkeypatch.setattr(mm, "budget_check", REAL_BUDGET_CHECK)
    monkeypatch.setattr(mm, "BUDGET_GB", 45.0)  # детерминированный бюджет, независимо от RAM
    entry = mm.ModelEntry("clef-27b-4bit", "Clef 27B", "mlx-community/clef-4bit",
                          30004, type="clef", peak_gb=20.0)  # 17+24+20 > 45
    error = await mm.budget_check(entry)
    assert error is not None
    assert "памят" in error.lower()
    assert "clef-27b-4bit" in error


@pytest.mark.asyncio
async def test_budget_allows_within_limit(monkeypatch):
    async def fake_port_running(port):
        return port in (30001, 30002)  # ~17 + ~24 = ~41 ГБ

    monkeypatch.setattr(mm, "port_running", fake_port_running)
    monkeypatch.setattr(mm, "budget_check", REAL_BUDGET_CHECK)
    monkeypatch.setattr(mm, "BUDGET_GB", 45.0)
    entry = mm.ModelEntry("m", "M", "org/m", 30099, peak_gb=1.0)  # 41+1 ≤ 45
    assert await mm.budget_check(entry) is None
    assert await mm.budget_check(entry) is None


# ---------------------------------------------------------------- матч порта в cmdline

def test_port_in_cmd_single_element_argv():
    # bash-обёртка отдаёт argv одним элементом-строкой
    cmd = "python -m sglang.launch_server --model-path org/m --max-total-tokens 8192 --host 127.0.0.1 --port 30002"
    assert mm._port_in_cmd(cmd, 30002)
    assert not mm._port_in_cmd(cmd, 3000)
    assert not mm._port_in_cmd(cmd, 300)
    assert not mm._port_in_cmd(cmd, 300020)


def test_port_in_cmd_normal_argv():
    cmd = "python clef_mlx.py serve --port 30003"
    assert mm._port_in_cmd(cmd, 30003)
    assert not mm._port_in_cmd(cmd, 30002)
