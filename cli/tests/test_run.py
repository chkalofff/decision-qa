from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from dqa.processed import ProcessedManifest
from dqa_common.config_pack import finalize_pack

ROOT = Path(__file__).resolve().parents[2]


def set_control(server, **changes):
    value = json.loads(server["control"].read_text(encoding="utf-8"))
    value.update(changes)
    server["control"].write_text(json.dumps(value))


def records(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def cli_args(pack, server, *args):
    return ("run", "--config", str(pack), "--server", server["url"], *args)


def ndjson(result):
    assert result.stdout, result.stderr.decode()
    return [json.loads(line) for line in result.stdout.decode().splitlines() if line]


@pytest.fixture
def run_server(tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    control = tmp_path / "control.json"
    requests = tmp_path / "requests.ndjson"
    calls = tmp_path / "calls.ndjson"
    token_file = tmp_path / "tokens.json"
    control.write_text(json.dumps({
        "delay": 0, "partial": False, "fail_create_once": False,
        "fail_chunk_once": False, "inject_resync_once": False, "start_429_once": False,
        "cancel_429": False, "prepare_delay": 0, "page_delay": 0, "break_sse": False,
    }))
    bootstrap = tmp_path / "bootstrap.py"
    bootstrap.write_text(r'''
import asyncio
import json
import os
from pathlib import Path

import uvicorn
from fastapi.responses import JSONResponse, StreamingResponse
from backend import app as app_module
from backend import auth, decide_service, model_manager as mm

CONTROL = Path(os.environ["CONTROL"])
REQUESTS = Path(os.environ["REQUESTS"])
CALLS = Path(os.environ["CALLS"])

def flags():
    return json.loads(CONTROL.read_text(encoding="utf-8"))

def update(**changes):
    value = flags()
    value.update(changes)
    CONTROL.write_text(json.dumps(value))

def append(path, value):
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False) + "\n")
        stream.flush()

for key in ("alpha", "beta"):
    mm.REGISTRY[key] = mm.ModelEntry(key, key.title(), "", 0, type="remote", api="decisions", base_url="http://fake")

async def status(entry):
    return {"status": "running"}

mm.model_status = status

async def decide(entry, payload, *, check_status=True):
    current = flags()
    append(CALLS, {"model": entry.key, "input": payload.get("input")})
    if current.get("delay"):
        await asyncio.sleep(current["delay"])
    if current.get("partial") and entry.key == "beta":
        return {"ok": False, "error": "beta down"}
    return {
        "ok": True,
        "answers": {"q1": {"type": "yes_no", "probabilities": {"yes": 0.9, "no": 0.1}}},
        "usage": {"prompt_tokens": 2}, "metrics": {}, "prompt_format_version": 3,
    }

decide_service.decide_one = decide

@app_module.app.middleware("http")
async def faults(request, call_next):
    append(REQUESTS, {"method": request.method, "path": request.url.path})
    current = flags()
    if request.url.path == "/api/run/capabilities" and current.get("prepare_delay"):
        await asyncio.sleep(current["prepare_delay"])
    if request.method == "GET" and request.url.path.endswith("/files") and current.get("page_delay"):
        await asyncio.sleep(current["page_delay"])
    if request.method == "POST" and request.url.path == "/api/run" and current.get("fail_create_once"):
        update(fail_create_once=False)
        return JSONResponse({"detail": "injected create failure"}, status_code=500)
    if request.method == "POST" and request.url.path.endswith("/files") and current.get("fail_chunk_once"):
        update(fail_chunk_once=False)
        return JSONResponse({"detail": "injected chunk failure"}, status_code=500)
    if request.method == "POST" and request.url.path.endswith("/start") and current.get("start_429_once"):
        update(start_429_once=False)
        return JSONResponse({"detail": "injected capacity"}, status_code=429, headers={"Retry-After": "0"})
    if request.method == "POST" and request.url.path.endswith("/cancel") and current.get("cancel_429"):
        return JSONResponse({"detail": "endless capacity"}, status_code=429, headers={"Retry-After": "0"})
    if request.method == "GET" and request.url.path.endswith("/events") and current.get("break_sse"):
        return JSONResponse({"detail": "injected SSE outage"}, status_code=500)
    response = await call_next(request)
    if request.method == "GET" and request.url.path.endswith("/events") and current.get("inject_resync_once"):
        update(inject_resync_once=False)
        async def resync_after_start():
            async for chunk in response.body_iterator:
                yield chunk
                break
            yield 'id: 999\ndata: {"type":"resync_required","seq":999}\n\n'
        return StreamingResponse(resync_after_start(), status_code=response.status_code,
                                 headers=dict(response.headers), media_type="text/event-stream")
    return response

auth.ACCESS_TOKENS_PATH = Path(os.environ["TOKEN_FILE"])
uvicorn.run(app_module.app, host="127.0.0.1", port=PORT, log_level="warning")
'''.replace("PORT", str(port)), encoding="utf-8")
    launcher = tmp_path / "launch.py"
    launcher.write_text("import bootstrap\n", encoding="utf-8")
    from backend import auth
    auth.save_tokens([{"owner": "cli", "hash": auth.token_hash("secret"), "prefix": "dqa_test",
                       "created": "2026-01-01T00:00:00Z", "revoked": None}], token_file)
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join((str(tmp_path), str(ROOT))),
        "DQA_RUN_STATE_DIR": str(tmp_path / "run-state"),
        "DQA_RUN_MAX_FILES_PER_CHUNK": "2",
        "DQA_RUN_HEARTBEAT_S": "0.1",
        "DQA_AUTH_REQUIRED": "1",
        "CONTROL": str(control), "REQUESTS": str(requests), "CALLS": str(calls),
        "TOKEN_FILE": str(token_file),
    }
    log = (tmp_path / "server.log").open("w")
    process = subprocess.Popen([sys.executable, str(launcher)], cwd=ROOT, env=env,
                               stdout=log, stderr=subprocess.STDOUT)
    url = f"http://127.0.0.1:{port}"
    try:
        for _ in range(150):
            if process.poll() is not None:
                raise AssertionError((tmp_path / "server.log").read_text(encoding="utf-8"))
            try:
                if httpx.get(url + "/api/version", timeout=0.1).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.05)
        else:
            raise AssertionError("isolated uvicorn did not start")
        yield {"url": url, "control": control, "requests": requests, "calls": calls,
               "process": process, "tmp": tmp_path}
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        log.close()


