"""Actual /api/run transport, SSE control, reusable outcomes and exit policy."""

from __future__ import annotations

import copy
import gzip
import json
import queue
import random
import signal
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator

import httpx

from dqa_common.materials import material_hash, materials_fingerprint

from . import SCHEMA, cli_version
from .client import Client, DqaError, _detail
from .inputs import InputPlan, Material, SkippedRecord
from .pack import LoadedPack
from .processed import ProcessedManifest, processed_key, reusable_entry

TERMINAL_STATUSES = {"completed", "completed_partial", "cancelled", "failed"}


class _Control(Exception):
    def __init__(self, code: int):
        self.code = code


class _SecondInterrupt(Exception):
    pass


class _ResyncRequired(Exception):
    pass


@dataclass
class _WatchFailure:
    error: Exception


class RunTransport:
    def __init__(self, client: Client, capabilities: dict[str, Any], *, retry: int,
                 control: Callable[[], None], verbose: bool = False):
        self.client = client
        self.capabilities = capabilities
        self.retry = retry
        self.control = control
        self.verbose = verbose
        self.http = httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0))

    def close(self) -> None:
        self.http.close()

    @property
    def headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self.client.token:
            headers["Authorization"] = f"Bearer {self.client.token}"
        return headers

    def request(self, method: str, path: str, *, body: bytes | None = None,
                headers: dict[str, str] | None = None, expected: tuple[int, ...] = (200,),
                timeout: float | None = None) -> dict[str, Any]:
        failures = 0
        while True:
            self.control()
            request_headers = {**self.headers, **(headers or {})}
            try:
                response = self.http.request(method, self.client.server + path, content=body,
                                             headers=request_headers,
                                             timeout=timeout if timeout is not None else 60.0)
            except httpx.HTTPError as exc:
                failures += 1
                if failures > self.retry:
                    raise DqaError(69, f"Сбой соединения {method} {path}: {exc}") from exc
                self._sleep(failures, f"{method} {path}: {exc}; повтор")
                continue
            if self.verbose:
                print(f"{method} {path} → {response.status_code}", file=sys.stderr)
            if response.status_code == 429:
                delay = _retry_after(response)
                self._sleep(1, f"{method} {path}: 429; ожидание {delay:g} c", fixed=delay)
                continue
            if response.status_code >= 500:
                failures += 1
                if failures > self.retry:
                    raise DqaError(69, f"Сервер недоступен {method} {path}: HTTP {response.status_code}: {_detail(response)}")
                self._sleep(failures, f"{method} {path}: HTTP {response.status_code}; повтор")
                continue
            _raise_status(response)
            if response.status_code not in expected:
                raise DqaError(69, f"Неожиданный HTTP {response.status_code} для {method} {path}: {_detail(response)}")
            try:
                value = response.json()
            except ValueError as exc:
                raise DqaError(69, f"Сервер вернул не JSON для {method} {path}.") from exc
            if not isinstance(value, dict):
                raise DqaError(69, f"Несовместимый ответ {method} {path}: ожидался объект.")
            return value

    def _sleep(self, attempt: int, message: str, *, fixed: float | None = None) -> None:
        if self.verbose:
            print(message, file=sys.stderr)
        delay = fixed if fixed is not None else min(8.0, 2 ** (attempt - 1)) + random.random() * 0.1
        end = time.monotonic() + delay
        while True:
            self.control()
            remaining = end - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(0.1, remaining))

    def create(self, body: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
        raw = _json_bytes(body)
        return self.request("POST", "/api/run", body=raw,
                            headers={"Content-Type": "application/json", "Idempotency-Key": idempotency_key},
                            expected=(200, 201))

    def upload(self, run_id: str, chunk_index: int, raw: bytes) -> None:
        headers = {"Content-Type": "application/json"}
        if self.capabilities.get("features", {}).get("gzip"):
            compressed = gzip.compress(raw, compresslevel=6, mtime=0)
            if len(compressed) < len(raw):
                raw = compressed
                headers["Content-Encoding"] = "gzip"
        self.request("POST", f"/api/run/{run_id}/files", body=raw, headers=headers)

    def start(self, run_id: str) -> dict[str, Any]:
        return self.request("POST", f"/api/run/{run_id}/start")

    def metadata(self, run_id: str) -> dict[str, Any]:
        return self.request("GET", f"/api/run/{run_id}")

    def cancel(self, run_id: str) -> None:
        self.request("POST", f"/api/run/{run_id}/cancel", timeout=5.0)

    def page(self, run_id: str, offset: int, limit: int) -> dict[str, Any]:
        return self.request("GET", f"/api/run/{run_id}/files?offset={offset}&limit={limit}")


@dataclass
class RunOutcome:
    """Reusable run result without a whole-job in-memory file list.

    ``iter_files()`` pages final canonical results and merges them with input and
    already-processed skips in source order. NDJSON is emitted by ``accept`` as
    server events arrive; JSON consumers call ``write_json()`` after terminal.
    """

    plan: InputPlan
    pack: LoadedPack
    client: Client
    capabilities: dict[str, Any]
    transport: RunTransport | None
    pending: list[Material]
    reused: list[dict[str, Any]]
    fail_on: str
    quiet: bool
    output_format: str
    server_version: str
    run_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    run_start: dict[str, Any] | None = None
    run_end: dict[str, Any] | None = None
    interrupted: int | None = None
    decision_counts: dict[str, int] = field(default_factory=dict)
    _server_completed: int = 0
    policy_hit: bool = False
    degraded: bool = False
    _static: list[dict[str, Any]] = field(default_factory=list)
    _stream_started: bool = False
    _static_streamed: bool = False
    manifest: ProcessedManifest | None = None
    control: Callable[[], None] | None = None

    def __post_init__(self) -> None:
        self._static = sorted(
            [*_skipped_records(self.plan.skipped), *self.reused],
            key=lambda record: record["source_index"],
        )
        for record in self._static:
            self._account(record)
        if not self.pending:
            now = _now_metadata()
            self.metadata = {
                "run_id": None, "status": "completed", "material_count": 0,
                "effective_config": copy.deepcopy(self.pack.effective),
                "threads_effective": 0, "started_at": now, "finished_at": now,
                "duration_s": 0.0, "summary": {"files_total": 0, "files_completed": 0,
                "files_ok": 0, "files_failed": 0, "files_pending": 0},
            }
            self.run_start = {"type": "run_start", "run_id": None, "files_total": 0,
                              "threads_effective": 0, "models": self.pack.models, "mode": self.pack.mode}
            self.run_end = {"type": "run_end", "run_id": None, "status": "completed",
                            "summary": self.metadata["summary"], "duration_s": 0.0}
            if self.output_format == "ndjson":
                self.accept(self.run_start)
                self.accept(self.run_end)

    def accept(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "run_start":
            event = {**event, "files_total": len(self.plan.records)}
            self.run_start = event
            self.metadata["threads_effective"] = event.get("threads_effective")
            if not self.quiet:
                print(f"run_id: {event.get('run_id')} · threads={event.get('threads_effective')}", file=sys.stderr)
        elif kind == "file":
            record = self._canonical(event, persist=True)
            self._server_completed += 1
            self._account(record)
            event = {"type": "file", **record}
            if not self.quiet:
                completed = self.report_fields()["summary"]["files_completed"]
                print(f"{completed}/{len(self.plan.records)} files · i={record['i']} · {record['status']}", file=sys.stderr)
        elif kind == "run_end":
            self.run_end = event
            event = {**event, "summary": self.report_fields()["summary"]}
        if self.output_format == "ndjson":
            self._ensure_stream_start()
            self._stream_static()
            if kind != "run_start":
                _write_ndjson(event)

    def _canonical(self, event: dict[str, Any], *, persist: bool = False) -> dict[str, Any]:
        aggregate = event.get("aggregate") or {}
        decision = cli_decision(aggregate.get("decision"), self.pack.original)
        material = self.pending[event["i"]]
        record = {
            key: copy.deepcopy(event[key]) for key in (
                "path", "name", "material", "content_sha256", "status", "runs",
                "errors", "models_skipped", "duration_s",
            ) if key in event
        }
        record.update({
            "i": material.i, "source_index": material.source_index,
            "decision": decision, "answers": aggregate.get("answers"),
            "by_model": aggregate.get("by_model"), "trace": aggregate.get("trace") or [],
            "usage": aggregate.get("usage") or {}, "metrics": aggregate.get("metrics") or {},
        })
        if persist and decision and self.manifest is not None and self.run_id and record.get("status") == "ok" and not record.get("errors"):
            self.transport_manifest_append(record, decision)
        return record

    def transport_manifest_append(self, record: dict[str, Any], decision: dict[str, Any]) -> None:
        manifest = getattr(self, "manifest", None)
        if manifest is not None:
            manifest.append(key=processed_key(record["content_sha256"], self.pack.effective["fingerprint"]),
                            outcome=decision["outcome"], run_id=self.run_id,
                            content_sha256=record["content_sha256"])

    def _account(self, record: dict[str, Any]) -> None:
        decision = record.get("decision")
        if decision:
            outcome = decision["outcome"]
            self.decision_counts[outcome] = self.decision_counts.get(outcome, 0) + 1
        if record.get("status") == "error" or record.get("errors") or record.get("reason") in {"empty", "unreadable", "encoding"}:
            self.degraded = True
        if self.fail_on == "error" and (record.get("status") == "error" or record.get("errors")):
            self.policy_hit = True
        elif self.fail_on == "any" and decision and not decision["is_default"]:
            self.policy_hit = True
        elif self.fail_on not in {"error", "any", "none"} and decision and decision["outcome"] in self.fail_on.split(","):
            self.policy_hit = True

    def _ensure_stream_start(self) -> None:
        if self._stream_started:
            return
        self._stream_started = True
        start = self.run_start or {
            "type": "run_start", "run_id": self.run_id,
            "files_total": len(self.pending), "threads_effective": self.metadata.get("threads_effective") or 0,
            "models": self.pack.models, "mode": self.pack.mode,
        }
        _write_ndjson({"schema": SCHEMA, **start, "models_overridden": self.pack.models_overridden})

    def _stream_static(self) -> None:
        if self._static_streamed:
            return
        self._static_streamed = True
        for record in self._static:
            _write_ndjson({"type": "file", **record})

    def _check_output_control(self) -> None:
        if self.transport is not None:
            self.transport.control()
        elif self.control is not None:
            self.control()

    def iter_files(self) -> Iterator[dict[str, Any]]:
        static = iter(self._static)
        current = next(static, None)
        if self.run_id and self.transport and self.pending:
            offset = 0
            limit = self.capabilities.get("max_page_limit", 200)
            while offset < len(self.pending):
                self._check_output_control()
                page = self.transport.page(self.run_id, offset, limit)
                files = page.get("files")
                if not isinstance(files, list):
                    raise DqaError(69, "Несовместимая страница результатов: files не список.")
                for event in files:
                    self._check_output_control()
                    record = self._canonical(event)
                    while current is not None and current["source_index"] < record["source_index"]:
                        yield current
                        current = next(static, None)
                    yield record
                next_offset = page.get("next_offset")
                if next_offset is None:
                    break
                if not isinstance(next_offset, int) or next_offset <= offset:
                    raise DqaError(69, "Несовместимая страница результатов: next_offset не увеличивается.")
                offset = next_offset
        while current is not None:
            self._check_output_control()
            yield current
            current = next(static, None)

    def report_fields(self) -> dict[str, Any]:
        effective = self.metadata.get("effective_config") or self.pack.effective
        summary = dict((self.run_end or {}).get("summary") or self.metadata.get("summary") or {})
        server_completed = max(self._server_completed, summary.get("files_completed", summary.get("files_ok", 0) + summary.get("files_failed", 0)))
        summary.update({
            "files_total": len(self.plan.records),
            "files_completed": server_completed + len(self._static),
            "files_ok": summary.get("files_ok", 0),
            "files_failed": summary.get("files_failed", 0),
            "files_pending": max(0, len(self.pending) - server_completed),
            "files_skipped": len(self._static),
            "decisions": self.decision_counts,
        })
        return {
            "schema": SCHEMA, "run_id": self.run_id, "cli_version": cli_version(),
            "server": {"url": self.client.server, "version": self.server_version},
            "status": (self.run_end or {}).get("status") or self.metadata.get("status"),
            "config": {
                "path": self.pack.path, "version": self.pack.original["version"],
                "fingerprint_version": self.pack.original["fingerprint_version"],
                "hash": self.pack.original["hash"], "fingerprint": self.pack.original["fingerprint"],
                "effective_hash": effective["hash"], "effective_fingerprint": effective["fingerprint"],
                "models_overridden": self.pack.models_overridden,
                "mode_overridden": self.pack.mode_overridden,
                "models_pack": self.pack.original["settings"]["models"],
            },
            "mode": effective["settings"]["mode"], "models": effective["settings"]["models"],
            "aggregation": effective["settings"]["aggregation"],
            "threads_effective": (self.run_start or {}).get("threads_effective", self.metadata.get("threads_effective")),
            "materials_fingerprint": self.metadata.get("materials_fingerprint"),
            "run_fingerprint": self.metadata.get("run_fingerprint"),
            "execution": self.metadata.get("execution"),
            "started_at": self.metadata.get("started_at"), "finished_at": self.metadata.get("finished_at"),
            "duration_s": (self.run_end or {}).get("duration_s", self.metadata.get("duration_s")),
            "summary": summary,
        }

    def write_json(self) -> None:
        fields = self.report_fields()
        fields.pop("summary", None)
        prefix = json.dumps(fields, ensure_ascii=False, allow_nan=False)
        sys.stdout.write(prefix[:-1] + ',"files":[')
        first = True
        returned = 0
        decisions: dict[str, int] = {}
        statuses = {"ok": 0, "error": 0, "skipped": 0}
        try:
            for record in self.iter_files():
                if not first:
                    sys.stdout.write(",")
                first = False
                sys.stdout.write(json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
                returned += 1
                status = record.get("status")
                if status in statuses:
                    statuses[status] += 1
                decision = record.get("decision")
                if decision:
                    outcome = decision["outcome"]
                    decisions[outcome] = decisions.get(outcome, 0) + 1
        except _Control as control:
            self.interrupted = control.code
        total = len(self.plan.records)
        summary = {
            "files_total": total,
            "files_returned": returned,
            "files_completed": returned,
            "files_ok": statuses["ok"],
            "files_failed": statuses["error"],
            "files_skipped": statuses["skipped"],
            "files_pending": total - returned,
            "files_truncated": total - returned,
            "decisions": decisions,
        }
        sys.stdout.write('],"summary":' + json.dumps(summary, ensure_ascii=False, allow_nan=False) + "}\n")
        sys.stdout.flush()

    def close(self) -> None:
        if self.transport is not None:
            self.transport.close()

    @property
    def exit_code(self) -> int:
        if self.interrupted is not None:
            return self.interrupted
        status = (self.run_end or {}).get("status") or self.metadata.get("status")
        if status in {"failed", "cancelled"}:
            return 70
        if self.policy_hit:
            return 10
        if self.degraded or status == "completed_partial":
            return 2
        return 0


class Runner:
    def __init__(self, *, plan: InputPlan, pack: LoadedPack, client: Client,
                 capabilities: dict[str, Any], args: Any, reused: list[dict[str, Any]],
                 pending: list[Material], manifest: ProcessedManifest | None,
                 server_version: str):
        self.plan = plan
        self.pack = pack
        self.client = client
        self.capabilities = capabilities
        self.args = args
        self.reused = reused
        self.pending = pending
        self.manifest = manifest
        self.server_version = server_version
        self.deadline = getattr(args, "deadline", None)
        self.control_code: int | None = None
        self.cleanup_deadline: float | None = None
        self.run_id: str | None = None
        self.outcome: RunOutcome | None = None
        self.transport: RunTransport | None = None
        self._old_handlers: dict[int, Any] = {}

    def _check_control(self) -> None:
        if self.control_code is not None:
            raise _Control(self.control_code)
        if self.deadline is not None and time.monotonic() >= self.deadline:
            raise _Control(75)

    def _signal(self, code: int) -> None:
        if self.control_code is not None:
            raise _SecondInterrupt()
        self.control_code = code
        if self.run_id and not self.args.quiet:
            print(f"Отмена {self.run_id}…", file=sys.stderr)

    def run(self) -> RunOutcome:
        self._install_signals()
        try:
            self.transport = RunTransport(self.client, self.capabilities, retry=self.args.retry,
                                          control=self._check_control, verbose=self.args.verbose)
            self.outcome = RunOutcome(self.plan, self.pack, self.client, self.capabilities,
                                      self.transport if self.pending else None, self.pending,
                                      self.reused, self.args.fail_on, self.args.quiet,
                                      self.args.format, self.server_version)
            self.outcome.manifest = self.manifest
            self.outcome.control = self._check_control
            if not self.pending:
                try:
                    self._check_control()
                except _Control as control:
                    self.outcome.interrupted = control.code
                return self.outcome
            self._execute()
            return self.outcome
        except _SecondInterrupt:
            print(f"Повторное прерывание; run_id={self.run_id}", file=sys.stderr)
            if self.outcome is not None:
                self.outcome.interrupted = 130
                return self.outcome
            raise DqaError(130, f"Повторное прерывание; run_id={self.run_id}")
        except Exception:
            if self.transport:
                self.transport.close()
            raise
        finally:
            self._restore_signals()

    def _execute(self) -> None:
        watcher: threading.Thread | None = None
        events: queue.Queue = queue.Queue(maxsize=64)
        interrupted: int | None = None
        try:
            hashes = [_material_hash(material) for material in self.pending]
            body: dict[str, Any] = {
                "pack": self.pack.original,
                "overrides": {},
                "material_count": len(self.pending),
                "materials_fingerprint": materials_fingerprint(hashes),
            }
            if self.args.models is not None:
                body["overrides"]["models"] = self.pack.models
            if self.args.mode is not None:
                body["overrides"]["mode"] = self.pack.mode
            if self.args.threads is not None:
                body["threads"] = self.args.threads
            created = self.transport.create(body, uuid.uuid4().hex)
            self.run_id = created["run_id"]
            self.outcome.run_id = self.run_id
            self.outcome.metadata = created
            if not self.args.quiet:
                print(f"run_id: {self.run_id}", file=sys.stderr)
            for chunk_index, raw in _chunks(self.pending, self.capabilities):
                self.transport.upload(self.run_id, chunk_index, raw)
            self.outcome.metadata = self.transport.start(self.run_id)
        except _Control as control:
            interrupted = control.code
        if self.run_id is None:
            raise DqaError(interrupted or 130, "Прогон прерван до создания server job.")
        watcher = threading.Thread(target=self._watch_entry, args=(events,), daemon=True)
        watcher.start()
        controlled = self._consume_watch(events, watcher, interrupted)
        if controlled is not None:
            interrupted = controlled
        self.outcome.interrupted = interrupted
        try:
            self.outcome.metadata = self.transport.metadata(self.run_id)
        except _Control as control:
            interrupted = control.code
            self.outcome.interrupted = control.code
        except DqaError:
            if interrupted is None:
                raise
        if self.outcome.run_end is None:
            status = self.outcome.metadata.get("status")
            self.outcome.accept({"type": "run_end", "run_id": self.run_id, "status": status,
                                 "summary": self.outcome.metadata.get("summary") or {},
                                 "duration_s": self.outcome.metadata.get("duration_s")})
        if self.outcome.interrupted == 130:
            self.transport.control = lambda: None
        else:
            self.transport.control = self._check_control

    def _watch_entry(self, events: queue.Queue) -> None:
        try:
            self._watch(events)
        except Exception as exc:
            events.put(_WatchFailure(exc))

    def _consume_watch(self, events: queue.Queue, watcher: threading.Thread,
                       interrupted: int | None) -> int | None:
        cancelled = interrupted is not None
        if cancelled:
            self._cancel_best_effort(interrupted)
        failure: Exception | None = None
        while watcher.is_alive() or not events.empty():
            try:
                event = events.get(timeout=0.1)
            except queue.Empty:
                event = None
            if isinstance(event, _WatchFailure):
                failure = event.error
            elif isinstance(event, dict):
                self.outcome.accept(event)
            if not cancelled:
                try:
                    self._check_control()
                except _Control as control:
                    interrupted = control.code
                    cancelled = True
                    self._cancel_best_effort(interrupted)
            if cancelled and not watcher.is_alive() and events.empty():
                break
            if cancelled and self.cleanup_deadline is not None and time.monotonic() >= self.cleanup_deadline:
                break
        if failure is not None and interrupted is None:
            raise failure
        return interrupted

    def _begin_cleanup(self, code: int) -> None:
        if self.cleanup_deadline is None:
            self.cleanup_deadline = time.monotonic() + 5.0
        self.outcome.interrupted = code
        self.transport.control = self._check_cleanup

    def _check_cleanup(self) -> None:
        if self.cleanup_deadline is not None and time.monotonic() >= self.cleanup_deadline:
            raise _Control(self.outcome.interrupted or 75)

    def _cancel_best_effort(self, code: int) -> None:
        self._begin_cleanup(code)
        try:
            self.transport.cancel(self.run_id)
        except (_Control, DqaError) as exc:
            print(f"dqa: не удалось подтвердить отмену {self.run_id}: {exc}", file=sys.stderr)

    def _watch(self, events: queue.Queue) -> None:
        after = 0
        seen: set[int] = set()
        failures = 0
        headers = self.transport.headers
        while True:
            try:
                with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0)) as http:
                    with http.stream("GET", f"{self.client.server}/api/run/{self.run_id}/events?after={after}",
                                     headers=headers) as response:
                        if response.status_code == 429:
                            time.sleep(_retry_after(response))
                            continue
                        if response.status_code >= 500:
                            raise httpx.HTTPStatusError("server error", request=response.request, response=response)
                        _raise_status(response)
                        data_lines: list[str] = []
                        for line in response.iter_lines():
                            if not line:
                                if data_lines:
                                    event = json.loads("\n".join(data_lines))
                                    data_lines = []
                                    if event.get("type") == "resync_required":
                                        raise _ResyncRequired("server requested journal replay")
                                    seq = event.get("seq")
                                    if not isinstance(seq, int):
                                        raise DqaError(69, f"SSE без числового seq; run_id={self.run_id}")
                                    if seq in seen:
                                        continue
                                    seen.add(seq)
                                    after = max(after, seq)
                                    failures = 0
                                    events.put(event)
                                    if event.get("type") == "run_end":
                                        return
                            elif line.startswith("data:"):
                                data_lines.append(line[5:].lstrip())
                        if data_lines:
                            raise DqaError(69, f"Неполное SSE-событие; run_id={self.run_id}")
                        raise httpx.RemoteProtocolError("SSE ended before run_end", request=response.request)
            except (httpx.HTTPError, ValueError, _ResyncRequired) as exc:
                failures += 1
                if failures > self.args.retry:
                    raise DqaError(69, f"SSE оборвался после reconnect; run_id={self.run_id}; задание может продолжаться на сервере: {exc}") from exc
                if self.args.verbose:
                    print(f"SSE reconnect after={after}: {exc}", file=sys.stderr)
                time.sleep(min(2.0, 2 ** (failures - 1) + random.random() * 0.1))

    def _install_signals(self) -> None:
        signals = {signal.SIGINT, getattr(signal, "SIGTERM", signal.SIGINT)}
        if hasattr(signal, "SIGBREAK"):
            signals.add(signal.SIGBREAK)
        for sig in signals:
            try:
                self._old_handlers[sig] = signal.getsignal(sig)
                signal.signal(sig, lambda _signum, _frame: self._signal(130))
            except (ValueError, OSError):
                pass

    def _restore_signals(self) -> None:
        for sig, handler in self._old_handlers.items():
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError):
                pass


