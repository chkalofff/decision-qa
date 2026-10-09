"""Unit-тесты backend приложения «Вердикт» v2. SGLang замокан — реальный сервер не нужен.

Live-smoke: RUN_LIVE=1 pytest -m live
"""

from __future__ import annotations

import json
import os
import re

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import model_manager as mm

client = TestClient(app_module.app)

MODEL_A = "qwen38-27b-4bit"
MODEL_B = "qwen35-35b-a3b-4bit"
CLEF_FLASH = "clef-flash-9b-4bit"
CLEF_27B = "clef-27b-4bit"
LAYA = "laya-04b-q8"
JEV = "jev-latest"
JEV_PREVIEW = "jev-preview"


# ---------------------------------------------------------------- helpers

def yn_question(qid="q1"):
    return {"id": qid, "question": "Да?", "type": "yes_no"}


def choice_question(qid="q2", options=("А", "Б", "В")):
    return {
        "id": qid,
        "question": "Выбор?",
        "type": "choice",
        "options": [{"name": n} for n in options],
    }


def score_question(qid="q3", levels=("низкий", "средний", "высокий")):
    return {"id": qid, "question": "Оценка?", "type": "score", "levels": list(levels)}


def good_body(models=None):
    return {
        "input": "Некоторый текст контекста.",
        "questions": [yn_question(), choice_question(), score_question()],
        "models": models if models is not None else [MODEL_A],
    }


FAKE_RESPONSE = {
    "object": "decisions",
    "model": "test-model",
    "prompt_format_version": 1,
    "answers": {
        "q1": {
            "type": "yes_no",
            "probabilities": {"yes": 0.7, "no": 0.3},
            "label_mass": 0.98,
        },
        "q2": {
            "type": "choice",
            "probabilities": {"А": 0.1, "Б": 0.8, "В": 0.1},
            "choice": "Б",
            "label_mass": 0.95,
        },
        "q3": {
            "type": "score",
            "probabilities": {"0": 0.2, "1": 0.5, "2": 0.3},
            "score": 1.1,
            "label_mass": 0.9,
        },
    },
    "usage": {"prompt_tokens": 42, "completion_tokens": 0},
}


SYSTEMONE_FAKE = {
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
    """Подмена httpx.AsyncClient: записывает запросы, возвращает заготовленные ответы."""

    calls: list[dict] = []
    post_response = FakeResponse(200, FAKE_RESPONSE)
    post_responses: dict[str, FakeResponse] = {}  # ключ — подстрока URL
    get_response = FakeResponse(200, {"data": [{"id": "test-model"}]})
    raise_on: str | None = None  # "post" | "get"

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, json=None, headers=None, **kwargs):
        if FakeAsyncClient.raise_on == "post":
            raise httpx.ConnectError("connection refused")
        FakeAsyncClient.calls.append({"url": url, "json": json, "headers": headers})
        for needle, resp in FakeAsyncClient.post_responses.items():
            if needle in url:
                return resp
        return FakeAsyncClient.post_response

    async def get(self, url, **kwargs):
        if FakeAsyncClient.raise_on == "get":
            raise httpx.ConnectError("connection refused")
        return FakeAsyncClient.get_response


@pytest.fixture(autouse=True)
def mock_sglang(monkeypatch, request, tmp_path):
    if request.node.get_closest_marker("live"):
        yield
        return
    FakeAsyncClient.calls = []
    FakeAsyncClient.post_response = FakeResponse(200, FAKE_RESPONSE)
    FakeAsyncClient.post_responses = {}
    FakeAsyncClient.get_response = FakeResponse(200, {"data": [{"id": "test-model"}]})
    FakeAsyncClient.raise_on = None
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    for entry in mm.REGISTRY.values():
        entry.proc = None
        entry.started_at = None
    monkeypatch.setattr(mm, "is_downloaded", lambda hf_id: False)
    monkeypatch.setattr(mm, "rss_gb", lambda port: None)
    # Креды и кэш проб — в изоляцию: тесты не зависят от реального credentials.json
    from backend import credentials as creds
    monkeypatch.setattr(creds, "CREDENTIALS_PATH", tmp_path / "credentials.json")
    mm._probe_cache.clear()
    yield


# ---------------------------------------------------------------- валидация

def test_empty_input_rejected():
    body = good_body()
    body["input"] = "   "
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422
    assert "input" in r.json()["detail"].lower() or "пуст" in r.json()["detail"].lower()


def test_empty_dict_input_rejected():
    body = good_body()
    body["input"] = {}
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422


def test_empty_list_input_rejected():
    body = good_body()
    body["input"] = []
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422


