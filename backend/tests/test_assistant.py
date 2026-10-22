"""Тесты AI-ассистента: hermes-парсинг tool_call, стрим-фильтр, validate_args,
агентный цикл run_agent (httpx замокан фейком) и роутер /api/assistant/*.

Реальные chat-модели не нужны: run_agent ходит в httpx.AsyncClient.stream(),
который подменяется фейком с заготовленными SSE-строками; проба /v1/models
в роутере подменяется тем же фейком.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import model_manager as mm
from backend import remote_llm
from backend.assistant import agent
from backend.assistant import analysis as analysis_mod
from backend.assistant import journal
from backend.assistant.agent import (_StreamFilter, parse_tool_calls, run_agent,
                                     split_thinking, strip_tool_markup)
from backend.assistant.prompts import (SYSTEM_PROMPT, _MAX_SNAPSHOT_CHARS_REMOTE,
                                       serialize_snapshot, snapshot_max_chars)
from backend.assistant.proposal_checks import (decision_reference_warnings,
                                               expand_question_edits,
                                               validate_against_snapshot)
from backend.assistant.tools import (ACTION_TOOLS, PROPOSAL_TOOLS, TOOL_NAMES,
                                     TOOLS, strict_schema, validate_args)

client = TestClient(app_module.app)

MODEL_A = "qwen38-27b-4bit"   # sglang, chat-capable
MODEL_B = "qwen35-35b-a3b-4bit"
LAYA = "laya-04b-q8"          # llamacpp, chat-capable
CLEF_FLASH = "clef-flash-9b-4bit"  # не chat-capable
JEV = "jev-latest"            # remote, не chat-capable

CHAT_URL = "http://fake-chat/v1/chat/completions"


@pytest.fixture
def _journal_tmp():
    """Путь к tmp-журналу (редирект — в conftest.py)."""
    return journal.JOURNAL_PATH


# ---------------------------------------------------------------- helpers

def sse_lines(*pieces: str) -> list[str]:
    """OpenAI-строки стрима: data: {chunk} на кусок контента + финальный [DONE]."""
    lines = ["data: " + json.dumps({"choices": [{"delta": {"content": p}}]},
                                   ensure_ascii=False)
             for p in pieces]
    lines.append("data: [DONE]")
    return lines


def hermes_call(name: str, params: dict[str, str]) -> str:
    body = "".join(f"<parameter={k}>\n{v}\n</parameter>\n" for k, v in params.items())
    return f"<tool_call><function={name}>\n{body}</function></tool_call>"


async def collect_events(gen) -> list[dict]:
    """Прогоняет run_agent и разбирает SSE-строки в события."""
    events = []
    async for line in gen:
        assert line.startswith("data: ") and line.endswith("\n\n")
        events.append(json.loads(line[len("data: "):]))
    return events


def event_types(events: list[dict]) -> list[str]:
    return [e["type"] for e in events]


class FakeStreamResponse:
    """Подмена ответа client.stream(): async CM + aiter_lines/aread/status_code."""

    def __init__(self, lines: list[str], status_code: int = 200, body: bytes = b""):
        self.status_code = status_code
        self._lines = lines
        self._body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aread(self):
        return self._body


class FakeChatClient:
    """Подмена httpx.AsyncClient для run_agent: stream() отдаёт заготовленные
    SSE-ответы по порядку (один список строк на шаг агента), запросы пишет."""

    responses: list[list[str]] = []
    requests: list[dict] = []
    raise_connect = False
    status_code = 200
    body: bytes = b""

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def stream(self, method, url, json=None, **kwargs):
        if FakeChatClient.raise_connect:
            raise httpx.ConnectError("connection refused")
        FakeChatClient.requests.append({"method": method, "url": url, "json": json})
        idx = len(FakeChatClient.requests) - 1
        assert idx < len(FakeChatClient.responses), "лишний запрос к модели"
        return FakeStreamResponse(FakeChatClient.responses[idx],
                                  FakeChatClient.status_code, FakeChatClient.body)


@pytest.fixture
def fake_chat(monkeypatch):
    FakeChatClient.responses = []
    FakeChatClient.requests = []
    FakeChatClient.raise_connect = False
    FakeChatClient.status_code = 200
    FakeChatClient.body = b""
    monkeypatch.setattr(agent.httpx, "AsyncClient", FakeChatClient)
    return FakeChatClient


def make_read_tools(calls: list[str]) -> dict:
    async def get_state(_args=None):
        calls.append("get_state")
        return {"ok": True, "state": {"mode": "single"}}

    async def list_presets(_args=None):
        calls.append("list_presets")
        return {"ok": True, "presets": []}

    async def list_models(_args=None):
        calls.append("list_models")
        return {"ok": True, "models": []}

    async def get_file_result(args=None):
        calls.append("get_file_result")
        return {"ok": True, "file": (args or {}).get("file")}

    return {"get_state": get_state, "list_presets": list_presets,
            "list_models": list_models, "get_file_result": get_file_result}


# ---------------------------------------------------------------- реестр тулов

def test_tools_registry_sanity():
    assert PROPOSAL_TOOLS == {"propose_questions", "propose_context",
                              "propose_run", "propose_save_preset",
                              "propose_decision"}
    assert PROPOSAL_TOOLS <= TOOL_NAMES
    read = {"get_state", "list_presets", "list_models", "get_file_result",
            "get_result"}
    assert read <= TOOL_NAMES
    assert PROPOSAL_TOOLS.isdisjoint(read)
    assert ACTION_TOOLS == {"run_trial", "analyze_run", "review_queue"}
    assert ACTION_TOOLS <= TOOL_NAMES
    assert ACTION_TOOLS.isdisjoint(PROPOSAL_TOOLS | read)
    args, error = validate_args("get_result", None)
    assert error is None and args == {}


def test_validate_review_queue_limit():
    args, error = validate_args("review_queue", None)
    assert error is None and args == {}
    args, error = validate_args("review_queue", {"limit": 8})
    assert error is None and args == {"limit": 8}
    _, error = validate_args("review_queue", {"limit": 11})
    assert error and "1 до 10" in error
    _, error = validate_args("review_queue", {"limit": 0})
    assert error and "1 до 10" in error
    _, error = validate_args("review_queue", {"limit": "пять"})
    assert error and "number" in error


def test_validate_propose_decision():
    ok = {"outcomes": [
        {"label": "Опубликовать", "color": "green", "rules": [
            {"anyOf": False, "conditions": [
                {"question": "q1", "answer": "yes", "op": "gte",
                 "threshold": 90}]}]},
        {"label": "На модерацию", "color": "yellow", "isDefault": True,
         "rules": []}]}
    args, err = validate_args("propose_decision", ok)
    assert err is None and args is not None
    # пустой список исходов
    _, err = validate_args("propose_decision", {"outcomes": []})
    assert err and "хотя бы один исход" in err
    # два default
    bad = {"outcomes": [
        {"label": "a", "rules": []}, {"label": "b", "isDefault": True,
                                      "rules": []},
        {"label": "c", "isDefault": True, "rules": []}]}
    _, err = validate_args("propose_decision", bad)
    assert err and "только один" in err
    # условие без answer/score и с обоими сразу — разные тексты + локатор
    bad = {"outcomes": [{"label": "a", "rules": [
        {"conditions": [{"question": "q1", "op": "gte"}]}]}]}
    _, err = validate_args("propose_decision", bad)
    assert err and "нет ни answer, ни score" in err
    assert "исход «a», правило 1, условие 1 (вопрос «q1»)" in err
    bad = {"outcomes": [{"label": "a", "rules": [
        {"conditions": [{"question": "q2", "op": "gte", "answer": "yes",
                         "threshold": 90, "score": 2}]}]}]}
    _, err = validate_args("propose_decision", bad)
    assert err and "заданы и answer, и score" in err
    assert "условие 1 (вопрос «q2»)" in err
    # answer без threshold
    bad = {"outcomes": [{"label": "a", "rules": [
        {"conditions": [{"question": "q1", "op": "gte", "answer": "yes"}]}]}]}
    _, err = validate_args("propose_decision", bad)
    assert err and "threshold" in err and "условие 1" in err
    # опечатка в имени поля — whitelist ловит до ветки «ни answer, ни score»
    bad = {"outcomes": [{"label": "a", "rules": [
        {"conditions": [{"question": "q1", "op": "gte", "value": 2}]}]}]}
    _, err = validate_args("propose_decision", bad)
    assert err and "неизвестное поле «value»" in err
    # дубли названий исходов (фронт такую карточку блокирует — ловим на бэке)
    bad = {"outcomes": [{"label": "Требует внимания", "rules": [
        {"conditions": [{"question": "q1", "op": "gte", "answer": "yes",
                         "threshold": 90}]}]},
        {"label": "Требует внимания", "isDefault": True, "rules": []}]}
    _, err = validate_args("propose_decision", bad)
    assert err and "уникальными" in err and "Требует внимания" in err
    # answer «да»/«нет» вместо yes/no — самопочинимый reject (модели копировали
    # русские значения из снапшота; для choice «да» — легальная опция, поэтому
    # без нормализации, только отказ с подсказкой)
    bad = {"outcomes": [{"label": "a", "rules": [
        {"conditions": [{"question": "q1", "op": "gte", "answer": "да",
                         "threshold": 80}]}]}]}
    _, err = validate_args("propose_decision", bad)
    assert err and "yes или no" in err and "условие 1 (вопрос «q1»)" in err
    # позиционная адресация (номер вместо id) — ошибка схемы (контракт A3)
    _, err = validate_args("propose_decision", {"outcomes": [
        {"label": "a", "rules": [{"conditions": [
            {"question": 1, "op": "gte", "answer": "yes",
             "threshold": 80}]}]}]})
    assert err and "ожидался string" in err
    # title (карточка 2.1 «Рамс»): строка — ок, не строка — ошибка схемы;
    # outcomes-валидация от title не зависит
    args, err = validate_args("propose_decision", {**ok, "title": "Суть правки"})
    assert err is None and args["title"] == "Суть правки"
    _, err = validate_args("propose_decision", {**ok, "title": 5})
    assert err and "title" in err and "ожидался string" in err


def test_proposal_checks_use_message_time_snapshot():
    """Валидация идёт по снапшоту на момент сообщения (гонка «пользователь
    правил во время стрима» осознанно закрывается apply-time проверкой фронта,
    а не бэком — ложный tool-error стоил бы шаг)."""
    from backend.assistant.proposal_checks import validate_against_snapshot
    args = {"outcomes": [{"label": "a", "rules": [{"conditions": [
        {"question": "q3", "answer": "yes", "op": "gte", "threshold": 50}]}]}]}
    snap3 = {"questions": [{"n": i, "id": f"q{i}", "question": f"В{i}?",
                            "type": "yes_no"} for i in (1, 2, 3)]}
    snap1 = {"questions": [{"n": 1, "id": "q1", "question": "В1?",
                            "type": "yes_no"}]}
    assert validate_against_snapshot("propose_decision", args, snap3) is None
    err = validate_against_snapshot("propose_decision", args, snap1)
    assert err and "вопроса «q3» нет" in err


# ---------------------------------------------------------------- parse_tool_calls

def test_parse_hermes_json_and_string_params():
    content = ("текст до\n"
               + hermes_call("propose_context", {"text": '{"a": 1}', "mode": "replace"})
               + "\nтекст после")
    calls = parse_tool_calls(content)
    assert calls == [("propose_context", {"text": {"a": 1}, "mode": "replace"}, "")]


def test_parse_hermes_multiple_calls():
    content = ("<tool_call><function=get_state></function></tool_call>"
               "промежуточный текст"
               "<tool_call><function=list_models></function></tool_call>")
    calls = parse_tool_calls(content)
    assert [c[0] for c in calls] == ["get_state", "list_models"]
    assert all(c[1] == {} for c in calls)


def test_parse_legacy_json_form():
    content = '<tool_call>{"name": "get_state", "arguments": {}}</tool_call>'
    assert parse_tool_calls(content) == [("get_state", {}, "")]
    # arguments строкой с JSON внутри
    raw = json.dumps({"name": "propose_run", "arguments": json.dumps({"scope": "single"})})
    assert parse_tool_calls(f"<tool_call>{raw}</tool_call>") == [
        ("propose_run", {"scope": "single"}, "")]


def test_parse_garbage_no_calls():
    assert parse_tool_calls("просто текст без разметки") == []
    assert parse_tool_calls("<tool_call>{не json}</tool_call>") == []
    assert parse_tool_calls("") == []


# ---------------------------------------------------------------- strip/split

def test_strip_tool_markup():
    hermes = "до\n<tool_call><function=get_state></function></tool_call>\nпосле"
    stripped = strip_tool_markup(hermes)
    assert "<tool_call>" not in stripped
    assert "до" in stripped and "после" in stripped
    assert strip_tool_markup("<tool_call><function=get_state></function></tool_call>") == ""
    assert strip_tool_markup('<tool_call>{"name": "get_state"}</tool_call>') == ""
    assert strip_tool_markup("чистый текст") == "чистый текст"


def test_split_thinking():
    assert split_thinking("думал</think>ответ") == ("думал", "ответ")
    assert split_thinking("без маркера") == ("", "без маркера")
    assert split_thinking("</think>только ответ") == ("", "только ответ")


# ---------------------------------------------------------------- validate_args

def test_validate_unknown_tool():
    args, error = validate_args("delete_everything", {})
    assert args is None
    assert "Неизвестный инструмент" in error


def test_validate_propose_questions_valid_all_types():
    args, error = validate_args("propose_questions", {
        "mode": "replace",
        "questions": [
            {"id": "q1", "question": "Ок?", "type": "yes_no",
             "description_yes": "да, ок", "description_no": "не ок"},
            {"id": "q2", "question": "Выбор?", "type": "choice",
             "options": ["А", "Б", "В"]},
            {"id": "q3", "question": "Оценка?", "type": "score",
             "levels": ["низкий", "высокий"], "direction": "up"},
        ],
    })
    assert error is None
    assert args["mode"] == "replace"
    # direction не знает pydantic Question, но валиден для фронта — сохраняется
    assert args["questions"][2]["direction"] == "up"


def test_validate_propose_questions_errors():
    base = {"questions": [{"id": "q1", "question": "Ок?", "type": "yes_no"}],
            "mode": "replace"}

    args, error = validate_args("propose_questions", {
        **base, "questions": [{"id": "  ", "question": "Ок?", "type": "yes_no"}]})
    assert args is None and "пустым" in error
    # локатор: какой именно вопрос сломан (модель чинит вслепую без него)
    assert error.startswith("Вопрос №1 (id ")

    args, error = validate_args("propose_questions", {
        **base, "questions": [{"id": "q1", "question": "Выбор?", "type": "choice",
                               "options": ["А"]}]})
    assert args is None and "опций" in error

    args, error = validate_args("propose_questions", {
        **base, "questions": [{"id": "q1", "question": "Ок?", "type": "yes_no"},
                              {"id": "q1", "question": "Ок2?", "type": "yes_no"}]})
    assert args is None and "уникальн" in error

    args, error = validate_args("propose_questions", {**base, "mode": "заменить"})
    assert args is None and "mode" in error


def test_validate_read_tool_no_args_ok():
    args, error = validate_args("get_state", None)
    assert error is None and args == {}
    args, error = validate_args("get_state", "не объект")
    assert args is None and "объектом" in error


def test_validate_get_file_result():
    args, error = validate_args("get_file_result", {"file": "doc.txt"})
    assert error is None and args["file"] == "doc.txt"
    _, error = validate_args("get_file_result", {})
    assert error and "обязательного поля" in error and "file" in error


def test_validate_run_trial_v2_params():
    """run_trial: contextText/batchFile/useImages/decision — валидация."""
    ok = {"contextText": "свой текст", "batchFile": "doc.txt", "useImages": True,
          "decision": {"outcomes": [
              {"label": "Да", "rules": [
                  {"conditions": [{"question": "q1", "answer": "yes",
                                   "op": "gte", "threshold": 50}]}]},
              {"label": "Нет", "isDefault": True, "rules": []}]}}
    args, error = validate_args("run_trial", ok)
    assert error is None and args is not None
    # decision с пустыми исходами — доменная ошибка
    _, error = validate_args("run_trial", {"decision": {"outcomes": []}})
    assert error and "хотя бы один исход" in error
    # два default в decision
    _, error = validate_args("run_trial", {"decision": {"outcomes": [
        {"label": "a", "rules": []}, {"label": "b", "isDefault": True, "rules": []},
        {"label": "c", "isDefault": True, "rules": []}]}})
    assert error and "только один" in error
    # условие без threshold
    _, error = validate_args("run_trial", {"decision": {"outcomes": [
        {"label": "a", "rules": [
            {"conditions": [{"question": "q1", "op": "gte",
                             "answer": "yes"}]}]}]}})
    assert error and "threshold" in error
    # useImages — boolean, не строка
    _, error = validate_args("run_trial", {"useImages": "да"})
    assert error and "useImages" in error
    # contextText/batchFile — строки
    _, error = validate_args("run_trial", {"contextText": 42})
    assert error and "contextText" in error


def test_validate_propose_context_file_and_preset_slug():
    args, error = validate_args("propose_context", {
        "text": "новый", "mode": "replace", "file": "doc.txt"})
    assert error is None and args["file"] == "doc.txt"
    _, error = validate_args("propose_context", {
        "text": "новый", "mode": "replace", "file": 5})
    assert error and "file" in error
    args, error = validate_args("propose_save_preset", {
        "name": "Пресет", "slug": "my-preset"})
    assert error is None and args["slug"] == "my-preset"
    _, error = validate_args("propose_save_preset", {"name": "Пресет", "slug": 5})
    assert error and "slug" in error


def test_validate_args_strips_strict_nulls():
    """Strict-режим провайдеров (A2.1): необязательные поля приходят с явным
    null — это «не задано», срезаются рекурсивно до проверки схемы; null
    обязательного поля — по-прежнему ошибка «нет поля»."""
    # необязательный null срезается
    args, error = validate_args("propose_context", {
        "text": "новый", "mode": "replace", "file": None})
    assert error is None and args == {"text": "новый", "mode": "replace"}
    # null внутри edits-операции (strict-схема требует все поля объекта)
    args, error = validate_args("propose_questions", {
        "questions": None, "mode": None,
        "edits": [{"op": "remove", "target": "q2",
                   "after": None, "question": None, "into": None}]})
    assert error is None and args["edits"] == [{"op": "remove", "target": "q2"}]
    # null внутри условия правил (score-ветка без answer)
    args, error = validate_args("propose_decision", {"outcomes": [
        {"label": "Да", "color": None, "isDefault": None, "rules": [
            {"anyOf": None, "conditions": [
                {"question": "q1", "op": "gte", "answer": None,
                 "threshold": None, "score": 2}]}]},
        {"label": "Нет", "isDefault": True, "rules": []}]})
    assert error is None
    # null обязательного поля → «нет поля», как и раньше
    _, error = validate_args("propose_context", {"text": None, "mode": "replace"})
    assert error and "нет обязательного поля" in error and "text" in error


# ------------------------------------------------- валидация против снапшота

SNAP_QS = [
    {"n": 1, "id": "q1", "question": "Есть дефект?", "type": "yes_no"},
    {"n": 2, "id": "q2", "question": "Тип дефекта?", "type": "choice",
     "options": ["Скол", "Трещина"]},
    {"n": 3, "id": "q3", "question": "Качество фото?", "type": "score",
     "levels": ["плохо", "норм", "отлично"]},
]
SNAP = {"questions": SNAP_QS,
        "batchFiles": [{"name": "a.txt"}, {"name": "b.txt"}]}


def _decision(cond: dict) -> dict:
    return {"outcomes": [{"label": "Ок", "rules": [
        {"conditions": [cond]}]},
        {"label": "Прочее", "isDefault": True, "rules": []}]}


def test_snapshot_decision_conditions():
    ok = _decision({"question": "q2", "answer": "Скол", "op": "gte",
                    "threshold": 80})
    assert validate_against_snapshot("propose_decision", ok, SNAP) is None
    ok = _decision({"question": "q3", "score": 2, "op": "gte"})
    assert validate_against_snapshot("propose_decision", ok, SNAP) is None
    # неизвестный id — локатор + verbatim-подсказка актуальных id (A3)
    err = validate_against_snapshot(
        "propose_decision",
        _decision({"question": "q5", "answer": "yes", "op": "gte",
                   "threshold": 50}), SNAP)
    assert err and "вопроса «q5» нет" in err
    assert "актуальные id: q1, q2, q3" in err
    assert "исход «Ок», правило 1, условие 1" in err
    # yes_no: answer вне yes/no
    err = validate_against_snapshot(
        "propose_decision",
        _decision({"question": "q1", "answer": "maybe", "op": "gte",
                   "threshold": 50}), SNAP)
    assert err and "yes или no" in err and "вопрос «q1»" in err
    # choice: answer не из опций — ошибка со списком допустимых
    err = validate_against_snapshot(
        "propose_decision",
        _decision({"question": "q2", "answer": "Царапина", "op": "gte",
                   "threshold": 50}), SNAP)
    assert err and "не опция" in err and "Скол" in err and "Трещина" in err
    # score-вопрос с answer / score на не-score вопросе
    err = validate_against_snapshot(
        "propose_decision",
        _decision({"question": "q3", "answer": "yes", "op": "gte",
                   "threshold": 50}), SNAP)
    assert err and "задай score, а не answer" in err
    err = validate_against_snapshot(
        "propose_decision", _decision({"question": "q1", "score": 1,
                                       "op": "gte"}), SNAP)
    assert err and "не шкала" in err
    # score вне диапазона шкалы (уровни 0..2)
    err = validate_against_snapshot(
        "propose_decision", _decision({"question": "q3", "score": 5,
                                       "op": "gte"}), SNAP)
    assert err and "вне шкалы" in err and "0..2" in err
    # без снапшота — проверять не против чего, пропускаем
    assert validate_against_snapshot("propose_decision", ok, None) is None


def test_snapshot_decision_multi_error():
    """Все ошибки условий — одним сообщением (не fail-fast): модель чинит
    одним ретраем вместо кругов «починила одну — споткнулась о следующую»
    (инцидент 17.10: 3 ретрая → RepeatGuard → карточка правил умерла)."""
    args = {"outcomes": [{"label": "Ок", "rules": [{"conditions": [
        {"question": "q1", "answer": "maybe", "op": "gte", "threshold": 50},
        {"question": "q3", "answer": "yes", "op": "gte", "threshold": 50},
    ]}]}]}
    err = validate_against_snapshot("propose_decision", args, SNAP)
    assert err and "условие 1" in err and "условие 2" in err
    assert "yes или no" in err and "задай score, а не answer" in err


def test_snapshot_decision_virtual_questions():
    """questions_override — виртуальный набор из карточки вопросов этого же
    хода (по id, A3); без override — проверка по снапшоту, пустой override —
    не фолбэк на снапшот."""
    # виртуальный набор: остался только q3 (score) — q1 в нём уже нет
    virtual = SNAP_QS[2:]
    ok = _decision({"question": "q1", "answer": "yes", "op": "gte",
                    "threshold": 50})
    assert validate_against_snapshot("propose_decision", ok, SNAP) is None
    err = validate_against_snapshot("propose_decision", ok, SNAP,
                                    questions_override=virtual)
    assert err and "вопроса «q1» нет" in err and "актуальные id: q3" in err
    err = validate_against_snapshot("propose_decision", ok, SNAP,
                                    questions_override=[])
    assert err and "набор пуст" in err


def test_snapshot_questions_duplicates():
    # replace: дубль внутри предложения
    err = validate_against_snapshot("propose_questions", {
        "mode": "replace",
        "questions": [{"id": "x1", "question": "Есть дефект!", "type": "yes_no"},
                      {"id": "x2", "question": "Есть дефект?", "type": "yes_no"}]},
        SNAP)
    assert err and "№1 и №2" in err and "повторяются" in err
    # append: дубль существующего вопроса снапшота (нормализация: регистр/пунктуация)
    err = validate_against_snapshot("propose_questions", {
        "mode": "append",
        "questions": [{"id": "x1", "question": " есть  дефект ", "type": "yes_no"}]},
        SNAP)
    assert err and "дубль существующего вопроса №1" in err
    # replace с текстом существующего — не дубль (старый набор затирается)
    assert validate_against_snapshot("propose_questions", {
        "mode": "replace",
        "questions": [{"id": "x1", "question": "Есть дефект?", "type": "yes_no"}]},
        SNAP) is None
    # append без дублей — чисто
    assert validate_against_snapshot("propose_questions", {
        "mode": "append",
        "questions": [{"id": "x1", "question": "Новый?", "type": "yes_no"}]},
        SNAP) is None


def test_snapshot_context_file_and_run_scope():
    ok = {"text": "т", "mode": "replace", "file": "a.txt"}
    assert validate_against_snapshot("propose_context", ok, SNAP) is None
    err = validate_against_snapshot("propose_context",
                                    {**ok, "file": "nope.txt"}, SNAP)
    assert err and "нет в пакете" in err and "a.txt" in err and "b.txt" in err
    err = validate_against_snapshot("propose_context", ok,
                                    {"batchFiles": []})
    assert err and "пакет пуст" in err
    # propose_run: batch без файлов
    err = validate_against_snapshot("propose_run", {"scope": "batch"},
                                    {"batchFiles": []})
    assert err and "нет файлов" in err
    assert validate_against_snapshot("propose_run", {"scope": "batch"},
                                     SNAP) is None
    assert validate_against_snapshot("propose_run", {"scope": "single"},
                                     {"batchFiles": []}) is None


# ---------------------------------------------------------------- edits

def test_validate_question_edits_composition():
    ok = {"edits": [{"op": "update", "target": "q2",
                     "question": {"id": "q2", "question": "Тип?", "type": "choice",
                                  "options": ["А", "Б"]}},
                    {"op": "add", "after": "q1",
                     "question": {"id": "q9", "question": "Новый?", "type": "yes_no"}}]}
    args, err = validate_args("propose_questions", ok)
    assert err is None and args["edits"]
    # edits и questions вместе — нельзя
    _, err = validate_args("propose_questions", {
        **ok, "questions": [{"id": "q1", "question": "Ок?", "type": "yes_no"}],
        "mode": "replace"})
    assert err and "либо edits, либо questions" in err
    # ни edits, ни questions+mode
    _, err = validate_args("propose_questions", {})
    assert err and "либо edits" in err
    # состав по op: remove без target; update с лишним полем; split с 1 вопросом
    _, err = validate_args("propose_questions", {"edits": [{"op": "remove"}]})
    assert err and "edits[0] (op=remove)" in err and "'target'" in err
    _, err = validate_args("propose_questions", {"edits": [
        {"op": "update", "target": "q1",
         "question": {"id": "q1", "question": "Ок?", "type": "yes_no"},
         "into": []}]})
    assert err and "лишнее поле 'into'" in err
    _, err = validate_args("propose_questions", {"edits": [
        {"op": "split", "target": "q1",
         "into": [{"id": "a", "question": "А?", "type": "yes_no"}]}]})
    assert err and "2–3 вопроса" in err
    # позиционная адресация (n вместо target) — лишнее поле + нет target
    _, err = validate_args("propose_questions",
                           {"edits": [{"op": "remove", "n": 1}]})
    assert err and "'target'" in err
    # неизвестная op ловится схемой (enum)
    _, err = validate_args("propose_questions",
                           {"edits": [{"op": "move", "target": "q1"}]})
    assert err and "op" in err


def test_expand_question_edits():
    # update: замена по месту, id — из снапшота (ссылки по id не рвутся)
    qs, err, renames = expand_question_edits(SNAP, [
        {"op": "update", "target": "q1",
         "question": {"id": "zz", "question": "Есть скол?", "type": "yes_no"}}])
    assert err is None and renames == []
    assert [q["question"] for q in qs] == ["Есть скол?", "Тип дефекта?",
                                           "Качество фото?"]
    assert qs[0]["id"] == "q1", "id существующего вопроса сохранён"
    # remove + add после id + split — операции по порядку, ссылки по id не
    # зависят от сдвигов нумерации внутри вызова (в этом и смысл A3)
    qs, err, renames = expand_question_edits(SNAP, [
        {"op": "remove", "target": "q1"},
        {"op": "add", "after": "q2",
         "question": {"id": "q9", "question": "Вставка?", "type": "yes_no"}},
        {"op": "split", "target": "q3",
         "into": [{"id": "qa", "question": "Часть А?", "type": "yes_no"},
                  {"id": "qb", "question": "Часть Б?", "type": "yes_no"}]},
    ])
    assert err is None and renames == []
    assert [q["id"] for q in qs] == ["q2", "q9", "qa", "qb"]
    # add без after — в конец
    qs, err, _ = expand_question_edits(SNAP, [
        {"op": "add",
         "question": {"id": "q9", "question": "В конец?", "type": "yes_no"}}])
    assert err is None and qs[-1]["id"] == "q9" and len(qs) == 4
    # служебное n снапшота в итог не попадает
    assert all("n" not in q for q in qs)
    # target/after неизвестны — локатор операции + verbatim-подсказка id (A3)
    qs, err, _ = expand_question_edits(SNAP, [{"op": "remove", "target": "qx"}])
    assert qs is None and "edits[0] (op=remove)" in err
    assert "вопроса «qx» нет" in err and "актуальные id: q1, q2, q3" in err
    qs, err, _ = expand_question_edits(SNAP, [
        {"op": "add", "after": "qx",
         "question": {"id": "q9", "question": "?", "type": "yes_no"}}])
    assert qs is None and "вопроса «qx» (after) нет" in err
    # коллизия id нового вопроса с существующим — тихое переименование (A3):
    # существующий id неприкосновенен, новый получает суффикс
    qs, err, renames = expand_question_edits(SNAP, [
        {"op": "add",
         "question": {"id": "q2", "question": "Дубль id?", "type": "yes_no"}},
        {"op": "split", "target": "q3",
         "into": [{"id": "qa", "question": "Часть А?", "type": "yes_no"},
                  {"id": "qa", "question": "Часть Б?", "type": "yes_no"}]},
    ])
    assert err is None
    assert renames == [("qa", "qa-2"), ("q2", "q2-2")]
    assert [q["id"] for q in qs] == ["q1", "q2", "qa", "qa-2", "q2-2"]
    # итог — доменной валидацией: пустой набор и битый вопрос отвергаются
    qs, err, _ = expand_question_edits(
        {"questions": [{"n": 1, "id": "q1", "question": "Ок?", "type": "yes_no"}]},
        [{"op": "remove", "target": "q1"}])
    assert qs is None and "набор пуст" in err
    qs, err, _ = expand_question_edits(SNAP, [
        {"op": "update", "target": "q2",
         "question": {"id": "q2", "question": "Тип?", "type": "choice",
                      "options": ["одна"]}}])
    assert qs is None and "опций" in err


def test_decision_reference_warnings():
    snap = {**SNAP, "decision": {"outcomes": [
        {"label": "Брак", "rules": [{"conditions": [
            {"question": "q1", "answer": "yes", "op": "gte", "threshold": 80},
            {"question": "q3", "score": 2, "op": "gte"}]}]},
        {"label": "Ок", "isDefault": True, "rules": []}]}}
    warn = decision_reference_warnings(snap, [{"op": "remove", "target": "q1"},
                                              {"op": "split", "target": "q3"},
                                              {"op": "add", "question": {}}])
    assert warn == ("правило исхода «Брак» ссылается на №1; "
                    "правило исхода «Брак» ссылается на №3")
    # вопрос без ссылок и вовсе без decision — предупреждения нет
    assert decision_reference_warnings(snap, [{"op": "update", "target": "q2",
                                               "question": {}}]) is None
    assert decision_reference_warnings(SNAP, [{"op": "remove",
                                               "target": "q1"}]) is None


# ---------------------------------------------------------------- _StreamFilter

def test_stream_filter_hides_tool_call_char_by_char():
    filt = _StreamFilter(thinking=False)
    markup = "<tool_call><function=get_state></function></tool_call>"
    events = []
    for ch in [""] + list(markup):  # пустой первый чанк не должен решать режим
        events.extend(filt.feed(ch))
    assert events == [], "tool_call-разметка не должна уходить наружу"


def test_stream_filter_thinking_then_answer():
    # одним чанком
    filt = _StreamFilter(thinking=True)
    assert filt.feed("рассуждение</think>ответ") == [
        ("thinking", "рассуждение"), ("token", "ответ")]
    # по частям
    filt = _StreamFilter(thinking=True)
    assert filt.feed("рассуждение") == []
    events = filt.feed("</think>ответ") + filt.feed(" ещё")
    assert ("thinking", "рассуждение") in events
    assert "".join(t for k, t in events if k == "token") == "ответ ещё"


def test_stream_filter_plain_text_passthrough():
    filt = _StreamFilter(thinking=False)
    events = filt.feed("Привет, ") + filt.feed("мир")
    assert events == [("token", "Привет, "), ("token", "мир")]


def test_stream_filter_angle_bracket_non_tool_call():
    filt = _StreamFilter(thinking=False)
    text = "<пример> это не tool_call"
    events = []
    for ch in text:
        events.extend(filt.feed(ch))
    tokens = "".join(t for k, t in events if k == "token")
    assert tokens == text


# ---------------------------------------------------------------- промпт

def test_system_prompt_language_and_brevity_rules():
    from backend.assistant.prompts import SYSTEM_PROMPT
    # язык ответа = язык последнего сообщения пользователя, дефолт — русский
    assert "язык последнего сообщения пользователя" in SYSTEM_PROMPT
    assert "по умолчанию русский" in SYSTEM_PROMPT
    # лаконичность: короче обычного, без вступлений/резюме, рамка для простых вопросов
    assert "вдвое короче" in SYSTEM_PROMPT
    assert "Без вступлений" in SYSTEM_PROMPT
    assert "2–6 предложений" in SYSTEM_PROMPT
    # приоритет существующих результатов: resultsSummary до run_trial
    assert "resultsSummary" in SYSTEM_PROMPT
    # вопросы — обобщённые классификаторы, не подгонка под текущий экземпляр
    assert "переиспользуемые классификаторы" in SYSTEM_PROMPT
    assert "других таких же документах" in SYSTEM_PROMPT
    # ссылки на вопросы: в тексте — номер/цитата (поле n), в аргументах
    # инструментов — только id (A3); id пользователю не показываем
    assert "поле n" in SYSTEM_PROMPT
    assert "никогда не показывай их в ответах" in SYSTEM_PROMPT
    # HITL: предложения не применяются сами, ждут кнопки «Принять»/«Отклонить»
    assert "Принять" in SYSTEM_PROMPT
    assert "говори «предложил»" in SYSTEM_PROMPT
    # видимость моделей и vision (правило 11), get_file_result (правило 6)
    assert "selected" in SYSTEM_PROMPT
    assert "vision" in SYSTEM_PROMPT
    assert "get_file_result" in SYSTEM_PROMPT


# ---------------------------------------------------------------- run_agent

async def test_run_agent_read_tool_then_answer(fake_chat):
    tool_calls = []
    fake_chat.responses = [
        sse_lines("<tool_call><function=get_state></function></tool_call>"),
        sse_lines("Вот ", "состояние."),
    ]
    events = await collect_events(run_agent(
        [], "что сейчас в приложении?", {"mode": "single"}, CHAT_URL,
        thinking=False, read_tools=make_read_tools(tool_calls)))

    assert event_types(events) == ["tool", "tool", "token", "token", "done"]
    assert events[0] == {"type": "tool", "name": "get_state", "status": "start",
                         "args": "{}"}
    assert events[1] == {"type": "tool", "name": "get_state", "status": "done"}
    assert events[2]["text"] + events[3]["text"] == "Вот состояние."
    assert tool_calls == ["get_state"]

    # второй запрос: в messages добавились ответ ассистента и role:"tool" с результатом
    assert len(fake_chat.requests) == 2
    assert fake_chat.requests[0]["url"] == CHAT_URL
    messages = fake_chat.requests[1]["json"]["messages"]
    assert [m["role"] for m in messages] == ["system", "user", "assistant", "tool"]
    tool_msg = messages[-1]
    assert tool_msg["name"] == "get_state"
    assert json.loads(tool_msg["content"]) == {"ok": True, "state": {"mode": "single"}}
    # первый запрос: system со снапшотом + user, tools и stream включены
    first = fake_chat.requests[0]["json"]
    assert first["stream"] is True
    assert first["chat_template_kwargs"] == {"enable_thinking": False}
    assert '"mode": "single"' in first["messages"][0]["content"]
    assert first["messages"][1] == {"role": "user", "content": "что сейчас в приложении?"}


async def test_run_agent_propose_questions_proposal(fake_chat):
    tool_calls = []
    questions = json.dumps([{"id": "q1", "question": "Понятен ли текст?",
                             "type": "yes_no"}], ensure_ascii=False)
    fake_chat.responses = [
        sse_lines(hermes_call("propose_questions",
                              {"questions": questions, "mode": "replace"})),
        sse_lines("Предложил один вопрос."),
    ]
    events = await collect_events(run_agent(
        [], "придумай вопросы", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools(tool_calls)))

    assert event_types(events) == ["proposal", "token", "done"]
    proposal = events[0]["proposal"]
    assert proposal["kind"] == "propose_questions"
    assert proposal["title"] == "Набор вопросов"
    assert len(proposal["id"]) == 8
    assert proposal["payload"]["mode"] == "replace"
    assert proposal["payload"]["questions"][0]["id"] == "q1"
    assert tool_calls == [], "propose-инструмент не должен исполняться"
    # модель получила tool-сообщение «ждёт подтверждения», а не «применено»
    tool_msg = fake_chat.requests[1]["json"]["messages"][-1]
    assert tool_msg["role"] == "tool"
    assert "ждёт подтверждения" in tool_msg["content"]


async def test_run_agent_vision_images_in_user_message(fake_chat):
    """vision=True + картинки в снапшоте → user-сообщение content-массивом с
    image_url (OpenAI-формат); в JSON-системном промпте dataUrl нет."""
    snap = {"context": {"text": "т", "imagesCount": 1,
                        "images": ["data:image/png;base64,QUJD"]}}
    fake_chat.responses = [sse_lines("Вижу.")]
    events = await collect_events(run_agent(
        [], "что на картинке?", snap, CHAT_URL, thinking=False,
        read_tools=make_read_tools([]), vision=True))
    assert event_types(events) == ["token", "done"]
    msgs = fake_chat.requests[0]["json"]["messages"]
    user = msgs[-1]
    assert isinstance(user["content"], list)
    assert user["content"][0] == {"type": "text", "text": "что на картинке?"}
    assert user["content"][1]["type"] == "image_url"
    assert user["content"][1]["image_url"]["url"] == "data:image/png;base64,QUJD"
    assert "data:image" not in msgs[0]["content"]


async def test_run_agent_proposal_titles_dynamic(fake_chat):
    """Заголовок proposal зависит от аргументов: propose_context+file →
    «Текст файла пакета», propose_save_preset+slug → «Обновить пресет»,
    propose_decision+title → суть правки от модели (карточка 2.1 «Рамс»)."""
    outcomes = json.dumps([{"label": "Разбор", "rules": [{"conditions": [
        {"question": "q1", "answer": "yes", "op": "gte", "threshold": 60}]}]},
        {"label": "Ок", "isDefault": True, "rules": []}], ensure_ascii=False)
    fake_chat.responses = [
        sse_lines(hermes_call("propose_context",
                              {"text": '"новый"', "mode": '"replace"',
                               "file": '"doc.txt"'})),
        sse_lines(hermes_call("propose_save_preset",
                              {"name": '"Пресет"', "slug": '"my-preset"'})),
        sse_lines(hermes_call("propose_decision", {
            "title": '"Порог раздражения 70% → 60%"', "outcomes": outcomes})),
        sse_lines("Предложил."),
    ]
    events = await collect_events(run_agent(
        [], "правки", None, CHAT_URL, thinking=False,
        read_tools=make_read_tools([])))
    props = [e["proposal"] for e in events if e["type"] == "proposal"]
    assert [p["title"] for p in props] == ["Текст файла пакета",
                                           "Обновить пресет",
                                           "Порог раздражения 70% → 60%"]
    assert props[0]["payload"]["file"] == "doc.txt"
    assert props[1]["payload"]["slug"] == "my-preset"
    # title — и в payload (payload = args), и в заголовке карточки
    assert props[2]["payload"]["title"] == "Порог раздражения 70% → 60%"
    # без title — прежний общий заголовок (title необязателен по схеме, как у
    # propose_run: старые записанные сессии и не-strict провайдеры не ломаются)
    fake_chat.requests = []
    fake_chat.responses = [
        sse_lines(hermes_call("propose_decision", {"outcomes": outcomes})),
        sse_lines("Предложил."),
    ]
    events = await collect_events(run_agent(
        [], "правила", None, CHAT_URL, thinking=False,
        read_tools=make_read_tools([])))
    props = [e["proposal"] for e in events if e["type"] == "proposal"]
    assert props and props[0]["title"] == "Правила решения"


async def test_run_agent_invalid_args_error_to_model(fake_chat):
    fake_chat.responses = [
        sse_lines(hermes_call("propose_questions", {
            "questions": '[{"id": "q1", "question": "Ок?", "type": "yes_no"}]',
            "mode": "заменить"})),
        sse_lines("Исправляюсь."),
    ]
    events = await collect_events(run_agent(
        [], "придумай вопросы", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))

    assert event_types(events) == ["tool", "token", "done"]
    tool_ev = events[0]
    assert tool_ev["status"] == "error"
    assert tool_ev["name"] == "propose_questions"
    assert "mode" in tool_ev["message"]
    # валидация аргументов — internal: предпроверка, ничего не запускалось,
    # фронт такую строку из ленты скрывает
    assert tool_ev["internal"] is True
    # ошибка ушла модели tool-сообщением
    tool_msg = fake_chat.requests[1]["json"]["messages"][-1]
    assert tool_msg["role"] == "tool"
    content = json.loads(tool_msg["content"])
    assert content["ok"] is False and "mode" in content["error"]


async def test_run_agent_proposal_rejected_by_snapshot(fake_chat):
    """Предпроверка против снапшота до карточки: propose_decision со ссылкой
    на несуществующий id — proposal не создаётся, модель получает tool-error
    (internal: фронт строку скрывает) с verbatim-подсказкой актуальных id и
    чинится тем же ответом (A3)."""
    snap = {"questions": [{"n": 1, "id": "q1", "question": "Ок?",
                           "type": "yes_no"}]}
    bad = json.dumps([
        {"label": "a", "rules": [{"conditions": [
            {"question": "q7", "answer": "yes", "op": "gte", "threshold": 80}]}]},
        {"label": "b", "isDefault": True, "rules": []}], ensure_ascii=False)
    fake_chat.responses = [
        sse_lines(hermes_call("propose_decision", {"outcomes": bad})),
        sse_lines("Исправляюсь."),
    ]
    events = await collect_events(run_agent(
        [], "предложи правила", snap, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))

    assert event_types(events) == ["tool", "token", "done"]
    tool_ev = events[0]
    assert tool_ev["name"] == "propose_decision"
    assert tool_ev["status"] == "error"
    assert "вопроса «q7» нет" in tool_ev["message"]
    assert "актуальные id: q1" in tool_ev["message"]
    assert tool_ev["internal"] is True
    tool_msg = fake_chat.requests[1]["json"]["messages"][-1]
    assert tool_msg["role"] == "tool"
    content = json.loads(tool_msg["content"])
    assert content["ok"] is False and "вопроса «q7» нет" in content["error"]


async def test_run_agent_propose_questions_edits(fake_chat):
    """edits разворачиваются на бэке в итоговый набор: карточке — payload
    {mode: replace, questions, edits, warn?}, фронт применяет как replace.
    Адресация операций — по id (A3). Правка вопроса, на который ссылаются
    правила, — warn в карточку и нота модели «предложи обновлённые правила
    этим же ответом»."""
    snap = {"questions": [
        {"n": 1, "id": "q1", "question": "Есть дефект?", "type": "yes_no"},
        {"n": 2, "id": "q2", "question": "Качество?", "type": "score",
         "levels": ["плохо", "хорошо"]}],
        "decision": {"outcomes": [
            {"label": "Брак", "rules": [{"conditions": [
                {"question": "q1", "answer": "yes", "op": "gte",
                 "threshold": 80}]}]},
            {"label": "Ок", "isDefault": True, "rules": []}]}}
    edits = json.dumps([
        {"op": "update", "target": "q1",
         "question": {"id": "q1", "question": "Есть скол?", "type": "yes_no"}},
        {"op": "add", "question": {"id": "q9", "question": "Подпись есть?",
                                   "type": "yes_no"}}], ensure_ascii=False)
    fake_chat.responses = [
        sse_lines(hermes_call("propose_questions", {"edits": edits})),
        sse_lines("Предложил правки."),
    ]
    events = await collect_events(run_agent(
        [], "переформулируй первый и добавь про подпись", snap, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))

    assert event_types(events) == ["proposal", "token", "done"]
    proposal = events[0]["proposal"]
    assert proposal["kind"] == "propose_questions"
    assert proposal["title"] == "Правка вопросов"
    payload = proposal["payload"]
    assert payload["mode"] == "replace"
    assert [q["question"] for q in payload["questions"]] == [
        "Есть скол?", "Качество?", "Подпись есть?"]
    assert [q["id"] for q in payload["questions"]] == ["q1", "q2", "q9"]
    assert json.loads(edits) == payload["edits"], "исходные edits — в payload"
    assert payload["warn"] == "правило исхода «Брак» ссылается на №1"
    # модель получила ноту про обновление правил
    tool_msg = fake_chat.requests[1]["json"]["messages"][-1]
    note = json.loads(tool_msg["content"])["note"]
    assert "предложи обновлённые правила этим же ответом" in note


async def test_run_agent_propose_questions_edits_collision(fake_chat):
    """Коллизия id (A3): модель предложила id существующего вопроса для нового
    — бэкенд молча переименовывает, переименование отражено в ноте модели и в
    payload карточки (финальные id)."""
    snap = {"questions": [{"n": 1, "id": "q1", "question": "Ок?",
                           "type": "yes_no"}]}
    edits = json.dumps([
        {"op": "add", "question": {"id": "q1", "question": "Новый вопрос?",
                                   "type": "yes_no"}}], ensure_ascii=False)
    fake_chat.responses = [
        sse_lines(hermes_call("propose_questions", {"edits": edits})),
        sse_lines("Предложил добавить."),
    ]
    events = await collect_events(run_agent(
        [], "добавь вопрос", snap, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    proposal = events[0]["proposal"]
    assert [q["id"] for q in proposal["payload"]["questions"]] == ["q1", "q1-2"]
    note = json.loads(fake_chat.requests[1]["json"]["messages"][-1
                     ].get("content", "{}")).get("note", "")
    assert "q1 → q1-2" in note


async def test_run_agent_propose_questions_edits_error(fake_chat):
    """edits с несуществующим id — proposal не создаётся, internal tool-error
    с verbatim-подсказкой актуальных id, модель чинится тем же ответом."""
    snap = {"questions": [{"n": 1, "id": "q1", "question": "Ок?",
                           "type": "yes_no"}]}
    edits = json.dumps([{"op": "remove", "target": "q5"}], ensure_ascii=False)
    fake_chat.responses = [
        sse_lines(hermes_call("propose_questions", {"edits": edits})),
        sse_lines("Исправляюсь."),
    ]
    events = await collect_events(run_agent(
        [], "удали пятый", snap, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))

    assert event_types(events) == ["tool", "token", "done"]
    assert events[0]["status"] == "error" and events[0]["internal"] is True
    assert "вопроса «q5» нет" in events[0]["message"]
    assert "актуальные id: q1" in events[0]["message"]


async def test_run_agent_strips_stray_markup(fake_chat):
    """Модель выдала hermes-разметку неизвестного/невалидного вызова — после
    ретрая с ошибкой валидации отвечает текстом; разметка не утекает наружу."""
    fake_chat.responses = [
        sse_lines("<tool_call><function=no_such_tool></function></tool_call>"),
        sse_lines("Ответ ", "модели."),
    ]
    events = await collect_events(run_agent(
        [], "привет", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    types = event_types(events)
    assert types == ["tool", "token", "token", "done"]
    assert events[0]["status"] == "error"
    assert "Неизвестный инструмент" in events[0]["message"]
    tokens = "".join(e["text"] for e in events if e["type"] == "token")
    assert tokens == "Ответ модели."
    assert len(fake_chat.requests) == 2  # ретрай после ошибки валидации
    tool_msg = fake_chat.requests[1]["json"]["messages"][-1]
    assert tool_msg["role"] == "tool"
    assert "Неизвестный инструмент" in tool_msg["content"]


async def test_run_agent_broken_tool_call_retried(fake_chat):
    """Обрыв hermes-разметки (parse_tool_calls пуст, но маркеры есть): цикл даёт
    модели один ретрай с просьбой повторить вызов, а не отдаёт огрызок ответом."""
    tool_calls = []
    fake_chat.responses = [
        sse_lines("Сейчас: <tool_call><function=propose_decision><parameter=outcomes>[{"),
        sse_lines(hermes_call("get_state", {})),
        sse_lines("Готово."),
    ]
    events = await collect_events(run_agent(
        [], "предложи правила", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools(tool_calls)))

    names = [e.get("name") for e in events if e["type"] == "tool"]
    assert "retry" in names, event_types(events)
    assert tool_calls == ["get_state"]
    assert len(fake_chat.requests) == 3
    # NB: requests[i]["json"]["messages"] — ссылка на живой список (мутирует
    # между шагами), содержимое шага по ним не проверить — только события.
    # обрывок разметки наружу не утёк
    tokens = "".join(e["text"] for e in events if e["type"] == "token")
    assert "<tool_call" not in tokens and "<function=" not in tokens


async def test_run_agent_broken_tool_call_retried_once(fake_chat):
    """Повторный слом разметки — второй ретрай не делаем, текстовый фолбэк."""
    fake_chat.responses = [
        sse_lines("<tool_call><function=get_state"),
        sse_lines("Не выходит. <tool_call><function=get_state"),
    ]
    events = await collect_events(run_agent(
        [], "привет", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))

    names = [e.get("name") for e in events if e["type"] == "tool"]
    assert names.count("retry") == 1
    assert len(fake_chat.requests) == 2  # третьего шага нет
    assert events[-1]["type"] == "done"
    tokens = "".join(e["text"] for e in events if e["type"] == "token")
    assert "<tool_call" not in tokens and "<function=" not in tokens


async def test_run_agent_phantom_guard_recovers(fake_chat):
    """Страж фантомов: модель заявила «предложил карточку», но вызова не было —
    ход не завершается, модель получает подсказку и вызывает инструмент
    (инцидент 16.10: выдуманные карточки и прогоны на длинной истории)."""
    fake_chat.responses = [
        sse_lines("Предложил вам новый контекст."),
        sse_lines(hermes_call("propose_context",
                              {"text": '"новый"', "mode": '"replace"'})),
        sse_lines("Теперь карточка на месте."),
    ]
    events = await collect_events(run_agent(
        [], "поменяй контекст", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))

    names = [e.get("name") for e in events if e["type"] == "tool"]
    assert names == ["phantom_guard"], event_types(events)
    assert "proposal" in event_types(events)
    assert len(fake_chat.requests) == 3  # фантом → подсказка → вызов → финал


async def test_run_agent_phantom_guard_not_fired(fake_chat):
    """Страж молчит: карточка реально ушла за ход; обычный текст; условное
    «предложил бы» — не утверждение о свершившемся действии."""
    # фаза 1: proposal был — «Предложил» легитимно
    fake_chat.responses = [
        sse_lines(hermes_call("propose_context",
                              {"text": '"новый"', "mode": '"replace"'})),
        sse_lines("Предложил контекст."),
    ]
    events = await collect_events(run_agent(
        [], "поменяй контекст", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    assert "phantom_guard" not in [e.get("name") for e in events]
    assert len(fake_chat.requests) == 2

    # фаза 2: обычный ответ без претензий
    fake_chat.requests = []  # фейк индексирует responses по числу запросов
    fake_chat.responses = [sse_lines("Всё понятно, спрашивайте.")]
    events = await collect_events(run_agent(
        [], "привет", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    assert event_types(events) == ["token", "done"]
    assert len(fake_chat.requests) == 1

    # фаза 3: условное наклонение — не срабатывает
    fake_chat.requests = []
    fake_chat.responses = [sse_lines("Я предложил бы вариант, но нужны данные.")]
    events = await collect_events(run_agent(
        [], "привет", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    assert event_types(events) == ["token", "done"]
    assert len(fake_chat.requests) == 1


async def test_run_agent_phantom_guard_fires_once(fake_chat):
    """Повторная претензия без вызова — второго срабатывания нет, текст
    отдаётся как есть (не зацикливаемся)."""
    fake_chat.responses = [
        sse_lines("Предложил вам правила."),
        sse_lines("Снова предложил вам правила."),
    ]
    events = await collect_events(run_agent(
        [], "предложи правила", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))

    names = [e.get("name") for e in events if e["type"] == "tool"]
    assert names.count("phantom_guard") == 1
    assert len(fake_chat.requests) == 2  # третьего шага нет
    assert events[-1]["type"] == "done"


async def test_run_agent_phantom_guard_promises(fake_chat):
    """Страж ловит и обещание действия без вызова (инцидент 17.10:
    «Пробую ещё раз, коротко» — и 0 вызовов, дважды подряд)."""
    fake_chat.responses = [
        sse_lines("Пробую ещё раз, коротко."),
        sse_lines(hermes_call("propose_context",
                              {"text": '"новый"', "mode": '"replace"'})),
        sse_lines("Готово."),
    ]
    events = await collect_events(run_agent(
        [], "а где карточки?", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    names = [e.get("name") for e in events if e["type"] == "tool"]
    assert names == ["phantom_guard"], event_types(events)
    assert "proposal" in event_types(events)
    assert len(fake_chat.requests) == 3


async def test_run_agent_phantom_guard_typed_bypass(fake_chat):
    """По-типовой страж: proposal за ход ушло, но ответ заявляет прогон —
    страж срабатывает по trial (инцидент 17.10, 10:13: proposal-событие
    обезоруживало общий страж, выдуманный прогон уходил текстом)."""
    fake_chat.responses = [
        sse_lines(hermes_call("propose_context",
                              {"text": '"новый"', "mode": '"replace"'})),
        sse_lines("Карточка выше. Прогнал — стало 100%."),
        sse_lines("Признаю: прогона не было, цифры выдумал."),
    ]
    events = await collect_events(run_agent(
        [], "поменяй контекст и прогони", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))

    names = [e.get("name") for e in events if e["type"] == "tool"]
    assert "phantom_guard" in names
    assert "proposal" in event_types(events)
    assert len(fake_chat.requests) == 3  # вызов → фантом прогона → финал


async def test_run_agent_degrade_guard_recovers(fake_chat):
    """Детектор деградации: CJK-мусор в финале — ретрай шага с подсказкой,
    нормальный ответ доходит (инцидент 17.10, 10:14: три хода тарабарщины)."""
    fake_chat.responses = [
        sse_lines("уapa收藏本站 (utunah"),
        sse_lines("Всё в порядке, повторяю по-русски."),
    ]
    events = await collect_events(run_agent(
        [], "привет", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))

    names = [e.get("name") for e in events if e["type"] == "tool"]
    assert names == ["degrade_guard"], event_types(events)
    # мусор мог частично уйти стримом до финальной проверки — как и у
    # phantom-стража, это принятый tradeoff; важен ретрай и итог
    tokens = "".join(e["text"] for e in events if e["type"] == "token")
    assert "Всё в порядке" in tokens
    assert events[-1]["type"] == "done"
    assert len(fake_chat.requests) == 2


async def test_run_agent_degrade_guard_gives_up(fake_chat):
    """Повторная деградация за ход — честная ошибка вместо мусора."""
    fake_chat.responses = [
        sse_lines("уapa收藏本站"),
        sse_lines("а?"),
    ]
    events = await collect_events(run_agent(
        [], "привет", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))

    names = [e.get("name") for e in events if e["type"] == "tool"]
    assert names == ["degrade_guard"], event_types(events)
    assert events[-1]["type"] == "error"
    assert "бессвязн" in events[-1]["message"]
    assert len(fake_chat.requests) == 2  # третьего шага нет


def test_trial_claim_phrasings():
    """Фразы фантомных прогонов из сок-сессий 17.10 (qwen-модели обходили
    страж формулировками «прогон готов», «гипотеза подтвердилась»)."""
    from backend.assistant.agent import _phantom_missing
    for text in ["Пробный прогон по 4 вопросам готов — таблица в чате.",
                 "Пробный прогон подтвердил: исход «Требует внимания».",
                 "Сделал два пробных прогона — везде «да».",
                 "Гипотеза подтвердилась: 82% «нет».",
                 "Прогон уже в чате, смотрите цифры."]:
        assert "trial" in _phantom_missing(text, {"proposal"}), text
    # trial за ход был — легитимно
    assert _phantom_missing("Пробный прогон готов.", {"trial"}) == []
    # «пришёл/отправил карточку» без proposal-события (обход из сессии C)
    assert "proposal" in _phantom_missing(
        "Пришёл карточку правила заново.", set())
    assert "proposal" in _phantom_missing(
        "Отправил карточку с пресетом.", {"trial"})
    # предложение действия, а не утверждение — не ловим
    assert _phantom_missing("Могу прогнать, если хотите.", set()) == []


def test_proposal_claim_reissue_verbs():
    """Инцидент 19.10: модель заявила «перевыпустил правила» без вызова —
    страж промолчал (regex не знал лексику «выпуск»), пользователь трижды
    спрашивал «где карточка». Формы собраны из журнала 17–19.10."""
    from backend.assistant.agent import _phantom_missing
    for text in ["Готово — исправил ссылки и перевыпустил правила.",
                 "Перевыпускаю карточку с правилами.",
                 "Перевыпущу карточку заново.",
                 "Выпускаю обе карточки — правку вопросов и правила.",
                 "Оформил карточку с новым набором.",
                 "Карточка правил выпущена, смотрите выше.",
                 "Сейчас перевыпущу предложение."]:
        assert "proposal" in _phantom_missing(text, set()), text
    # proposal за ход был — легитимно
    assert _phantom_missing("Перевыпустил правила.", {"proposal"}) == []
    # отрицания и честные признания — не ловим
    assert _phantom_missing(
        "Карточку с правилами отправить не удалось.", set()) == []


# Снапшот для тестов виртуального состояния хода (P0, инцидент 17.10):
# q1 — дубль (yes_no), q2 — choice, q3 — score.
SNAP_TURN = {"questions": [
    {"n": 1, "id": "q1", "question": "Дубль?", "type": "yes_no"},
    {"n": 2, "id": "q2", "question": "Тон?", "type": "choice",
     "options": ["А", "Б"]},
    {"n": 3, "id": "q3", "question": "Оценка?", "type": "score",
     "levels": ["п", "н", "о"]}]}
# набор после удаления дубля: id q2/q3 сохраняются (A3 — сдвиг № не ломает
# ссылки)
TURN_QS = json.dumps([
    {"id": "q2", "question": "Тон?", "type": "choice",
     "options": ["А", "Б"]},
    {"id": "q3", "question": "Оценка?", "type": "score",
     "levels": ["п", "н", "о"]}], ensure_ascii=False)
TURN_DECISION = json.dumps([
    {"label": "Плохо", "rules": [{"conditions": [
        {"question": "q2", "answer": "А", "op": "gte", "threshold": 50},
        {"question": "q3", "score": 2, "op": "gte"}]}]},
    {"label": "Ок", "isDefault": True, "rules": []}], ensure_ascii=False)


async def test_run_agent_failed_call_replaced_in_history(fake_chat):
    """Ledger-история (v1.0, arXiv:2608.23651): вербатим упавшего вызова не
    остаётся в контексте следующего шага — только рантайм-описание провала
    (вербатим повышает повтор ошибки 0.06→0.54)."""
    fake_chat.responses = [
        sse_lines(hermes_call("run_trial", {"title": '"x"'})),
        sse_lines("Прогон не удался: нечего прогонять."),
    ]
    events = await collect_events(run_agent(
        [], "прогони", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    assert events[-1]["type"] == "done"
    assert len(fake_chat.requests) == 2
    msgs = fake_chat.requests[1]["json"]["messages"]
    asst = [m for m in msgs if m["role"] == "assistant"]
    assert asst, "шаг с вызовом — в истории"
    content = asst[-1]["content"]
    assert "<tool_call" not in content and "<function=" not in content, \
        "вербатим упавшего вызова вымыт из контекста"
    assert "[система: вызов run_trial" in content
    assert "завершился ошибкой" in content


async def test_run_agent_old_tool_results_cleared(fake_chat):
    """Tool result clearing: старые результаты инструментов в окне хода
    схлопываются в однострочники, свежие два остаются полными."""
    async def get_state(_args=None):
        return {"ok": True, "state": {"mode": "single", "blob": "x" * 500}}
    fake_chat.responses = [
        sse_lines(hermes_call("get_state", {})),
        sse_lines(hermes_call("get_state", {})),
        sse_lines(hermes_call("get_state", {})),
        sse_lines("Готово."),
    ]
    events = await collect_events(run_agent(
        [], "три проверки", None, CHAT_URL,
        thinking=False, read_tools={"get_state": get_state}))
    assert events[-1]["type"] == "done"
    assert len(fake_chat.requests) == 4
    msgs = fake_chat.requests[3]["json"]["messages"]
    tools = [m for m in msgs if m["role"] == "tool"]
    assert len(tools) == 3
    assert tools[0]["content"].startswith("[get_state: выполнен"), \
        "старый результат схлопнут"
    assert "blob" not in tools[0]["content"]
    assert "blob" in tools[1]["content"] and "blob" in tools[2]["content"], \
        "свежие два — полные"


async def test_remote_agent_failed_call_arguments_replaced(fake_chat, monkeypatch):
    """Remote-цикл: у упавшего native-вызова arguments в истории заменяются
    маркером провала (структуру tool_calls/tool_call_id ломать нельзя)."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    fake_chat.responses = [
        sse_chunks(_tc_delta("run_trial", '{"title": "x"}')),
        sse_chunks(_content_delta("Не вышло.")),
    ]
    events = await collect_events(run_remote_agent(
        [], "прогони", None, _remote_entry(), thinking=False))
    assert events[-1]["type"] == "done"
    msgs = fake_chat.requests[1]["json"]["messages"]
    asst = [m for m in msgs if m["role"] == "assistant" and m.get("tool_calls")]
    assert asst
    args_str = asst[-1]["tool_calls"][0]["function"]["arguments"]
    assert "_failed" in args_str and '"title"' not in args_str