def execute_run(*, plan: InputPlan, pack: LoadedPack, client: Client,
                capabilities: dict[str, Any], args: Any,
                manifest: ProcessedManifest | None) -> RunOutcome:
    latest = manifest.latest_by_key() if manifest is not None else {}
    pending: list[Material] = []
    reused: list[dict[str, Any]] = []
    outcomes = {outcome["id"]: outcome for outcome in pack.original["decision"]["outcomes"]}
    outcome_ids = set(outcomes)
    for material in plan.materials:
        entry = latest.get(processed_key(material.content_sha256, pack.effective["fingerprint"]))
        if entry is None or not reusable_entry(entry, pack.effective["fingerprint"], outcome_ids):
            pending.append(material)
            continue
        outcome = outcomes[entry["outcome"]]
        record = material.summary()
        record.update({
            "status": "skipped", "reason": "already_processed",
            "run_id": entry["run_id"], "previous_run_id": entry["run_id"],
            "decision": {"outcome": outcome["id"], "label": outcome["label"], "rule": None,
                         "is_default": outcome["isDefault"]},
            "answers": None, "by_model": None, "runs": [], "errors": [],
        })
        reused.append(record)
    server_version = client.version()["version"]
    return Runner(plan=plan, pack=pack, client=client, capabilities=capabilities,
                  args=args, reused=reused, pending=pending, manifest=manifest,
                  server_version=server_version).run()