def test_dict_and_list_input_pass():
    for value in ({"dialog": [{"role": "agent", "text": "Привет"}]}, ["строка", {"a": 1}]):
        body = good_body()
        body["input"] = value
        r = client.post("/api/decide", json=body)
        assert r.status_code == 200
        assert FakeAsyncClient.calls[-1]["json"]["input"] == value


def test_zero_questions_rejected():
    body = good_body()
    body["questions"] = []
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422


def test_models_required():
    body = good_body()
    del body["models"]
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422


def test_empty_models_rejected():
    body = good_body(models=[])
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422


def test_unknown_model_key_rejected():
    body = good_body(models=[MODEL_A, "no-such-model"])
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422
    assert "no-such-model" in r.json()["detail"]


def test_duplicate_ids_rejected():
    body = good_body()
    body["questions"] = [yn_question("q1"), yn_question("q1")]
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422
    assert "уникальн" in r.json()["detail"].lower()


def test_choice_too_few_options():
    body = good_body()
    body["questions"] = [choice_question(options=("А",))]
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422


def test_choice_too_many_options():
    body = good_body()
    body["questions"] = [choice_question(options=[f"o{i}" for i in range(27)])]
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422


def test_choice_boundary_2_and_26_options():
    for n in (2, 26):
        body = good_body()
        body["questions"] = [choice_question(options=[f"o{i}" for i in range(n)])]
        r = client.post("/api/decide", json=body)
        assert r.status_code == 200, n


def test_score_too_few_levels():
    body = good_body()
    body["questions"] = [score_question(levels=("один",))]
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422


def test_score_too_many_levels():
    body = good_body()
    body["questions"] = [score_question(levels=[f"l{i}" for i in range(11)])]
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422


def test_score_boundary_2_and_10_levels():
    for n in (2, 10):
        body = good_body()
        body["questions"] = [score_question(levels=[f"l{i}" for i in range(n)])]
        r = client.post("/api/decide", json=body)
        assert r.status_code == 200, n


def test_empty_option_name_rejected():
    body = good_body()
    body["questions"] = [choice_question(options=("А", "  "))]
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422


def test_casefold_duplicate_option_names():
    body = good_body()
    body["questions"] = [choice_question(options=("Да", " ДА "))]
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422


# ---------------------------------------------------------------- маппинг

def test_payload_mapping_to_sglang():
    body = good_body()
    body["temperature"] = 0.5
    body["prompt_format_version"] = 2
    r = client.post("/api/decide", json=body)
    assert r.status_code == 200
    assert len(FakeAsyncClient.calls) == 1
    call = FakeAsyncClient.calls[0]
    assert call["url"] == "http://127.0.0.1:30001/v1/decisions"
    payload = call["json"]
    assert payload["input"] == body["input"]
    assert payload["temperature"] == 0.5
    assert payload["prompt_format_version"] == 2
    assert "models" not in payload
    assert [q["id"] for q in payload["questions"]] == ["q1", "q2", "q3"]
    assert payload["questions"][1]["type"] == "choice"
    assert payload["questions"][1]["options"] == [{"name": "А"}, {"name": "Б"}, {"name": "В"}]
    assert payload["questions"][2]["levels"] == ["низкий", "средний", "высокий"]


def test_no_optional_keys_when_omitted():
    r = client.post("/api/decide", json=good_body())
    assert r.status_code == 200
    payload = FakeAsyncClient.calls[0]["json"]
    assert "temperature" not in payload
    assert "prompt_format_version" not in payload
    assert "return_prompt_token_ids" not in payload


# ---------------------------------------------------------------- мультизапуск

def test_multi_model_both_ok():
    r = client.post("/api/decide", json=good_body(models=[MODEL_A, MODEL_B]))
    assert r.status_code == 200
    results = r.json()["results"]
    assert set(results) == {MODEL_A, MODEL_B}
    assert all(res["ok"] for res in results.values())
    urls = sorted(c["url"] for c in FakeAsyncClient.calls)
    assert urls == [
        "http://127.0.0.1:30001/v1/decisions",
        "http://127.0.0.1:30002/v1/decisions",
    ]


def test_multi_model_one_error():
    FakeAsyncClient.post_responses = {
        ":30002": FakeResponse(400, {"detail": "bad question format"}),
    }
    r = client.post("/api/decide", json=good_body(models=[MODEL_A, MODEL_B]))
    assert r.status_code == 200
    results = r.json()["results"]
    assert results[MODEL_A]["ok"] is True
    assert results[MODEL_B]["ok"] is False
    assert "bad question format" in results[MODEL_B]["error"]


