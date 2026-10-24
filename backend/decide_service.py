"""Legacy /api/decide orchestration, kept separate from the FastAPI adapter."""

from __future__ import annotations

import asyncio
import time

import httpx

from backend import clef
from backend import fast_batch
from backend import model_manager as mm
from backend import remote_llm
from backend.schemas import DecideRequest, build_sglang_payload


async def decide_one(entry: mm.ModelEntry, payload: dict, *, check_status: bool = True) -> dict:
    if check_status:
        status = await mm.model_status(entry)
        if status["status"] != "running":
            return {"ok": False, "error": mm.not_running_message(entry, status["status"])}
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=mm.REQUEST_TIMEOUT) as client:
            resp = await client.post(f"{entry.url}/v1/decisions", json=payload,
                                     headers=mm._auth_headers(entry))
    except httpx.HTTPError as e:
        return {"ok": False, "error": f"Сервер недоступен по адресу {entry.url}: {e}"}
    duration_s = time.perf_counter() - t0
    if resp.status_code == 400:
        try:
            detail = resp.json()
            if isinstance(detail, dict):
                detail = detail.get("detail") or detail.get("message") or resp.text
        except Exception:
            detail = resp.text
        return {"ok": False, "error": str(detail)}
    if resp.status_code != 200:
        return {"ok": False, "error": f"Неожиданный ответ сервера (HTTP {resp.status_code}): {resp.text[:500]}"}
    data = resp.json()
    answers = data.get("answers", {})
    usage = data.get("usage") or {}
    prompt_tokens = usage.get("prompt_tokens")
    mass_min, mass_avg = mm.label_mass_metrics(answers)
    metrics = {
        "duration_s": round(duration_s, 2),
        "prompt_tokens": prompt_tokens,
        "prefill_tok_s": round(prompt_tokens / duration_s, 1) if prompt_tokens else None,
        "label_mass_min": mass_min,
        "label_mass_avg": mass_avg,
        "rss_gb": mm.rss_gb_for(entry),
        "mode": "decisions",
    }
    return {
        "ok": True,
        "answers": answers,
        "usage": usage,
        "prompt_format_version": data.get("prompt_format_version"),
        "metrics": metrics,
    }


async def run_decide(req: DecideRequest):
    unknown = [k for k in req.models if k not in mm.REGISTRY]
    if unknown:
        return 422, {"detail": f"Неизвестные модели: {', '.join(unknown)}"}
    disabled = [k for k in req.models if not mm.REGISTRY[k].enabled]
    if disabled:
        return 422, {"detail": f"Модели отключены в менеджере моделей: {', '.join(disabled)}"}
    if req.images:
        if req.mode == "fast_batch":
            return 422, {"detail": "Быстрый режим не поддерживает изображения"}
        no_vision = [k for k in req.models if not mm.REGISTRY[k].vision]
        if no_vision:
            names = ", ".join(no_vision)
            return 422, {"detail": (
                f"Модель не поддерживает изображения: {names}. "
                "Снимите с них выбор или уберите изображения.")}

    def task(entry: mm.ModelEntry):
        # SystemOne делает один проход на все вопросы; run mode и температура
        # на этот протокол не влияют.
        if entry.api == "systemone" and not remote_llm.is_chat_entry(entry):
            return clef.run(entry, req)
        if remote_llm.is_chat_entry(entry):
            return remote_llm.run_decide(entry, req)
        if req.mode == "fast_batch":
            return fast_batch.run(entry, req.questions, req.input)
        return decide_one(entry, payload)

    payload = build_sglang_payload(req)
    results = await asyncio.gather(*(task(mm.REGISTRY[key]) for key in req.models))
    return 200, {"results": dict(zip(req.models, results))}
