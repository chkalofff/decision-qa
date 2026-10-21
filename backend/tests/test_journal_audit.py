"""Тесты агрегатора метрик журнала ассистента
(scripts/journal_audit.py, режим --metrics). Фикстуры-записи, офлайн."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "journal_audit", ROOT / "scripts" / "journal_audit.py")
journal_audit = importlib.util.module_from_spec(_spec)
sys.modules["journal_audit"] = journal_audit
_spec.loader.exec_module(journal_audit)

metrics = journal_audit.metrics


def chat_rec(model="m1", preview="ок", steps=(), fallback=False,
             session_id=None, trials=None):
    """Минимальная chat-запись журнала; session_id отсутствует = legacy."""
    rec = {"type": "chat", "model_key": model, "answer_preview": preview,
           "steps": list(steps), "fallback": fallback}
    if session_id is not None:
        rec["session_id"] = session_id
    if trials is not None:
        rec["trials"] = trials
    return rec


def err(tool):
    return {"tool": tool, "status": "error"}


def ok(tool):
    return {"tool": tool, "status": "done"}


def test_metrics_validation_loops():
    """Петля = ≥2 подряд error одного tool; смена tool или done-шаг её
    разрывают; серии 3+ считаются отдельно."""
    m = metrics([
        chat_rec(steps=[err("a"), err("a")]),                  # петля длины 2
        chat_rec(steps=[err("b"), err("b"), err("b")]),        # серия 3+
        chat_rec(steps=[err("a"), err("b"), err("a")]),        # разные tool
        chat_rec(steps=[err("a"), ok("a"), err("a")]),         # разорвано done
        chat_rec(steps=[err("a"), err("a"), ok("c"),
                        err("b"), err("b")]),                  # две петли
        chat_rec(steps=[ok("a")]),                             # чистая
    ])["global"]
    assert m["records"] == 6
    vl = m["validation_loops"]
    assert vl["records"] == 3
    assert vl["loops"] == 4
    assert vl["loops_3plus"] == 1
    assert vl["rate"] == round(3 / 6, 4)


def test_metrics_phantom_guard_fallback():
    """Phantom — claim в ответе без события trial; страж среди steps =
    guard-rescue; fallback — по флагу записи."""
    m = metrics([
        chat_rec(preview="Я прогнал все вопросы"),             # фантом
        chat_rec(preview="Я прогнал все вопросы",              # реальный прогон
                 trials=[{"models": [], "ok": True}]),
        chat_rec(steps=[ok("phantom_guard")]),
        chat_rec(fallback=True),
    ])["global"]
    assert m["phantom"]["records"] == 1
    assert m["phantom"]["rate"] == 0.25
    assert m["guard_rescue"]["records"] == 1
    assert m["fallback"]["records"] == 1


def test_metrics_by_model():
    """Разрез по model_key: метрики считаются внутри каждой модели."""
    m = metrics([
        chat_rec(model="a", preview="Я прогнал все вопросы"),
        chat_rec(model="a"),
        chat_rec(model="b", fallback=True),
    ])
    assert m["by_model"]["a"]["records"] == 2
    assert m["by_model"]["a"]["phantom"]["rate"] == 0.5
    assert m["by_model"]["b"]["records"] == 1
    assert m["by_model"]["b"]["fallback"]["records"] == 1
    assert m["by_model"]["b"]["phantom"]["records"] == 0


def test_metrics_session_buckets_and_legacy():
    """Разрез по длине сессии: bucket'ы 1–3/4–10/11+ по числу ходов с одним
    session_id; записи без session_id (legacy) — в глобальных метриках,
    но не в разрезе сессий."""
    recs = ([chat_rec(session_id="s1") for _ in range(2)]
            + [chat_rec(session_id="s2") for _ in range(5)]
            + [chat_rec(session_id="s3") for _ in range(12)]
            + [chat_rec(preview="Я прогнал все вопросы")])     # legacy
    m = metrics(recs)
    assert m["legacy_records"] == 1
    assert m["global"]["records"] == 20
    assert m["global"]["phantom"]["records"] == 1  # legacy в глобальных
    b = m["by_session_length"]
    assert b["1–3"]["sessions"] == 1 and b["1–3"]["records"] == 2
    assert b["4–10"]["sessions"] == 1 and b["4–10"]["records"] == 5
    assert b["11+"]["sessions"] == 1 and b["11+"]["records"] == 12
    # legacy не попадает в разрез сессий
    assert sum(x["records"] for x in b.values()) == 19
    assert all(x["phantom"]["records"] == 0 for x in b.values())
