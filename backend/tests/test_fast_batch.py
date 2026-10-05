"""Unit-тесты режима fast_batch. SGLang замокан — реальный сервер не нужен."""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import fast_batch as fb
from backend import model_manager as mm
from backend.schemas import DecideRequest

client = TestClient(app_module.app)

MODEL_A = "qwen38-27b-4bit"

CHAT_URL = "http://127.0.0.1:30001/v1/chat/completions"


# ---------------------------------------------------------------- helpers

def yn_question(qid="q1", yes=None, no=None):
    q = {"id": qid, "question": "Да?", "type": "yes_no"}
    if yes:
        q["yes"] = yes
    if no:
        q["no"] = no
    return q


def choice_question(qid="q2", options=("А", "Б", "В")):
    return {
        "id": qid,
        "question": "Выбор?",
        "type": "choice",
        "options": [{"name": n} for n in options],
    }


def score_question(qid="q3", levels=("л0", "л1", "л2", "л3", "л4")):
    return {"id": qid, "question": "Оценка?", "type": "score", "levels": list(levels)}


def good_body(models=None):
    return {
        "input": "Некоторый текст контекста.",
        "questions": [yn_question(), choice_question(), score_question()],
        "models": models if models is not None else [MODEL_A],
        "mode": "fast_batch",
    }


def make_questions():
    req = DecideRequest.model_validate(good_body())
    return req.questions


def content_item(token, top):
    """Элемент choices[0].logprobs.content: токен с top_logprobs."""
    return {
        "token": token,
        "logprob": top[token],
        "top_logprobs": [{"token": t, "logprob": lp} for t, lp in top.items()],
    }


def chat_response(content_items, prompt_tokens=42, completion_tokens=None):
    return {
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "".join(i["token"] for i in content_items),
                },
                "logprobs": {"content": content_items},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": (
                completion_tokens if completion_tokens is not None else len(content_items)
            ),
        },
    }


def good_chat_items():
    """Корректный ответ: A (yes_no), C (choice), 3 (score)."""
    return [
        content_item("A", {"A": -0.1, "B": -3.0}),
        content_item("C", {"A": -5.0, "B": -1.0, "C": -0.2}),
        content_item("3", {"0": -6.0, "1": -4.0, "2": -2.0, "3": -0.5}),
    ]


class FakeResponse:
    def __init__(self, status_code=200, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data
        self.text = text

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class FakeAsyncClient:
    """Подмена httpx.AsyncClient: очередь ответов на POST, health-probe на GET."""

    calls: list[dict] = []
    post_queue: list[FakeResponse] = []
    post_error = False
    get_error = False
    default_post_response = FakeResponse(
        200,
        {
            "object": "decisions",
            "model": "test-model",
            "prompt_format_version": 1,
            "answers": {
                "q1": {"type": "yes_no", "probabilities": {"yes": 0.7, "no": 0.3}, "label_mass": 0.9}
            },
            "usage": {"prompt_tokens": 10, "completion_tokens": 0},
        },
    )

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, json=None, **kwargs):
        FakeAsyncClient.calls.append({"url": url, "json": json})
        if FakeAsyncClient.post_error:
            raise httpx.ConnectError("connection refused")
        if FakeAsyncClient.post_queue:
            return FakeAsyncClient.post_queue.pop(0)
        return FakeAsyncClient.default_post_response

    async def get(self, url, **kwargs):
        if FakeAsyncClient.get_error:
            raise httpx.ConnectError("connection refused")
        return FakeResponse(200, {"data": [{"id": "test-model"}]})


@pytest.fixture(autouse=True)
def mock_sglang(monkeypatch):
    FakeAsyncClient.calls = []
    FakeAsyncClient.post_queue = []
    FakeAsyncClient.post_error = False
    FakeAsyncClient.get_error = False
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(mm, "is_downloaded", lambda hf_id: False)
    monkeypatch.setattr(mm, "rss_gb", lambda port: None)
    for entry in mm.REGISTRY.values():
        entry.proc = None
        entry.started_at = None
    yield


def queue_chat(items=None, data=None, status=200, text=""):
    payload = data if data is not None else chat_response(items or good_chat_items())
    FakeAsyncClient.post_queue.append(FakeResponse(status, payload, text))


# ---------------------------------------------------------------- промпт и regex

def test_build_prompt_mixed_types():
    questions = make_questions()
    messages = fb.build_messages("Контекст здесь.", questions)
    assert messages[0]["role"] == "system"
    user = messages[1]["content"]
    assert "Контекст здесь." in user
    # yes_no с описаниями
    assert "A: да" in user and "B: нет" in user
    # choice: метки по именам опций
    assert "A: А" in user and "B: Б" in user and "C: В" in user
    # score: числовые метки по уровням
    assert "0: л0" in user and "4: л4" in user
    assert "1. Да?" in user and "2. Выбор?" in user and "3. Оценка?" in user
    assert fb.FINAL_INSTRUCTION in user


