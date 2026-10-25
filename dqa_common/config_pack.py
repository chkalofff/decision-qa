"""Versioned config-pack normalization, validation, JCS hashes and overrides."""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import math
import os
import re
from typing import Any, IO

import rfc8785

from . import AGGREGATION_POLICY, FINGERPRINT_VERSION, PACK_VERSION

_HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_MODES = {"decisions", "fast_batch", "both"}
_DIRECTIONS = {
    "yes_no": {"yes", "no", "neutral"},
    "score": {"up", "down", "neutral"},
}
_TOP_LEVEL = {
    "version", "fingerprint_version", "name", "description", "questions",
    "decision", "settings", "hash", "fingerprint", "ui",
}


class ConfigPackError(ValueError):
    """A structurally invalid, non-canonicalizable or mismatched config pack."""


def _fail(path: str, message: str) -> None:
    raise ConfigPackError(f"{path}: {message}")


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _check_json(value: Any, path: str) -> None:
    if value is None or isinstance(value, (str, bool)):
        return
    if _is_number(value):
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _check_json(item, f"{path}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                _fail(path, "JSON object keys must be strings")
            _check_json(item, f"{path}.{key}")
        return
    _fail(path, "value is not finite JSON data")


def _required_dict(value: Any, path: str) -> dict:
    if not isinstance(value, dict):
        _fail(path, "expected an object")
    return value


def _required_list(value: Any, path: str) -> list:
    if not isinstance(value, list):
        _fail(path, "expected an array")
    return value


def _required_string(value: Any, path: str, *, nonempty: bool = False) -> str:
    if not isinstance(value, str):
        _fail(path, "expected a string")
    if nonempty and not value.strip():
        _fail(path, "must not be empty")
    return value


def _normalize_question(question: Any, index: int) -> dict:
    path = f"questions[{index}]"
    source = _required_dict(question, path)
    result = copy.deepcopy(source)
    qid = _required_string(source.get("id"), f"{path}.id", nonempty=True)
    result["question"] = _required_string(source.get("question", ""), f"{path}.question")
    qtype = _required_string(source.get("type"), f"{path}.type")
    if qtype not in {"yes_no", "choice", "score"}:
        _fail(f"{path}.type", f"unsupported question type {qtype!r}")
    direction = source.get("direction")
    if direction is not None:
        if qtype not in _DIRECTIONS or direction not in _DIRECTIONS[qtype]:
            _fail(f"{path}.direction", f"invalid direction {direction!r} for {qtype}")
    for key in ("yes", "no"):
        if key in source and source[key] is not None:
            _required_string(source[key], f"{path}.{key}")
    if qtype == "choice":
        options = _required_list(source.get("options"), f"{path}.options")
        if not 2 <= len(options) <= 26:
            _fail(f"{path}.options", "choice requires 2..26 options")
        seen = set()
        normalized_options = []
        for option_index, option in enumerate(options):
            option_path = f"{path}.options[{option_index}]"
            option_source = _required_dict(option, option_path)
            option_result = copy.deepcopy(option_source)
            name = _required_string(option_source.get("name"), f"{option_path}.name", nonempty=True)
            if "\n" in name or "\r" in name:
                _fail(f"{option_path}.name", "newlines are not allowed")
            folded = name.strip().casefold()
            if folded in seen:
                _fail(f"{option_path}.name", f"duplicate option name {name!r}")
            seen.add(folded)
            if option_source.get("description") is not None:
                _required_string(option_source["description"], f"{option_path}.description")
            normalized_options.append(option_result)
        result["options"] = normalized_options
    elif qtype == "score":
        levels = _required_list(source.get("levels"), f"{path}.levels")
        if not 2 <= len(levels) <= 10:
            _fail(f"{path}.levels", "score requires 2..10 levels")
        for level_index, level in enumerate(levels):
            _required_string(level, f"{path}.levels[{level_index}]")
    return result


def _normalize_condition(condition: Any, path: str, questions: dict[str, dict]) -> dict:
    source = _required_dict(condition, path)
    result = copy.deepcopy(source)
    qid = _required_string(source.get("question"), f"{path}.question", nonempty=True)
    if qid not in questions:
        _fail(f"{path}.question", f"unknown question id {qid!r}")
    op = source.get("op", "gte")
    if op not in ("gte", "lt"):
        _fail(f"{path}.op", "expected 'gte' or 'lt'")
    result["op"] = op
    question = questions[qid]
    answer = source.get("answer")
    if answer is not None:
        _required_string(answer, f"{path}.answer")
        if question["type"] == "score":
            _fail(f"{path}.answer", "score conditions use score, not answer")
        options = ["yes", "no"] if question["type"] == "yes_no" else [o["name"] for o in question["options"]]
        if answer not in options:
            _fail(f"{path}.answer", f"question {qid!r} has no answer {answer!r}")
        threshold = source.get("threshold")
        if not _is_number(threshold) or not 0 <= threshold <= 1:
            _fail(f"{path}.threshold", "expected a finite number in 0..1")
    else:
        if question["type"] != "score":
            _fail(f"{path}.answer", "non-score conditions require answer and threshold")
        score = source.get("score")
        max_score = len(question["levels"]) - 1
        if not _is_number(score) or not 0 <= score <= max_score:
            _fail(f"{path}.score", f"expected a finite number in 0..{max_score}")
    return result


def _normalize_decision(decision: Any, questions: list[dict]) -> dict:
    source = _required_dict(decision, "decision")
    result = copy.deepcopy(source)
    enabled = source.get("enabled", True)
    if not isinstance(enabled, bool):
        _fail("decision.enabled", "expected a boolean")
    result["enabled"] = enabled
    outcomes = _required_list(source.get("outcomes"), "decision.outcomes")
    result["outcomes"] = []
    qmap = {question["id"]: question for question in questions}
    outcome_ids = set()
    labels = set()
    defaults = 0
    for outcome_index, outcome in enumerate(outcomes):
        path = f"decision.outcomes[{outcome_index}]"
        outcome_source = _required_dict(outcome, path)
        outcome_result = copy.deepcopy(outcome_source)
        outcome_id = _required_string(outcome_source.get("id"), f"{path}.id", nonempty=True)
        if outcome_id in outcome_ids:
            _fail(f"{path}.id", f"duplicate outcome id {outcome_id!r}")
        outcome_ids.add(outcome_id)
        label = _required_string(outcome_source.get("label"), f"{path}.label", nonempty=True)
        folded_label = label.strip()
        if folded_label in labels:
            _fail(f"{path}.label", f"duplicate outcome label {label!r}")
        labels.add(folded_label)
        if "color" in outcome_source:
            _required_string(outcome_source["color"], f"{path}.color")
        is_default = outcome_source.get("isDefault", False)
        if not isinstance(is_default, bool):
            _fail(f"{path}.isDefault", "expected a boolean")
        outcome_result["isDefault"] = is_default
        defaults += int(is_default)
        rules = _required_list(outcome_source.get("rules", []), f"{path}.rules")
        outcome_result["rules"] = []
        for rule_index, rule in enumerate(rules):
            rule_path = f"{path}.rules[{rule_index}]"
            rule_source = _required_dict(rule, rule_path)
            rule_result = copy.deepcopy(rule_source)
            any_of = rule_source.get("anyOf", False)
            if not isinstance(any_of, bool):
                _fail(f"{rule_path}.anyOf", "expected a boolean")
            rule_result["anyOf"] = any_of
            conditions = _required_list(rule_source.get("conditions", []), f"{rule_path}.conditions")
            rule_result["conditions"] = [
                _normalize_condition(condition, f"{rule_path}.conditions[{condition_index}]", qmap)
                for condition_index, condition in enumerate(conditions)
            ]
            outcome_result["rules"].append(rule_result)
        result["outcomes"].append(outcome_result)
    if defaults > 1:
        _fail("decision.outcomes", "at most one default outcome is allowed")
    return result


def _normalize_settings(settings: Any) -> dict:
    source = _required_dict(settings, "settings")
    result = copy.deepcopy(source)
    mode = source.get("mode")
    if mode not in _MODES:
        _fail("settings.mode", "expected decisions, fast_batch or both")
    models = _required_list(source.get("models"), "settings.models")
    seen = set()
    for index, model in enumerate(models):
        _required_string(model, f"settings.models[{index}]", nonempty=True)
        if model in seen:
            _fail(f"settings.models[{index}]", f"duplicate model key {model!r}")
        seen.add(model)
    aggregation = source.get("aggregation")
    if aggregation != AGGREGATION_POLICY:
        _fail("settings.aggregation", f"unsupported policy {aggregation!r}")
    if "temperature" in source and (not _is_number(source["temperature"]) or source["temperature"] <= 0):
        _fail("settings.temperature", "expected a finite number greater than zero")
    if "prompt_formats" in source:
        formats = _required_dict(source["prompt_formats"], "settings.prompt_formats")
        for model, version in formats.items():
            _required_string(model, "settings.prompt_formats key", nonempty=True)
            if not isinstance(version, int) or isinstance(version, bool):
                _fail(f"settings.prompt_formats.{model}", "expected an integer")
    if "inference" in source:
        _required_dict(source["inference"], "settings.inference")
    return result


def normalize_pack(pack: Any, *, require_decision: bool = False) -> dict:
    """Deep-copy and validate a pack, adding only engine defaults, never IDs."""
    source = _required_dict(pack, "pack")
    _check_json(source, "pack")
    unknown = set(source) - _TOP_LEVEL
    if unknown:
        _fail("pack", f"unknown top-level fields: {', '.join(sorted(unknown))}")
    if source.get("version") != PACK_VERSION or isinstance(source.get("version"), bool):
        _fail("version", f"expected {PACK_VERSION}")
    if source.get("fingerprint_version") != FINGERPRINT_VERSION or isinstance(source.get("fingerprint_version"), bool):
        _fail("fingerprint_version", f"expected {FINGERPRINT_VERSION}")
    result = copy.deepcopy(source)
    for key in ("name", "description"):
        if key in source:
            _required_string(source[key], key)
    for key in ("hash", "fingerprint"):
        if key in source and (not isinstance(source[key], str) or not _HASH_RE.fullmatch(source[key])):
            _fail(key, "expected 'sha256:' followed by 64 lowercase hex characters")
    questions = _required_list(source.get("questions"), "questions")
    result["questions"] = [_normalize_question(question, index) for index, question in enumerate(questions)]
    question_ids = set()
    for index, question in enumerate(result["questions"]):
        qid = question["id"]
        if qid in question_ids:
            _fail(f"questions[{index}].id", f"duplicate question id {qid!r}")
        question_ids.add(qid)
    result["decision"] = _normalize_decision(source.get("decision"), result["questions"])
    result["settings"] = _normalize_settings(source.get("settings"))
    if require_decision and not result["decision"]["enabled"]:
        _fail("decision.enabled", "decision pipeline requires enabled:true")
    return result


def validate_pack(pack: Any, *, require_decision: bool = False, check_hashes: bool = False) -> dict:
    """Validate structure and, on request, both recorded integrity values."""
    normalized = normalize_pack(pack, require_decision=require_decision)
    if check_hashes:
        for field, actual in (("hash", config_hash(pack)), ("fingerprint", config_fingerprint(pack))):
            recorded = normalized.get(field)
            if recorded is None:
                _fail(field, "missing integrity value")
            if not hmac.compare_digest(recorded, actual):
                _fail(field, f"integrity mismatch: expected {actual}")
    return normalized


def full_projection(pack: Any) -> dict:
    """Validate and return the exact full pack minus both integrity fields."""
    source = _required_dict(pack, "pack")
    normalize_pack(source)
    projection = copy.deepcopy(source)
    projection.pop("hash", None)
    projection.pop("fingerprint", None)
    return projection


def _semantic_condition(condition: dict) -> dict:
    result = {"question": condition["question"], "op": condition["op"]}
    if condition.get("answer") is not None:
        result["answer"] = condition["answer"]
        result["threshold"] = condition["threshold"]
    else:
        result["score"] = condition["score"]
    return result


def semantic_projection(pack: Any) -> dict:
    """Return the explicit execution-affecting projection for fingerprint v1."""
    normalized = normalize_pack(pack)
    questions = []
    for question in normalized["questions"]:
        projected = {
            "id": question["id"],
            "type": question["type"],
            "question": question["question"],
        }
        if question["type"] == "yes_no":
            projected["yes"] = question.get("yes")
            projected["no"] = question.get("no")
        elif question["type"] == "choice":
            projected["options"] = [
                {"name": option["name"], "description": option.get("description")}
                for option in question["options"]
            ]
        else:
            projected["levels"] = copy.deepcopy(question["levels"])
        questions.append(projected)
    outcomes = []
    for outcome in normalized["decision"]["outcomes"]:
        outcomes.append({
            "id": outcome["id"],
            "isDefault": outcome["isDefault"],
            "rules": [
                {
                    "anyOf": rule["anyOf"],
                    "conditions": [_semantic_condition(condition) for condition in rule["conditions"]],
                }
                for rule in outcome["rules"]
            ],
        })
    settings = copy.deepcopy(normalized["settings"])
    settings["models"] = sorted(
        settings["models"], key=lambda value: value.encode("utf-16-be", "surrogatepass"))
    return {
        "fingerprint_version": FINGERPRINT_VERSION,
        "questions": questions,
        "decision": {"enabled": normalized["decision"]["enabled"], "outcomes": outcomes},
        "settings": settings,
    }


def canonical_bytes(value: Any) -> bytes:
    """Serialize with the vetted RFC 8785 implementation, never json.dumps."""
    try:
        return rfc8785.dumps(value)
    except (rfc8785.CanonicalizationError, TypeError, ValueError) as exc:
        raise ConfigPackError(f"JCS canonicalization failed: {exc}") from exc


def _digest(projection: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_bytes(projection)).hexdigest()


def config_hash(pack: Any) -> str:
    """SHA-256 over JCS of the full pack without ``hash``/``fingerprint``."""
    return _digest(full_projection(pack))


def config_fingerprint(pack: Any) -> str:
    """SHA-256 over JCS of the explicit semantic projection."""
    return _digest(semantic_projection(pack))


def finalize_pack(pack: Any, *, require_decision: bool = False) -> dict:
    """Return a normalized pack with freshly computed hash and fingerprint."""
    normalized = normalize_pack(pack, require_decision=require_decision)
    normalized.pop("hash", None)
    normalized.pop("fingerprint", None)
    normalized["hash"] = config_hash(normalized)
    normalized["fingerprint"] = config_fingerprint(normalized)
    return normalized


def effective_pack(pack: Any, *, models: list[str] | None = None, mode: str | None = None) -> dict:
    """Return an overridden effective copy; the original pack is never mutated."""
    effective = normalize_pack(pack)
    effective.pop("hash", None)
    effective.pop("fingerprint", None)
    if models is not None:
        effective["settings"]["models"] = copy.deepcopy(models)
    if mode is not None:
        effective["settings"]["mode"] = mode
    return finalize_pack(effective)



def _unique_object(pairs: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ConfigPackError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _invalid_constant(value: str) -> None:
    raise ConfigPackError(f"non-finite JSON number {value} is not allowed")


def loads_pack(text: str | bytes, *, require_decision: bool = False, check_hashes: bool = False) -> dict:
    """Load strict JSON, rejecting duplicate keys and NaN/Infinity before use."""
    if isinstance(text, bytes):
        text = text.decode("utf-8-sig")
    try:
        raw = json.loads(text, object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
    except ConfigPackError:
        raise
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ConfigPackError(f"invalid config-pack JSON: {exc}") from exc
    return validate_pack(raw, require_decision=require_decision, check_hashes=check_hashes)


def load_pack(source: str | os.PathLike | IO[str] | IO[bytes], *, require_decision: bool = False,
              check_hashes: bool = False) -> dict:
    """Load a pack from a filesystem path or an open text/binary stream."""
    if hasattr(source, "read"):
        return loads_pack(source.read(), require_decision=require_decision, check_hashes=check_hashes)
    with open(source, "rb") as stream:
        return loads_pack(stream.read(), require_decision=require_decision, check_hashes=check_hashes)
