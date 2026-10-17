"""Валидация предложений (propose_*) против снапшота состояния приложения.

validate_args (tools.py) проверяет схему и доменные инварианты аргументов
вслепую; здесь — только state-зависимые проверки: ссылки на вопросы по №,
дубли текстов против существующего набора, имена файлов пакета. Ошибки —
самопочинимые (локатор + допустимые значения): модель чинит вызов тем же
ответом, карточка пользователю не показывается.
"""
from __future__ import annotations

import unicodedata
from typing import Any

from backend.assistant.tools import normalize_tool_questions


def _norm_question_text(q: Any) -> str:
    """Зеркало normQuestionText с фронта (assistant.js) — дубль-проверка
    считается по той же нормализации, что и превалидация карточки."""
    s = str(q.get("question") if isinstance(q, dict) else q or "")
    chars = [c if unicodedata.category(c)[0] in ("L", "N") else " "
             for c in s.strip().lower()]
    return " ".join("".join(chars).split())


def _snapshot_questions(snapshot: dict | None) -> list[dict]:
    qs = (snapshot or {}).get("questions")
    return [q for q in qs if isinstance(q, dict)] if isinstance(qs, list) else []


def _check_decision_against_snapshot(outcomes: list,
                                     questions: list[dict]) -> str | None:
    """Условия правил против вопросов снапшота: № существует, answer/score
    соответствуют типу вопроса, score — в диапазоне шкалы. Собираем до 3
    ошибок сразу (не fail-fast): модель чинит всё одним ретраем вместо
    кругов «починила одну — споткнулась о следующую» (инцидент 17.10)."""
    total = len(questions)
    errors: list[str] = []
    for o in outcomes:
        if not isinstance(o, dict):
            continue
        for ri, r in enumerate(o.get("rules") or []):
            for ci, c in enumerate(r.get("conditions") or []):
                if not isinstance(c, dict):
                    continue
                loc = (f"propose_decision: исход «{o.get('label')}», "
                       f"правило {ri + 1}, условие {ci + 1} "
                       f"(вопрос №{c.get('question')})")
                n = c.get("question")
                if not isinstance(n, (int, float)) or isinstance(n, bool) \
                        or not (1 <= n <= total):
                    errors.append(f"{loc}: вопроса №{n} нет — "
                                  f"в наборе {total} вопросов")
                    continue
                q = questions[int(n) - 1]
                qtype = q.get("type")
                answer, score = c.get("answer"), c.get("score")
                if qtype in ("yes_no", "choice") and score is not None:
                    errors.append(f"{loc}: вопрос №{int(n)} — не шкала: "
                                  "задай answer + threshold, без score")
                elif qtype == "yes_no" and answer is not None \
                        and answer not in ("yes", "no"):
                    errors.append(f"{loc}: вопрос №{int(n)} — да/нет: answer "
                                  f"должен быть yes или no, получен {answer!r}")
                elif qtype == "choice" and answer is not None:
                    options = [o2.get("name") if isinstance(o2, dict) else o2
                               for o2 in q.get("options") or []]
                    if answer not in options:
                        avail = ", ".join(str(x) for x in options[:5])
                        if len(options) > 5:
                            avail += f" и ещё {len(options) - 5}"
                        errors.append(f"{loc}: answer {answer!r} — не опция "
                                      f"вопроса №{int(n)}; допустимые: {avail}")
                elif qtype == "score":
                    if answer is not None:
                        errors.append(f"{loc}: вопрос №{int(n)} — шкала: "
                                      "задай score, а не answer")
                    else:
                        levels = q.get("levels") or []
                        if score is not None and levels \
                                and not (0 <= score <= len(levels) - 1):
                            errors.append(
                                f"{loc}: score {score} вне шкалы вопроса "
                                f"№{int(n)} — допустимо 0..{len(levels) - 1}")
    if not errors:
        return None
    shown = "; ".join(errors[:3])
    if len(errors) > 3:
        shown += f"; и ещё {len(errors) - 3}"
    return shown


def _check_question_duplicates(incoming: list,
                               existing: list[dict] | None) -> str | None:
    """Дубли нормализованного текста в итоговом наборе. existing — вопросы
    снапшота (режим append: итог = снапшот + входящие); для replace дубль
    со старым набором не считается — важны повторы внутри предложения."""
    seen: dict[str, tuple[str, int]] = {}
    for i, q in enumerate(existing or []):
        t = _norm_question_text(q)
        if t:
            seen.setdefault(t, ("existing", i + 1))
    for i, q in enumerate(incoming):
        t = _norm_question_text(q)
        if not t:
            continue
        if t in seen:
            kind, k = seen[t]
            if kind == "existing":
                return (f"propose_questions: вопрос №{i + 1} в предложении — "
                        f"дубль существующего вопроса №{k} «{t[:60]}»")
            return (f"propose_questions: вопросы №{k} и №{i + 1} "
                    f"в предложении повторяются «{t[:60]}»")
        seen[t] = ("incoming", i + 1)
    return None


