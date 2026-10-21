"""Replay-корпус сессий ассистента (A1, v1.2) — блокирующий гейт изменений
агентного цикла.

Отличие от assistant_eval.py (сценарии-инциденты, 1–2 хода): здесь СЕССИИ —
многоходовые диалоги docs/evals/corpus/*.json с действиями пользователя над
карточками между ходами (accept/decline/ignore с честной эмуляцией применения
к снапшоту) и ассертами уровня сессии (expect). Классы дефектов корпуса:
фантомы, validation-петли, stale/позиционная адресация, деградация длинных
сессий.

Транспорт и базовые грейдеры переиспользованы из assistant_eval (фейк
httpx.AsyncClient с записанными SSE-ответами, аудит journal_audit с прощением
находок, закрытых стражем). run_trial — фейк; analyze_run/review_queue —
настоящие (analysis.py — чистые функции снапшота, сети нет); propose_*
исполняются по-настоящему (их валидация против снапшота — часть проверяемого
поведения). Цикл — только локальный (run_agent, hermes): все инциденты
классов корпуса — с локальных моделей.

Формат сессии (docs/evals/corpus/*.json):
{
  "name": "phantom__proposal_claim",
  "class": "phantom",                // phantom | validation | stale | long
  "loop": "local",
  "snapshot": "../fixtures/snapshot_dup.json",
  "trial_result": {"ok": true},      // опционально: исход фейка run_trial
  "turns": [
    {"user": "...",
     "canned": [...],                // как в assistant_eval: строка = content,
                                     // {"content"?, "tool_calls": [...]} = шаг
     "accept": "all" | [0, 2],       // индексы карточек хода, принятых
                                     // пользователем (применяются к снапшоту)
     "decline": [1],                 // отклонённые (снапшот не меняется);
                                     // остальные карточки хода = ignore
     "graders": {...}}               // грейдеры assistant_eval +
                                     // required_tool_errors / required_proposals /
                                     // forbidden_events
  ],
  "expect": {                        // ассерты уровня сессии (после всех ходов)
    "turns": 3,                      // число ходов — страховка от обрезки файла
    "final_snapshot": {"questions_count": 4, "decision_outcomes": 2},
    "guard_fires": {"phantom_guard": {"min": 1, "max": 2}}
  }
}

Эмуляция применения карточек (accept): propose_questions → questions снапшота
(payload replace/append, перенумерация n), propose_decision → decision,
propose_context → context.text (или текст файла пакета по payload.file).
propose_run / propose_save_preset — ignore-only: accept таких карточек
фиксируется в diff, но снапшот не меняет (запуск прогона и сохранение
пресета на фронте уходят в API, в replay не эмулируются).

Запуск: .venv-test/bin/python scripts/replay_corpus.py
        [--scenario PATH|NAME] [--guards-off phantom,degrade] [--verbose]
Код выхода 1, если хотя бы одна сессия FAIL.
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for p in (str(ROOT), str(ROOT / "scripts")):
    if p not in sys.path:
        sys.path.insert(0, p)

import assistant_eval as ev  # noqa: E402
from backend.assistant import agent  # noqa: E402
from backend.assistant import analysis as analysis_mod  # noqa: E402

CORPUS_DIR = ROOT / "docs" / "evals" / "corpus"


# ---------------------------------------------------------------- сессии

def load_corpus() -> list[dict]:
    """Все сессии docs/evals/corpus/*.json, по имени файла."""
    out = []
    for path in sorted(CORPUS_DIR.glob("*.json")):
        scn = json.loads(path.read_text(encoding="utf-8"))
        scn.setdefault("name", path.stem)
        scn["_path"] = path
        out.append(scn)
    return out


def load_session(ref: str) -> dict:
    """Сессия по имени или по пути к JSON-файлу."""
    path = Path(ref)
    if path.suffix == ".json" and path.exists():
        scn = json.loads(path.read_text(encoding="utf-8"))
        scn.setdefault("name", path.stem)
        scn["_path"] = path.resolve()
        return scn
    for scn in load_corpus():
        if scn["name"] == ref:
            return scn
    raise KeyError(f"сессия {ref!r} не найдена в {CORPUS_DIR}")


def _load_json_ref(scn: dict, key: str):
    rel = scn.get(key)
    if not rel:
        return None
    return json.loads((scn["_path"].parent / rel).resolve()
                      .read_text(encoding="utf-8"))


# ---------------------------------------------------------------- инструменты

def _action_tools(snapshot: dict | None, cfg: dict) -> dict:
    """run_trial — фейк assistant_eval; analyze_run/review_queue — настоящие
    (analysis.py — чистые функции снапшота, офлайн)."""
    tools = dict(ev._action_tools(snapshot, cfg))

    async def analyze_run(_args=None):
        payload = analysis_mod.compute_run_analysis(snapshot)
        return {"ok": True, "analysis": payload}, [
            {"type": "analysis", "analysis": payload}]

    async def review_queue(args=None):
        try:
            limit = int((args or {}).get("limit") or 5)
        except (TypeError, ValueError):
            limit = 5
        payload = analysis_mod.compute_review_queue(snapshot or {}, limit=limit)
        return {"ok": True, "queue": payload}, [
            {"type": "review_queue", "queue": payload}]

    tools["analyze_run"] = analyze_run
    tools["review_queue"] = review_queue
    return tools


# ------------------------------------------------------- действия над карточками

def _apply_one(snapshot: dict, kind: str, payload: dict) -> str:
    """Применить принятую карточку к снапшоту (как «Принять» на фронте).
    → человекочитаемый diff. Ignore-only kinds снапшот не меняют."""
    if kind == "propose_questions":
        qs = [dict(q) for q in payload.get("questions") or []
              if isinstance(q, dict)]
        if payload.get("mode") == "append":
            base = [{k: v for k, v in q.items() if k != "n"}
                    for q in snapshot.get("questions") or []
                    if isinstance(q, dict)]
            qs = base + qs
        old = len(snapshot.get("questions") or [])
        snapshot["questions"] = [{"n": i + 1, **q} for i, q in enumerate(qs)]
        return f"questions {old}→{len(qs)}"
    if kind == "propose_decision":
        outcomes = payload.get("outcomes") or []
        snapshot["decision"] = {"outcomes": outcomes}
        labels = ", ".join(str(o.get("label")) for o in outcomes)
        return f"decision: {len(outcomes)} исхода ({labels})"
    if kind == "propose_context":
        text = str(payload.get("text") or "")
        append = payload.get("mode") == "append"
        if payload.get("file"):
            name = str(payload["file"])
            for f in snapshot.get("batchFiles") or []:
                if isinstance(f, dict) and f.get("name") == name:
                    f["text"] = ((f.get("text") or "") + "\n" + text).strip() \
                        if append else text
                    return f"batchFiles[{name}].text ← {len(f['text'])} симв."
            return f"batchFiles[{name}] не найден — текст не применён"
        ctx = snapshot.setdefault("context", {})
        ctx["text"] = ((ctx.get("text") or "") + "\n" + text).strip() \
            if append else text
        return f"context.text ← {len(ctx['text'])} симв."
    # propose_run / propose_save_preset — ignore-only (см. докстринг модуля)
    return f"{kind}: kind не эмулируется (ignore-only) — снапшот не изменён"


def _apply_cards(snapshot: dict, events: list[dict],
                 turn: dict) -> tuple[list[str], list[str]]:
    """Действия пользователя над карточками хода: accept применяет, decline и
    ignore — нет. → (diffs для отчёта, ошибки сценария)."""
    proposals = [e.get("proposal") or {}
                 for e in events if e.get("type") == "proposal"]
    acc = turn.get("accept")
    accept_idx = set(range(len(proposals))) if acc == "all" \
        else {int(i) for i in (acc or [])}
    decline_idx = {int(i) for i in (turn.get("decline") or [])}
    fails = []
    if (acc is not None or turn.get("decline")) and not proposals:
        fails.append("accept/decline заданы, но карточек за ход не было")
        return [], fails
    for i in sorted(accept_idx | decline_idx):
        if i >= len(proposals):
            fails.append(f"действие над карточкой #{i}, а карточек за ход: "
                         f"{len(proposals)}")
    diffs = []
    for i, prop in enumerate(proposals):
        kind = prop.get("kind")
        if i in accept_idx:
            diffs.append(f"принята {kind}: "
                         + _apply_one(snapshot, kind, prop.get("payload") or {}))
        elif i in decline_idx:
            diffs.append(f"отклонена {kind} — снапшот не изменён")
        else:
            diffs.append(f"проигнорирована {kind} — снапшот не изменён")
    return diffs, fails


# ---------------------------------------------------------------- грейдеры

def _grade_extra(turn: dict, events: list[dict]) -> list[str]:
    """Грейдеры корпуса поверх assistant_eval.grade_turn."""
    g = turn.get("graders") or {}
    fails: list[str] = []
    types = [e.get("type") for e in events]
    err_tools = {e.get("name") for e in events
                 if e.get("type") == "tool" and e.get("status") == "error"}
    for t in g.get("required_tool_errors") or []:
        if t not in err_tools:
            fails.append(f"нет обязательной ошибки инструмента {t!r} "
                         "(tool status error)")
    for t in g.get("forbidden_events") or []:
        if t in types:
            fails.append(f"было запрещённое событие {t!r}")
    # required_proposals: kinds карточек хода как in-order подпоследовательность
    kinds = iter((e.get("proposal") or {}).get("kind")
                 for e in events if e.get("type") == "proposal")
    for k in g.get("required_proposals") or []:
        if k not in kinds:
            fails.append(f"нет обязательной карточки {k!r} "
                         "(в ожидаемом порядке)")
    return fails


def _grade_session(scn: dict, turns: list, snapshot: dict) -> list[str]:
    """Ассерты уровня сессии (expect) — после всех ходов."""
    exp = scn.get("expect") or {}
    fails: list[str] = []
    if exp.get("turns") is not None and exp["turns"] != len(turns):
        fails.append(f"expect.turns={exp['turns']}, а в сессии {len(turns)} "
                     "(файл обрезан или лишние ходы)")
    fs = exp.get("final_snapshot") or {}
    if "questions_count" in fs:
        n = len(snapshot.get("questions") or [])
        if n != fs["questions_count"]:
            fails.append(f"final_snapshot.questions_count: ожидалось "
                         f"{fs['questions_count']}, получено {n}")
    if "decision_outcomes" in fs:
        n = len((snapshot.get("decision") or {}).get("outcomes") or [])
        if n != fs["decision_outcomes"]:
            fails.append(f"final_snapshot.decision_outcomes: ожидалось "
                         f"{fs['decision_outcomes']}, получено {n}")
    fires: dict[str, int] = {}
    for t in turns:
        for e in t.events:
            if e.get("type") == "tool" and e.get("status") == "done":
                fires[e.get("name")] = fires.get(e.get("name"), 0) + 1
    for name, rng in (exp.get("guard_fires") or {}).items():
        n = fires.get(name, 0)
        if rng.get("min") is not None and n < rng["min"]:
            fails.append(f"guard_fires.{name}: {n} < min {rng['min']}")
        if rng.get("max") is not None and n > rng["max"]:
            fails.append(f"guard_fires.{name}: {n} > max {rng['max']}")
    return fails


# ---------------------------------------------------------------- прогон

class SessionReport:
    def __init__(self, name: str, cls: str):
        self.name = name
        self.cls = cls
        self.turns: list[ev.TurnReport] = []
        self.session_failures: list[str] = []

    @property
    def ok(self) -> bool:
        return not self.session_failures \
            and not any(t.failures for t in self.turns)

    @property
    def failures(self) -> list[str]:
        out = []
        for i, t in enumerate(self.turns):
            for f in t.failures:
                out.append(f"ход {i + 1}: {f}")
        return out + [f"сессия: {f}" for f in self.session_failures]

    @property
    def requests(self) -> int:
        return sum(t.requests for t in self.turns)


async def _run_turn(turn: dict, history: list[dict], snapshot: dict | None,
                    trial_cfg: dict, rep: ev.TurnReport) -> None:
    canned = turn.get("canned") or []
    ev._FakeChatClient.responses = [ev._step_lines(c, "local") for c in canned]
    ev._FakeChatClient.requests = []
    events: list[dict] = []
    failure = None
    try:
        gen = agent.run_agent(
            history, turn.get("user", ""), snapshot,
            "http://eval/v1/chat/completions", False,
            ev._read_tools(snapshot), _action_tools(snapshot, trial_cfg))
        async for line in gen:
            events.append(json.loads(line[len("data: "):]))
    except AssertionError as e:
        failure = f"агент запросил шагов больше, чем записано в canned: {e}"
    rep.events = events
    rep.requests = len(ev._FakeChatClient.requests)
    unused = len(ev._FakeChatClient.responses) - rep.requests
    rep.failures = ([failure] if failure else []) \
        + ev.grade_turn(turn, events, rep.requests, max(unused, 0)) \
        + _grade_extra(turn, events)


async def _run_session_async(scn: dict, guards_off_cli: list[str],
                             verbose: bool = False) -> SessionReport:
    rep = SessionReport(scn["name"], scn.get("class", "?"))
    snapshot = copy.deepcopy(_load_json_ref(scn, "snapshot"))
    history: list[dict] = []
    trial_cfg = scn.get("trial_result") or {}
    if scn.get("loop", "local") != "local":
        rep.session_failures.append("replay_corpus гоняет только локальный "
                                    "цикл (run_agent, hermes)")
        return rep

    guards = sorted(set(guards_off_cli) | set(scn.get("guards_off") or []))
    saved_client = agent.httpx.AsyncClient
    saved_guards = os.environ.get("ASSISTANT_GUARDS_OFF")
    agent.httpx.AsyncClient = ev._FakeChatClient
    if guards:
        os.environ["ASSISTANT_GUARDS_OFF"] = ",".join(guards)
    else:
        os.environ.pop("ASSISTANT_GUARDS_OFF", None)
    try:
        for turn in scn.get("turns") or []:
            trep = ev.TurnReport(turn.get("user", ""))
            rep.turns.append(trep)
            await _run_turn(turn, history, snapshot, trial_cfg, trep)
            diffs, card_fails = _apply_cards(snapshot, trep.events, turn)
            trep.snapshot_diffs = diffs
            trep.failures += card_fails
            done = next((e for e in reversed(trep.events)
                         if e.get("type") == "done"), None)
            if done is not None:
                history.append({"role": "user",
                                "content": turn.get("user", "")})
                answer = ev._final_answer(trep.events)
                if answer:
                    history.append({"role": "assistant", "content": answer})
        rep.session_failures = _grade_session(scn, rep.turns, snapshot or {})
    finally:
        agent.httpx.AsyncClient = saved_client
        if saved_guards is None:
            os.environ.pop("ASSISTANT_GUARDS_OFF", None)
        else:
            os.environ["ASSISTANT_GUARDS_OFF"] = saved_guards
    return rep


def run_session(scn: dict, guards_off: list[str] | None = None,
                verbose: bool = False) -> SessionReport:
    return asyncio.run(_run_session_async(scn, guards_off or [], verbose))


# ---------------------------------------------------------------- CLI

def _print_report(rep: SessionReport, verbose: bool) -> None:
    status = "PASS" if rep.ok else "FAIL"
    print(f"{status}  [{rep.cls}] {rep.name} — ходов: {len(rep.turns)}, "
          f"запросов к модели: {rep.requests}")
    for i, t in enumerate(rep.turns):
        for d in t.snapshot_diffs:
            print(f"      ход {i + 1} snapshot: {d}")
        for f in t.failures:
            print(f"      ход {i + 1} FAIL: {f}")
        if verbose:
            kinds = [e.get("type") if e.get("type") != "tool"
                     else f"tool:{e.get('name')}:{e.get('status')}"
                     for e in t.events]
            print(f"      ход {i + 1} события: {', '.join(map(str, kinds))}")
    for f in rep.session_failures:
        print(f"      сессия FAIL: {f}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--scenario", default=None,
                    help="прогнать одну сессию: имя или путь к JSON")
    ap.add_argument("--guards-off", default="",
                    help="стражи через запятую (phantom,degrade) — демонтажный "
                         "прогон: сессии, требующие этих стражей, должны упасть")
    ap.add_argument("--verbose", action="store_true",
                    help="печатать события каждого хода")
    args = ap.parse_args()

    guards_off = [s.strip() for s in args.guards_off.split(",") if s.strip()]
    try:
        sessions = [load_session(args.scenario)] if args.scenario \
            else load_corpus()
    except KeyError as e:
        print(e.args[0])
        return 2
    if not sessions:
        print(f"сессий не найдено в {CORPUS_DIR}")
        return 2

    if guards_off:
        print(f"ДЕМОНТАЖНЫЙ ПРОГОН: стражи выключены: {', '.join(guards_off)}")
    reports = []
    for scn in sessions:
        rep = run_session(scn, guards_off, args.verbose)
        reports.append(rep)
        _print_report(rep, args.verbose)
    passed = sum(1 for r in reports if r.ok)
    print(f"\nИтог: {passed}/{len(reports)} PASS")
    return 0 if passed == len(reports) else 1


if __name__ == "__main__":
    raise SystemExit(main())