def test_propose_decision_description_example_valid():
    """Пример вызова в description propose_decision (input_examples, v1.0)
    обязан быть валидным — иначе он учит модель битой схеме: проходит
    validate_args и доменную валидацию против снапшота."""
    import re as _re
    desc = next(t["function"]["description"] for t in TOOLS
                if t["function"]["name"] == "propose_decision")
    m = _re.search(r"Пример: (\{.*\})", desc)
    assert m, "пример в description"
    fixed, err = validate_args("propose_decision", json.loads(m.group(1)))
    assert err is None, err
    snap = {"questions": [{"n": 1, "id": "q1", "question": "Q?",
                           "type": "yes_no"}]}
    assert validate_against_snapshot("propose_decision", fixed, snap) is None


def test_repeat_guard_canonical_args():
    """Fingerprint — canonical JSON аргументов: переупорядоченные ключи и
    лишние пробелы — тот же повтор; изменённые аргументы — новая попытка
    (v1.0: модель ре-сериализует JSON по-разному, сырой ключ петлю не ловил)."""
    from backend.assistant.agent import _RepeatGuard
    g = _RepeatGuard()
    err = "в наборе 3 вопросов"
    assert g.note("run_trial", {"a": 1, "b": [2, 3]}, err) == 1
    assert g.note("run_trial", {"b": [2, 3], "a": 1}, err) == 2, \
        "переупорядоченные ключи — тот же повтор"
    assert g.note("run_trial", {"a": 1, "b": [2, 3]}, "другая ошибка") == 1
    assert g.note("run_trial", {"a": 1, "b": [2, 4]}, err) == 1, \
        "изменённые аргументы — не повтор (это попытка починиться)"
    assert g.note("run_trial", None, err) == 1  # args=None не роняет


