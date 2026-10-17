"""Аудит журнала ассистента (server/logs/assistant.jsonl).

Ищет по записям type:"chat" дефекты, которые стражи должны были поймать
или которые стражам неподвластны:
- trial-claim в финальном ответе без события trial (выдуманный прогон);
- proposal-claim без события proposal (фантомная карточка);
- generic-claim («пробую ещё раз») без любых action-событий;
- CJK/тарабарщина в финальном ответе (деградация модели);
- дословные повторы ответа подряд (модель зациклилась текстом).

Плюс статистика срабатываний стражей (phantom_guard / degrade_guard /
retry / steps) — критерий их удаления: 0 за несколько сессий.

Запуск: .venv-test/bin/python scripts/journal_audit.py [--file PATH]
[--tail N] [--since YYYY-MM-DD]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.assistant.agent import (  # noqa: E402
    _DEGRADED_RE, _GENERIC_CLAIM_RE, _PROPOSAL_CLAIM_RE, _TRIAL_CLAIM_RE)

_GUARD_TOOLS = ("phantom_guard", "degrade_guard", "retry", "steps")


def _load_records(path: Path, tail: int, since: str | None) -> list[dict]:
    records = []
    if not path.exists():
        return records
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("type") != "chat":
            continue
        if since and str(rec.get("ts", ""))[:10] < since:
            continue
        records.append(rec)
    return records[-tail:] if tail else records


def audit(records: list[dict]) -> tuple[list[str], dict[str, int]]:
    findings: list[str] = []
    stats: dict[str, int] = {name: 0 for name in _GUARD_TOOLS}
    stats["chats"] = len(records)
    prev_preview = ""
    for rec in records:
        ts = str(rec.get("ts", ""))[:19]
        who = rec.get("model_key", "?")
        preview = rec.get("answer_preview") or ""
        steps = rec.get("steps") or []
        step_names = [s.get("tool") for s in steps]
        for name in _GUARD_TOOLS:
            stats[name] += step_names.count(name)
        has_trial = bool(rec.get("trials"))
        has_proposal = bool(rec.get("proposals"))
        label = f"{ts} [{who}] «{(rec.get('user') or '')[:60]}»"

        if _TRIAL_CLAIM_RE.search(preview) and not has_trial:
            findings.append(f"ФАНТОМ-ПРОГОН  {label}: {preview[:120]}")
        if _PROPOSAL_CLAIM_RE.search(preview) and not has_proposal:
            findings.append(f"ФАНТОМ-КАРТОЧКА {label}: {preview[:120]}")
        if (_GENERIC_CLAIM_RE.search(preview) and not has_trial
                and not has_proposal):
            findings.append(f"ФАНТОМ-ОБЕЩАНИЕ {label}: {preview[:120]}")
        if _DEGRADED_RE.search(preview):
            findings.append(f"ДЕГРАДАЦИЯ    {label}: {preview[:120]}")
        if len(preview) >= 80 and preview == prev_preview:
            findings.append(f"ПОВТОР ОТВЕТА {label}: {preview[:120]}")
        prev_preview = preview
    return findings, stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--file", default=str(
        Path(__file__).resolve().parent.parent
        / "server" / "logs" / "assistant.jsonl"))
    ap.add_argument("--tail", type=int, default=0,
                    help="только последние N записей")
    ap.add_argument("--since", default=None,
                    help="только записи не старше YYYY-MM-DD")
    args = ap.parse_args()

    records = _load_records(Path(args.file), args.tail, args.since)
    if not records:
        print("записей не найдено")
        return 0
    findings, stats = audit(records)
    print(f"записей: {stats.pop('chats')}; стражи: "
          + ", ".join(f"{k}={v}" for k, v in stats.items()))
    if findings:
        print(f"\nНАХОДКИ ({len(findings)}):")
        for f in findings:
            print(" ", f)
        return 1
    print("находок нет")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
