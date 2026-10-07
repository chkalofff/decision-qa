"""Облачные chat-API: OpenAI-совместимый POST {base_url}/chat/completions.

Поддерживаемые провайдеры (имя → базовый URL, env-переменная ключа):
openrouter, openai, clef (прокси ai.1lab.club), systemone (api.system1.cloud),
laya (laya.ai). Ключ берётся из env-переменной провайдера, иначе из
credentials.json по ключу модели (см. credentials.py).

remote_chat — один нестриминговый chat completion. Поверх него:
- run_decide — прогон вопросов /api/decide одним chat-запросом (модель
  отвечает JSON с ответами, текстовый ответ маппится в формат answers);
- generate_questions — генерация вопросов LLM (менеджер вопросов, пресеты).

Замечание по api="systemone": исторически это протокол /v1/systemone
(clef.run). Chat-провайдером systemone считается только запись с base_url
https://api.system1.cloud — см. chat_base_url().
"""

from __future__ import annotations

import json
import os
import re
import time

import httpx

from backend import credentials as creds
from backend.schemas import Question

REQUEST_TIMEOUT = 300.0

# api → (base_url по умолчанию, env-переменная с ключом)
APIS: dict[str, tuple[str, str]] = {
    "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
    "openai": ("https://api.openai.com/v1", "OPENAI_API_KEY"),
    "clef": ("https://ai.1lab.club/v1", "CLEF_API_KEY"),
    "systemone": ("https://api.system1.cloud/v1", "SYSTEM1_API_KEY"),
    "laya": ("https://laya.ai/api/v1", "LAYA_API_KEY"),
}

_SYSTEMONE_PROTOCOL_DEFAULT = "https://api.system1.cloud/v1"


def is_chat_api(api) -> bool:
    return api in APIS


def default_base_url(api: str) -> str | None:
    item = APIS.get(api)
    return item[0] if item else None


def chat_base_url(api: str, base_url: str | None) -> str | None:
    """Эффективный base_url chat API или None, если запись — не chat.

    api="systemone" без base_url или с base_url api.system1.cloud — облачный
    chat-провайдер; с другим base_url — протокол /v1/systemone (clef.run).
    """
    if not is_chat_api(api):
        return None
    if api == "systemone" and base_url:
        base = base_url.rstrip("/")
        if base != _SYSTEMONE_PROTOCOL_DEFAULT:
            return None
        return base
    return (base_url or APIS[api][0]).rstrip("/")


def is_chat_entry(entry) -> bool:
    """Запись реестра — облачная chat-модель (type=remote + chat API)."""
    return getattr(entry, "type", None) == "remote" \
        and chat_base_url(entry.api, entry.base_url) is not None


def _env_key(api: str) -> str | None:
    value = os.environ.get(APIS[api][1], "").strip()
    return value or None


def api_key(api: str, model_key: str | None = None) -> str | None:
    """Ключ провайдера: env-переменная приоритетнее credentials.json."""
    if not is_chat_api(api):
        return creds.get(model_key) if model_key else None
    return _env_key(api) or (creds.get(model_key) if model_key else None)


def has_key(api: str, model_key: str | None = None) -> bool:
    return api_key(api, model_key) is not None


# ---------------------------------------------------------------- базовый вызов

