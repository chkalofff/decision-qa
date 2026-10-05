"""Unit-тесты backend/clef.py: маппинг SystemOne, разбор ответов, ошибки, метрики."""

from __future__ import annotations

import httpx
import pytest

from backend import clef
from backend import model_manager as mm
from backend.schemas import DecideRequest, Question


def make_entry(hf_id="mlx-community/clef-flash-4bit", port=30003):
    return mm.ModelEntry("clef-flash-9b-4bit", "Clef-Flash 9B · 4bit", hf_id, port, 0.14, "clef")


def yn(qid="q1", yes=None, no=None):
    return Question(id=qid, question="Да?", type="yes_no", yes=yes, no=no)


def choice(qid="q2", options=("А", "Б", "В"), descriptions=None):
    descriptions = descriptions or [None] * len(options)
    return Question(
        id=qid, question="Выбор?", type="choice",
        options=[{"name": n, "description": d} for n, d in zip(options, descriptions)],
    )


def score(qid="q3", levels=("низкий", "средний", "высокий")):
    return Question(id=qid, question="Оценка?", type="score", levels=list(levels))


def make_request(questions=None):
    return DecideRequest(
        input="Некоторый текст контекста.",
        questions=questions or [yn(), choice(), score()],
        models=["clef-flash-9b-4bit"],
    )


SYSTEMONE_RESPONSE = {
    "model": "clef-flash",
    "answers": {
        "q1": {"type": "noul", "noul": 0.7},
        "q2": {"type": "choice", "choice": "Б", "confidence": 0.8,
               "probabilities": {"А": 0.1, "Б": 0.8, "В": 0.1}},
        "q3": {"type": "score", "score": 1.1, "confidence": 0.5,
               "probabilities": {"0": 0.2, "1": 0.5, "2": 0.3}},
    },
    "usage": {"input_tokens": 42, "output_tokens": 0, "latency_ms": 300},
}


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
    calls: list[dict] = []
    post_response = FakeResponse(200, SYSTEMONE_RESPONSE)
    get_error = False
    post_error = False

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, json=None, **kwargs):
        if FakeAsyncClient.post_error:
            raise httpx.ConnectError("connection refused")
        FakeAsyncClient.calls.append({"url": url, "json": json})
        return FakeAsyncClient.post_response

    async def get(self, url, **kwargs):
        if FakeAsyncClient.get_error:
            raise httpx.ConnectError("connection refused")
        return FakeResponse(200, {"data": [{"id": "clef-flash"}]})


@pytest.fixture(autouse=True)
def base_mocks(monkeypatch):
    FakeAsyncClient.calls = []
    FakeAsyncClient.post_response = FakeResponse(200, SYSTEMONE_RESPONSE)
    FakeAsyncClient.get_error = False
    FakeAsyncClient.post_error = False
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(mm, "rss_gb", lambda port: None)
    yield


# ---------------------------------------------------------------- маппинг запроса

def test_model_name_by_hf_id():
    assert clef.model_name(make_entry("mlx-community/clef-flash-4bit")) == "clef-flash"
    assert clef.model_name(make_entry("mlx-community/clef-4bit")) == "clef"


def test_request_shape():
    req = make_request()
    payload = clef.build_systemone_request(make_entry(), req)
    assert payload["model"] == "clef-flash"
    assert payload["state"] == "Некоторый текст контекста."
    assert [q for q in payload["questions"]] == ["q1", "q2", "q3"]
    assert "images" not in payload


def test_request_with_images():
    req = make_request()
    req.images = ["data:image/png;base64,AAAA"]
    payload = clef.build_systemone_request(make_entry(), req)
    assert payload["images"] == ["data:image/png;base64,AAAA"]


def test_yes_no_without_criteria():
    payload = clef.question_payload(yn())
    assert payload == {"type": "noul", "instructions": "Да?"}


def test_yes_no_with_labels():
    payload = clef.question_payload(yn(yes="подходит", no="не подходит"))
    assert payload["criteria"] == {"true": "подходит", "false": "не подходит"}


def test_choice_criteria_with_fallback_description():
    payload = clef.question_payload(choice(options=("А", "Б"), descriptions=["описание А", None]))
    assert payload["type"] == "choice"
    assert payload["criteria"] == {"А": "описание А", "Б": "Б"}


