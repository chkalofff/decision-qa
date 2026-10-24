"""Controlled async contract tests for the reusable server run engine."""

from __future__ import annotations

import asyncio
import json

import pytest

from backend import app as app_module
from backend import decide_service
from backend import model_manager as mm
from backend import run_engine
from backend.run_engine import RunEngine, RunEngineError
from backend.schemas import DecideRequest


def entry(key, *, api="decisions", type="sglang", vision=False, enabled=True, roles=None,
          base_url=None, api_model=None):
    return mm.ModelEntry(
        key, key, f"org/{key}", 30000, type=type, api=api, vision=vision,
        enabled=enabled, roles=roles, base_url=base_url, api_model=api_model,
    )


def registry(*entries):
    return {item.key: item for item in entries}


def config(models, *, mode="decisions", enabled=True, prompt_formats=None):
    settings = {"models": list(models), "mode": mode, "aggregation": "mean_probability_v1"}
    if prompt_formats is not None:
        settings["prompt_formats"] = prompt_formats
    return {
        "version": 1,
        "fingerprint_version": 1,
        "questions": [{"id": "q1", "question": "Да?", "type": "yes_no"}],
        "decision": {
            "enabled": enabled,
            "outcomes": [{
                "id": "yes", "label": "Да", "color": "green",
                "rules": [{"conditions": [{
                    "question": "q1", "answer": "yes", "op": "gte", "threshold": 0.5,
                }]}],
            }],
        },
        "settings": settings,
    }


def answers(probability=0.8):
    return {"q1": {"type": "yes_no", "probabilities": {
        "yes": probability, "no": 1 - probability,
    }}}


def ok(probability=0.8, **extra):
    return {
        "ok": True, "answers": answers(probability), "usage": {"prompt_tokens": 3},
        "metrics": {"duration_s": 0.1}, **extra,
    }


def running_status(monkeypatch, statuses=None):
    calls = []

    async def fake_status(item):
        calls.append(item.key)
        return {"status": (statuses or {}).get(item.key, "running")}

    monkeypatch.setattr(run_engine.mm, "model_status", fake_status)
    return calls


@pytest.mark.asyncio
async def test_legacy_decide_service_and_app_adapter_are_equivalent(monkeypatch):
    item = entry("native")
    monkeypatch.setitem(mm.REGISTRY, "native", item)
    try:
        async def status(_):
            return {"status": "running"}

        health_checks = []

        async def native(model, payload, *, check_status=True):
            health_checks.append(check_status)
            return ok(prompt_format_version=2)

        monkeypatch.setattr(decide_service.mm, "model_status", status)
        monkeypatch.setattr(decide_service, "decide_one", native)
        req = DecideRequest(input="Текст", questions=config(["native"])["questions"], models=["native"])
        direct_status, direct = await decide_service.run_decide(req)
        adapted = await app_module.decide(req)
        assert direct_status == 200
        assert adapted == direct
        canonical = await RunEngine(config(["native"]), registry=registry(item)).run_material({"input": "Текст"})
        run = canonical["runs"][0]
        assert {key: run[key] for key in direct["results"]["native"]} == direct["results"]["native"]
        assert run["decision"]["outcomeId"] == "yes"
        assert health_checks == [True, True, False]
        req_unknown = DecideRequest(input="Текст", questions=req.questions, models=["missing"])
        legacy = await app_module.decide(req_unknown)
        assert legacy.status_code == 422
        assert json.loads(legacy.body) == {"detail": "Неизвестные модели: missing"}
    finally:
        mm.REGISTRY.pop("native", None)


@pytest.mark.asyncio
async def test_protocol_matrix_and_single_job_preflight(monkeypatch):
    items = registry(
        entry("native"), entry("clef", api="systemone", type="clef"),
        entry("jev", api="systemone", type="remote", base_url="https://jev.example"),
        entry("laya", api="systemone", type="llamacpp"),
        entry("chat", api="openrouter", type="remote", api_model="chat-model"),
    )
    probes = running_status(monkeypatch)
    calls = []

    async def native(model, payload, *, check_status=True):
        calls.append(("native", model.key, check_status))
        return ok(prompt_format_version=1)

    async def systemone(model, req, *, check_status=True):
        calls.append((model.key, model.key, check_status))
        return ok()

    async def chat(model, req, *, check_status=True):
        calls.append(("chat", model.key, check_status))
        return ok()

    monkeypatch.setattr(run_engine.decide_service, "decide_one", native)
    monkeypatch.setattr(run_engine.clef, "run", systemone)
    monkeypatch.setattr(run_engine.remote_llm, "run_decide", chat)
    engine = RunEngine(config(list(items)), registry=items)
    first = await engine.run_material({"input": "one", "name": "a.txt", "path": "client/a.txt"})
    second = await engine.run_material({"input": "two"})
    assert probes == list(items)
    assert len(calls) == 10
    assert {call[0] for call in calls} == set(items)
    assert all(call[2] is False for call in calls)
    assert first["material"] == {"name": "a.txt", "path": "client/a.txt"}
    assert [run["model"] for run in first["runs"]] == list(items)
    assert all(run["mode"] == "decisions" and run["decision"]["outcomeId"] == "yes"
               for run in first["runs"] + second["runs"])


