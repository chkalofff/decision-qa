"""Квитанции исходов карточек (A4): очередь receipts.py (TTL, cap,
«прочитано = удалено», idempotency-key), ревизия состояния (канонизация —
зеркало canonicalState/stateRevision на фронте), формат инжекции в контекст,
эндпоинты /api/assistant/event (бикон → журнал + очередь) и /chat (дрейн →
user-сообщение перед сообщением пользователя + поле receipts_injected в
журнале)."""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.assistant import journal, receipts
from backend.assistant.receipts import (ReceiptStore, canonical_state,
                                        format_turn_events,
                                        revision_of_snapshot)

client = TestClient(app_module.app)


@pytest.fixture
def fresh_store(monkeypatch):
    """Изолированный STORE для эндпоинт-тестов (синглтон процесса)."""
    store = ReceiptStore()
    monkeypatch.setattr(receipts, "STORE", store)
    return store


# ---------------------------------------------------------------- очередь

def test_store_put_drain_and_idempotency():
    s = ReceiptStore()
    r = {"event_id": "p1:applied", "kind": "propose_questions",
         "outcome": "applied"}
    assert s.put("sess", dict(r)) is True
    # idempotency-key: повторная доставка — дубля нет, put сигналит False
    assert s.put("sess", dict(r)) is False
    # другой outcome той же карточки — другой ключ, встаёт
    assert s.put("sess", {"event_id": "p1:undone", "kind": "propose_questions",
                          "outcome": "undone"}) is True
    # без session_id не кладём (старый клиент — только журнал)
    assert s.put("", dict(r)) is False
    out = s.drain("sess")
    assert [x["outcome"] for x in out] == ["applied", "undone"]
    assert all("_ts" not in x for x in out), "внутренние поля не утекают"
    # прочитано = удалено
    assert s.drain("sess") == []
    assert s.drain("другая сессия") == []


def test_store_ttl_and_caps():
    clock = [1000.0]
    s = ReceiptStore(ttl_s=60, cap_per_session=3, max_sessions=2,
                     clock=lambda: clock[0])
    for i in range(5):
        assert s.put("a", {"event_id": f"e{i}", "n": i}) is True
    # cap на сессию: остались 3 последних, старейшие вытеснены
    assert [r["n"] for r in s.drain("a")] == [2, 3, 4]
    # TTL: протухшее не доезжает
    s.put("a", {"event_id": "old", "n": 0})
    clock[0] += 61
    s.put("a", {"event_id": "new", "n": 1})
    assert [r["n"] for r in s.drain("a")] == [1]
    # cap сессий: третья вытесняет наименее активную
    s.put("s1", {"n": 1})
    s.put("s2", {"n": 2})
    s.drain("s1")                      # активность s1 свежее s2
    s.put("s3", {"n": 3})              # вытесняет s2
    assert s.drain("s2") == [] and s.drain("s3") == [{"n": 3}]


# ---------------------------------------------------------------- ревизия

SNAP = {
    "questions": [{"n": 1, "id": "q1", "question": "Ок?", "type": "yes_no"},
                  {"n": 2, "id": "q2", "question": "Балл?", "type": "score",
                   "levels": ["п", "о"]}],
    "decision": {"outcomes": [
        {"label": "Брак", "rules": [{"conditions": [
            {"question": "q1", "op": "gte", "answer": "yes",
             "threshold": 80}]}]},
        {"label": "Ок", "isDefault": True, "rules": []}]},
    "context": {"text": "материал"},
    "batchFiles": [{"name": "a.txt"}],
}