def test_model_not_running_gives_ok_false():
    FakeAsyncClient.raise_on = "get"  # порт не отвечает → модель не running
    r = client.post("/api/decide", json=good_body(models=[MODEL_A]))
    assert r.status_code == 200
    res = r.json()["results"][MODEL_A]
    assert res["ok"] is False
    assert "start" in res["error"] or "запуст" in res["error"].lower()
    assert FakeAsyncClient.calls == []


# ---------------------------------------------------------------- clef-диспетчеризация

def test_mixed_dispatch_decisions():
    FakeAsyncClient.post_responses = {":30003": FakeResponse(200, SYSTEMONE_FAKE)}
    r = client.post("/api/decide", json=good_body(models=[MODEL_A, CLEF_FLASH]))
    assert r.status_code == 200
    results = r.json()["results"]
    assert results[MODEL_A]["ok"] is True
    assert results[CLEF_FLASH]["ok"] is True
    assert results[CLEF_FLASH]["metrics"]["mode"] == "clef"
    urls = sorted(c["url"] for c in FakeAsyncClient.calls)
    assert urls == [
        "http://127.0.0.1:30001/v1/decisions",
        "http://127.0.0.1:30003/v1/systemone",
    ]


def test_clef_ignores_fast_batch_mode():
    # В режиме fast_batch clef-модель всё равно идёт на /v1/systemone
    FakeAsyncClient.post_responses = {":30003": FakeResponse(200, SYSTEMONE_FAKE)}
    body = good_body(models=[CLEF_FLASH])
    body["mode"] = "fast_batch"
    r = client.post("/api/decide", json=body)
    assert r.status_code == 200
    res = r.json()["results"][CLEF_FLASH]
    assert res["ok"] is True
    assert res["metrics"]["mode"] == "clef"
    assert FakeAsyncClient.calls[0]["url"] == "http://127.0.0.1:30003/v1/systemone"


def test_start_blocked_by_memory_budget(monkeypatch):
    async def fake_port_running(port):
        return port != 30004  # clef-27b ещё не запущена, остальные — running

    def boom(*args, **kwargs):
        raise AssertionError("Popen не должен вызываться при превышении бюджета")

    monkeypatch.setattr(mm, "port_running", fake_port_running)
    monkeypatch.setattr(mm.subprocess, "Popen", boom)
    r = client.post(f"/api/models/{CLEF_27B}/start")
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert "памят" in detail.lower()
    assert CLEF_27B in detail


# ---------------------------------------------------------------- ошибки SGLang

def test_sglang_400_as_error_slot():
    FakeAsyncClient.post_response = FakeResponse(400, {"detail": "bad question format"}, "")
    r = client.post("/api/decide", json=good_body())
    assert r.status_code == 200
    res = r.json()["results"][MODEL_A]
    assert res["ok"] is False
    assert "bad question format" in res["error"]


def test_sglang_unavailable_as_error_slot():
    FakeAsyncClient.raise_on = "post"  # get (health-probe) работает, post падает
    r = client.post("/api/decide", json=good_body())
    assert r.status_code == 200
    res = r.json()["results"][MODEL_A]
    assert res["ok"] is False
    assert "недоступен" in res["error"]


# ---------------------------------------------------------------- разбор ответа

def test_response_shape_and_metrics():
    r = client.post("/api/decide", json=good_body())
    assert r.status_code == 200
    res = r.json()["results"][MODEL_A]
    assert res["ok"] is True
    assert res["answers"]["q1"]["probabilities"] == {"yes": 0.7, "no": 0.3}
    assert res["answers"]["q2"]["choice"] == "Б"
    assert res["answers"]["q3"]["score"] == 1.1
    assert res["usage"]["prompt_tokens"] == 42
    assert res["prompt_format_version"] == 1
    metrics = res["metrics"]
    assert metrics["prompt_tokens"] == 42
    assert metrics["duration_s"] >= 0
    assert metrics["prefill_tok_s"] > 0
    assert metrics["label_mass_min"] == 0.9
    assert metrics["label_mass_avg"] == round((0.98 + 0.95 + 0.9) / 3, 4)
    assert "rss_gb" in metrics


# ---------------------------------------------------------------- models api

