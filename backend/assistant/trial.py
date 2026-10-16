"""Пробный прогон (инструмент run_trial): вопросы × decision-модели на тексте
контекста из снапшота (или подменённом тексте / тексте файла пакета).
Исполняется сразу на сервере в агентном цикле (не proposal). Картинки живут в
браузере и попадают на сервер только внутри снапшота (когда у chat-модели
ассистента vision) — с useImages они прокидываются vision-моделям прогона.
Правила решения (decision) сервер не вычисляет: они прокидываются в
SSE-событии trial, исходы считает движок на фронте."""
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


def _short_answer(ans: dict | None, q: dict | None = None) -> str:
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
        score = ans.get("score", 0)
        levels = (q or {}).get("levels") or []
        if levels:
            top_i = len(levels) - 1
            lvl = levels[min(max(round(score), 0), top_i)]
            return f"{score:.2f} из {top_i} («{lvl}»)"
        return f"{score:.2f}"
    return "—"


def _questions_from_snapshot(snapshot: dict) -> list[dict]:
    # В снапшоте id нет (фронт отдаёт только n/текст) — генерируем q1..qN,
    # чтобы пройти доменную валидацию Question.
    out = []
    for i, q in enumerate(snapshot.get("questions") or []):
        if not isinstance(q, dict):
            continue
        q = dict(q)
        q.setdefault("id", f"q{i + 1}")
        out.append(q)
    return out


def _questions_by_nums(snapshot: dict, nums: list) -> tuple[list[dict] | None,
                                                            str | None]:
    """Выбор существующих вопросов по № из снапшота (поле n) — без
    сериализации полных объектов моделью."""
    all_q = _questions_from_snapshot(snapshot)
    if not all_q:
        return None, "В состоянии нет вопросов."
    out = []
    for raw in nums:
        n = int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) \
            else None
        if n is None or n < 1 or n > len(all_q):
            return None, (f"questionNums: вопроса №{raw} нет — в наборе "
                          f"{len(all_q)} вопросов")
        q = all_q[n - 1]
        if q not in out:
            out.append(q)
    return normalize_tool_questions(out)


def _selected_keys(snapshot: dict) -> list[str]:
    """Ключи выбранных в баре моделей из снапшота (элементы — {key, status}
    или, из старых клиентов, голые ключи)."""
    keys = []
    for item in snapshot.get("selectedModels") or []:
        keys.append(item.get("key") if isinstance(item, dict) else item)
    return [k for k in keys if isinstance(k, str)]


async def _default_models(snapshot: dict) -> list[str]:
    """Выбранные в баре decision-модели со статусом running (≤ TRIAL_MAX_MODELS)."""
    keys = [k for k in _selected_keys(snapshot)
            if k in mm.REGISTRY and mm.REGISTRY[k].enabled
            and "decision" in mm.REGISTRY[k].roles]
    running = []
    for key in keys:
        st = await mm.model_status(mm.REGISTRY[key])
        if st.get("status") == "running":
            running.append(key)
    return running


def _resolve_context(snapshot: dict, args: dict) -> tuple[str | None, dict | None,
                                                         dict | None]:
    """Текст прогона и (при batchFile) запись файла из снапшота.
    → (text, file_entry, error)."""
    if args.get("contextText") is not None:
        return str(args["contextText"]).strip(), None, None
    if args.get("batchFile"):
        name = str(args["batchFile"])
        files = snapshot.get("batchFiles") or []
        entry = next((f for f in files
                      if isinstance(f, dict) and f.get("name") == name), None)
        if entry is None:
            available = [f.get("name") for f in files if isinstance(f, dict)]
            return None, None, {
                "ok": False,
                "error": f"Файл {name!r} не найден в снапшоте. "
                         f"Доступные: {', '.join(map(str, available)) or 'нет'}."}
        return str(entry.get("text") or "").strip(), entry, None
    if snapshot.get("page") == "batch":
        return None, None, {
            "ok": False,
            "error": "Страница «Пакет материалов»: текста материала нет. Укажи batchFile "
                     "(прогон по тексту одного файла) или contextText, либо "
                     "предложи полный прогон через propose_run."}
    return ((snapshot.get("context") or {}).get("text") or "").strip(), None, None