def test_revision_canonical_and_stable():
    rev = revision_of_snapshot(SNAP)
    assert rev == "n97pje", \
        "вектор соответствия фронту (stateRevision на том же состоянии)"
    # порядок ключей/лишние поля снапшота ревизию не меняют
    noisy = {"page": "single", **SNAP, "zzz": {"любое": "поле"},
             "questions": [{**q, "direction": "yes", "extra": 1}
                           for q in SNAP["questions"]]}
    assert revision_of_snapshot(noisy) == rev
    # содержательное изменение — другая ревизия
    changed = json.loads(json.dumps(SNAP))
    changed["questions"][0]["question"] = "Другой?"
    assert revision_of_snapshot(changed) != rev
    assert revision_of_snapshot(None) is None
    # каноническая форма — задокументированный контракт
    canon = canonical_state(SNAP)
    assert canon["q"][0] == ["q1", "yes_no", "Ок?"]
    assert canon["d"][0][2][0][1][0] == ["q1", "gte", "yes", 80, None]
    assert canon["c"] == "материал" and canon["b"] == ["a.txt"]


# ---------------------------------------------------------------- формат инжекции

def test_format_turn_events():
    # квитанции по видам исходов + совпадение ревизии — без пометок
    text = format_turn_events([
        {"kind": "propose_questions", "title": "Набор вопросов",
         "outcome": "applied", "post_state": "вопросов: 6", "revision": "r1"},
        {"kind": "propose_decision", "outcome": "declined"},
    ], current_revision="r1")
    assert "«Набор вопросов» (propose_questions) — ПРИНЯТА и применена" in text
    assert "состояние после: вопросов: 6" in text
    assert "ОТКЛОНЕНА пользователем" in text
    assert "менялось" not in text
    # расхождение ревизии ПОСЛЕДНЕЙ квитанции пачки → пометка ручной правки;
    # у более ранней (её ревизия старше следующей квитанции) пометки нет
    text = format_turn_events([
        {"kind": "propose_questions", "outcome": "applied", "revision": "r0"},
        {"kind": "propose_decision", "outcome": "applied", "revision": "r1"},
    ], current_revision="rX")
    lines = text.splitlines()
    assert "менялось" not in lines[1] and "менялось вне карточек" in lines[2]
    # invalid с причиной, undone
    text = format_turn_events([
        {"kind": "propose_decision", "outcome": "invalid",
         "detail": "вопроса «q9» нет"},
        {"kind": "propose_questions", "outcome": "undone"},
    ], None)
    assert "НЕПРИМЕНИМА (невалидна): вопроса «q9» нет" in text
    assert "ОТМЕНЕНА пользователем (откат)" in text
    # abort + внешнее изменение
    text = format_turn_events([], None, prev_aborted=True,
                              external_change=True)
    assert "ответ был прерван пользователем" in text
    assert "менялось в другой вкладке" in text
    # пусто — None (сообщения нет)
    assert format_turn_events([], None) is None
    assert format_turn_events([], "r1") is None, "без квитанций сверки нет"


# ---------------------------------------------------------------- эндпоинты

def test_event_endpoint_queues_receipt(fresh_store, _journal_tmp):
    body = {"kind": "propose_questions", "outcome": "applied",
            "session_id": "s1", "proposal_id": "p1", "event_id": "p1:applied",
            "title": "Набор вопросов", "post_state": "вопросов: 6",
            "revision": "abc"}
    r = client.post("/api/assistant/event", json=body)
    assert r.status_code == 200
    queued = fresh_store.drain("s1")
    assert len(queued) == 1
    assert queued[0]["title"] == "Набор вопросов"
    assert queued[0]["post_state"] == "вопросов: 6"
    assert queued[0]["revision"] == "abc"
    # двойная доставка (ретрай/двойной клик) — дубля в очереди нет
    client.post("/api/assistant/event", json=body)
    assert fresh_store.drain("s1") == [], "очередь уже была сдрейнена"
    # журнал пишется по-прежнему (аудит A1)
    rec = [json.loads(line) for line in _journal_tmp.read_text().splitlines()]
    ev = [x for x in rec if x.get("type") == "event"]
    assert ev and ev[-1]["outcome"] == "applied" and ev[-1]["session_id"] == "s1"
    # без session_id — только журнал, очередь пуста
    client.post("/api/assistant/event", json={
        "kind": "propose_run", "outcome": "declined"})
    assert fresh_store.drain("s1") == []


