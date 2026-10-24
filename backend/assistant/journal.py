"""JSONL-журнал диалогов ассистента (наблюдаемость, v0.8).

Одна строка на запрос /api/assistant/chat (type:"chat") и одна на событие
с фронта (type:"event" — бикон исходов карточек). Журналы разделены по
owner в server/state/users/<owner>/assistant.jsonl. Прежний общий файл
лениво переносится только в local с резервной копией. Ротация по размеру:
за CAP вырастает — оставляем хвост KEEP байт. Журнал не должен ронять чат:
любые ошибки записи глотаем с warning."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from backend.auth import safe_owner

log = logging.getLogger("decision_qa.assistant")

JOURNAL_PATH = (Path(__file__).resolve().parent.parent.parent
                / "server" / "logs" / "assistant.jsonl")
LEGACY_JOURNAL_PATH = JOURNAL_PATH
STATE_USERS_DIR = (Path(__file__).resolve().parent.parent.parent
                   / "server" / "state" / "users")
_MAX_BYTES = 5 * 1024 * 1024   # ротация
_KEEP_BYTES = 2 * 1024 * 1024  # хвост, который остаётся после ротации

_USER_CHARS = 500    # сообщение пользователя в записи
_ANSWER_CHARS = 500  # превью финального ответа
_EVENT_CHARS = 300   # message/error поля событий


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def journal_path(owner: str = "local") -> Path:
    owner = safe_owner(owner)
    if owner == "local" and JOURNAL_PATH != LEGACY_JOURNAL_PATH:
        return JOURNAL_PATH  # monkeypatch-совместимость существующих тестов
    return STATE_USERS_DIR / owner / "assistant.jsonl"


def _migrate_local_legacy(path: Path) -> None:
    if JOURNAL_PATH != LEGACY_JOURNAL_PATH or not LEGACY_JOURNAL_PATH.exists() \
            or path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    shutil.copy2(LEGACY_JOURNAL_PATH, tmp)
    os.replace(tmp, path)
    backup = LEGACY_JOURNAL_PATH.with_name(LEGACY_JOURNAL_PATH.name + ".pre-owner-migration.bak")
    n = 2
    while backup.exists():
        backup = LEGACY_JOURNAL_PATH.with_name(
            LEGACY_JOURNAL_PATH.name + f".pre-owner-migration-{n}.bak")
        n += 1
    os.replace(LEGACY_JOURNAL_PATH, backup)


def append_record(record: dict, owner: str = "local") -> None:
    """Дописать строку в журнал owner (+ротация). Ошибки — только warning."""
    record.setdefault("ts", _now())
    try:
        path = journal_path(owner)
        if owner == "local":
            _migrate_local_legacy(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False, default=str)
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
        if path.stat().st_size > _MAX_BYTES:
            data = path.read_bytes()[-_KEEP_BYTES:]
            nl = data.find(b"\n")
            if nl != -1:
                data = data[nl + 1:]
            path.write_bytes(data)
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
                          thinking: bool = False,
                          session_id: str | None = None,
                          receipts_injected: list | None = None,
                          owner: str = "local"):
    """Обёртка над SSE-генератором агента (run_agent / run_remote_agent —
    общая точка, чтобы не плодить рассинхрон двух циклов). Накапливает
    запись по проходящим событиям и пишет строку при завершении стрима:
    outcome = done / error / abort (клиент отвалился) / incomplete."""
    rec = {
        "type": "chat",
        "model_key": model_key,
        "remote": remote,
        # id вкладки-сессии с фронта (v1.2); None у старых клиентов
        "session_id": session_id,
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
    # Квитанции, ушедшие в контекст этого хода (A4) — видны в записи для
    # аудита (журнал остаётся источником журнального анализа).
    if receipts_injected:
        rec["receipts_injected"] = receipts_injected
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
                    rec_trial = {"models": trial.get("models") or [],
                                 "ok": trial.get("ok", True)}
                    if trial.get("aborted"):
                        # прерванный прогон (макет 4.12): координаты обрыва
                        rec_trial["aborted"] = True
                        rec_trial["step"] = trial.get("step")
                        rec_trial["total"] = trial.get("total")
                    rec.setdefault("trials", []).append(rec_trial)
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
        append_record(rec, owner=owner)
