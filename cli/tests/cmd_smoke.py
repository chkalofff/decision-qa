"""Real dqa.cmd version smoke against an isolated backend (CI Windows only)."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

import httpx


def _main(diagnostics: list[str]) -> None:
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
        env = {**os.environ, "PYTHONPATH": str(root),
               "DQA_RUN_STATE_DIR": str(Path(temporary) / "run-state")}
        log_path = Path(temporary) / "server.log"
        with log_path.open("w") as log:
            server = subprocess.Popen([sys.executable, "-c", code], cwd=root, env=env,
                                      stdout=log, stderr=subprocess.STDOUT)
            try:
                url = f"http://127.0.0.1:{port}"
                diagnostics.append(f"server={url}; script={root / 'cli' / 'bin' / 'dqa.cmd'}")
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
                diagnostics.extend((f"exit={result.returncode}", result.stdout.decode("utf-8", errors="replace"),
                                    result.stderr.decode("utf-8", errors="replace")))
                if result.returncode != 0:
                    raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))
                payload = json.loads(result.stdout)
                assert payload["schema"] == 1 and payload["compatible"] is True
                print(json.dumps(payload, ensure_ascii=False))
            finally:
                diagnostics.append(log_path.read_text(errors="replace"))
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    diagnostics: list[str] = []
    try:
        _main(diagnostics)
    except BaseException:
        diagnostics.append(traceback.format_exc())
        message = "\n".join(diagnostics)[-4000:]
        Path("dqa-cmd-smoke.log").write_text(message, encoding="utf-8")
        escaped = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::error::Windows dqa.cmd smoke failed: {escaped}", flush=True)
        raise


if __name__ == "__main__":
    main()
