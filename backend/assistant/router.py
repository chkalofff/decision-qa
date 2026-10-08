"""HTTP-эндпоинты ассистента: /api/assistant/chat (SSE), /api/assistant/models."""
from __future__ import annotations

import json

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from backend import model_manager as mm
from backend import preset_store
from backend import remote_llm
from backend.assistant import agent
from backend.assistant import trial as trial_mod
from backend.assistant.tools import validate_args

router = APIRouter(prefix="/api/assistant")

def _chat_models() -> list[dict]:
    """Модели с ролью "chat" (пригодные для chat completions ассистента)."""
    return [{"key": e.key, "label": e.label, "remote": remote_llm.is_chat_entry(e)}
            for e in mm.REGISTRY.values()
            if "chat" in e.roles and e.enabled]


@router.get("/models")
async def assistant_models():
    """Модели, пригодные для ассистента (роль chat)."""
    return {"models": _chat_models()}


async def _resolve_chat_url(model_key: str) -> tuple[str | None, mm.ModelEntry | None,
                                                    JSONResponse | None]:
    """→ (chat_url, entry, ошибка). Для облачной chat-модели chat_url = None —
    вместо проксирования стрима агент вызывает remote_llm.remote_chat."""
    entry = mm.REGISTRY.get(model_key)
    if not entry or "chat" not in entry.roles:
        return None, None, JSONResponse(status_code=422, content={
            "detail": f"Модель {model_key!r} не подходит для ассистента. "
                      f"Доступные: {[m['key'] for m in _chat_models()]}"})
    if remote_llm.is_chat_entry(entry):
        if not remote_llm.has_key(entry.api, entry.key):
            return None, None, JSONResponse(status_code=409, content={
                "detail": f"У модели «{entry.label}» нет API-ключа. "
                          "Задайте его на странице «Модели»."})
        return None, entry, None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{entry.url}/v1/models")
        if r.status_code != 200:
            raise httpx.ConnectError("bad status")
    except Exception:
        return None, None, JSONResponse(status_code=409, content={
            "detail": f"Модель «{entry.label}» не запущена. "
                      f"Запустите её чипом в верхнем баре."})
    return f"{entry.url}/v1/chat/completions", entry, None


@router.post("/chat")
async def assistant_chat(request: Request):
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return JSONResponse(status_code=422, content={"detail": "Невалидный JSON"})
    message = (data.get("message") or "").strip()
    if not message:
        return JSONResponse(status_code=422, content={"detail": "Пустое сообщение"})
    model_key = data.get("model_key") or ""
    chat_url, entry, error = await _resolve_chat_url(model_key)
    if error:
        return error
    history = data.get("history") or []
    if not isinstance(history, list):
        history = []
    history = [m for m in history
               if isinstance(m, dict) and m.get("role") in ("user", "assistant")
               and isinstance(m.get("content"), str)]
    snapshot = data.get("snapshot") if isinstance(data.get("snapshot"), dict) else None
    thinking = bool(data.get("thinking"))

    async def read_get_state():
        return {"ok": True, "state": snapshot or {}}

    async def read_list_presets():
        return {"ok": True, "presets": [
            {"slug": p["slug"], "name": p.get("name"), "page": p.get("page"),
             "description": p.get("description"), "source": p.get("source")}
            for p in preset_store.list_presets()]}

    async def read_list_models():
        out = []
        for e in mm.REGISTRY.values():
            st = await mm.model_status(e)
            out.append({"key": e.key, "label": e.label, "type": e.type,
                        "status": st.get("status"), "vision": st.get("vision")})
        return {"ok": True, "models": out}

    read_tools = {"get_state": read_get_state,
                  "list_presets": read_list_presets,
                  "list_models": read_list_models}
    action_tools = {"run_trial": lambda args: trial_mod.run_trial(snapshot, args)}

    if remote_llm.is_chat_entry(entry):
        # Облачная chat-модель: нативный OpenAI tool calling (agent сам ходит
        # в API провайдера); фолбэк — hermes-разметка в content.
        stream = agent.run_remote_agent(history, message, snapshot, entry,
                                        read_tools, action_tools,
                                        thinking=thinking)
    else:
        # Локальные (sglang, bonsai): hermes-парсинг tool_call из content.
        stream = agent.run_agent(history, message, snapshot, chat_url, thinking,
                                 read_tools, action_tools)
    return StreamingResponse(stream, media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@router.post("/propose/validate")
async def validate_proposal(request: Request):
    """Сухая валидация payload предложения (используется тестами и UI-предпросмотром)."""
    data = await request.json()
    args, error = validate_args(data.get("kind", ""), data.get("payload"))
    if error:
        return JSONResponse(status_code=422, content={"detail": error})
    return {"ok": True}
