"""Run job orchestration, validation and fair bounded material scheduling."""

from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Callable

from backend.run_engine import RunEngine, RunEngineError
from backend.run_schemas import RunAPIError, RunChunkRequest, RunCreateRequest, RunLimits
from backend.run_store import RunJob, RunStore, TERMINAL_STATUSES, utc_now
from backend.schemas import DecideRequest
from dqa_common.config_pack import (
    ConfigPackError, canonical_bytes, effective_pack, finalize_pack, validate_pack,
)
from dqa_common.materials import (
    material_hash, materials_fingerprint, raw_content_sha256, run_fingerprint,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RUN_ROOT = PROJECT_ROOT / "server" / "state" / "runs"


def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_bytes(value)).hexdigest()


def _material_type(payload: Mapping[str, Any]) -> str:
    images = payload.get("images") or []
    declared = (payload.get("material") or {}).get("type")
    if images:
        if declared == "text+images":
            return "text+images"
        if payload.get("input") is None or payload.get("input") == "":
            return "image"
        return "text+images"
    return "text"


def prepare_chunk(request: RunChunkRequest, job: RunJob, limits: RunLimits) -> tuple[str, list[dict]]:
    if len(request.files) > limits.max_files_per_chunk:
        raise RunAPIError(422, f"Не больше {limits.max_files_per_chunk} файлов в чанке")
    if len(job.material_chunks) + len(request.files) > job.material_count:
        raise RunAPIError(422, "Чанк превышает объявленный material_count")
    seen = set()
    records = []
    for file in request.files:
        if file.i in seen or file.i in job.material_chunks:
            raise RunAPIError(409, f"Материал с i={file.i} уже загружен или повторён в чанке")
        seen.add(file.i)
        if file.i >= job.material_count:
            raise RunAPIError(422, f"i={file.i} вне диапазона 0..{job.material_count - 1}")
        images = file.images or []
        try:
            DecideRequest.images_valid(images)
        except ValueError as exc:
            raise RunAPIError(422, f"files[{file.i}].images: {exc}") from exc
        if file.input is not None and not isinstance(file.input, (str, dict, list)):
            raise RunAPIError(422, f"files[{file.i}].input должен быть строкой, объектом, массивом или null")
        if not images and (file.input is None or not file.input
                           or isinstance(file.input, str) and not file.input.strip()):
            raise RunAPIError(422, f"files[{file.i}]: материал не может быть пустым")
        material_type = _material_type(file.model_dump())
        declared = (file.material or {}).get("type")
        if declared is not None and declared != material_type:
            raise RunAPIError(422, f"files[{file.i}].material.type не соответствует содержимому")
        declared_images = (file.material or {}).get("images") or []
        if declared_images and len(declared_images) != len(images):
            raise RunAPIError(422, f"files[{file.i}].material.images не совпадает с images")
        image_metadata = []
        for index, image in enumerate(images):
            supplied = declared_images[index] if declared_images else {}
            if not isinstance(supplied, Mapping):
                raise RunAPIError(422, f"files[{file.i}].material.images[{index}] должен быть объектом")
            name = supplied.get("name") or f"image-{index + 1}.png"
            encoded = image.split(",", 1)[1] if image.startswith("data:") else image
            try:
                digest = raw_content_sha256(base64.b64decode(encoded, validate=True))
            except Exception as exc:
                raise RunAPIError(422, f"files[{file.i}].images[{index}]: невалидный base64") from exc
            if supplied.get("sha256") is not None and supplied["sha256"] != digest:
                raise RunAPIError(422, f"files[{file.i}].material.images[{index}].sha256 не совпадает с содержимым")
            image_metadata.append({"name": str(name), "sha256": digest})
        material = {"type": material_type, "images": image_metadata}
        metadata = {
            "i": file.i,
            "material": material,
            "content_sha256": file.content_sha256,
        }
        if file.path is not None:
            metadata["path"] = file.path
        if file.name is not None:
            metadata["name"] = file.name
        hash_metadata = {
            key: copy.deepcopy(metadata[key]) for key in ("path", "name", "material") if key in metadata
        }
        metadata["material_hash"] = material_hash(
            file.input, images, hash_metadata, content_digest=file.content_sha256)
        payload = file.model_dump()
        records.append({"metadata": metadata, "payload": payload})
    chunk_hash = _digest(request.model_dump())
    return chunk_hash, records


