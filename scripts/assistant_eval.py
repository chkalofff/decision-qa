"""Replay-регрессионный eval-раннер ассистента (стратегия тестирования v1.0).

Прогоняет детерминированные сценарии из docs/evals/scenarios/*.json против
агентных циклов backend/assistant/agent.py с записанными («canned») ответами
модели — сеть полностью подменена фейк-транспортом (httpx.AsyncClient),
run_trial — фейком (реальные propose_* исполняются по-настоящему: их валидация
против снапшота — часть проверяемого поведения).

Грейдеры смотрят на ИСХОД хода (события/псевдо-журнал), а не на текст:
исход done/error, аудит journal_audit.audit() по собранным событиям с
прощением находок, закрытых сработавшим стражем (ФАНТОМ-* ← phantom_guard,
ДЕГРАДАЦИЯ ← degrade_guard), отсутствие CJK в финальном ответе (токены после
последнего сброса черновика стражем), лимит запросов, обязательные/запрещённые
события и tool-вызовы. Между ходами снапшот мутирует: accept=all применяет
карточки хода к состоянию (propose_questions/decision/context).

Запуск: .venv-test/bin/python scripts/assistant_eval.py
        [--scenario NAME] [--guards-off phantom,degrade] [--verbose]
Код выхода 1, если хотя бы один сценарий FAIL.
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
for p in (str(ROOT), str(ROOT / "scripts")):
    if p not in sys.path:
        sys.path.insert(0, p)

from backend.assistant import agent  # noqa: E402
from backend.assistant.agent import _DEGRADED_RE  # noqa: E402
from journal_audit import audit  # noqa: E402

SCENARIOS_DIR = ROOT / "docs" / "evals" / "scenarios"
DEFAULT_MAX_REQUESTS = agent.MAX_STEPS + 1

# tool-события, после которых фронт стирает доретрайный черновик ответа
_DRAFT_RESET_TOOLS = {"phantom_guard", "degrade_guard", "retry"}
# прощение находок аудита: префикс находки → страж, который её закрывает
_FORGIVING_GUARDS = (("ФАНТОМ", "phantom_guard"), ("ДЕГРАДАЦИЯ", "degrade_guard"))


# ---------------------------------------------------------------- сценарии

def load_scenarios() -> list[dict]:
    """Все сценарии docs/evals/scenarios/*.json, по имени."""
    out = []
    for path in sorted(SCENARIOS_DIR.glob("*.json")):
        scn = json.loads(path.read_text(encoding="utf-8"))
        scn.setdefault("name", path.stem)
        scn["_path"] = path
        out.append(scn)
    return out


def load_scenario(name: str) -> dict:
    for scn in load_scenarios():
        if scn["name"] == name:
            return scn
    raise KeyError(f"сценарий {name!r} не найден в {SCENARIOS_DIR}")


def _load_json_ref(scn: dict, key: str):
    rel = scn.get(key)
    if not rel:
        return None
    return json.loads((scn["_path"].parent / rel).resolve()
                      .read_text(encoding="utf-8"))


# ---------------------------------------------------------------- фейк-транспорт

class _FakeStreamResponse:
    """Подмена ответа client.stream(): async CM + aiter_lines/aread."""

    def __init__(self, lines: list[str], status_code: int = 200):
        self.status_code = status_code
        self._lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aread(self):
        return b""


class _FakeChatClient:
    """Подмена httpx.AsyncClient на время прогона: stream() отдаёт записанные
    SSE-ответы по одному на шаг агента, запросы считает."""

    responses: list[list[str]] = []
    requests: list[dict] = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def stream(self, method, url, json=None, **kwargs):
        _FakeChatClient.requests.append({"method": method, "url": url,
                                         "json": json})
        idx = len(_FakeChatClient.requests) - 1
        assert idx < len(_FakeChatClient.responses), (
            f"запрос №{idx + 1}, а записано шагов: {len(_FakeChatClient.responses)}")
        return _FakeStreamResponse(_FakeChatClient.responses[idx])


def _sse_lines(*chunks: dict) -> list[str]:
    lines = ["data: " + json.dumps(c, ensure_ascii=False) for c in chunks]
    lines.append("data: [DONE]")
    return lines


def _content_chunk(text: str) -> dict:
    return {"choices": [{"delta": {"content": text}}]}


def _tc_chunk(name: str, arguments: str, idx: int) -> dict:
    return {"choices": [{"delta": {"tool_calls": [
        {"index": idx, "id": f"call_{idx}",
         "function": {"name": name, "arguments": arguments}}]}}]}


def _hermes_call(name: str, args: dict) -> str:
    body = "".join(f"<parameter={k}>\n{json.dumps(v, ensure_ascii=False)}\n"
                   f"</parameter>\n" for k, v in args.items())
    return f"<tool_call><function={name}>\n{body}</function></tool_call>"


def _step_lines(canned, loop: str) -> list[str]:
    """Один canned-шаг → SSE-строки ответа модели.
    Строка — content как есть (hermes-разметка для local, для remote —
    hermes-фолбэк); объект {"content"?, "tool_calls": [...]} — native
    tool_calls (remote) или конвертируется в hermes (local)."""
    if isinstance(canned, str):
        if loop == "remote":
            return _sse_lines(_content_chunk(canned))
        return _sse_lines(_content_chunk(canned))
    content = canned.get("content") or ""
    calls = canned.get("tool_calls") or []
    if loop == "remote":
        chunks = [_content_chunk(content)] if content else []
        for i, tc in enumerate(calls):
            args = json.dumps(tc.get("arguments") or {}, ensure_ascii=False)
            chunks.append(_tc_chunk(tc["name"], args, i))
        return _sse_lines(*chunks)
    text = content + "".join(
        _hermes_call(tc["name"], tc.get("arguments") or {}) for tc in calls)
    return _sse_lines(_content_chunk(text))


# ---------------------------------------------------------------- фейк-инструменты

def _read_tools(snapshot: dict | None) -> dict:
    snap = snapshot or {}

    async def get_state(_args=None):
        models = [{"key": m.get("key"), "status": m.get("status")}
                  for m in snap.get("selectedModels") or []]
        return {"ok": True, "state": {
            "page": snap.get("page"),
            "questions": len(snap.get("questions") or []),
            "selectedModels": models,
            "hasResults": bool(snap.get("singleResults") or snap.get("runs")),
        }}

    async def list_presets(_args=None):
        return {"ok": True, "presets": []}

    async def list_models(_args=None):
        return {"ok": True, "models": [
            {"key": m.get("key"), "label": m.get("key"),
             "status": m.get("status"), "roles": ["decision"]}
            for m in snap.get("selectedModels") or []]}

    async def get_file_result(args=None):
        name = (args or {}).get("file")
        for f in snap.get("batchFiles") or []:
            if isinstance(f, dict) and f.get("name") == name:
                return {"ok": True, "file": name, "text": f.get("text"),
                        "results": f.get("results")}
        return {"ok": False, "error": f"файл {name!r} не найден в снапшоте"}

    async def get_result(_args=None):
        return {"ok": True,
                "singleResults": snap.get("singleResults") or {},
                "decisionTrace": snap.get("decisionTrace") or []}

    return {"get_state": get_state, "list_presets": list_presets,
            "list_models": list_models, "get_file_result": get_file_result,
            "get_result": get_result}


def _action_tools(snapshot: dict | None, cfg: dict) -> dict:
    """Фейк run_trial: сеть не трогаем; при ok отдаёт trial-событие,
    чтобы грейдеры/стражи видели прогон как настоящий."""
    snap = snapshot or {}

    async def run_trial(args):
        if not cfg.get("ok", True):
            return {"ok": False, "started": True,
                    "error": cfg.get("error", "сбой прогона (фейк)")}, []
        models = args.get("models") or [
            m.get("key") for m in snap.get("selectedModels") or []
            if m.get("status") == "running"] or ["eval-model"]
        questions = snap.get("questions") or []
        trial = {
            "title": args.get("title") or "Пробный прогон",
            "questions": [{"id": q.get("id", f"q{i + 1}"),
                           "question": q.get("question"), "type": q.get("type")}
                          for i, q in enumerate(questions)],
            "models": models,
            "rows": [{"model": k, "label": k, "answers": {}} for k in models],
        }
        summary = f"Фейковый прогон: {len(trial['questions'])} вопросов × {len(models)} мод."
        return {"ok": True, "summary": summary}, [{"type": "trial",
                                                   "trial": trial}]

    return {"run_trial": run_trial}


# ---------------------------------------------------------------- мутация снапшота

def _apply_proposals(snapshot: dict, events: list[dict]) -> list[str]:
    """accept=all: применить карточки хода к снапшоту (как кнопка «Принять»
    на фронте). → человекочитаемый diff для отчёта."""
    diffs = []
    for e in events:
        if e.get("type") != "proposal":
            continue
        prop = e.get("proposal") or {}
        kind, payload = prop.get("kind"), prop.get("payload") or {}
        if kind == "propose_questions":
            old = len(snapshot.get("questions") or [])
            new = []
            for i, q in enumerate(payload.get("questions") or []):
                q2 = {"n": i + 1}
                q2.update(q)
                new.append(q2)
            snapshot["questions"] = new
            titles = "; ".join(f"№{q['n']} «{str(q.get('question'))[:40]}»"
                               for q in new)
            diffs.append(f"questions {old}→{len(new)}: {titles}")
        elif kind == "propose_decision":
            outcomes = payload.get("outcomes") or []
            snapshot["decision"] = {"outcomes": outcomes}
            labels = ", ".join(str(o.get("label")) for o in outcomes)
            diffs.append(f"decision: {len(outcomes)} исхода ({labels})")
        elif kind == "propose_context":
            ctx = snapshot.setdefault("context", {})
            text = str(payload.get("text") or "")
            if payload.get("mode") == "append":
                text = ((ctx.get("text") or "") + "\n" + text).strip()
            ctx["text"] = text
            diffs.append(f"context.text ← {len(text)} симв.")
    return diffs


# ---------------------------------------------------------------- грейдеры

def _final_answer(events: list[dict]) -> str:
    """Текст, который реально увидел пользователь: токены после последнего
    сброса черновика стражем (фронт стирает доретрайный текст)."""
    last_reset = -1
    for i, e in enumerate(events):
        if e.get("type") == "tool" and e.get("name") in _DRAFT_RESET_TOOLS:
            last_reset = i
    return "".join(e.get("text") or "" for e in events[last_reset + 1:]
                   if e.get("type") == "token")


def _audit_findings(events: list[dict], user: str,
                    done_tools: set) -> list[str]:
    """Псевдо-запись журнала из событий хода → journal_audit.audit();
    находки, закрытые сработавшим стражем, прощаются."""
    tool_events = [e for e in events if e.get("type") == "tool"]
    rec = {
        "type": "chat",
        "model_key": "eval",
        "user": user,
        "answer_preview": "".join(
            e.get("text") or "" for e in events if e.get("type") == "token"),
        "steps": [{"tool": e.get("name"), "status": e.get("status")}
                  for e in tool_events],
        "proposals": [{"kind": (e.get("proposal") or {}).get("kind")}
                      for e in events if e.get("type") == "proposal"],
        "trials": [e.get("trial") for e in events if e.get("type") == "trial"],
    }
    findings, _stats = audit([rec])
    out = []
    for f in findings:
        if any(f.lstrip().startswith(prefix) and guard in done_tools
               for prefix, guard in _FORGIVING_GUARDS):
            continue
        out.append(f.strip())
    return out


def grade_turn(turn: dict, events: list[dict], requests: int,
               unused_canned: int) -> list[str]:
    """Грейдеры по исходу хода. → список провалов (пустой = PASS)."""
    g = turn.get("graders") or {}
    fails: list[str] = []
    types = [e.get("type") for e in events]
    tool_events = [e for e in events if e.get("type") == "tool"]
    tool_names = {e.get("name") for e in tool_events}
    done_tools = {e.get("name") for e in tool_events
                  if e.get("status") == "done"}

    has_error = "error" in types
    if turn.get("expect_error"):
        if not has_error:
            fails.append("ожидался исход error (expect_error), но ход "
                         "завершился без ошибки")
    elif has_error:
        msg = next((e.get("message") for e in events
                    if e.get("type") == "error"), "")
        fails.append(f"исход error: {msg}")

    for finding in _audit_findings(events, turn.get("user", ""), done_tools):
        fails.append(f"аудит: {finding}")

    if not turn.get("expect_error") and _DEGRADED_RE.search(
            _final_answer(events)):
        fails.append("CJK/мусор в финальном ответе")

    for t in g.get("required_events") or []:
        if t not in types:
            fails.append(f"нет обязательного события {t!r}")
    for t in g.get("required_tools") or []:
        if t not in done_tools:
            fails.append(f"нет обязательного tool-события {t!r} "
                         "(status done)")
    for t in g.get("forbidden_tools") or []:
        if t in tool_names:
            fails.append(f"вызывался запрещённый инструмент {t!r}")
    max_req = g.get("max_requests", DEFAULT_MAX_REQUESTS)
    if requests > max_req:
        fails.append(f"запросов к модели {requests} > {max_req}")
    if unused_canned > 0:
        fails.append(f"не израсходованы canned-ответы: {unused_canned} "
                     "(ход завершился раньше записанного)")
    return fails


# ---------------------------------------------------------------- прогон

class TurnReport:
    def __init__(self, user: str):
        self.user = user
        self.requests = 0
        self.failures: list[str] = []
        self.snapshot_diffs: list[str] = []
        self.events: list[dict] = []


class ScenarioReport:
    def __init__(self, name: str):
        self.name = name
        self.turns: list[TurnReport] = []

    @property
    def ok(self) -> bool:
        return not any(t.failures for t in self.turns)

    @property
    def failures(self) -> list[str]:
        out = []
        for i, t in enumerate(self.turns):
            for f in t.failures:
                out.append(f"ход {i + 1}: {f}")
        return out

    @property
    def requests(self) -> int:
        return sum(t.requests for t in self.turns)


async def _run_turn(turn: dict, history: list[dict], snapshot: dict | None,
                    loop: str, trial_cfg: dict, rep: TurnReport) -> None:
    canned = turn.get("canned") or []
    _FakeChatClient.responses = [_step_lines(c, loop) for c in canned]
    _FakeChatClient.requests = []
    read_tools = _read_tools(snapshot)
    action_tools = _action_tools(snapshot, trial_cfg)
    events: list[dict] = []
    failure = None
    try:
        if loop == "remote":
            entry = SimpleNamespace(key="eval-remote", label="EvalRemote",
                                    api="openrouter", api_model="eval/model",
                                    base_url=None)
            gen = agent.run_remote_agent(
                history, turn["user"], snapshot, entry,
                read_tools=read_tools, action_tools=action_tools)
        else:
            gen = agent.run_agent(
                history, turn["user"], snapshot,
                "http://eval/v1/chat/completions", False,
                read_tools, action_tools)
        async for line in gen:
            events.append(json.loads(line[len("data: "):]))
    except AssertionError as e:
        failure = f"агент запросил шагов больше, чем записано в canned: {e}"
    rep.events = events
    rep.requests = len(_FakeChatClient.requests)
    unused = len(_FakeChatClient.responses) - rep.requests
    rep.failures = ([failure] if failure else []) + grade_turn(
        turn, events, rep.requests, max(unused, 0))


async def _run_scenario_async(scn: dict, guards_off_cli: list[str],
                              verbose: bool = False) -> ScenarioReport:
    rep = ScenarioReport(scn["name"])
    snapshot = copy.deepcopy(_load_json_ref(scn, "snapshot"))
    history = copy.deepcopy(_load_json_ref(scn, "history")) or []
    loop = scn.get("loop", "local")
    trial_cfg = scn.get("trial_result") or {}

    guards = sorted(set(guards_off_cli) | set(scn.get("guards_off") or []))
    saved_client = agent.httpx.AsyncClient
    saved_guards = os.environ.get("ASSISTANT_GUARDS_OFF")
    saved_or_key = os.environ.get("OPENROUTER_API_KEY")
    agent.httpx.AsyncClient = _FakeChatClient
    if guards:
        os.environ["ASSISTANT_GUARDS_OFF"] = ",".join(guards)
    else:
        os.environ.pop("ASSISTANT_GUARDS_OFF", None)
    if loop == "remote":
        os.environ["OPENROUTER_API_KEY"] = saved_or_key or "eval-dummy"
    try:
        for turn in scn.get("turns") or []:
            trep = TurnReport(turn.get("user", ""))
            rep.turns.append(trep)
            await _run_turn(turn, history, snapshot, loop, trial_cfg, trep)
            if turn.get("accept") == "all":
                trep.snapshot_diffs = _apply_proposals(snapshot, trep.events)
            done = next((e for e in reversed(trep.events)
                         if e.get("type") == "done"), None)
            if done is not None:
                history.append({"role": "user", "content": turn.get("user", "")})
                answer = _final_answer(trep.events)
                if answer:
                    history.append({"role": "assistant", "content": answer})
    finally:
        agent.httpx.AsyncClient = saved_client
        if saved_guards is None:
            os.environ.pop("ASSISTANT_GUARDS_OFF", None)
        else:
            os.environ["ASSISTANT_GUARDS_OFF"] = saved_guards
        if saved_or_key is None:
            os.environ.pop("OPENROUTER_API_KEY", None)
        else:
            os.environ["OPENROUTER_API_KEY"] = saved_or_key
    return rep


def run_scenario(scn: dict, guards_off: list[str] | None = None,
                 verbose: bool = False) -> ScenarioReport:
    return asyncio.run(_run_scenario_async(scn, guards_off or [], verbose))


# ---------------------------------------------------------------- CLI

def _print_report(rep: ScenarioReport, verbose: bool) -> None:
    status = "PASS" if rep.ok else "FAIL"
    print(f"{status}  {rep.name} — ходов: {len(rep.turns)}, "
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--scenario", default=None,
                    help="прогнать один сценарий по имени")
    ap.add_argument("--guards-off", default="",
                    help="стражи через запятую (phantom,degrade) — демонтажный "
                         "прогон: сценарии, требующие этих стражей, должны упасть")
    ap.add_argument("--verbose", action="store_true",
                    help="печатать события каждого хода")
    args = ap.parse_args()

    guards_off = [s.strip() for s in args.guards_off.split(",") if s.strip()]
    try:
        scenarios = [load_scenario(args.scenario)] if args.scenario \
            else load_scenarios()
    except KeyError as e:
        print(e.args[0])
        return 2
    if not scenarios:
        print(f"сценариев не найдено в {SCENARIOS_DIR}")
        return 2

    if guards_off:
        print(f"ДЕМОНТАЖНЫЙ ПРОГОН: стражи выключены: {', '.join(guards_off)}")
    reports = []
    for scn in scenarios:
        rep = run_scenario(scn, guards_off, args.verbose)
        reports.append(rep)
        _print_report(rep, args.verbose)
    passed = sum(1 for r in reports if r.ok)
    print(f"\nИтог: {passed}/{len(reports)} PASS")
    return 0 if passed == len(reports) else 1


if __name__ == "__main__":
    raise SystemExit(main())
