"""Валидация предложений (propose_*) против снапшота состояния приложения.

validate_args (tools.py) проверяет схему и доменные инварианты аргументов
вслепую; здесь — только state-зависимые проверки: ссылки на вопросы по id
(контракт v1.2/A3 — стабильные id, №n остаётся для отображения), дубли
текстов против существующего набора, имена файлов пакета. Ошибки —
самопочинимые (локатор + verbatim-подсказка актуального состояния): модель
чинит вызов тем же ответом, карточка пользователю не показывается.
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


def _actual_ids_hint(questions: list[dict], limit: int = 12) -> str:
    """Verbatim-подсказка актуальных id для самокоррекции модели:
    «актуальные id: q1, q2, …» (срезка с счётчиком хвоста)."""
    ids = [str(q.get("id")) for q in questions if q.get("id")]
    shown = ", ".join(ids[:limit])
    if len(ids) > limit:
        shown += f" и ещё {len(ids) - limit}"
    return f"актуальные id: {shown or 'нет (набор пуст)'}"


def _question_by_id(questions: list[dict], qid: Any) -> dict | None:
    if not isinstance(qid, str):
        return None
    return next((q for q in questions if q.get("id") == qid), None)


def _check_decision_against_snapshot(outcomes: list,
                                     questions: list[dict]) -> str | None:
    """Условия правил против вопросов снапшота (по id, контракт A3): id
    существует, answer/score соответствуют типу вопроса, score — в диапазоне
    шкалы. Собираем до 3 ошибок сразу (не fail-fast): модель чинит всё одним
    ретраем вместо кругов «починила одну — споткнулась о следующую» (инцидент
    17.10). На неизвестный id — verbatim-подсказка актуальных id."""
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
                       f"(вопрос «{c.get('question')}»)")
                q = _question_by_id(questions, c.get("question"))
                if q is None:
                    errors.append(
                        f"{loc}: вопроса «{c.get('question')}» нет "
                        f"(удалён или никогда не существовал) — "
                        f"{_actual_ids_hint(questions)}")
                    continue
                qid = q.get("id")
                qtype = q.get("type")
                answer, score = c.get("answer"), c.get("score")
                if qtype in ("yes_no", "choice") and score is not None:
                    errors.append(f"{loc}: вопрос «{qid}» — не шкала: "
                                  "задай answer + threshold, без score")
                elif qtype == "yes_no" and answer is not None \
                        and answer not in ("yes", "no"):
                    errors.append(f"{loc}: вопрос «{qid}» — да/нет: answer "
                                  f"должен быть yes или no, получен {answer!r}")
                elif qtype == "choice" and answer is not None:
                    options = [o2.get("name") if isinstance(o2, dict) else o2
                               for o2 in q.get("options") or []]
                    if answer not in options:
                        avail = ", ".join(str(x) for x in options[:5])
                        if len(options) > 5:
                            avail += f" и ещё {len(options) - 5}"
                        errors.append(f"{loc}: answer {answer!r} — не опция "
                                      f"вопроса «{qid}»; допустимые: {avail}")
                elif qtype == "score":
                    if answer is not None:
                        errors.append(f"{loc}: вопрос «{qid}» — шкала: "
                                      "задай score, а не answer")
                    else:
                        levels = q.get("levels") or []
                        if score is not None and levels \
                                and not (0 <= score <= len(levels) - 1):
                            errors.append(
                                f"{loc}: score {score} вне шкалы вопроса "
                                f"«{qid}» — допустимо 0..{len(levels) - 1}")
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
    модель строит уже под неё — инцидент 17.10). Набор — по id (A3)."""
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
        # гейт по состоянию моделей (макет 4.11): выбранная, но не запущенная
        # модель — прогон по ней не выполнится. unknown — статусов нет в
        # снапшоте (напр. облегчённая превалидация), их не считаем.
        not_running = [m for m in snapshot.get("selectedModels") or []
                       if isinstance(m, dict)
                       and m.get("status") not in (None, "unknown", "running")]
        if not_running:
            shown = ", ".join(f"{m.get('key')} (статус: {m.get('status')})"
                              for m in not_running[:3])
            return ("propose_run: модели не запущены: " + shown + ". "
                    "Запустить их может только пользователь на странице "
                    "«Модели» — сообщи ему об этом.")
    return None


# ---------------------------------------------------------------- edits


