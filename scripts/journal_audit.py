"""Аудит журнала ассистента (server/state/users/local/assistant.jsonl).

Ищет по записям type:"chat" дефекты, которые стражи должны были поймать
или которые стражам неподвластны:
- trial-claim в финальном ответе без события trial (выдуманный прогон);
- proposal-claim без события proposal (фантомная карточка);
- generic-claim («пробую ещё раз») без любых action-событий;
- CJK/тарабарщина в финальном ответе (деградация модели);
- дословные повторы ответа подряд (модель зациклилась текстом).

Плюс статистика срабатываний стражей (phantom_guard / degrade_guard /
retry / steps) — критерий их удаления: 0 за несколько сессий.

Режим --metrics (v1.2): агрегированные метрики качества вместо находок —
phantom rate, validation-loop rate, guard-rescue rate, fallback rate,
разрезы по модели и по длине сессии (session_id; записи без него —
«legacy», в разрез сессий не входят).

Запуск: .venv-test/bin/python scripts/journal_audit.py [--file PATH]
[--tail N] [--since YYYY-MM-DD] [--metrics]
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

# Стражи, чьё появление среди steps = «спасение» хода (guard-rescue rate)
_RESCUE_TOOLS = frozenset(("phantom_guard", "degrade_guard", "retry"))

# Bucket'ы длины сессии (число chat-ходов с одним session_id)
_SESSION_BUCKETS = ((1, 3, "1–3"), (4, 10, "4–10"), (11, None, "11+"))


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


# ---------------------------------------------------------------- метрики

def _has_phantom(rec: dict) -> bool:
    """Фантом-находка по тем же правилам, что и audit(): claim в превью
    ответа без соответствующего события (trial/proposal) в записи."""
    preview = rec.get("answer_preview") or ""
    has_trial = bool(rec.get("trials"))
    has_proposal = bool(rec.get("proposals"))
    return bool((_TRIAL_CLAIM_RE.search(preview) and not has_trial)
                or (_PROPOSAL_CLAIM_RE.search(preview) and not has_proposal)
                or (_GENERIC_CLAIM_RE.search(preview) and not has_trial
                    and not has_proposal))


def _count_loops(rec: dict) -> tuple[int, int]:
    """Петли валидации внутри записи: серия из ≥2 подряд идущих шагов
    со status=="error" одного и того же tool. → (число петель, из них
    серий длины 3+)."""
    loops = loops3 = 0
    run_tool: str | None = None
    run_len = 0
    for step in rec.get("steps") or []:
        if step.get("status") == "error":
            if step.get("tool") == run_tool:
                run_len += 1
            else:
                if run_len >= 2:
                    loops += 1
                    loops3 += run_len >= 3
                run_tool, run_len = step.get("tool"), 1
        else:
            if run_len >= 2:
                loops += 1
                loops3 += run_len >= 3
            run_tool, run_len = None, 0
    if run_len >= 2:
        loops += 1
        loops3 += run_len >= 3
    return loops, loops3


def _aggregate(records: list[dict]) -> dict:
    """Метрики по срезу chat-записей: доли — от числа записей в срезе."""
    n = len(records)
    phantom = guard_rescue = fallback = loop_records = loops = loops3 = 0
    for rec in records:
        phantom += _has_phantom(rec)
        l, l3 = _count_loops(rec)
        loops += l
        loops3 += l3
        loop_records += l > 0
        tools = {s.get("tool") for s in rec.get("steps") or []}
        guard_rescue += bool(tools & _RESCUE_TOOLS)
        fallback += rec.get("fallback") is True

    def rate(part: int) -> float:
        return round(part / n, 4) if n else 0.0

    return {
        "records": n,
        "phantom": {"records": phantom, "rate": rate(phantom)},
        "validation_loops": {"records": loop_records, "rate": rate(loop_records),
                             "loops": loops, "loops_3plus": loops3},
        "guard_rescue": {"records": guard_rescue, "rate": rate(guard_rescue)},
        "fallback": {"records": fallback, "rate": rate(fallback)},
    }


def metrics(records: list[dict]) -> dict:
    """Агрегированные метрики журнала (v1.2): глобальные + разрезы по
    model_key и по длине сессии. Записи без session_id — «legacy»: в
    глобальные метрики входят, в разрез сессий — нет."""
    by_model: dict[str, list[dict]] = {}
    sessions: dict[str, list[dict]] = {}
    legacy = 0
    for rec in records:
        by_model.setdefault(str(rec.get("model_key") or "?"), []).append(rec)
        sid = rec.get("session_id")
        if sid:
            sessions.setdefault(str(sid), []).append(rec)
        else:
            legacy += 1
    by_bucket: dict[str, dict] = {}
    for lo, hi, label in _SESSION_BUCKETS:
        bucket_recs = [rec for recs in sessions.values()
                       if len(recs) >= lo and (hi is None or len(recs) <= hi)
                       for rec in recs]
        agg = _aggregate(bucket_recs)
        agg["sessions"] = sum(1 for recs in sessions.values()
                              if len(recs) >= lo and (hi is None or len(recs) <= hi))
        by_bucket[label] = agg
    return {
        "global": _aggregate(records),
        "legacy_records": legacy,
        "by_model": {k: _aggregate(v) for k, v in sorted(by_model.items())},
        "by_session_length": by_bucket,
    }


def _fmt_pct(rate: float) -> str:
    return f"{rate * 100:.1f}%"


def _print_metrics_block(label: str, agg: dict, indent: str = "") -> None:
    n = agg["records"]
    vl = agg["validation_loops"]
    print(f"{indent}{label}: записей {n}, "
          f"phantom {agg['phantom']['records']} ({_fmt_pct(agg['phantom']['rate'])}), "
          f"петли: записей {vl['records']} ({_fmt_pct(vl['rate'])}), "
          f"петель {vl['loops']}, серий 3+ {vl['loops_3plus']}, "
          f"guard-rescue {agg['guard_rescue']['records']} "
          f"({_fmt_pct(agg['guard_rescue']['rate'])}), "
          f"fallback {agg['fallback']['records']} "
          f"({_fmt_pct(agg['fallback']['rate'])})")


def print_metrics(m: dict) -> None:
    g = m["global"]
    print(f"записей: {g['records']} (legacy без session_id: {m['legacy_records']})")
    _print_metrics_block("всего", g)
    if m["by_model"]:
        print("\nпо моделям:")
        for model, agg in m["by_model"].items():
            _print_metrics_block(model, agg, indent="  ")
    print("\nпо длине сессии:")
    for label, agg in m["by_session_length"].items():
        _print_metrics_block(f"{label} ходов (сессий {agg['sessions']})", agg,
                             indent="  ")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--file", default=str(
        Path(__file__).resolve().parent.parent
        / "server" / "state" / "users" / "local" / "assistant.jsonl"))
    ap.add_argument("--tail", type=int, default=0,
                    help="только последние N записей")
    ap.add_argument("--since", default=None,
                    help="только записи не старше YYYY-MM-DD")
    ap.add_argument("--metrics", action="store_true",
                    help="агрегированные метрики (без находок)")
    args = ap.parse_args()

    records = _load_records(Path(args.file), args.tail, args.since)
    if not records:
        print("записей не найдено")
        return 0
    if args.metrics:
        print_metrics(metrics(records))
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
