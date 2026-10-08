"""Decision-QA backend v2: маршруты API и статика фронтенда."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from backend import clef
from backend import fast_batch
from backend import model_manager as mm
from backend import preset_store
from backend import remote_llm
from backend import settings as app_settings
from backend.assistant import router as assistant_router
from backend.schemas import DecideRequest, build_sglang_payload

STATIC_DIR = Path(__file__).resolve().parent.parent / "frontend" / "static"
VERSION_FILE = Path(__file__).resolve().parent.parent / "VERSION"


def app_version() -> str:
    try:
        return VERSION_FILE.read_text(encoding="utf-8").strip() or "dev"
    except OSError:
        return "dev"


app = FastAPI(title="Decision-QA")
app.include_router(assistant_router.router)


class NoCacheStaticFiles(StaticFiles):
    """Статика с Cache-Control: no-cache — кэш остаётся (etag → дешёвые 304),
    но браузер обязан ревалидировать и не исполняет устаревший JS/CSS."""

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    messages = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err.get("loc", []) if p != "body")
        messages.append(f"{loc}: {err.get('msg')}" if loc else err.get("msg"))
    return JSONResponse(status_code=422, content={"detail": "; ".join(messages)})


def _error_422(message: str) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": message})


# ---------------------------------------------------------------- models

@app.get("/api/models")
async def list_models():
    models = [await mm.model_status(e) for e in mm.REGISTRY.values()]
    return {
        "models": models,
        "device": {
            "ram_gb": round(mm.TOTAL_RAM_GB, 1),
            "budget_gb": round(mm.BUDGET_GB, 1),
        },
    }


@app.post("/api/models")
async def create_model(request: Request):
    """Добавление облачной (remote) модели."""
    data = await request.json()
    entry, error = mm.create_remote_model(data)
    if error is not None:
        return _error_422(error)
    return await mm.model_status(entry)


@app.delete("/api/models/{key}")
async def remove_model(key: str):
    """Удаление remote-модели из реестра (локальные выключаются через PATCH)."""
    entry = mm.REGISTRY.get(key)
    if entry is None:
        return _error_422(f"Неизвестная модель: {key!r}")
    status, message = mm.delete_remote_model(entry)
    if status != 200:
        return JSONResponse(status_code=status, content={"detail": message})
    return {"key": key, "detail": message}


@app.patch("/api/models/{key}")
async def patch_model(key: str, request: Request):
    """Правка label/short_label/enabled/base_url/roles/context_length с сохранением в конфиг."""
    entry = mm.REGISTRY.get(key)
    if entry is None:
        return _error_422(f"Неизвестная модель: {key!r}")
    patch = await request.json()
    allowed = {"label", "short_label", "enabled", "base_url", "roles", "context_length"}
    unknown = set(patch) - allowed
    if unknown:
        return _error_422(f"Нельзя править поля: {', '.join(sorted(unknown))}")
    try:
        mm.update_model(entry, patch)
    except ValueError as e:
        return _error_422(str(e))
    return await mm.model_status(entry)


@app.put("/api/models/{key}/credentials")
async def put_credentials(key: str, request: Request):
    entry = mm.REGISTRY.get(key)
    if entry is None:
        return _error_422(f"Неизвестная модель: {key!r}")
    if entry.managed:
        return _error_422("API-ключ нужен только облачным моделям")
    data = await request.json()
    api_key = str(data.get("api_key") or "").strip()
    if not api_key:
        return _error_422("Пустой api_key")
    mm.creds.save(key, api_key)
    mm.invalidate_remote_probe(key)
    return {"key": key, "has_credentials": True}


@app.delete("/api/models/{key}/credentials")
async def delete_credentials(key: str):
    entry = mm.REGISTRY.get(key)
    if entry is None:
        return _error_422(f"Неизвестная модель: {key!r}")
    mm.creds.delete(key)
    mm.invalidate_remote_probe(key)
    return {"key": key, "has_credentials": False}


@app.post("/api/models/{key}/download")
async def download_model(key: str):
    entry = mm.REGISTRY.get(key)
    if entry is None:
        return _error_422(f"Неизвестная модель: {key!r}")
    status, message = await mm.start_download(entry)
    if status != 200:
        return JSONResponse(status_code=status, content={"detail": message})
    return {"key": key, "detail": message}


@app.post("/api/models/{key}/delete")
async def delete_model_files(key: str):
    """Удаление скачанных файлов локальной модели из HF-кэша."""
    entry = mm.REGISTRY.get(key)
    if entry is None:
        return _error_422(f"Неизвестная модель: {key!r}")
    status, message = await mm.delete_model(entry)
    if status != 200:
        return JSONResponse(status_code=status, content={"detail": message})
    return {"key": key, "detail": message}


@app.post("/api/models/{key}/start")
async def start_model(key: str):
    entry = mm.REGISTRY.get(key)
    if entry is None:
        return _error_422(f"Неизвестная модель: {key!r}")
    ok, error = await mm.start_model(entry)
    if not ok:
        return JSONResponse(status_code=409, content={"detail": error})
    return {"key": key, "status": "starting"}


@app.post("/api/models/{key}/stop")
async def stop_model(key: str):
    entry = mm.REGISTRY.get(key)
    if entry is None:
        return _error_422(f"Неизвестная модель: {key!r}")
    status, message = await mm.stop_model(entry)
    if status != 200:
        return JSONResponse(status_code=status, content={"detail": message})
    return {"key": key, "detail": message}


# ---------------------------------------------------------------- settings

def _settings_payload() -> dict:
    return {
        "budget_fraction": round(mm.BUDGET_FRACTION, 4),
        "budget_gb": round(mm.BUDGET_GB, 1),
        "total_ram_gb": round(mm.TOTAL_RAM_GB, 1),
    }


@app.get("/api/settings")
async def get_settings():
    return _settings_payload()


@app.put("/api/settings/budget")
async def put_budget(request: Request):
    """Смена MODELS_BUDGET_FRACTION из UI: на лету + персист в settings.json."""
    data = await request.json()
    try:
        fraction = float(data.get("fraction"))
    except (TypeError, ValueError, AttributeError):
        return _error_422(
            f"Поле fraction должно быть числом "
            f"{app_settings.MIN_BUDGET_FRACTION}–{app_settings.MAX_BUDGET_FRACTION}")
    lo, hi = app_settings.MIN_BUDGET_FRACTION, app_settings.MAX_BUDGET_FRACTION
    if not (lo <= fraction <= hi):
        return _error_422(
            f"Доля бюджета моделей должна быть в диапазоне {lo}–{hi} "
            f"(30–95% RAM), получено {fraction}")
    mm.set_budget_fraction(fraction)
    return _settings_payload()


# ---------------------------------------------------------------- presets

@app.get("/api/presets")
async def list_presets():
    return preset_store.list_presets()


@app.post("/api/presets")
async def create_preset(request: Request):
    """Создать/перезаписать пользовательский пресет (в presets_user/)."""
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return _error_422("Тело запроса должно быть валидным JSON")
    preset, error = preset_store.create_preset(data)
    if error is not None:
        return _error_422(error)
    return preset


@app.patch("/api/presets/{slug}")
async def rename_preset(slug: str, request: Request):
    """Переименование пользовательского пресета (name → новый slug)."""
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return _error_422("Тело запроса должно быть валидным JSON")
    name = data.get("name") if isinstance(data, dict) else None
    preset, status, error = preset_store.rename_preset(slug, str(name or ""))
    if error is not None:
        return JSONResponse(status_code=status, content={"detail": error})
    return preset


@app.delete("/api/presets/{slug}")
async def delete_preset(slug: str):
    """Удаление пользовательского пресета (встроенные — read-only)."""
    status, error = preset_store.delete_preset(slug)
    if error is not None:
        return JSONResponse(status_code=status, content={"detail": error})
    return {"slug": slug, "detail": "Пресет удалён"}


# ---------------------------------------------------------------- LLM-генерация вопросов

def _resolve_generate_model(data: dict) -> tuple[mm.ModelEntry | None, JSONResponse | None]:
    """Общая валидация model_key для /api/presets/generate и
    /api/questions/generate: любая включённая модель с ролью chat
    (облачная chat API или локальная с chat url — sglang, bonsai)."""
    model_key = str(data.get("model_key") or "")
    entry = mm.REGISTRY.get(model_key)
    if entry is None or "chat" not in entry.roles:
        return None, _error_422(
            f"Модель {model_key!r} не подходит для генерации — нужна роль "
            "«ассистент» (chat). Включите её на странице «Модели».")
    if not entry.enabled:
        return None, _error_422(f"Модель {model_key!r} отключена в менеджере моделей")
    return entry, None


async def _local_generate_chat(entry: mm.ModelEntry, messages: list[dict],
                               thinking: bool) -> str:
    """Нестриминговый chat completion локальной модели (sglang/bonsai).
    Модель должна быть запущена — иначе GenerateModelNotRunning (→ 409)."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{entry.url}/v1/models")
        if r.status_code != 200:
            raise httpx.ConnectError("bad status")
    except Exception:
        raise GenerateModelNotRunning(
            f"Модель «{entry.label}» не запущена. Запустите её чипом в верхнем баре.")
    payload = {"model": entry.key, "messages": messages,
               "max_tokens": 4096, "temperature": 0.7,
               "chat_template_kwargs": {"enable_thinking": thinking}}
    try:
        async with httpx.AsyncClient(timeout=mm.REQUEST_TIMEOUT) as client:
            resp = await client.post(f"{entry.url}/v1/chat/completions",
                                     json=payload, headers=mm._auth_headers(entry))
    except httpx.HTTPError as e:
        raise RuntimeError(f"Модель «{entry.label}» недоступна: {e}") from e
    if resp.status_code != 200:
        raise RuntimeError(f"Модель «{entry.label}» ответила "
                           f"{resp.status_code}: {resp.text[:300]}")
    try:
        return resp.json()["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"Неожиданный ответ модели «{entry.label}» "
                           f"(нет choices): {resp.text[:300]}") from e


