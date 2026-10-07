"""Пробный прогон (инструмент run_trial): вопросы × decision-модели на тексте
контекста из снапшота. Исполняется сразу на сервере в агентном цикле (не
proposal). Только одиночный режим: изображения и файлы батча живут в браузере
и на сервер не передаются — для страницы «Батч» возвращаем модели внятную
ошибку."""
from __future__ import annotations

import asyncio
import json
from json import JSONDecodeError

from fastapi.responses import JSONResponse

from backend import model_manager as mm
from backend.assistant.tools import (TRIAL_MAX_MODELS, TRIAL_MAX_QUESTIONS,
                                     normalize_tool_questions)
from backend.schemas import DecideRequest

TRIAL_TIMEOUT_S = 300.0  # общий таймаут прогона поверх помодельных REQUEST_TIMEOUT


def _short_answer(ans: dict | None) -> str:
    """Компактный «ответ · уверенность» — как shortAnswer на фронте."""
    if not ans:
        return "—"
    p = ans.get("probabilities") or {}
    t = ans.get("type")
    if t == "yes_no":
        yes, no = p.get("yes", 0), p.get("no", 0)
        return f"да {yes:.0%}" if yes >= no else f"нет {no:.0%}"
    if t == "choice":
        top = max(p.items(), key=lambda kv: kv[1], default=None)
        label = ans.get("choice") or (top[0] if top else "—")
        return f"{label} {top[1]:.0%}" if top else label
    if t == "score":
        return f"{ans.get('score', 0):.2f}"
    return "—"


def _confidence(ans: dict | None) -> float | None:
    if not ans:
        return None
    vals = list((ans.get("probabilities") or {}).values())
    return max(vals) if vals else None


def _questions_from_snapshot(snapshot: dict) -> list[dict]:
    return [q for q in (snapshot.get("questions") or []) if isinstance(q, dict)]


async def _default_models(snapshot: dict) -> list[str]:
    """Выбранные в баре decision-модели со статусом running (≤ TRIAL_MAX_MODELS)."""
    keys = [k for k in (snapshot.get("selectedModels") or [])
            if k in mm.REGISTRY and mm.REGISTRY[k].enabled
            and "decision" in mm.REGISTRY[k].roles]
    running = []
    for key in keys:
        st = await mm.model_status(mm.REGISTRY[key])
        if st.get("status") == "running":
            running.append(key)
    return running


async def run_trial(snapshot: dict | None, args: dict) -> tuple[dict, list[dict]]:
    """→ (результат для tool-сообщения модели, доп. SSE-события для UI).
    Событие trial: {questions, models, rows, note?}; UI не мутируется."""
    snapshot = snapshot or {}
    if snapshot.get("page") == "batch":
        return {"ok": False,
                "error": "Пробный прогон работает только в одиночном режиме: "
                         "файлы батча живут в браузере и недоступны серверу. "
                         "Предложи пользователю полный прогон через propose_run "
                         "или переключись на одиночный контекст."}, []

    # --- вопросы
    if args.get("questions"):
        questions, error = normalize_tool_questions(args["questions"])
        if error:
            return {"ok": False, "error": error}, []
    else:
        questions, error = normalize_tool_questions(_questions_from_snapshot(snapshot))
        if error:
            return {"ok": False, "error": error}, []
        if not questions:
            return {"ok": False, "error": "В состоянии нет вопросов — задай их "
                                          "в аргументе questions."}, []
    if len(questions) > TRIAL_MAX_QUESTIONS:
        return {"ok": False,
                "error": f"Вопросов больше {TRIAL_MAX_QUESTIONS} — укажи в аргументе "
                         "questions до 5 самых важных."}, []

    # --- модели
    note = None
    if args.get("models"):
        keys = [k for k in args["models"] if k in mm.REGISTRY]
        unknown = [k for k in args["models"] if k not in mm.REGISTRY]
        if unknown:
            return {"ok": False, "error": f"Неизвестные модели: {', '.join(unknown)}"}, []
        not_running = []
        for key in keys:
            st = await mm.model_status(mm.REGISTRY[key])
            if st.get("status") != "running":
                not_running.append(key)
        if not_running:
            return {"ok": False,
                    "error": f"Модели не запущены: {', '.join(not_running)}. "
                             "Запустить их может только пользователь на странице "
                             "«Модели» — выбери другие или предложи запуск."}, []
    else:
        keys = await _default_models(snapshot)
        all_selected = [k for k in (snapshot.get("selectedModels") or [])
                        if k in mm.REGISTRY]
        if len(keys) > TRIAL_MAX_MODELS:
            keys = keys[:TRIAL_MAX_MODELS]
            note = (f"Выбрано больше {TRIAL_MAX_MODELS} моделей — прогнал первые "
                    f"{TRIAL_MAX_MODELS}.")
        elif len(all_selected) > len(keys):
            note = "Часть выбранных моделей не запущена и пропущена."
    if not keys:
        return {"ok": False,
                "error": "Нет запущенных decision-моделей (из выбранных в баре). "
                         "Укажи models явно или предложи пользователю запустить модель."}, []

    # --- контекст: только текст; изображения живут в браузере
    text = ((snapshot.get("context") or {}).get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "Пустой текст контекста — нечего прогонять."}, []
    images_count = (snapshot.get("context") or {}).get("imagesCount") or 0
    if images_count:
        img_note = (f"Изображения контекста ({images_count}) в пробном прогоне "
                    "не участвовали — их данные живут в браузере.")
        note = f"{note} {img_note}" if note else img_note

    req = DecideRequest(input=text, questions=questions, models=keys,
                        mode="decisions")
    from backend import app as app_module  # лениво: app импортирует assistant.router
    try:
        resp = await asyncio.wait_for(app_module.decide(req), timeout=TRIAL_TIMEOUT_S)
    except asyncio.TimeoutError:
        return {"ok": False,
                "error": f"Пробный прогон не уложился в {int(TRIAL_TIMEOUT_S)} с."}, []
    if isinstance(resp, JSONResponse):
        try:
            detail = json.loads(resp.body).get("detail", "ошибка валидации")
        except (JSONDecodeError, AttributeError):
            detail = "ошибка запуска прогона"
        return {"ok": False, "error": str(detail)}, []

    results = resp.get("results", {})
    rows = []
    lines = []
    for key in keys:
        entry = mm.REGISTRY[key]
        res = results.get(key) or {}
        if not res.get("ok"):
            rows.append({"model": key, "label": entry.label,
                         "error": res.get("error", "ошибка прогона")})
            lines.append(f"{key}: ОШИБКА — {res.get('error')}")
            continue
        answers = res.get("answers") or {}
        cells = {q["id"]: _short_answer(answers.get(q["id"])) for q in questions}
        rows.append({"model": key, "label": entry.label, "answers": cells})
        lines.append(f"{key}: " + "; ".join(
            f"{q['id']} → {cells[q['id']]}" for q in questions))

    trial_event = {
        "questions": [{"id": q["id"], "question": q["question"], "type": q["type"]}
                      for q in questions],
        "models": keys,
        "rows": rows,
    }
    if note:
        trial_event["note"] = note
    result = {"ok": True, "summary": "\n".join(lines)}
    if note:
        result["note"] = note
    return result, [{"type": "trial", "trial": trial_event}]
