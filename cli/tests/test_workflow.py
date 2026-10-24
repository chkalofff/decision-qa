from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from test_run import records, run_server

SCRIPT = Path(__file__).resolve().parents[1] / "examples" / "workflow_consumer.py"


def test_workflow_failure_replay_unknown_outcome_and_partial_guard(pack_file, run_server, tmp_path):
    material = tmp_path / "a.txt"
    material.write_text("a")
    report = tmp_path / "report.json"
    ledger = tmp_path / "done.ndjson"
    processed = tmp_path / "processed.ndjson"
    actions = tmp_path / "actions.ndjson"
    env = {**os.environ, "DQA_TOKEN": "secret",
           "PYTHONPATH": os.pathsep.join((str(Path(__file__).resolve().parents[2] / "cli"),
                                          str(Path(__file__).resolve().parents[2])))}
    base = [sys.executable, str(SCRIPT), "--pack", str(pack_file), "--server", run_server["url"],
            "--report", str(report), "--ledger", str(ledger), "--processed", str(processed),
            "--fake-action", str(actions), "--dqa", f"{sys.executable} -m dqa", str(material)]
    mapping = ["--outcome", "ok=invite", "--outcome", "reject=block"]

    failed = subprocess.run([*base, *mapping, "--fail-after", "1"], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    assert failed.returncode == 65 and report.exists()
    assert len(records(actions)) == 1 and not ledger.read_text()
    calls = len(records(run_server["calls"]))

    replay = subprocess.run([*base, *mapping, "--consume-only"], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    assert replay.returncode == 0, replay.stderr.decode()
    assert len(records(actions)) == 1 and len(records(ledger)) == 1
    assert len(records(run_server["calls"])) == calls
    again = subprocess.run([*base, *mapping, "--consume-only"], env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    assert again.returncode == 0 and len(records(actions)) == 1 and len(records(ledger)) == 1

    unknown = subprocess.run([*base, "--outcome", "reject=block", "--consume-only"], env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    assert unknown.returncode == 65 and b"ALERT" in unknown.stderr
    assert len(records(actions)) == 1

    value = json.loads(report.read_text())
    ndjson_report = tmp_path / "report.ndjson"
    events = [
        {"schema": 1, "type": "run_start", "run_id": value["run_id"],
         "effective_config": json.loads(pack_file.read_text())},
        *({"type": "file", **record} for record in value["files"]),
        {"type": "run_end", "run_id": value["run_id"], "status": "completed",
         "summary": value["summary"]},
    ]
    ndjson_report.write_text("".join(json.dumps(event) + "\n" for event in events))
    dry_ledger = tmp_path / "dry-ledger.ndjson"
    dry_actions = tmp_path / "dry-actions.ndjson"
    ndjson_base = [*base, "--report", str(ndjson_report), "--ledger", str(dry_ledger),
                   "--fake-action", str(dry_actions)]
    dry = subprocess.run([*ndjson_base, *mapping, "--consume-only", "--dry-run"], env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    assert dry.returncode == 0, dry.stderr.decode()
    assert not dry_ledger.exists() and not dry_actions.exists()
    real = subprocess.run([*ndjson_base, *mapping, "--consume-only"], env=env,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    assert real.returncode == 0, real.stderr.decode()
    assert len(records(dry_actions)) == 1 and len(records(dry_ledger)) == 1

    unknown_report = tmp_path / "unknown.json"
    unknown_value = dict(value)
    unknown_value["files"] = [*value["files"], {**value["files"][0], "decision": {
        "outcome": "surprise", "label": "Surprise", "rule": None, "is_default": False}}]
    unknown_value["summary"] = {**value["summary"], "files_total": 2, "files_completed": 2}
    unknown_report.write_text(json.dumps(unknown_value))
    unknown_actions = tmp_path / "unknown-actions.ndjson"
    unknown_ledger = tmp_path / "unknown-ledger.ndjson"
    blocked = subprocess.run([*base, "--report", str(unknown_report), "--ledger", str(unknown_ledger),
                              "--fake-action", str(unknown_actions), "--outcome", "ok=invite", "--consume-only"],
                             env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    assert blocked.returncode == 65 and not unknown_actions.exists() and not unknown_ledger.exists()

    value = json.loads(report.read_text())
    value["status"] = "completed_partial"
    value["summary"]["files_pending"] = 1
    report.write_text(json.dumps(value))
    other_actions = tmp_path / "other-actions.ndjson"
    partial = subprocess.run([*base, "--fake-action", str(other_actions), *mapping, "--consume-only"],
                             env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    assert partial.returncode == 65 and not other_actions.exists()
