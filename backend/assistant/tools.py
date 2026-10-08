"""Реестр инструментов ассистента: JSON Schema для модели + исполнители.

Read-инструменты выполняются на бэкенде сразу. Mutating-инструменты не
исполняются никогда — они превращаются в proposal-события для UI (HITL).
"""
from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from backend.schemas import Question

# ------------------------------------------------------------------ схемы

_QUESTION_SCHEMA = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "короткий id латиницей, напр. q1"},
        "question": {"type": "string"},
        "type": {"type": "string", "enum": ["yes_no", "choice", "score"]},
        "description_yes": {"type": "string", "description": "описание ветки «да» (поле yes)"},
        "description_no": {"type": "string", "description": "описание ветки «нет» (поле no)"},
        "options": {"type": "array", "items": {"type": "string"},
                    "description": "2-26 вариантов, только для choice"},
        "levels": {"type": "array", "items": {"type": "string"},
                   "description": "2-10 уровней от низшего к высшему, только для score"},
        "direction": {"type": "string", "enum": ["up", "down", "neutral"],
                      "description": "up = выше лучше, down = ниже лучше; только для score"},
    },
    "required": ["id", "question", "type"],
}

_CONDITION_SCHEMA = {
    "type": "object",
    "properties": {
        "question": {"type": "number",
                     "description": "№ вопроса из снапшота (поле n)"},
        "answer": {"type": "string",
                   "description": "yes/no (yes_no) или точное имя опции (choice); "
                                  "для score-вопроса не задавать"},
        "op": {"type": "string", "enum": ["gte", "lt"],
               "description": "gte — не ниже порога, lt — ниже"},
        "threshold": {"type": "number",
                      "description": "порог вероятности ответа в %, 0–100 "
                                     "(только с answer)"},
        "score": {"type": "number",
                  "description": "порог среднего балла, уровни с 0 "
                                 "(только для score-вопроса, без answer)"},
    },
    "required": ["question", "op"],
}

_RULE_SCHEMA = {
    "type": "object",
    "properties": {
        "anyOf": {"type": "boolean",
                  "description": "false — все условия (И), true — хотя бы одно (ИЛИ)"},
        "conditions": {"type": "array", "items": _CONDITION_SCHEMA},
    },
    "required": ["conditions"],
}

_OUTCOME_SCHEMA = {
    "type": "object",
    "properties": {
        "label": {"type": "string", "description": "название исхода, коротко"},
        "color": {"type": "string",
                  "enum": ["green", "red", "yellow", "blue", "purple", "gray"]},
        "isDefault": {"type": "boolean",
                      "description": "исход по умолчанию (ни одно правило не "
                                     "сработало); максимум один, последним"},
        "rules": {"type": "array", "items": _RULE_SCHEMA},
    },
    "required": ["label", "rules"],
}

