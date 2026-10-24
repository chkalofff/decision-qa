"""Python port of the deterministic decision engine in decision.js."""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any


def _js_truthy(value: Any) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0 and not (isinstance(value, float) and math.isnan(value))
    if isinstance(value, str):
        return bool(value)
    return True


def _get(value: Any, key: Any, default: Any = None) -> Any:
    if isinstance(value, Mapping):
        return value.get(key, default)
    if isinstance(value, (list, tuple)) and isinstance(key, str):
        try:
            index = int(key)
        except ValueError:
            return default
        if str(index) == key and 0 <= index < len(value):
            return value[index]
    return default


def condition_detail(cond: Mapping[str, Any], answers: Any) -> dict[str, Any]:
    """Evaluate one condition and return the JS-shaped trace detail."""
    op = "lt" if cond.get("op") == "lt" else "gte"
    ans = _get(answers, cond.get("question"))
    if cond.get("answer") is not None:
        threshold = cond.get("threshold") if cond.get("threshold") is not None else 0.5
        value = None
        if _js_truthy(ans):
            probabilities = _get(ans, "probabilities")
            if not _js_truthy(probabilities):
                probabilities = {}
            value = _get(probabilities, cond.get("answer"))
        ok = value is not None and (value < threshold if op == "lt" else value >= threshold)
        return {
            "ok": bool(ok),
            "kind": "prob",
            "question": cond.get("question"),
            "answer": cond.get("answer"),
            "value": value,
            "threshold": threshold,
            "op": op,
        }
    threshold = cond.get("score") if cond.get("score") is not None else 0
    value = _get(ans, "score") if _js_truthy(ans) else None
    ok = value is not None and (value < threshold if op == "lt" else value >= threshold)
    return {
        "ok": bool(ok),
        "kind": "score",
        "question": cond.get("question"),
        "value": value,
        "threshold": threshold,
        "op": op,
    }


def eval_rules(decision: Mapping[str, Any], answers: Any) -> tuple[list[dict], dict | None, Mapping | None]:
    """Return ``(trace, hit_entry, first_default)`` with first-hit ordering."""
    fallback = None
    trace = []
    hit_entry = None
    for outcome in decision["outcomes"]:
        if _js_truthy(outcome.get("isDefault")) and fallback is None:
            fallback = outcome
        rules = outcome.get("rules") or []
        for rule_idx, rule in enumerate(rules):
            conditions = rule.get("conditions") or []
            if not conditions:
                continue
            details = [condition_detail(cond, answers) for cond in conditions]
            if _js_truthy(rule.get("anyOf")):
                hit = any(detail["ok"] for detail in details)
            else:
                hit = all(detail["ok"] for detail in details)
            entry = {
                "outcomeId": outcome.get("id"),
                "label": outcome.get("label"),
                "color": outcome.get("color"),
                "ruleIdx": rule_idx,
                "anyOf": _js_truthy(rule.get("anyOf")),
                "hit": hit,
                "conditions": details,
            }
            trace.append(entry)
            if hit:
                hit_entry = {"o": outcome, "entry": entry}
                return trace, hit_entry, fallback
    return trace, hit_entry, fallback


def evaluate_decision(decision: Any, answers: Any) -> dict[str, Any] | None:
    """Return the first hit, then the first default, otherwise ``None``."""
    if (
        not _js_truthy(decision)
        or not isinstance(decision, Mapping)
        or not isinstance(decision.get("outcomes"), list)
        or not _js_truthy(answers)
    ):
        return None
    trace, hit_entry, fallback = eval_rules(decision, answers)
    if hit_entry is not None:
        outcome = hit_entry["o"]
        return {
            "outcomeId": outcome.get("id"),
            "label": outcome.get("label"),
            "color": outcome.get("color"),
            "ruleIdx": hit_entry["entry"]["ruleIdx"],
            "isDefault": False,
            "trace": trace,
        }
    if fallback is not None:
        return {
            "outcomeId": fallback.get("id"),
            "label": fallback.get("label"),
            "color": fallback.get("color"),
            "ruleIdx": -1,
            "isDefault": True,
            "trace": trace,
        }
    return None


def explain_decision(decision: Any, answers: Any) -> dict[str, Any]:
    """Return ``{res, trace}`` without discarding the no-outcome trace."""
    result = evaluate_decision(decision, answers)
    if result is not None:
        return {"res": result, "trace": result.get("trace") or []}
    if (
        not _js_truthy(decision)
        or not isinstance(decision, Mapping)
        or not isinstance(decision.get("outcomes"), list)
        or not _js_truthy(answers)
    ):
        return {"res": None, "trace": []}
    return {"res": None, "trace": eval_rules(decision, answers)[0]}