def test_models_list_shape():
    r = client.get("/api/models")
    assert r.status_code == 200
    data = r.json()
    assert data["device"]["ram_gb"] > 0
    assert data["device"]["budget_gb"] > 0
    models = data["models"]
    assert len(models) == 11
    by_key = {m["key"]: m for m in models}
    bonsai = by_key["bonsai2-27b"]
    assert bonsai["type"] == "bonsai" and bonsai["port"] == 30006
    assert bonsai["roles"] == ["chat"] and bonsai["enabled"] is True
    assert bonsai["vision"] is True
    assert by_key[MODEL_A]["port"] == 30001
    assert by_key[MODEL_A]["type"] == "sglang"
    assert by_key[MODEL_A]["status"] == "running"  # фейковый health-probe отвечает 200
    assert by_key[MODEL_B]["hf_id"] == "mlx-community/Qwen3.5-35B-A3B-4bit"
    assert by_key[CLEF_FLASH]["type"] == "clef"
    assert by_key[CLEF_27B]["type"] == "clef"
    assert by_key[LAYA]["type"] == "llamacpp"
    assert by_key[LAYA]["gguf_file"] == "Laya-Q8_0.gguf"
    # облачные Jev-модели
    jev = by_key[JEV]
    assert jev["type"] == "remote" and jev["managed"] is False
    assert jev["api"] == "systemone"
    assert jev["base_url"] == "https://api.typesafe.ai"
    assert jev["api_model"] == "jev-latest"
    assert jev["vision"] is False
    assert jev["peak_gb"] is None and jev["download_gb"] is None  # у remote не отдаём
    assert jev["has_credentials"] is False  # фикстура изолирует credentials.json
    assert jev["status"] == "no_credentials"
    assert by_key[JEV_PREVIEW]["enabled"] is False
    assert "apikey" not in json.dumps(data)  # ключ наружу не утекает


def test_health_reports_models():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"models": {MODEL_A: "running", MODEL_B: "running",
                                   CLEF_FLASH: "running", CLEF_27B: "running",
                                   "bonsai2-27b": "running", LAYA: "running",
                                   JEV: "no_credentials", JEV_PREVIEW: "no_credentials",
                                   "remote-qwen3-8-27b-openrouter": "no_credentials",
                                   "remote-deepseek-v4-1-flash-openrouter": "no_credentials",
                                   "remote-qwen3-8-flash-openrouter": "no_credentials"}}


def test_version_endpoint():
    r = client.get("/api/version")
    assert r.status_code == 200
    expected = (app_module.VERSION_FILE.read_text(encoding="utf-8").strip()
                if app_module.VERSION_FILE.exists() else "dev")
    assert r.json() == {"version": expected}


# ---------------------------------------------------------------- менеджер моделей (API)

def test_patch_model_label_and_enabled(monkeypatch, tmp_path):
    monkeypatch.setattr(mm, "CONFIG_PATH", tmp_path / "models_config.json")
    entry = mm.REGISTRY[MODEL_A]
    old_label, old_enabled = entry.label, entry.enabled
    try:
        r = client.patch(f"/api/models/{MODEL_A}", json={"label": "Новое имя", "enabled": False})
        assert r.status_code == 200
        assert r.json()["label"] == "Новое имя"
        assert r.json()["enabled"] is False
        saved = json.loads((tmp_path / "models_config.json").read_text(encoding="utf-8"))
        assert next(c for c in saved if c["key"] == MODEL_A)["label"] == "Новое имя"

        # отключённая модель не участвует в decide
        r = client.post("/api/decide", json={**good_body(), "mode": "decisions"})
        assert r.status_code == 422
        assert "отключены" in r.json()["detail"]
    finally:
        entry.label, entry.enabled = old_label, old_enabled


def test_patch_model_unknown_field():
    r = client.patch(f"/api/models/{MODEL_A}", json={"port": 9999})
    assert r.status_code == 422
    assert "port" in r.json()["detail"]


def test_remote_model_crud_via_api(monkeypatch, tmp_path):
    from backend import credentials as creds

    monkeypatch.setattr(mm, "CONFIG_PATH", tmp_path / "models_config.json")
    monkeypatch.setattr(creds, "CREDENTIALS_PATH", tmp_path / "credentials.json")
    created_key = None
    try:
        r = client.post("/api/models", json={
            "label": "Облачная Clef", "base_url": "https://api.example.com/",
            "api": "systemone", "api_model": "clef-flash", "api_key": "sk-9",
        })
        assert r.status_code == 200, r.text
        data = r.json()
        created_key = data["key"]
        assert data["managed"] is False
        assert data["has_credentials"] is True
        assert "sk-9" not in r.text  # ключ наружу не возвращается

        # decide к облачной модели уходит на её base_url с Authorization
        r = client.post("/api/decide", json={
            "input": "Текст.", "models": [created_key],
            "questions": [yn_question()], "mode": "decisions",
        })
        assert r.status_code == 200
        call = next(c for c in FakeAsyncClient.calls if "systemone" in c["url"])
        assert call["url"].startswith("https://api.example.com/")
        assert call["json"]["model"] == "clef-flash"

        # локальную модель удалить из реестра нельзя
        r = client.delete(f"/api/models/{MODEL_A}")
        assert r.status_code == 422

        r = client.delete(f"/api/models/{created_key}")
        assert r.status_code == 200
        assert creds.get(created_key) is None
    finally:
        if created_key:
            mm.REGISTRY.pop(created_key, None)