def test_real_single_batch_ndjson_json_threads_and_overrides(dqa, pack_file, run_server, tmp_path):
    materials = []
    for name in ("b.txt", "a.txt", "c.txt"):
        path = tmp_path / name
        path.write_text(name)
        materials.append(str(path))
    streamed = dqa(*cli_args(pack_file, run_server, *materials, "--models", "beta",
                             "--threads", "2", "--format", "ndjson", "--quiet"))
    assert streamed.returncode == 0, streamed.stderr.decode()
    events = ndjson(streamed)
    assert events[0]["type"] == "run_start" and events[0]["threads_effective"] == 2
    assert events[0]["models"] == ["beta"] and events[0]["models_overridden"] is True
    assert events[0]["effective_config"]["fingerprint"] != json.loads(pack_file.read_text(encoding="utf-8"))["fingerprint"]
    files = [event for event in events if event["type"] == "file"]
    assert len(files) == 3 and len({event["i"] for event in files}) == 3
    assert all(event["answers"]["q1"]["by_model"]["beta"]["yes"] == 0.9 for event in files)
    assert events[-1]["type"] == "run_end" and events[-1]["summary"]["files_ok"] == 3
    assert not streamed.stderr
    paths = [record["path"] for record in records(run_server["requests"])]
    assert sum(path.endswith("/files") for path in paths) == 2
    assert {record["model"] for record in records(run_server["calls"])} == {"beta"}

    result = dqa(*cli_args(pack_file, run_server, *materials, "--threads", "2", "--quiet"))
    assert result.returncode == 0, result.stderr.decode()
    report = json.loads(result.stdout)
    assert [item["i"] for item in report["files"]] == [0, 1, 2]
    assert report["threads_effective"] == 2 and report["models"] == ["alpha"]
    assert report["config"]["models_pack"] == ["alpha"]
    assert report["execution"]["prompt_formats"]["alpha"] == 3
    assert report["files"][0]["runs"][0]["model"] == "alpha"
    assert report["files"][0]["by_model"]["alpha"]["decision"]["outcomeId"] == "ok"
    assert report["files"][0]["decision"] == {"outcome": "ok", "label": "Подходит", "rule": None, "is_default": True}