def test_score_criteria_levels():
    payload = clef.question_payload(score())
    assert payload["type"] == "score"
    assert payload["criteria"] == ["низкий", "средний", "высокий"]


# ---------------------------------------------------------------- маппинг ответа

def test_map_answers_shapes():
    answers = clef.map_answers(SYSTEMONE_RESPONSE, make_request().questions)
    a1, a2, a3 = answers["q1"], answers["q2"], answers["q3"]
    assert a1["probabilities"] == {"yes": 0.7, "no": pytest.approx(0.3)}
    assert a1["label_mass"] is None
    assert a2["choice"] == "Б"
    assert sum(a2["probabilities"].values()) == pytest.approx(1.0)
    assert a3["score"] == pytest.approx(0.2 * 0 + 0.5 * 1 + 0.3 * 2)
    assert a3["probabilities"]["2"] == 0.3


def test_map_answers_normalizes_probabilities():
    data = {"answers": {"q2": {"probabilities": {"А": 1.0, "Б": 3.0}}}}
    answers = clef.map_answers(data, [choice(options=("А", "Б"))])
    probs = answers["q2"]["probabilities"]
    assert probs["А"] == pytest.approx(0.25)
    assert probs["Б"] == pytest.approx(0.75)
    assert answers["q2"]["choice"] == "Б"


def test_map_answers_choice_positional_fallback():
    data = {"answers": {"q2": {"probabilities": [0.2, 0.5, 0.3]}}}
    answers = clef.map_answers(data, [choice()])
    assert answers["q2"]["probabilities"] == {"А": 0.2, "Б": 0.5, "В": 0.3}
    assert answers["q2"]["choice"] == "Б"


def test_map_answers_choice_without_choice_field():
    data = {"answers": {"q2": {"probabilities": {"А": 0.1, "Б": 0.9}}}}
    answers = clef.map_answers(data, [choice(options=("А", "Б"))])
    assert answers["q2"]["choice"] == "Б"


def test_map_answers_missing_question_raises():
    with pytest.raises(KeyError):
        clef.map_answers({"answers": {}}, [yn()])


# ---------------------------------------------------------------- run()

@pytest.mark.asyncio
async def test_run_ok():
    res = await clef.run(make_entry(), make_request())
    assert res["ok"] is True
    assert res["answers"]["q2"]["choice"] == "Б"
    assert res["usage"]["input_tokens"] == 42
    metrics = res["metrics"]
    assert metrics["prompt_tokens"] == 42
    assert metrics["mode"] == "clef"
    assert metrics["label_mass_min"] is None
    assert metrics["label_mass_avg"] is None
    assert metrics["prefill_tok_s"] > 0
    call = FakeAsyncClient.calls[0]
    assert call["url"] == "http://127.0.0.1:30003/v1/systemone"
    assert call["json"]["questions"]["q1"]["type"] == "noul"


@pytest.mark.asyncio
async def test_run_not_running_no_post():
    FakeAsyncClient.get_error = True
    res = await clef.run(make_entry(), make_request())
    assert res["ok"] is False
    assert "запуст" in res["error"].lower()
    assert FakeAsyncClient.calls == []


@pytest.mark.asyncio
async def test_run_400_detail():
    FakeAsyncClient.post_response = FakeResponse(400, {"detail": "bad question"}, "")
    res = await clef.run(make_entry(), make_request())
    assert res["ok"] is False
    assert "bad question" in res["error"]


@pytest.mark.asyncio
async def test_run_413_context_too_long():
    FakeAsyncClient.post_response = FakeResponse(413, {"detail": "maximum context length"}, "")
    res = await clef.run(make_entry(), make_request())
    assert res["ok"] is False
    assert "16k" in res["error"]


@pytest.mark.asyncio
async def test_run_unavailable():
    FakeAsyncClient.post_error = True
    res = await clef.run(make_entry(), make_request())
    assert res["ok"] is False
    assert "недоступен" in res["error"]


@pytest.mark.asyncio
async def test_run_bad_answer_shape():
    FakeAsyncClient.post_response = FakeResponse(200, {"answers": {"q1": {"unexpected": 1}}})
    res = await clef.run(make_entry(), make_request())
    assert res["ok"] is False
    assert "разобрать" in res["error"]