class GenerateModelNotRunning(RuntimeError):
    """Локальная chat-модель для генерации не запущена (→ 409)."""


async def _generate(entry: mm.ModelEntry, task: str, context: str | None,
                    thinking: bool) -> dict:
    """Генерация вопросов: облачная — remote_chat (reasoning_effort при
    thinking), локальная — chat completions с enable_thinking."""
    if remote_llm.is_chat_entry(entry):
        return await remote_llm.generate_questions(
            entry, task, context=context,
            reasoning_effort="high" if thinking else None)
    messages = remote_llm.build_generate_messages(task, context)
    text = await _local_generate_chat(entry, messages, thinking)
    return remote_llm.parse_generated_questions(text)


@app.post("/api/presets/generate")
async def generate_preset(request: Request):
    """LLM-генерация набора вопросов для пресета по описанию задачи."""
    data = await request.json()
    entry, error = _resolve_generate_model(data)
    if error:
        return error
    task = str(data.get("description") or "").strip()
    if not task:
        return _error_422("Пустое описание задачи (description)")
    try:
        result = await _generate(entry, task, None, bool(data.get("thinking")))
    except GenerateModelNotRunning as e:
        return JSONResponse(status_code=409, content={"detail": str(e)})
    except (RuntimeError, ValueError) as e:
        return JSONResponse(status_code=502, content={"detail": str(e)})
    return result