def test_auth_idempotent_retries_and_sse_reconnect(dqa, pack_file, run_server, tmp_path):
    material = tmp_path / "a.txt"
    material.write_text("a")
    denied = dqa(*cli_args(pack_file, run_server, str(material)), token=None)
    assert denied.returncode == 77 and not denied.stdout
    set_control(run_server, fail_create_once=True, fail_chunk_once=True, inject_resync_once=True, start_429_once=True)
    result = dqa(*cli_args(pack_file, run_server, str(material), "--format", "ndjson",
                           "--retry", "2", "--verbose"))
    assert result.returncode == 0, result.stderr.decode()
    events = ndjson(result)
    assert [event["type"] for event in events].count("run_start") == 1
    assert len([event for event in events if event["type"] == "file"]) == 1
    requests = records(run_server["requests"])
    assert sum(item["path"] == "/api/run" for item in requests) == 2
    assert sum(item["path"].endswith("/files") for item in requests) == 2
    assert sum(item["path"].endswith("/start") for item in requests) == 2
    assert sum(item["path"].endswith("/events") for item in requests) >= 2
    assert len(records(run_server["calls"])) == 1
    assert "reconnect after=1" in result.stderr.decode()


def test_timeout_cancel_with_partial_json(dqa, pack_file, run_server, tmp_path):
    material = tmp_path / "slow.txt"
    material.write_text("slow")
    set_control(run_server, prepare_delay=2)
    preparation_started = time.monotonic()
    preparation = dqa(*cli_args(pack_file, run_server, str(material), "--timeout", "0.1", "--quiet"))
    assert time.monotonic() - preparation_started < 3
    assert preparation.returncode == 75 and not preparation.stdout
    set_control(run_server, prepare_delay=0)
    set_control(run_server, delay=2, cancel_429=True)
    partial_report = tmp_path / "partial-report.json"
    started = time.monotonic()
    timed = dqa(*cli_args(pack_file, run_server, str(material), "--timeout", "0.2",
                          "--report", str(partial_report), "--quiet"))
    assert time.monotonic() - started < 8
    assert timed.returncode == 75, timed.stderr.decode()
    report = json.loads(timed.stdout)
    assert report["status"] in {"queued", "running", "cancelled", "completed_partial", "cancel_requested"}
    assert isinstance(report["files"], list)
    audit = json.loads(partial_report.read_text(encoding="utf-8"))
    assert audit["summary"]["files_returned"] == len(audit["files"])
    assert audit["summary"]["files_pending"] == audit["summary"]["files_total"] - audit["summary"]["files_completed"]
    if report.get("run_id"):
        assert any(item["path"].endswith("/cancel") for item in records(run_server["requests"]))
    else:
        assert not any(item["path"].endswith("/cancel") for item in records(run_server["requests"]))


