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
        "direction": {"type": "string", "enum": ["up", "down", "yes", "no", "neutral"],
                      "description": "score: up = выше лучше, down = ниже лучше; "
                                     "yes_no: yes = «да» лучше, no = «нет» лучше"},
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
        "description": "Текущее состояние приложения: режим (single/batch), материал, "
                       "вопросы, файлы пакета, выбранные модели, сводка последних результатов.",
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
        "description": "Детали по одному файлу пакета из снапшота: текст файла и "
                       "результаты прогона по нему (ответы с уверенностью на "
                       "вопросы и решение на модель). Используй, когда агрегатов "
                       "resultsSummary недостаточно.",
        "parameters": {"type": "object", "properties": {
            "file": {"type": "string",
                     "description": "имя файла из снапшота (batchFiles[].name)"},
        }, "required": ["file"]},
    }},
    {"type": "function", "function": {
        "name": "get_result",
        "description": "Детали одиночного прогона из снапшота: по каждой модели "
                       "ответы на вопросы с полным распределением вероятностей "
                       "(singleResults) и trace решений (почему сработал/не сработал "
                       "исход — значения условий и запас до порога). Используй, когда "
                       "агрегатов resultsSummary недостаточно.",
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
                     "description": "append — добавить к текущим; replace — "
                                    "ПОЛНАЯ замена всего набора: questions должен "
                                    "содержать ВСЕ итоговые вопросы, включая "
                                    "неизменённые. Точечная правка (изменить или "
                                    "разбить вопрос №N) — replace с полным "
                                    "набором, где №N изменён/разбит, остальные "
                                    "как были"},
        }, "required": ["questions", "mode"]},
    }},
    {"type": "function", "function": {
        "name": "propose_context",
        "description": "Предложить новый текст материала (single-режим) или, с "
                       "параметром file, текст конкретного файла пакета. "
                       "Не применяет само.",
        "parameters": {"type": "object", "properties": {
            "text": {"type": "string"},
            "mode": {"type": "string", "enum": ["replace", "append"]},
            "file": {"type": "string",
                     "description": "имя файла пакета из снапшота — правка его "
                                    "текста вместо материала одиночного режима"},
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
                       "Текст — материал из состояния; можно подменить своим "
                       "(contextText) или взять текст файла пакета (batchFile). "
                       "С decision (правила как в propose_decision) интерфейс "
                       "посчитает исходы в карточке прогона. useImages — прокинуть "
                       "картинки из снапшота (только если они там есть и все "
                       "модели прогона vision). Всегда заполняй title "
                       "(гипотеза прогона — что проверяем); подпись «что "
                       "изменено» интерфейс выведет из параметров сам. Пример "
                       "прогона текущих вопросов №1–5 на другой модели: "
                       "{\"models\": [\"<ключ>\"], \"questionNums\": [1,2,3,4,5], "
                       "\"title\": \"...\"}. "
                       "Лимиты: до 5 вопросов, до 3 моделей, только запущенные.",
        "parameters": {"type": "object", "properties": {
            "questions": {"type": "array", "items": _QUESTION_SCHEMA,
                          "description": "вопросы прогона полными объектами — только "
                                         "для what-if со СВОИМИ формулировками; для "
                                         "подмножества текущих — questionNums; не "
                                         "задано ничего — вопросы из состояния"},
            "questionNums": {"type": "array", "items": {"type": "number"},
                             "description": "номера существующих вопросов из снапшота "
                                            "(поле n), до 5 — выбор подмножества без "
                                            "сериализации объектов"},
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
                            "description": "свой текст материала вместо текущего"},
            "batchFile": {"type": "string",
                          "description": "имя файла пакета из снапшота — прогон "
                                         "по его тексту"},
            "useImages": {"type": "boolean",
                          "description": "передать картинки материала/файла "
                                         "vision-моделям прогона"},
            "title": {"type": "string",
                      "description": "ОБЯЗАТЕЛЬНО: короткое название/гипотеза "
                                     "прогона — что проверяем (до ~120 "
                                     "символов)"},
        }},
    }},
    {"type": "function", "function": {
        "name": "propose_save_preset",
        "description": "Предложить сохранить текущие материалы/пакет и вопросы как пресет. "
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
            loc = f"Вопрос №{len(out) + 1} (id {q.get('id')!r})"
            return None, loc + ": " + "; ".join(err["msg"] for err in e.errors())
        ids.append(q["id"])
        out.append(q)
    if len(ids) != len(set(ids)):
        return None, "id вопросов должны быть уникальными"
    return out, None


_CONDITION_FIELDS = {"question", "answer", "op", "threshold", "score"}


def _check_decision_outcomes(outcomes: Any, tool: str) -> str | None:
    """Доменная валидация исходов решения (propose_decision и run_trial).
    Сообщения — самопочинимые: локатор (исход/правило/условие) и ветка
    ошибки, иначе модель гадает, что чинить, и жжёт шаги на повторы."""
    if not isinstance(outcomes, list) or not outcomes:
        return f"{tool}: нужен хотя бы один исход"
    if sum(1 for o in outcomes if isinstance(o, dict) and o.get("isDefault")) > 1:
        return f"{tool}: исход по умолчанию может быть только один"
    labels = [o.get("label") for o in outcomes if isinstance(o, dict)]
    if len(labels) != len(set(labels)):
        dup = next(lb for lb in labels if labels.count(lb) > 1)
        return (f"{tool}: исход «{dup}» встречается дважды — названия исходов "
                "должны быть уникальными")
    for o in outcomes:
        if not isinstance(o, dict):
            return f"{tool}: исход должен быть объектом"
        for ri, r in enumerate(o.get("rules") or []):
            if not (r.get("conditions") or []):
                return (f"{tool}: у правила исхода "
                        f"«{o.get('label')}» должно быть условие")
            for ci, c in enumerate(r["conditions"]):
                loc = (f"{tool}: исход «{o.get('label')}», правило {ri + 1}, "
                       f"условие {ci + 1} (вопрос №{c.get('question')})")
                unknown = set(c) - _CONDITION_FIELDS
                if unknown:
                    return (f"{loc}: неизвестное поле "
                            f"«{sorted(unknown)[0]}» (доступные: question, "
                            "answer, op, threshold, score)")
                has_ans = c.get("answer") is not None
                has_score = c.get("score") is not None
                if has_ans and has_score:
                    return (f"{loc}: заданы и answer, и score — оставь одно "
                            "из двух (answer+threshold для yes_no/choice, "
                            "score для шкалы)")
                if not has_ans and not has_score:
                    return (f"{loc}: нет ни answer, ни score — для "
                            "yes_no/choice задай answer+threshold, для "
                            "score-вопроса — score")
                if has_ans and c.get("threshold") is None:
                    return (f"{loc}: для answer нужен threshold (0–100)")
                if c.get("answer") in ("да", "нет"):
                    return (f"{loc}: answer «{c['answer']}» недопустим — для "
                            "yes/no-вопроса задай yes или no (англ.), для "
                            "choice — точное имя опции из вопроса")
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
        if len(args.get("questionNums") or []) > TRIAL_MAX_QUESTIONS:
            return None, (f"run_trial: не больше {TRIAL_MAX_QUESTIONS} вопросов "
                          "за прогон — questionNums до "
                          f"{TRIAL_MAX_QUESTIONS} номеров")
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
