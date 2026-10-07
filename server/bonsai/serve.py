"""Тонкий OpenAI-совместимый сервер поверх экспериментального Hadamard-рантайма
пака prism-ml/Ternary-Bonsai-2-27B-mlx-2bit (model_type prism_hadamard_qwen35).

Стандартные mlx-lm/SGLang этот пак не загружают: веса в повёрнутом базисе,
трансформы применяет собственный runtime репо модели (runtime/ в снапшоте,
sys.path из MODEL_PATH — см. PACK-RUNTIME.md). Vision-паки грузятся через
runtime/vision_artifact.py поверх mlx-vlm, text-only — через runtime/artifact.py.

Эндпоинты: GET /health, GET /v1/models, POST /v1/chat/completions (SSE-стрим
в OpenAI-формате + нестриминговый ответ). Запуск: server/run_bonsai.sh
(env MODEL_PATH — путь к снапшоту, PORT, MODEL_ID).
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import queue
import sys
import threading
import time
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

MODEL_PATH = Path(os.environ.get("MODEL_PATH", "")).resolve()
MODEL_ID = os.environ.get("MODEL_ID", "bonsai")
PORT = int(os.environ.get("PORT", "30006"))
DEFAULT_MAX_TOKENS = 2048

if not MODEL_PATH.is_dir() or not (MODEL_PATH / "config.json").is_file():
    print(f"MODEL_PATH не указывает на снапшот пака: {MODEL_PATH}", file=sys.stderr)
    sys.exit(1)

sys.path.insert(0, str(MODEL_PATH / "runtime"))

app = FastAPI()
_state: dict = {}  # model, processor, mode ("vision" | "text"), tokenizer/eos для text
_gen_lock = threading.Lock()


def _load_pack() -> None:
    config = json.loads((MODEL_PATH / "config.json").read_text())
    if config.get("components", {}).get("vision"):
        from vision_artifact import load_vl_model

        model, processor, cfg = load_vl_model(MODEL_PATH)
        _state.update(model=model, processor=processor, config=cfg, mode="vision")
    else:
        from artifact import load_model
        from tokenizers import Tokenizer

        model, cfg = load_model(MODEL_PATH)
        gen = _read_json("generation_config.json", {})
        eos = gen.get("eos_token_id")
        tokenizer = Tokenizer.from_file(str(MODEL_PATH / "tokenizer.json"))
        stop = set(eos if isinstance(eos, list) else [] if eos is None else [eos])
        stop |= {i for i in (tokenizer.token_to_id("<|im_end|>"),
                             tokenizer.token_to_id("<|endoftext|>"))
                 if i is not None}
        _state.update(model=model, tokenizer=tokenizer, stop=stop, mode="text")


def _read_json(name: str, default):
    path = MODEL_PATH / name
    return json.loads(path.read_text()) if path.is_file() else default


def _render(messages: list[dict], tools=None, enable_thinking: bool = False) -> str:
    """Рендер всей истории chat_template.jinja пака (как quickstart.py)."""
    template_path = MODEL_PATH / "chat_template.jinja"
    if not template_path.is_file():
        raise ValueError("В паке нет chat_template.jinja")
    from jinja2.sandbox import ImmutableSandboxedEnvironment

    return (
        ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True)
        .from_string(template_path.read_text())
        .render(
            messages=messages,
            tools=tools,
            add_generation_prompt=True,
            enable_thinking=enable_thinking,
        )
    )


def _sampler_settings(temperature=None, top_p=None, top_k=None) -> dict:
    """Дефолты из generation_config.json пака; параметры запроса их перекрывают."""
    gen = _read_json("generation_config.json", {})
    return {
        "temp": (gen.get("temperature", 1.0) if temperature is None
                 else max(float(temperature), 0.0)),
        "top_p": gen.get("top_p", 0.95) if top_p is None else float(top_p),
        "top_k": gen.get("top_k", 20) if top_k is None else int(top_k),
    }


def _extract_images(messages: list[dict]) -> list:
    """PIL-изображения из content-партов image_url (data: URL или файл)."""
    from PIL import Image

    images = []
    for msg in messages:
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            url = ""
            if part.get("type") == "image_url":
                url = (part.get("image_url") or {}).get("url", "")
            elif part.get("type") == "image" and isinstance(part.get("image"), str):
                url = part["image"]
            if url.startswith("data:"):
                _, _, b64 = url.partition(",")
                images.append(Image.open(io.BytesIO(base64.b64decode(b64))))
            elif url and Path(url).is_file():
                images.append(Image.open(url))
    return images


def _generate_vision(prompt: str, images: list, max_tokens: int, settings: dict,
                     out: queue.Queue) -> None:
    from mlx_vlm import stream_generate

    for chunk in stream_generate(_state["model"], _state["processor"], prompt,
                                 image=images or None, max_tokens=max_tokens,
                                 **settings):
        # .text у mlx-vlm — дельта; на случай кумулятивного стрима отрезаем префикс
        text = chunk.text if hasattr(chunk, "text") else str(chunk)
        out.put(text)


def _generate_text(prompt: str, max_tokens: int, settings: dict,
                   out: queue.Queue) -> None:
    import mlx.core as mx
    from mlx_lm.sample_utils import make_sampler

    model, tokenizer, stop = _state["model"], _state["tokenizer"], _state["stop"]
    sample = make_sampler(temp=settings["temp"], top_p=settings["top_p"],
                          top_k=settings["top_k"])
    x = mx.array([tokenizer.encode(prompt, add_special_tokens=False).ids])
    cache = model.make_cache()
    generated: list[int] = []
    for _ in range(max_tokens):
        logits = model.lm_head(model.model(x, cache=cache)[:, -1:, :])[:, -1, :]
        x = sample(logits)[:, None]
        mx.eval(x)
        token = int(x.item())
        if token in stop:
            break
        generated.append(token)
        text = tokenizer.decode(generated)
        if text.endswith("\ufffd"):  # недособранный UTF-8 — ждём следующий токен
            continue
        out.put(text)
        generated.clear()


def _stream_worker(prompt: str, images: list, max_tokens: int, settings: dict,
                   out: queue.Queue) -> None:
    try:
        with _gen_lock:  # одна модель — одна генерация за раз
            if _state["mode"] == "vision":
                _generate_vision(prompt, images, max_tokens, settings, out)
            else:
                _generate_text(prompt, max_tokens, settings, out)
        out.put(None)  # конец
    except Exception as e:  # noqa: BLE001 — отдаём клиенту как error-часть
        out.put(e)


async def _iter_deltas(out: queue.Queue):
    """Асинхронно отдаёт дельты из очереди воркера (кумулятивные строки диффим)."""
    emitted = ""
    while True:
        item = await asyncio.to_thread(out.get)
        if item is None:
            return
        if isinstance(item, Exception):
            raise item
        if item.startswith(emitted):
            delta = item[len(emitted):]
            emitted = item
        else:
            delta = item
            emitted += item
        if delta:
            yield delta


def _chunk(text: str | None, finish: str | None = None) -> str:
    delta = {} if finish else {"content": text}
    payload = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": MODEL_ID,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_ID}


@app.get("/v1/models")
async def list_models():
    return {"object": "list", "data": [
        {"id": MODEL_ID, "object": "model", "created": 0, "owned_by": "local"}]}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return JSONResponse(status_code=400, content={
            "error": {"message": "Невалидный JSON"}})
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        return JSONResponse(status_code=400, content={
            "error": {"message": "messages — непустой список"}})
    max_tokens = int(body.get("max_tokens") or DEFAULT_MAX_TOKENS)
    settings = _sampler_settings(body.get("temperature"), body.get("top_p"),
                                 body.get("top_k"))
    kwargs = body.get("chat_template_kwargs") or {}
    try:
        images = _extract_images(messages) if _state["mode"] == "vision" else []
        # jinja-шаблон сам ставит <|image_pad|> по content-партам
        prompt = _render(messages, tools=body.get("tools"),
                         enable_thinking=bool(kwargs.get("enable_thinking", False)))
    except Exception as e:  # noqa: BLE001
        return JSONResponse(status_code=400, content={
            "error": {"message": f"Ошибка рендера промпта: {e}"}})

    out: queue.Queue = queue.Queue()
    threading.Thread(target=_stream_worker,
                     args=(prompt, images, max_tokens, settings, out),
                     daemon=True).start()

    if body.get("stream"):
        async def sse():
            try:
                async for delta in _iter_deltas(out):
                    yield _chunk(delta)
                yield _chunk(None, finish="stop")
            except Exception as e:  # noqa: BLE001
                yield "data: " + json.dumps({"error": {"message": str(e)}}) + "\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(sse(), media_type="text/event-stream")

    text = ""
    try:
        async for delta in _iter_deltas(out):
            text += delta
    except Exception as e:  # noqa: BLE001
        return JSONResponse(status_code=500, content={
            "error": {"message": str(e)}})
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_ID,
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": text}}],
    }


@app.on_event("startup")
def startup():
    _load_pack()
    print(f"Bonsai-сервер: {MODEL_ID} ({_state['mode']}) на порту {PORT}",
          file=sys.stderr)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