async def remote_chat(api: str, api_model: str, messages: list[dict],
                      max_tokens: int = 2048, temperature: float = 0.0,
                      *, model_key: str | None = None,
                      base_url: str | None = None,
                      reasoning_effort: str | None = None) -> str:
    """Текст ответа chat completion. Ошибки — RuntimeError с понятным текстом.
    reasoning_effort пробрасывается как есть; если API отвечает 400/422
    (параметр не поддержан) — один ретрай без него."""
    base = chat_base_url(api, base_url)
    if base is None:
        raise ValueError(f"Неизвестный chat API: {api!r}")
    if not api_model:
        raise ValueError("Для облачной chat-модели нужно имя модели (api_model)")
    key = api_key(api, model_key)
    if key is None:
        env = APIS[api][1]
        raise RuntimeError(
            f"Нет API-ключа: задайте {env} или сохраните ключ на странице «Модели»")
    payload = {"model": api_model, "messages": messages,
               "max_tokens": max_tokens, "temperature": temperature}
    if reasoning_effort:
        payload["reasoning_effort"] = reasoning_effort
    headers = {"Authorization": f"Bearer {key}"}
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.post(f"{base}/chat/completions",
                                     json=payload, headers=headers)
            if resp.status_code in (400, 422) and "reasoning_effort" in payload:
                payload.pop("reasoning_effort")
                resp = await client.post(f"{base}/chat/completions",
                                         json=payload, headers=headers)
    except httpx.HTTPError as e:
        raise RuntimeError(f"API недоступен ({base}): {e}") from e
    if resp.status_code != 200:
        detail = resp.text[:300]
        try:
            body = resp.json()
            if isinstance(body, dict):
                err = body.get("error")
                detail = (err.get("message") if isinstance(err, dict) else err) \
                    or body.get("detail") or detail
        except Exception:
            pass
        raise RuntimeError(f"API ответил {resp.status_code}: {detail}")
    data = resp.json()
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"Неожиданный ответ API (нет choices): "
                           f"{json.dumps(data, ensure_ascii=False)[:300]}") from e
    return content or ""


# ---------------------------------------------------------------- decide через chat

DECIDE_SYSTEM = """\
Ты — движок ответов на вопросы по контексту. Ответь на КАЖДЫЙ вопрос и верни \
СТРОГО один JSON-объект без пояснений и markdown-ограждений:
{"answers": {"<id вопроса>": <ответ>, ...}}

Формат ответа по типу вопроса:
- yes_no: число 0..1 — вероятность ответа «да» (например 0.85);
- choice: строка — ТОЧНОЕ имя одной из опций;
- score: целое число — индекс уровня шкалы от 0 (первый уровень).\
"""


def _describe_question(q: Question) -> str:
    if q.type == "yes_no":
        desc = f"{q.id} (yes_no): {q.question or q.id}"
        crit = []
        if q.yes:
            crit.append(f"да = {q.yes}")
        if q.no:
            crit.append(f"нет = {q.no}")
        return desc + (" (" + "; ".join(crit) + ")" if crit else "")
    if q.type == "choice":
        opts = "; ".join(
            f"{o.name}" + (f" — {o.description}" if o.description else "")
            for o in q.options or [])
        return f"{q.id} (choice): {q.question or q.id}. Опции: {opts}"
    levels = ", ".join(f"{i}={lvl}" for i, lvl in enumerate(q.levels or []))
    return f"{q.id} (score): {q.question or q.id}. Шкала: {levels}"


def build_decide_messages(req) -> list[dict]:
    context = req.input if isinstance(req.input, str) \
        else json.dumps(req.input, ensure_ascii=False)
    lines = ["Контекст:", context, "", "Вопросы:"]
    lines += [_describe_question(q) for q in req.questions]
    return [{"role": "system", "content": DECIDE_SYSTEM},
            {"role": "user", "content": "\n".join(lines)}]


_JSON_BLOCK_RE = re.compile(r"\{.*\}", re.S)


