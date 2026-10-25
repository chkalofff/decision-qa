#!/usr/bin/env python3
"""Deterministic validate → run → consume example with replay-safe fake actions."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from contextlib import contextmanager, nullcontext
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dqa.analysis import load_report
from dqa.client import DqaError


@contextmanager
def locked(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    stream = path.open("a+b")
    try:
        if os.name == "posix":
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        else:
            import msvcrt
            for _ in range(50):
                try:
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError(f"Ledger is locked: {path}")
        yield stream
    finally:
        if os.name == "posix":
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()


def parse_map(values: list[str]) -> dict[str, str]:
    result = {}
    for value in values:
        outcome, separator, action = value.partition("=")
        if not separator or not outcome or not action:
            raise RuntimeError("--outcome expects ID=ACTION")
        result[outcome] = action
    return result


def fake_action(log: Path, key: str, path: str, action: str) -> None:
    existing = set()
    if log.exists():
        existing = {json.loads(line)["key"] for line in log.read_text(encoding="utf-8").splitlines() if line}
    if key in existing:
        return
    with log.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"key": key, "path": path, "action": action}, ensure_ascii=False) + "\n")


def _done_keys(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return {json.loads(line)["key"] for line in path.read_text(encoding="utf-8").splitlines() if line}


def consume(args: argparse.Namespace) -> int:
    if not args.consume_only:
        base = [*shlex.split(args.dqa)]
        common = ["--server", args.server, *args.inputs]
        validated = subprocess.run([*base, "validate", "--config", args.pack, *common]).returncode
        if validated != 0:
            return validated
        run = [*base, "run", "--config", args.pack, "--report", args.report,
               "--format", "json", "--fail-on", "none", *common]
        if args.processed:
            run.extend(["--skip-processed", args.processed])
        code = subprocess.run(run).returncode
        if code >= 64:
            return code
    report = load_report(args.report)
    if not report.complete:
        raise RuntimeError("Refusing actions: report is partial or filtered")
    fingerprint = report.metadata["config"]["effective_fingerprint"]
    outcome_map = parse_map(args.outcome)
    required_outcomes = {record["decision"]["outcome"] for record in report.iter_files()
                         if record.get("decision")}
    missing = sorted(required_outcomes - set(outcome_map))
    if missing:
        raise RuntimeError(f"ALERT: no action mapping for outcome {missing[0]}")
    ledger_path = Path(args.ledger)
    if args.dry_run:
        done = _done_keys(ledger_path)
        ledger_context = nullcontext(None)
    else:
        done = set()
        ledger_context = locked(ledger_path)
    with ledger_context as ledger:
        if ledger is not None:
            ledger.seek(0)
            for raw in ledger:
                if raw.strip():
                    done.add(json.loads(raw)["key"])
        performed = 0
        for record in report.iter_files():
            decision = record.get("decision")
            if not decision:
                continue
            outcome = decision["outcome"]
            key = f"dqa:{fingerprint}:{record['content_sha256']}"
            if key in done:
                continue
            path = record.get("path") or record.get("name") or ""
            action = outcome_map[outcome]
            if args.dry_run:
                print(json.dumps({"key": key, "path": path, "action": action}, ensure_ascii=False))
                continue
            fake_action(Path(args.fake_action), key, path, action)
            performed += 1
            if args.fail_after and performed >= args.fail_after:
                raise RuntimeError("simulated consumer failure")
            ledger.write(json.dumps({"version": 1, "key": key, "outcome": outcome,
                                     "run_id": report.metadata.get("run_id")}, ensure_ascii=False).encode() + b"\n")
            ledger.flush()
            done.add(key)
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--pack")
    result.add_argument("--server", default="http://localhost:8000")
    result.add_argument("--report", required=True)
    result.add_argument("--processed")
    result.add_argument("--ledger", required=True)
    result.add_argument("--outcome", action="append", default=[], metavar="ID=ACTION")
    result.add_argument("--fake-action", help="Idempotent action log for local testing")
    result.add_argument("--dry-run", action="store_true")
    result.add_argument("--fail-after", type=int, default=0)
    result.add_argument("--consume-only", action="store_true")
    result.add_argument("--dqa", default="dqa")
    result.add_argument("inputs", nargs="*")
    return result


def main() -> int:
    args = parser().parse_args()
    if not args.consume_only and not args.pack:
        parser().error("--pack is required unless --consume-only is used")
    if not args.dry_run and not args.fake_action:
        parser().error("this example requires --fake-action LOG or --dry-run")
    try:
        return consume(args)
    except (DqaError, RuntimeError, OSError, json.JSONDecodeError) as exc:
        print(f"consumer: {exc}", file=sys.stderr)
        return exc.code if isinstance(exc, DqaError) else 65


if __name__ == "__main__":
    raise SystemExit(main())