def test_build_prompt_yes_no_custom_descriptions():
    body = good_body()
    body["questions"] = [yn_question(yes="Скорее да", no="Скорее нет")]
    req = DecideRequest.model_validate(body)
    user = fb.build_messages(body["input"], req.questions)[1]["content"]
    assert "A: Скорее да" in user
    assert "B: Скорее нет" in user


def test_build_prompt_dict_input():
    questions = make_questions()
    user = fb.build_messages({"dialog": [{"role": "agent", "text": "Привет"}]}, questions)[1]["content"]
    assert '"dialog"' in user


def test_build_regex_mixed_types():
    questions = make_questions()
    assert fb.build_regex(questions) == "^(A|B)(A|B|C)(0|1|2|3|4)$"


def test_build_regex_choice_26_and_score_10():
    body = good_body()
    body["questions"] = [
        choice_question(options=[f"o{i}" for i in range(26)]),
        score_question(levels=[f"l{i}" for i in range(10)]),
    ]
    req = DecideRequest.model_validate(body)
    assert fb.build_regex(req.questions) == "^(A|B|C|D|E|F|G|H|I|J|K|L|M|N|O|P|Q|R|S|T|U|V|W|X|Y|Z)(0|1|2|3|4|5|6|7|8|9)$"


# ---------------------------------------------------------------- вероятности

def test_softmax_sum_and_argmax():
    scores = {"A": -0.1, "B": -2.0}
    probs = fb.softmax_probabilities(scores, ["A", "B"])
    assert abs(sum(probs.values()) - 1.0) < 1e-6
    assert probs["A"] > probs["B"]
    assert probs["A"] == pytest.approx(0.8699, abs=1e-3)


def test_softmax_missing_label_gets_tiny_probability():
    scores = {"A": -0.1}  # B не видна в top_logprobs
    probs = fb.softmax_probabilities(scores, ["A", "B"])
    assert abs(sum(probs.values()) - 1.0) < 1e-6
    assert probs["A"] > 0.99
    assert 0.0 < probs["B"] < 1e-9  # floor = -0.1 - 25 → ~e^-25 после нормировки


def test_parse_content_answers_mapping():
    questions = make_questions()
    answers = fb.parse_content_answers(good_chat_items(), questions)
    assert answers is not None
    a1, a2, a3 = answers["q1"], answers["q2"], answers["q3"]
    assert a1["type"] == "yes_no" and set(a1["probabilities"]) == {"yes", "no"}
    assert a1["probabilities"]["yes"] > a1["probabilities"]["no"]
    assert a2["choice"] == "В"
    # q3: logprobs {"0": -6, "1": -4, "2": -2, "3": -0.5} → матожидание ≈ 2.76
    assert a3["score"] == pytest.approx(2.7647, abs=1e-3)
    for a in (a1, a2, a3):
        assert abs(sum(a["probabilities"].values()) - 1.0) < 1e-6
        assert a["label_mass"] is None


def test_parse_content_answers_wrong_length():
    questions = make_questions()
    assert fb.parse_content_answers(good_chat_items()[:2], questions) is None
    assert fb.parse_content_answers(good_chat_items() + [content_item("A", {"A": -0.1})], questions) is None


def test_parse_content_answers_invalid_label():
    questions = make_questions()
    items = good_chat_items()
    items[2] = content_item("9", {"9": -0.1})  # у score 5 уровней: 0..4
    assert fb.parse_content_answers(items, questions) is None


# ---------------------------------------------------------------- end-to-end /api/decide

def test_fast_batch_success_shape():
    queue_chat()
    r = client.post("/api/decide", json=good_body())
    assert r.status_code == 200
    res = r.json()["results"][MODEL_A]
    assert res["ok"] is True
    assert res["prompt_format_version"] is None
    assert res["usage"] == {"prompt_tokens": 42, "completion_tokens": 3}
    metrics = res["metrics"]
    assert metrics["mode"] == "fast_batch"
    assert metrics["fallback"] is False
    assert metrics["label_mass_min"] is None
    assert metrics["label_mass_avg"] is None
    assert metrics["prompt_tokens"] == 42
    assert metrics["prefill_tok_s"] > 0
    answers = res["answers"]
    assert answers["q1"]["probabilities"]["yes"] > 0.5
    assert answers["q2"]["choice"] == "В"
    assert answers["q3"]["score"] > 2.0


def test_fast_batch_request_payload():
    queue_chat()
    r = client.post("/api/decide", json=good_body())
    assert r.status_code == 200
    assert len(FakeAsyncClient.calls) == 1
    call = FakeAsyncClient.calls[0]
    assert call["url"] == CHAT_URL
    payload = call["json"]
    assert payload["model"] == mm.REGISTRY[MODEL_A].hf_id
    assert payload["regex"] == "^(A|B)(A|B|C)(0|1|2|3|4)$"
    assert payload["temperature"] == 0
    assert payload["logprobs"] is True
    assert payload["top_logprobs"] == 20
    assert payload["max_completion_tokens"] == 3
    assert [m["role"] for m in payload["messages"]] == ["system", "user"]


