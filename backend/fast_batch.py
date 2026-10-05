"""Режим fast_batch: все вопросы одним запросом /v1/chat/completions.

Модель отвечает строкой меток (по одной на вопрос); распределение вероятностей
восстанавливается из top_logprobs каждой позиции. Формат answers совпадает с /v1/decisions.
"""

from __future__ import annotations

import json
import math
import re
import time
from typing import Any

import httpx

from backend import model_manager as mm
from backend.schemas import Question

TOP_LOGPROBS_NUM = 20
MISSING_LABEL_PENALTY = 25.0

SYSTEM_MESSAGE = (
    "Ты отвечаешь на вопросы о приведённом ниже тексте. "
    "На каждый вопрос выбери ровно одну метку из предложенных."
)
FINAL_INSTRUCTION = (
    "Ответь строго одной строкой: метка на каждый вопрос подряд без пробелов и пояснений, "
    "вопросы нумеруются с 1."
)

SEPARATORS_RE = re.compile(r"[\s,;]+")


def labels_for(question: Question) -> list[str]:
    """Метки вариантов вопроса в промпте: A/B, A..Z или 0..9."""
    if question.type == "yes_no":
        return ["A", "B"]
    if question.type == "choice":
        return [chr(ord("A") + i) for i in range(len(question.options))]
    if question.type == "score":
        return [str(i) for i in range(len(question.levels))]
    raise ValueError(f"Неизвестный тип вопроса: {question.type!r}")


def probability_keys(question: Question) -> list[str]:
    """Ключи probabilities в ответе — как у /v1/decisions."""
    if question.type == "yes_no":
        return ["yes", "no"]
    if question.type == "choice":
        return [opt.name for opt in question.options]
    if question.type == "score":
        return [str(i) for i in range(len(question.levels))]
    raise ValueError(f"Неизвестный тип вопроса: {question.type!r}")


def label_descriptions(question: Question) -> list[str]:
    if question.type == "yes_no":
        return [question.yes or "да", question.no or "нет"]
    if question.type == "choice":
        return [opt.name for opt in question.options]
    if question.type == "score":
        return list(question.levels)
    raise ValueError(f"Неизвестный тип вопроса: {question.type!r}")


def build_messages(input_data: str | dict | list, questions: list[Question]) -> list[dict]:
    if isinstance(input_data, str):
        text = input_data.strip()
    else:
        text = json.dumps(input_data, ensure_ascii=False, indent=2)
    lines = [text, "", "Вопросы:"]
    for i, q in enumerate(questions, start=1):
        lines.append(f"{i}. {q.question}".rstrip())
        for label, desc in zip(labels_for(q), label_descriptions(q)):
            lines.append(f"{label}: {desc}")
    lines += ["", FINAL_INSTRUCTION]
    return [
        {"role": "system", "content": SYSTEM_MESSAGE},
        {"role": "user", "content": "\n".join(lines)},
    ]


def build_regex(questions: list[Question]) -> str:
    """^(A|B)(A|B|C)(0|1|2)...$ — группа на каждый вопрос."""
    groups = "".join(f"({'|'.join(labels_for(q))})" for q in questions)
    return f"^{groups}$"


# ---------------------------------------------------------------- вероятности

def position_label_logprobs(item: dict, allowed: set[str]) -> dict[str, float]:
    """logprob каждой разрешённой метки позиции из top_logprobs (дедуп по максимуму)."""
    scores: dict[str, float] = {}
    for entry in item.get("top_logprobs") or []:
        token = str(entry.get("token", "")).strip()
        if token in allowed:
            logprob = float(entry.get("logprob", 0.0))
            scores[token] = max(logprob, scores.get(token, -math.inf))
    chosen = str(item.get("token", "")).strip()
    if chosen in allowed:
        logprob = float(item.get("logprob", 0.0))
        scores[chosen] = max(logprob, scores.get(chosen, -math.inf))
    return scores


def softmax_probabilities(scores: dict[str, float], labels: list[str]) -> dict[str, float]:
    """Softmax по меткам; недостающие получают min(видимые) − 25."""
    floor = (min(scores.values()) if scores else 0.0) - MISSING_LABEL_PENALTY
    full = {label: scores.get(label, floor) for label in labels}
    shift = max(full.values())
    exps = {label: math.exp(lp - shift) for label, lp in full.items()}
    total = sum(exps.values())
    return {label: exps[label] / total for label in labels}


def build_answer(question: Question, label_probs: dict[str, float]) -> dict:
    keys = probability_keys(question)
    probs = dict(zip(keys, (label_probs[label] for label in labels_for(question))))
    answer: dict[str, Any] = {"type": question.type, "probabilities": probs, "label_mass": None}
    if question.type == "choice":
        answer["choice"] = max(probs, key=probs.get)
    elif question.type == "score":
        answer["score"] = math.fsum(i * p for i, p in enumerate(probs.values()))
    return answer


def parse_content_answers(content_items: list[dict], questions: list[Question]) -> dict | None:
    """Разбор контента с учётом слияния токенов: итоговая строка должна состоять
    ровно из N меток подряд; токен может покрывать несколько позиций (например,
    токен «BA») — его распределение top_logprobs тогда применяется к каждой
    покрытой позиции (приближение; подробности см. в комментарии к
    position_label_logprobs)."""
    # Спецтокены (напр. <|im_end|>) исключаем из строки и из спанов
    items = [it for it in content_items if not str(it.get("token", "")).startswith("<|")]
    text = "".join(str(item.get("token", "")) for item in items).strip()
    if len(text) != len(questions):
        return None
    # Позиции символов → покрывающий токен
    spans: list[dict] = []
    pos = 0
    for item in items:
        token_text = str(item.get("token", ""))
        n = len(token_text)
        for _ in token_text:
            if pos < len(questions):
                spans.append(item)
            pos += 1
    answers: dict[str, dict] = {}
    for i, q in enumerate(questions):
        labels = labels_for(q)
        ch = text[i]
        if ch not in labels:
            return None
        scores = position_label_logprobs(spans[i], set(labels))
        answers[q.id] = build_answer(q, softmax_probabilities(scores, labels))
    return answers


