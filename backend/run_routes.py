"""Thin HTTP/SSE adapter for the temporary run job manager."""

from __future__ import annotations

import asyncio
import json
import zlib
from typing import Any

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError

from backend import model_manager as mm
from backend.run_jobs import RunManager
from backend.run_schemas import RunAPIError, RunChunkRequest, RunCreateRequest
from backend.run_store import TERMINAL_STATUSES

router = APIRouter(prefix="/api/run", tags=["run"])


def manager(request: Request) -> RunManager:
    current = getattr(request.app.state, "run_manager", None)
    if current is None:
        current = RunManager.create_default()
        request.app.state.run_manager = current
    return current


def _model(value: Any, schema):
    try:
        return schema.model_validate(value)
    except ValidationError as exc:
        messages = []
        for error in exc.errors():
            location = ".".join(str(part) for part in error["loc"])
            messages.append(f"{location}: {error['msg']}" if location else error["msg"])
        raise RunAPIError(422, "; ".join(messages)) from exc


async def _json_body(request: Request, max_bytes: int) -> Any:
    encoding = request.headers.get("Content-Encoding", "identity").lower()
    if encoding not in {"identity", "gzip"}:
        raise RunAPIError(415, "Content-Encoding должен быть identity или gzip")
    length = request.headers.get("Content-Length")
    if length and int(length) > max_bytes:
        raise RunAPIError(413, f"Сжатый или обычный чанк превышает {max_bytes} байт")
    if encoding == "identity":
        data = bytearray()
        async for part in request.stream():
            data.extend(part)
            if len(data) > max_bytes:
                raise RunAPIError(413, f"Чанк превышает {max_bytes} байт")
    else:
        decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
        data = bytearray()
        compressed = 0
        try:
            async for part in request.stream():
                compressed += len(part)
                if compressed > max_bytes:
                    raise RunAPIError(413, "Сжатый чанк превышает лимит")
                data.extend(decompressor.decompress(part, max_bytes + 1 - len(data)))
                if len(data) > max_bytes or decompressor.unconsumed_tail:
                    raise RunAPIError(413, f"Распакованный чанк превышает {max_bytes} байт")
            data.extend(decompressor.flush(max_bytes + 1 - len(data)))
        except zlib.error as exc:
            raise RunAPIError(400, "Невалидный gzip-поток") from exc
        if len(data) > max_bytes:
            raise RunAPIError(413, f"Распакованный чанк превышает {max_bytes} байт")
        if not decompressor.eof or decompressor.unused_data:
            raise RunAPIError(400, "Неполный или многокомпонентный gzip-поток")
    try:
        return json.loads(bytes(data))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise RunAPIError(400, "Тело запроса должно быть валидным UTF-8 JSON") from exc


@router.get("/capabilities")
async def capabilities(request: Request):
    result = manager(request).limits.capabilities()
    result["auth_required"] = request.state.auth_required
    authenticated = not request.state.auth_required or bool(request.headers.get("Authorization"))
    if authenticated:
        entries = [entry for entry in mm.REGISTRY.values()
                   if entry.enabled and "decision" in entry.roles]
        statuses = await asyncio.gather(*(mm.model_status(entry) for entry in entries))
        result["models"] = [{
            "key": entry.key, "label": entry.label, "vision": entry.vision,
            "enabled": entry.enabled, "roles": list(entry.roles),
            "type": entry.type, "api": entry.api, "status": status.get("status"),
        } for entry, status in zip(entries, statuses)]
    return result


@router.post("")
async def create_run(request: Request, idempotency_key: str = Header(alias="Idempotency-Key")):
    if not 1 <= len(idempotency_key) <= 200:
        raise RunAPIError(422, "Idempotency-Key: 1..200 символов")
    payload = _model(await _json_body(request, manager(request).limits.max_chunk_bytes), RunCreateRequest)
    job, created = manager(request).create(request.state.owner, payload, idempotency_key)
    return JSONResponse(job.public(), status_code=201 if created else 200)


@router.post("/{run_id}/files")
async def upload_files(run_id: str, request: Request):
    service = manager(request)
    job = service.store.get(request.state.owner, run_id)
    payload = _model(await _json_body(request, service.limits.max_chunk_bytes), RunChunkRequest)
    return service.upload(job, payload)


@router.post("/{run_id}/start")
async def start_run(run_id: str, request: Request):
    service = manager(request)
    job = service.store.get(request.state.owner, run_id)
    job = await service.start(job)
    return job.public()


@router.get("/{run_id}")
async def get_run(run_id: str, request: Request):
    return manager(request).store.get(request.state.owner, run_id).public()


@router.get("/{run_id}/files")
async def get_files(run_id: str, request: Request, offset: int = Query(default=0, ge=0),
                    limit: int | None = Query(default=None, ge=1)):
    service = manager(request)
    job = service.store.get(request.state.owner, run_id)
    actual_limit = limit or service.limits.default_page_limit
    if actual_limit > service.limits.max_page_limit:
        raise RunAPIError(422, f"limit не больше {service.limits.max_page_limit}")
    if offset > job.material_count:
        raise RunAPIError(422, "offset превышает material_count")
    return service.store.read_results(job, offset, actual_limit)


def _cursor(after: int | None, last_event_id: str | None) -> int:
    if after is not None:
        return after
    if last_event_id is None or not last_event_id.strip():
        return 0
    try:
        return int(last_event_id)
    except ValueError as exc:
        raise RunAPIError(409, "Last-Event-ID должен быть числовым seq") from exc


@router.get("/{run_id}/events")
async def events(run_id: str, request: Request, after: int | None = Query(default=None),
                 last_event_id: str | None = Header(default=None, alias="Last-Event-ID")):
    service = manager(request)
    job = service.store.get(request.state.owner, run_id)
    cursor = _cursor(after, last_event_id)
    service.store.validate_cursor(job, cursor)
    queue = service.store.subscribe(job)

    async def stream():
        sent = cursor
        try:
            for event in service.store.events_after(job, cursor):
                sent = event["seq"]
                yield f"id: {sent}\ndata: {json.dumps(event, ensure_ascii=False, separators=(',', ':'))}\n\n"
            while True:
                if job.status in TERMINAL_STATUSES and sent >= job.event_seq:
                    return
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=service.limits.heartbeat_s)
                except TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                if event["type"] == "resync_required":
                    yield f"event: error\ndata: {json.dumps({**event, 'code': 409}, ensure_ascii=False)}\n\n"
                    return
                if event["seq"] <= sent:
                    continue
                sent = event["seq"]
                yield f"id: {sent}\ndata: {json.dumps(event, ensure_ascii=False, separators=(',', ':'))}\n\n"
        finally:
            service.store.unsubscribe(job, queue)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
    })


@router.post("/{run_id}/cancel")
async def cancel_run(run_id: str, request: Request):
    service = manager(request)
    job = service.store.get(request.state.owner, run_id)
    job = await service.cancel(job)
    return job.public()