@pytest.mark.skipif(os.name == "nt", reason="GitHub headless console does not reliably deliver CTRL_BREAK")
def test_console_cancel_with_partial_json(dqa, pack_file, run_server, tmp_path):
    material = tmp_path / "slow.txt"
    material.write_text("slow")
    second = tmp_path / "second.txt"
    second.write_text("second")
    set_control(run_server, delay=2, cancel_429=False, page_delay=6)
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join((str(ROOT / "cli"), str(ROOT)))
    env["DQA_CONFIG_DIR"] = str(run_server["tmp"] / "client-config")
    env["DQA_TOKEN"] = "secret"
    process = subprocess.Popen([sys.executable, "-m", "dqa", *cli_args(
        pack_file, run_server, str(material), str(second), "--threads", "1", "--quiet")],
                               cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0)
    previous_calls = len(records(run_server["calls"]))
    for _ in range(150):
        if len(records(run_server["calls"])) >= previous_calls + 2:
            break
        time.sleep(0.05)
    else:
        process.kill()
        raise AssertionError("second model did not start")
    process.send_signal(signal.SIGBREAK if os.name == "nt" else signal.SIGINT)
    interrupted_started = time.monotonic()
    stdout, stderr = process.communicate(timeout=20)
    assert time.monotonic() - interrupted_started >= 5
    assert process.returncode == 130, stderr.decode()
    assert stdout, f"expected partial JSON; exit={process.returncode}; stderr={stderr.decode()}"
    interrupted = json.loads(stdout)
    assert len(interrupted["files"]) == 1
    assert interrupted["summary"] == {
        "files_total": 2, "files_returned": 1, "files_completed": 1,
        "files_ok": 1, "files_failed": 0, "files_skipped": 0,
        "files_pending": 1, "files_filtered_out": 0, "files_truncated": 1,
        "decisions": {"ok": 1},
    }


def test_runner_console_break_handler_registration(pack_file, tmp_path):
    from types import SimpleNamespace

    from dqa.client import Client
    from dqa.inputs import build_plan
    from dqa.pack import load
    from dqa.runner import Runner
    from test_inputs import args, capabilities

    source = tmp_path / "a.txt"
    source.write_text("a")
    plan = build_plan(args(materials=[str(source)]), capabilities())
    runner = Runner(plan=plan, pack=load(str(pack_file)), client=Client("http://unused"),
                    capabilities=capabilities(), args=SimpleNamespace(
                        timeout=0, deadline=None, retry=0, quiet=True,
                        format="json", verbose=False),
                    reused=[], pending=[], manifest=None, server_version="test")
    runner.run_id = "run_test"
    sig = getattr(signal, "SIGBREAK", signal.SIGINT)
    runner._install_signals()
    try:
        handler = signal.getsignal(sig)
        assert callable(handler)
        handler(sig, None)
    finally:
        runner._restore_signals()
    assert runner.control_code == 130


def test_control_before_create_returns_partial_json(pack_file, tmp_path, monkeypatch):
    import io
    from types import SimpleNamespace

    from dqa.client import Client
    from dqa.inputs import build_plan
    from dqa.pack import load
    from dqa.runner import Runner, RunTransport, _Control
    from test_inputs import args, capabilities

    source = tmp_path / "a.txt"
    source.write_text("a")
    plan = build_plan(args(materials=[str(source)]), capabilities())

    def interrupt_create(self, body, idempotency_key):
        raise _Control(75)

    def unexpected_cancel(self, run_id):
        pytest.fail("cancel must not be called without a run ID")

    monkeypatch.setattr(RunTransport, "create", interrupt_create)
    monkeypatch.setattr(RunTransport, "cancel", unexpected_cancel)
    runner = Runner(plan=plan, pack=load(str(pack_file)), client=Client("http://unused"),
                    capabilities=capabilities(), args=SimpleNamespace(
                        timeout=0, deadline=None, retry=0, quiet=True, format="json",
                        verbose=False, models=None, mode=None, threads=None, fail_on="error"),
                    reused=[], pending=plan.materials, manifest=None, server_version="test")
    outcome = runner.run()
    stdout = io.StringIO()
    monkeypatch.setattr(sys, "stdout", stdout)
    outcome.write_json()
    outcome.close()

    report = json.loads(stdout.getvalue())
    assert outcome.exit_code == 75
    assert report["run_id"] is None
    assert report["status"] == "cancel_requested"
    assert report["files"] == []
    assert report["summary"] == {
        "files_total": 1, "files_returned": 0, "files_completed": 0,
        "files_ok": 0, "files_failed": 0, "files_skipped": 0,
        "files_pending": 1, "files_filtered_out": 0, "files_truncated": 1,
        "decisions": {},
    }