@app.post("/api/questions/generate")
async def generate_questions_ep(request: Request):
    """LLM-генерация вопросов по контексту (менеджер вопросов)."""
    data = await request.json()
    entry, error = _resolve_generate_model(data)
    if error:
        return error
    context = data.get("input")
    context = context if isinstance(context, str) else json.dumps(context, ensure_ascii=False) \
        if isinstance(context, (dict, list)) else ""
    task = str(data.get("hint") or "").strip() \
        or "Составь вопросы для проверки таких текстов"
    try:
        result = await _generate(entry, task, context, bool(data.get("thinking")))
    except GenerateModelNotRunning as e:
        return JSONResponse(status_code=409, content={"detail": str(e)})
    except (RuntimeError, ValueError) as e:
        return JSONResponse(status_code=502, content={"detail": str(e)})
    return {"questions": result["questions"]}


async def _generate_decision(entry: mm.ModelEntry, task: str,
                             questions: list[dict], context: str | None,
                             thinking: bool) -> dict:
    """Генерация правил решения: те же пути, что _generate для вопросов."""
    if remote_llm.is_chat_entry(entry):
        return await remote_llm.generate_decision(
            entry, task, questions, context=context,
            reasoning_effort="high" if thinking else None)
    messages = remote_llm.build_decision_generate_messages(task, questions, context)
    text = await _local_generate_chat(entry, messages, thinking)
    return remote_llm.parse_generated_decision(text, questions)


