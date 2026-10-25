from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    completed = subprocess.run(
        [os.environ.get("NODE", "node"), "frontend/tests/run.mjs"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace",
    )
    output = completed.stdout or ""
    Path("frontend-output.txt").write_text(output, encoding="utf-8")
    print(output, end="", flush=True)
    if completed.returncode:
        for line in output.splitlines():
            if line.startswith(("not ok", "FAIL ")):
                escaped = line.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
                print(f"::error::{escaped}", flush=True)
        tail = "\n".join(output.splitlines()[-40:])[-4000:]
        escaped = tail.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::error::Frontend tests failed; output tail: {escaped}", flush=True)
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
