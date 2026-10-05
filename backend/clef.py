"""Бэкенд Clef: decision-модели Cloudflare через локальный сервер /v1/systemone
(clef_mlx.py serve из mlx-community/clef-flash-4bit / clef-4bit).

Один не-авторегрессионный проход на все вопросы; sampling/temperature нет.
Формат answers совпадает с /v1/decisions (label_mass всегда None).
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from backend import model_manager as mm
from backend.schemas import Question


def model_name(entry: mm.ModelEntry) -> str:
    """Селектор модели в теле запроса: api_model из конфига, иначе по hf_id."""
    if entry.api_model:
        return entry.api_model
    return "clef-flash" if "flash" in entry.hf_id else "clef"


def question_payload(q: Question) -> dict:
    """Наш тип вопроса → типизированный вопрос SystemOne (noul/choice/score)."""
    payload: dict[str, Any] = {"instructions": q.question or q.id}
    if q.type == "yes_no":
        payload["type"] = "noul"
        criteria = {}
        if q.yes:
            criteria["true"] = q.yes
        if q.no:
            criteria["false"] = q.no
        if criteria:
            payload["criteria"] = criteria
    elif q.type == "choice":
        payload["type"] = "choice"
        payload["criteria"] = {opt.name: (opt.description or opt.name) for opt in q.options or []}
    elif q.type == "score":
        payload["type"] = "score"
        payload["criteria"] = list(q.levels or [])
    else:
        raise ValueError(f"Неизвестный тип вопроса: {q.type!r}")
    return payload


def build_systemone_request(entry: mm.ModelEntry, req) -> dict:
    payload = {
        "model": model_name(entry),
        "state": req.input,
        "questions": {q.id: question_payload(q) for q in req.questions},
    }
    if getattr(req, "images", None):
        payload["images"] = req.images
    return payload


# ---------------------------------------------------------------- ответ → answers

def _normalize(probs: dict[str, float]) -> dict[str, float]:
    total = sum(probs.values())
    if total > 0 and abs(total - 1.0) > 1e-6:
        return {k: v / total for k, v in probs.items()}
    return probs


def _probability_true(ans: Any) -> float:
    """noul-ответ: число или dict с одним из известных ключей."""
    if isinstance(ans, (int, float)):
        return float(ans)
    if isinstance(ans, dict):
        for key in ("noul", "probability", "p_true", "true", "value"):
            if isinstance(ans.get(key), (int, float)):
                return float(ans[key])
    raise ValueError(f"Нестандартный noul-ответ: {ans!r}")


def _probabilities_dict(raw: Any, keys: list[str]) -> dict[str, float]:
    """Вероятности вариантов: dict по ключам или список по позициям."""
    if isinstance(raw, dict):
        if set(raw) == set(keys):
            return _normalize({k: float(raw[k]) for k in keys})
        # Ключи не совпали с нашими (например, индексы) — позиционный маппинг
        values = [float(v) for _, v in sorted(raw.items(), key=lambda kv: str(kv[0]))]
    elif isinstance(raw, list):
        values = [float(v) for v in raw]
    else:
        raise ValueError(f"Нестандартные probabilities: {raw!r}")
    if len(values) != len(keys):
        raise ValueError(f"Число вероятностей {len(values)} != числу вариантов {len(keys)}")
    return _normalize(dict(zip(keys, values)))


def map_answers(data: dict, questions: list[Question]) -> dict:
    """Ответ /v1/systemone → формат answers как у /v1/decisions."""
    raw_answers = data.get("answers") or {}
    answers: dict[str, dict] = {}
    for q in questions:
        ans = raw_answers[q.id]
        if q.type == "yes_no":
            p = min(max(_probability_true(ans), 0.0), 1.0)
            answers[q.id] = {"type": "yes_no",
                             "probabilities": {"yes": p, "no": 1.0 - p},
                             "label_mass": None}
        elif q.type == "choice":
            keys = [opt.name for opt in q.options or []]
            probs = _probabilities_dict(ans.get("probabilities"), keys)
            answers[q.id] = {"type": "choice",
                             "probabilities": probs,
                             "choice": ans.get("choice") if ans.get("choice") in probs
                             else max(probs, key=probs.get),
                             "label_mass": None}
        elif q.type == "score":
            keys = [str(i) for i in range(len(q.levels or []))]
            probs = _probabilities_dict(ans.get("probabilities"), keys)
            answers[q.id] = {"type": "score",
                             "probabilities": probs,
                             "score": sum(i * p for i, p in enumerate(probs.values())),
                             "label_mass": None}
    return answers


def _error_detail(resp) -> str:
    try:
        detail = resp.json()
        if isinstance(detail, dict):
            detail = detail.get("detail") or detail.get("error") or detail.get("message") or resp.text
    except Exception:
        detail = resp.text
    text = str(detail)
    if resp.status_code == 413 or "maximum context length" in text.lower():
        return f"Контекст не влезает в 16k токенов Clef: {text}"
    return text


async def run(entry: mm.ModelEntry, req) -> dict:
    """Один результат /api/decide для clef-модели."""
    status = await mm.model_status(entry)
    if status["status"] != "running":
        return {"ok": False, "error": mm.not_running_message(entry, status["status"])}
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=mm.REQUEST_TIMEOUT) as client:
            resp = await client.post(f"{entry.url}/v1/systemone",
                                     json=build_systemone_request(entry, req),
                                     headers=mm._auth_headers(entry))
    except httpx.HTTPError as e:
        return {"ok": False, "error": f"Сервер недоступен по адресу {entry.url}: {e}"}
    duration_s = time.perf_counter() - t0
    if resp.status_code != 200:
        return {"ok": False, "error": _error_detail(resp)}

    data = resp.json()
    try:
        answers = map_answers(data, req.questions)
    except (KeyError, ValueError) as e:
        return {"ok": False, "error": f"Не удалось разобрать ответ Clef: {e}"}

    usage = data.get("usage") or {}
    prompt_tokens = usage.get("input_tokens") or usage.get("prompt_tokens")
    metrics = {
        "duration_s": round(duration_s, 2),
        "prompt_tokens": prompt_tokens,
        "prefill_tok_s": round(prompt_tokens / duration_s, 1) if prompt_tokens else None,
        "label_mass_min": None,
        "label_mass_avg": None,
        "rss_gb": mm.rss_gb_for(entry),
        "mode": "clef" if entry.type == "clef" else "systemone",
    }
    return {
        "ok": True,
        "answers": answers,
        "usage": usage,
        "prompt_format_version": None,
        "metrics": metrics,
    }