def extract_json(text: str) -> dict:
    """JSON-объект из ответа модели: чистый текст или обёртка ```json … ```."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```\w*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        m = _JSON_BLOCK_RE.search(text)
        if not m:
            raise ValueError("в ответе нет JSON-объекта")
        data = json.loads(m.group(0))
    if not isinstance(data, dict):
        raise ValueError("ответ — не JSON-объект")
    return data


def _one_hot(keys: list[str], chosen: str) -> dict[str, float]:
    return {k: (1.0 if k == chosen else 0.0) for k in keys}


def _answer_yes_no(raw) -> dict:
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        p = min(max(float(raw), 0.0), 1.0)
    elif isinstance(raw, bool):
        p = 1.0 if raw else 0.0
    elif isinstance(raw, str):
        v = raw.strip().casefold()
        if v in ("yes", "да", "true", "1"):
            p = 1.0
        elif v in ("no", "нет", "false", "0"):
            p = 0.0
        else:
            p = min(max(float(v), 0.0), 1.0)  # "0.7" → вероятность
    else:
        raise ValueError(f"нестандартный yes_no-ответ: {raw!r}")
    return {"type": "yes_no",
            "probabilities": {"yes": p, "no": round(1.0 - p, 6)},
            "label_mass": None}


def _answer_choice(raw, q: Question) -> dict:
    keys = [o.name for o in q.options or []]
    if isinstance(raw, dict):
        raw = raw.get("choice") or raw.get("answer")
    if not isinstance(raw, str):
        raise ValueError(f"нестандартный choice-ответ: {raw!r}")
    if raw not in keys:
        folded = {k.casefold(): k for k in keys}
        raw = folded.get(raw.strip().casefold())
    if raw is None:
        raise ValueError(f"выбранная опция не из списка: {raw!r}")
    return {"type": "choice", "probabilities": _one_hot(keys, raw),
            "choice": raw, "label_mass": None}


def _answer_score(raw, q: Question) -> dict:
    keys = [str(i) for i in range(len(q.levels or []))]
    if isinstance(raw, dict):
        raw = raw.get("score") if raw.get("score") is not None else raw.get("answer")
    if isinstance(raw, str) and raw in (q.levels or []):
        idx = (q.levels or []).index(raw)
    else:
        idx = int(float(raw))
    if not (0 <= idx < len(keys)):
        raise ValueError(f"score вне шкалы: {raw!r}")
    return {"type": "score", "probabilities": _one_hot(keys, str(idx)),
            "score": float(idx), "label_mass": None}


def parse_answers(text: str, questions: list[Question]) -> dict:
    """Текст ответа chat-модели → answers формата /v1/decisions."""
    data = extract_json(text)
    raw_answers = data.get("answers", data)
    if not isinstance(raw_answers, dict):
        raise ValueError("в JSON нет объекта answers")
    answers = {}
    for q in questions:
        if q.id not in raw_answers:
            raise ValueError(f"нет ответа на вопрос {q.id!r}")
        raw = raw_answers[q.id]
        if q.type == "yes_no":
            answers[q.id] = _answer_yes_no(raw)
        elif q.type == "choice":
            answers[q.id] = _answer_choice(raw, q)
        elif q.type == "score":
            answers[q.id] = _answer_score(raw, q)
    return answers


async def run_decide(entry, req) -> dict:
    """Один результат /api/decide для облачной chat-модели."""
    from backend import model_manager as mm  # локально: избегаем цикла импортов

    status = await mm.model_status(entry)
    if status["status"] != "running":
        return {"ok": False, "error": mm.not_running_message(entry, status["status"])}
    t0 = time.perf_counter()
    try:
        text = await remote_chat(
            entry.api, entry.api_model or entry.key, build_decide_messages(req),
            max_tokens=4096, temperature=req.temperature or 0.0,
            model_key=entry.key, base_url=entry.base_url)
        answers = parse_answers(text, req.questions)
    except (RuntimeError, ValueError) as e:
        return {"ok": False, "error": str(e)}
    duration_s = time.perf_counter() - t0
    return {
        "ok": True,
        "answers": answers,
        "usage": {},
        "prompt_format_version": None,
        "metrics": {
            "duration_s": round(duration_s, 2),
            "prompt_tokens": None,
            "prefill_tok_s": None,
            "label_mass_min": None,
            "label_mass_avg": None,
            "rss_gb": None,
            "mode": "remote_chat",
        },
    }


# ---------------------------------------------------------------- генерация вопросов

GENERATE_SYSTEM = """\
Ты — конструктор вопросов для оценки текстов. По описанию задачи придумай \
вопросы и верни СТРОГО один JSON-объект без пояснений и markdown-ограждений:
{"name": "короткое имя набора", "description": "одно предложение",
 "questions": [...]}