def _resolve_images(snapshot: dict, file_entry: dict | None,
                    args: dict, keys: list[str]) -> tuple[list | None,
                                                          str | None,
                                                          dict | None]:
    """Картинки для прогона при useImages. → (images, note, error).
    Картинки есть в снапшоте, только если у chat-модели ассистента vision."""
    available: list[str] = []
    if file_entry is not None:
        available = [u for u in file_entry.get("images") or []
                     if isinstance(u, str)]
    else:
        available = [u for u in (snapshot.get("context") or {}).get("images") or []
                     if isinstance(u, str)]
    if not args.get("useImages"):
        return None, None, None
    if not available:
        return None, ("useImages: в снапшоте нет данных изображений (они "
                      "передаются, только если у модели ассистента vision) — "
                      "прогон по одному тексту."), None
    no_vision = [k for k in keys if not mm.REGISTRY[k].vision]
    if no_vision:
        return None, None, {
            "ok": False,
            "error": "useImages: модели без поддержки изображений: "
                     f"{', '.join(no_vision)}. Убери их из models или вызови "
                     "без useImages."}
    return available, None, None


def _derive_changes(snapshot: dict, args: dict, keys: list[str]) -> str:
    """Подпись «что изменено» выводится кодом из параметров вызова, а не прозой
    модели (инцидент: поле changes маскировалось под канал действия — модель
    писала намерение в подпись вместо параметров models/questionNums)."""
    parts = []
    if args.get("questionNums"):
        nums = ", ".join("№" + str(int(n)) for n in args["questionNums"])
        parts.append(f"вопросы {nums}")
    elif args.get("questions"):
        parts.append(f"свои формулировки ({len(args['questions'])} шт.)")
    if args.get("models") and set(keys) != set(_selected_keys(snapshot)):
        parts.append("другие модели: " + ", ".join(keys))
    if args.get("contextText"):
        parts.append("свой текст материала")
    if args.get("batchFile"):
        parts.append(f"текст файла «{args['batchFile']}»")
    if args.get("decision"):
        parts.append("свои правила решения")
    if args.get("useImages"):
        parts.append("с картинками")
    return "; ".join(parts)