def _material_hash(material: Material) -> str:
    metadata = {key: value for key, value in (("path", material.path), ("name", material.name)) if value is not None}
    metadata["material"] = material.material()
    images = [image.raw() for image in material.images]
    try:
        return material_hash(None, images, metadata, content_digest=material.content_sha256)
    finally:
        for image in material.images:
            image.release_raw()


def _chunks(materials: list[Material], capabilities: dict[str, Any]) -> Iterator[tuple[int, bytes]]:
    max_files = capabilities.get("max_files_per_chunk")
    max_bytes = capabilities.get("max_chunk_bytes")
    if not isinstance(max_files, int) or not isinstance(max_bytes, int):
        raise DqaError(69, "Capabilities не содержат max_files_per_chunk/max_chunk_bytes.")
    chunk: list[dict[str, Any]] = []
    chunk_index = 0
    for server_index, material in enumerate(materials):
        payload = material.payload()
        payload["i"] = server_index
        if material.kind == "image":
            payload["input"] = ""
        raw = _json_bytes(payload)
        if len(raw) + 64 > max_bytes:
            raise DqaError(65, f"Материал {material.path or material.name} не помещается в max_chunk_bytes={max_bytes} даже отдельно.")
        candidate = _json_bytes({"chunk_index": chunk_index, "files": [*chunk, payload]})
        if chunk and (len(chunk) >= max_files or len(candidate) > max_bytes):
            yield chunk_index, _json_bytes({"chunk_index": chunk_index, "files": chunk})
            chunk_index += 1
            chunk = []
        chunk.append(payload)
    if chunk:
        yield chunk_index, _json_bytes({"chunk_index": chunk_index, "files": chunk})