Каждый вопрос — объект одного из видов:
- {"type": "yes_no", "question": "текст вопроса",
   "yes": "критерий ответа «да»", "no": "критерий ответа «нет»"}
- {"type": "choice", "question": "…", "options": [{"name": "вариант",
   "description": "пояснение"}, …]} — от 2 до 5 опций
- {"type": "score", "question": "…", "levels": ["худший", …, "лучший"],
   "direction": "up"} — от 2 до 5 уровней; direction: up (больше = лучше),
  down (больше = хуже) или neutral
Вопросы — на русском, конкретные и проверяемые по тексту.\
"""

MAX_GENERATED_QUESTIONS = 12


def parse_generated_questions(text: str) -> dict:
    """Ответ LLM генерации → {name?, description?, questions: [с id]}."""
    data = extract_json(text)
    questions = data.get("questions")
    if not isinstance(questions, list) or not questions:
        raise ValueError("в ответе модели нет непустого списка questions")
    out = []
    for i, q in enumerate(questions[:MAX_GENERATED_QUESTIONS], start=1):
        if not isinstance(q, dict):
            raise ValueError(f"вопрос #{i} — не объект")
        item = {"id": f"q{i}", "question": str(q.get("question") or "").strip(),
                "type": q.get("type")}
        if not item["question"]:
            raise ValueError(f"вопрос #{i}: пустой текст")
        if item["type"] == "yes_no":
            if q.get("yes"):
                item["yes"] = str(q["yes"])
            if q.get("no"):
                item["no"] = str(q["no"])
        elif item["type"] == "choice":
            options = []
            for o in q.get("options") or []:
                if isinstance(o, str):
                    options.append({"name": o})
                elif isinstance(o, dict) and str(o.get("name") or "").strip():
                    opt = {"name": str(o["name"])}
                    if o.get("description"):
                        opt["description"] = str(o["description"])
                    options.append(opt)
            item["options"] = options
        elif item["type"] == "score":
            item["levels"] = [str(x) for x in (q.get("levels") or [])]
        # валидация общей схемой (типы, опции 2–26, уровни 2–10)
        Question.model_validate(item)
        if item["type"] == "score":
            direction = q.get("direction")
            if direction in ("up", "down", "neutral"):
                item["direction"] = direction
        out.append(item)
    result = {"questions": out}
    if str(data.get("name") or "").strip():
        result["name"] = str(data["name"]).strip()
    if str(data.get("description") or "").strip():
        result["description"] = str(data["description"]).strip()
    return result


def build_generate_messages(task: str, context: str | None = None,
                            count: int = 6) -> list[dict]:
    """Сообщения генерации вопросов (общие для облачного и локального пути)."""
    user = f"Задача: {task.strip()}\nПридумай {count} вопросов."
    if context and context.strip():
        user = (f"Контекст (пример анализируемого текста):\n"
                f"{context.strip()[:8000]}\n\n{user}")
    return [{"role": "system", "content": GENERATE_SYSTEM},
            {"role": "user", "content": user}]


async def generate_questions(entry, task: str, context: str | None = None,
                             count: int = 6,
                             reasoning_effort: str | None = None) -> dict:
    """LLM-генерация вопросов облачной chat-моделью. → {name?, description?,
    questions}; ошибки — RuntimeError/ValueError с понятным текстом."""
    if not task.strip():
        raise ValueError("Пустое описание задачи")
    messages = build_generate_messages(task, context, count)
    text = await remote_chat(entry.api, entry.api_model or entry.key, messages,
                             max_tokens=4096, temperature=0.7,
                             model_key=entry.key, base_url=entry.base_url,
                             reasoning_effort=reasoning_effort)
    return parse_generated_questions(text)