def parse_text_labels(text: str, questions: list[Question]) -> list[str] | None:
    """Fallback-разбор строки ответа: метки подряд, допустимы пробелы/запятые между ними."""
    cleaned = SEPARATORS_RE.sub("", text or "")
    if len(cleaned) != len(questions):
        return None
    labels: list[str] = []
    for ch, q in zip(cleaned, questions):
        if ch not in labels_for(q):
            return None
        labels.append(ch)
    return labels


def parse_fallback_answers(data: dict, questions: list[Question]) -> dict | None:
    """Fallback: строка ответа + top_logprobs; при невозможности выравнивания — one-hot."""
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    text = message.get("content") or ""
    labels = parse_text_labels(text, questions)
    if labels is None:
        return None
    content_items = ((choice.get("logprobs") or {}).get("content")) or []
    aligned: list[dict] = []
    idx = 0
    for item in content_items:
        if idx >= len(questions):
            break
        if str(item.get("token", "")).strip() == labels[idx]:
            aligned.append(item)
            idx += 1
    answers: dict[str, dict] = {}
    for i, q in enumerate(questions):
        if i < len(aligned):
            scores = position_label_logprobs(aligned[i], set(labels_for(q)))
            label_probs = softmax_probabilities(scores, labels_for(q))
        else:
            label_probs = {label: 1.0 if label == labels[i] else 0.0 for label in labels_for(q)}
        answers[q.id] = build_answer(q, label_probs)
    return answers


def _is_regex_unsupported(resp) -> bool:
    if resp.status_code != 400:
        return False
    text = (getattr(resp, "text", "") or "").lower()
    return "regex" in text or "grammar" in text


async def run(entry: mm.ModelEntry, questions: list[Question], input_data: Any) -> dict:
    """Один результат /api/decide для fast_batch-режима."""
    status = await mm.model_status(entry)
    if status["status"] != "running":
        return {"ok": False, "error": mm.not_running_message(entry, status["status"])}
    headers = mm._auth_headers(entry)
    base_payload = {
        "model": entry.hf_id,
        "messages": build_messages(input_data, questions),
        "temperature": 0,
        "max_completion_tokens": len(questions),
        "logprobs": True,
        "top_logprobs": TOP_LOGPROBS_NUM,
        # Qwen3-шаблон по умолчанию включает thinking — без этого ответ
        # начинается с блока рассуждений и метки не парсятся.
        "chat_template_kwargs": {"enable_thinking": False},
    }
    t0 = time.perf_counter()
    fallback = False
    answers: dict | None = None
    data: dict | None = None
    try:
        async with httpx.AsyncClient(timeout=mm.REQUEST_TIMEOUT) as client:
            resp = await client.post(
                f"{entry.url}/v1/chat/completions",
                json={**base_payload, "regex": build_regex(questions)},
                headers=headers,
            )
            if resp.status_code == 200:
                data = resp.json()
                answers = parse_content_answers(_content_items(data), questions)
            if answers is None and resp.status_code != 200 and not _is_regex_unsupported(resp):
                return {"ok": False, "error": _http_error(resp, entry)}
            if answers is None:
                fallback = True
                resp = await client.post(
                    f"{entry.url}/v1/chat/completions", json=base_payload,
                    headers=headers,
                )
                if resp.status_code != 200:
                    return {"ok": False, "error": _http_error(resp, entry)}
                data = resp.json()
                answers = parse_fallback_answers(data, questions)
    except httpx.HTTPError as e:
        return {"ok": False, "error": f"SGLang недоступен по адресу {entry.url}: {e}"}
    duration_s = time.perf_counter() - t0

    if answers is None:
        text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        return {
            "ok": False,
            "error": (
                f"Не удалось разобрать ответ модели{f' (fallback без regex)' if fallback else ''}: "
                f"ожидалось {len(questions)} меток, получено: {text[:200]!r}"
            ),
            "metrics": {"mode": "fast_batch", "fallback": fallback},
        }

    usage_src = data.get("usage") or {}
    content_items = _content_items(data)
    prompt_tokens = usage_src.get("prompt_tokens")
    usage = {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": usage_src.get("completion_tokens", len(content_items) or None),
    }
    metrics = {
        "duration_s": round(duration_s, 2),
        "prompt_tokens": prompt_tokens,
        "prefill_tok_s": round(prompt_tokens / duration_s, 1) if prompt_tokens else None,
        "label_mass_min": None,
        "label_mass_avg": None,
        "rss_gb": mm.rss_gb_for(entry),
        "mode": "fast_batch",
        "fallback": fallback,
    }
    return {
        "ok": True,
        "answers": answers,
        "usage": usage,
        "prompt_format_version": None,
        "metrics": metrics,
    }


def _content_items(data: dict) -> list[dict]:
    return ((data.get("choices") or [{}])[0].get("logprobs") or {}).get("content") or []


def _http_error(resp, entry: mm.ModelEntry) -> str:
    if resp.status_code == 400:
        try:
            detail = resp.json()
            if isinstance(detail, dict):
                detail = detail.get("detail") or detail.get("message") or resp.text
        except Exception:
            detail = resp.text
        return str(detail)
    return f"Неожиданный ответ SGLang (HTTP {resp.status_code}): {resp.text[:500]}"
