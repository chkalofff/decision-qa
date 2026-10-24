"""Reusable job-scoped model execution over the existing protocol adapters."""

from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from backend import clef
from backend import decide_service
from backend import fast_batch
from backend import model_manager as mm
from backend import remote_llm
from backend.schemas import DecideRequest, Question, build_sglang_payload
from dqa_common.aggregation import aggregate_mean_probability_v1
from dqa_common.config_pack import canonical_bytes, normalize_pack
from dqa_common.decision import explain_decision

ENGINE_VERSION = 1


class RunEngineError(ValueError):
    """Invalid effective config/model selection or material for a job run."""


def supports_fast_batch(entry: mm.ModelEntry) -> bool:
    """Fast mode belongs to the native decisions/chat protocol, not SystemOne."""
    return entry.api == "decisions" and not remote_llm.is_chat_entry(entry)


def _safe_url(value: str | None) -> str | None:
    if not value:
        return value
    try:
        parts = urlsplit(value)
        host = parts.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        if parts.port is not None:
            host += f":{parts.port}"
        return urlunsplit((parts.scheme, host, parts.path, "", ""))
    except ValueError:
        return None


def _execution_identity(entry: mm.ModelEntry) -> dict:
    return {
        "key": entry.key,
        "type": entry.type,
        "api": entry.api,
        "model": entry.api_model or entry.hf_id or None,
        "url": _safe_url(entry.url),
        "vision": bool(entry.vision),
    }


def _copy_entry(entry: mm.ModelEntry) -> mm.ModelEntry:
    snapshot = copy.copy(entry)
    snapshot.roles = list(entry.roles)
    return snapshot


class _PromptPin:
    def __init__(self, version: int | None):
        self.requested_version = version
        self.version = version
        self.resolved = version is not None
        self.leader = False
        self.condition = asyncio.Condition()

    async def acquire(self) -> tuple[bool, int | None]:
        async with self.condition:
            while not self.resolved and self.leader:
                await self.condition.wait()
            if self.resolved:
                return False, self.requested_version
            self.leader = True
            return True, None

    async def finish(self, result: dict) -> None:
        async with self.condition:
            if result.get("ok") is True:
                if not self.resolved:
                    self.requested_version = result.get("prompt_format_version")
                self.version = result.get("prompt_format_version")
                self.resolved = True
            self.leader = False
            self.condition.notify_all()

    async def observe(self, result: dict) -> None:
        if result.get("ok") is not True:
            return
        async with self.condition:
            self.version = result.get("prompt_format_version")


