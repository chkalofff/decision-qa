"""Bounded output writers, filters, human formats and atomic audit artifacts."""

from __future__ import annotations

import csv
import json
import os
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, TextIO, TYPE_CHECKING

from .client import DqaError

if TYPE_CHECKING:
    from .runner import RunOutcome

LARGE_REPORT_THRESHOLD = 10_000


def report_kind(files_total: int) -> str:
    return "ndjson" if files_total > LARGE_REPORT_THRESHOLD else "json"


def matches(record: dict[str, Any], outcome_filter: set[str] | None) -> bool:
    if not outcome_filter:
        return True
    decision = record.get("decision")
    return bool(decision and decision.get("outcome") in outcome_filter)


def write_json(outcome: "RunOutcome", stream: TextIO, outcome_filter: set[str] | None = None) -> None:
    from .runner import _Control

    fields = outcome.report_fields()
    fields.pop("summary", None)
    stream.write(json.dumps(fields, ensure_ascii=False, allow_nan=False)[:-1] + ',"files":[')
    first = True
    returned = 0
    completed = 0
    decisions: dict[str, int] = {}
    statuses = {"ok": 0, "error": 0, "skipped": 0}
    try:
        for record in outcome.iter_files():
            completed += 1
            if not matches(record, outcome_filter):
                continue
            if not first:
                stream.write(",")
            first = False
            stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
            returned += 1
            status = record.get("status")
            if status in statuses:
                statuses[status] += 1
            decision = record.get("decision")
            if decision:
                outcome_id = decision["outcome"]
                decisions[outcome_id] = decisions.get(outcome_id, 0) + 1
    except _Control as control:
        outcome.interrupted = control.code
    total = len(outcome.plan.records)
    summary = {
        "files_total": total,
        "files_returned": returned,
        "files_completed": completed,
        "files_ok": statuses["ok"],
        "files_failed": statuses["error"],
        "files_skipped": statuses["skipped"],
        "files_pending": total - completed,
        "files_filtered_out": completed - returned,
        "files_truncated": total - completed,
        "decisions": decisions,
    }
    stream.write('],"summary":' + json.dumps(summary, ensure_ascii=False, allow_nan=False) + "}\n")
    stream.flush()


class OutputCounters:
    def __init__(self, outcome_filter: set[str] | None = None):
        self.outcome_filter = outcome_filter
        self.seen = 0
        self.returned = 0
        self.filtered_out = 0
        self.statuses = {"ok": 0, "error": 0, "skipped": 0}
        self.decisions: dict[str, int] = {}

    def add(self, record: dict[str, Any]) -> bool:
        self.seen += 1
        if not matches(record, self.outcome_filter):
            self.filtered_out += 1
            return False
        self.returned += 1
        status = record.get("status")
        if status in self.statuses:
            self.statuses[status] += 1
        decision = record.get("decision")
        if decision:
            outcome = decision["outcome"]
            self.decisions[outcome] = self.decisions.get(outcome, 0) + 1
        return True

    def summary(self, total: int) -> dict[str, Any]:
        return {
            "files_total": total, "files_returned": self.returned,
            "files_completed": self.seen, "files_ok": self.statuses["ok"],
            "files_failed": self.statuses["error"], "files_skipped": self.statuses["skipped"],
            "files_pending": total - self.seen, "files_filtered_out": self.filtered_out,
            "files_truncated": total - self.seen, "decisions": self.decisions,
        }


