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
    соответствуют типу вопроса, score — в диапазоне шкалы."""
    total = len(questions)
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
                    return (f"{loc}: вопроса №{n} нет — "
                            f"в наборе {total} вопросов")
                q = questions[int(n) - 1]
                qtype = q.get("type")
                answer, score = c.get("answer"), c.get("score")
                if qtype in ("yes_no", "choice") and score is not None:
                    return (f"{loc}: вопрос №{int(n)} — не шкала: задай "
                            "answer + threshold, без score")
                if qtype == "yes_no" and answer is not None \
                        and answer not in ("yes", "no"):
                    return (f"{loc}: вопрос №{int(n)} — да/нет: answer "
                            f"должен быть yes или no, получен {answer!r}")
                if qtype == "choice" and answer is not None:
                    options = [o2.get("name") if isinstance(o2, dict) else o2
                               for o2 in q.get("options") or []]
                    if answer not in options:
                        avail = ", ".join(str(x) for x in options[:5])
                        if len(options) > 5:
                            avail += f" и ещё {len(options) - 5}"
                        return (f"{loc}: answer {answer!r} — не опция "
                                f"вопроса №{int(n)}; допустимые: {avail}")
                if qtype == "score":
                    if answer is not None:
                        return (f"{loc}: вопрос №{int(n)} — шкала: задай "
                                "score, а не answer")
                    levels = q.get("levels") or []
                    if score is not None and levels \
                            and not (0 <= score <= len(levels) - 1):
                        return (f"{loc}: score {score} вне шкалы вопроса "
                                f"№{int(n)} — допустимо 0..{len(levels) - 1}")
    return None


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
                              snapshot: dict | None) -> str | None:
    """State-зависимые проверки proposal-инструментов. None — всё чисто
    (или снапшот не передан: тогда проверять не против чего)."""
    if not snapshot:
        return None
    if name == "propose_decision":
        return _check_decision_against_snapshot(args.get("outcomes") or [],
                                                _snapshot_questions(snapshot))
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