@pytest.mark.asyncio
async def test_partial_exception_and_cancelled_error_propagation(monkeypatch):
    items = registry(entry("bad"), entry("good", api="systemone", type="clef"))
    running_status(monkeypatch)

    async def native(model, payload, *, check_status=True):
        raise RuntimeError("unexpected boom")

    async def systemone(model, req, *, check_status=True):
        if model.key == "good":
            return ok()
        raise AssertionError("unexpected model")

    monkeypatch.setattr(run_engine.decide_service, "decide_one", native)
    monkeypatch.setattr(run_engine.clef, "run", systemone)
    result = await RunEngine(config(list(items)), registry=items).run_material({"input": "x"})
    assert result["runs"][0]["ok"] is False
    assert result["runs"][0]["error"] == "unexpected boom"
    assert result["runs"][1]["ok"] is True

    async def cancelled(model, req, *, check_status=True):
        raise asyncio.CancelledError()

    monkeypatch.setattr(run_engine.clef, "run", cancelled)
    engine = RunEngine(config(["good"]), registry=items)
    with pytest.raises(asyncio.CancelledError):
        await engine.run_material({"input": "x"})


@pytest.mark.asyncio
async def test_both_orders_passes_and_never_duplicates_systemone_or_chat(monkeypatch):
    items = registry(
        entry("native"), entry("system", api="systemone", type="clef"),
        entry("chat", api="openrouter", type="remote", api_model="chat-model"),
    )
    running_status(monkeypatch)
    events = []

    async def native(model, payload, *, check_status=True):
        events.append("native:decisions")
        return ok(0.2, prompt_format_version=1)

    async def system(model, req, *, check_status=True):
        events.append(f"{model.key}:decisions")
        return ok(0.8)

    async def fast(model, questions, input_data, *, check_status=True):
        events.append("native:fast_batch")
        return ok(1.0)

    monkeypatch.setattr(run_engine.decide_service, "decide_one", native)
    monkeypatch.setattr(run_engine.clef, "run", system)
    monkeypatch.setattr(run_engine.remote_llm, "run_decide", system)
    monkeypatch.setattr(run_engine.fast_batch, "run", fast)
    engine = RunEngine(config(list(items), mode="both"), registry=items)
    result = await engine.run_material({"input": "x"})
    assert events == [
        "native:decisions", "system:decisions", "chat:decisions", "native:fast_batch",
    ]
    assert [(run["model"], run["mode"]) for run in result["runs"]] == [
        ("native", "decisions"), ("system", "decisions"), ("chat", "decisions"),
        ("native", "fast_batch"),
    ]
    aggregate = engine.aggregate(result["runs"])
    assert aggregate["answers"]["q1"]["probabilities"]["yes"] == pytest.approx(0.6)
    assert aggregate["answers"]["q1"]["by_model"] == {
        "native": {"yes": 0.2, "no": 0.8},
        "system": {"yes": 0.8, "no": pytest.approx(0.2)},
        "chat": {"yes": 0.8, "no": pytest.approx(0.2)},
    }