class MaterialScheduler:
    """Strict FIFO tickets enforce one global in-flight bound across all jobs."""

    def __init__(self, capacity: int):
        self.capacity = capacity
        self.active = 0
        self.tickets: list[object] = []
        self.condition = asyncio.Condition()

    async def acquire(self) -> object:
        ticket = object()
        async with self.condition:
            self.tickets.append(ticket)
            try:
                while self.tickets[0] is not ticket or self.active >= self.capacity:
                    await self.condition.wait()
            except BaseException:
                if ticket in self.tickets:
                    self.tickets.remove(ticket)
                self.condition.notify_all()
                raise
            self.tickets.pop(0)
            self.active += 1
            return ticket

    async def release(self, ticket: object) -> None:
        async with self.condition:
            self.active -= 1
            self.condition.notify_all()

class JobDeadline(Exception):
    pass


class RunManager:
    def __init__(self, store: RunStore, *, engine_factory: Callable[[Mapping[str, Any]], RunEngine] = RunEngine):
        self.store = store
        self.limits = store.limits
        self.engine_factory = engine_factory
        self.scheduler = MaterialScheduler(self.limits.max_inflight_materials)
        self.tasks: set[asyncio.Task] = set()
        self.workers: set[asyncio.Task] = set()
        self.sweeper: asyncio.Task | None = None

    @classmethod
    def create_default(cls) -> "RunManager":
        import os
        return cls(RunStore(os.environ.get("DQA_RUN_STATE_DIR", DEFAULT_RUN_ROOT), RunLimits.from_env()))

    def _track(self, task: asyncio.Task, *, worker: bool = False) -> asyncio.Task:
        target = self.workers if worker else self.tasks
        target.add(task)
        task.add_done_callback(target.discard)
        return task

    def _ensure_sweeper(self) -> None:
        if self.sweeper is None or self.sweeper.done():
            self.sweeper = self._track(asyncio.create_task(self._sweep(), name="run-store-ttl"))

    async def _sweep(self) -> None:
        while True:
            await asyncio.sleep(min(60.0, max(0.05, self.limits.job_ttl_s / 2)))
            self.store.cleanup_expired()

    def create(self, owner: str, request: RunCreateRequest, idempotency_key: str) -> tuple[RunJob, bool]:
        if request.threads is not None and request.threads > self.limits.max_threads:
            raise RunAPIError(422, f"threads не больше {self.limits.max_threads}")
        if request.material_count > self.limits.max_files_per_job:
            raise RunAPIError(422, f"material_count не больше {self.limits.max_files_per_job}")
        try:
            validate_pack(request.pack, check_hashes=True)
            config = effective_pack(
                request.pack, models=request.overrides.models, mode=request.overrides.mode,
            )
        except ConfigPackError as exc:
            raise RunAPIError(422, str(exc)) from exc
        request_hash = _digest(request.model_dump())
        fingerprint = run_fingerprint(config["fingerprint"], request.materials_fingerprint)
        return self.store.create_job(
            owner=owner, idempotency_key=idempotency_key, request_hash=request_hash,
            effective_config=config, material_count=request.material_count,
            expected_materials_fingerprint=request.materials_fingerprint,
            materials_fingerprint=request.materials_fingerprint, run_fingerprint=fingerprint,
            threads_requested=request.threads,
        )

    def upload(self, job: RunJob, request: RunChunkRequest) -> dict:
        if request.chunk_index in job.chunks:
            chunk_hash = _digest(request.model_dump())
            stored = job.chunks[request.chunk_index]
            if stored["chunk_hash"] != chunk_hash:
                raise RunAPIError(409, f"chunk_index {request.chunk_index} уже загружен с другим содержимым")
            return {"run_id": job.run_id, "chunk_index": request.chunk_index,
                    "accepted": False, "uploaded": len(job.material_chunks)}
        if job.status != "uploading":
            raise RunAPIError(409, "Материалы принимаются только в статусе uploading")
        chunk_hash, records = prepare_chunk(request, job, self.limits)
        accepted = self.store.put_chunk(job, request.chunk_index, chunk_hash, records)
        return {"run_id": job.run_id, "chunk_index": request.chunk_index,
                "accepted": accepted, "uploaded": len(job.material_chunks)}

    def _validate_start_data(self, job: RunJob) -> None:
        if len(job.material_chunks) != job.material_count or set(job.material_chunks) != set(range(job.material_count)):
            missing = sorted(set(range(job.material_count)) - set(job.material_chunks))
            raise RunAPIError(422, f"Загружены не все материалы; отсутствуют i: {missing[:20]}")
        try:
            config = finalize_pack(job.effective_config)
            hashes = [item["material_hash"] for item in self.store.material_metadata(job)]
        except (ConfigPackError, KeyError) as exc:
            raise RunAPIError(422, f"Метаданные материалов невалидны: {exc}") from exc
        actual = materials_fingerprint(hashes)
        if actual != job.expected_materials_fingerprint:
            raise RunAPIError(422, "materials_fingerprint не совпадает с загруженными материалами")
        job.effective_config = config
        job.materials_fingerprint = actual
        job.run_fingerprint = run_fingerprint(config["fingerprint"], actual)

    def _check_image_compatibility(self, job: RunJob, engine: RunEngine) -> None:
        has_images = False
        for item in self.store.material_metadata(job):
            if item["material"]["images"]:
                has_images = True
                break
        if not has_images:
            return
        mode = job.effective_config["settings"]["mode"]
        if mode in {"fast_batch", "both"}:
            raise RunAPIError(422, f"Режим {mode} не поддерживает изображения")
        selected = job.effective_config["settings"]["models"]
        if not any(engine.models[key].vision for key in selected):
            raise RunAPIError(422, "Ни одна выбранная модель не поддерживает изображения")

    async def start(self, job: RunJob) -> RunJob:
        async with job.start_lock:
            if job.status != "uploading":
                return job
            active = sum(item.status in {"queued", "running", "cancel_requested"}
                         for item in self.store.jobs.values())
            if active >= self.limits.max_concurrent_jobs:
                raise RunAPIError(429, "Достигнут max_concurrent_jobs; повторите позже",
                                  headers={"Retry-After": "1"})
            self._validate_start_data(job)
            engine = self.engine_factory(job.effective_config)
            try:
                statuses = await engine.preflight_models()
            except RunEngineError as exc:
                raise RunAPIError(422, str(exc)) from exc
            self._check_image_compatibility(job, engine)
            unavailable = [key for key, status in statuses.items() if status.get("status") != "running"]
            if unavailable:
                names = ", ".join(f"{key} ({statuses[key].get('status')})" for key in unavailable)
                raise RunAPIError(409, f"Выбранные модели не запущены: {names}")
            if job.cancel_requested:
                return job
            requested = job.threads_requested or self.limits.default_threads
            available = max(1, self.limits.max_inflight_materials - self.scheduler.active)
            job.threads_effective = min(requested, self.limits.max_threads, available, job.material_count)
            job.status = "queued"
            job.queued_at = utc_now()
            job.expires_monotonic = None
            job.execution = engine.execution_metadata
            job.task = self._track(asyncio.create_task(self._run(job, engine), name=job.run_id))
            self._ensure_sweeper()
            return job

    def _refresh_execution(self, job: RunJob, engine: RunEngine) -> None:
        job.execution = engine.execution_metadata
        actual = {key: value for key, value in job.execution["prompt_formats"].items() if value is not None}
        if actual:
            config = copy.deepcopy(job.effective_config)
            config["settings"]["prompt_formats"] = {
                **(config["settings"].get("prompt_formats") or {}), **actual,
            }
            job.effective_config = finalize_pack(config)
            job.run_fingerprint = run_fingerprint(job.effective_config["fingerprint"], job.materials_fingerprint)

    async def _run(self, job: RunJob, engine: RunEngine) -> None:
        job.status = "running"
        job.started_at = utc_now()
        started = time.perf_counter()
        job.deadline_monotonic = time.monotonic() + self.limits.job_deadline_s
        self.store.append_event(job, {
            "type": "run_start", "run_id": job.run_id,
            "effective_config": job.effective_config,
            "models": job.effective_config["settings"]["models"],
            "mode": job.effective_config["settings"]["mode"],
            "threads_effective": job.threads_effective,
            "files_total": job.material_count,
            "run_fingerprint": job.run_fingerprint,
            "execution": job.execution,
        })
        next_index = 0

        def take_index() -> int | None:
            nonlocal next_index
            if next_index >= job.material_count or job.cancel_requested:
                return None
            index = next_index
            next_index += 1
            return index

        async def worker() -> None:
            while True:
                index = take_index()
                if index is None:
                    return
                remaining = job.deadline_monotonic - time.monotonic()
                if remaining <= 0:
                    raise JobDeadline()
                try:
                    ticket = await asyncio.wait_for(self.scheduler.acquire(), timeout=remaining)
                except TimeoutError as exc:
                    raise JobDeadline() from exc
                try:
                    remaining = job.deadline_monotonic - time.monotonic()
                    if remaining <= 0:
                        raise JobDeadline()
                    if job.cancel_requested:
                        return
                    payload = self.store.load_material(job, index)
                    metadata = self.store.material_metadata_at(job, index)
                    images = [{
                        "dataUrl": image,
                        "name": metadata["material"]["images"][image_index]["name"],
                    } for image_index, image in enumerate(payload.get("images") or [])]
                    material = {
                        "input": payload["input"], "images": images,
                        "name": payload.get("name"), "path": payload.get("path"),
                        "type": metadata["material"]["type"],
                    }
                    file_started = time.perf_counter()
                    try:
                        outcome = await asyncio.wait_for(engine.run_material(material), timeout=remaining)
                    except TimeoutError as exc:
                        raise JobDeadline() from exc
                    except RunEngineError as exc:
                        outcome = {"runs": [], "models_skipped": [], "material_error": str(exc)}
                    aggregate = engine.aggregate(outcome["runs"])
                    mode = job.effective_config["settings"]["mode"]
                    success = any(run.get("ok") is True and (mode == "fast_batch" or run.get("mode") == "decisions")
                                  for run in outcome["runs"])
                    errors = aggregate["errors"]
                    if outcome.get("material_error"):
                        errors = [{"stage": "material", "message": outcome["material_error"]}, *errors]
                    event = {
                        "type": "file", "i": index,
                        **{key: copy.deepcopy(metadata[key]) for key in ("path", "name") if key in metadata},
                        "material": metadata["material"], "content_sha256": metadata["content_sha256"],
                        "status": "ok" if success else "error",
                        "runs": outcome["runs"], "aggregate": aggregate, "errors": errors,
                        "models_skipped": outcome.get("models_skipped") or [],
                        "duration_s": round(time.perf_counter() - file_started, 3),
                    }
                    self.store.record_file(job, event)
                finally:
                    await self.scheduler.release(ticket)

        workers = [self._track(asyncio.create_task(worker(), name=f"{job.run_id}-worker-{n}"), worker=True)
                   for n in range(job.threads_effective or 1)]
        error = None
        try:
            await asyncio.gather(*workers)
            if job.cancel_requested:
                raise asyncio.CancelledError()
            status = "completed"
        except asyncio.CancelledError:
            status = "completed_partial" if job.result_indices and len(job.result_indices) < job.material_count else "cancelled"
            for task in workers:
                task.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
        except JobDeadline:
            error = "Превышен server deadline задания"
            status = "completed_partial" if job.result_indices else "failed"
            for task in workers:
                task.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
        except Exception as exc:
            error = f"Внутренняя ошибка задания: {exc.__class__.__name__}: {exc}"
            status = "completed_partial" if job.result_indices else "failed"
            for task in workers:
                task.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
        finally:
            if len(job.result_indices) == job.material_count and status in {"cancelled", "completed_partial"}:
                status = "completed"
            self._refresh_execution(job, engine)
            self.store.finish(job, status, duration_s=time.perf_counter() - started, error=error)
            self.store.append_event(job, {
                "type": "run_end", "run_id": job.run_id, "status": status,
                "summary": job.summary(), "duration_s": job.duration_s,
            })

    async def cancel(self, job: RunJob) -> RunJob:
        if job.status in TERMINAL_STATUSES:
            return job
        first = not job.cancel_requested
        job.cancel_requested = True
        if first:
            self.store.append_event(job, {"type": "run_cancelled", "run_id": job.run_id})
        if job.status == "uploading":
            self.store.finish(job, "cancelled", duration_s=0.0)
            self.store.append_event(job, {
                "type": "run_end", "run_id": job.run_id, "status": "cancelled",
                "summary": job.summary(), "duration_s": 0.0,
            })
            return job
        job.status = "cancel_requested"
        if job.task is not None and not job.task.done():
            job.task.cancel()
            await asyncio.gather(job.task, return_exceptions=True)
        return job

    async def close(self) -> None:
        if self.sweeper is not None:
            self.sweeper.cancel()
        for task in tuple(self.tasks):
            if not task.done():
                task.cancel()
        await self.store.close()
        await asyncio.gather(*tuple(self.tasks), return_exceptions=True)
        await asyncio.gather(*tuple(self.workers), return_exceptions=True)