TOOLS: list[dict] = [
    {"type": "function", "function": {
        "name": "get_state",
        "description": "Текущее состояние приложения: режим (single/batch), контекст, "
                       "вопросы, файлы батча, выбранные модели, сводка последних результатов.",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "list_presets",
        "description": "Список пресетов (имя, описание, режим, источник builtin/user).",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "list_models",
        "description": "Список моделей: ключ, статус (running/stopped/…), роли "
                       "(decision/chat), enabled, selected (выбрана в баре), vision.",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "get_file_result",
        "description": "Детали по одному файлу батча из снапшота: текст файла и "
                       "результаты прогона по нему (ответы с уверенностью на "
                       "вопросы и решение на модель). Используй, когда агрегатов "
                       "resultsSummary недостаточно.",
        "parameters": {"type": "object", "properties": {
            "file": {"type": "string",
                     "description": "имя файла из снапшота (batchFiles[].name)"},
        }, "required": ["file"]},
    }},
    {"type": "function", "function": {
        "name": "propose_questions",
        "description": "Предложить пользователю набор вопросов. НИЧЕГО не применяет само — "
                       "пользователь увидит карточку и подтвердит. После вызова напиши "
                       "текстом, что именно предложено и почему.",
        "parameters": {"type": "object", "properties": {
            "questions": {"type": "array", "items": _QUESTION_SCHEMA},
            "mode": {"type": "string", "enum": ["replace", "append"],
                     "description": "replace — заменить все вопросы, append — добавить"},
        }, "required": ["questions", "mode"]},
    }},
    {"type": "function", "function": {
        "name": "propose_context",
        "description": "Предложить новый текст контекста (single-режим) или, с "
                       "параметром file, текст конкретного файла батча. "
                       "Не применяет само.",
        "parameters": {"type": "object", "properties": {
            "text": {"type": "string"},
            "mode": {"type": "string", "enum": ["replace", "append"]},
            "file": {"type": "string",
                     "description": "имя файла батча из снапшота — правка его "
                                    "текста вместо одиночного контекста"},
        }, "required": ["text", "mode"]},
    }},
    {"type": "function", "function": {
        "name": "propose_run",
        "description": "Предложить запустить прогон текущего режима (single или batch) "
                       "на выбранных моделях. Не применяет само.",
        "parameters": {"type": "object", "properties": {
            "scope": {"type": "string", "enum": ["single", "batch"]},
            "note": {"type": "string", "description": "что проверяем этим прогоном"},
        }, "required": ["scope"]},
    }},
    {"type": "function", "function": {
        "name": "run_trial",
        "description": "Пробный прогон: выполнить вопросы на decision-моделях ПРЯМО "
                       "СЕЙЧАС (без подтверждения пользователя) и получить сводку "
                       "ответов с уверенностью. Для проверки гипотез по формулировкам. "
                       "Контекст — текст из состояния; можно подменить своим "
                       "(contextText) или взять текст файла батча (batchFile). "
                       "С decision (правила как в propose_decision) интерфейс "
                       "посчитает исходы в карточке прогона. useImages — прокинуть "
                       "картинки из снапшота (только если они там есть и все "
                       "модели прогона vision). "
                       "Лимиты: до 5 вопросов, до 3 моделей, только запущенные.",
        "parameters": {"type": "object", "properties": {
            "questions": {"type": "array", "items": _QUESTION_SCHEMA,
                          "description": "вопросы прогона; не заданы — вопросы из "
                                         "текущего состояния"},
            "models": {"type": "array", "items": {"type": "string"},
                       "description": "ключи decision-моделей; не заданы — выбранные "
                                      "запущенные"},
            "decision": {"type": "object",
                         "properties": {"outcomes": {"type": "array",
                                                     "items": _OUTCOME_SCHEMA}},
                         "required": ["outcomes"],
                         "description": "правила решения для оценки исхода "
                                        "(формат propose_decision)"},
            "contextText": {"type": "string",
                            "description": "свой текст контекста вместо текущего"},
            "batchFile": {"type": "string",
                          "description": "имя файла батча из снапшота — прогон "
                                         "по его тексту"},
            "useImages": {"type": "boolean",
                          "description": "передать картинки контекста/файла "
                                         "vision-моделям прогона"},
        }},
    }},
    {"type": "function", "function": {
        "name": "propose_save_preset",
        "description": "Предложить сохранить текущий контекст/батч и вопросы как пресет. "
                       "Не применяет само.",
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string"},
            "description": {"type": "string"},
            "slug": {"type": "string",
                     "description": "slug существующего пресета (из list_presets) — "
                                    "обновить его, а не создавать новый"},
        }, "required": ["name"]},
    }},
    {"type": "function", "function": {
        "name": "propose_decision",
        "description": "Предложить правила решения: исходы и логические условия по "
                       "ответам на вопросы. Не применяет само. Движок детерминированный "
                       "(не LLM): исходы проверяются по порядку, побеждает первый "
                       "сработавший; ни одно правило — исход isDefault. Условия "
                       "ссылаются на вопросы по № из снапшота (поле n).",
        "parameters": {"type": "object", "properties": {
            "outcomes": {"type": "array", "items": _OUTCOME_SCHEMA},
        }, "required": ["outcomes"]},
    }},
]

TOOL_NAMES = {t["function"]["name"] for t in TOOLS}
PROPOSAL_TOOLS = {"propose_questions", "propose_context", "propose_run",
                  "propose_save_preset", "propose_decision"}
# Авто-исполняемые на сервере в агентном цикле (не read, не proposal).
ACTION_TOOLS = {"run_trial"}

TRIAL_MAX_QUESTIONS = 5
TRIAL_MAX_MODELS = 3

# ------------------------------------------------------------------ валидация


def _type_name(v: Any) -> str:
    return type(v).__name__


