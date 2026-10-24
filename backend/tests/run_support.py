"""Shared controlled fakes and contract fixtures for /api/run tests."""

from __future__ import annotations

import asyncio
import base64
import copy
from types import SimpleNamespace

from backend.run_schemas import RunChunkRequest, RunCreateRequest
from dqa_common.aggregation import aggregate_mean_probability_v1
from dqa_common.config_pack import finalize_pack
from dqa_common.materials import (
    composite_content_sha256, material_hash, materials_fingerprint, raw_content_sha256,
    run_fingerprint,
)


def pack(models=None, *, mode="decisions"):
    return finalize_pack({
        "version": 1,
        "fingerprint_version": 1,
        "questions": [{"id": "q1", "question": "Да?", "type": "yes_no"}],
        "decision": {
            "enabled": True,
            "outcomes": [{
                "id": "yes", "label": "Да", "isDefault": True,
                "rules": [{"conditions": [{
                    "question": "q1", "answer": "yes", "op": "gte", "threshold": 0.5,
                }]}],
            }],
        },
        "settings": {
            "models": list(models or ["fake"]), "mode": mode,
            "aggregation": "mean_probability_v1",
        },
    })


def create_request(count=1, *, models=None, mode="decisions", threads=None, fingerprint="sha256:" + "0" * 64):
    return RunCreateRequest.model_validate({
        "pack": pack(models, mode=mode), "overrides": {}, "threads": threads,
        "material_count": count, "materials_fingerprint": fingerprint,
    })


def file_payload(index, text=None, *, images=None, name=None, path=None, material=None):
    text = f"material-{index}" if text is None else text
    images = images or []
    payload = {
        "i": index, "input": text, "images": images,
        "content_sha256": composite_content_sha256(text, images),
    }
    if name is not None:
        payload["name"] = name
    if path is not None:
        payload["path"] = path
    if material is not None:
        payload["material"] = material
    return payload


def client_fingerprint(files):
    hashes = []
    for item in sorted(files, key=lambda value: value["i"]):
        images = item.get("images") or []
        declared = (item.get("material") or {})
        if images:
            material_type = "text+images" if declared.get("type") == "text+images" or item["input"] not in (None, "") else "image"
        else:
            material_type = "text"
        image_metadata = []
        for index, image in enumerate(images):
            encoded = image.split(",", 1)[1] if image.startswith("data:") else image
            supplied = (declared.get("images") or [{}] * len(images))[index]
            image_metadata.append({
                "name": str(supplied.get("name") or f"image-{index + 1}.png"),
                "sha256": raw_content_sha256(base64.b64decode(encoded, validate=True)),
            })
        metadata = {key: copy.deepcopy(item[key]) for key in ("path", "name") if key in item}
        metadata["material"] = {"type": material_type, "images": image_metadata}
        hashes.append(material_hash(item["input"], images, metadata,
                                    content_digest=item["content_sha256"]))
    return materials_fingerprint(hashes)


def upload_all(manager, job, files):
    request = RunChunkRequest.model_validate({"chunk_index": 0, "files": files})
    manager.upload(job, request)
    metadata = list(manager.store.material_metadata(job))
    expected = materials_fingerprint(item["material_hash"] for item in metadata)
    job.expected_materials_fingerprint = expected
    job.materials_fingerprint = expected
    job.run_fingerprint = run_fingerprint(job.effective_config["fingerprint"], expected)
    return request


class FakeController:
    def __init__(self):
        self.calls = []
        self.active = 0
        self.max_active = 0
        self.preflight_calls = 0
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()
        self.hook = None

    async def run(self, engine, material):
        self.calls.append(material["input"])
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.started.set()
        try:
            if self.hook is not None:
                await self.hook(engine, material)
            else:
                await self.release.wait()
            return {
                "runs": [{
                    "model": "fake", "mode": "decisions", "ok": True,
                    "answers": {"q1": {"type": "yes_no", "probabilities": {"yes": 0.8, "no": 0.2}}},
                    "usage": {"prompt_tokens": 2}, "metrics": {},
                    "decision": {"outcomeId": "yes"}, "trace": [],
                }],
                "models_skipped": [], "execution": {},
            }
        finally:
            self.active -= 1


class FakeEngine:
    controller = FakeController()
    preflight_error = None
    statuses = {"fake": "running"}
    visions = {"fake": True}

    def __init__(self, config):
        self.config = copy.deepcopy(dict(config))
        self.execution_metadata = {
            "engine_version": 1, "execution_signature": "sha256:" + "1" * 64,
            "mode": self.config["settings"]["mode"],
            "models": [{"key": key} for key in self.config["settings"]["models"]],
            "prompt_formats": {},
        }
        self.models = {
            key: SimpleNamespace(vision=self.visions.get(key, True))
            for key in self.config["settings"]["models"]
        }

    async def preflight_models(self):
        type(self).controller.preflight_calls += 1
        if type(self).preflight_error is not None:
            raise type(self).preflight_error
        return {key: {"status": type(self).statuses.get(key, "running")}
                for key in self.config["settings"]["models"]}

    async def run_material(self, material):
        return await type(self).controller.run(self, material)

    def aggregate(self, runs):
        return aggregate_mean_probability_v1(self.config, runs)


def reset_fake():
    FakeEngine.controller = FakeController()
    FakeEngine.preflight_error = None
    FakeEngine.statuses = {"fake": "running"}
    FakeEngine.visions = {"fake": True}
    return FakeEngine.controller


async def wait_terminal(manager, job, timeout=2.0):
    async with asyncio.timeout(timeout):
        while job.status not in {"completed", "completed_partial", "cancelled", "failed"}:
            await asyncio.sleep(0.005)
    return job
