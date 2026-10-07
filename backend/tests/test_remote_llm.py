"""Unit-тесты облачных chat API (remote_llm): remote_chat, decide-прогон,
генерация вопросов, ассистент на удалённой модели, создание remote-модели
с именованным API. Внешние HTTP замоканы — сеть не нужна.
"""

from __future__ import annotations

import json
import json as json_module

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import credentials as creds
from backend import model_manager as mm
from backend import remote_llm
from backend.schemas import DecideRequest, Question

client = TestClient(app_module.app)


class FakeResponse:
    def __init__(self, status_code=200, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data
        self.text = text

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


CHAT_OK = FakeResponse(200, {
    "choices": [{"message": {"content": '{"answers": {"q1": 0.8}}'}}],
})


class FakeAsyncClient:
    calls: list[dict] = []
    post_response = CHAT_OK
    post_sequence: list | None = None
    get_response = FakeResponse(200, {"data": [{"id": "m"}]})
    raise_on_post = False

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, json=None, headers=None, **kwargs):
        if FakeAsyncClient.raise_on_post:
            raise httpx.ConnectError("connection refused")
        FakeAsyncClient.calls.append({"url": url, "json": dict(json or {}),
                                      "headers": headers})
        if FakeAsyncClient.post_sequence:
            return FakeAsyncClient.post_sequence.pop(0)
        return FakeAsyncClient.post_response

    async def get(self, url, **kwargs):
        return FakeAsyncClient.get_response

    def stream(self, method, url, json=None, headers=None, **kwargs):
        """Стрим-вариант post() для агента: content ответа одним SSE-чанком."""
        FakeAsyncClient.calls.append({"url": url, "json": json, "headers": headers})
        resp = FakeAsyncClient.post_response
        try:
            content = resp.json()["choices"][0]["message"].get("content") or ""
        except Exception:
            content = ""
        lines = ["data: " + json_module.dumps(
            {"choices": [{"delta": {"content": content}}]}, ensure_ascii=False),
            "data: [DONE]"]
        return FakeStreamCtx(resp.status_code, lines, resp.text.encode())


class FakeStreamCtx:
    def __init__(self, status_code, lines, body=b""):
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