def ensure_unique_ids(questions: list[dict],
                      protected_ids: set[str] | None = None,
                      keep_key: str | None = None
                      ) -> list[tuple[str, str]]:
    """Гарантия уникальности id (контракт A3: модель предлагает id, бэкенд
    молча гарантирует уникальность): коллизии переименовываются суффиксом
    «-2», «-3», … → список переименований [(было, стало)] для ноты модели.
    protected_ids — id существующих вопросов: заняты с самого начала.
    keep_key — маркер «элемент и есть существующий вопрос» (его id
    неприкосновенен): защита по идентичности элемента, а не по значению id —
    НОВЫЙ вопрос, присвоивший себе id существующего, переименовывается."""
    taken = set(protected_ids or ())
    renames: list[tuple[str, str]] = []
    for q in questions:
        if keep_key and q.pop(keep_key, False):
            taken.add(str(q.get("id") or ""))
            continue  # существующий вопрос — id неприкосновенен
        qid = str(q.get("id") or "")
        if qid and qid not in taken:
            taken.add(qid)
            continue
        base = qid or "q"
        n = 2
        while f"{base}-{n}" in taken:
            n += 1
        new_id = f"{base}-{n}"
        q["id"] = new_id
        taken.add(new_id)
        renames.append((qid, new_id))
    return renames


def expand_question_edits(snapshot: dict | None,
                          edits: list
                          ) -> tuple[list[dict] | None, str | None,
                                     list[tuple[str, str]]]:
    """Точечные операции над вопросами → итоговый набор (payload как replace).
    Адресация — по id (контракт A3): target/after — id вопросов набора на
    момент вызова (id стабильны, сдвиги нумерации операций внутри вызова не
    ломают ссылки). Операции применяются по порядку. У существующих вопросов
    id — из снапшота (ссылки правил/разметки по id не рвутся), у новых — id,
    данный моделью; коллизии id молча переименовываются (возвращается список
    renames для ноты модели). → (questions, error, renames)."""
    questions = [{**{k: v for k, v in q.items() if k != "n"}, "_keep": True}
                 for q in _snapshot_questions(snapshot)]
    original_ids = {q.get("id") for q in questions}
    hint = lambda: _actual_ids_hint(questions)  # noqa: E731
    for i, e in enumerate(edits):
        op = e.get("op")
        loc = f"propose_questions: edits[{i}] (op={op})"

        def _pos(qid: Any) -> int | None:
            for pos, q in enumerate(questions):
                if q.get("id") == qid:
                    return pos
            return None

        if op == "add":
            q = dict(e["question"])
            if e.get("after") is None:
                questions.append(q)
            else:
                pos = _pos(e.get("after"))
                if pos is None:
                    return None, (f"{loc}: вопроса «{e.get('after')}» "
                                  f"(after) нет — {hint()}"), []
                questions.insert(pos + 1, q)
            continue
        pos = _pos(e.get("target"))
        if pos is None:
            return None, (f"{loc}: вопроса «{e.get('target')}» нет "
                          f"(удалён или никогда не существовал) — "
                          f"{hint()}"), []
        if op == "remove":
            questions.pop(pos)
        elif op == "update":
            new = dict(e["question"])
            new["id"] = questions[pos].get("id") or new.get("id")
            new["_keep"] = True  # id унаследован — неприкосновенен
            questions[pos] = new
        elif op == "split":
            questions[pos:pos + 1] = [dict(q) for q in e["into"]]
    if not questions:
        return None, ("propose_questions: после операций набор пуст — "
                      "нужен хотя бы один вопрос"), []
    # коллизии id новых вопросов (add/split) с существующими — тихое
    # переименование; существующие id неприкосновенны
    renames = ensure_unique_ids(questions, protected_ids=original_ids,
                                keep_key="_keep")
    # доменная валидация итогового набора основной схемой приложения
    _, error = normalize_tool_questions(questions)
    if error:
        return None, error, []
    return questions, None, renames


def decision_reference_warnings(snapshot: dict | None,
                                edits: list) -> str | None:
    """Remove/update/split вопроса (по id), на который ссылается условие
    действующих правил, — не отвергаем, а предупреждаем (карточке — warn,
    модели — note). Ссылки правил и target операций — по id (A3); в тексте
    предупреждения — № для отображения."""
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
    num_by_id = {q.get("id"): i + 1
                 for i, q in enumerate(_snapshot_questions(snapshot))}
    seen: list[str] = []
    for e in edits:
        if e.get("op") not in ("remove", "update", "split"):
            continue
        target = e.get("target")
        for ref_id, label in refs:
            if ref_id == target:
                n = num_by_id.get(target)
                shown = f"№{n}" if n is not None else f"«{target}»"
                part = f"правило исхода «{label}» ссылается на {shown}"
                if part not in seen:
                    seen.append(part)
    return "; ".join(seen) if seen else None


def proposed_question_set(snapshot: dict | None, payload: dict) -> list[dict]:
    """Итоговый набор вопросов успешного propose_questions — виртуальное
    состояние хода: следующий propose_decision тем же ходом валидируется
    уже против него (правила модель строит под новый набор по id, а карточка
    вопросов ещё ждёт «Принять»)."""
    incoming = [q for q in payload.get("questions") or []
                if isinstance(q, dict)]
    if payload.get("mode") == "append":
        return _snapshot_questions(snapshot) + incoming
    return incoming
