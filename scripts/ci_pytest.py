from __future__ import annotations

import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def command_text(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def main() -> int:
    report = Path(".pytest-ci-results.xml")
    result = subprocess.run([sys.executable, "-m", "pytest", "-q", f"--junitxml={report}"]).returncode
    if result and report.exists():
        root = ET.parse(report).getroot()
        for case in root.iter("testcase"):
            failures = [*case.findall("failure"), *case.findall("error")]
            for failure in failures:
                name = f"{case.get('classname', '')}.{case.get('name', 'test')}"
                message = failure.get("message") or (failure.text or "failed").splitlines()[0]
                print(f"::error ::{command_text(name + ': ' + message)}", flush=True)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
