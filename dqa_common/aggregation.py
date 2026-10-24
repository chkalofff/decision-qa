"""Versioned aggregation over canonical model runs."""

from __future__ import annotations

import copy
import math
from collections.abc import Iterable, Mapping
from typing import Any

from . import AGGREGATION_POLICY
from .decision import evaluate_decision, explain_decision

_CANONICAL_MODE = "decisions"


def _job_mode(config: Mapping[str, Any]) -> str:
    return (config.get("settings") or {}).get("mode", "decisions")


def _is_canonical(run: Mapping[str, Any], job_mode: str) -> bool:
    return job_mode == "fast_batch" or run.get("mode") == _CANONICAL_MODE


def _successful_canonical(runs: list[dict], job_mode: str) -> list[dict]:
    return [run for run in runs if _is_canonical(run, job_mode) and run.get("ok") is True]


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _options(question: Mapping[str, Any]) -> list[str]:
    if question["type"] == "yes_no":
        return ["yes", "no"]
    if question["type"] == "choice":
        return [option["name"] for option in question["options"]]
    return []


def _aggregate_question(question: Mapping[str, Any], answers: list[Mapping[str, Any]]) -> dict | None:
    qtype = question["type"]
    if qtype == "score":
        score = _mean([answer["score"] for answer in answers if _finite(answer.get("score"))])
        return None if score is None else {"type": "score", "score": score}
    options = _options(question)
    probabilities = {}
    for option in options:
        values = []
        for answer in answers:
            distribution = answer.get("probabilities")
            value = distribution.get(option) if isinstance(distribution, Mapping) else None
            if _finite(value):
                values.append(value)
        mean = _mean(values)
        if mean is not None:
            probabilities[option] = mean
    if not probabilities:
        return None
    top = max(options, key=lambda option: probabilities.get(option, -math.inf))
    result = {
        "type": qtype,
        "answer": top,
        "confidence": probabilities[top],
        "probabilities": probabilities,
    }
    if qtype == "choice":
        result["choice"] = top
    return result


def _sum_usage(runs: Iterable[Mapping[str, Any]]) -> dict:
    totals = {}

    def add(target: dict, source: Mapping[str, Any]) -> None:
        for key, value in source.items():
            if _finite(value):
                target[key] = target.get(key, 0) + value
            elif isinstance(value, Mapping):
                nested = target.setdefault(key, {})
                if isinstance(nested, dict):
                    add(nested, value)

    for run in runs:
        usage = run.get("usage")
        if isinstance(usage, Mapping):
            add(totals, usage)
    return totals


def _errors(runs: Iterable[Mapping[str, Any]]) -> list[dict]:
    errors = []
    for run in runs:
        if run.get("ok") is True:
            continue
        errors.append({
            "model": run.get("model"),
            "mode": run.get("mode"),
            "error": copy.deepcopy(run.get("error", run.get("errors"))),
        })
    return errors


def aggregate_mean_probability_v1(config: Mapping[str, Any], canonical_runs: Iterable[Mapping[str, Any]]) -> dict:
    """Aggregate the successful canonical pass for the configured job mode.

    Canonical run shape (camelCase output from the decision engine is intentional):
    ``{model: str, mode: "decisions"|"fast_batch", ok: bool,
    answers: {qid: answer}, usage?: object, metrics?: object, error?: any}``.
    A run represents one model/mode/material inference. ``answers`` retains the
    backend's raw yes_no/choice/score values. Runs may also carry arbitrary raw
    adapter fields; the returned ``runs`` and ``by_model`` preserve them.

    In ``decisions`` and ``both``, only successful ordinary runs feed the
    aggregate; fast runs in ``both`` remain diagnostic. In ``fast_batch`` every
    successful sole pass feeds it: native fast runs plus SystemOne/remote-chat
    ordinary runs. No SystemOne/remote fast run is synthesized.

    Each aggregated ``answers[qid]`` also carries ``by_model`` with that
    question's successful canonical probabilities/score per model. Missing
    answers/components are skipped rather than treated as zero. Numeric usage
    fields are summed across actual runs (including diagnostics); wall durations
    stay only in per-run metrics and are never summed here.
    """
    normalized_runs = [copy.deepcopy(dict(run)) for run in canonical_runs]
    for index, run in enumerate(normalized_runs):
        if not isinstance(run.get("model"), str) or not run["model"]:
            raise ValueError(f"runs[{index}].model must be a nonempty string")
        if run.get("mode") not in {"decisions", "fast_batch"}:
            raise ValueError(f"runs[{index}].mode must be decisions or fast_batch")
        if not isinstance(run.get("ok"), bool):
            raise ValueError(f"runs[{index}].ok must be boolean")
        if "answers" in run and not isinstance(run["answers"], Mapping):
            raise ValueError(f"runs[{index}].answers must be an object")
        run.setdefault("answers", {})
    job_mode = _job_mode(config)
    canonical = _successful_canonical(normalized_runs, job_mode)
    answers = {}
    for question in config["questions"]:
        qid = question["id"]
        available = [
            run["answers"][qid]
            for run in canonical
            if isinstance(run["answers"].get(qid), Mapping)
        ]
        aggregate = _aggregate_question(question, available)
        if aggregate is not None:
            per_model = {}
            for run in canonical:
                answer = run["answers"].get(qid)
                if question["type"] == "score":
                    if _finite(answer.get("score")):
                        per_model[run["model"]] = answer["score"]
                    continue
                distribution = answer.get("probabilities")
                probabilities = {
                    option: distribution.get(option)
                    for option in _options(question)
                    if isinstance(distribution, Mapping) and _finite(distribution.get(option))
                }
                if probabilities:
                    per_model[run["model"]] = probabilities
            aggregate["by_model"] = per_model
            answers[qid] = aggregate
    decision_config = config["decision"]
    decision_enabled = decision_config.get("enabled", True)
    aggregate_decision = evaluate_decision(decision_config, answers) if canonical and decision_enabled else None
    aggregate_trace = explain_decision(decision_config, answers)["trace"] if canonical and decision_enabled else []
    by_model = {}
    for run in normalized_runs:
        model_entry = by_model.setdefault(run["model"], {"runs": [], "decision": None, "trace": []})
        model_entry["runs"].append(copy.deepcopy(run))
        if run["ok"] and decision_enabled and _is_canonical(run, job_mode):
            explanation = explain_decision(decision_config, run["answers"])
            model_entry["decision"] = explanation["res"]
            model_entry["trace"] = explanation["trace"]
    return {
        "policy": AGGREGATION_POLICY,
        "answers": answers,
        "decision": aggregate_decision,
        "trace": aggregate_trace,
        "by_model": by_model,
        "runs": normalized_runs,
        "errors": _errors(normalized_runs),
        "usage": _sum_usage(normalized_runs),
        "metrics": {
            "runs_total": len(normalized_runs),
            "decisions_runs_total": sum(run.get("mode") == _CANONICAL_MODE for run in normalized_runs),
            "decisions_runs_succeeded": sum(
                run.get("mode") == _CANONICAL_MODE and run.get("ok") is True for run in normalized_runs
            ),
        },
    }
