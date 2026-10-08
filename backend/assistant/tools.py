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
        "description": "Список decision-моделей: ключ, статус (running/stopped), vision, тип.",
        "parameters": {"type": "object", "properties": {}},
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
        "description": "Предложить новый текст контекста (single-режим). Не применяет само.",
        "parameters": {"type": "object", "properties": {
            "text": {"type": "string"},
            "mode": {"type": "string", "enum": ["replace", "append"]},
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
                       "Только одиночный режим: текст контекста из состояния; "
                       "изображения и файлы батча не участвуют. "
                       "Лимиты: до 5 вопросов, до 3 моделей.",
        "parameters": {"type": "object", "properties": {
            "questions": {"type": "array", "items": _QUESTION_SCHEMA,
                          "description": "вопросы прогона; не заданы — вопросы из "
                                         "текущего состояния"},
            "models": {"type": "array", "items": {"type": "string"},
                       "description": "ключи decision-моделей; не заданы — выбранные "
                                      "запущенные"},
        }},
    }},
    {"type": "function", "function": {
        "name": "propose_save_preset",
        "description": "Предложить сохранить текущий контекст/батч и вопросы как пресет. "
                       "Не применяет само.",
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string"},
            "description": {"type": "string"},
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
        outcomes = args.get("outcomes") or []
        if not outcomes:
            return None, "propose_decision: нужен хотя бы один исход"
        if sum(1 for o in outcomes if o.get("isDefault")) > 1:
            return None, "propose_decision: исход по умолчанию может быть только один"
        for o in outcomes:
            for r in o.get("rules") or []:
                if not (r.get("conditions") or []):
                    return None, (f"propose_decision: у правила исхода "
                                  f"«{o.get('label')}» должно быть условие")
                for c in r["conditions"]:
                    has_ans = c.get("answer") is not None
                    has_score = c.get("score") is not None
                    if has_ans == has_score:
                        return None, ("propose_decision: в условии — либо "
                                      "answer+threshold, либо score")
                    if has_ans and c.get("threshold") is None:
                        return None, ("propose_decision: для answer нужен "
                                      "threshold (0–100)")
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
    return args, None
