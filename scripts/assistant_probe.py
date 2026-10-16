#!/usr/bin/env python3
"""Headless-пробник ассистента (v0.8): шлёт сообщение в /api/assistant/chat,
собирает SSE-стрим и печатает компактный транскрипт — шаги с аргументами и
длительностью, предложения, пробные прогоны, финальный ответ, исход.

После стрима сверяет результат с последней записью type:"chat" в журнале
server/logs/assistant.jsonl (журнал — источник истины для разбора диалогов).

Примеры:
  scripts/assistant_probe.py -m "Что у меня в контексте?" \
      --snapshot docs/evals/fixtures/snapshot_single.json
  scripts/assistant_probe.py -m "..." --model bonsai2-27b --thinking --validate

Код выхода: 1, если исход стрима — error, журнал не совпал или --validate
нашёл невалидное предложение; 0 иначе.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_JOURNAL = REPO_ROOT / "server" / "logs" / "assistant.jsonl"
DEFAULT_MODEL = "remote-deepseek-v4-1-flash-openrouter"


def load_json(path: str | None):
    if not path:
        return None
    return json.loads(Path(path).read_text(encoding="utf-8"))


def post_chat(base: str, payload: dict):
    req = urllib.request.Request(
        f"{base}/api/assistant/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    return urllib.request.urlopen(req, timeout=600)


def post_validate(base: str, kind: str, payload) -> tuple[bool, str]:
    req = urllib.request.Request(
        f"{base}/api/assistant/propose/validate",
        data=json.dumps({"kind": kind, "payload": payload}).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            json.loads(r.read())
            return True, ""
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("detail", str(e))
        except Exception:  # noqa: BLE001
            detail = str(e)
        return False, str(detail)


def last_journal_record(journal: Path) -> dict | None:
    if not journal.exists():
        return None
    last = None
    for line in journal.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("type") == "chat":
            last = rec
    return last


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-m", "--message", required=True)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--snapshot", help="JSON-файл со снапшотом (формат buildSnapshot)")
    ap.add_argument("--history", help="JSON-файл с историей [{role, content}]")
    ap.add_argument("--thinking", action="store_true")
    ap.add_argument("--validate", action="store_true",
                    help="прогнать предложения через /api/assistant/propose/validate")
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--journal", default=str(DEFAULT_JOURNAL))
    ap.add_argument("--raw", action="store_true", help="печатать сырые SSE-события")
    args = ap.parse_args()

    payload = {"model_key": args.model, "message": args.message,
               "thinking": args.thinking}
    snapshot = load_json(args.snapshot)
    if snapshot is not None:
        payload["snapshot"] = snapshot
    history = load_json(args.history)
    if history is not None:
        payload["history"] = history

    print(f"→ {args.model}: {args.message}")
    if snapshot:
        print(f"  снапшот: {args.snapshot} ({len(json.dumps(snapshot, ensure_ascii=False))} симв.)")

    steps: list[dict] = []
    proposals: list[dict] = []
    trials: list[dict] = []
    answer_parts: list[str] = []
    outcome = "incomplete"
    error_msg = None
    started = time.monotonic()
    step_started: dict[str, float] = {}

    try:
        resp = post_chat(args.base, payload)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:500]
        print(f"✗ HTTP {e.code}: {body}")
        return 1

    buffer = ""
    while True:
        chunk = resp.read(4096)
        if not chunk:
            break
        buffer += chunk.decode("utf-8", "replace")
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if not line.startswith("data:"):
                continue
            try:
                ev = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
            if args.raw:
                print(f"  sse: {json.dumps(ev, ensure_ascii=False)[:400]}")
            t = ev.get("type")
            if t == "tool":
                name = ev.get("name") or ""
                status = ev.get("status")
                if status == "start":
                    step_started[name] = time.monotonic()
                    a = ev.get("args")
                    print(f"  ⚙ {name}({a})" if a else f"  ⚙ {name}…")
                else:
                    ms = round((time.monotonic() - step_started.pop(name, time.monotonic())) * 1000)
                    steps.append({"tool": name, "status": status, "ms": ms})
                    mark = "✓" if status == "done" else "✗"
                    msg = f" — {ev.get('message')}" if ev.get("message") else ""
                    print(f"  {mark} {name} {ms} мс{msg}")
            elif t == "proposal":
                p = ev.get("proposal") or {}
                proposals.append(p)
                print(f"  ▣ предложение {p.get('kind')}: {p.get('title')}")
            elif t == "trial":
                tr = ev.get("trial") or {}
                trials.append(tr)
                print(f"  ▶ trial {tr.get('models')}: ok={tr.get('ok', True)}")
            elif t == "token":
                answer_parts.append(ev.get("text") or "")
            elif t == "error":
                outcome = "error"
                error_msg = ev.get("message")
                print(f"  ✗ ошибка: {error_msg}")
            elif t == "done":
                outcome = "done"

    elapsed = time.monotonic() - started
    answer = "".join(answer_parts)
    print()
    print("── ответ ──")
    print(answer[:3000] if answer else "(пусто)")
    print()
    print(f"── итог: {outcome} · {elapsed:.1f} с · шагов {len(steps)} · "
          f"предложений {len(proposals)} · trial {len(trials)} ──")

    rc = 0 if outcome != "error" else 1

    # сверка с журналом
    rec = last_journal_record(Path(args.journal))
    if rec is None:
        print("журнал: записей type:chat не найдено")
        rc = 1
    else:
        same = (rec.get("outcome") in (outcome, "abort")
                and len(rec.get("steps") or []) == len(steps)
                and len(rec.get("proposals") or []) == len(proposals))
        mark = "✓" if same else "✗ РАСХОЖДЕНИЕ"
        print(f"журнал: {mark} outcome={rec.get('outcome')} "
              f"steps={len(rec.get('steps') or [])} "
              f"proposals={rec.get('proposals')} fallback={rec.get('fallback')} "
              f"duration={rec.get('duration_ms')} мс")
        if not same:
            rc = 1

    if args.validate:
        for p in proposals:
            ok, detail = post_validate(args.base, p.get("kind", ""), p.get("payload"))
            print(f"validate {p.get('kind')}: {'✓' if ok else '✗ ' + detail}")
            if not ok:
                rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
