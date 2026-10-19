"""Детерминированный анализ прогона (ассистент v1.1): карточка «Разбор
прогона» и очередь «Что разметить дальше».

Разделение труда: частоты, группировку и отбор кандидатов считает КОД,
модель только называет причины текстом. Чистые функции от снапшота (dict,
который фронт шлёт в /api/assistant/chat), без LLM и без состояния приложения.

Источники данных снапшота (buildSnapshot в assistant.js):
- batchResults {имя файла: {ключ модели: {answers: {№: «да · 87%»}, …}}} —
  короткие ответы shortAnswer (label · conf% для yes_no/choice, «3.71» для
  score); batchFiles[{num, id, name}] — мост имя → id файла;
- singleResults {короткий лейбл модели: [{n, answer, distribution?}]};
- decision — правила решения (условия: question=n, op, answer+threshold %
  или score);
- reviewMarks {totals, items, targets?} — targets: структурные координаты
  пометок {sc, v, c?, q?, qid?, m?, ml?, f?, fid?, dec?, md?} (модель видит
  текстовые items, targets — для этого модуля).
"""
from __future__ import annotations

import re
from typing import Any

# shortAnswer фронта: «да · 87%» / «цена · 55%»; score — «3.71».
_ANSWER_RE = re.compile(r"^(.*) · (\d+(?:[.,]\d+)?)%$")
_SCORE_RE = re.compile(r"^-?\d+(?:[.,]\d+)?$")

LOW_CONFIDENCE = 0.60      # уверенность top-ответа ниже — кандидат/категория
THRESHOLD_MARGIN_PP = 10   # близость к порогу вероятности, п.п.
SCORE_MARGIN = 0.5         # близость к порогу среднего балла
SCORE_DISAGREE_GAP = 1.0   # расхождение score-ответов моделей
QUEUE_DEFAULT_LIMIT = 5
QUEUE_MAX_LIMIT = 10
MAX_CATEGORY_CELLS = 5     # сколько ячеек несёт категория для навигатора
MAX_COMMENTS = 5           # сколько комментариев вербатим в разборе

_ANSWER_DISPLAY = {"yes": "да", "no": "нет"}


def _plural(n: int, one: str, few: str, many: str) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} {one}"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return f"{n} {few}"
    return f"{n} {many}"


def _parse_answer(text: Any) -> dict | None:
    """Строка shortAnswer → {label, conf} или {score}; None — не распознано."""
    if not isinstance(text, str):
        return None
    text = text.strip()
    m = _ANSWER_RE.match(text)
    if m:
        return {"label": m.group(1),
                "conf": float(m.group(2).replace(",", ".")) / 100}
    if _SCORE_RE.match(text):
        return {"label": None, "score": float(text.replace(",", "."))}
    return None


def _questions_by_n(snapshot: dict) -> dict[int, dict]:
    return {q["n"]: q for q in snapshot.get("questions") or []
            if isinstance(q, dict) and isinstance(q.get("n"), (int, float))}


def _collect_cells(snapshot: dict, page: str) -> list[dict] | None:
    """Плоский список ячеек результатов активной страницы:
    {unit (имя файла | None), fid, model (ключ для batch / лейбл для single),
    qn, qid, label, conf, score}. None — результатов нет."""
    questions = _questions_by_n(snapshot)
    cells: list[dict] = []
    if page == "batch":
        results = snapshot.get("batchResults") or {}
        if not isinstance(results, dict) or not results:
            return None
        fid_by_name = {f.get("name"): f.get("id")
                       for f in snapshot.get("batchFiles") or []
                       if isinstance(f, dict)}
        for fname, per_model in results.items():
            if not isinstance(per_model, dict):
                continue
            for mk, entry in per_model.items():
                if not isinstance(entry, dict) or entry.get("error"):
                    continue
                for qn_s, ans_text in (entry.get("answers") or {}).items():
                    parsed = _parse_answer(ans_text)
                    if parsed is None:
                        continue
                    try:
                        qn = int(qn_s)
                    except (TypeError, ValueError):
                        continue
                    q = questions.get(qn) or {}
                    cells.append({"unit": fname, "fid": fid_by_name.get(fname),
                                  "model": mk, "qn": qn,
                                  "qid": q.get("id"), "qtype": q.get("type"),
                                  **parsed})
        return cells
    results = snapshot.get("singleResults") or {}
    if not isinstance(results, dict) or not results:
        return None
    for label, rows in results.items():
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            parsed = _parse_answer(row.get("answer"))
            qn = row.get("n")
            if parsed is None or not isinstance(qn, (int, float)):
                continue
            q = questions.get(int(qn)) or {}
            cells.append({"unit": None, "fid": None, "model": label,
                          "qn": int(qn), "qid": q.get("id"),
                          "qtype": q.get("type"), **parsed})
    return cells