@pytest.mark.asyncio
async def test_fast_only_uses_native_fast_and_single_ordinary_passes(monkeypatch):
    items = registry(
        entry("native"), entry("system", api="systemone", type="clef"),
        entry("chat", api="openrouter", type="remote", api_model="chat-model"),
    )
    running_status(monkeypatch)
    events = []

    async def fast(model, questions, input_data, *, check_status=True):
        events.append("fast")
        return ok(0.9)

    async def ordinary(model, req, *, check_status=True):
        events.append(model.key)
        return ok(0.3 if model.key == "system" else 0.6)

    async def unexpected_native(*args, **kwargs):
        raise AssertionError("native decisions must not run in fast-only mode")

    monkeypatch.setattr(run_engine.fast_batch, "run", fast)
    monkeypatch.setattr(run_engine.clef, "run", ordinary)
    monkeypatch.setattr(run_engine.remote_llm, "run_decide", ordinary)
    monkeypatch.setattr(run_engine.decide_service, "decide_one", unexpected_native)
    engine = RunEngine(config(list(items), mode="fast_batch"), registry=items)
    result = await engine.run_material({"input": "x"})
    assert sorted(events) == ["chat", "fast", "system"]
    assert [(run["model"], run["mode"]) for run in result["runs"]] == [
        ("native", "fast_batch"), ("system", "decisions"), ("chat", "decisions"),
    ]
    aggregate = engine.aggregate(result["runs"])
    assert aggregate["answers"]["q1"]["probabilities"]["yes"] == pytest.approx(0.6)
    assert aggregate["decision"]["outcomeId"] == "yes"
    assert set(aggregate["answers"]["q1"]["by_model"]) == set(items)


@pytest.mark.asyncio
async def test_images_placeholder_order_skip_and_no_vision_error(monkeypatch):
    items = registry(entry("text"), entry("vision", api="systemone", type="clef", vision=True))
    running_status(monkeypatch)
    calls = []

    async def system(model, req, *, check_status=True):
        calls.append(req)
        return ok()

    monkeypatch.setattr(run_engine.clef, "run", system)
    engine = RunEngine(config(list(items)), registry=items)
    images = [
        {"dataUrl": "data:image/png;base64,AA==", "name": "first.png"},
        {"dataUrl": "data:image/png;base64,AQ==", "name": "second.png"},
    ]
    result = await engine.run_material({"input": "", "images": images})
    assert result["models_skipped"] == [{"model": "text", "reason": "non_vision"}]
    assert calls[0].input == "Изображение: first.png\nИзображение: second.png"
    assert calls[0].images == [image["dataUrl"] for image in images]

    await engine.run_material({"input": "", "type": "text+images", "images": images})
    assert calls[1].input == "", "пустой текст с вложениями не заменяется placeholder-именами"
    assert calls[1].images == [image["dataUrl"] for image in images]

    calls.clear()
    text_only = RunEngine(config(["text"]), registry=items)
    with pytest.raises(RunEngineError, match="Ни одна"):
        await text_only.run_material({"input": "", "images": images})
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["fast_batch", "both"])
async def test_images_rejected_before_inference_in_fast_modes(monkeypatch, mode):
    items = registry(entry("native", vision=True))
    running_status(monkeypatch)

    async def unexpected(*args, **kwargs):
        raise AssertionError("inference must not start")

    monkeypatch.setattr(run_engine.decide_service, "decide_one", unexpected)
    monkeypatch.setattr(run_engine.fast_batch, "run", unexpected)
    engine = RunEngine(config(["native"], mode=mode), registry=items)
    with pytest.raises(RunEngineError, match=mode):
        await engine.run_material({"input": "", "images": ["data:image/png;base64,AA=="]})


@pytest.mark.asyncio
async def test_execution_snapshot_and_signature_are_immutable_and_credential_free(monkeypatch):
    original = entry(
        "native", type="remote", base_url="https://user:secret@example.test/v1?api_key=secret",
    )
    items = registry(original)
    running_status(monkeypatch)
    seen = []

    async def native(model, payload, *, check_status=True):
        seen.append(model.url)
        return ok(prompt_format_version=1)

    monkeypatch.setattr(run_engine.decide_service, "decide_one", native)
    engine = RunEngine(config(["native"]), registry=items)
    signature = engine.execution_signature
    original.base_url = "https://changed.example"
    original.enabled = False
    original.roles[:] = ["chat"]
    await engine.run_material({"input": "x"})
    assert seen == ["https://user:secret@example.test/v1?api_key=secret"]
    assert engine.execution_signature == signature
    public = json.dumps(engine.execution_metadata, ensure_ascii=False)
    assert "secret" not in public and "user" not in public and "changed" not in public
    assert engine.execution_metadata["models"][0]["url"] == "https://example.test/v1"