async def test_run_agent_decision_validated_against_turn_questions(fake_chat):
    """Правила тем же ходом после карточки вопросов валидируются против её
    итогового набора (по id, A3), а не против снапшота — инцидент 17.10:
    3 ошибки валидации → RepeatGuard → карточка правил умерла, хотя модель
    всё построила верно."""
    fake_chat.responses = [
        sse_lines(hermes_call("propose_questions",
                              {"questions": TURN_QS, "mode": "replace"})),
        sse_lines(hermes_call("propose_decision",
                              {"outcomes": TURN_DECISION})),
        sse_lines("Готово."),
    ]
    events = await collect_events(run_agent(
        [], "удали дубль и обнови правила", SNAP_TURN, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    props = [e["proposal"]["kind"] for e in events
             if e["type"] == "proposal"]
    assert props == ["propose_questions", "propose_decision"], \
        event_types(events)
    errors = [e for e in events
              if e["type"] == "tool" and e.get("status") == "error"]
    assert not errors, errors


async def test_run_agent_decision_virtual_set_bounds(fake_chat):
    """Виртуальный набор ограничивает и сверху: ссылка на id вне его —
    ошибка с verbatim-подсказкой id НОВОГО набора (q2, q3), а не снапшота."""
    fake_chat.responses = [
        sse_lines(hermes_call("propose_questions",
                              {"questions": TURN_QS, "mode": "replace"})),
        sse_lines(hermes_call("propose_decision", {"outcomes": json.dumps(
            [{"label": "Плохо", "rules": [{"conditions": [
                {"question": "q1", "answer": "yes", "op": "gte",
                 "threshold": 50}]}]}], ensure_ascii=False)})),
        sse_lines(hermes_call("propose_decision",
                              {"outcomes": TURN_DECISION})),
        sse_lines("Исправил."),
    ]
    events = await collect_events(run_agent(
        [], "удали дубль и обнови правила", SNAP_TURN, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    errors = [e for e in events
              if e["type"] == "tool" and e.get("status") == "error"]
    assert len(errors) == 1, event_types(events)
    assert "вопроса «q1» нет" in errors[0]["message"]
    assert "актуальные id: q2, q3" in errors[0]["message"]
    props = [e["proposal"]["kind"] for e in events
             if e["type"] == "proposal"]
    assert props == ["propose_questions", "propose_decision"]


async def test_run_agent_connect_error(fake_chat):
    fake_chat.raise_connect = True
    events = await collect_events(run_agent(
        [], "привет", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    assert event_types(events) == ["error"]
    assert "недоступна" in events[0]["message"]
    assert "нет соединения" in events[0]["message"]


async def test_run_agent_non_200_status(fake_chat):
    fake_chat.responses = [[]]  # строки не дойдут: статус не 200
    fake_chat.status_code = 500
    fake_chat.body = "boom".encode()
    events = await collect_events(run_agent(
        [], "привет", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    assert event_types(events) == ["error"]
    assert "500" in events[0]["message"] and "недоступен" in events[0]["message"]


class FakeOverflowClient:
    """Первый stream() → 400 «context length», дальше — обычные ответы."""

    requests: list[dict] = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def stream(self, method, url, json=None, **kwargs):
        FakeOverflowClient.requests.append({"url": url, "json": json})
        idx = len(FakeOverflowClient.requests) - 1
        if idx == 0:
            return FakeStreamResponse([], status_code=400, body=(
                b'{"message":"Requested token count exceeds the model '
                b'maximum context length of 8192 tokens"}'))
        return FakeStreamResponse(sse_lines("Ответ после сокращения"))


async def test_run_agent_context_overflow_retry(monkeypatch):
    """400 «context length» → история режется до system+последний вопрос,
    max_tokens снижается, запрос повторяется и ответ доезжает."""
    FakeOverflowClient.requests = []
    monkeypatch.setattr(agent.httpx, "AsyncClient", FakeOverflowClient)
    history = [{"role": "user", "content": f"старый вопрос {i}"} for i in range(6)]
    events = await collect_events(run_agent(
        history, "новый вопрос", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    types = event_types(events)
    assert types[-1] == "done"
    assert "token" in types
    assert "error" not in types
    assert len(FakeOverflowClient.requests) == 2, "должен быть ровно один ретрай"
    first, second = (r["json"] for r in FakeOverflowClient.requests)
    assert first["max_tokens"] == 2048
    assert second["max_tokens"] == 1024
    roles = [m["role"] for m in second["messages"]]
    assert roles == ["system", "user"], roles
    assert second["messages"][-1]["content"] == "новый вопрос"


async def test_run_agent_context_overflow_single_retry(monkeypatch):
    """Повторный 400 после ретрая — честная ошибка, без бесконечного цикла."""
    FakeOverflowClient.requests = []
    monkeypatch.setattr(agent.httpx, "AsyncClient", FakeOverflowClient)
    # обе попытки → 400: патчим второй ответ тоже на 400
    orig_stream = FakeOverflowClient.stream

    def always_400(self, method, url, json=None, **kwargs):
        orig_stream(self, method, url, json=json, **kwargs)
        return FakeStreamResponse([], status_code=400, body=b"context length")

    monkeypatch.setattr(FakeOverflowClient, "stream", always_400)
    events = await collect_events(run_agent(
        [{"role": "user", "content": "старый"}], "вопрос", None, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    assert event_types(events)[-1] == "error"
    assert "400" in events[-1]["message"]
    assert len(FakeOverflowClient.requests) == 2, "одна попытка + один ретрай"


async def test_run_agent_max_steps_fallback_summary(fake_chat):
    """6 шагов ушли на инструменты → запасной финальный шаг без tools:
    модель подводит итог текстом, а не падает с «превышен лимит шагов»."""
    fake_chat.responses = [
        sse_lines("<tool_call><function=get_state></function></tool_call>")
    ] * 6 + [sse_lines("Итог: всё собрано.")]
    events = await collect_events(run_agent(
        [], "разбери всё подряд", {"mode": "single"}, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    types = event_types(events)
    assert types[-2:] == ["token", "done"]
    assert "error" not in types
    assert events[-2]["text"] == "Итог: всё собрано."
    notes = [e for e in events if e["type"] == "tool" and e["name"] == "steps"]
    assert notes and "Лимит шагов" in notes[0]["message"]
    assert len(fake_chat.requests) == 7
    last = fake_chat.requests[-1]["json"]
    assert "tools" not in last, "на запасном шаге инструменты недоступны"
    assert last["messages"][-1]["role"] == "user"
    assert "Лимит шагов исчерпан" in last["messages"][-1]["content"]


def _hermes(name: str, args: dict) -> str:
    body = "".join(f"<parameter={k}>\n{json.dumps(v, ensure_ascii=False)}\n"
                   f"</parameter>\n" for k, v in args.items())
    return f"<tool_call><function={name}>\n{body}</function></tool_call>"


async def test_run_agent_duplicate_proposals_deduped(fake_chat):
    """Карточка-дождь (eval 21.10, s2 — 5 идентичных карточек пересборки за
    ход): повтор (kind + канонический payload) в пределах хода пользователю
    не уходит — internal tool-событие dedup (в журнал идёт, в ленту нет) и
    note модели; разные payload одного kind пропускаются все."""
    def decision(label):
        return {"outcomes": [
            {"label": label, "rules": [{"conditions": [
                {"question": "q1", "answer": "yes", "op": "gte",
                 "threshold": 80}]}]},
            {"label": "Прочее", "isDefault": True, "rules": []}]}

    snapshot = {"questions": [{"n": 1, "id": "q1", "question": "Ок?",
                               "type": "yes_no"}]}

    # фаза 1: пять идентичных вызовов за один шаг → одна карточка
    same5 = "".join(_hermes("propose_decision", decision("Да"))
                    for _ in range(5))
    fake_chat.responses = [sse_lines(same5), sse_lines("Карточка выше.")]
    events = await collect_events(run_agent(
        [], "настрой правила", snapshot, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    proposals = [e for e in events if e["type"] == "proposal"]
    assert len(proposals) == 1, "дубли за ход поглощаются"
    dedup_notes = [e for e in events if e["type"] == "tool"
                   and e["name"] == "dedup"]
    assert len(dedup_notes) == 4 and all(e.get("internal") for e in dedup_notes)
    assert event_types(events)[-1] == "done"

    # фаза 2: разные payload одного kind → обе карточки проходят
    two = _hermes("propose_decision", decision("Да")) \
        + _hermes("propose_decision", decision("Иначе"))
    fake_chat.requests = []  # FakeChatClient индексирует responses по счётчику
    fake_chat.responses = [sse_lines(two), sse_lines("Две карточки.")]
    events = await collect_events(run_agent(
        [], "настрой правила", snapshot, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    proposals = [e for e in events if e["type"] == "proposal"]
    assert len(proposals) == 2, "разные payload одного kind — не дубли"
    assert not [e for e in events if e["type"] == "tool"
                and e["name"] == "dedup"]


async def test_run_agent_repeat_error_breaker(fake_chat):
    """Анти-петля: 2-я одинаковая ошибка → подсказка «не повторяй», инструменты
    ещё доступны (модель может починиться); 3-я → досрочный финальный шаг
    без инструментов (инцидент 16.10: 5 одинаковых фейлов propose_decision)."""
    bad_call = "<tool_call><function=propose_decision>\n" \
        "<parameter=outcomes>\n" + json.dumps([{"label": "a", "rules": [
            {"conditions": [{"question": 1, "op": "gte"}]}]}]) + \
        "\n</parameter>\n</function></tool_call>"
    fake_chat.responses = [
        sse_lines(bad_call),
        sse_lines(bad_call),
        sse_lines(bad_call),
        sse_lines("Не удалось подготовить правила, предлагаю текстом."),
        # запас на случай регресса — breaker не должен дать дойти сюда
        sse_lines(bad_call), sse_lines(bad_call),
    ]
    events = await collect_events(run_agent(
        [], "предложи правила", {"mode": "single"}, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    types = event_types(events)
    assert types[-2:] == ["token", "done"] and "error" not in types
    assert len(fake_chat.requests) == 4, "3 упавших вызова + финальный шаг"
    notes = [e for e in events if e["type"] == "tool" and e["name"] == "steps"]
    assert notes and "Одна и та же ошибка повторяется" in notes[0]["message"]
    # на 2-м фейле модель получила предупреждение — и инструменты ещё были
    # (NB: requests[i]["json"]["messages"] — ссылка на живой список, видны
    # все сообщения на конец прогона; подсказка — на 2-й из трёх ошибок)
    tool_msgs = [m for m in fake_chat.requests[2]["json"]["messages"]
                 if m["role"] == "tool"]
    assert sum("уже падал с этой же ошибкой" in m["content"]
               for m in tool_msgs) == 1, "подсказка ровно на одной ошибке"
    assert "tools" in fake_chat.requests[2]["json"], \
        "подсказка приходит, пока модель может ей воспользоваться"
    assert "tools" not in fake_chat.requests[-1]["json"]


async def test_run_agent_repeat_hint_enables_repair(fake_chat):
    """Подсказка на 2-й ошибке — не приговор: модель чинится на следующем
    шаге, принудительного финала нет (находка eval 17.10: deepseek после
    полного списка ошибок повторял вызов идентично)."""
    bad_call = "<tool_call><function=propose_decision>\n" \
        "<parameter=outcomes>\n" + json.dumps([{"label": "a", "rules": [
            {"conditions": [{"question": 1, "op": "gte"}]}]}]) + \
        "\n</parameter>\n</function></tool_call>"
    good = json.dumps([{"label": "Ок", "isDefault": True, "rules": []}],
                      ensure_ascii=False)
    fake_chat.responses = [
        sse_lines(bad_call),
        sse_lines(bad_call),
        sse_lines(hermes_call("propose_decision", {"outcomes": good})),
        sse_lines("Исправил."),
    ]
    events = await collect_events(run_agent(
        [], "предложи правила", {"mode": "single"}, CHAT_URL,
        thinking=False, read_tools=make_read_tools([])))
    assert "proposal" in event_types(events), event_types(events)
    notes = [e for e in events if e["type"] == "tool" and e["name"] == "steps"]
    assert not notes, "принудительного финала после подсказки нет"
    assert len(fake_chat.requests) == 4


# ---------------------------------------------------------------- роутер

class FakeRouterClient:
    """Подмена httpx.AsyncClient для роутера: get() — проба /v1/models,
    stream() — chat completions."""

    stream_responses: list[list[str]] = []
    stream_requests: list[dict] = []
    get_ok = True

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, **kwargs):
        if not FakeRouterClient.get_ok:
            raise httpx.ConnectError("connection refused")
        return FakeStreamResponse([], status_code=200)

    def stream(self, method, url, json=None, **kwargs):
        FakeRouterClient.stream_requests.append(
            {"method": method, "url": url, "json": json})
        idx = len(FakeRouterClient.stream_requests) - 1
        return FakeStreamResponse(FakeRouterClient.stream_responses[idx])


@pytest.fixture
def fake_router_http(monkeypatch):
    FakeRouterClient.stream_responses = []
    FakeRouterClient.stream_requests = []
    FakeRouterClient.get_ok = True
    monkeypatch.setattr(httpx, "AsyncClient", FakeRouterClient)
    return FakeRouterClient


def test_assistant_models_structure():
    r = client.get("/api/assistant/models")
    assert r.status_code == 200
    models = r.json()["models"]
    keys = {m["key"] for m in models}
    assert {MODEL_A, MODEL_B} <= keys
    assert LAYA not in keys       # llamacpp по умолчанию — только роль decision
    assert CLEF_FLASH not in keys  # clef — не chat completions
    assert JEV not in keys         # remote — не chat-capable тип
    assert "bonsai2-27b" in keys  # bonsai включён в конфиге, роль chat
    for m in models:
        entry = mm.REGISTRY[m["key"]]
        assert "chat" in entry.roles and entry.enabled
        assert m["label"] == entry.label
        assert set(m) == {"key", "label", "remote"}
        assert m["remote"] == remote_llm.is_chat_entry(entry)


def test_assistant_models_follow_chat_role():
    """Фильтр идёт по роли chat, а не по типу: chat-only sglang и
    llamacpp с выданной ролью проходят, decision-only sglang — нет."""
    laya = mm.REGISTRY[LAYA]
    model_a = mm.REGISTRY[MODEL_A]
    saved = (laya.roles, model_a.roles)
    try:
        laya.roles = ["decision", "chat"]
        model_a.roles = ["chat"]
        keys = {m["key"] for m in client.get("/api/assistant/models").json()["models"]}
        assert LAYA in keys and MODEL_A in keys
        model_a.roles = ["decision"]
        keys = {m["key"] for m in client.get("/api/assistant/models").json()["models"]}
        assert MODEL_A not in keys
        # chat-эндпоинт тоже проверяет роль
        r = client.post("/api/assistant/chat",
                        json={"model_key": MODEL_A, "message": "привет"})
        assert r.status_code == 422
        assert MODEL_A in r.json()["detail"]
    finally:
        laya.roles, model_a.roles = saved


def test_chat_empty_message_422():
    for msg in ("", "   ", None):
        r = client.post("/api/assistant/chat",
                        json={"model_key": MODEL_A, "message": msg})
        assert r.status_code == 422, msg


def test_chat_unknown_or_incapable_model_422():
    r = client.post("/api/assistant/chat",
                    json={"model_key": "no-such-model", "message": "привет"})
    assert r.status_code == 422
    r = client.post("/api/assistant/chat",
                    json={"model_key": CLEF_FLASH, "message": "привет"})
    assert r.status_code == 422
    assert CLEF_FLASH in r.json()["detail"]


def test_chat_model_not_running_409(fake_router_http):
    fake_router_http.get_ok = False  # проба GET /v1/models падает
    r = client.post("/api/assistant/chat",
                    json={"model_key": MODEL_A, "message": "привет"})
    assert r.status_code == 409
    assert "не запущена" in r.json()["detail"]
    assert fake_router_http.stream_requests == []  # до стрима не дошло


def test_chat_happy_path_sse(fake_router_http):
    fake_router_http.stream_responses = [sse_lines("Ответ ", "модели.")]
    r = client.post("/api/assistant/chat", json={
        "model_key": MODEL_A, "message": "привет",
        "history": [{"role": "user", "content": "ранее"},
                    {"role": "system", "content": "отфильтруется"}],
        "snapshot": {"mode": "single"}, "thinking": True,
    })
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    events = [json.loads(line[len("data: "):])
              for line in r.text.splitlines() if line.startswith("data: ")]
    assert events[-1] == {"type": "done"}
    tokens = "".join(e["text"] for e in events if e["type"] == "token")
    assert tokens == "Ответ модели."
    # chat_url из реестра; history отфильтрована до user/assistant
    req = fake_router_http.stream_requests[0]
    assert req["url"] == mm.REGISTRY[MODEL_A].url + "/v1/chat/completions"
    assert [m["role"] for m in req["json"]["messages"]] == ["system", "user", "user"]
    assert req["json"]["chat_template_kwargs"] == {"enable_thinking": True}


def test_chat_bonsai_with_tools(fake_router_http):
    """bonsai (chat_template.jinja пака понимает tools): chat-запрос идёт на
    порт 30006 со списком tools и hermes-подсказкой в system-промпте."""
    entry = mm.REGISTRY["bonsai2-27b"]
    fake_router_http.stream_responses = [sse_lines("Привет.")]
    saved = entry.enabled
    entry.enabled = True
    try:
        r = client.post("/api/assistant/chat",
                        json={"model_key": "bonsai2-27b", "message": "привет"})
        assert r.status_code == 200
        req = fake_router_http.stream_requests[0]
        assert req["url"] == "http://127.0.0.1:30006/v1/chat/completions"
        names = [t["function"]["name"] for t in req["json"]["tools"]]
        assert "get_state" in names and "run_trial" in names
        sysmsg = req["json"]["messages"][0]["content"]
        assert "<tool_call><function=" in sysmsg  # hermes-подсказка с примером
    finally:
        entry.enabled = saved


def test_propose_validate_ok():
    r = client.post("/api/assistant/propose/validate", json={
        "kind": "propose_questions",
        "payload": {"questions": [{"id": "q1", "question": "Ок?", "type": "yes_no"}],
                    "mode": "replace"}})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


# ------------------------------------------------------- журнал и бикон (v0.8)

def _journal_records(path):
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()
            if l.strip()]


def test_chat_journal_record_done(fake_router_http, _journal_tmp):
    """Запрос /chat → одна строка type:"chat" в журнале: исход, шаги с
    аргументами и длительностью, превью ответа, размер снапшота."""
    fake_router_http.stream_responses = [
        sse_lines("<tool_call><function=get_state></function></tool_call>"),
        sse_lines("Всё посмотрел."),
    ]
    r = client.post("/api/assistant/chat", json={
        "model_key": MODEL_A, "message": "что в приложении?",
        "snapshot": {"mode": "single"}})
    assert r.status_code == 200
    recs = _journal_records(_journal_tmp)
    assert len(recs) == 1
    rec = recs[0]
    assert rec["type"] == "chat" and rec["outcome"] == "done"
    assert rec["model_key"] == MODEL_A and rec["remote"] is False
    assert rec["user"] == "что в приложении?"
    assert rec["answer_preview"] == "Всё посмотрел."
    assert rec["answer_chars"] == len("Всё посмотрел.")
    assert rec["snapshot"]["chars"] > 0 and rec["snapshot"]["budget"] > 0
    assert rec["snapshot"]["truncated"] is False
    assert rec["duration_ms"] >= 0 and rec["fallback"] is False
    assert rec["thinking"] is False
    assert len(rec["steps"]) == 1
    step = rec["steps"][0]
    assert step["tool"] == "get_state" and step["status"] == "done"
    assert step["args"] == "{}" and step["ms"] >= 0


async def test_journal_stream_error_and_abort(_journal_tmp):
    """Исходы error (SSE error событие) и abort (клиент закрыл стрим)."""
    async def err_gen():
        yield 'data: {"type": "error", "message": "API ответил 500"}\n\n'
    events = await collect_events(journal.log_chat_stream(
        err_gen(), model_key="m", remote=False, user_message="q",
        snapshot_budget=8000, snapshot_chars=0, snapshot_truncated=False,
        thinking=True))
    assert events == [{"type": "error", "message": "API ответил 500"}]
    rec = _journal_records(_journal_tmp)[0]
    assert rec["outcome"] == "error" and rec["error"] == "API ответил 500"
    assert rec["thinking"] is True

    async def hang_gen():
        yield 'data: {"type": "token", "text": "часть"}\n\n'
        await asyncio.sleep(30)
    g = journal.log_chat_stream(hang_gen(), model_key="m", remote=False,
                                user_message="q", snapshot_budget=8000,
                                snapshot_chars=0, snapshot_truncated=False)
    await g.__anext__()
    await g.aclose()  # клиент отвалился посреди стрима
    recs = _journal_records(_journal_tmp)
    assert recs[1]["outcome"] == "abort"
    assert recs[1]["answer_chars"] == len("часть")


async def test_journal_error_step_args_and_proposal_payload(_journal_tmp):
    """Упавший на валидации вызов пишется с args (start-события не было), а
    предложение — с payload, а не только kind: без этого инциденты вроде
    16.10 (5 фейлов propose_decision) нереконструируемы."""
    def sse(payload: dict) -> str:
        return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"

    async def gen():
        yield sse({"type": "tool", "name": "propose_decision",
                   "status": "error", "message": "bad",
                   "args": '{"outcomes": []}'})
        yield sse({"type": "proposal", "proposal": {
            "id": "x1", "kind": "propose_questions",
            "payload": {"mode": "replace", "questions": [{"id": "q1"}]}}})
        yield sse({"type": "token", "text": "текст"})
        yield sse({"type": "done"})
    await collect_events(journal.log_chat_stream(
        gen(), model_key="m", remote=False, user_message="q",
        snapshot_budget=8000, snapshot_chars=0, snapshot_truncated=False))
    rec = _journal_records(_journal_tmp)[0]
    assert rec["steps"][0]["args"] == '{"outcomes": []}'
    prop = rec["proposals"][0]
    assert prop["kind"] == "propose_questions"
    # id — привязка биконов исходов (applied/declined/invalid) к ходу
    assert prop["id"] == "x1"
    assert json.loads(prop["payload"])["mode"] == "replace"


def test_assistant_event_beacon(_journal_tmp):
    """Бикон исходов карточек: валидный — строка type:"event" в журнале,
    невалидный outcome или пустой kind — 422."""
    r = client.post("/api/assistant/event", json={
        "kind": "propose_decision", "outcome": "applied",
        "proposal_id": "ab12cd34", "session_id": "sess-1"})
    assert r.status_code == 200
    recs = _journal_records(_journal_tmp)
    assert len(recs) == 1
    rec = recs[0]
    assert rec["type"] == "event" and rec["event"] == "card_outcome"
    assert rec["kind"] == "propose_decision" and rec["outcome"] == "applied"
    assert rec["proposal_id"] == "ab12cd34"
    assert rec["session_id"] == "sess-1"

    # старый клиент без session_id — не ошибка, в записи None
    r = client.post("/api/assistant/event", json={
        "kind": "propose_decision", "outcome": "declined"})
    assert r.status_code == 200
    assert _journal_records(_journal_tmp)[1]["session_id"] is None

    bad = client.post("/api/assistant/event",
                      json={"kind": "propose_decision", "outcome": "nope"})
    assert bad.status_code == 422
    missing = client.post("/api/assistant/event", json={"outcome": "applied"})
    assert missing.status_code == 422
    assert len(_journal_records(_journal_tmp)) == 2, "422 не пишет в журнал"


def test_chat_session_id_in_journal(fake_router_http, _journal_tmp):
    """session_id из chat-body пишется в запись журнала (обрезка до 64
    символов); старый клиент без поля — session_id None."""
    fake_router_http.stream_responses = [sse_lines("Ответ."), sse_lines("Ответ.")]
    r = client.post("/api/assistant/chat", json={
        "model_key": MODEL_A, "message": "привет", "session_id": "x" * 100})
    assert r.status_code == 200
    r = client.post("/api/assistant/chat", json={
        "model_key": MODEL_A, "message": "привет"})
    assert r.status_code == 200
    recs = _journal_records(_journal_tmp)
    assert recs[0]["session_id"] == "x" * 64
    assert recs[1]["session_id"] is None


def test_chat_get_file_result_and_list_models(fake_router_http):
    """Read-тулы с аргументами: get_file_result (текст файла + результаты из
    снапшота), list_models (роли/enabled/selected/vision)."""
    snapshot = {
        "page": "batch",
        "batchFiles": [{"name": "doc.txt", "text": "содержимое файла",
                        "imagesCount": 0}],
        "batchResults": {"doc.txt": {"trial-x": {"answers": {"1": "да 80%"},
                                                 "decision": "Ок"}}},
        "selectedModels": [{"key": MODEL_A, "status": "running"}],
    }
    fake_router_http.stream_responses = [
        sse_lines(hermes_call("get_file_result", {"file": '"doc.txt"'})),
        sse_lines(hermes_call("list_models", {})),
        sse_lines("Готово."),
    ]
    r = client.post("/api/assistant/chat", json={
        "model_key": MODEL_A, "message": "что в файле doc.txt?",
        "snapshot": snapshot})
    assert r.status_code == 200
    events = [json.loads(line[len("data: "):])
              for line in r.text.splitlines() if line.startswith("data: ")]
    assert event_types(events) == ["tool", "tool", "tool", "tool", "token", "done"]
    # payload хранит ссылку на живой список messages — смотрим финальное состояние
    msgs = fake_router_http.stream_requests[-1]["json"]["messages"]
    tools = {m.get("name"): m for m in msgs if m.get("role") == "tool"}
    # get_file_result: текст файла и пофайловые результаты из снапшота
    content1 = json.loads(tools["get_file_result"]["content"])
    assert content1["ok"] is True
    assert content1["text"] == "содержимое файла"
    assert content1["results"]["trial-x"]["decision"] == "Ок"
    # list_models: роли/enabled/selected/vision; selected — по снапшоту
    content2 = json.loads(tools["list_models"]["content"])
    m_a = next(m for m in content2["models"] if m["key"] == MODEL_A)
    assert m_a["selected"] is True
    assert m_a["enabled"] is True
    assert "chat" in m_a["roles"] and "decision" in m_a["roles"]
    assert "vision" in m_a


def test_chat_get_file_result_unknown_file(fake_router_http):
    """get_file_result с неизвестным файлом — ошибка со списком доступных."""
    snapshot = {"page": "batch",
                "batchFiles": [{"name": "doc.txt", "text": "x", "imagesCount": 0}]}
    fake_router_http.stream_responses = [
        sse_lines(hermes_call("get_file_result", {"file": '"no.txt"'})),
        sse_lines("Файла нет."),
    ]
    r = client.post("/api/assistant/chat", json={
        "model_key": MODEL_A, "message": "покажи no.txt", "snapshot": snapshot})
    assert r.status_code == 200
    # payload хранит ссылку на живой список messages — смотрим финальное состояние
    msgs = fake_router_http.stream_requests[-1]["json"]["messages"]
    tool = next(m for m in msgs
                if m.get("role") == "tool" and m.get("name") == "get_file_result")
    content = json.loads(tool["content"])
    assert content["ok"] is False
    assert "не найден" in content["error"]
    assert content["available"] == ["doc.txt"]


def test_propose_validate_invalid_422():
    r = client.post("/api/assistant/propose/validate", json={
        "kind": "propose_questions",
        "payload": {"questions": [{"id": "q1", "question": "Ок?", "type": "yes_no"}],
                    "mode": "bogus"}})
    assert r.status_code == 422
    assert "mode" in r.json()["detail"]


def test_propose_validate_unknown_kind_422():
    r = client.post("/api/assistant/propose/validate",
                    json={"kind": "delete_everything", "payload": {}})
    assert r.status_code == 422
    assert "Неизвестный инструмент" in r.json()["detail"]


def test_propose_validate_expanded_edits_payload():
    """Expanded-payload ops-карточки (mode=replace + итоговый questions + edits
    для превью) — валиден для сухой валидации: edits срезаются. Иначе
    превалидация фронта метила бы все ops-карточки невалидными."""
    r = client.post("/api/assistant/propose/validate", json={
        "kind": "propose_questions",
        "payload": {"mode": "replace",
                    "questions": [{"id": "q1", "question": "Ок?",
                                   "type": "yes_no"}],
                    "edits": [{"op": "update", "target": "q1",
                               "question": {"id": "q1", "question": "Ок?",
                                            "type": "yes_no"}}]}})
    assert r.status_code == 200
    # модельный вызов с edits без итогового набора — по-прежнему отказ
    r = client.post("/api/assistant/propose/validate", json={
        "kind": "propose_questions",
        "payload": {"edits": [{"op": "remove", "target": "q1"}],
                    "mode": "append"}})
    assert r.status_code == 422


def test_propose_validate_with_snapshot():
    """Единый базис (A3): /propose/validate с опциональным снапшотом прогоняет
    и state-зависимые проверки (по id) — фронт доверяет серверной валидации
    того же контракта, локальной двойной валидации у него нет."""
    snap = {"questions": [{"n": 1, "id": "q1", "question": "Ок?",
                           "type": "yes_no"}]}
    good = {"outcomes": [{"label": "a", "rules": [{"conditions": [
        {"question": "q1", "answer": "yes", "op": "gte", "threshold": 80}]}]},
        {"label": "b", "isDefault": True, "rules": []}]}
    r = client.post("/api/assistant/propose/validate", json={
        "kind": "propose_decision", "payload": good, "snapshot": snap})
    assert r.status_code == 200
    # неизвестный id — 422 с verbatim-подсказкой актуальных id
    bad = {"outcomes": [{"label": "a", "rules": [{"conditions": [
        {"question": "q_gone", "answer": "yes", "op": "gte",
         "threshold": 80}]}]}, {"label": "b", "isDefault": True, "rules": []}]}
    r = client.post("/api/assistant/propose/validate", json={
        "kind": "propose_decision", "payload": bad, "snapshot": snap})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "вопроса «q_gone» нет" in detail and "актуальные id: q1" in detail
    # тот же payload без снапшота — только схема: state-ошибки не ловятся
    r = client.post("/api/assistant/propose/validate", json={
        "kind": "propose_decision", "payload": bad})
    assert r.status_code == 200


# ---------------------------------------------------------------- run_trial

from backend.assistant import trial as trial_mod
from backend.assistant.tools import ACTION_TOOLS


def _trial_models():
    """Две запущенные decision-модели в реестре (восстановление после теста)."""
    a = mm.ModelEntry("trial-a", "Trial A", "", 0, type="remote",
                      api="decisions", base_url="http://ta", roles=["decision"])
    b = mm.ModelEntry("trial-b", "Trial B", "", 0, type="remote",
                      api="decisions", base_url="http://tb", roles=["decision"])
    mm.REGISTRY[a.key] = a
    mm.REGISTRY[b.key] = b
    return a, b


def _cleanup_trial_models():
    for key in ("trial-a", "trial-b"):
        mm.REGISTRY.pop(key, None)


@pytest.fixture
def trial_env(monkeypatch):
    a, b = _trial_models()

    async def fake_status(entry):
        return {"key": entry.key, "status": "running"}

    async def fake_decide(req):
        answers = {q.id: {"type": q.type, "probabilities": {"yes": 0.8, "no": 0.2}}
                   for q in req.questions}
        return {"results": {key: {"ok": True, "answers": answers}
                            for key in req.models}}

    monkeypatch.setattr(mm, "model_status", fake_status)
    monkeypatch.setattr(app_module, "decide", fake_decide)
    yield
    _cleanup_trial_models()


TRIAL_SNAPSHOT = {
    "page": "single",
    "context": {"text": "Текст контекста для пробного прогона", "imagesCount": 0},
    "questions": [{"n": 1, "question": "Есть опыт?", "type": "yes_no"}],
    "selectedModels": ["trial-a", "trial-b"],
}


def test_run_trial_in_action_tools():
    assert "run_trial" in TOOL_NAMES
    assert "run_trial" in ACTION_TOOLS
    assert ACTION_TOOLS.isdisjoint(PROPOSAL_TOOLS)


def test_run_trial_validate_limits():
    qs = [{"id": f"q{i}", "question": "?", "type": "yes_no"} for i in range(6)]
    _, err = validate_args("run_trial", {"questions": qs})
    assert "не больше 5 вопросов" in err
    _, err = validate_args("run_trial", {"models": ["a", "b", "c", "d"]})
    assert "не больше 3 моделей" in err
    _, err = validate_args("run_trial", {"questions": [
        {"id": "q1", "question": "?", "type": "choice"}]})
    assert "опций" in err
    args, err = validate_args("run_trial", {})
    assert err is None and args == {}
    _, err = validate_args("run_trial", {"questionIds": [f"q{i}"
                                                         for i in range(6)]})
    assert "не больше 5 вопросов" in err
    args, err = validate_args("run_trial", {"questionIds": ["q1", "q2"]})
    assert err is None


async def test_trial_question_ids(trial_env):
    """questionIds — выбор подмножества существующих вопросов по id из
    снапшота (контракт A3), без сериализации полных объектов (инцидент: при
    9 вопросах каждый trial начинался с ошибки «больше 5» и ретрая с 5
    объектами)."""
    snap = dict(TRIAL_SNAPSHOT, questions=[
        {"n": 1, "id": "q1", "question": "Первый?", "type": "yes_no"},
        {"n": 2, "id": "q2", "question": "Второй?", "type": "yes_no"},
        {"n": 3, "id": "q3", "question": "Третий?", "type": "yes_no"},
    ])
    result, events = await trial_mod.run_trial(dict(snap),
                                               {"questionIds": ["q3", "q1", "q1"]})
    assert result["ok"] is True
    got = [q["question"] for q in events[0]["trial"]["questions"]]
    assert got == ["Третий?", "Первый?"], "порядок как в ids, дубль слит"
    # неизвестный id — самопочинимая ошибка с verbatim-подсказкой
    result, _ = await trial_mod.run_trial(dict(snap), {"questionIds": ["qx"]})
    assert result["ok"] is False
    assert "«qx»" in result["error"] and "актуальные id: q1, q2, q3" \
        in result["error"]
    # questions и questionIds вместе — ошибка
    result, _ = await trial_mod.run_trial(dict(snap), {
        "questionIds": ["q1"],
        "questions": [{"id": "q1", "question": "?", "type": "yes_no"}]})
    assert result["ok"] is False and "не вместе" in result["error"]


async def test_trial_score_scale_in_summary(trial_env, monkeypatch):
    """Score-ответ в сводке — с диапазоном и именем уровня: без этого контракта
    модели называли 1.0 из 2 «максимумом шкалы» (находка матрицы моделей)."""
    async def fake_decide(req):
        answers = {q.id: {"type": "score", "score": 1.0}
                   for q in req.questions}
        return {"results": {key: {"ok": True, "answers": answers}
                            for key in req.models}}
    monkeypatch.setattr(app_module, "decide", fake_decide)
    snap = dict(TRIAL_SNAPSHOT, questions=[
        {"n": 1, "question": "Эмпатия?", "type": "score",
         "levels": ["нет эмпатии", "формальная", "выраженная"]}])
    result, _ = await trial_mod.run_trial(snap, {})
    assert result["ok"] is True
    assert "Эмпатия? → 1.00 из 2 («формальная»)" in result["summary"]


def test_short_answer_score_without_levels():
    # без levels — прежний формат
    assert trial_mod._short_answer({"type": "score", "score": 0.8}) == "0.80"


async def test_trial_defaults_from_snapshot(trial_env):
    result, events = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT), {})
    assert result["ok"] is True
    assert "trial-a" in result["summary"] and "trial-b" in result["summary"]
    assert "да 80%" in result["summary"]
    # сводка ссылается на текст вопроса, а не на технический id
    assert "Есть опыт? → да 80%" in result["summary"]
    assert len(events) == 1 and events[0]["type"] == "trial"
    t = events[0]["trial"]
    assert t["models"] == ["trial-a", "trial-b"]
    # вопрос из снапшота без id получил сгенерированный q1
    assert t["questions"][0]["id"] == "q1"
    assert t["rows"][0]["answers"] == {"q1": "да 80%"}
    assert "note" not in t


async def test_trial_explicit_args(trial_env):
    result, events = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT), {
        "questions": [{"id": "t1", "question": "Есть цифры?", "type": "yes_no",
                       "description_yes": "цифры есть"}],
        "models": ["trial-b"],
    })
    assert result["ok"] is True
    t = events[0]["trial"]
    assert t["models"] == ["trial-b"]
    assert t["questions"][0]["question"] == "Есть цифры?"
    assert "trial-a" not in result["summary"]


async def test_trial_batch_page_error(trial_env):
    snap = dict(TRIAL_SNAPSHOT, page="batch")
    result, events = await trial_mod.run_trial(snap, {})
    assert result["ok"] is False
    assert "batchFile" in result["error"]  # батч без указания файла — подсказка
    assert events == []


async def test_trial_no_running_models(trial_env, monkeypatch):
    async def stopped(entry):
        return {"key": entry.key, "status": "stopped"}
    monkeypatch.setattr(mm, "model_status", stopped)
    result, events = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT), {})
    assert result["ok"] is False
    assert "Нет запущенных" in result["error"]
    result, _ = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT),
                                          {"models": ["trial-a"]})
    assert "не запущены" in result["error"]


async def test_trial_unknown_model(trial_env):
    result, _ = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT),
                                          {"models": ["no-such"]})
    assert result["ok"] is False
    assert "Неизвестные модели" in result["error"]


async def test_trial_too_many_questions_from_snapshot(trial_env):
    snap = dict(TRIAL_SNAPSHOT, questions=[
        {"id": f"q{i}", "question": "?", "type": "yes_no"} for i in range(6)])
    result, events = await trial_mod.run_trial(snap, {})
    assert result["ok"] is False
    assert "больше 5" in result["error"]
    assert events == []


async def test_trial_images_note(trial_env):
    snap = dict(TRIAL_SNAPSHOT,
                context={"text": "текст", "imagesCount": 2})
    result, events = await trial_mod.run_trial(snap, {})
    assert result["ok"] is True
    assert "Изображения" in result["note"]


async def test_trial_context_text_and_batch_file(trial_env, monkeypatch):
    """contextText подменяет текст состояния; batchFile — текст файла батча."""
    seen = {}

    async def fake_decide(req):
        seen["input"] = req.input
        answers = {q.id: {"type": q.type, "probabilities": {"yes": 0.8, "no": 0.2}}
                   for q in req.questions}
        return {"results": {key: {"ok": True, "answers": answers}
                            for key in req.models}}

    monkeypatch.setattr(app_module, "decide", fake_decide)
    result, _ = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT),
                                          {"contextText": "свой текст"})
    assert result["ok"] is True
    assert seen["input"] == "свой текст"
    # страница «Батч»: прогон по тексту файла из снапшота
    snap = dict(TRIAL_SNAPSHOT, page="batch",
                batchFiles=[{"name": "doc.txt", "text": "текст файла"}])
    result, events = await trial_mod.run_trial(snap, {"batchFile": "doc.txt"})
    assert result["ok"] is True
    assert seen["input"] == "текст файла"
    # имя файла прокидывается в trial-событие — фронту для дельты на
    # размеченных ячейках этого файла (v1.1, макет 7)
    assert events[0]["trial"]["batchFile"] == "doc.txt"
    # неизвестный файл — ошибка со списком доступных
    result, events = await trial_mod.run_trial(snap, {"batchFile": "no.txt"})
    assert result["ok"] is False
    assert "не найден" in result["error"] and "doc.txt" in result["error"]
    assert events == []


async def test_trial_decision_passthrough(trial_env):
    """decision прокидывается в trial-событие (исходы считает фронт), в rows —
    fullAnswers для фронтового движка."""
    decision = {"outcomes": [
        {"label": "Да", "color": "green", "rules": [
            {"conditions": [{"question": "q1", "answer": "yes", "op": "gte",
                             "threshold": 50}]}]},
        {"label": "Нет", "isDefault": True, "rules": []}]}
    result, events = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT),
                                               {"decision": decision})
    assert result["ok"] is True
    t = events[0]["trial"]
    assert t["decision"] == decision
    assert "интерфейс" in t["note"]
    fa = t["rows"][0]["fullAnswers"]["q1"]
    assert fa["probabilities"]["yes"] == 0.8
    assert "Исход" not in result["summary"]


async def test_trial_title_changes_passthrough(trial_env):
    """title прокидывается как есть; changes выводится кодом из параметров
    (поле убрано из схемы — модель больше не пишет намерение прозой)."""
    result, events = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT), {
        "title": "Гипотеза: порог 70% отсекает валидные кейсы"})
    assert result["ok"] is True
    t = events[0]["trial"]
    assert t["title"].startswith("Гипотеза")
    assert "changes" not in t  # параметров-изменений не было
    # деривация по параметрам
    _, ev = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT),
                                      {"questionIds": ["q1"]})
    assert ev[0]["trial"]["changes"] == "вопросы №1"
    _, ev = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT), {
        "models": ["trial-b"], "contextText": "свой текст"})
    assert "другие модели: trial-b" in ev[0]["trial"]["changes"]
    assert "свой текст материала" in ev[0]["trial"]["changes"]
    _, ev = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT), {
        "questions": [{"id": "t1", "question": "Свой?", "type": "yes_no"}]})
    assert "свои формулировки (1 шт.)" in ev[0]["trial"]["changes"]
    # те же модели, что в баре — не изменение
    _, ev = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT),
                                      {"models": ["trial-a", "trial-b"]})
    assert "changes" not in ev[0]["trial"]