def test_fast_batch_mode_default_is_decisions():
    body = good_body()
    del body["mode"]
    r = client.post("/api/decide", json=body)
    assert r.status_code == 200
    # decisions-ветка ходит в /v1/decisions, а не в chat/completions
    assert all("/v1/decisions" in c["url"] for c in FakeAsyncClient.calls)


def test_invalid_mode_rejected():
    body = good_body()
    body["mode"] = "fast-batch"
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422


def test_fast_batch_model_not_running():
    FakeAsyncClient.get_error = True
    r = client.post("/api/decide", json=good_body())
    assert r.status_code == 200
    res = r.json()["results"][MODEL_A]
    assert res["ok"] is False
    assert "запуст" in res["error"].lower()
    assert FakeAsyncClient.calls == []


# ---------------------------------------------------------------- fallback

def test_fallback_when_regex_unsupported():
    FakeAsyncClient.post_queue.append(FakeResponse(400, None, "unsupported grammar: regex"))
    queue_chat()
    r = client.post("/api/decide", json=good_body())
    assert r.status_code == 200
    res = r.json()["results"][MODEL_A]
    assert res["ok"] is True
    assert res["metrics"]["fallback"] is True
    assert len(FakeAsyncClient.calls) == 2
    assert "regex" not in FakeAsyncClient.calls[1]["json"]


def test_fallback_when_response_unparseable():
    queue_chat(items=[content_item("A", {"A": -0.1})])  # 1 токен вместо 3 → retry
    queue_chat()
    r = client.post("/api/decide", json=good_body())
    assert r.status_code == 200
    res = r.json()["results"][MODEL_A]
    assert res["ok"] is True
    assert res["metrics"]["fallback"] is True


def test_fallback_parses_text_with_separators():
    FakeAsyncClient.post_queue.append(FakeResponse(400, None, "regex not supported"))
    items = [
        content_item("A", {"A": -0.1, "B": -3.0}),
        content_item(" ", {" ": -0.01}),
        content_item("B", {"A": -1.0, "B": -0.2, "C": -4.0}),
        content_item(",", {",": -0.01}),
        content_item("4", {"0": -7.0, "3": -2.0, "4": -0.3}),
    ]
    queue_chat(items=items)
    r = client.post("/api/decide", json=good_body())
    assert r.status_code == 200
    res = r.json()["results"][MODEL_A]
    assert res["ok"] is True
    assert res["metrics"]["fallback"] is True
    assert res["answers"]["q1"]["probabilities"]["yes"] > 0.5
    assert res["answers"]["q2"]["choice"] == "Б"
    assert res["answers"]["q3"]["score"] > 3.0
    # выровненные логпробы дают не one-hot распределение (3: −2.0 против 4: −0.3)
    p = res["answers"]["q3"]["probabilities"]
    assert 0.05 < p["3"] < 0.2


def test_fallback_one_hot_without_aligned_logprobs():
    FakeAsyncClient.post_queue.append(FakeResponse(400, None, "regex not supported"))
    data = chat_response([])
    data["choices"][0]["message"]["content"] = "AC3"
    data["choices"][0]["logprobs"] = None
    queue_chat(data=data)
    r = client.post("/api/decide", json=good_body())
    assert r.status_code == 200
    res = r.json()["results"][MODEL_A]
    assert res["ok"] is True
    assert res["answers"]["q2"]["choice"] == "В"
    assert res["answers"]["q2"]["probabilities"] == {"А": 0.0, "Б": 0.0, "В": 1.0}


# ---------------------------------------------------------------- мусор

def test_garbage_response_gives_ok_false():
    FakeAsyncClient.post_queue.append(FakeResponse(400, None, "regex not supported"))
    data = chat_response([])
    data["choices"][0]["message"]["content"] = "Ответ: не знаю"
    data["choices"][0]["logprobs"] = None
    queue_chat(data=data)
    r = client.post("/api/decide", json=good_body())
    assert r.status_code == 200
    res = r.json()["results"][MODEL_A]
    assert res["ok"] is False
    assert "разобрать" in res["error"]
    assert res["metrics"]["fallback"] is True


def test_hard_400_not_retried():
    FakeAsyncClient.post_queue.append(FakeResponse(400, {"detail": "model overloaded"}, ""))
    r = client.post("/api/decide", json=good_body())
    assert r.status_code == 200
    res = r.json()["results"][MODEL_A]
    assert res["ok"] is False
    assert "model overloaded" in res["error"]
    assert len(FakeAsyncClient.calls) == 1  # не fallback-ошибка → один запрос


def test_sglang_unavailable():
    FakeAsyncClient.post_error = True
    r = client.post("/api/decide", json=good_body())
    assert r.status_code == 200
    res = r.json()["results"][MODEL_A]
    assert res["ok"] is False
    assert "недоступен" in res["error"]