async def run_trial(snapshot: dict | None, args: dict) -> tuple[dict, list[dict]]:
    """→ (результат для tool-сообщения модели, доп. SSE-события для UI).
    Событие trial: {questions, models, rows, title?, changes?, decision?, note?};
    UI не мутируется. rows[].fullAnswers — сырые ответы (для evaluateDecision
    на фронте)."""
    snapshot = snapshot or {}

    # --- вопросы
    if args.get("questions") and args.get("questionNums"):
        return {"ok": False, "error": "Либо questions (свои формулировки), "
                                      "либо questionNums (номера существующих) "
                                      "— не вместе."}, []
    if args.get("questions"):
        questions, error = normalize_tool_questions(args["questions"])
        if error:
            return {"ok": False, "error": error}, []
    elif args.get("questionNums"):
        questions, error = _questions_by_nums(snapshot, args["questionNums"])
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
                "error": f"Вопросов больше {TRIAL_MAX_QUESTIONS} — выбери до "
                         f"{TRIAL_MAX_QUESTIONS} самых важных: questionNums "
                         "(номера из снапшота) или questions (свои формулировки)."}, []

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
                not_running.append(f"{key} (статус: {st.get('status')})")
        if not_running:
            return {"ok": False,
                    "error": f"Модели не запущены: {', '.join(not_running)}. "
                             "Запустить их может только пользователь на странице "
                             "«Модели» — выбери другие или предложи запуск."}, []
    else:
        keys = await _default_models(snapshot)
        all_selected = [k for k in _selected_keys(snapshot) if k in mm.REGISTRY]
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

    # --- контекст
    text, file_entry, error = _resolve_context(snapshot, args)
    if error:
        return error, []
    if not text:
        return {"ok": False, "error": "Пустой текст материала — нечего прогонять."}, []

    # --- изображения
    images, img_note, error = _resolve_images(snapshot, file_entry, args, keys)
    if error:
        return error, []
    if img_note:
        note = f"{note} {img_note}" if note else img_note
    if not args.get("useImages"):
        images_count = (len(file_entry.get("images") or [])
                        if file_entry is not None
                        else (snapshot.get("context") or {}).get("imagesCount") or 0)
        if images_count:
            img_note = (f"Изображения ({images_count}) в пробном прогоне не "
                        "участвовали — для прогона с картинками вызови с "
                        "useImages: true.")
            note = f"{note} {img_note}" if note else img_note

    req = DecideRequest(input=text, questions=questions, models=keys,
                        mode="decisions", images=images or None)
    from backend import app as app_module  # лениво: app импортирует assistant.router
    # started=True: прогон реально пошёл (ресурсы потрачены) — такие попытки
    # считает антиспам-лимит run_trial_limited; ошибки предпроверок выше — нет.
    try:
        resp = await asyncio.wait_for(app_module.decide(req), timeout=TRIAL_TIMEOUT_S)
    except asyncio.TimeoutError:
        return {"ok": False, "started": True,
                "error": f"Пробный прогон не уложился в {int(TRIAL_TIMEOUT_S)} с."}, []
    if isinstance(resp, JSONResponse):
        try:
            detail = json.loads(resp.body).get("detail", "ошибка валидации")
        except (JSONDecodeError, AttributeError):
            detail = "ошибка запуска прогона"
        return {"ok": False, "started": True, "error": str(detail)}, []

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
        cells = {q["id"]: _short_answer(answers.get(q["id"]), q) for q in questions}
        rows.append({"model": key, "label": entry.label, "answers": cells,
                     "fullAnswers": {q["id"]: answers.get(q["id"])
                                     for q in questions
                                     if answers.get(q["id"]) is not None}})
        lines.append(f"{key}: " + "; ".join(
            f"{str(q['question'])[:50]} → {cells[q['id']]}" for q in questions))

    trial_event = {
        "questions": [{"id": q["id"], "question": q["question"], "type": q["type"]}
                      for q in questions],
        "models": keys,
        "rows": rows,
    }
    if args.get("title"):
        trial_event["title"] = str(args["title"])
    changes = _derive_changes(snapshot, args, keys)
    if changes:
        trial_event["changes"] = changes
    if args.get("decision"):
        # Правила не вычисляются на сервере — исходы считает движок на фронте.
        trial_event["decision"] = args["decision"]
        note = (f"{note} Исходы по правилам decision посчитает интерфейс в "
                "карточке прогона — в сводке их нет." if note else
                "Исходы по правилам decision посчитает интерфейс в карточке "
                "прогона — в сводке их нет.")
    if note:
        trial_event["note"] = note
    result = {"ok": True, "summary": "\n".join(lines)}
    if note:
        result["note"] = note
    return result, [{"type": "trial", "trial": trial_event}]


TRIALS_PER_REPLY = 2  # антиспам: пробных прогонов на один ответ пользователя


def run_trial_limited(snapshot: dict | None):
    """Фабрика run_trial с лимитом на одно сообщение пользователя (v0.7:
    серии из 4–6 пробных прогонов подряд спамили ленту и сжигали бюджет
    шагов агента, не доходя до предложения)."""
    calls = 0

    async def _run(args: dict) -> tuple[dict, list[dict]]:
        nonlocal calls
        if calls >= TRIALS_PER_REPLY:
            return {"ok": False,
                    "error": (f"Лимит пробных прогонов на один ответ ({TRIALS_PER_REPLY}). "
                              "Сделай вывод по имеющимся данным текстом "
                              "или предложением (propose_*).")}, []
        result, events = await run_trial(snapshot, args)
        # Лимит тратят только реально запущенные прогоны: ошибка предпроверок
        # (модель не запущена, нет файла) ничего не жжёт и лимит не ест.
        # Ключ started НЕ снимаем: _exec_tool по нему отличает предпроверку
        # (internal, скрыта из ленты) от сбоя выполнения (видим пользователю).
        if result.get("ok") or result.get("started"):
            calls += 1
        return result, events
    return _run