@pytest.fixture(autouse=True)
def mock_http(monkeypatch, tmp_path):
    FakeAsyncClient.calls = []
    FakeAsyncClient.post_response = CHAT_OK
    FakeAsyncClient.post_sequence = None
    FakeAsyncClient.raise_on_post = False
    FakeAsyncClient.get_response = FakeResponse(200, {"data": [{"id": "m"}]})
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(creds, "CREDENTIALS_PATH", tmp_path / "credentials.json")
    monkeypatch.setattr(mm, "CONFIG_PATH", tmp_path / "models_config.json")
    for var in ("OPENROUTER_API_KEY", "OPENAI_API_KEY", "CLEF_API_KEY",
                "SYSTEM1_API_KEY", "LAYA_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    mm._probe_cache.clear()
    yield
    for key in [k for k in mm.REGISTRY if k.startswith("remote-")]:
        mm.REGISTRY.pop(key, None)


@pytest.fixture
def chat_model(monkeypatch):
    """Облачная chat-модель openrouter в реестре с ключом в credentials."""
    entry, error = mm.create_remote_model({
        "label": "OR Claude", "api": "openrouter", "api_model": "anthropic/claude",
        "api_key": "sk-or-test",
    })
    assert error is None
    mm.invalidate_remote_probe(entry.key)
    yield entry
    mm.REGISTRY.pop(entry.key, None)


def yn_question(qid="q1"):
    return {"id": qid, "question": "Да?", "type": "yes_no"}


# ---------------------------------------------------------------- remote_chat

@pytest.mark.asyncio
async def test_remote_chat_request_shape(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-env")
    text = await remote_llm.remote_chat(
        "openrouter", "anthropic/claude",
        [{"role": "user", "content": "привет"}], max_tokens=100, temperature=0.5)
    assert text == '{"answers": {"q1": 0.8}}'
    call = FakeAsyncClient.calls[0]
    assert call["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert call["headers"] == {"Authorization": "Bearer sk-env"}
    assert call["json"]["model"] == "anthropic/claude"
    assert call["json"]["max_tokens"] == 100
    assert call["json"]["temperature"] == 0.5


@pytest.mark.asyncio
async def test_remote_chat_env_key_beats_credentials(chat_model, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-env")
    await remote_llm.remote_chat("openrouter", "m", [{"role": "user", "content": "x"}],
                                 model_key=chat_model.key, base_url=chat_model.base_url)
    assert FakeAsyncClient.calls[0]["headers"]["Authorization"] == "Bearer sk-env"
    monkeypatch.delenv("OPENROUTER_API_KEY")
    await remote_llm.remote_chat("openrouter", "m", [{"role": "user", "content": "x"}],
                                 model_key=chat_model.key, base_url=chat_model.base_url)
    assert FakeAsyncClient.calls[1]["headers"]["Authorization"] == "Bearer sk-or-test"


@pytest.mark.asyncio
async def test_remote_chat_no_key_error():
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        await remote_llm.remote_chat("openai", "gpt-4o", [{"role": "user", "content": "x"}])


@pytest.mark.asyncio
async def test_remote_chat_http_error(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-t")
    FakeAsyncClient.post_response = FakeResponse(429, {"error": {"message": "rate limit"}})
    with pytest.raises(RuntimeError, match="rate limit"):
        await remote_llm.remote_chat("openai", "gpt-4o",
                                     [{"role": "user", "content": "x"}])


def test_base_urls_and_systemone_disambiguation():
    assert remote_llm.default_base_url("clef") == "https://ai.1lab.club/v1"
    assert remote_llm.default_base_url("systemone") == "https://api.system1.cloud/v1"
    assert remote_llm.default_base_url("laya") == "https://laya.ai/api/v1"
    # systemone с чужим base_url — протокол /v1/systemone, не chat
    assert remote_llm.chat_base_url("systemone", "https://api.typesafe.ai") is None
    assert remote_llm.chat_base_url("systemone", None) == "https://api.system1.cloud/v1"
    assert remote_llm.chat_base_url("decisions", "http://x") is None


# ---------------------------------------------------------------- parse_answers

def _questions():
    return [
        Question(id="q1", question="Да?", type="yes_no"),
        Question(id="q2", question="Выбор?", type="choice",
                 options=[{"name": "А"}, {"name": "Б"}]),
        Question(id="q3", question="Оценка?", type="score", levels=["плохо", "хорошо"]),
    ]


def test_parse_answers_all_types():
    text = json.dumps({"answers": {"q1": 0.9, "q2": "Б", "q3": 1}})
    answers = remote_llm.parse_answers(text, _questions())
    assert answers["q1"]["probabilities"] == {"yes": 0.9, "no": 0.1}
    assert answers["q2"]["choice"] == "Б"
    assert answers["q2"]["probabilities"] == {"А": 0.0, "Б": 1.0}
    assert answers["q3"]["score"] == 1.0
    assert answers["q1"]["label_mass"] is None


def test_parse_answers_fenced_and_synonyms():
    text = '```json\n{"answers": {"q1": "да", "q2": "а", "q3": "хорошо"}}\n```'
    answers = remote_llm.parse_answers(text, _questions())
    assert answers["q1"]["probabilities"]["yes"] == 1.0
    assert answers["q2"]["choice"] == "А"  # case-insensitive
    assert answers["q3"]["score"] == 1.0   # уровень по имени


def test_parse_answers_errors():
    with pytest.raises(ValueError):
        remote_llm.parse_answers("никакого json", _questions())
    with pytest.raises(ValueError, match="q2"):
        remote_llm.parse_answers('{"answers": {"q1": 1}}', _questions())


# ---------------------------------------------------------------- create_remote_model

def test_create_remote_chat_model_defaults(chat_model):
    assert chat_model.base_url == "https://openrouter.ai/api/v1"
    assert chat_model.api_model == "anthropic/claude"
    assert chat_model.roles == ["decision", "chat"]
    assert creds.get(chat_model.key) == "sk-or-test"
    saved = json.loads(mm.CONFIG_PATH.read_text(encoding="utf-8"))
    cfg = next(c for c in saved if c["key"] == chat_model.key)
    assert cfg["api"] == "openrouter"
    assert cfg["roles"] == ["decision", "chat"]


def test_create_remote_chat_model_requires_api_model():
    entry, error = mm.create_remote_model({"label": "X", "api": "openai"})
    assert entry is None
    assert "api_model" in error


def test_create_remote_unknown_api():
    entry, error = mm.create_remote_model({"label": "X", "api": "bogus",
                                           "base_url": "http://x"})
    assert entry is None
    assert "api" in error


def test_systemone_custom_base_url_stays_protocol():
    entry, error = mm.create_remote_model({
        "label": "Jev copy", "api": "systemone",
        "base_url": "https://api.typesafe.ai", "api_model": "jev"})
    assert error is None
    assert not remote_llm.is_chat_entry(entry)  # протокол /v1/systemone
    assert entry.roles == ["decision"]
    mm.REGISTRY.pop(entry.key, None)


def test_systemone_cloud_is_chat():
    entry, error = mm.create_remote_model({
        "label": "S1", "api": "systemone", "api_model": "s1-large"})
    assert error is None
    assert remote_llm.is_chat_entry(entry)
    assert entry.base_url == "https://api.system1.cloud/v1"
    mm.REGISTRY.pop(entry.key, None)


def test_chat_model_status_with_env_key(chat_model, monkeypatch):
    """Ключ из env считается кредами: статус не no_credentials."""
    creds.delete(chat_model.key)
    mm.invalidate_remote_probe(chat_model.key)
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-env")
    import asyncio
    status = asyncio.run(mm.model_status(chat_model))
    assert status["has_credentials"] is True
    assert status["status"] == "running"  # фейковый probe GET /models = 200


# ---------------------------------------------------------------- /api/decide

def test_decide_remote_chat_ok(chat_model):
    r = client.post("/api/decide", json={
        "input": "Иван врач.", "questions": [yn_question()], "models": [chat_model.key],
    })
    assert r.status_code == 200
    res = r.json()["results"][chat_model.key]
    assert res["ok"] is True, res
    assert res["answers"]["q1"]["probabilities"] == {"yes": 0.8, "no": 0.2}
    assert res["metrics"]["mode"] == "remote_chat"
    call = next(c for c in FakeAsyncClient.calls if "chat/completions" in c["url"])
    assert call["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert call["headers"] == {"Authorization": "Bearer sk-or-test"}
    assert call["json"]["model"] == "anthropic/claude"
    user_msg = call["json"]["messages"][1]["content"]
    assert "Иван врач." in user_msg and "Да?" in user_msg


def test_decide_remote_chat_api_error_slot(chat_model):
    FakeAsyncClient.post_response = FakeResponse(500, text="boom")
    r = client.post("/api/decide", json={
        "input": "Текст.", "questions": [yn_question()], "models": [chat_model.key],
    })
    res = r.json()["results"][chat_model.key]
    assert res["ok"] is False
    assert "500" in res["error"]


def test_decide_remote_chat_bad_json_slot(chat_model):
    FakeAsyncClient.post_response = FakeResponse(
        200, {"choices": [{"message": {"content": "просто текст без json"}}]})
    r = client.post("/api/decide", json={
        "input": "Текст.", "questions": [yn_question()], "models": [chat_model.key],
    })
    res = r.json()["results"][chat_model.key]
    assert res["ok"] is False
    assert "JSON" in res["error"]


def test_decide_remote_chat_no_credentials(chat_model):
    creds.delete(chat_model.key)
    mm.invalidate_remote_probe(chat_model.key)
    r = client.post("/api/decide", json={
        "input": "Текст.", "questions": [yn_question()], "models": [chat_model.key],
    })
    res = r.json()["results"][chat_model.key]
    assert res["ok"] is False
    assert "API-ключ" in res["error"]
    assert not [c for c in FakeAsyncClient.calls if "chat/completions" in c["url"]]


# ---------------------------------------------------------------- генерация вопросов

GEN_OK = FakeResponse(200, {"choices": [{"message": {"content": json.dumps({
    "name": "Скрининг",
    "description": "Проверка резюме",
    "questions": [
        {"type": "yes_no", "question": "Есть опыт?", "yes": "опыт указан"},
        {"type": "choice", "question": "Стек?", "options": ["Python", "Go"]},
        {"type": "score", "question": "Уровень?",
         "levels": ["junior", "senior"], "direction": "up"},
    ],
})}}]})


def test_presets_generate_ok(chat_model):
    FakeAsyncClient.post_response = GEN_OK
    r = client.post("/api/presets/generate", json={
        "model_key": chat_model.key, "description": "Скрининг резюме"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["name"] == "Скрининг"
    assert [q["id"] for q in data["questions"]] == ["q1", "q2", "q3"]
    assert data["questions"][1]["options"][0] == {"name": "Python"}
    assert data["questions"][2]["direction"] == "up"
    # сгенерированные вопросы валидны для пресета
    r2 = client.post("/api/presets", json={
        "name": data["name"], "page": "single",
        "payload": {"input": "пример резюме", "questions": data["questions"]}})
    assert r2.status_code == 200, r2.text
    # убираем созданный пресет
    client.delete(f"/api/presets/{r2.json()['slug']}")


def test_presets_generate_errors(chat_model):
    r = client.post("/api/presets/generate", json={
        "model_key": chat_model.key, "description": "  "})
    assert r.status_code == 422
    r = client.post("/api/presets/generate", json={
        "model_key": "clef-flash-9b-4bit", "description": "x"})
    assert r.status_code == 422
    assert "chat" in r.json()["detail"]
    FakeAsyncClient.raise_on_post = True
    r = client.post("/api/presets/generate", json={
        "model_key": chat_model.key, "description": "x"})
    assert r.status_code == 502


def test_questions_generate_ok(chat_model):
    FakeAsyncClient.post_response = GEN_OK
    r = client.post("/api/questions/generate", json={
        "model_key": chat_model.key, "input": "Иван врач, 10 лет опыта."})
    assert r.status_code == 200, r.text
    questions = r.json()["questions"]
    assert len(questions) == 3
    assert "name" not in r.json()  # для редактора — только вопросы
    call = FakeAsyncClient.calls[-1]
    assert "Иван врач" in call["json"]["messages"][1]["content"]


# ---------------------------------------------------------------- генерация: локальные chat-модели

def test_generate_local_sglang_ok_default_no_thinking():
    """Локальная sglang chat-модель: проба /v1/models + POST chat/completions,
    enable_thinking=false по умолчанию."""
    FakeAsyncClient.post_response = GEN_OK
    r = client.post("/api/questions/generate", json={
        "model_key": "qwen38-27b-4bit", "hint": "проверка резюме"})
    assert r.status_code == 200, r.text
    assert len(r.json()["questions"]) == 3
    post = next(c for c in FakeAsyncClient.calls
                if c["url"].endswith("/v1/chat/completions"))
    entry = mm.REGISTRY["qwen38-27b-4bit"]
    assert post["url"] == f"{entry.url}/v1/chat/completions"
    assert post["json"]["chat_template_kwargs"] == {"enable_thinking": False}
    assert "reasoning_effort" not in post["json"]


def test_generate_local_thinking_true():
    FakeAsyncClient.post_response = GEN_OK
    r = client.post("/api/presets/generate", json={
        "model_key": "qwen38-27b-4bit", "description": "задача", "thinking": True})
    assert r.status_code == 200, r.text
    post = next(c for c in FakeAsyncClient.calls
                if c["url"].endswith("/v1/chat/completions"))
    assert post["json"]["chat_template_kwargs"] == {"enable_thinking": True}


def test_generate_local_not_running_409():
    """Проба /v1/models падает — 409 «не запущена» (как у ассистента)."""
    FakeAsyncClient.get_response = FakeResponse(500, text="down")
    r = client.post("/api/questions/generate", json={
        "model_key": "qwen38-27b-4bit", "hint": "x"})
    assert r.status_code == 409
    assert "не запущена" in r.json()["detail"]


def test_generate_remote_thinking_reasoning_effort(chat_model):
    """thinking=true у облачной → reasoning_effort в payload."""
    FakeAsyncClient.post_response = GEN_OK
    r = client.post("/api/presets/generate", json={
        "model_key": chat_model.key, "description": "задача", "thinking": True})
    assert r.status_code == 200, r.text
    call = FakeAsyncClient.calls[-1]
    assert call["json"]["reasoning_effort"] == "high"


def test_generate_remote_reasoning_effort_fallback(chat_model):
    """400 из-за reasoning_effort → один ретрай без параметра."""
    FakeAsyncClient.post_sequence = [
        FakeResponse(400, {"error": {"message": "unknown field reasoning_effort"}}),
        GEN_OK,
    ]
    r = client.post("/api/presets/generate", json={
        "model_key": chat_model.key, "description": "задача", "thinking": True})
    assert r.status_code == 200, r.text
    assert len(FakeAsyncClient.calls) == 2
    assert FakeAsyncClient.calls[0]["json"]["reasoning_effort"] == "high"
    assert "reasoning_effort" not in FakeAsyncClient.calls[1]["json"]


# ---------------------------------------------------------------- ассистент на remote

def test_assistant_models_include_remote_chat(chat_model):
    models = client.get("/api/assistant/models").json()["models"]
    remote = next(m for m in models if m["key"] == chat_model.key)
    assert remote["remote"] is True
    # протоколная remote-модель (jev) в список не попадает — роль только decision
    assert "jev-latest" not in {m["key"] for m in models}


def test_assistant_chat_remote_ok(chat_model):
    FakeAsyncClient.post_response = FakeResponse(
        200, {"choices": [{"message": {"content": "Ответ облака."}}]})
    r = client.post("/api/assistant/chat", json={
        "model_key": chat_model.key, "message": "привет"})
    assert r.status_code == 200
    events = [json.loads(line[len("data: "):])
              for line in r.text.splitlines() if line.startswith("data: ")]
    assert events[-1] == {"type": "done"}
    tokens = "".join(e["text"] for e in events if e["type"] == "token")
    assert tokens == "Ответ облака."
    call = FakeAsyncClient.calls[-1]
    assert call["url"].endswith("/chat/completions")
    assert call["json"]["messages"][-1] == {"role": "user", "content": "привет"}
    names = [t["function"]["name"] for t in call["json"]["tools"]]
    assert "get_state" in names  # облачный ассистент — с инструментами


def test_assistant_chat_remote_no_key_409(chat_model):
    creds.delete(chat_model.key)
    r = client.post("/api/assistant/chat", json={
        "model_key": chat_model.key, "message": "привет"})
    assert r.status_code == 409
    assert "API-ключ" in r.json()["detail"]