def test_credentials_endpoints(monkeypatch, tmp_path):
    from backend import credentials as creds

    monkeypatch.setattr(mm, "CONFIG_PATH", tmp_path / "models_config.json")
    monkeypatch.setattr(creds, "CREDENTIALS_PATH", tmp_path / "credentials.json")
    key = None
    try:
        r = client.post("/api/models", json={
            "label": "Tmp", "base_url": "http://x", "api": "decisions"})
        key = r.json()["key"]

        r = client.put(f"/api/models/{key}/credentials", json={"api_key": "  "})
        assert r.status_code == 422
        r = client.put(f"/api/models/{key}/credentials", json={"api_key": "abc"})
        assert r.json() == {"key": key, "has_credentials": True}
        r = client.delete(f"/api/models/{key}/credentials")
        assert r.json() == {"key": key, "has_credentials": False}

        # локальной модели креды не нужны
        r = client.put(f"/api/models/{MODEL_A}/credentials", json={"api_key": "abc"})
        assert r.status_code == 422
    finally:
        if key:
            mm.REGISTRY.pop(key, None)


# ---------------------------------------------------------------- remote: decide

def test_remote_decide_ok_sends_auth_and_model():
    """jev-latest: запрос уходит на typesafe с Bearer-ключом и api_model в payload."""
    from backend import credentials as creds

    creds.save(JEV, "sk-jev-test")
    FakeAsyncClient.post_responses = {"typesafe": FakeResponse(200, SYSTEMONE_FAKE)}
    r = client.post("/api/decide", json=good_body(models=[JEV]))
    assert r.status_code == 200
    res = r.json()["results"][JEV]
    assert res["ok"] is True, res
    call = FakeAsyncClient.calls[-1]
    assert call["url"] == "https://api.typesafe.ai/v1/systemone"
    assert call["headers"] == {"Authorization": "Bearer sk-jev-test"}
    assert call["json"]["model"] == "jev-latest"
    assert res["metrics"]["mode"] == "systemone"


def test_remote_decide_without_key_clear_error():
    """Без API-ключа — понятная ошибка в слоте результата, запрос наружу не уходит."""
    r = client.post("/api/decide", json=good_body(models=[JEV]))
    assert r.status_code == 200
    res = r.json()["results"][JEV]
    assert res["ok"] is False
    assert "no_credentials" in res["error"]
    assert "API-ключ" in res["error"]
    assert FakeAsyncClient.calls == []


def test_remote_credentials_roundtrip_for_config_entry():
    """PUT/DELETE credentials работают и для remote-записи из конфига (jev-preview)."""
    r = client.put(f"/api/models/{JEV_PREVIEW}/credentials", json={"api_key": "sk-x"})
    assert r.status_code == 200
    assert r.json() == {"key": JEV_PREVIEW, "has_credentials": True}
    # проба сброшена → статус стал running (фейковый probe 200)
    r = client.get("/api/models")
    assert {m["key"]: m for m in r.json()["models"]}[JEV_PREVIEW]["status"] == "running"
    r = client.delete(f"/api/models/{JEV_PREVIEW}/credentials")
    assert r.json() == {"key": JEV_PREVIEW, "has_credentials": False}
    r = client.get("/api/models")
    assert {m["key"]: m for m in r.json()["models"]}[JEV_PREVIEW]["status"] == "no_credentials"


def test_download_endpoint_no_hf_cli(monkeypatch):
    monkeypatch.setattr(mm, "_find_hf_cli", lambda: None)
    r = client.post(f"/api/models/{MODEL_A}/download")
    assert r.status_code == 500
    assert "hf" in r.json()["detail"]


# ---------------------------------------------------------------- изображения