def cli_decision(value: Any, pack: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not isinstance(value.get("outcomeId"), str):
        return None
    outcome = next((item for item in pack["decision"]["outcomes"] if item["id"] == value["outcomeId"]), None)
    if outcome is None:
        return None
    is_default = bool(value.get("isDefault"))
    rule = None
    rule_index = value.get("ruleIdx")
    if not is_default and isinstance(rule_index, int) and 0 <= rule_index < len(outcome.get("rules", [])):
        rule = format_rule(outcome["rules"][rule_index])
    return {"outcome": outcome["id"], "label": outcome["label"], "rule": rule, "is_default": is_default}


def format_rule(rule: dict[str, Any]) -> str | None:
    conditions = []
    for condition in rule.get("conditions") or []:
        op = "<" if condition.get("op") == "lt" else ">="
        if condition.get("answer") is not None:
            left = f"{condition['question']}.{condition['answer']}"
            threshold = condition["threshold"]
        else:
            left = condition["question"]
            threshold = condition["score"]
        conditions.append(f"{left}{op}{json.dumps(threshold, ensure_ascii=False, allow_nan=False)}")
    if not conditions:
        return None
    return (" || " if rule.get("anyOf") else " && ").join(conditions)


def _skipped_records(skipped: list[SkippedRecord]) -> Iterator[dict[str, Any]]:
    for item in skipped:
        record = item.summary()
        record.update({"decision": None, "answers": None, "by_model": None, "runs": [], "errors": []})
        yield record


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _write_ndjson(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


def _raise_status(response: httpx.Response) -> None:
    if response.status_code in (401, 403):
        raise DqaError(77, "Сервер отклонил доступ (401/403). Проверьте DQA_TOKEN.")
    if response.status_code in (400, 409, 410, 413, 415, 422):
        raise DqaError(65, f"Сервер отклонил запрос ({response.status_code}): {_detail(response)}")
    if response.status_code >= 400:
        raise DqaError(69, f"Сервер вернул HTTP {response.status_code}: {_detail(response)}")


def _retry_after(response: httpx.Response) -> float:
    try:
        return min(60.0, max(0.0, float(response.headers.get("Retry-After", "1"))))
    except ValueError:
        return 1.0


def _now_metadata() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
