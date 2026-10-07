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
from backend.assistant.agent import (_StreamFilter, parse_tool_calls, run_agent,
                                     split_thinking, strip_tool_markup)
from backend.assistant.tools import PROPOSAL_TOOLS, TOOL_NAMES, validate_args

client = TestClient(app_module.app)

MODEL_A = "qwen38-27b-4bit"   # sglang, chat-capable
MODEL_B = "qwen35-35b-a3b-4bit"
LAYA = "laya-04b-q8"          # llamacpp, chat-capable
CLEF_FLASH = "clef-flash-9b-4bit"  # не chat-capable
JEV = "jev-latest"            # remote, не chat-capable

CHAT_URL = "http://fake-chat/v1/chat/completions"


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
    async def get_state():
        calls.append("get_state")
        return {"ok": True, "state": {"mode": "single"}}

    async def list_presets():
        calls.append("list_presets")
        return {"ok": True, "presets": []}

    async def list_models():
        calls.append("list_models")
        return {"ok": True, "models": []}

    return {"get_state": get_state, "list_presets": list_presets,
            "list_models": list_models}


# ---------------------------------------------------------------- реестр тулов

def test_tools_registry_sanity():
    assert PROPOSAL_TOOLS == {"propose_questions", "propose_context",
                              "propose_run", "propose_save_preset"}
    assert PROPOSAL_TOOLS <= TOOL_NAMES
    read = {"get_state", "list_presets", "list_models"}
    assert read <= TOOL_NAMES
    assert PROPOSAL_TOOLS.isdisjoint(read)


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
    assert events[0] == {"type": "tool", "name": "get_state", "status": "start"}
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
    # ошибка ушла модели tool-сообщением
    tool_msg = fake_chat.requests[1]["json"]["messages"][-1]
    assert tool_msg["role"] == "tool"
    content = json.loads(tool_msg["content"])
    assert content["ok"] is False and "mode" in content["error"]


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
    assert "500" in events[0]["message"] and "boom" in events[0]["message"]


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
    "questions": [{"id": "q1", "question": "Есть опыт?", "type": "yes_no"}],
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


async def test_trial_defaults_from_snapshot(trial_env):
    result, events = await trial_mod.run_trial(dict(TRIAL_SNAPSHOT), {})
    assert result["ok"] is True
    assert "trial-a" in result["summary"] and "trial-b" in result["summary"]
    assert "да 80%" in result["summary"]
    assert len(events) == 1 and events[0]["type"] == "trial"
    t = events[0]["trial"]
    assert t["models"] == ["trial-a", "trial-b"]
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
    assert "одиночном режиме" in result["error"]
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
    assert events[0] == {"type": "tool", "name": "run_trial", "status": "start"}
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
    assert events[0] == {"type": "tool", "name": "get_state", "status": "start"}
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
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    fake_chat.responses = [[]]  # строки не дойдут: статус не 200
    FakeChatClient.status_code = 429
    FakeChatClient.body = b"rate limited"
    events = await collect_events(run_remote_agent([], "привет", None,
                                                   _remote_entry()))
    assert event_types(events) == ["error"]
    assert "429" in events[0]["message"]


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