IMG_PNG = ("data:image/png;base64,"
           "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def test_images_ok_clef_payload():
    FakeAsyncClient.post_responses = {":30003": FakeResponse(200, SYSTEMONE_FAKE)}
    body = good_body(models=[CLEF_FLASH])
    body["images"] = [IMG_PNG]
    r = client.post("/api/decide", json=body)
    assert r.status_code == 200
    call = next(c for c in FakeAsyncClient.calls if "systemone" in c["url"])
    assert call["json"]["images"] == [IMG_PNG]
    assert call["json"]["state"] == body["input"]


def test_images_empty_input_ok():
    FakeAsyncClient.post_responses = {":30003": FakeResponse(200, SYSTEMONE_FAKE)}
    body = good_body(models=[CLEF_FLASH])
    body["input"] = ""
    body["images"] = [IMG_PNG]
    r = client.post("/api/decide", json=body)
    assert r.status_code == 200
    assert r.json()["results"][CLEF_FLASH]["ok"] is True


def test_images_raw_base64_ok():
    FakeAsyncClient.post_responses = {":30003": FakeResponse(200, SYSTEMONE_FAKE)}
    body = good_body(models=[CLEF_FLASH])
    body["images"] = [IMG_PNG.split(",", 1)[1]]  # чистый base64 без data URL
    r = client.post("/api/decide", json=body)
    assert r.status_code == 200


def test_images_too_many():
    body = good_body(models=[CLEF_FLASH])
    body["images"] = [IMG_PNG] * 9
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422
    assert "8" in r.json()["detail"]


def test_images_invalid_format():
    body = good_body(models=[CLEF_FLASH])
    body["images"] = ["это не base64!!!"]
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422
    assert "base64" in r.json()["detail"]


def test_images_heic_422_with_clear_message():
    body = good_body(models=[CLEF_FLASH])
    heic_b64 = "AAAAGGZ0eXBoZWljAAAAAA"  # валидный base64, но mime heic
    body["images"] = [f"data:image/heic;base64,{heic_b64}"]
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422
    assert "Неподдерживаемый формат" in r.json()["detail"]
    assert "HEIC" in r.json()["detail"]


def test_images_total_size_limit():
    body = good_body(models=[CLEF_FLASH])
    body["images"] = ["A" * (21 * 1024 * 1024)]  # валидный base64, но > 20 МБ
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422
    assert "20" in r.json()["detail"]


def test_images_non_vision_model_422():
    body = good_body(models=[MODEL_A])
    body["images"] = [IMG_PNG]
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422
    assert MODEL_A in r.json()["detail"]
    assert "изображени" in r.json()["detail"]
    assert FakeAsyncClient.calls == []  # до диспетчеризации не дошло


def test_images_fast_batch_422():
    body = good_body(models=[CLEF_FLASH])
    body["images"] = [IMG_PNG]
    body["mode"] = "fast_batch"
    r = client.post("/api/decide", json=body)
    assert r.status_code == 422
    assert "Быстрый режим" in r.json()["detail"]


def test_vision_flags_in_models_api():
    r = client.get("/api/models")
    assert r.status_code == 200
    by_key = {m["key"]: m for m in r.json()["models"]}
    assert by_key[CLEF_FLASH]["vision"] is True
    assert by_key[CLEF_27B]["vision"] is True
    assert by_key[MODEL_A]["vision"] is False
    assert by_key[MODEL_B]["vision"] is False
    assert by_key[LAYA]["vision"] is False


# ---------------------------------------------------------------- presets

def test_presets_valid():
    from backend.schemas import DecideRequest

    r = client.get("/api/presets")
    assert r.status_code == 200
    presets = r.json()
    assert len(presets) == 8
    names = {p["name"] for p in presets}
    assert names == {
        "Скрининг резюме",
        "QA диалога поддержки",
        "Анализ отзывов о товаре",
        "Модерация контента",
        "UGC-модерация поста",
        "Модерация фото товаров",
        "Возвраты: претензии с фото",
    }
    # одиночный и батч-пресеты скрининга намеренно с одним именем —
    # батч отличается бейджем «батч» в меню, дубля «— батч» в имени нет
    assert sum(p["name"] == "Скрининг резюме" for p in presets) == 2
    for p in presets:
        if p.get("page") == "batch":
            continue  # у батч-пресета нет input — своя схема, см. test_batch_preset_valid
        req = DecideRequest.model_validate({**p, "models": [CLEF_FLASH]})
        if p["name"] == "UGC-модерация поста":
            assert req.images and all(i.startswith("data:image/") for i in req.images)


def test_batch_preset_valid():
    from pathlib import Path

    from backend.schemas import Question

    r = client.get("/api/presets")
    assert r.status_code == 200
    batch = [p for p in r.json() if p.get("page") == "batch"]
    assert len(batch) == 3
    by_name = {}
    for p in batch:
        by_name.setdefault(p["name"], []).append(p)
    # без дубля «— батч»: бейдж есть в меню
    assert len(by_name["Скрининг резюме"]) == 1 and len(by_name["Скрининг резюме"][0]["files"]) == 10
    assert len(by_name["Модерация фото товаров"]) == 1
    assert len(by_name["Возвраты: претензии с фото"]) == 1
    returns = by_name["Возвраты: претензии с фото"][0]
    assert len(returns["files"]) == 5
    photo = by_name["Модерация фото товаров"][0]
    assert len(photo["files"]) == 10  # 5 синтетических PNG + 5 реальных JPEG
    for p in batch:
        assert p["description"]
        names = set()
        for f in p["files"]:
            assert f["name"].strip()
            assert f["name"] not in names, f"дубль имени файла: {f['name']}"
            names.add(f["name"])
            content = f.get("content")
            image = f.get("image") or f.get("dataUrl")
            assert bool(content) != bool(image), f"{f['name']}: content ИЛИ image, ровно одно"
            if content:
                # content-требования — только для текстовых файлов
                assert content.strip()
                assert len(content) >= 1000, f"слишком короткий текст: {f['name']}"
            else:
                assert image.startswith("data:image/"), f"image не data URL: {f['name']}"
        # фото-пресет: вопрос defect заменён decision-правилами → минимум 4 вопроса
        assert 4 <= len(p["questions"]) <= 12
        ids = set()
        for q in p["questions"]:
            Question.model_validate(q)
            assert q["id"] not in ids, f"дубль id вопроса: {q['id']}"
            ids.add(q["id"])
        # опции choice — на русском (кириллица в имени)
        for q in p["questions"]:
            if q["type"] == "choice":
                for o in q["options"]:
                    assert re.search(r"[а-яА-Я]", o["name"]), f"опция не на русском: {o['name']}"
    # фото-пресет: ровно 5 PNG (синтетика) + 5 JPEG (реальные фото), общий размер < 3 МБ
    assert all(f.get("image") for f in photo["files"]), "фото-пресет должен содержать только image-файлы"
    prefixes = [f["image"].split(";")[0] for f in photo["files"]]
    assert prefixes.count("data:image/png") == 5
    assert prefixes.count("data:image/jpeg") == 5
    preset_path = Path(__file__).resolve().parents[1] / "presets" / "batch_photo_moderation.json"
    assert preset_path.stat().st_size < 3 * 1024 * 1024, "пресет раздулся > 3 МБ"
    # возвраты: к текстовым файлам прикреплено 0–3 JPEG, суммарно 9
    assert [len(f.get("images") or []) for f in returns["files"]] == [3, 1, 0, 2, 3]
    for f in returns["files"]:
        for img in f.get("images") or []:
            assert img.startswith("data:image/jpeg;base64,"), f"{f['name']}: image не JPEG data URL"
    returns_path = Path(__file__).resolve().parents[1] / "presets" / "batch_returns_claims.json"
    assert returns_path.stat().st_size < 2 * 1024 * 1024, "пресет раздулся > 2 МБ"


# ---------------------------------------------------------------- статика: кэш

def test_static_no_cache_header():
    # no-cache ≠ «без кэша»: etag остаётся, браузер ревалидирует и получает 304,
    # но никогда не исполняет устаревший JS/CSS после деплоя.
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers["Cache-Control"] == "no-cache"
    assert r.headers.get("ETag"), "etag должен остаться для ревалидации"
    for path in ("/app.js", "/style.css"):
        r = client.get(path)
        assert r.status_code == 200, path
        assert r.headers["Cache-Control"] == "no-cache", path
    # API не трогаем
    assert "Cache-Control" not in client.get("/api/presets").headers


# ---------------------------------------------------------------- настройки (бюджет памяти)

from backend import settings as app_settings


@pytest.fixture
def isolated_settings(monkeypatch, tmp_path):
    """settings.json — во временный файл; BUDGET_FRACTION/BUDGET_GB — откат после теста."""
    monkeypatch.setattr(app_settings, "SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr(mm, "BUDGET_FRACTION", mm.BUDGET_FRACTION)
    monkeypatch.setattr(mm, "BUDGET_GB", mm.BUDGET_GB)
    yield tmp_path / "settings.json"


def test_get_settings_shape(isolated_settings):
    r = client.get("/api/settings")
    assert r.status_code == 200
    data = r.json()
    assert set(data) == {"budget_fraction", "budget_gb", "total_ram_gb"}
    assert 0 < data["budget_fraction"] <= 1
    assert data["budget_gb"] == round(mm.BUDGET_GB, 1)
    assert data["total_ram_gb"] == round(mm.TOTAL_RAM_GB, 1)
    assert abs(data["budget_gb"] - data["budget_fraction"] * data["total_ram_gb"]) < 0.15


def test_put_budget_updates_and_persists(isolated_settings):
    r = client.put("/api/settings/budget", json={"fraction": 0.8})
    assert r.status_code == 200
    data = r.json()
    assert data["budget_fraction"] == 0.8
    assert mm.BUDGET_FRACTION == 0.8
    assert mm.BUDGET_GB == 0.8 * mm.TOTAL_RAM_GB
    assert data["budget_gb"] == round(mm.BUDGET_GB, 1)
    saved = json.loads(isolated_settings.read_text(encoding="utf-8"))
    assert saved["budget_fraction"] == 0.8
    # /api/models отдаёт актуальный budget_gb
    r = client.get("/api/models")
    assert r.json()["device"]["budget_gb"] == round(mm.BUDGET_GB, 1)


def test_put_budget_out_of_range_422(isolated_settings):
    for bad in (0.2, 1.5):
        r = client.put("/api/settings/budget", json={"fraction": bad})
        assert r.status_code == 422, bad
        assert "диапазоне" in r.json()["detail"]
    assert not isolated_settings.exists()  # невалидные значения не персистятся


def test_put_budget_non_numeric_422(isolated_settings):
    r = client.put("/api/settings/budget", json={"fraction": "много"})
    assert r.status_code == 422


def test_settings_persist_across_load(isolated_settings):
    client.put("/api/settings/budget", json={"fraction": 0.75})
    assert app_settings.load_budget_fraction() == 0.75  # перечитано из файла


def test_settings_priority_file_over_env_over_default(isolated_settings, monkeypatch):
    # дефолт без файла и env
    monkeypatch.delenv("MODELS_BUDGET_FRACTION", raising=False)
    assert app_settings.load_budget_fraction() == 0.65
    # env > дефолт
    monkeypatch.setenv("MODELS_BUDGET_FRACTION", "0.5")
    assert app_settings.load_budget_fraction() == 0.5
    # файл > env
    isolated_settings.write_text('{"budget_fraction": 0.7}\n', encoding="utf-8")
    assert app_settings.load_budget_fraction() == 0.7


def test_budget_check_honours_new_budget(isolated_settings, monkeypatch):
    """После PUT маленькой доли запуск модели, не влезающей в бюджет, → 409."""
    monkeypatch.setattr(mm, "TOTAL_RAM_GB", 64.0)
    FakeAsyncClient.raise_on = "get"  # все порты мертвы — модель не запущена
    r = client.put("/api/settings/budget", json={"fraction": 0.3})
    assert r.status_code == 200 and mm.BUDGET_GB == 0.3 * 64.0  # 19.2 ГБ
    r = client.post(f"/api/models/{CLEF_27B}/start")  # пик ~20 ГБ > 19.2 ГБ
    assert r.status_code == 409
    assert "не влезает" in r.json()["detail"]


# ---------------------------------------------------------------- live smoke

@pytest.mark.live
@pytest.mark.skipif(not os.environ.get("RUN_LIVE"), reason="запускается только с RUN_LIVE=1")
def test_live_smoke():
    real_client = TestClient(app_module.app)
    body = {
        "input": "Иван любит чай больше, чем кофе. Он врач.",
        "questions": [
            {"id": "q1", "question": "Иван любит чай?", "type": "yes_no"},
            {"id": "q2", "question": "Что предпочитает Иван?", "type": "choice",
             "options": [{"name": "чай"}, {"name": "кофе"}, {"name": "вода"}]},
            {"id": "q3", "question": "Насколько Иван любит чай?", "type": "score",
             "levels": ["совсем не любит", "нейтрально", "очень любит"]},
        ],
        "models": [MODEL_A, MODEL_B, CLEF_FLASH, CLEF_27B],
    }
    r = real_client.post("/api/decide", json=body, timeout=None)
    assert r.status_code == 200, r.text
    results = r.json()["results"]
    assert set(results) == {MODEL_A, MODEL_B, CLEF_FLASH, CLEF_27B}
    checked = 0
    for res in results.values():
        if not res["ok"]:
            continue  # незапущенная модель допустима
        checked += 1
        a1, a2, a3 = res["answers"]["q1"], res["answers"]["q2"], res["answers"]["q3"]
        assert abs(sum(a1["probabilities"].values()) - 1) < 1e-3
        assert abs(sum(a2["probabilities"].values()) - 1) < 1e-3
        assert abs(sum(a3["probabilities"].values()) - 1) < 1e-3
        assert a2["choice"] in {"чай", "кофе", "вода"}
        assert 0 <= a3["score"] <= 2
    assert checked >= 1, "ни одна модель не запущена"