class RunEngine:
    """One immutable model registry and effective config for a whole job.

    Construct once at job start, then call ``run_material`` for each material.
    The first call performs one cached health preflight; later materials reuse it.
    """

    def __init__(self, effective_config: Mapping[str, Any], *,
                 registry: Mapping[str, mm.ModelEntry] | None = None):
        self.config = normalize_pack(dict(effective_config))
        source = mm.REGISTRY if registry is None else registry
        self.models = {
            key: _copy_entry(source[key])
            for key in self.config["settings"]["models"]
            if key in source
        }
        self._source_keys = set(source)
        self._statuses: dict[str, dict] | None = None
        self._preflight_lock = asyncio.Lock()
        self._mode = self.config["settings"]["mode"]
        formats = self.config["settings"].get("prompt_formats") or {}
        self._prompt_pins = {
            key: _PromptPin(formats.get(key))
            for key, entry in self.models.items()
            if entry.api == "decisions" and not remote_llm.is_chat_entry(entry)
        }
        identities = [_execution_identity(self.models[key]) for key in sorted(self.models)]
        self._execution_models = identities
        projection = {"engine_version": ENGINE_VERSION, "models": identities}
        self.execution_signature = "sha256:" + hashlib.sha256(canonical_bytes(projection)).hexdigest()

    @property
    def execution_metadata(self) -> dict:
        return {
            "engine_version": ENGINE_VERSION,
            "execution_signature": self.execution_signature,
            "mode": self._mode,
            "models": copy.deepcopy(self._execution_models),
            "prompt_formats": {
                key: pin.version if pin.resolved else None
                for key, pin in self._prompt_pins.items()
            },
        }

    async def preflight_models(self) -> dict[str, dict]:
        async with self._preflight_lock:
            if self._statuses is not None:
                return self._statuses
            selected = self.config["settings"]["models"]
            if not selected:
                raise RunEngineError("Нужна хотя бы одна модель (settings.models)")
            unknown = [key for key in selected if key not in self._source_keys]
            if unknown:
                raise RunEngineError(f"Неизвестные модели: {', '.join(unknown)}")
            disabled = [key for key in selected if not self.models[key].enabled]
            if disabled:
                raise RunEngineError(f"Модели отключены в менеджере моделей: {', '.join(disabled)}")
            wrong_role = [key for key in selected if "decision" not in self.models[key].roles]
            if wrong_role:
                raise RunEngineError(f"Модели не имеют роли decision: {', '.join(wrong_role)}")
            statuses = await asyncio.gather(*(mm.model_status(self.models[key]) for key in selected))
            self._statuses = dict(zip(selected, statuses))
            return self._statuses

    async def _request(self, key: str, material: Mapping[str, Any], input_data: Any,
                       images: list[str] | None, mode: str,
                       prompt_format_version: int | None = None) -> DecideRequest:
        settings = self.config["settings"]
        inference = settings.get("inference") or {}
        return DecideRequest(
            input=input_data,
            temperature=settings.get("temperature"),
            prompt_format_version=prompt_format_version,
            return_prompt_token_ids=inference.get("return_prompt_token_ids"),
            mode=mode,
            questions=[Question.model_validate(question) for question in self.config["questions"]],
            models=[key],
            images=images,
        )

    async def _ordinary(self, key: str, material: Mapping[str, Any], input_data: Any,
                        images: list[str] | None) -> dict:
        entry = self.models[key]
        pin = self._prompt_pins.get(key)
        prompt_version = pin.requested_version if pin is not None else None
        req = await self._request(key, material, input_data, images, "decisions", prompt_version)
        if remote_llm.is_chat_entry(entry):
            return await remote_llm.run_decide(entry, req, check_status=False)
        if entry.api == "systemone":
            return await clef.run(entry, req, check_status=False)
        if entry.api != "decisions":
            raise RunEngineError(f"Модель {key} использует неподдерживаемый протокол: {entry.api}")
        if pin is None:
            return await decide_service.decide_one(entry, build_sglang_payload(req), check_status=False)
        leader, version = await pin.acquire()
        if version != prompt_version:
            req = await self._request(key, material, input_data, images, "decisions", version)
        if not leader:
            result = await decide_service.decide_one(entry, build_sglang_payload(req), check_status=False)
            await pin.observe(result)
            return result
        try:
            result = await decide_service.decide_one(entry, build_sglang_payload(req), check_status=False)
        except BaseException:
            await pin.finish({"ok": False})
            raise
        await pin.finish(result)
        return result

    async def _fast(self, key: str, input_data: Any, images: list[str] | None) -> dict:
        req = await self._request(key, {}, input_data, images, "fast_batch")
        return await fast_batch.run(self.models[key], req.questions, req.input, check_status=False)

    async def _safe_run(self, key: str, mode: str, call) -> dict:
        try:
            raw = await call
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raw = {"ok": False, "error": str(exc) or exc.__class__.__name__}
        run = {
            "model": key,
            "mode": mode,
            "ok": raw.get("ok") is True,
            "answers": raw.get("answers") or {},
            "usage": raw.get("usage") or {},
            "metrics": raw.get("metrics") or {},
            "decision": None,
            "trace": [],
        }
        if "prompt_format_version" in raw:
            run["prompt_format_version"] = raw["prompt_format_version"]
        if not run["ok"]:
            run["error"] = raw.get("error") or "Неизвестная ошибка модели"
        elif self.config["decision"].get("enabled", True):
            explanation = explain_decision(self.config["decision"], run["answers"])
            run["decision"] = explanation["res"]
            run["trace"] = explanation["trace"]
        return run

    async def _run_pass(self, keys: list[str], material: Mapping[str, Any], input_data: Any,
                        images: list[str] | None, mode: str) -> list[dict]:
        calls = []
        for key in keys:
            if mode == "fast_batch" and supports_fast_batch(self.models[key]):
                call = self._fast(key, input_data, images)
            else:
                call = self._ordinary(key, material, input_data, images)
            calls.append(self._safe_run(key, mode if supports_fast_batch(self.models[key]) or mode == "decisions"
                                        else "decisions", call))
        results = await asyncio.gather(*calls, return_exceptions=True)
        for result in results:
            if isinstance(result, asyncio.CancelledError):
                raise result
            if isinstance(result, BaseException):
                raise result
        return results

    def _available(self, keys: list[str]) -> tuple[list[str], list[str]]:
        available = []
        unavailable = []
        for key in keys:
            if self._statuses[key]["status"] == "running":
                available.append(key)
            else:
                unavailable.append(key)
        return available, unavailable

    def _safe_failure(self, key: str, mode: str) -> dict:
        status = self._statuses[key]["status"]
        return {
            "model": key, "mode": mode, "ok": False, "answers": {},
            "usage": {}, "metrics": {}, "decision": None, "trace": [],
            "error": mm.not_running_message(self.models[key], status),
        }

    def _unavailable_runs(self, keys: list[str]) -> list[dict]:
        runs = []
        for key in keys:
            ordinary = self._safe_failure(key, "decisions")
            if self._mode == "fast_batch" and supports_fast_batch(self.models[key]):
                ordinary["mode"] = "fast_batch"
            runs.append(ordinary)
            if self._mode == "both" and supports_fast_batch(self.models[key]):
                runs.append(self._safe_failure(key, "fast_batch"))
        return runs

    @staticmethod
    def _images(material: Mapping[str, Any]) -> tuple[list[str], list[str]]:
        payloads = []
        names = []
        for index, image in enumerate(material.get("images") or []):
            if isinstance(image, str):
                payload = image
                name = f"image-{index + 1}.png"
            elif isinstance(image, Mapping):
                payload = next((image[key] for key in ("dataUrl", "data_url", "base64", "data", "bytes")
                                if key in image), None)
                metadata = image.get("metadata") or {}
                name = image.get("name") or metadata.get("name") or f"image-{index + 1}.png"
                if isinstance(payload, (bytes, bytearray, memoryview)):
                    mime = image.get("mime") or metadata.get("mime") or "image/png"
                    payload = f"data:{mime};base64," + base64.b64encode(bytes(payload)).decode("ascii")
            else:
                raise RunEngineError(f"images[{index}] должен быть строкой или объектом")
            if not isinstance(payload, str) or not payload:
                raise RunEngineError(f"images[{index}] не содержит base64/data URL")
            payloads.append(payload)
            names.append(str(name))
        return payloads, names

    async def run_material(self, material: Mapping[str, Any]) -> dict:
        """Run one material and return canonical runs plus execution metadata.

        Input: ``{input|content, images?, name?, path?, metadata?}``. Image items
        are ordered base64/data-URL strings or objects carrying one of those payloads.
        """
        if not isinstance(material, Mapping):
            raise RunEngineError("material должен быть объектом")
        images, image_names = self._images(material)
        if images and self._mode in {"fast_batch", "both"}:
            raise RunEngineError(f"Режим {self._mode} не поддерживает изображения")
        input_data = material["input"] if "input" in material else material.get("content")
        if images and (input_data is None or input_data == "") and material.get("type") != "text+images":
            input_data = "\n".join(f"Изображение: {name}" for name in image_names)
        if not images and (input_data is None or not input_data
                           or isinstance(input_data, str) and not input_data.strip()):
            raise RunEngineError("Материал (input) не может быть пустым")
        if not isinstance(input_data, (str, dict, list)):
            raise RunEngineError("material.input должен быть строкой, объектом или массивом")
        await self.preflight_models()
        selected = self.config["settings"]["models"]
        skipped = []
        if images:
            vision = []
            for key in selected:
                if self.models[key].vision:
                    vision.append(key)
                else:
                    skipped.append({"model": key, "reason": "non_vision"})
            selected = vision
            if not selected:
                raise RunEngineError("Ни одна выбранная модель не поддерживает изображения")
        available, unavailable = self._available(selected)
        runs = []
        if self._mode == "both":
            runs.extend(await self._run_pass(available, material, input_data, images or None, "decisions"))
            fast_keys = [key for key in available if supports_fast_batch(self.models[key])]
            runs.extend(await self._run_pass(fast_keys, material, input_data, images or None, "fast_batch"))
        else:
            runs.extend(await self._run_pass(available, material, input_data, images or None, self._mode))
        runs.extend(self._unavailable_runs(unavailable))
        metadata = {}
        for key in ("name", "path"):
            if key in material:
                metadata[key] = copy.deepcopy(material[key])
        if "metadata" in material:
            metadata.update(copy.deepcopy(dict(material["metadata"] or {})))
        return {
            "material": metadata,
            "runs": runs,
            "models_skipped": skipped,
            "execution": self.execution_metadata,
        }

    def aggregate(self, runs: list[dict]) -> dict:
        return aggregate_mean_probability_v1(self.config, runs)


def aggregate(config: Mapping[str, Any], runs: list[dict]) -> dict:
    """Aggregate canonical runs with the mode-aware shared policy."""
    return aggregate_mean_probability_v1(config, runs)