async def test_trial_use_images(trial_env, monkeypatch):
    """useImages: без флага картинки не прокидываются (note); с флагом —
    ошибка для не-vision моделей прогона, для vision — dataUrl доезжают."""
    snap = dict(TRIAL_SNAPSHOT,
                context={"text": "текст", "imagesCount": 1,
                         "images": ["data:image/png;base64,QUJD"]})
    seen = {}

    async def fake_decide(req):
        seen["images"] = req.images
        answers = {q.id: {"type": q.type, "probabilities": {"yes": 0.8, "no": 0.2}}
                   for q in req.questions}
        return {"results": {key: {"ok": True, "answers": answers}
                            for key in req.models}}

    monkeypatch.setattr(app_module, "decide", fake_decide)
    # без useImages — картинки не участвуют, note об этом
    result, events = await trial_mod.run_trial(snap, {})
    assert result["ok"] is True
    assert seen["images"] is None
    assert "не участвовали" in events[0]["trial"]["note"]
    # useImages с не-vision моделями прогона — явная ошибка
    result, events = await trial_mod.run_trial(snap, {"useImages": True})
    assert result["ok"] is False
    assert "без поддержки изображений" in result["error"]
    assert events == []
    # все модели прогона vision — картинки доезжают (фикстура удалит записи)
    mm.REGISTRY["trial-a"].vision = True
    mm.REGISTRY["trial-b"].vision = True
    result, events = await trial_mod.run_trial(snap, {"useImages": True})
    assert result["ok"] is True
    assert seen["images"] == ["data:image/png;base64,QUJD"]


