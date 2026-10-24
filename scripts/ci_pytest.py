from __future__ import annotations

import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

MAX_FALLBACK_CHARS = 4000
MAX_FALLBACK_LINES = 40


def command_text(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def main() -> int:
    report = Path(os.environ.get("PYTEST_CI_JUNIT", ".pytest-ci-results.xml"))
    output = Path(os.environ.get("PYTEST_CI_OUTPUT", "pytest-output.txt"))
    completed = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", *sys.argv[1:], f"--junitxml={report}"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace",
    )
    result = completed.returncode
    output.write_text(completed.stdout or "", encoding="utf-8")
    if completed.stdout:
        print(completed.stdout, end="", flush=True)
    if not result:
        return result

    annotated = 0
    if report.exists():
        try:
            root = ET.parse(report).getroot()
            for case in root.iter("testcase"):
                failures = [*case.findall("failure"), *case.findall("error")]
                for failure in failures:
                    name = f"{case.get('classname', '')}.{case.get('name', 'test')}"
                    message = failure.get("message") or (failure.text or "failed").splitlines()[0]
                    print(f"::error ::{command_text(name + ': ' + message)}", flush=True)
                    annotated += 1
        except ET.ParseError:
            pass
    if not annotated:
        lines = (completed.stdout or "pytest failed without captured output").splitlines()
        tail = "\n".join(lines[-MAX_FALLBACK_LINES:])[-MAX_FALLBACK_CHARS:]
        print(f"::error ::{command_text('pytest failed without parsed testcase failure; output tail:\n' + tail)}", flush=True)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
