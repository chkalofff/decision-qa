"""FastAPI contract tests plus one real isolated uvicorn /api/run smoke."""

from __future__ import annotations

import asyncio
import gzip
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

from backend import auth
from backend import app as app_module
from backend.run_jobs import RunManager
from backend.run_schemas import RunLimits
from backend.run_store import RunStore
from backend.schemas import MAX_IMAGES_B64_CHARS
from backend.tests.run_support import (
    FakeEngine, client_fingerprint, file_payload, pack, reset_fake, wait_terminal,
)

ROOT = Path(__file__).resolve().parent.parent.parent


@pytest_asyncio.fixture
async def api(tmp_path):
    reset_fake()
    service = RunManager(RunStore(tmp_path / "runs", RunLimits()), engine_factory=FakeEngine)
    app_module.app.state.run_manager = service
    transport = httpx.ASGITransport(app=app_module.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client, service
    await service.close()


def create_body(files, *, models=None, threads=None):
    return {
        "pack": pack(models), "overrides": {}, "threads": threads,
        "material_count": len(files), "materials_fingerprint": client_fingerprint(files),
    }


async def create(client, files, key="create-key", **kwargs):
    response = await client.post("/api/run", json=create_body(files, **kwargs),
                                 headers={"Idempotency-Key": key})
    assert response.status_code == 201, response.text
    return response.json()


def sse_events(raw):
    events = []
    for block in raw.split("\n\n"):
        data = [line[6:] for line in block.splitlines() if line.startswith("data: ")]
        if data:
            events.append(json.loads("\n".join(data)))
    return events


@pytest.mark.asyncio
async def test_full_lifecycle_idempotency_pagination_and_sse_reconnect(api, monkeypatch):
    client, service = api
    files = [file_payload(i, name=f"f{i}.txt", path=f"client/f{i}.txt") for i in range(3)]
    created = await create(client, files, threads=2)
    run_id = created["run_id"]
    assert created["status"] == "uploading"
    assert created["config_hash"] == created["effective_config"]["hash"]
    repeated = await client.post("/api/run", json=create_body(files, threads=2),
                                 headers={"Idempotency-Key": "create-key"})
    assert repeated.status_code == 200 and repeated.json()["run_id"] == run_id
    different = create_body(files, threads=2)
    different["material_count"] = 2
    conflict = await client.post("/api/run", json=different, headers={"Idempotency-Key": "create-key"})
    assert conflict.status_code == 409

    later = await client.post(f"/api/run/{run_id}/files", json={"chunk_index": 1, "files": files[2:]})
    assert later.status_code == 200
    first = await client.post(f"/api/run/{run_id}/files", json={"chunk_index": 0, "files": files[:2]})
    assert first.status_code == 200 and first.json()["uploaded"] == 3
    replay = await client.post(f"/api/run/{run_id}/files", json={"chunk_index": 0, "files": files[:2]})
    assert replay.status_code == 200 and replay.json()["accepted"] is False
    changed = dict(files[0])
    changed["name"] = "changed.txt"
    conflict = await client.post(f"/api/run/{run_id}/files",
                                 json={"chunk_index": 0, "files": [changed, files[1]]})
    assert conflict.status_code == 409

    started = await client.post(f"/api/run/{run_id}/start")
    assert started.status_code == 200
    again = await client.post(f"/api/run/{run_id}/start")
    assert again.status_code == 200
    job = service.store.get("local", run_id)
    await wait_terminal(service, job)
    metadata = (await client.get(f"/api/run/{run_id}")).json()
    assert metadata["status"] == "completed"
    assert metadata["threads_effective"] == 2
    assert metadata["summary"]["files_ok"] == 3
    assert FakeEngine.controller.preflight_calls == 1
    assert len(FakeEngine.controller.calls) == 3
    terminal_replay = await client.post(f"/api/run/{run_id}/files",
                                        json={"chunk_index": 0, "files": files[:2]})
    assert terminal_replay.status_code == 200 and terminal_replay.json()["accepted"] is False

    page = (await client.get(f"/api/run/{run_id}/files?offset=0&limit=2")).json()
    assert [item["i"] for item in page["files"]] == [0, 1]
    assert page["next_offset"] == 2
    tail = (await client.get(f"/api/run/{run_id}/files?offset=2&limit=2")).json()
    assert [item["i"] for item in tail["files"]] == [2]
    assert tail["next_offset"] is None
    serialized = json.dumps(page, ensure_ascii=False)
    assert "material-0" not in serialized and "client/f0.txt" in serialized
    assert page["files"][0]["aggregate"]["answers"]["q1"]["by_model"]["fake"]["yes"] == 0.8

    replayed = await client.get(f"/api/run/{run_id}/events?after=1")
    events = sse_events(replayed.text)
    assert [event["seq"] for event in events] == list(range(2, 6))
    assert [event["type"] for event in events] == ["file", "file", "file", "run_end"]
    assert all("material-" not in json.dumps(event) for event in events if event["type"] == "file")
    assert replayed.headers["cache-control"] == "no-cache"
    assert replayed.headers["x-accel-buffering"] == "no"
    by_header = await client.get(f"/api/run/{run_id}/events", headers={"Last-Event-ID": "4"})
    assert [event["seq"] for event in sse_events(by_header.text)] == [5]
    assert (await client.get(f"/api/run/{run_id}/events?after=99")).status_code == 409
    assert (await client.get(f"/api/run/{run_id}/events?after=-1")).status_code == 409
    assert (await client.get(f"/api/run/{run_id}/events",
                             headers={"Last-Event-ID": "bad"})).status_code == 409

    monkeypatch.setattr(auth, "authenticate", lambda token: "other" if token == "valid" else None)
    headers = {"Authorization": "Bearer valid"}
    for method, path in (
        ("GET", f"/api/run/{run_id}"), ("GET", f"/api/run/{run_id}/files"),
        ("GET", f"/api/run/{run_id}/events"), ("POST", f"/api/run/{run_id}/cancel"),
        ("POST", f"/api/run/{run_id}/start"),
    ):
        response = await client.request(method, path, headers=headers)
        assert response.status_code == 404


@pytest.mark.asyncio
async def test_start_validation_fingerprint_models_and_incomplete(api):
    client, service = api
    files = [file_payload(0)]
    created = await create(client, files, key="incomplete")
    incomplete = await client.post(f"/api/run/{created['run_id']}/start")
    assert incomplete.status_code == 422 and "не все" in incomplete.json()["detail"]

    body = create_body(files)
    body["materials_fingerprint"] = "sha256:" + "f" * 64
    created = (await client.post("/api/run", json=body, headers={"Idempotency-Key": "bad-fp"})).json()
    await client.post(f"/api/run/{created['run_id']}/files", json={"chunk_index": 0, "files": files})
    mismatch = await client.post(f"/api/run/{created['run_id']}/start")
    assert mismatch.status_code == 422 and "materials_fingerprint" in mismatch.json()["detail"]

    created = await create(client, files, key="down")
    await client.post(f"/api/run/{created['run_id']}/files", json={"chunk_index": 0, "files": files})
    FakeEngine.statuses = {"fake": "stopped"}
    down = await client.post(f"/api/run/{created['run_id']}/start")
    assert down.status_code == 409 and "fake" in down.json()["detail"]
    FakeEngine.statuses = {"fake": "running"}
    assert (await client.post(f"/api/run/{created['run_id']}/start")).status_code == 200
    await wait_terminal(service, service.store.get("local", created["run_id"]))


@pytest.mark.asyncio
async def test_pack_integrity_and_raw_file_bytes_are_accepted(api):
    client, service = api
    files = [file_payload(0, "Привет")]
    invalid = create_body(files)
    invalid["pack"]["hash"] = "sha256:" + "a" * 64
    rejected = await client.post("/api/run", json=invalid, headers={"Idempotency-Key": "bad-pack"})
    assert rejected.status_code == 422 and "integrity mismatch" in rejected.json()["detail"]

    from dqa_common.materials import raw_content_sha256
    raw = "Привет".encode("cp1251")
    files[0]["content_sha256"] = raw_content_sha256(raw)
    created = await create(client, files, key="cp1251")
    run_id = created["run_id"]
    uploaded = await client.post(f"/api/run/{run_id}/files", json={"chunk_index": 0, "files": files})
    assert uploaded.status_code == 200, uploaded.text
    started = await client.post(f"/api/run/{run_id}/start")
    assert started.status_code == 200, started.text
    job = service.store.get("local", run_id)
    await wait_terminal(service, job)
    result = service.store.read_results(job, 0, 1)["files"][0]
    assert result["content_sha256"] == raw_content_sha256(raw)


@pytest.mark.asyncio
async def test_gzip_upload_bomb_limit_and_maximum_image_material(api, tmp_path):
    client, service = api
    files = [file_payload(0)]
    created = await create(client, files, key="gzip")
    raw = json.dumps({"chunk_index": 0, "files": files}).encode()
    response = await client.post(f"/api/run/{created['run_id']}/files", content=gzip.compress(raw),
                                 headers={"Content-Encoding": "gzip", "Content-Type": "application/json"})
    assert response.status_code == 200

    other = await create(client, files, key="bomb")
    bomb = gzip.compress(b" " * (service.limits.max_chunk_bytes + 100))
    response = await client.post(f"/api/run/{other['run_id']}/files", content=bomb,
                                 headers={"Content-Encoding": "gzip", "Content-Type": "application/json"})
    assert response.status_code == 413

    import base64
    image = base64.b64encode(b"\0" * (MAX_IMAGES_B64_CHARS // 4 * 3)).decode()
    assert len(image) == MAX_IMAGES_B64_CHARS
    image_file = file_payload(0, "", images=[image], material={"type": "image", "images": [{"name": "max.png"}]})
    created = await create(client, [image_file], key="max-image")
    raw = json.dumps({"chunk_index": 0, "files": [image_file]}).encode()
    response = await client.post(f"/api/run/{created['run_id']}/files", content=gzip.compress(raw),
                                 headers={"Content-Encoding": "gzip", "Content-Type": "application/json"})
    assert response.status_code == 200, response.text


@pytest.mark.asyncio
async def test_disconnect_does_not_cancel_and_capabilities_auth(api, monkeypatch):
    client, service = api
    controller = FakeEngine.controller
    controller.release.clear()
    files = [file_payload(0)]
    created = await create(client, files, key="disconnect")
    run_id = created["run_id"]
    await client.post(f"/api/run/{run_id}/files", json={"chunk_index": 0, "files": files})
    await client.post(f"/api/run/{run_id}/start")
    from fastapi import Request
    from backend.run_routes import events
    scope = {
        "type": "http", "app": app_module.app, "method": "GET", "scheme": "http",
        "path": f"/api/run/{run_id}/events", "raw_path": f"/api/run/{run_id}/events".encode(),
        "query_string": b"", "headers": [], "client": ("testclient", 123),
        "server": ("testserver", 80), "http_version": "1.1", "root_path": "",
    }
    request = Request(scope)
    request.state.owner = "local"
    response = await events(run_id, request, after=0, last_event_id=None)
    iterator = response.body_iterator
    first = await anext(iterator)
    assert first.startswith("id: 1\n") and "run_start" in first
    await iterator.aclose()
    job = service.store.get("local", run_id)
    assert job.status == "running" and not job.cancel_requested
    controller.release.set()
    await wait_terminal(service, job)

    monkeypatch.setenv("DQA_AUTH_REQUIRED", "1")
    public = await client.get("/api/run/capabilities")
    assert public.status_code == 200 and "models" not in public.json()
    assert public.json()["max_images_b64_chars"] == MAX_IMAGES_B64_CHARS
    assert public.json()["features"] == {"after_seq": True, "cancel": True, "gzip": True}
    monkeypatch.setattr(auth, "authenticate", lambda token: "remote" if token == "valid" else None)
    private = await client.get("/api/run/capabilities", headers={"Authorization": "Bearer valid"})
    assert private.status_code == 200 and "models" in private.json()
    assert {"status", "type", "api"}.issubset(private.json()["models"][0])


def test_real_uvicorn_http_smoke(tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    code = r'''
import asyncio
from backend import app as app_module
from backend import model_manager as mm
from backend import run_engine
from run_support_smoke import install
install()
import uvicorn
uvicorn.run(app_module.app, host="127.0.0.1", port=PORT, log_level="warning")
'''.replace("PORT", str(port))
    (tmp_path / "run_support_smoke.py").write_text('''
from backend import decide_service, model_manager as mm, run_engine

def install():
    entry = mm.ModelEntry("fake", "Fake", "", 0, type="remote", api="decisions", base_url="http://fake")
    mm.REGISTRY["fake"] = entry
    async def status(entry):
        return {"status": "running"}
    async def decide(entry, payload, *, check_status=True):
        return {"ok": True, "answers": {"q1": {"type": "yes_no", "probabilities": {"yes": 0.9, "no": 0.1}}}, "usage": {}, "metrics": {}}
    run_engine.mm.model_status = status
    decide_service.decide_one = decide
''', encoding="utf-8")
    env = {**os.environ, "PYTHONPATH": f"{tmp_path}{os.pathsep}{ROOT}", "DQA_RUN_STATE_DIR": str(tmp_path / "state")}
    process = subprocess.Popen([sys.executable, "-c", code], cwd=ROOT, env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise AssertionError(process.stdout.read())
            try:
                if httpx.get(base + "/api/version", timeout=0.1).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.05)
        else:
            raise AssertionError("uvicorn did not start")
        files = [file_payload(0)]
        created = httpx.post(base + "/api/run", json=create_body(files),
                             headers={"Idempotency-Key": "uvicorn"}, timeout=5)
        assert created.status_code == 201, created.text
        run_id = created.json()["run_id"]
        assert httpx.post(base + f"/api/run/{run_id}/files", json={"chunk_index": 0, "files": files}, timeout=5).status_code == 200
        assert httpx.post(base + f"/api/run/{run_id}/start", timeout=5).status_code == 200
        with httpx.stream("GET", base + f"/api/run/{run_id}/events", timeout=5) as response:
            assert response.status_code == 200
            raw = "".join(response.iter_text())
        events = sse_events(raw)
        assert [event["type"] for event in events] == ["run_start", "file", "run_end"]
        assert events[-1]["status"] == "completed"
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
