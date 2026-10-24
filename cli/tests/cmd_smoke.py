"""Real dqa.cmd version smoke against an isolated backend (CI Windows only)."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx


def main() -> None:
    if os.name != "nt":
        raise SystemExit("cmd_smoke.py is intended for Windows CI")
    root = Path(__file__).resolve().parents[2]
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    code = (
        "from backend import app as app_module, model_manager as mm; "
        "mm.REGISTRY.clear(); "
        "import uvicorn; "
        f"uvicorn.run(app_module.app, host='127.0.0.1', port={port}, log_level='warning')"
    )
    with tempfile.TemporaryDirectory() as temporary:
        env = {**os.environ, "PYTHONPATH": str(root), "DQA_RUN_STATE_DIR": temporary}
        log_path = Path(temporary) / "server.log"
        with log_path.open("w") as log:
            server = subprocess.Popen([sys.executable, "-c", code], cwd=root, env=env,
                                      stdout=log, stderr=subprocess.STDOUT)
            try:
                url = f"http://127.0.0.1:{port}"
                for _ in range(150):
                    if server.poll() is not None:
                        raise RuntimeError(log_path.read_text())
                    try:
                        if httpx.get(url + "/api/version", timeout=0.1).status_code == 200:
                            break
                    except httpx.HTTPError:
                        time.sleep(0.05)
                else:
                    raise RuntimeError("isolated backend did not start")
                result = subprocess.run([str(root / "cli" / "bin" / "dqa.cmd"), "version", "--server", url],
                                        cwd=root, env=env, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, timeout=30)
                if result.returncode != 0:
                    raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))
                payload = json.loads(result.stdout)
                assert payload["schema"] == 1 and payload["compatible"] is True
                print(json.dumps(payload, ensure_ascii=False))
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


if __name__ == "__main__":
    main()
