"""JSONL-журнал диалогов ассистента (наблюдаемость, v0.8).

Одна строка на запрос /api/assistant/chat (type:"chat") и одна на событие
с фронта (type:"event" — бикон исходов карточек). Файл
server/logs/assistant.jsonl, ротация по размеру: за CAP вырастает —
оставляем хвост KEEP байт. Журнал не должен ронять чат: любые ошибки
записи глотаем с warning."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("decision_qa.assistant")

JOURNAL_PATH = (Path(__file__).resolve().parent.parent.parent
                / "server" / "logs" / "assistant.jsonl")
_MAX_BYTES = 5 * 1024 * 1024   # ротация
_KEEP_BYTES = 2 * 1024 * 1024  # хвост, который остаётся после ротации

_USER_CHARS = 500    # сообщение пользователя в записи
_ANSWER_CHARS = 500  # превью финального ответа
_EVENT_CHARS = 300   # message/error поля событий


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def append_record(record: dict) -> None:
    """Дописать строку в журнал (+ротация). Ошибки — только warning."""
    record.setdefault("ts", _now())
    try:
        JOURNAL_PATH.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False, default=str)
        with JOURNAL_PATH.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
        if JOURNAL_PATH.stat().st_size > _MAX_BYTES:
            data = JOURNAL_PATH.read_bytes()[-_KEEP_BYTES:]
            nl = data.find(b"\n")
            if nl != -1:
                data = data[nl + 1:]
            JOURNAL_PATH.write_bytes(data)
    except OSError as e:
        log.warning("журнал ассистента: запись не удалась — %s", e)


def _parse_event(line: str) -> dict | None:
    if not line.startswith("data: "):
        return None
    try:
        return json.loads(line[len("data: "):])
    except json.JSONDecodeError:
        return None


async def log_chat_stream(stream, *, model_key: str, remote: bool,
                          user_message: str, snapshot_budget: int,
                          snapshot_chars: int, snapshot_truncated: bool,
                          thinking: bool = False):
    """Обёртка над SSE-генератором агента (run_agent / run_remote_agent —
    общая точка, чтобы не плодить рассинхрон двух циклов). Накапливает
    запись по проходящим событиям и пишет строку при завершении стрима:
    outcome = done / error / abort (клиент отвалился) / incomplete."""
    rec = {
        "type": "chat",
        "model_key": model_key,
        "remote": remote,
        "user": (user_message or "")[:_USER_CHARS],
        "snapshot": {"budget": snapshot_budget, "chars": snapshot_chars,
                     "truncated": snapshot_truncated},
        "steps": [],
        "proposals": [],
        "fallback": False,  # был запасной шаг при исчерпании MAX_STEPS
        "thinking": thinking,  # запрошен режим рассуждений
        "answer_chars": 0,
        "answer_preview": "",
    }
    started = time.monotonic()
    step_started: dict[str, tuple[float, str | None]] = {}
    outcome: str | None = None
    completed = False
    try:
        async for line in stream:
            payload = _parse_event(line)
            if payload:
                t = payload.get("type")
                if t == "tool":
                    name = str(payload.get("name") or "")
                    status = payload.get("status")
                    if status == "start":
                        step_started[name] = (time.monotonic(),
                                              payload.get("args"))
                    else:
                        step = {"tool": name, "status": status}
                        start = step_started.pop(name, None)
                        if start is not None:
                            step["ms"] = round((time.monotonic() - start[0]) * 1000)
                            if start[1]:
                                step["args"] = start[1]
                        elif payload.get("args"):
                            # упал на валидации до start-события — args в error
                            step["args"] = str(payload["args"])[:_EVENT_CHARS]
                        msg = payload.get("message")
                        if msg:
                            step["message"] = str(msg)[:_EVENT_CHARS]
                        rec["steps"].append(step)
                        if name == "steps":
                            rec["fallback"] = True
                elif t == "proposal":
                    prop = payload.get("proposal") or {}
                    if prop.get("kind"):
                        rec["proposals"].append({
                            "kind": prop["kind"],
                            # id — привязка биконов исходов (applied/declined/
                            # invalid) к ходу, предложившему карточку
                            "id": prop.get("id"),
                            "payload": json.dumps(prop.get("payload"),
                                                  ensure_ascii=False,
                                                  default=str)[:1500],
                        })
                elif t == "trial":
                    trial = payload.get("trial") or {}
                    rec.setdefault("trials", []).append(
                        {"models": trial.get("models") or [],
                         "ok": trial.get("ok", True)})
                elif t == "token":
                    text = payload.get("text") or ""
                    rec["answer_chars"] += len(text)
                    if len(rec["answer_preview"]) < _ANSWER_CHARS:
                        rec["answer_preview"] = (
                            rec["answer_preview"] + text)[:_ANSWER_CHARS]
                elif t == "error":
                    outcome = "error"
                    rec["error"] = str(payload.get("message") or "")[:_EVENT_CHARS]
                elif t == "done":
                    outcome = outcome or "done"
            yield line
        completed = True
    except (GeneratorExit, asyncio.CancelledError):
        outcome = outcome or "abort"
        raise
    finally:
        if outcome is None:
            outcome = "abort" if not completed else "incomplete"
        rec["outcome"] = outcome
        rec["duration_ms"] = round((time.monotonic() - started) * 1000)
        append_record(rec)