@pytest.fixture
def _journal_tmp():
    return journal.JOURNAL_PATH  # редирект в tmp — conftest.py


class _FakeRouterClient:
    """Подмена httpx.AsyncClient для роутера: get() — проба /v1/models,
    stream() — chat completions с заготовленными строками."""

    stream_responses: list[list[str]] = []
    stream_requests: list[dict] = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, **kwargs):
        return type("R", (), {"status_code": 200})()

    def stream(self, method, url, json=None, **kwargs):
        _FakeRouterClient.stream_requests.append({"json": json})
        idx = len(_FakeRouterClient.stream_requests) - 1
        lines = _FakeRouterClient.stream_responses[idx]
        lines = lines + ["data: [DONE]"]

        class Resp:
            status_code = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def aiter_lines(self):
                for line in lines:
                    yield line
        return Resp()


def _sse_text(text: str) -> list[str]:
    return ["data: " + json.dumps({"choices": [{"delta": {"content": text}}]},
                                   ensure_ascii=False)]


def test_chat_drains_receipts_into_context(fresh_store, monkeypatch,
                                           _journal_tmp):
    """Ход с session-id: очередь дрейнится, квитанции — user-сообщением перед
    сообщением пользователя (снапшот важнее квитанции: расхождение ревизии —
    пометка), запись журнала несёт receipts_injected."""
    _FakeRouterClient.stream_responses = [_sse_text("Понял."),
                                          _sse_text("И дальше."),
                                          _sse_text("Хорошо.")]
    _FakeRouterClient.stream_requests = []
    monkeypatch.setattr(httpx, "AsyncClient", _FakeRouterClient)
    snap = {"questions": [{"n": 1, "id": "q1", "question": "Ок?",
                           "type": "yes_no"}]}
    rev = revision_of_snapshot(snap)
    # квитанция со СТАРОЙ ревизией (ручная правка после применения)
    fresh_store.put("s-chat", {"kind": "propose_questions",
                               "outcome": "applied", "title": "Набор вопросов",
                               "post_state": "вопросов: 1", "revision": "old"})
    r = client.post("/api/assistant/chat", json={
        "model_key": "qwen38-27b-4bit", "message": "ок", "snapshot": snap,
        "session_id": "s-chat"})
    assert r.status_code == 200
    msgs = _FakeRouterClient.stream_requests[0]["json"]["messages"]
    evt = msgs[-2]
    assert evt["role"] == "user" and msgs[-1]["content"] == "ок"
    assert "ПРИНЯТА и применена" in evt["content"]
    assert "вопросов: 1" in evt["content"]
    assert "состояние менялось вне карточек" in evt["content"]
    # «прочитано = удалено»: второй ход той же сессии — без квитанций
    client.post("/api/assistant/chat", json={
        "model_key": "qwen38-27b-4bit", "message": "и?", "snapshot": snap,
        "session_id": "s-chat"})
    msgs2 = _FakeRouterClient.stream_requests[1]["json"]["messages"]
    assert not any("ПРИНЯТА" in str(m.get("content")) for m in msgs2)
    # флаги хода: abort прошлого ответа + внешнее изменение
    client.post("/api/assistant/chat", json={
        "model_key": "qwen38-27b-4bit", "message": "дальше",
        "snapshot": snap, "session_id": "s-chat", "prev_aborted": True,
        "external_change": True})
    msgs3 = _FakeRouterClient.stream_requests[2]["json"]["messages"]
    assert "ответ был прерван пользователем" in msgs3[-2]["content"]
    assert "менялось в другой вкладке" in msgs3[-2]["content"]
    # журнал: receipts_injected в записи type:"chat" первого хода
    recs = [json.loads(line)
            for line in _journal_tmp.read_text().splitlines()]
    chats = [x for x in recs if x.get("type") == "chat"]
    assert chats[0]["receipts_injected"] == [
        {"kind": "propose_questions", "outcome": "applied",
         "proposal_id": None}]
    assert "receipts_injected" not in chats[1]
