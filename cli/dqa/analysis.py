"""Local explain and diff over complete JSON/NDJSON CLI reports."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, TextIO

from .client import DqaError

PROBABILITY_DELTA = 0.1
SCORE_DELTA = 0.5


@dataclass
class Report:
    path: Path
    metadata: dict[str, Any]
    summary: dict[str, Any]
    complete: bool
    format: str
    json_files: list[dict[str, Any]] | None = None

    def iter_files(self) -> Iterator[dict[str, Any]]:
        if self.format == "json":
            yield from self.json_files or []
            return
        for event in _ndjson_events(self.path):
            if event.get("type") == "file":
                yield event


def load_report(filename: str) -> Report:
    path = Path(filename)
    try:
        with path.open("r", encoding="utf-8-sig") as stream:
            prefix = stream.read(4096)
            if not prefix.strip():
                raise DqaError(65, f"Отчёт {path} пуст.")
            stream.seek(0)
            single_json = prefix.lstrip().startswith("{")
            root = None
            if single_json:
                try:
                    root = json.load(stream)
                except json.JSONDecodeError as exc:
                    if exc.msg != "Extra data":
                        raise DqaError(65, f"Невалидный отчёт {path}: {exc}") from exc
                    single_json = False
        if single_json and isinstance(root, dict) and root.get("type") in {"run_start", "file", "run_end"}:
            single_json = False
        if single_json:
            if not isinstance(root, dict) or not isinstance(root.get("files"), list):
                raise DqaError(65, f"JSON-отчёт {path} не содержит files[].")
            metadata = root
            summary = root.get("summary") or {}
            json_files = root["files"]
            status = root.get("status")
            has_end = True
            report_format = "json"
            file_count = len(json_files)
        else:
            metadata = {}
            summary = {}
            status = None
            has_end = False
            file_count = 0
            for event in _ndjson_events(path):
                kind = event.get("type")
                if kind == "run_start":
                    metadata = _ndjson_metadata(event)
                elif kind == "file":
                    file_count += 1
                elif kind == "run_end":
                    has_end = True
                    status = event.get("status")
                    summary = event.get("summary") or {}
            metadata.update({"status": status, "summary": summary})
            json_files = None
            report_format = "ndjson"
    except (OSError, UnicodeError) as exc:
        raise DqaError(66, f"Не удалось прочитать отчёт {path}: {exc}") from exc
    total = summary.get("files_total")
    completed = summary.get("files_completed")
    returned = summary.get("files_returned", completed)
    filtered = summary.get("files_filtered_out", 0)
    pending = summary.get("files_pending", 0)
    truncated = summary.get("files_truncated", pending)
    counts_valid = bool(
        isinstance(total, int) and isinstance(completed, int) and isinstance(returned, int)
        and returned == file_count and completed == file_count + filtered
        and total == completed + pending and truncated == pending
    )
    complete = bool(
        counts_valid and has_end and status == "completed" and completed == total
        and not pending and not truncated and not filtered
    )
    return Report(path, metadata, summary, complete, report_format, json_files)


def _ndjson_metadata(event: dict[str, Any]) -> dict[str, Any]:
    metadata = dict(event)
    effective = event.get("effective_config")
    if isinstance(effective, dict):
        metadata["config"] = {
            "effective_hash": effective.get("hash"),
            "effective_fingerprint": effective.get("fingerprint"),
        }
    return metadata


def _ndjson_events(path: Path) -> Iterator[dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8-sig") as stream:
            for number, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise DqaError(65, f"{path}:{number}: невалидный NDJSON: {exc}") from exc
                if not isinstance(event, dict):
                    raise DqaError(65, f"{path}:{number}: ожидался JSON-объект.")
                yield event
    except OSError as exc:
        raise DqaError(66, f"Не удалось прочитать отчёт {path}: {exc}") from exc


def explain(filename: str, query: str) -> dict[str, Any]:
    report = load_report(filename)
    exact = []
    for record in report.iter_files():
        if record.get("path") == query:
            exact.append(record)
            if len(exact) > 1:
                break
    matches = exact or [record for record in report.iter_files() if record.get("name") == query]
    if not matches:
        raise DqaError(66, f"Материал {query!r} не найден в отчёте {filename}.")
    if len(matches) > 1:
        raise DqaError(65, f"Имя {query!r} неоднозначно ({len(matches)} записи); укажите полный path.")
    record = matches[0]
    return {
        "schema": 1, "type": "explain", "query": query,
        "matched_path": record.get("path") or record.get("name"),
        "run_id": report.metadata.get("run_id"), "complete": report.complete,
        "file": {
            key: record.get(key) for key in (
                "i", "path", "name", "status", "reason", "material", "content_sha256",
                "decision", "answers", "by_model", "trace", "errors", "runs", "duration_s",
            ) if key in record
        },
    }


def diff(first: str, second: str) -> dict[str, Any]:
    left = load_report(first)
    right = load_report(second)
    if not left.complete or not right.complete:
        raise DqaError(65, "diff требует два полных completed отчёта; partial/truncated/filtered вход отклонён.")
    left_by_hash = _by_hash(left.iter_files())
    right_by_hash = _by_hash(right.iter_files())
    transitions: dict[str, int] = {}
    changed = []
    for content_hash in sorted(set(left_by_hash) & set(right_by_hash)):
        before = left_by_hash[content_hash]
        after = right_by_hash[content_hash]
        before_outcome = (before.get("decision") or {}).get("outcome")
        after_outcome = (after.get("decision") or {}).get("outcome")
        deltas = _answer_deltas(before, after)
        if before_outcome == after_outcome and not deltas:
            continue
        if before_outcome != after_outcome:
            key = f"{before_outcome}->{after_outcome}"
            transitions[key] = transitions.get(key, 0) + 1
        changed.append({
            "content_sha256": content_hash,
            "path": after.get("path") or after.get("name"),
            "previous_path": before.get("path") or before.get("name"),
            "before": before_outcome, "after": after_outcome,
            "answer_deltas": deltas,
        })
    return {
        "schema": 1, "type": "diff",
        "thresholds": {"probability": PROBABILITY_DELTA, "score": SCORE_DELTA},
        "summary": {
            "transitions": sum(transitions.values()),
            "changed_files": len(changed),
            "answer_changes": sum(len(item["answer_deltas"]) for item in changed),
        },
        "transitions": transitions, "files": changed,
    }


def write_diff_table(value: dict[str, Any], stream: TextIO) -> None:
    stream.write(f"TRANSITIONS {value['summary']['transitions']} · CHANGED {value['summary']['changed_files']}\n")
    for transition, count in value["transitions"].items():
        stream.write(f"{transition}: {count}\n")
    for record in value["files"]:
        stream.write(f"{record['path']}: {record['before']} -> {record['after']}"
                     f" · answer deltas {len(record['answer_deltas'])}\n")


def _by_hash(files: Iterator[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result = {}
    for record in files:
        digest = record.get("content_sha256")
        if not isinstance(digest, str) or not digest:
            continue
        if digest in result:
            raise DqaError(65, f"content_sha256 {digest} встречается более одного раза; diff неоднозначен.")
        result[digest] = record
    return result


def _answer_deltas(before: dict[str, Any], after: dict[str, Any]) -> list[dict[str, Any]]:
    if before.get("reason") == "already_processed" or after.get("reason") == "already_processed":
        return []
    first = before.get("answers") or {}
    second = after.get("answers") or {}
    deltas = []
    for qid in sorted(set(first) | set(second)):
        left = first.get(qid) or {}
        right = second.get(qid) or {}
        if isinstance(left.get("score"), (int, float)) and isinstance(right.get("score"), (int, float)):
            delta = right["score"] - left["score"]
            if abs(delta) >= SCORE_DELTA:
                deltas.append({"question": qid, "kind": "score", "before": left["score"],
                               "after": right["score"], "delta": delta})
            continue
        first_probs = left.get("probabilities") or {}
        second_probs = right.get("probabilities") or {}
        for option in sorted(set(first_probs) | set(second_probs)):
            a, b = first_probs.get(option), second_probs.get(option)
            if not _finite(a) or not _finite(b):
                continue
            delta = b - a
            if abs(delta) >= PROBABILITY_DELTA:
                deltas.append({"question": qid, "kind": "probability", "option": option,
                               "before": a, "after": b, "delta": delta})
    return deltas


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)