class NDJSONWriter:
    def __init__(self, stream: TextIO, outcome_filter: set[str] | None = None):
        self.stream = stream
        self.counters = OutputCounters(outcome_filter)

    def __call__(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "file" and not self.counters.add(event):
            return
        if kind == "run_end":
            summary = event.get("summary") or {}
            total = summary.get("files_total", self.counters.seen)
            event = {**event, "summary": self.counters.summary(total)}
        self.stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        self.stream.flush()


class PartialJSONWriter:
    def __init__(self, stream: TextIO, pack: Any, files_total: int):
        self.stream = stream
        self.pack = pack
        self.files_total = files_total
        self.counters = OutputCounters()
        self.started = False
        self.closed = False
        self.status = "failed"
        self.run_id = None
        self.effective = pack.effective

    def __call__(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "run_start":
            self.effective = event.get("effective_config") or self.pack.effective
            self.run_id = event.get("run_id")
            self.status = "running"
            self._start()
        elif kind == "file":
            self._start()
            self.counters.add(event)
            if self.counters.returned > 1:
                self.stream.write(",")
            self.stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
            self.stream.flush()
        elif kind == "run_end":
            self.status = event.get("status") or self.status
            self.run_id = event.get("run_id", self.run_id)

    def _start(self) -> None:
        if self.started:
            return
        self.started = True
        pack = self.pack.original
        config = {
            "path": self.pack.path, "version": pack["version"],
            "fingerprint_version": pack["fingerprint_version"],
            "hash": pack["hash"], "fingerprint": pack["fingerprint"],
            "effective_hash": self.effective["hash"],
            "effective_fingerprint": self.effective["fingerprint"],
            "models_overridden": self.pack.models_overridden,
            "mode_overridden": self.pack.mode_overridden,
            "models_pack": pack["settings"]["models"],
        }
        root = {
            "schema": 1, "run_id": self.run_id, "config": config,
            "mode": self.effective["settings"]["mode"],
            "models": self.effective["settings"]["models"],
            "aggregation": self.effective["settings"]["aggregation"],
        }
        self.stream.write(json.dumps(root, ensure_ascii=False, allow_nan=False)[:-1] + ',"files":[')

    def close(self) -> None:
        if self.closed:
            return
        self._start()
        summary = self.counters.summary(self.files_total)
        self.stream.write('],"status":' + json.dumps(self.status) + ',"summary":' +
                          json.dumps(summary, ensure_ascii=False, allow_nan=False) + "}\n")
        self.stream.flush()
        self.stream.close()
        self.closed = True


class FanoutWriter:
    def __init__(self, *writers: Callable[[dict[str, Any]], None]):
        self.writers = writers

    def __call__(self, event: dict[str, Any]) -> None:
        for writer in self.writers:
            writer(event)


def write_csv(outcome: "RunOutcome", stream: TextIO, outcome_filter: set[str] | None = None) -> None:
    from .runner import _Control

    stream.write("\ufeff")
    writer = csv.writer(stream, lineterminator="\n")
    questions = outcome.pack.original["questions"]
    writer.writerow(["path", "status", "outcome", "label", "confidence",
                     *(question["id"] for question in questions), "errors"])
    try:
        for record in outcome.iter_files():
            if not matches(record, outcome_filter):
                continue
            decision = record.get("decision") or {}
            answers = record.get("answers") or {}
            writer.writerow([
                record.get("path") or record.get("name") or "",
                record.get("status", ""), decision.get("outcome", ""),
                decision.get("label", ""), confidence(record, outcome.pack.original),
                *(short_answer(answers.get(question["id"])) for question in questions),
                json.dumps(record.get("errors") or [], ensure_ascii=False, separators=(",", ":"), allow_nan=False),
            ])
    except _Control as control:
        outcome.interrupted = control.code
    stream.flush()


def write_table(outcome: "RunOutcome", stream: TextIO, outcome_filter: set[str] | None = None,
                *, color: bool = False) -> None:
    from .runner import _Control

    stream.write("FILE | OUTCOME | CONFIDENCE | DURATION\n")
    try:
        for record in outcome.iter_files():
            if not matches(record, outcome_filter):
                continue
            decision = record.get("decision") or {}
            label = decision.get("label", "")
            if color and decision:
                rgb = _outcome_rgb(decision, outcome.pack.original)
                if rgb:
                    label = f"\x1b[38;2;{rgb[0]};{rgb[1]};{rgb[2]}m{label}\x1b[0m"
            duration = record.get("duration_s")
            stream.write(" | ".join((
                str(record.get("path") or record.get("name") or ""),
                label, confidence(record, outcome.pack.original),
                "" if duration is None else f"{duration:.3f}s",
            )) + "\n")
    except _Control as control:
        outcome.interrupted = control.code
    stream.flush()


def _outcome_rgb(decision: dict[str, Any], pack: dict[str, Any]) -> tuple[int, int, int] | None:
    outcome = next((item for item in pack["decision"]["outcomes"]
                    if item["id"] == decision.get("outcome")), None)
    value = (outcome or {}).get("color", "")
    if not isinstance(value, str) or len(value) != 7 or not value.startswith("#"):
        return None
    try:
        return tuple(int(value[index:index + 2], 16) for index in (1, 3, 5))
    except ValueError:
        return None


def confidence(record: dict[str, Any], pack: dict[str, Any]) -> str:
    decision = record.get("decision")
    if not decision or decision.get("is_default") or not decision.get("rule"):
        return ""
    outcome = next((item for item in pack["decision"]["outcomes"]
                    if item["id"] == decision.get("outcome")), None)
    if outcome is None:
        return ""
    from .runner import format_rule
    matched = [rule for rule in outcome.get("rules", []) if format_rule(rule) == decision["rule"]]
    if len(matched) != 1 or len(matched[0].get("conditions") or []) != 1:
        return ""
    condition = matched[0]["conditions"][0]
    if condition.get("answer") is None:
        return ""
    answer = (record.get("answers") or {}).get(condition["question"]) or {}
    value = (answer.get("probabilities") or {}).get(condition["answer"])
    return f"{value:.1%}" if isinstance(value, (int, float)) and not isinstance(value, bool) else ""


def short_answer(answer: Any) -> str:
    if not isinstance(answer, dict):
        return ""
    if isinstance(answer.get("score"), (int, float)) and not isinstance(answer.get("score"), bool):
        return f"{answer['score']:.2f}"
    value = answer.get("answer", answer.get("choice"))
    if value is None:
        return ""
    confidence_value = answer.get("confidence")
    suffix = f" ({confidence_value:.1%})" if isinstance(confidence_value, (int, float)) and not isinstance(confidence_value, bool) else ""
    return f"{value}{suffix}"


@contextmanager
def atomic_text(path: str) -> Iterator[TextIO]:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=target.name + ".", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            yield stream
        os.replace(temporary, target)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


class ReportArtifact:
    def __init__(self, path: str, files_total: int, pack: Any):
        self.path = Path(path)
        self.kind = report_kind(files_total)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.partial = self.path.with_name(self.path.name + ".partial")
        self.stream: TextIO | None = self.partial.open("w", encoding="utf-8", newline="")
        if self.kind == "ndjson":
            self.event_writer = NDJSONWriter(self.stream)
        else:
            self.event_writer = PartialJSONWriter(self.stream, pack, files_total)

    def finish(self, outcome: "RunOutcome") -> None:
        assert self.stream is not None
        if self.kind == "json":
            self.event_writer.close()
            self.stream = None
            with atomic_text(str(self.path)) as stream:
                write_json(outcome, stream)
            self.partial.unlink(missing_ok=True)
            return
        self.stream.close()
        self.stream = None
        os.replace(self.partial, self.path)

    def abort(self) -> None:
        if self.stream is not None:
            if self.kind == "json":
                self.event_writer.close()
            else:
                self.stream.close()
            self.stream = None


def write_selected(outcome: "RunOutcome", stream: TextIO, output_format: str,
                   outcome_filter: set[str] | None = None, *, color: bool = False) -> None:
    if output_format == "json":
        write_json(outcome, stream, outcome_filter)
    elif output_format == "csv":
        write_csv(outcome, stream, outcome_filter)
    elif output_format == "table":
        write_table(outcome, stream, outcome_filter, color=color)
    else:
        raise DqaError(70, f"Неподдерживаемый paged output format: {output_format}")


def supports_ansi(stream: TextIO) -> bool:
    return bool(getattr(stream, "isatty", lambda: False)()) and os.environ.get("TERM", "") != "dumb" and "NO_COLOR" not in os.environ