async def test_trial_model_error_row(trial_env, monkeypatch):
    async def fake_decide(req):
        return {"results": {
            "trial-a": {"ok": True, "answers": {"q1": {"type": "yes_no",
                        "probabilities": {"yes": 0.9, "no": 0.1}}}},
            "trial-b": {"ok": False, "error": "сервер недоступен"}}}
    monkeypatch.setattr(app_module, "decide", fake_decide)
    result, events = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT), {})
    assert result["ok"] is True
    rows = {r["model"]: r for r in events[0]["trial"]["rows"]}
    assert rows["trial-a"]["answers"]["q1"] == "да 90%"
    assert rows["trial-b"]["error"] == "сервер недоступен"
    assert "ОШИБКА" in result["summary"]


async def test_trial_decide_422(trial_env, monkeypatch):
    async def fake_decide(req):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=422, content={"detail": "bad req"})
    monkeypatch.setattr(app_module, "decide", fake_decide)
    result, events = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT), {})
    assert result["ok"] is False and result["error"] == "bad req"
    assert events == []


async def test_run_agent_trial_step(fake_chat, trial_env):
    """Агент: run_trial исполняется на сервере, SSE — tool start/done + trial."""
    fake_chat.responses = [
        sse_lines(hermes_call("run_trial", {"models": '["trial-a"]'})),
        sse_lines("Готово."),
    ]

    async def run_trial_tool(args):
        return await trial_mod.run_trial(dict(TRIAL_SNAPSHOT), args)

    events = await collect_events(run_agent(
        [], "проверь гипотезу", {"mode": "single"}, CHAT_URL,
        thinking=False, read_tools=make_read_tools([]),
        action_tools={"run_trial": run_trial_tool}))

    types = event_types(events)
    assert types == ["tool", "trial", "tool", "token", "done"]
    assert events[0] == {"type": "tool", "name": "run_trial", "status": "start",
                         "args": '{"models": ["trial-a"]}'}
    t = events[1]["trial"]
    assert t["models"] == ["trial-a"]
    assert t["rows"][0]["answers"] == {"q1": "да 80%"}
    assert events[2]["status"] == "done"
    # модель получила сводку tool-сообщением
    tool_msg = fake_chat.requests[1]["json"]["messages"][-1]
    assert tool_msg["role"] == "tool"
    assert "да 80%" in tool_msg["content"]


