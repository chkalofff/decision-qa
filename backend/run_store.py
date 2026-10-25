"""Single-process temporary run metadata and owner-scoped disk spool."""

from __future__ import annotations

import asyncio
import copy
import json
import os
import re
import shutil
import tempfile
import time
import uuid
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.auth import safe_owner
from backend.run_schemas import RunAPIError, RunLimits

_RUN_ID_RE = re.compile(r"^run_[0-9a-f]{32}$")
TERMINAL_STATUSES = {"completed", "completed_partial", "cancelled", "failed"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _private(path: Path, *, directory: bool = False) -> None:
    if os.name == "posix":
        os.chmod(path, 0o700 if directory else 0o600)


def _atomic_json(path: Path, value: Any) -> None:
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    tmp = Path(temporary)
    try:
        _private(tmp)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        _private(path)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


@dataclass
class RunJob:
    owner: str
    run_id: str
    request_hash: str
    effective_config: dict
    material_count: int
    expected_materials_fingerprint: str
    materials_fingerprint: str
    run_fingerprint: str
    threads_requested: int | None
    status: str = "uploading"
    threads_effective: int | None = None
    created_at: str = field(default_factory=utc_now)
    queued_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    duration_s: float | None = None
    execution: dict | None = None
    error: str | None = None
    chunks: dict[int, dict] = field(default_factory=dict)
    material_chunks: dict[int, int] = field(default_factory=dict)
    result_indices: set[int] = field(default_factory=set)
    files_ok: int = 0
    files_failed: int = 0
    event_seq: int = 0
    cancel_requested: bool = False
    deadline_monotonic: float | None = None
    expires_monotonic: float | None = None
    task: asyncio.Task | None = field(default=None, repr=False)
    subscribers: set[asyncio.Queue] = field(default_factory=set, repr=False)
    start_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    def summary(self) -> dict:
        return {
            "files_total": self.material_count,
            "files_completed": len(self.result_indices),
            "files_ok": self.files_ok,
            "files_failed": self.files_failed,
            "files_pending": self.material_count - len(self.result_indices),
        }

    def public(self) -> dict:
        return {
            "run_id": self.run_id,
            "status": self.status,
            "material_count": self.material_count,
            "effective_config": copy.deepcopy(self.effective_config),
            "config_hash": self.effective_config["hash"],
            "config_fingerprint": self.effective_config["fingerprint"],
            "materials_fingerprint": self.materials_fingerprint,
            "run_fingerprint": self.run_fingerprint,
            "threads_requested": self.threads_requested,
            "threads_effective": self.threads_effective,
            "created_at": self.created_at,
            "queued_at": self.queued_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "duration_s": self.duration_s,
            "execution": copy.deepcopy(self.execution),
            "summary": self.summary(),
            "error": self.error,
            "cancel_requested": self.cancel_requested,
        }


class RunStore:
    """Volatile job registry with bounded chunk files and paged result files.

    Construction deliberately removes all previous run state: inference jobs are
    never resumed or relabelled as completed after a process restart.
    """

    def __init__(self, root: str | Path, limits: RunLimits | None = None):
        self.root = Path(root)
        self.limits = limits or RunLimits()
        self.jobs: dict[tuple[str, str], RunJob] = {}
        self.idempotency: dict[tuple[str, str], tuple[str, str]] = {}
        if self.root.exists():
            for child in self.root.iterdir():
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child)
                else:
                    child.unlink()
        self.root.mkdir(parents=True, exist_ok=True)
        _private(self.root, directory=True)

    def create_job(self, *, owner: str, idempotency_key: str, request_hash: str,
                   effective_config: dict, material_count: int,
                   expected_materials_fingerprint: str, materials_fingerprint: str,
                   run_fingerprint: str, threads_requested: int | None) -> tuple[RunJob, bool]:
        owner = safe_owner(owner)
        self.cleanup_expired()
        idem_key = (owner, idempotency_key)
        previous = self.idempotency.get(idem_key)
        if previous is not None:
            old_hash, run_id = previous
            if old_hash != request_hash:
                raise RunAPIError(409, "Idempotency-Key уже использован для другого запроса")
            job = self.jobs.get((owner, run_id))
            if job is None:
                raise RunAPIError(410, "Срок хранения идемпотентного задания истёк")
            return job, False
        run_id = "run_" + uuid.uuid4().hex
        job = RunJob(
            owner=owner, run_id=run_id, request_hash=request_hash,
            effective_config=copy.deepcopy(effective_config), material_count=material_count,
            expected_materials_fingerprint=expected_materials_fingerprint,
            materials_fingerprint=materials_fingerprint, run_fingerprint=run_fingerprint,
            threads_requested=threads_requested,
            expires_monotonic=time.monotonic() + self.limits.job_ttl_s,
        )
        directory = self._directory(job)
        directory.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        _private(directory.parent, directory=True)
        directory.mkdir(parents=True, mode=0o700)
        _private(directory, directory=True)
        (directory / "chunks").mkdir(mode=0o700)
        _private(directory / "chunks", directory=True)
        (directory / "results").mkdir(mode=0o700)
        _private(directory / "results", directory=True)
        self.jobs[(owner, run_id)] = job
        self.idempotency[idem_key] = (request_hash, run_id)
        return job, True

    def _directory(self, job: RunJob) -> Path:
        if not _RUN_ID_RE.fullmatch(job.run_id):
            raise ValueError("invalid run id")
        return self.root / safe_owner(job.owner) / job.run_id

    def get(self, owner: str, run_id: str) -> RunJob:
        self.cleanup_expired()
        job = self.jobs.get((owner, run_id))
        if job is None:
            raise RunAPIError(404, "Задание не найдено")
        return job

    def put_chunk(self, job: RunJob, chunk_index: int, chunk_hash: str,
                  records: list[dict]) -> bool:
        existing = job.chunks.get(chunk_index)
        if existing is not None:
            if existing["chunk_hash"] != chunk_hash:
                raise RunAPIError(409, f"chunk_index {chunk_index} уже загружен с другим содержимым")
            return False
        directory = self._directory(job) / "chunks"
        payload = {
            "chunk_index": chunk_index,
            "chunk_hash": chunk_hash,
            "files": [{"metadata": item["metadata"], "payload": item["payload"]} for item in records],
        }
        _atomic_json(directory / f"{chunk_index:08d}.json", payload)
        _atomic_json(directory / f"{chunk_index:08d}.meta.json", {
            "chunk_index": chunk_index,
            "files": [item["metadata"] for item in records],
        })
        job.chunks[chunk_index] = {"chunk_hash": chunk_hash, "count": len(records)}
        for item in records:
            job.material_chunks[item["metadata"]["i"]] = chunk_index
        job.expires_monotonic = time.monotonic() + self.limits.job_ttl_s
        return True

    def chunk_records(self, job: RunJob, chunk_index: int) -> list[dict]:
        path = self._directory(job) / "chunks" / f"{chunk_index:08d}.json"
        try:
            with path.open(encoding="utf-8") as stream:
                return json.load(stream)["files"]
        except (OSError, KeyError, json.JSONDecodeError) as exc:
            raise RunAPIError(500, "Временные данные загрузки повреждены или удалены") from exc

    def chunk_metadata(self, job: RunJob, chunk_index: int) -> list[dict]:
        path = self._directory(job) / "chunks" / f"{chunk_index:08d}.meta.json"
        try:
            with path.open(encoding="utf-8") as stream:
                return json.load(stream)["files"]
        except (OSError, KeyError, json.JSONDecodeError) as exc:
            raise RunAPIError(500, "Метаданные загрузки повреждены или удалены") from exc

    def material_metadata(self, job: RunJob) -> Iterator[dict]:
        for chunk_index in sorted(job.chunks):
            yield from self.chunk_metadata(job, chunk_index)

    def material_metadata_at(self, job: RunJob, index: int) -> dict:
        chunk_index = job.material_chunks[index]
        for item in self.chunk_metadata(job, chunk_index):
            if item["i"] == index:
                return item
        raise RunAPIError(500, f"Метаданные материала {index} отсутствуют")

    def load_material(self, job: RunJob, index: int) -> dict:
        chunk_index = job.material_chunks[index]
        for item in self.chunk_records(job, chunk_index):
            if item["metadata"]["i"] == index:
                return item["payload"]
        raise RunAPIError(500, f"Материал {index} отсутствует во временном чанке")

    def append_event(self, job: RunJob, event: Mapping[str, Any]) -> dict:
        job.event_seq += 1
        stored = {**copy.deepcopy(dict(event)), "seq": job.event_seq}
        path = self._directory(job) / "events.jsonl"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(stored, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        _private(path)
        for queue in tuple(job.subscribers):
            try:
                queue.put_nowait(stored)
            except asyncio.QueueFull:
                job.subscribers.discard(queue)
                try:
                    queue.get_nowait()
                    queue.put_nowait({
                        "type": "resync_required", "seq": stored["seq"],
                        "detail": "SSE subscriber overflow; reconnect with after=<last seq>",
                    })
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass
        return stored

    def record_file(self, job: RunJob, event: Mapping[str, Any]) -> dict:
        seq = job.event_seq + 1
        stored = {**copy.deepcopy(dict(event)), "seq": seq}
        index = stored["i"]
        _atomic_json(self._directory(job) / "results" / f"{index:08d}.json", stored)
        job.result_indices.add(index)
        if stored["status"] == "ok":
            job.files_ok += 1
        else:
            job.files_failed += 1
        return self.append_event(job, stored)

    def events_after(self, job: RunJob, after: int) -> Iterator[dict]:
        path = self._directory(job) / "events.jsonl"
        try:
            stream = path.open(encoding="utf-8")
        except FileNotFoundError:
            return
        with stream:
            for line in stream:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise RunAPIError(500, "Журнал событий задания повреждён") from exc
                if event["seq"] > after:
                    yield event

    def validate_cursor(self, job: RunJob, after: int) -> None:
        if after < 0:
            raise RunAPIError(409, "after/Last-Event-ID должен быть неотрицательным целым")
        if after > job.event_seq:
            raise RunAPIError(409, f"Курсор {after} новее последнего события {job.event_seq}")

    def subscribe(self, job: RunJob) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=1024)
        job.subscribers.add(queue)
        return queue

    def unsubscribe(self, job: RunJob, queue: asyncio.Queue) -> None:
        job.subscribers.discard(queue)

    def read_results(self, job: RunJob, offset: int, limit: int) -> dict:
        files = []
        index = offset
        upper = min(job.material_count, offset + limit)
        while index < upper:
            path = self._directory(job) / "results" / f"{index:08d}.json"
            if path.exists():
                try:
                    with path.open(encoding="utf-8") as stream:
                        files.append(json.load(stream))
                except json.JSONDecodeError as exc:
                    raise RunAPIError(500, "Результат задания повреждён") from exc
            index += 1
        next_offset = offset + limit if upper < job.material_count else None
        return {
            "files": files,
            "offset": offset,
            "limit": limit,
            "returned": len(files),
            "completed": len(job.result_indices),
            "total": job.material_count,
            "next_offset": next_offset,
            "status": job.status,
        }

    def finish(self, job: RunJob, status: str, *, duration_s: float, error: str | None = None) -> None:
        if status not in TERMINAL_STATUSES:
            raise ValueError("terminal status required")
        job.status = status
        job.finished_at = utc_now()
        job.duration_s = round(max(0.0, duration_s), 3)
        job.error = error
        job.expires_monotonic = time.monotonic() + self.limits.job_ttl_s
        self.delete_raw(job)

    def delete_raw(self, job: RunJob) -> None:
        shutil.rmtree(self._directory(job) / "chunks", ignore_errors=True)

    def cleanup_expired(self) -> None:
        now = time.monotonic()
        for key, job in tuple(self.jobs.items()):
            if job.expires_monotonic is None or job.expires_monotonic > now:
                continue
            shutil.rmtree(self._directory(job), ignore_errors=True)
            for queue in tuple(job.subscribers):
                job.subscribers.discard(queue)
            self.jobs.pop(key, None)
            self.idempotency = {
                idem: record for idem, record in self.idempotency.items()
                if not (idem[0] == job.owner and record[1] == job.run_id)
            }

    async def close(self) -> None:
        for job in tuple(self.jobs.values()):
            if job.task is not None and not job.task.done():
                job.task.cancel()
        tasks = [job.task for job in self.jobs.values() if job.task is not None]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