@pytest.mark.asyncio
async def test_prompt_pin_leader_barrier_under_concurrency(monkeypatch):
    items = registry(entry("native"))
    running_status(monkeypatch)
    release = asyncio.Event()
    calls = []

    async def native(model, payload, *, check_status=True):
        calls.append(payload.get("prompt_format_version"))
        if len(calls) == 1:
            await release.wait()
        return ok(prompt_format_version=7)

    monkeypatch.setattr(run_engine.decide_service, "decide_one", native)
    engine = RunEngine(config(["native"]), registry=items)
    first = asyncio.create_task(engine.run_material({"input": "first"}))
    second = asyncio.create_task(engine.run_material({"input": "second"}))
    for _ in range(5):
        await asyncio.sleep(0)
    assert calls == [None]
    release.set()
    results = await asyncio.gather(first, second)
    assert calls == [None, 7]
    assert all(run["prompt_format_version"] == 7 for result in results for run in result["runs"])
    assert engine.execution_metadata["prompt_formats"] == {"native": 7}


@pytest.mark.asyncio
async def test_explicit_prompt_pin_stays_fixed_while_actual_version_is_reported(monkeypatch):
    items = registry(entry("native"))
    running_status(monkeypatch)
    calls = []

    async def native(model, payload, *, check_status=True):
        calls.append(payload.get("prompt_format_version"))
        return ok(prompt_format_version=9)

    monkeypatch.setattr(run_engine.decide_service, "decide_one", native)
    engine = RunEngine(config(["native"], prompt_formats={"native": 2}), registry=items)
    await engine.run_material({"input": "a"})
    await engine.run_material({"input": "b"})
    assert calls == [2, 2]
    assert engine.execution_metadata["prompt_formats"] == {"native": 9}


@pytest.mark.asyncio
async def test_prompt_pin_failed_leader_retries_and_null_does_not_barrier(monkeypatch):
    items = registry(entry("native"))
    running_status(monkeypatch)
    calls = []

    async def failing_then_pinned(model, payload, *, check_status=True):
        calls.append(payload.get("prompt_format_version"))
        if len(calls) == 1:
            raise RuntimeError("leader failed")
        return ok(prompt_format_version=4)

    monkeypatch.setattr(run_engine.decide_service, "decide_one", failing_then_pinned)
    engine = RunEngine(config(["native"]), registry=items)
    results = await asyncio.wait_for(asyncio.gather(
        engine.run_material({"input": "a"}), engine.run_material({"input": "b"}),
    ), timeout=1)
    assert calls == [None, None]
    assert sorted(run["ok"] for result in results for run in result["runs"]) == [False, True]
    third = await engine.run_material({"input": "c"})
    assert calls == [None, None, 4]
    assert third["runs"][0]["prompt_format_version"] == 4

    calls.clear()

    async def null_version(model, payload, *, check_status=True):
        calls.append(payload.get("prompt_format_version"))
        return ok(prompt_format_version=None)

    monkeypatch.setattr(run_engine.decide_service, "decide_one", null_version)
    null_engine = RunEngine(config(["native"]), registry=items)
    await asyncio.wait_for(asyncio.gather(
        null_engine.run_material({"input": "a"}), null_engine.run_material({"input": "b"}),
    ), timeout=1)
    assert calls == [None, None]


@pytest.mark.asyncio
async def test_disabled_decision_stays_answers_only(monkeypatch):
    items = registry(entry("native"))
    running_status(monkeypatch)

    async def native(model, payload, *, check_status=True):
        return ok()

    monkeypatch.setattr(run_engine.decide_service, "decide_one", native)
    engine = RunEngine(config(["native"], enabled=False), registry=items)
    result = await engine.run_material({"input": "x"})
    assert result["runs"][0]["answers"] == answers()
    assert result["runs"][0]["decision"] is None and result["runs"][0]["trace"] == []
    aggregate = engine.aggregate(result["runs"])
    assert aggregate["decision"] is None and aggregate["trace"] == []
    assert aggregate["by_model"]["native"]["decision"] is None


@pytest.mark.asyncio
async def test_preflight_validation_and_unavailable_error_slots(monkeypatch):
    items = registry(
        entry("disabled", enabled=False), entry("chat-only", roles=["chat"]),
        entry("down"),
    )
    probes = running_status(monkeypatch, {"down": "stopped"})
    for key in ("missing", "disabled", "chat-only"):
        engine = RunEngine(config([key]), registry=items)
        with pytest.raises(RunEngineError):
            await engine.preflight_models()
    assert probes == []
    result = await RunEngine(config(["down"], mode="fast_batch"), registry=items).run_material({"input": "x"})
    assert probes == ["down"]
    assert result["runs"][0]["mode"] == "fast_batch"
    assert result["runs"][0]["ok"] is False and "stopped" in result["runs"][0]["error"]