async def test_run_agent_trial_error_step(fake_chat, trial_env):
    fake_chat.responses = [
        sse_lines(hermes_call("run_trial", {"models": '["no-such"]'})),
        sse_lines("Не вышло."),
    ]

    async def run_trial_tool(args):
        return await trial_mod.run_trial(dict(TRIAL_SNAPSHOT), args)

    events = await collect_events(run_agent(
        [], "прогони", {"mode": "single"}, CHAT_URL,
        thinking=False, read_tools=make_read_tools([]),
        action_tools={"run_trial": run_trial_tool}))
    types = event_types(events)
    assert types == ["tool", "tool", "token", "done"]
    assert events[1]["status"] == "error"
    assert "Неизвестные модели" in events[1]["message"]
    # предпроверка (прогон не запускался) — internal, фронт скрывает
    assert events[1]["internal"] is True


ANALYSIS_SNAPSHOT = {
    "page": "single",
    "questions": [{"n": 1, "id": "q1", "question": "Есть жалоба?",
                   "type": "yes_no"}],
    "singleResults": {"27B": [{"n": 1, "answer": "да · 52%"}],
                      "35B": [{"n": 1, "answer": "нет · 61%"}]},
}


async def test_run_agent_analyze_run_emits_analysis(fake_chat):
    """Агент: analyze_run исполняется на сервере из снапшота (без LLM),
    SSE — tool start/done + событие analysis с payload карточки; тот же
    payload уходит модели для именования причин."""
    fake_chat.responses = [
        sse_lines(hermes_call("analyze_run", {})),
        sse_lines("Главная проблема — расхождение моделей."),
    ]

    async def analyze_tool(args):
        payload = analysis_mod.compute_run_analysis(ANALYSIS_SNAPSHOT)
        return {"ok": True, "analysis": payload}, [
            {"type": "analysis", "analysis": payload}]

    events = await collect_events(run_agent(
        [], "разбери прогон", dict(ANALYSIS_SNAPSHOT), CHAT_URL,
        thinking=False, read_tools=make_read_tools([]),
        action_tools={"analyze_run": analyze_tool}))

    types = event_types(events)
    assert types == ["tool", "analysis", "tool", "token", "done"]
    payload = events[1]["analysis"]
    assert payload["page"] == "single" and payload["stats"]["cells"] == 2
    assert payload["no_marks"] is True
    kinds = {c["kind"] for c in payload["categories"]}
    assert "disagreement" in kinds and "lowconf" in kinds
    tool_msg = fake_chat.requests[1]["json"]["messages"][-1]
    assert tool_msg["role"] == "tool" and tool_msg["name"] == "analyze_run"
    result = json.loads(tool_msg["content"])
    assert result["ok"] is True and result["analysis"]["stats"]["cells"] == 2


async def test_run_agent_review_queue_emits_queue(fake_chat):
    """Агент: review_queue (с limit) → SSE review_queue; done/empty — честные
    состояния для модели."""
    fake_chat.responses = [
        sse_lines(hermes_call("review_queue", {"limit": "1"})),
        sse_lines("Начните с этой ячейки."),
    ]

    async def queue_tool(args):
        payload = analysis_mod.compute_review_queue(
            dict(ANALYSIS_SNAPSHOT), limit=(args or {}).get("limit") or 5)
        return {"ok": True, "queue": payload}, [
            {"type": "review_queue", "queue": payload}]

    events = await collect_events(run_agent(
        [], "что разметить?", dict(ANALYSIS_SNAPSHOT), CHAT_URL,
        thinking=False, read_tools=make_read_tools([]),
        action_tools={"review_queue": queue_tool}))

    types = event_types(events)
    assert types == ["tool", "review_queue", "tool", "token", "done"]
    queue = events[1]["queue"]
    assert len(queue["candidates"]) == 1, "limit=1 respected"
    assert queue["candidates"][0]["prio"] == 3, "расхождение — первое"
    assert queue["candidates"][0]["target"]["scope"] == "single"


