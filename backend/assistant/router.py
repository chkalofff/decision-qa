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
from backend.assistant import analysis as analysis_mod
from backend.assistant import journal
from backend.assistant import receipts as receipts_mod
from backend.assistant import trial as trial_mod
from backend.assistant.prompts import serialize_snapshot, snapshot_max_chars
from backend.assistant.proposal_checks import validate_against_snapshot
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
    owner = request.state.owner
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
    # id сессии-вкладки с фронта (v1.2): сквозная привязка ходов в журнале;
    # старый клиент без поля — None, не ошибка
    session_id = str(data.get("session_id") or "")[:64] or None
    # Квитанции исходов карточек (A4): дрейн очереди сессии — «прочитано =
    # удалено»; уходят в контекст этого хода и в запись журнала.
    receipts = receipts_mod.STORE.drain(session_id, owner=owner) if session_id else []
    # флаги хода с фронта (A4): прошлый ответ прерван пользователем; состояние
    # менялось в другой вкладке (storage-event на ключ воркспейса)
    prev_aborted = bool(data.get("prev_aborted"))
    external_change = bool(data.get("external_change"))
    # Потолок снапшота — от контекста выбранной chat-модели (32k → 8К симв.,
    # ≥128k → 16К, ≥256k → 20К; внешние облачные без context_length — 12К).
    snapshot_chars = snapshot_max_chars(remote_llm.is_chat_entry(entry),
                                        entry.context_length)

    async def read_get_state(_args=None):
        return {"ok": True, "state": snapshot or {}}

    async def read_list_presets(_args=None):
        return {"ok": True, "presets": [
            {"slug": p["slug"], "name": p.get("name"), "page": p.get("page"),
             "description": p.get("description"), "source": p.get("source")}
            for p in preset_store.list_presets(owner=owner)]}

    def selected_keys() -> set[str]:
        keys = set()
        for item in (snapshot or {}).get("selectedModels") or []:
            key = item.get("key") if isinstance(item, dict) else item
            if isinstance(key, str):
                keys.add(key)
        return keys

    async def read_list_models(_args=None):
        selected = selected_keys()
        out = []
        for e in mm.REGISTRY.values():
            st = await mm.model_status(e)
            out.append({"key": e.key, "label": e.label, "type": e.type,
                        "status": st.get("status"), "vision": st.get("vision"),
                        "roles": list(e.roles), "enabled": e.enabled,
                        "selected": e.key in selected})
        return {"ok": True, "models": out}

    async def read_get_file_result(args=None):
        name = str((args or {}).get("file") or "").strip()
        files = (snapshot or {}).get("batchFiles") or []
        entry = next((f for f in files
                      if isinstance(f, dict) and f.get("name") == name), None)
        if entry is None:
            return {"ok": False,
                    "error": f"Файл {name!r} не найден в снапшоте.",
                    "available": [f.get("name") for f in files
                                  if isinstance(f, dict)]}
        out = {"ok": True, "file": name,
               "imagesCount": entry.get("imagesCount") or 0}
        if entry.get("text"):
            out["text"] = entry["text"]
        results = ((snapshot or {}).get("batchResults") or {}).get(name)
        if results:
            out["results"] = results
        else:
            out["note"] = "Результатов прогона по этому файлу нет."
        return out

    async def read_get_result(_args=None):
        snap = snapshot or {}
        out = {"ok": True}
        if snap.get("singleResults"):
            out["results"] = snap["singleResults"]
        else:
            out["note"] = "Результатов одиночного прогона нет."
        if snap.get("decisionTrace"):
            out["decisionTrace"] = snap["decisionTrace"]
        return out

    # Детерминированный анализ прогона (analysis.py): считается из снапшота
    # запроса, без LLM; payload уходит и модели (для именования причин), и
    # фронту SSE-событием (карточки «Разбор прогона» / «Очередь разметки»).
    async def action_analyze_run(_args=None):
        payload = analysis_mod.compute_run_analysis(snapshot)
        return {"ok": True, "analysis": payload}, [
            {"type": "analysis", "analysis": payload}]

    async def action_review_queue(args=None):
        try:
            limit = int((args or {}).get("limit") or 5)
        except (TypeError, ValueError):
            limit = 5
        payload = analysis_mod.compute_review_queue(snapshot or {}, limit=limit)
        return {"ok": True, "queue": payload}, [
            {"type": "review_queue", "queue": payload}]

    read_tools = {"get_state": read_get_state,
                  "list_presets": read_list_presets,
                  "list_models": read_list_models,
                  "get_file_result": read_get_file_result,
                  "get_result": read_get_result}
    action_tools = {"run_trial": trial_mod.run_trial_limited(
                        snapshot, session_id=session_id),
                    "analyze_run": action_analyze_run,
                    "review_queue": action_review_queue}

    if remote_llm.is_chat_entry(entry):
        # Облачная chat-модель: нативный OpenAI tool calling (agent сам ходит
        # в API провайдера); фолбэк — hermes-разметка в content.
        stream = agent.run_remote_agent(history, message, snapshot, entry,
                                        read_tools, action_tools,
                                        thinking=thinking, vision=entry.vision,
                                        snapshot_chars=snapshot_chars,
                                        receipts=receipts,
                                        prev_aborted=prev_aborted,
                                        external_change=external_change)
    else:
        # Локальные (sglang, bonsai): hermes-парсинг tool_call из content.
        stream = agent.run_agent(history, message, snapshot, chat_url, thinking,
                                 read_tools, action_tools, vision=entry.vision,
                                 snapshot_chars=snapshot_chars,
                                 receipts=receipts,
                                 prev_aborted=prev_aborted,
                                 external_change=external_change)
    # Общая обёртка журнала над обоими агентами, файл выбран по owner.
    serialized = serialize_snapshot(snapshot, max_chars=snapshot_chars)
    full_len = len(serialize_snapshot(snapshot, max_chars=10**9))
    stream = journal.log_chat_stream(
        stream, model_key=model_key, remote=remote_llm.is_chat_entry(entry),
        user_message=message, snapshot_budget=snapshot_chars,
        snapshot_chars=len(serialized) if snapshot else 0,
        snapshot_truncated=len(serialized) < full_len, thinking=thinking,
        session_id=session_id, owner=owner,
        receipts_injected=[{k: r.get(k) for k in ("kind", "outcome",
                                                  "proposal_id")}
                           for r in receipts])
    return StreamingResponse(stream, media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


_CARD_OUTCOMES = {"applied", "declined", "undone", "invalid"}


@router.post("/trial/abort")
async def assistant_trial_abort(request: Request):
    """«Прервать» на живой карточке пробного прогона (макет 4.2): помечает
    активный прогон сессии к остановке — незавершённые шаги отменяются,
    в SSE-поток уходит trial-событие с частичным результатом (aborted:true).
    Активного прогона нет → 409 (гонка «клик после финала» — безошибочно)."""
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return JSONResponse(status_code=422, content={"detail": "Невалидный JSON"})
    session_id = str(data.get("session_id") or "")[:64] or None
    if session_id and trial_mod.abort_trial(session_id):
        journal.append_record({
            "type": "event", "event": "trial_aborted",
            "session_id": session_id,
        }, owner=request.state.owner)
        return {"ok": True}
    return JSONResponse(status_code=409, content={
        "detail": "Активного пробного прогона нет — видимо, уже завершился."})


@router.post("/event")
async def assistant_event(request: Request):
    """Бикон исходов карточек с фронта (v0.8): принято/отклонено/отменено/
    невалидно — строкой type:"event" в тот же журнал assistant.jsonl.
    A4: с session-id квитанция дополнительно кладётся в очередь сессии
    (receipts.py) и уходит в контекст следующего хода — замкнутый контур;
    журнал пишется по-прежнему (аудит A1 работает по журналу)."""
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return JSONResponse(status_code=422, content={"detail": "Невалидный JSON"})
    kind = str(data.get("kind") or "")[:64]
    outcome = str(data.get("outcome") or "")[:32]
    if not kind or outcome not in _CARD_OUTCOMES:
        return JSONResponse(status_code=422, content={
            "detail": "Поля kind и outcome обязательны; outcome — один из "
                      f"{sorted(_CARD_OUTCOMES)}"})
    session_id = str(data.get("session_id") or "")[:64] or None
    journal.append_record({
        "type": "event", "event": "card_outcome", "kind": kind,
        "outcome": outcome,
        "proposal_id": str(data.get("proposal_id") or "")[:16] or None,
        "detail": str(data.get("detail") or "")[:300] or None,
        "session_id": session_id,
    }, owner=request.state.owner)
    if session_id:
        receipts_mod.STORE.put(session_id, {
            "event_id": str(data.get("event_id") or "")[:80] or None,
            "kind": kind,
            "outcome": outcome,
            "proposal_id": str(data.get("proposal_id") or "")[:16] or None,
            "title": str(data.get("title") or "")[:120] or None,
            "detail": str(data.get("detail") or "")[:300] or None,
            "post_state": str(data.get("post_state") or "")[:200] or None,
            "revision": str(data.get("revision") or "")[:16] or None,
        }, owner=request.state.owner)
    return {"ok": True}


@router.post("/propose/validate")
async def validate_proposal(request: Request):
    """Сухая валидация payload предложения — ЕДИНЫЙ базис валидации карточек
    (A3): та же пара validate_args (схема) + validate_against_snapshot
    (state-зависимые проверки по id-пространству «реальные + предложенные
    этим ходом»), что и в агентном цикле. Фронт передаёт облегчённый снапшот
    {questions, batchFiles} (для propose_decision — виртуальный набор хода,
    если карточка вопросов уже показана); без снапшота — только схема."""
    data = await request.json()
    payload = data.get("payload")
    snapshot = data.get("snapshot") if isinstance(data.get("snapshot"), dict) \
        else None
    # Expanded-payload ops-карточки (бэк разворачивает edits в итоговый набор):
    # edits там — превью-метаданные, применяется итоговый questions как replace;
    # без срезки edits сухая валидация отвергала бы такие карточки мьютексом
    # «либо edits, либо questions+mode».
    if (data.get("kind") == "propose_questions" and isinstance(payload, dict)
            and payload.get("mode") == "replace" and payload.get("questions")
            and payload.get("edits")):
        payload = {k: v for k, v in payload.items() if k != "edits"}
    args, error = validate_args(data.get("kind", ""), payload)
    if error:
        return JSONResponse(status_code=422, content={"detail": error})
    error = validate_against_snapshot(data.get("kind", ""), args, snapshot)
    if error:
        return JSONResponse(status_code=422, content={"detail": error})
    return {"ok": True}