# ------------------------------------------------------------------ пометки

def _mark_targets(snapshot: dict) -> list[dict]:
    marks = snapshot.get("reviewMarks") or {}
    return [t for t in marks.get("targets") or [] if isinstance(t, dict)]


def _marked_keys(targets: list[dict], page: str) -> tuple[set, set]:
    """(ячейки, вопросы-целиком) с пометками. Batch-ячейка: (fid, qid, m);
    single-ячейка: (qid, ml). Вопрос целиком: qid без модели."""
    cells: set = set()
    questions: set = set()
    for t in targets:
        if t.get("sc") != page:
            continue
        qid = t.get("qid")
        if not qid:
            continue
        model = t.get("m")
        if model:
            key = (t.get("fid"), qid, model) if page == "batch" \
                else (qid, t.get("ml") or model)
            cells.add(key)
        else:
            questions.add(qid)
    return cells, questions


def _cell_target(cell: dict, page: str) -> dict:
    """Координаты revealTarget фронта (конвенция review.js targetKey)."""
    if page == "batch":
        return {"scope": "batch", "file": cell.get("fid") or cell.get("unit"),
                "question": cell.get("qid"), "model": cell.get("model")}
    return {"scope": "single", "question": cell.get("qid"),
            "modelLabel": cell.get("model")}


def _question_target(qid: str | None) -> dict:
    return {"scope": "single", "question": qid}


def _is_marked(cell: dict, page: str, marked_cells: set) -> bool:
    key = (cell.get("fid"), cell.get("qid"), cell.get("model")) \
        if page == "batch" else (cell.get("qid"), cell.get("model"))
    return key in marked_cells


# ------------------------------------------------------------------ метрики