async def test_exec_tool_internal_flag():
    """_exec_tool: предпроверки (без started) помечаются internal и скрываются
    из ленты; сбои выполнения (started) — видимы пользователю."""
    async def precheck_fail(_args):
        return {"ok": False, "error": "модель не запущена"}, []

    async def exec_fail(_args):
        return {"ok": False, "started": True, "error": "таймаут прогона"}, []

    _r, events = await agent._exec_tool("run_trial", {}, {},
                                        {"run_trial": precheck_fail})
    assert events[-1]["status"] == "error" and events[-1]["internal"] is True
    _r, events = await agent._exec_tool("run_trial", {}, {},
                                        {"run_trial": exec_fail})
    assert events[-1]["status"] == "error" and "internal" not in events[-1]


# ---------------------------------------------------------------- remote tool calling

from types import SimpleNamespace

from backend.assistant.agent import run_remote_agent


def _remote_entry():
    return SimpleNamespace(key="remote-test", label="Remote", api="openrouter",
                           api_model="qwen/qwen3.8-27b", base_url=None)


def sse_chunks(*chunks: dict) -> list[str]:
    """OpenAI SSE-строки из готовых chunk-объектов (дельты content/tool_calls)."""
    lines = ["data: " + json.dumps(c, ensure_ascii=False) for c in chunks]
    lines.append("data: [DONE]")
    return lines


def _content_delta(text: str) -> dict:
    return {"choices": [{"delta": {"content": text}}]}


def _tc_delta(name: str, arguments: str, idx: int = 0,
              call_id: str | None = "call_1") -> dict:
    tc = {"index": idx, "function": {"name": name, "arguments": arguments}}
    if call_id:
        tc["id"] = call_id
    return {"choices": [{"delta": {"tool_calls": [tc]}}]}


async def test_remote_agent_plain_text(fake_chat, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    fake_chat.responses = [sse_chunks(_content_delta("Ответ "), _content_delta("облака."))]
    events = await collect_events(run_remote_agent([], "привет", None,
                                                   _remote_entry()))
    assert event_types(events) == ["token", "token", "done"]
    tokens = "".join(e["text"] for e in events if e["type"] == "token")
    assert tokens == "Ответ облака."
    req = fake_chat.requests[0]
    assert req["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert req["json"]["model"] == "qwen/qwen3.8-27b"
    assert req["json"]["stream"] is True
    names = [t["function"]["name"] for t in req["json"]["tools"]]
    assert "get_state" in names and "run_trial" in names


async def test_remote_agent_read_tool_loop(fake_chat, monkeypatch):
    """Нативный tool calling: get_state в дельтах → tool-сообщение → финал."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    fake_chat.responses = [
        sse_chunks(_tc_delta("get_state", ""), _tc_delta("", "{}")),
        sse_chunks(_content_delta("Вот состояние.")),
    ]
    events = await collect_events(run_remote_agent(
        [], "что в приложении?", {"mode": "single"}, _remote_entry(),
        read_tools=make_read_tools([])))
    assert event_types(events) == ["tool", "tool", "token", "done"]
    assert events[0] == {"type": "tool", "name": "get_state", "status": "start",
                         "args": "{}"}
    req2 = fake_chat.requests[1]["json"]
    asst = req2["messages"][-2]
    assert asst["role"] == "assistant"
    assert asst["tool_calls"][0]["id"] == "call_1"
    assert asst["tool_calls"][0]["function"]["name"] == "get_state"
    tool_msg = req2["messages"][-1]
    assert tool_msg["role"] == "tool"
    assert tool_msg["tool_call_id"] == "call_1"
    assert json.loads(tool_msg["content"])["ok"] is True


async def test_remote_agent_proposal_event(fake_chat, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    args = json.dumps({"questions": [{"id": "q1", "question": "Ок?",
                                      "type": "yes_no"}],
                       "mode": "replace"}, ensure_ascii=False)
    fake_chat.responses = [
        sse_chunks(_tc_delta("propose_questions", args[:20]),
                   _tc_delta("", args[20:])),
        sse_chunks(_content_delta("Предложил вопросы.")),
    ]
    events = await collect_events(run_remote_agent([], "предложи вопросы", None,
                                                   _remote_entry()))
    assert event_types(events) == ["proposal", "token", "done"]
    prop = events[0]["proposal"]
    assert prop["kind"] == "propose_questions"
    assert prop["payload"]["questions"][0]["question"] == "Ок?"


async def test_remote_agent_phantom_guard_recovers(fake_chat, monkeypatch):
    """Страж фантомов в облачном цикле: модель заявила карточку текстом без
    вызова — ход не завершается, после подсказки инструмент вызывается."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    good = json.dumps({"text": "новый", "mode": "replace"})
    fake_chat.responses = [
        sse_chunks(_content_delta("Предложил вам новый контекст.")),
        sse_chunks(_tc_delta("propose_context", good)),
        sse_chunks(_content_delta("Готово.")),
    ]
    events = await collect_events(run_remote_agent(
        [], "поменяй контекст", None, _remote_entry()))
    names = [e.get("name") for e in events if e["type"] == "tool"]
    assert names == ["phantom_guard"], event_types(events)
    assert "proposal" in event_types(events)
    assert len(fake_chat.requests) == 3


async def test_remote_agent_run_trial_action(fake_chat, monkeypatch, trial_env):
    """run_trial через нативный tool calling: исполнение + trial-событие."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    fake_chat.responses = [
        sse_chunks(_tc_delta("run_trial", json.dumps({"models": ["trial-a"]}))),
        sse_chunks(_content_delta("Прогнал: да 80%.")),
    ]

    async def run_trial_tool(args):
        return await trial_mod.run_trial(dict(TRIAL_SNAPSHOT), args)

    events = await collect_events(run_remote_agent(
        [], "проверь", {"mode": "single"}, _remote_entry(),
        action_tools={"run_trial": run_trial_tool}))
    types = event_types(events)
    assert types == ["tool", "trial", "tool", "token", "done"]
    assert events[1]["trial"]["models"] == ["trial-a"]
    assert events[2]["status"] == "done"


async def test_remote_agent_review_queue_action(fake_chat, monkeypatch):
    """review_queue через нативный tool calling: исполнение из снапшота +
    SSE-событие review_queue (оба агентных цикла пропускают событие)."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    fake_chat.responses = [
        sse_chunks(_tc_delta("review_queue", '{"limit": 2}')),
        sse_chunks(_content_delta("Вот кандидаты.")),
    ]

    async def queue_tool(args):
        payload = analysis_mod.compute_review_queue(
            dict(ANALYSIS_SNAPSHOT), limit=(args or {}).get("limit") or 5)
        return {"ok": True, "queue": payload}, [
            {"type": "review_queue", "queue": payload}]

    events = await collect_events(run_remote_agent(
        [], "что разметить?", dict(ANALYSIS_SNAPSHOT), _remote_entry(),
        action_tools={"review_queue": queue_tool}))
    types = event_types(events)
    assert types == ["tool", "review_queue", "tool", "token", "done"]
    queue = events[1]["queue"]
    assert len(queue["candidates"]) == 2
    tool_msg = fake_chat.requests[1]["json"]["messages"][-1]
    assert tool_msg["role"] == "tool" and tool_msg["tool_call_id"] == "call_1"
    assert json.loads(tool_msg["content"])["queue"]["total"] >= 2


async def test_remote_agent_max_steps_fallback_summary(fake_chat, monkeypatch):
    """Запасной шаг на облачной модели (нативный tool calling): 6 шагов
    инструментов → финальный вызов без tools, итог текстом."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    fake_chat.responses = [
        sse_chunks(_tc_delta("get_state", ""), _tc_delta("", "{}"))
    ] * 6 + [sse_chunks(_content_delta("Итог облака."))]
    events = await collect_events(run_remote_agent(
        [], "разбери всё подряд", {"mode": "single"}, _remote_entry(),
        read_tools=make_read_tools([])))
    types = event_types(events)
    assert types[-2:] == ["token", "done"]
    assert "error" not in types
    assert len(fake_chat.requests) == 7
    assert "tools" not in fake_chat.requests[-1]["json"]


async def test_remote_agent_repeat_error_breaker(fake_chat, monkeypatch):
    """Тот же анти-повтор в облачном цикле (нативный tool calling):
    подсказка на 2-й ошибке, принудительный финал — на 3-й."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    bad = json.dumps({"outcomes": [{"label": "a", "rules": [
        {"conditions": [{"question": 1, "op": "gte"}]}]}]})
    fake_chat.responses = [
        sse_chunks(_tc_delta("propose_decision", bad)),
        sse_chunks(_tc_delta("propose_decision", bad)),
        sse_chunks(_tc_delta("propose_decision", bad)),
        sse_chunks(_content_delta("Не вышло, предлагаю текстом.")),
        sse_chunks(_tc_delta("propose_decision", bad)),  # запас — недостижимо
    ]
    events = await collect_events(run_remote_agent(
        [], "предложи правила", {"mode": "single"}, _remote_entry(),
        read_tools=make_read_tools([])))
    types = event_types(events)
    assert types[-2:] == ["token", "done"] and "error" not in types
    assert len(fake_chat.requests) == 4, "3 упавших вызова + финальный шаг"
    notes = [e for e in events if e["type"] == "tool" and e["name"] == "steps"]
    assert notes and "Одна и та же ошибка повторяется" in notes[0]["message"]
    assert "tools" not in fake_chat.requests[-1]["json"]


async def test_remote_agent_garbage_args_retry(fake_chat, monkeypatch):
    """Мусорные аргументы → tool error, модель получает ошибку и ретраит."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    bad = json.dumps({"mode": "bogus", "questions": []})
    good = json.dumps({"text": "новый", "mode": "replace"})
    fake_chat.responses = [
        sse_chunks(_tc_delta("propose_context", bad)),
        sse_chunks(_tc_delta("propose_context", good)),
        sse_chunks(_content_delta("Готово.")),
    ]
    events = await collect_events(run_remote_agent([], "поменяй контекст", None,
                                                   _remote_entry()))
    types = event_types(events)
    assert types == ["tool", "proposal", "token", "done"]
    assert events[0]["status"] == "error"
    tool_msgs = [m for m in fake_chat.requests[1]["json"]["messages"]
                 if m["role"] == "tool"]
    assert tool_msgs and "mode" in tool_msgs[0]["content"]


async def test_remote_agent_hermes_fallback(fake_chat, monkeypatch):
    """Провайдер не разобрал tools: hermes-разметка в content → вызов."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    fake_chat.responses = [
        sse_lines("<tool_call><function=get_state></function></tool_call>"),
        sse_chunks(_content_delta("Состояние получено.")),
    ]
    events = await collect_events(run_remote_agent(
        [], "статус?", {"mode": "single"}, _remote_entry(),
        read_tools=make_read_tools([])))
    assert event_types(events) == ["tool", "tool", "token", "done"]
    tool_msg = fake_chat.requests[1]["json"]["messages"][-1]
    assert tool_msg["role"] == "tool"
    assert "tool_call_id" not in tool_msg  # hermes-фолбэк — без id


async def test_remote_agent_http_error(fake_chat, monkeypatch):
    """Ошибки провайдера — человекочитаемые, без сырого JSON тела наружу
    (инцидент: 429 OpenRouter с is_byok/remedy_hint показан пользователю)."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    fake_chat.responses = [[], [], [], []]  # по запросу на каждую фазу
    # 429 → фиксированное сообщение про лимит, код не нужен
    FakeChatClient.status_code = 429
    FakeChatClient.body = b'{"error": {"message": "Provider returned error", "is_byok": false}}'
    events = await collect_events(run_remote_agent([], "привет", None,
                                                   _remote_entry()))
    assert event_types(events) == ["error"]
    assert "перегружена" in events[0]["message"]
    assert "is_byok" not in events[0]["message"] and "{" not in events[0]["message"]
    # 5xx → «недоступен», 400 с JSON-телом → без тела, с кодом
    FakeChatClient.status_code = 500
    events = await collect_events(run_remote_agent([], "привет", None,
                                                   _remote_entry()))
    assert "недоступен" in events[0]["message"] and "500" in events[0]["message"]
    FakeChatClient.status_code = 400
    FakeChatClient.body = b'{"error": "bad"}'
    events = await collect_events(run_remote_agent([], "привет", None,
                                                   _remote_entry()))
    assert "400" in events[0]["message"] and "{" not in events[0]["message"]
    # короткое не-JSON тело — показываем
    FakeChatClient.status_code = 403
    FakeChatClient.body = b"Forbidden"
    events = await collect_events(run_remote_agent([], "привет", None,
                                                   _remote_entry()))
    assert "403" in events[0]["message"] and "Forbidden" in events[0]["message"]


# ---------------------------------------------------------------- hardening:
# утечки разметки, лимит thinking, таймауты, отмена

def test_stream_filter_explicit_think_block():
    filt = _StreamFilter(thinking=True)
    events = filt.feed("<think>думал") + filt.feed("</think>ответ") + filt.finish()
    tokens = "".join(t for k, t in events if k == "token")
    thinks = "".join(t for k, t in events if k == "thinking")
    assert tokens == "ответ" and thinks == "думал"


def test_stream_filter_explicit_think_without_flag():
    """thinking не запрошен, но модель выдала явный блок — теги не утекают."""
    filt = _StreamFilter(thinking=False)
    events = filt.feed("<think>шум</think>Ответ.") + filt.finish()
    tokens = "".join(t for k, t in events if k == "token")
    assert tokens == "Ответ." and "<think>" not in tokens


def test_stream_filter_bare_function_swallowed():
    filt = _StreamFilter(False)
    events = (filt.feed("Смотрю. ") + filt.feed("<function=get_state>\n</function>")
              + filt.finish())
    tokens = "".join(t for k, t in events if k == "token")
    assert tokens == "Смотрю. "


def test_stream_filter_special_tokens_swallowed():
    """Спецтокены Qwen/DeepSeek не утекают ни в потоке, ни в хвосте."""
    for start, end in (("<|tool_call|>", "<|tool_call_end|>"),
                       ("<｜tool▁call｜>", "<｜tool▁call▁end｜>")):
        filt = _StreamFilter(False)
        events = filt.feed(start + '{"name": "get_state"}' + end + " видно")
        events += filt.finish()
        tokens = "".join(t for k, t in events if k == "token")
        assert "get_state" not in tokens and "tool" not in tokens
        assert "видно" in tokens


def test_stream_filter_finish_flushes_text_drops_markup_tail():
    filt = _StreamFilter(False)
    assert filt.feed("текст до<tool") == [("token", "текст до")]
    assert filt.finish() == []  # обрывок "<tool" выброшен, а не показан


def test_stream_filter_finish_unfinished_thinking():
    filt = _StreamFilter(True)
    assert filt.feed("оборвалось") == []
    assert filt.finish() == [("thinking", "оборвалось")]


def test_parse_bare_function_call():
    content = ("<function=propose_context>\n<parameter=text>новый</parameter>\n"
               "<parameter=mode>replace</parameter>\n</function>")
    assert parse_tool_calls(content) == [
        ("propose_context", {"text": "новый", "mode": "replace"}, "")]


def test_strip_markup_variants():
    assert strip_tool_markup("<function=get_state></function>") == ""
    assert strip_tool_markup('<|tool_call|>{"name":"x"}<|tool_call_end|>ответ') == "ответ"
    assert strip_tool_markup("<｜tool▁call｜>{}<｜tool▁call▁end｜>") == ""
    assert strip_tool_markup("<think>думал</think>ответ") == "ответ"


def test_split_thinking_strips_explicit_open_tag():
    assert split_thinking("<think>думал</think>ответ") == ("думал", "ответ")


async def test_run_agent_explicit_think_not_leaked(fake_chat):
    """Сквозной: явный <think>…</think> в content не попадает в чат."""
    fake_chat.responses = [sse_lines("<think>подумал</think>", "Короткий ответ.")]
    events = await collect_events(run_agent(
        [], "привет", None, CHAT_URL, thinking=True,
        read_tools=make_read_tools([])))
    tokens = "".join(e["text"] for e in events if e["type"] == "token")
    thinks = "".join(e["text"] for e in events if e["type"] == "thinking")
    assert tokens == "Короткий ответ."
    assert thinks == "подумал"


async def test_run_agent_thinking_cap_retries_without_thinking(fake_chat):
    """Рассуждение дольше капа → заметка, ретрай шага с enable_thinking=false."""
    fake_chat.responses = [
        sse_lines("очень длинное рассуждение ", "которое не кончается"),
        sse_lines("Ответ без размышлений."),
    ]
    events = await collect_events(run_agent(
        [], "вопрос", None, CHAT_URL, thinking=True,
        read_tools=make_read_tools([]), thinking_time_cap=0))
    types = event_types(events)
    assert types == ["tool", "token", "done"]
    assert events[0]["name"] == "thinking" and events[0]["status"] == "done"
    assert "обрезано" in events[0]["message"]
    assert fake_chat.requests[1]["json"]["chat_template_kwargs"] == \
        {"enable_thinking": False}
    tokens = "".join(e["text"] for e in events if e["type"] == "token")
    assert tokens == "Ответ без размышлений."


# --- таймауты и отмена: медленный/зависший upstream

class _SlowStreamResponse:
    """aiter_lines зависает после выдачи чанков; aexit помечает закрытие."""

    def __init__(self, lines, tracker):
        self.status_code = 200
        self._lines = lines
        self._tracker = tracker

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self._tracker["closed"] = True
        return False

    async def aiter_lines(self):
        for line in self._lines:
            yield line
        await asyncio.sleep(3600)  # «модель зависла»

    async def aread(self):
        return b""


def _slow_client(monkeypatch, lines, tracker):
    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def stream(self, method, url, json=None, **kwargs):
            tracker["requests"] = tracker.get("requests", 0) + 1
            return _SlowStreamResponse(lines, tracker)

    monkeypatch.setattr(agent.httpx, "AsyncClient", Client)


async def test_run_agent_step_timeout_sse_error(monkeypatch):
    """Шаг дольше step_timeout → честный SSE error, upstream закрыт, без ретраев."""
    tracker = {}
    _slow_client(monkeypatch, [], tracker)
    events = await collect_events(run_agent(
        [], "вопрос", None, CHAT_URL, thinking=False,
        read_tools=make_read_tools([]), step_timeout=0.05))
    assert event_types(events) == ["error"]
    assert "прерван" in events[0]["message"]
    assert tracker["closed"] is True
    assert tracker["requests"] == 1


async def test_run_agent_cancel_closes_upstream(monkeypatch):
    """Отмена клиентом (disconnect) → upstream-стрим закрывается: генерация
    на модельном сервере реально останавливается."""
    tracker = {}
    _slow_client(monkeypatch, sse_lines("Первый токен."), tracker)
    gen = run_agent([], "вопрос", None, CHAT_URL, thinking=False,
                    read_tools=make_read_tools([]))
    first = await gen.__anext__()
    assert "Первый токен." in first
    await gen.aclose()  # клиент отключился посреди стрима
    assert tracker["closed"] is True


# --- remote: управление рассуждением, кап thinking, length-обрыв

async def test_remote_agent_reasoning_payload_openrouter(fake_chat, monkeypatch):
    """OpenRouter: флаг «Рассуждение» → reasoning {"enabled": bool}; с
    рассуждением max_tokens больше (reasoning-токены делят бюджет)."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    fake_chat.responses = [sse_chunks(_content_delta("а"))]
    await collect_events(run_remote_agent([], "q", None, _remote_entry(),
                                          thinking=False))
    off = fake_chat.requests[0]["json"]
    fake_chat.responses = [sse_chunks(_content_delta("б"))]
    fake_chat.requests = []  # FakeChatClient индексирует responses по счётчику
    await collect_events(run_remote_agent([], "q", None, _remote_entry(),
                                          thinking=True))
    on = fake_chat.requests[0]["json"]
    assert off["reasoning"] == {"enabled": False} and off["max_tokens"] == 2048
    assert on["reasoning"] == {"enabled": True} and on["max_tokens"] == 4096