def _check(schema: dict, value: Any, path: str, errors: list[str]) -> None:
    """Минимальная проверка по нашей подмножеству JSON Schema."""
    t = schema.get("type")
    ok = {"object": dict, "array": list, "string": str, "number": (int, float),
          "boolean": bool}.get(t)
    if ok and not isinstance(value, ok) or (t == "string" and isinstance(value, bool)):
        errors.append(f"{path}: ожидался {t}, получен {_type_name(value)}")
        return
    enum = schema.get("enum")
    if enum and value not in enum:
        errors.append(f"{path}: значение {value!r} не из {enum}")
    if t == "object":
        for req in schema.get("required", []):
            if req not in value:
                errors.append(f"{path}: нет обязательного поля {req!r}")
        props = schema.get("properties", {})
        for k, v in value.items():
            if k in props:
                _check(props[k], v, f"{path}.{k}", errors)
    elif t == "array" and "items" in schema:
        for i, item in enumerate(value):
            _check(schema["items"], item, f"{path}[{i}]", errors)


def normalize_tool_questions(qs: list) -> tuple[list[dict] | None, str | None]:
    """Вопросы из аргументов тула → словари основной схемы приложения.
    Модель отдаёт описания веток/опции строками — приводим к schemas.Question."""
    out = []
    ids = []
    for q in qs:
        q = dict(q)
        if "description_yes" in q:
            q["yes"] = q.pop("description_yes")
        if "description_no" in q:
            q["no"] = q.pop("description_no")
        if isinstance(q.get("options"), list):
            q["options"] = [o if isinstance(o, dict) else {"name": str(o)}
                            for o in q["options"]]
        q.pop("direction", None)  # direction живёт только на фронте
        try:
            Question.model_validate(q)
        except ValidationError as e:
            return None, "Вопрос: " + "; ".join(err["msg"] for err in e.errors())
        ids.append(q["id"])
        out.append(q)
    if len(ids) != len(set(ids)):
        return None, "id вопросов должны быть уникальными"
    return out, None


def _check_decision_outcomes(outcomes: Any, tool: str) -> str | None:
    """Доменная валидация исходов решения (propose_decision и run_trial)."""
    if not isinstance(outcomes, list) or not outcomes:
        return f"{tool}: нужен хотя бы один исход"
    if sum(1 for o in outcomes if isinstance(o, dict) and o.get("isDefault")) > 1:
        return f"{tool}: исход по умолчанию может быть только один"
    for o in outcomes:
        if not isinstance(o, dict):
            return f"{tool}: исход должен быть объектом"
        for r in o.get("rules") or []:
            if not (r.get("conditions") or []):
                return (f"{tool}: у правила исхода "
                        f"«{o.get('label')}» должно быть условие")
            for c in r["conditions"]:
                has_ans = c.get("answer") is not None
                has_score = c.get("score") is not None
                if has_ans == has_score:
                    return (f"{tool}: в условии — либо "
                            "answer+threshold, либо score")
                if has_ans and c.get("threshold") is None:
                    return (f"{tool}: для answer нужен "
                            "threshold (0–100)")
    return None


def validate_args(name: str, args: Any) -> tuple[dict | None, str | None]:
    """Проверка аргументов вызова. Возвращает (args, None) или (None, ошибка)."""
    if name not in TOOL_NAMES:
        return None, f"Неизвестный инструмент {name!r}. Доступные: {sorted(TOOL_NAMES)}"
    if args is None:
        args = {}
    if not isinstance(args, dict):
        return None, f"Аргументы {name} должны быть объектом JSON"
    schema = next(t["function"]["parameters"] for t in TOOLS
                  if t["function"]["name"] == name)
    errors: list[str] = []
    _check(schema, args, name, errors)
    if errors:
        return None, "; ".join(errors)
    # доменная валидация вопросов — основной pydantic-схемой приложения
    if name == "propose_questions":
        _, error = normalize_tool_questions(args["questions"])
        if error:
            return None, error
    if name == "propose_decision":
        error = _check_decision_outcomes(args.get("outcomes"), name)
        if error:
            return None, error
    if name == "run_trial":
        if len(args.get("questions") or []) > TRIAL_MAX_QUESTIONS:
            return None, (f"run_trial: не больше {TRIAL_MAX_QUESTIONS} вопросов "
                          "за прогон — выбери самые важные")
        if len(args.get("models") or []) > TRIAL_MAX_MODELS:
            return None, f"run_trial: не больше {TRIAL_MAX_MODELS} моделей за прогон"
        if "questions" in args:
            _, error = normalize_tool_questions(args["questions"])
            if error:
                return None, error
        if args.get("decision") is not None:
            error = _check_decision_outcomes(
                (args["decision"] or {}).get("outcomes"), name)
            if error:
                return None, error
    return args, None