@app.post("/api/decision/generate")
async def generate_decision_ep(request: Request):
    """LLM-генерация правил решения по вопросам (редактор «Решение»)."""
    data = await request.json()
    entry, error = _resolve_generate_model(data)
    if error:
        return error
    questions = data.get("questions")
    if not isinstance(questions, list) or not questions:
        return _error_422("Нужен непустой список вопросов (questions)")
    context = data.get("input")
    context = context if isinstance(context, str) else json.dumps(context, ensure_ascii=False) \
        if isinstance(context, (dict, list)) else ""
    task = str(data.get("hint") or "").strip() \
        or "Придумай правила решения по ответам на эти вопросы"
    try:
        return await _generate_decision(entry, task, questions, context,
                                        bool(data.get("thinking")))
    except GenerateModelNotRunning as e:
        return JSONResponse(status_code=409, content={"detail": str(e)})
    except (RuntimeError, ValueError) as e:
        return JSONResponse(status_code=502, content={"detail": str(e)})


# ---------------------------------------------------------------- decide

async def _decide_one(entry: mm.ModelEntry, payload: dict) -> dict:
    status = await mm.model_status(entry)
    if status["status"] != "running":
        return {"ok": False, "error": mm.not_running_message(entry, status["status"])}
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=mm.REQUEST_TIMEOUT) as client:
            resp = await client.post(f"{entry.url}/v1/decisions", json=payload,
                                     headers=mm._auth_headers(entry))
    except httpx.HTTPError as e:
        return {"ok": False, "error": f"Сервер недоступен по адресу {entry.url}: {e}"}
    duration_s = time.perf_counter() - t0
    if resp.status_code == 400:
        try:
            detail = resp.json()
            if isinstance(detail, dict):
                detail = detail.get("detail") or detail.get("message") or resp.text
        except Exception:
            detail = resp.text
        return {"ok": False, "error": str(detail)}
    if resp.status_code != 200:
        return {"ok": False, "error": f"Неожиданный ответ сервера (HTTP {resp.status_code}): {resp.text[:500]}"}
    data = resp.json()
    answers = data.get("answers", {})
    usage = data.get("usage") or {}
    prompt_tokens = usage.get("prompt_tokens")
    mass_min, mass_avg = mm.label_mass_metrics(answers)
    metrics = {
        "duration_s": round(duration_s, 2),
        "prompt_tokens": prompt_tokens,
        "prefill_tok_s": round(prompt_tokens / duration_s, 1) if prompt_tokens else None,
        "label_mass_min": mass_min,
        "label_mass_avg": mass_avg,
        "rss_gb": mm.rss_gb_for(entry),
        "mode": "decisions",
    }
    return {
        "ok": True,
        "answers": answers,
        "usage": usage,
        "prompt_format_version": data.get("prompt_format_version"),
        "metrics": metrics,
    }


@app.post("/api/decide")
async def decide(req: DecideRequest):
    unknown = [k for k in req.models if k not in mm.REGISTRY]
    if unknown:
        return _error_422(f"Неизвестные модели: {', '.join(unknown)}")
    disabled = [k for k in req.models if not mm.REGISTRY[k].enabled]
    if disabled:
        return _error_422(
            f"Модели отключены в менеджере моделей: {', '.join(disabled)}")
    if req.images:
        if req.mode == "fast_batch":
            return _error_422("Быстрый режим не поддерживает изображения")
        no_vision = [k for k in req.models if not mm.REGISTRY[k].vision]
        if no_vision:
            names = ", ".join(no_vision)
            return _error_422(
                f"Модель не поддерживает изображения: {names}. "
                "Снимите с них выбор или уберите изображения.")

    def task(entry: mm.ModelEntry):
        # Модели протокола SystemOne (clef, laya, облачные) делают один
        # не-авторегрессионный проход на все вопросы — режим прогона
        # (decisions/fast_batch) и температура на них не влияют.
        if entry.api == "systemone" and not remote_llm.is_chat_entry(entry):
            return clef.run(entry, req)
        # Облачные chat API (openrouter/openai/clef/laya/systemone-облако):
        # один chat completion на все вопросы, ответ-JSON маппится в answers.
        if remote_llm.is_chat_entry(entry):
            return remote_llm.run_decide(entry, req)
        if req.mode == "fast_batch":
            return fast_batch.run(entry, req.questions, req.input)
        return _decide_one(entry, payload)

    payload = build_sglang_payload(req)
    results = await asyncio.gather(*(task(mm.REGISTRY[key]) for key in req.models))
    return {"results": dict(zip(req.models, results))}


@app.get("/api/health")
async def health():
    statuses = await asyncio.gather(*(mm.model_status(e) for e in mm.REGISTRY.values()))
    return {"models": {s["key"]: s["status"] for s in statuses}}


@app.get("/api/version")
async def version():
    return {"version": app_version()}


app.mount("/", NoCacheStaticFiles(directory=str(STATIC_DIR), html=True), name="static")