def write_rule_pack(pack_file, tmp_path):
    value = json.loads(pack_file.read_text(encoding="utf-8"))
    value["decision"]["outcomes"][0]["rules"] = [{
        "anyOf": False,
        "conditions": [{"question": "q1", "answer": "yes", "op": "gte", "threshold": 0.5}],
    }]
    path = tmp_path / "rule-pack.json"
    path.write_text(json.dumps(finalize_pack(value, require_decision=True)), encoding="utf-8")
    return path


def test_decision_rule_partial_errors_and_fail_on(dqa, pack_file, run_server, tmp_path):
    material = tmp_path / "a.txt"
    material.write_text("a")
    pack = write_rule_pack(pack_file, tmp_path)
    set_control(run_server, partial=True)
    partial = dqa(*cli_args(pack, run_server, str(material), "--models", "alpha,beta", "--quiet"))
    assert partial.returncode == 10, partial.stderr.decode()
    report = json.loads(partial.stdout)
    item = report["files"][0]
    assert item["status"] == "ok" and item["errors"][0]["model"] == "beta"
    assert item["decision"] == {"outcome": "reject", "label": "Отклонить",
                                "rule": "q1.yes>=0.5", "is_default": False}
    failed = dqa(*cli_args(pack, run_server, str(material), "--models", "beta", "--quiet"))
    assert failed.returncode == 10 and json.loads(failed.stdout)["files"][0]["status"] == "error"
    degraded = dqa(*cli_args(pack, run_server, str(material), "--models", "alpha,beta",
                             "--fail-on", "none", "--quiet"))
    assert degraded.returncode == 2 and json.loads(degraded.stdout)["files"]
    manifest = tmp_path / "partial.ndjson"
    skipped = dqa(*cli_args(pack, run_server, str(material), "--models", "alpha,beta",
                            "--skip-processed", str(manifest), "--quiet"))
    assert skipped.returncode == 10
    assert not manifest.exists() or not manifest.read_text(encoding="utf-8")
    set_control(run_server, partial=False)
    for policy in ("reject", "any"):
        matched = dqa(*cli_args(pack, run_server, str(material), "--fail-on", policy, "--quiet"))
        assert matched.returncode == 10 and json.loads(matched.stdout)["files"][0]["decision"]["outcome"] == "reject"


def test_control_during_json_pagination_returns_valid_partial(pack_file, tmp_path, monkeypatch):
    import io
    import sys

    from dqa.client import Client
    from dqa.inputs import build_plan
    from dqa.pack import load
    from dqa.runner import RunOutcome, _Control
    from test_inputs import args, capabilities

    source = tmp_path / "a.txt"
    source.write_text("a")
    plan = build_plan(args(materials=[str(source)]), capabilities())
    pack = load(str(pack_file))

    class FailingTransport:
        def control(self):
            pass

        def page(self, run_id, offset, limit):
            raise _Control(75)

    outcome = RunOutcome(plan, pack, Client("http://unused"), {"max_page_limit": 200},
                         FailingTransport(), plan.materials, [], "error", True, "json", "test",
                         run_id="run_test", metadata={"status": "completed", "effective_config": pack.effective,
                         "summary": {"files_completed": 1, "files_ok": 1, "files_failed": 0}})
    stdout = io.StringIO()
    monkeypatch.setattr(sys, "stdout", stdout)
    outcome.write_json()
    report = json.loads(stdout.getvalue())
    assert report["files"] == [] and outcome.exit_code == 75
    assert report["summary"] == {
        "files_total": 1, "files_returned": 0, "files_completed": 0,
        "files_ok": 0, "files_failed": 0, "files_skipped": 0,
        "files_pending": 1, "files_filtered_out": 0, "files_truncated": 1, "decisions": {},
    }