def _fmt_score(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def _answers_text(cells: list[dict], limit: int = 3) -> str:
    parts = []
    for c in cells[:limit]:
        ans = f"«{c['label']}» {_pct(c['conf'])}" if c.get("label") is not None \
            else _fmt_score(c.get("score") or 0)
        parts.append(f"{c['model']}={ans}")
    return ", ".join(parts)


def _pct(conf: float | None) -> str:
    return f"{round((conf or 0) * 100)}%"


def _disagree_reason(group: list[dict]) -> str:
    """Причина расхождения по группе ячеек (все модели одного файла/вопроса)."""
    labels = [c for c in group if c.get("label") is not None]
    if labels:
        answers = sorted({c["label"] for c in labels})
        return "⚡ модели разошлись: " + " vs ".join(f"«{a}»"
                                                    for a in answers[:3])
    vals = sorted(c["score"] for c in group if c.get("score") is not None)
    return (f"⚡ модели разошлись: {_fmt_score(vals[0])} vs "
            f"{_fmt_score(vals[-1])} балла")


def _disagreements(cells: list[dict], page: str) -> list[dict]:
    """Расхождения моделей по вопросам: [{qn, units: [unit|None], cells}].
    Batch — группировка по (вопрос, файл); single — по вопросу (между моделями).
    Порог: разные top-ответы или разброс score ≥ SCORE_DISAGREE_GAP."""
    groups: dict = {}
    for c in cells:
        key = (c["qn"], c["unit"]) if page == "batch" else (c["qn"],)
        groups.setdefault(key, []).append(c)
    by_q: dict[int, dict] = {}
    for key, group in groups.items():
        qn = key[0]
        if len(group) < 2:
            continue
        labels = [c.get("label") for c in group if c.get("label") is not None]
        scores = [c.get("score") for c in group if c.get("score") is not None]
        disagree = len(set(labels)) > 1 if labels else False
        if not disagree and len(scores) >= 2:
            disagree = max(scores) - min(scores) >= SCORE_DISAGREE_GAP
        if not disagree:
            continue
        entry = by_q.setdefault(qn, {"qn": qn, "units": [], "cells": []})
        entry["units"].append(c["unit"] if page == "batch" else None)
        entry["cells"].extend(group)
    return sorted(by_q.values(), key=lambda e: -len(e["units"]))


def _low_confidence(cells: list[dict]) -> list[dict]:
    return [c for c in cells
            if c.get("conf") is not None and c["conf"] < LOW_CONFIDENCE]


def _decision_conditions(snapshot: dict) -> list[dict]:
    """Плоский список условий правил решения с контекстом исхода."""
    out = []
    decision = snapshot.get("decision") or {}
    for o in decision.get("outcomes") or []:
        if not isinstance(o, dict):
            continue
        for r in o.get("rules") or []:
            for c in r.get("conditions") or []:
                if isinstance(c, dict) and isinstance(
                        c.get("question"), (int, float)):
                    out.append({**c, "outcome": o.get("label")})
    return out


def _condition_text(cond: dict) -> str:
    op = "<" if cond.get("op") == "lt" else "≥"
    if cond.get("answer") is not None:
        ans = _ANSWER_DISPLAY.get(cond["answer"], cond["answer"])
        return (f"вопрос №{int(cond['question'])}: P(«{ans}») {op} "
                f"{round(cond.get('threshold') or 0)}%")
    return (f"вопрос №{int(cond['question'])}: балл {op} "
            f"{_fmt_score(cond.get('score') or 0)}")


def _near_threshold(cells: list[dict], snapshot: dict) -> list[dict]:
    """Ячейки вблизи порога условия решения:
    [{cell, cond, value, threshold, margin}]."""
    questions = _questions_by_n(snapshot)
    out = []
    for cond in _decision_conditions(snapshot):
        qn = int(cond["question"])
        qtype = (questions.get(qn) or {}).get("type")
        for cell in cells:
            if cell["qn"] != qn:
                continue
            if cond.get("answer") is not None:
                threshold = float(cond.get("threshold") or 0)
                display = _ANSWER_DISPLAY.get(cond["answer"], cond["answer"])
                if cell.get("label") == display:
                    value = (cell.get("conf") or 0) * 100
                elif qtype == "yes_no" and cell.get("conf") is not None:
                    value = (1 - cell["conf"]) * 100  # две ветки — дополнение
                else:
                    continue  # choice: доля не-top варианта неизвестна
                margin = abs(value - threshold)
                if margin > THRESHOLD_MARGIN_PP:
                    continue
            else:
                if cell.get("score") is None or cond.get("score") is None:
                    continue
                value = float(cell["score"])
                threshold = float(cond["score"])
                margin = abs(value - threshold)
                if margin > SCORE_MARGIN:
                    continue
            out.append({"cell": cell, "cond": cond, "value": value,
                        "threshold": threshold, "margin": margin})
    return out


# ------------------------------------------------------------------ разбор

def compute_run_analysis(snapshot: dict | None) -> dict:
    """Метрики прогона активной страницы → payload карточки «Разбор прогона».
    Пустой результат → {"empty": "no_results"}; нет разметки → "no_marks":
    true (метрики по расхождениям/уверенности всё равно считаются)."""
    snap = snapshot or {}
    page = "batch" if snap.get("page") == "batch" else "single"
    cells = _collect_cells(snap, page)
    if cells is None:
        return {"empty": "no_results", "page": page}
    questions = _questions_by_n(snap)
    targets = _mark_targets(snap)
    totals = (snap.get("reviewMarks") or {}).get("totals") or {}
    marked_cells, _marked_qs = _marked_keys(targets, page)
    raw: list[str] = []

    def qtext(qn: int) -> str:
        q = questions.get(qn) or {}
        return str(q.get("question") or "")[:60]

    categories: list[dict] = []

    # 1) концентрация ✗/? пометок по вопросам (первичный сигнал — разметка)
    bad = [t for t in targets if t.get("sc") == page
           and t.get("v") in ("reject", "unsure")]
    by_q: dict[int, list] = {}
    for t in bad:
        qn = t.get("q")
        if isinstance(qn, (int, float)):
            by_q.setdefault(int(qn), []).append(t)
    for qn, items in sorted(by_q.items(), key=lambda kv: -len(kv[1]))[:2]:
        icon_n = {"reject": 0, "unsure": 0}
        for t in items:
            icon_n[t["v"]] += 1
        parts = []
        if icon_n["reject"]:
            parts.append(f"✗ {icon_n['reject']}")
        if icon_n["unsure"]:
            parts.append(f"? {icon_n['unsure']}")
        files = [t.get("f") for t in items if t.get("f")]
        detail = _plural(len(items), "пометка", "пометки", "пометок")
        if files:
            detail += ": " + ", ".join(list(dict.fromkeys(files))[:3])
        raw.append(f"✗/? по вопросу №{qn}: {_plural(len(items), "пометка", "пометки", "пометок")} "
                   f"({', '.join(parts)})")
        categories.append({
            "kind": "marks", "icon": "✗", "count": len(items),
            "title": f"Ваши ✗/? сосредоточены в вопросе №{qn} "
                     f"«{qtext(qn)}»" if qtext(qn) else
                     f"Ваши ✗/? сосредоточены в вопросе №{qn}",
            "detail": detail, "action": "fix", "cells": []})
    # концентрация по модели (batch): модель с большинством ✗/?
    by_m: dict[str, list] = {}
    for t in bad:
        label = t.get("ml") or t.get("m")
        if label:
            by_m.setdefault(label, []).append(t)
    if len(by_m) > 1:
        label, items = max(by_m.items(), key=lambda kv: len(kv[1]))
        if len(items) > len(bad) / 2:
            raw.append(f"✗/? по моделям: " + ", ".join(
                f"{k}={len(v)}" for k, v in
                sorted(by_m.items(), key=lambda kv: -len(kv[1]))))
            categories.append({
                "kind": "marks-model", "icon": "✗", "count": len(items),
                "title": f"Модель {label} собирает больше всего ваших ✗/?",
                "detail": f"{len(items)} из {len(bad)} пометок ✗/?",
                "action": "fix", "cells": []})

    # 2) комментарии пользователя к ✗/? — вербатим с координатами
    comments = []
    for t in targets:
        if t.get("sc") != page or not t.get("c") \
                or t.get("v") not in ("reject", "unsure"):
            continue
        coords = []
        if t.get("f"):
            coords.append(str(t["f"]))
        if t.get("q"):
            coords.append(f"вопрос №{t['q']}")
        if t.get("ml") or t.get("m"):
            coords.append(str(t.get("ml") or t.get("m")))
        if t.get("dec"):
            coords.append("решение")
        comments.append({"coords": " · ".join(coords) or "пометка",
                         "verdict": t.get("v"), "comment": t["c"]})
    if comments:
        shown = comments[:MAX_COMMENTS]
        raw.extend(f"💬 {c['coords']}: «{c['comment']}»" for c in shown)
        categories.append({
            "kind": "comments", "icon": "💬", "count": len(comments),
            "title": "Ваши комментарии к ✗/? — названные причины",
            "detail": f"«{shown[0]['comment']}»"
                      + (f" и ещё {len(comments) - 1}"
                         if len(comments) > 1 else ""),
            "action": "fix", "cells": [], "comments": shown})

    # 3) расхождения моделей по вопросам (⚡)
    for entry in _disagreements(cells, page)[:3]:
        qn = entry["qn"]
        # batch: n = число файлов с расхождением; single: число моделей-ячеек
        n = len(entry["units"]) if page == "batch" else len(entry["cells"])
        # по одной ячейке на единицу (файл/модель с наименьшей уверенностью)
        picked: list[dict] = []
        seen_units: set = set()
        for c in sorted(entry["cells"],
                        key=lambda c: c.get("conf") if c.get("conf") is not None
                        else 1):
            ukey = c["unit"] if page == "batch" else c["model"]
            if ukey in seen_units or _is_marked(c, page, marked_cells):
                continue
            seen_units.add(ukey)
            picked.append(c)
        unit_word = (_plural(n, "файл", "файла", "файлов") if page == "batch"
                     else _plural(n, "модель", "модели", "моделей"))
        example = entry["cells"][0]
        # пример — только ячейки первой расходящейся единицы (файла)
        ex_cells = [c for c in entry["cells"] if c["unit"] == example["unit"]] \
            if page == "batch" else entry["cells"]
        detail = (f"{unit_word}: напр. "
                  + (f"{example['unit']}: " if example.get("unit") else "")
                  + _answers_text(ex_cells))
        raw.append(f"⚡ вопрос №{qn}: расхождение в {unit_word} "
                   f"({_answers_text(entry['cells'])})")
        categories.append({
            "kind": "disagreement", "icon": "⚡", "count": n,
            "title": f"Модели расходятся в вопросе №{qn} «{qtext(qn)}»"
                     if qtext(qn) else f"Модели расходятся в вопросе №{qn}",
            "detail": detail,
            "action": "review" if picked else None,
            "cells": [{"target": _cell_target(c, page), "file": c.get("unit"),
                       "questionN": qn, "model": c.get("model"),
                       "reason": "⚡ модели разошлись"}
                      for c in picked[:MAX_CATEGORY_CELLS]]})

    # 4) близость к порогу условий решения
    near = _near_threshold(cells, snap)
    by_cond: dict[str, list] = {}
    for hit in near:
        by_cond.setdefault(_condition_text(hit["cond"]), []).append(hit)
    for ctext, hits in sorted(by_cond.items(),
                              key=lambda kv: -len(kv[1]))[:2]:
        example = hits[0]
        cell = example["cell"]
        op = "<" if example["cond"].get("op") == "lt" else "≥"
        if example["cond"].get("answer") is not None:
            val = f"{round(example['value'])}%"
            thr = f"{op} {round(example['threshold'])}%"
        else:
            val = _fmt_score(example["value"])
            thr = f"{op} {_fmt_score(example['threshold'])}"
        where = f"{cell['unit']} × {cell['model']}" if cell.get("unit") \
            else str(cell.get("model"))
        raw.append(f"◐ {ctext}: {_plural(len(hits), "ячейка", "ячейки", "ячеек")} вблизи порога, напр. "
                   f"{where}: {val} при пороге {thr}")
        categories.append({
            "kind": "threshold", "icon": "◐", "count": len(hits),
            "title": f"Условие «{ctext}» срабатывает впритык",
            "detail": f"{_plural(len(hits), "ячейка", "ячейки", "ячеек")} в ±{THRESHOLD_MARGIN_PP} п.п. "
                      f"от порога, напр. {where}: {val} при пороге {thr}",
            "action": "fix", "cells": []})

    # 5) низкая уверенность top-ответа
    low = _low_confidence(cells)
    by_lq: dict[int, list] = {}
    for c in low:
        by_lq.setdefault(c["qn"], []).append(c)
    for qn, lcells in sorted(by_lq.items(), key=lambda kv: -len(kv[1]))[:2]:
        unmarked = [c for c in lcells if not _is_marked(c, page, marked_cells)]
        example = min(lcells, key=lambda c: c["conf"])
        where = f"{example['unit']} × {example['model']}" \
            if example.get("unit") else str(example["model"])
        raw.append(f"◌ вопрос №{qn}: {_plural(len(lcells), "ячейка", "ячейки", "ячеек")} с уверенностью "
                   f"<{int(LOW_CONFIDENCE * 100)}% (мин. {where}: "
                   f"{_pct(example['conf'])})")
        categories.append({
            "kind": "lowconf", "icon": "◌", "count": len(lcells),
            "title": f"Низкая уверенность в вопросе №{qn} «{qtext(qn)}»"
                     if qtext(qn) else f"Низкая уверенность в вопросе №{qn}",
            "detail": f"{_plural(len(lcells), "ячейка", "ячейки", "ячеек")} <{int(LOW_CONFIDENCE * 100)}%, "
                      f"мин. {where}: {_pct(example['conf'])}",
            "action": "review" if unmarked else None,
            "cells": [{"target": _cell_target(c, page), "file": c.get("unit"),
                       "questionN": qn, "model": c.get("model"),
                       "reason": f"низкая уверенность: {_pct(c['conf'])}"}
                      for c in unmarked[:MAX_CATEGORY_CELLS]]})

    models = {c["model"] for c in cells}
    units = {c["unit"] for c in cells if c.get("unit") is not None}
    stats = {
        "files": len(units),
        "models": len(models),
        "questions": len({c["qn"] for c in cells}),
        "cells": len(cells),
        "marks": {k: totals.get(k, 0) for k in
                  ("accept", "reject", "unsure", "comments")},
    }
    out: dict = {"page": page, "stats": stats, "categories": categories,
                 "raw": raw}
    marks_total = sum(stats["marks"].values())
    if marks_total == 0:
        out["no_marks"] = True
    return out


# ------------------------------------------------------------------ очередь

def compute_review_queue(snapshot: dict | None,
                         limit: int = QUEUE_DEFAULT_LIMIT) -> dict:
    """Топ-N неразмеченных ячеек на разметку, по ценности метки:
    ⚡ расхождение моделей > ответ у порога решения > низкая уверенность.
    Пустой прогон → {"empty": "no_results"}; размечать нечего → {"done": true}.
    """
    snap = snapshot or {}
    page = "batch" if snap.get("page") == "batch" else "single"
    limit = max(1, min(int(limit or QUEUE_DEFAULT_LIMIT), QUEUE_MAX_LIMIT))
    cells = _collect_cells(snap, page)
    if cells is None:
        return {"empty": "no_results", "page": page}
    targets = _mark_targets(snap)
    marked_cells, marked_qs = _marked_keys(targets, page)

    candidates: list[dict] = []
    seen: set = set()

    def push(cell: dict | None, prio: int, reason: str,
             question_level: bool = False) -> None:
        if question_level:
            qid = cell["qid"] if cell else None
            if not qid or qid in marked_qs or ("q", qid) in seen:
                return
            seen.add(("q", qid))
            target = _question_target(qid)
        else:
            assert cell is not None
            if _is_marked(cell, page, marked_cells):
                return
            key = (cell.get("fid"), cell.get("qid"), cell.get("model")) \
                if page == "batch" else (cell.get("qid"), cell.get("model"))
            if key in seen:
                return
            seen.add(key)
            target = _cell_target(cell, page)
        candidates.append({
            "file": cell.get("unit") if cell else None,
            "fileId": cell.get("fid") if cell else None,
            "questionN": cell["qn"] if cell else None,
            "qid": cell.get("qid") if cell else None,
            "model": None if question_level else (cell.get("model")
                                                  if cell else None),
            "reason": reason, "prio": prio, "target": target})

    # 1) ⚡ расхождения моделей (batch — ячейка с наименьшей уверенностью из
    # расходящихся; single — вопрос целиком, модели и так рядом в строке)
    for entry in _disagreements(cells, page):
        if page == "single":
            # причина — по всем моделям вопроса, кандидат — строка вопроса
            push(entry["cells"][0], 3, _disagree_reason(entry["cells"]),
                 question_level=True)
            continue
        by_unit: dict = {}
        for c in entry["cells"]:
            by_unit.setdefault(c["unit"], []).append(c)
        for group in by_unit.values():
            reason = _disagree_reason(group)
            # ячейка с наименьшей уверенностью из неразмеченных
            unmarked = [c for c in group
                        if not _is_marked(c, page, marked_cells)]
            if unmarked:
                cell = min(unmarked, key=lambda c: c["conf"]
                           if c.get("conf") is not None else 1)
                push(cell, 3, reason)

    # 2) ответ вблизи порога решения
    for hit in _near_threshold(cells, snap):
        cell = hit["cell"]
        op = "<" if hit["cond"].get("op") == "lt" else "≥"
        if hit["cond"].get("answer") is not None:
            reason = (f"у порога решения: {round(hit['value'])}% при условии "
                      f"{op} {round(hit['threshold'])}%")
        else:
            reason = (f"у порога решения: балл {_fmt_score(hit['value'])} "
                      f"при условии {op} {_fmt_score(hit['threshold'])}")
        push(cell, 2, reason)

    # 3) низкая уверенность top-ответа
    for c in _low_confidence(cells):
        push(c, 1, f"низкая уверенность: {_pct(c['conf'])}")

    candidates.sort(key=lambda c: (-c["prio"],
                                   _conf_of(c, cells)))
    total = len(candidates)
    shown = candidates[:limit]
    if not shown:
        return {"page": page, "done": True, "candidates": [], "total": 0}
    return {"page": page, "candidates": shown, "total": total}


def _conf_of(cand: dict, cells: list[dict]) -> float:
    """Уверенность кандидата для сортировки внутри приоритета (ниже — раньше)."""
    for c in cells:
        if c.get("qid") == cand.get("qid") and c.get("fid") == cand.get("fileId") \
                and (cand.get("model") is None or c.get("model") == cand.get("model")):
            return c.get("conf") if c.get("conf") is not None else 1.0
    return 1.0