def validate_against_snapshot(name: str, args: dict,
                              snapshot: dict | None,
                              questions_override: list | None = None
                              ) -> str | None:
    """State-зависимые проверки proposal-инструментов. None — всё чисто
    (или снапшот не передан: тогда проверять не против чего).
    questions_override — виртуальное состояние хода для propose_decision:
    набор вопросов из уже предложенной этим же ходом карточки
    propose_questions (она ещё не применена пользователем, но правила
    модель строит уже под неё — инцидент 17.10)."""
    if name == "propose_decision":
        questions = questions_override
        if questions is None:
            if not snapshot:
                return None
            questions = _snapshot_questions(snapshot)
        return _check_decision_against_snapshot(args.get("outcomes") or [],
                                                questions)
    if not snapshot:
        return None
    if name == "propose_questions":
        existing = _snapshot_questions(snapshot) \
            if args.get("mode") == "append" else None
        return _check_question_duplicates(args.get("questions") or [],
                                          existing)
    if name == "propose_context":
        file = args.get("file")
        if file:
            names = [f.get("name") for f in snapshot.get("batchFiles") or []
                     if isinstance(f, dict)]
            if file not in names:
                if not names:
                    return (f"propose_context: файла «{file}» нет — "
                            "пакет пуст")
                avail = ", ".join(str(x) for x in names[:10])
                if len(names) > 10:
                    avail += f" и ещё {len(names) - 10}"
                return (f"propose_context: файла «{file}» нет в пакете — "
                        f"доступные: {avail}")
    if name == "propose_run":
        if args.get("scope") == "batch" and not snapshot.get("batchFiles"):
            return ("propose_run: scope=batch, но в пакете нет файлов — "
                    "запустить нечего (scope=single или сначала добавь файлы)")
    return None


# ---------------------------------------------------------------- edits


def expand_question_edits(snapshot: dict | None,
                          edits: list) -> tuple[list[dict] | None, str | None]:
    """Точечные операции над вопросами → итоговый набор (payload как replace).
    Операции применяются по порядку к рабочему списку; n/after — номер в нём
    (после предыдущих операций). У существующих вопросов id — из снапшота
    (ссылки правил/разметки по id не рвутся), у новых — id, данный моделью
    (пустой подставит фронт при применении — конвенция normalizeQuestion)."""
    questions = [{k: v for k, v in q.items() if k != "n"}
                 for q in _snapshot_questions(snapshot)]
    for i, e in enumerate(edits):
        op = e.get("op")
        loc = f"propose_questions: edits[{i}] (op={op})"

        def _pos(num: Any) -> int | None:
            if isinstance(num, bool) or not isinstance(num, (int, float)) \
                    or not (1 <= num <= len(questions)):
                return None
            return int(num) - 1

        if op == "add":
            q = dict(e["question"])
            if e.get("after") is None:
                questions.append(q)
            else:
                pos = _pos(e.get("after"))
                if pos is None:
                    return None, (f"{loc}: вопроса №{e.get('after')} нет — "
                                  f"в наборе {len(questions)} вопросов")
                questions.insert(pos + 1, q)
            continue
        pos = _pos(e.get("n"))
        if pos is None:
            return None, (f"{loc}: вопроса №{e.get('n')} нет — "
                          f"в наборе {len(questions)} вопросов")
        if op == "remove":
            questions.pop(pos)
        elif op == "update":
            new = dict(e["question"])
            new["id"] = questions[pos].get("id") or new.get("id")
            questions[pos] = new
        elif op == "split":
            questions[pos:pos + 1] = [dict(q) for q in e["into"]]
    if not questions:
        return None, ("propose_questions: после операций набор пуст — "
                      "нужен хотя бы один вопрос")
    # доменная валидация итогового набора основной схемой приложения
    _, error = normalize_tool_questions(questions)
    if error:
        return None, error
    return questions, None


def decision_reference_warnings(snapshot: dict | None,
                                edits: list) -> str | None:
    """Remove/update/split вопроса, на который ссылается условие действующих
    правил, — не отвергаем, а предупреждаем (карточке — warn, модели — note)."""
    refs: list[tuple[Any, str]] = []
    decision = (snapshot or {}).get("decision") or {}
    for o in decision.get("outcomes") or []:
        if not isinstance(o, dict):
            continue
        for r in o.get("rules") or []:
            for c in (r.get("conditions") or []):
                if isinstance(c, dict):
                    refs.append((c.get("question"), str(o.get("label"))))
    if not refs:
        return None
    seen: list[str] = []
    for e in edits:
        if e.get("op") not in ("remove", "update", "split"):
            continue
        n = e.get("n")
        for ref_n, label in refs:
            if ref_n == n:
                part = f"правило исхода «{label}» ссылается на №{n}"
                if part not in seen:
                    seen.append(part)
    return "; ".join(seen) if seen else None


def proposed_question_set(snapshot: dict | None, payload: dict) -> list[dict]:
    """Итоговый набор вопросов успешного propose_questions — виртуальное
    состояние хода: следующий propose_decision тем же ходом валидируется
    уже против него (правила модель строит под новую нумерацию, а карточка
    вопросов ещё ждёт «Принять»)."""
    incoming = [q for q in payload.get("questions") or []
                if isinstance(q, dict)]
    if payload.get("mode") == "append":
        return _snapshot_questions(snapshot) + incoming
    return incoming