def test_oversized_single_material_is_clear_validation_error(tmp_path):
    from dqa.client import DqaError
    from dqa.inputs import build_plan
    from dqa.runner import _chunks
    from test_inputs import args, capabilities

    source = tmp_path / "large.txt"
    source.write_text("x" * 100)
    plan = build_plan(args(materials=[str(source)]), capabilities())
    with pytest.raises(DqaError) as caught:
        list(_chunks(plan.materials, {"max_files_per_chunk": 50, "max_chunk_bytes": 64}))
    assert caught.value.code == 65 and "max_chunk_bytes=64" in caught.value.message


def test_skip_processed_reuse_cosmetics_models_and_lock(dqa, pack_file, run_server, tmp_path):
    source = tmp_path / "one.txt"
    source.write_text("same")
    manifest = tmp_path / "seen.ndjson"
    first = dqa(*cli_args(pack_file, run_server, str(source), "--skip-processed", str(manifest), "--quiet"))
    assert first.returncode == 0, first.stderr.decode()
    first_report = json.loads(first.stdout)
    entries = records(manifest)
    assert len(entries) == 1 and entries[0]["version"] == 1 and entries[0]["key"].startswith("sha256:")
    calls_before = len(records(run_server["calls"]))
    second = dqa(*cli_args(pack_file, run_server, str(source), "--skip-processed", str(manifest), "--quiet"))
    assert second.returncode == 0, second.stderr.decode()
    reused = json.loads(second.stdout)["files"][0]
    assert reused["status"] == "skipped" and reused["reason"] == "already_processed"
    assert reused["answers"] is None and reused["run_id"] == first_report["run_id"]
    assert len(records(run_server["calls"])) == calls_before and len(records(manifest)) == 1
    reused_stream = dqa(*cli_args(pack_file, run_server, str(source), "--skip-processed", str(manifest),
                                  "--format", "ndjson", "--quiet"))
    start = ndjson(reused_stream)[0]
    assert start["effective_config"]["fingerprint"] == json.loads(pack_file.read_text(encoding="utf-8"))["fingerprint"]

    renamed = tmp_path / "renamed.txt"
    renamed.write_text("same")
    cosmetic_value = json.loads(pack_file.read_text(encoding="utf-8"))
    cosmetic_value["decision"]["outcomes"][1]["label"] = "Новый label"
    cosmetic = tmp_path / "cosmetic.json"
    cosmetic.write_text(json.dumps(finalize_pack(cosmetic_value, require_decision=True)), encoding="utf-8")
    third = dqa(*cli_args(cosmetic, run_server, str(renamed), "--skip-processed", str(manifest), "--quiet"))
    reused = json.loads(third.stdout)["files"][0]
    assert reused["reason"] == "already_processed" and reused["path"] == str(renamed)
    assert reused["decision"]["label"] == "Новый label"
    assert len(records(manifest)) == 1

    changed_models = dqa(*cli_args(pack_file, run_server, str(source), "--models", "beta",
                                   "--skip-processed", str(manifest), "--quiet"))
    assert changed_models.returncode == 0 and len(records(manifest)) == 2

    with ProcessedManifest(str(manifest), json.loads(pack_file.read_text(encoding="utf-8"))["fingerprint"]):
        locked = dqa(*cli_args(pack_file, run_server, str(source), "--skip-processed", str(manifest), "--quiet"))
    assert locked.returncode == 70 and "занят" in locked.stderr.decode() and not locked.stdout
