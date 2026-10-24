from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from dqa_common import AGGREGATION_POLICY
from dqa_common.config_pack import finalize_pack

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "cli"))


@pytest.fixture
def pack_file(tmp_path):
    pack = finalize_pack({
        "version": 1,
        "fingerprint_version": 1,
        "name": "CLI test",
        "questions": [{"id": "q1", "type": "yes_no", "question": "Подходит?", "yes": "да", "no": "нет"}],
        "decision": {"enabled": True, "outcomes": [
            {"id": "reject", "label": "Отклонить", "isDefault": False, "rules": []},
            {"id": "ok", "label": "Подходит", "isDefault": True, "rules": []},
        ]},
        "settings": {"mode": "decisions", "models": ["alpha"], "aggregation": AGGREGATION_POLICY},
    }, require_decision=True)
    path = tmp_path / "pack.json"
    path.write_text(json.dumps(pack, ensure_ascii=False), encoding="utf-8")
    return path


@pytest.fixture
def http_server():
    state = {
        "token": "secret",
        "requests": [],
        "capabilities_status": 200,
        "capabilities": {
            "schema": 1, "min_schema": 1, "max_schema": 1,
            "pack_version": 1, "fingerprint_version": 1,
            "aggregation": AGGREGATION_POLICY,
            "default_threads": 2, "max_threads": 8,
            "max_files_per_chunk": 50, "max_files_per_job": 100000,
            "max_images": 8, "max_images_b64_chars": 20 * 1024 * 1024,
            "modes": ["decisions", "fast_batch", "both"],
            "features": {"after_seq": True, "cancel": True, "gzip": True},
            "auth_required": True,
            "models": [
                {"key": "alpha", "label": "Alpha", "status": "running", "vision": True},
                {"key": "beta", "label": "Beta", "status": "running", "vision": True},
                {"key": "stopped", "label": "Stopped", "status": "stopped", "vision": True},
            ],
        },
    }

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state["requests"].append({"path": self.path, "authorization": self.headers.get("Authorization")})
            if self.headers.get("Authorization") != f"Bearer {state['token']}":
                self._reply(401, {"detail": "token required"})
            elif self.path == "/api/version":
                self._reply(200, {"version": "1.3-test"})
            elif self.path == "/api/run/capabilities":
                self._reply(state["capabilities_status"], copy.deepcopy(state["capabilities"]))
            else:
                self._reply(404, {"detail": "not found"})

        def _reply(self, status, value):
            payload = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state["url"] = f"http://127.0.0.1:{server.server_port}"
    yield state
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


@pytest.fixture
def dqa(tmp_path):
    def invoke(*args, input_bytes=b"", token="secret", env_extra=None, shim=False):
        env = os.environ.copy()
        for key in ("DQA_SERVER", "DQA_PROFILE", "DQA_TOKEN", "DQA_CONFIG_DIR"):
            env.pop(key, None)
        env["PYTHONPATH"] = os.pathsep.join((str(ROOT / "cli"), str(ROOT)))
        env["DQA_CONFIG_DIR"] = str(tmp_path / "config")
        if token is not None:
            env["DQA_TOKEN"] = token
        if env_extra:
            env.update(env_extra)
        command = [str(ROOT / "cli" / "bin" / ("dqa.cmd" if os.name == "nt" else "dqa"))] if shim else [sys.executable, "-m", "dqa"]
        return subprocess.run(command + list(args), input=input_bytes, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, env=env, cwd=ROOT, timeout=20)
    return invoke


@pytest.fixture
def validate(dqa, pack_file, http_server):
    def invoke(*args, **kwargs):
        return dqa("validate", "--config", str(pack_file), "--server", http_server["url"], *args, **kwargs)
    return invoke