async def test_remote_agent_strict_tools_fallback(monkeypatch):
    """strict-схемы tools: у провайдера с enforced strict (openai) идут со
    "strict": true; 400/422 на них — один фолбэк без флага (по образцу
    reasoning_effort)."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    requests = []

    class Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, json=None, **kwargs):
            requests.append(json)
            # openai: первый 400 съедает фолбэк reasoning_effort (порядок
            # проверок прежний), второй — уже strict-фолбэк
            if len(requests) <= 2:
                return FakeStreamResponse([], status_code=400,
                                          body=b"strict schema not supported")
            return FakeStreamResponse(sse_chunks(_content_delta("ок")))

    monkeypatch.setattr(agent.httpx, "AsyncClient", Client)
    entry = SimpleNamespace(key="remote-oai", label="OAI", api="openai",
                            api_model="gpt-x", base_url=None)
    events = await collect_events(run_remote_agent([], "q", None,
                                                   entry, thinking=False))
    tools0 = requests[0]["tools"]
    assert all(t["function"].get("strict") is True for t in tools0), \
        "у openai схемы идут со strict"
    tools2 = requests[2]["tools"]
    assert all("strict" not in t["function"] for t in tools2), \
        "после 400 — фолбэк без strict"
    assert event_types(events) == ["token", "done"]


async def test_remote_agent_strict_only_openai(fake_chat, monkeypatch):
    """strict — только api=='openai'; openrouter и прочие прокси — plain
    tools (eval 21.10, s1: strict на openrouter провоцирует flash
    стрингифицировать поля аргументов — validation-петли)."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    fake_chat.responses = [sse_chunks(_content_delta("ок"))]
    await collect_events(run_remote_agent([], "q", None, _remote_entry()))
    tools = fake_chat.requests[0]["json"]["tools"]
    assert all("strict" not in t["function"] for t in tools), \
        "openrouter не должен получать strict"


async def test_remote_agent_strict_autodowngrade_on_stringified(monkeypatch):
    """Второй рубеж: модель под strict стрингифицирует поля (HTTP 200, фолбэк
    по 400 молчит) — после второй type-mismatch ошибки валидации запуск
    дожимается на plain tools."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    requests = []
    bad = json.dumps({"edits": json.dumps([{"op": "remove", "target": "q1"}])})
    good = json.dumps({"edits": [{"op": "remove", "target": "q1"}]})
    canned = [sse_chunks(_tc_delta("propose_questions", bad)),
              sse_chunks(_tc_delta("propose_questions", bad)),
              sse_chunks(_tc_delta("propose_questions", good)),
              sse_chunks(_content_delta("Убрал вопрос — карточка выше."))]

    class Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, json=None, **kwargs):
            requests.append(json)
            return FakeStreamResponse(canned[len(requests) - 1])

    monkeypatch.setattr(agent.httpx, "AsyncClient", Client)
    entry = SimpleNamespace(key="remote-oai", label="OAI", api="openai",
                            api_model="gpt-x", base_url=None)
    snapshot = {"questions": [{"n": 1, "id": "q1", "question": "Ок?",
                               "type": "yes_no"},
                              {"n": 2, "id": "q2", "question": "Второй?",
                               "type": "yes_no"}]}
    events = await collect_events(run_remote_agent([], "удали q1", snapshot,
                                                   entry))
    assert len(requests) == 4
    assert all(t["function"].get("strict") is True
               for t in requests[0]["tools"])
    assert all(t["function"].get("strict") is True
               for t in requests[1]["tools"]), "после 1-й ошибки — ещё strict"
    assert all("strict" not in t["function"] for t in requests[2]["tools"]), \
        "после 2-й стрингификации — даунгрейд на plain"
    assert all("strict" not in t["function"] for t in requests[3]["tools"])
    types = event_types(events)
    assert "proposal" in types and types[-1] == "done"


def test_strict_tools_schema_shape():
    """A2.1: strict-вариант схем совместим с OpenAI strict mode —
    additionalProperties:false на каждом объекте, все поля в required,
    изначально необязательные — nullable (enum дополняется null).
    Исходные TOOLS не тронуты (их ест validate_args и local-цикл)."""
    def check(obj, path, errors):
        if obj.get("type") == "object" and "properties" in obj:
            if obj.get("additionalProperties") is not False:
                errors.append(path)
            if set(obj.get("required") or []) != set(obj["properties"]):
                errors.append(path + ":required")
            for k, v in obj["properties"].items():
                check(v, f"{path}.{k}", errors)
        if isinstance(obj.get("items"), dict):
            check(obj["items"], path + "[]", errors)

    errors = []
    for t in agent._TOOLS_STRICT:
        assert t["function"]["strict"] is True
        check(t["function"]["parameters"], t["function"]["name"], errors)
    assert not errors, errors
    # необязательное поле стало nullable, обязательное — нет
    ctx = next(t for t in agent._TOOLS_STRICT
               if t["function"]["name"] == "propose_context")
    props = ctx["function"]["parameters"]["properties"]
    assert props["file"]["type"] == ["string", "null"]
    assert props["text"]["type"] == "string"
    # необязательный enum (direction у вопроса) дополнен null
    pq = next(t for t in agent._TOOLS_STRICT
              if t["function"]["name"] == "propose_questions")
    direction = pq["function"]["parameters"]["properties"]["questions"][
        "items"]["properties"]["direction"]
    assert direction["type"] == ["string", "null"] and None in direction["enum"]
    # title propose_decision — необязателен по схеме (как у propose_run) →
    # в strict попадает в required как nullable, исходная схема не тронута
    pd = next(t for t in agent._TOOLS_STRICT
              if t["function"]["name"] == "propose_decision")
    pd_props = pd["function"]["parameters"]["properties"]
    assert pd_props["title"]["type"] == ["string", "null"]
    assert pd_props["outcomes"]["type"] == "array"
    plain_pd = next(t for t in TOOLS
                    if t["function"]["name"] == "propose_decision")
    assert plain_pd["function"]["parameters"]["required"] == ["outcomes"]
    plain = next(t for t in TOOLS if t["function"]["name"] == "propose_context")
    pp = plain["function"]["parameters"]
    assert "additionalProperties" not in pp and pp["required"] == ["text", "mode"]
    assert strict_schema(pp) is not pp  # трансформ — копия


async def test_strict_tools_schema_on_wire(fake_chat, monkeypatch):
    """A2.1: strict-схемы реально уходят в payload запроса (remote, провайдер
    с enforced strict — openai)."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    fake_chat.responses = [sse_chunks(_content_delta("ок"))]
    entry = SimpleNamespace(key="remote-oai", label="OAI", api="openai",
                            api_model="gpt-x", base_url=None)
    events = await collect_events(run_remote_agent([], "q", None, entry))
    assert event_types(events) == ["token", "done"]
    wire = fake_chat.requests[0]["json"]["tools"]
    assert all(t["function"]["strict"] is True for t in wire)
    assert all(t["function"]["parameters"]["additionalProperties"] is False
               for t in wire)


async def test_remote_agent_reasoning_effort_generic_400_fallback(monkeypatch):
    """Generic API: reasoning_effort low; 400 на параметр → ретрай без него."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    requests = []

    class Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, json=None, **kwargs):
            requests.append(json)
            if len(requests) == 1:
                return FakeStreamResponse([], status_code=400,
                                          body=b"unknown param reasoning_effort")
            return FakeStreamResponse(sse_chunks(_content_delta("готово")))

    monkeypatch.setattr(agent.httpx, "AsyncClient", Client)
    entry = SimpleNamespace(key="remote-oai", label="OAI", api="openai",
                            api_model="gpt-x", base_url=None)
    events = await collect_events(run_remote_agent([], "q", None, entry,
                                                   thinking=False))
    assert "reasoning_effort" not in requests[0] or True  # первый запрос — с параметром
    assert requests[0]["reasoning_effort"] == "low"
    assert "reasoning_effort" not in requests[1]
    assert event_types(events) == ["token", "done"]


async def test_remote_agent_thinking_cap_retries_without(fake_chat, monkeypatch):
    """Рассуждение дольше капа → стрим прерван, заметка, ретрай без reasoning."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    think = {"choices": [{"delta": {"reasoning": "долго думаю… "}}]}
    fake_chat.responses = [
        sse_chunks(think, think),
        sse_chunks(_content_delta("Ответ без размышлений.")),
    ]
    events = await collect_events(run_remote_agent(
        [], "q", None, _remote_entry(), thinking=True, thinking_time_cap=0))
    types = event_types(events)
    assert types[0] == "thinking"  # начало рассуждения дошло
    note = next(e for e in events if e["type"] == "tool")
    assert note["name"] == "thinking" and "обрезано" in note["message"]
    assert fake_chat.requests[1]["json"]["reasoning"] == {"enabled": False}
    tokens = "".join(e["text"] for e in events if e["type"] == "token")
    assert tokens == "Ответ без размышлений."


async def test_remote_agent_length_after_reasoning_is_error(fake_chat, monkeypatch):
    """finish_reason=length с пустым content после рассуждения → понятный
    SSE error вместо молчаливого done."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    fake_chat.responses = [sse_chunks(
        {"choices": [{"delta": {"reasoning": "много думал"}}]},
        {"choices": [{"delta": {}, "finish_reason": "length"}]},
    )]
    events = await collect_events(run_remote_agent([], "q", None,
                                                   _remote_entry(), thinking=True))
    assert event_types(events) == ["thinking", "error"]
    assert "лимит токенов" in events[-1]["message"]


def test_serialize_snapshot_prioritizes_results_over_context():
    """Переполнение снапшота: resultsSummary/questions сохраняются, режется
    context.text, общий потолок держится."""
    snap = {"page": "single",
            "context": {"text": "КОНТЕКСТ " * 2000, "imagesCount": 0},
            "questions": [{"id": "q1", "question": "Ок?", "type": "yes_no"}],
            "selectedModels": ["a"],
            "resultsSummary": "СВОДКА-РЕЗУЛЬТАТОВ"}
    text = serialize_snapshot(snap)
    assert "СВОДКА-РЕЗУЛЬТАТОВ" in text
    assert "Ок?" in text
    assert len(text) <= 8100
    assert "обрезано" in text


def test_serialize_snapshot_trims_review_marks_last():
    """Разметка аналитика — самое ценное: при переполнении сначала режется
    resultsSummary, reviewMarks урезается последним (пункты с хвоста)."""
    marks = {"totals": {"accept": 0, "reject": 40, "unsure": 0, "comments": 40},
             "items": [f"вопрос №{i} «Спам?» × 27B: ✗ «ошибка {i}»"
                       for i in range(40)]}
    snap = {"page": "single",
            "context": {"text": "", "imagesCount": 0},
            "questions": [{"n": 1, "question": "Ок?", "type": "yes_no"}],
            "reviewMarks": marks,
            "resultsSummary": "СВОДКА " * 1500}  # ~10k — вся обрезка пойдёт по ней
    text = serialize_snapshot(snap)
    assert len(text) <= 8100
    assert "ошибка 0" in text, "разметка пережила обрезку сводки"
    # сводка урезана раньше разметки
    assert "СВОДКА" in text and "обрезано" in text
    # экстремальное переполнение: сводка на потолке, разметка огромная —
    # пункты отбрасываются с хвоста, потолок держится
    snap2 = {"page": "single",
             "context": {"text": "К " * 2900, "imagesCount": 0},
             "questions": [{"n": 1, "question": "Ок?", "type": "yes_no"}],
             "reviewMarks": marks,
             "resultsSummary": "СВОДКА " * 900}
    text2 = serialize_snapshot(snap2)
    assert len(text2) <= 8100
    assert "обрезано" in text2 or "ошибка 39" not in text2


def test_serialize_snapshot_trims_batch_file_texts_first():
    """Переполнение: сначала режутся тексты batch-файлов (не ниже floor);
    questions/decision/resultsSummary не тронуты."""
    snap = {"page": "batch",
            "context": {"text": "", "imagesCount": 0},
            "questions": [{"n": i + 1, "question": f"Вопрос {i}?", "type": "yes_no"}
                          for i in range(3)],
            "decision": {"outcomes": [{"label": "Исход-цел", "rules": []}]},
            "batchFiles": [{"name": f"f{i}.txt", "text": "ТЕКСТ " * 500}
                           for i in range(4)],
            "resultsSummary": "СВОДКА-ЦЕЛАЯ"}
    text = serialize_snapshot(snap)
    assert len(text) <= 8100
    assert "обрезано" in text
    assert "Вопрос 2?" in text, "вопросы не режутся"
    assert "Исход-цел" in text, "decision не режется"
    assert "СВОДКА-ЦЕЛАЯ" in text, "сводка уместилась после обрезки текстов файлов"


def test_serialize_snapshot_strips_image_payloads():
    """dataUrl картинок не попадает в JSON-промпт (их везут image_url-части),
    счётчики остаются."""
    snap = {"page": "single",
            "context": {"text": "текст", "imagesCount": 1,
                        "images": ["data:image/png;base64,QUJD"]},
            "batchFiles": [{"name": "a.png", "imagesCount": 1,
                            "images": ["data:image/png;base64,WFla"]}]}
    text = serialize_snapshot(snap)
    assert "data:image" not in text
    assert '"imagesCount": 1' in text


def test_serialize_snapshot_remote_budget():
    """Облачному агенту доступен больший бюджет: тот же снапшот при
    max_chars=12000 не режется, при локальных 8000 — режется."""
    snap = {"page": "single",
            "context": {"text": "ДЛИННЫЙ " * 1200, "imagesCount": 0},  # ~9.6k
            "questions": [{"n": 1, "question": "Ок?", "type": "yes_no"}]}
    text = serialize_snapshot(snap, max_chars=_MAX_SNAPSHOT_CHARS_REMOTE)
    assert _MAX_SNAPSHOT_CHARS_REMOTE == 12000
    assert "обрезано" not in text
    assert "ДЛИННЫЙ" in text
    text_local = serialize_snapshot(snap)
    assert "обрезано" in text_local


def test_snapshot_max_chars_tiers_and_runs_victim():
    """Потолок — от контекста chat-модели: 32k→8000, облако→12000,
    ≥128k→16000, ≥256k→20000 (context_length перекрывает remote-дефолт).
    При обрезке runs (метрики прогонов) уходит раньше reviewMarks, decision
    с trace не режется."""
    assert snapshot_max_chars(False, None) == 8000
    assert snapshot_max_chars(False, 32768) == 8000
    assert snapshot_max_chars(True, None) == 12000
    assert snapshot_max_chars(False, 131072) == 16000
    assert snapshot_max_chars(True, 131072) == 16000
    assert snapshot_max_chars(True, 262144) == 20000
    # runs уходит целиком до разметки; trace внутри decision не трогаем.
    # Чтобы обрезка дошла до runs, не-режущиеся поля (questions/decision) +
    # разметка должны превышать потолок даже при текстах на floor.
    marks = {"totals": {"reject": 49},
             "items": ["вопрос №1: ✗ «ошибка»"]
             + [f"вопрос №{i}: ✗ «" + "п" * 150 + "»" for i in range(2, 50)]}
    snap = {"page": "single",
            "context": {"text": "К " * 2000, "imagesCount": 0},
            "questions": [{"n": i, "question": f"Вопрос {i}?", "type": "yes_no"}
                          for i in range(1, 6)],
            "decision": {"outcomes": [], "trace": ["условие №1: не прошло"]},
            "runs": ["Qwen: 12с, 900 токенов"],
            "reviewMarks": marks,
            "resultsSummary": "СВОДКА " * 1500}
    text = serialize_snapshot(snap)
    assert len(text) <= 8100
    assert "Qwen: 12с" not in text, "runs выброшен раньше разметки"
    assert "ошибка" in text, "разметка пережила"
    assert "условие №1: не прошло" in text, "trace в decision не режется"


async def test_run_trial_limited_caps_series(monkeypatch):
    """Антиспам: не более TRIALS_PER_REPLY пробных прогонов на один ответ —
    дальше честная ошибка модели (вывод текстом), лента не захламляется."""
    from backend.assistant import trial as trial_mod
    calls = []

    async def fake(snapshot, args):
        calls.append(args)
        return {"ok": True}, [{"type": "trial", "trial": {}}]

    monkeypatch.setattr(trial_mod, "run_trial", fake)
    run = trial_mod.run_trial_limited({})
    for i in range(trial_mod.TRIALS_PER_REPLY):
        res, _ = await run({"n": i})
        assert res["ok"]
    res, events = await run({"n": 99})
    assert not res["ok"] and "Лимит" in res["error"]
    assert events == []
    assert len(calls) == trial_mod.TRIALS_PER_REPLY

    # фаза 2: ошибки предпроверок (модель не запущена и т.п.) лимит не едят —
    # считаются только реально запущенные прогоны (ok или started)
    async def preflight_fail(snapshot, args):
        return {"ok": False, "error": "Модели не запущены"}, []

    monkeypatch.setattr(trial_mod, "run_trial", preflight_fail)
    run = trial_mod.run_trial_limited({})
    for _ in range(trial_mod.TRIALS_PER_REPLY + 2):
        res, _ = await run({})
        assert "Лимит" not in res.get("error", "")

    async def started_fail(snapshot, args):
        return {"ok": False, "started": True, "error": "таймаут"}, []

    monkeypatch.setattr(trial_mod, "run_trial", started_fail)
    run = trial_mod.run_trial_limited({})
    for _ in range(trial_mod.TRIALS_PER_REPLY):
        res, _ = await run({})
        # started остаётся в результате: _exec_tool по нему отличает сбой
        # выполнения (виден пользователю) от предпроверки (internal, скрыта)
        assert "таймаут" in res["error"] and res["started"] is True
    res, _ = await run({})
    assert "Лимит" in res["error"]
