import copy
import json
from pathlib import Path

import pytest

from dqa_common import AGGREGATION_POLICY
from dqa_common.config_pack import (
    ConfigPackError,
    canonical_bytes,
    config_fingerprint,
    config_hash,
    effective_pack,
    finalize_pack,
    full_projection,
    load_pack,
    loads_pack,
    normalize_pack,
    semantic_projection,
    validate_pack,
)
from dqa_common.materials import (
    composite_content_sha256,
    material_hash,
    materials_fingerprint,
    raw_content_sha256,
    run_fingerprint,
)

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "config_pack_parity.json").read_text(encoding="utf-8"))


def empty_pack():
    return {
        "version": 1,
        "fingerprint_version": 1,
        "questions": [],
        "decision": {"enabled": True, "outcomes": []},
        "settings": {"mode": "decisions", "models": [], "aggregation": AGGREGATION_POLICY},
    }


@pytest.mark.parametrize("case", FIXTURE["jcsCases"], ids=lambda case: case["name"])
def test_jcs_official_and_local_vectors(case):
    assert canonical_bytes(case["input"]).decode("utf-8") == case["expected"]


@pytest.mark.parametrize("name", FIXTURE["packs"], ids=FIXTURE["packs"].keys())
def test_pack_hash_and_semantic_fingerprint_golden(name):
    case = FIXTURE["packs"][name]
    assert full_projection(case["pack"]) == case["pack"]
    assert config_hash(case["pack"]) == case["hash"]
    assert config_fingerprint(case["pack"]) == case["fingerprint"]
    if "semantic" in case:
        assert semantic_projection(case["pack"]) == case["semantic"]


def test_projection_and_effective_override_contract():
    base = FIXTURE["packs"]["base"]["pack"]
    original = copy.deepcopy(base)
    assert full_projection(base) == base
    assert semantic_projection(base) == FIXTURE["semanticProjection"]
    override = FIXTURE["overrides"]
    effective = effective_pack(base, models=override["models"], mode=override["mode"])
    assert effective["hash"] == override["hash"]
    assert effective["fingerprint"] == override["fingerprint"]
    assert effective["settings"]["models"] == override["models"]
    assert effective["settings"]["mode"] == override["mode"]
    assert base == original


@pytest.mark.parametrize("case", FIXTURE["materials"]["cases"], ids=lambda case: case["name"])
def test_material_content_and_composite_hash_golden(case):
    assert raw_content_sha256(case["content"]) == case["raw"]
    assert composite_content_sha256(case["content"], case["images"]) == case["composite"]
    assert material_hash(case["content"], case["images"], case["metadata"]) == case["hash"]
    if "reversedImagesHash" in case:
        assert material_hash(case["content"], reversed(case["images"]), case["metadata"]) == case["reversedImagesHash"]


def test_ordered_materials_and_run_fingerprint_golden():
    materials = FIXTURE["materials"]
    actual = materials_fingerprint(materials["orderedHashes"])
    assert actual == materials["materialsFingerprint"]
    assert materials_fingerprint(reversed(materials["orderedHashes"])) != actual
    assert run_fingerprint(FIXTURE["packs"]["base"]["fingerprint"], actual) == materials["runFingerprint"]


@pytest.mark.parametrize("text", [
    '{"version":1,"version":1}',
    '{"questions":[{"id":"q","id":"other"}]}',
    '{"value":NaN}',
    '{"value":Infinity}',
    '{"value":-Infinity}',
], ids=["duplicate-top", "duplicate-nested", "nan", "infinity", "negative-infinity"])
def test_strict_json_loader_rejects_duplicates_and_nonfinite(text):
    with pytest.raises(ConfigPackError):
        loads_pack(text)


def test_load_pack_from_path_and_verify_hashes(tmp_path):
    finalized = finalize_pack(empty_pack())
    path = tmp_path / "pack.json"
    path.write_text(json.dumps(finalized), encoding="utf-8")
    assert load_pack(path, check_hashes=True) == finalized
    omitted = copy.deepcopy(FIXTURE["packs"]["defaultsOmitted"]["pack"])
    omitted["hash"] = config_hash(omitted)
    omitted["fingerprint"] = config_fingerprint(omitted)
    assert validate_pack(omitted, check_hashes=True)["hash"] == omitted["hash"]
    tampered = {**finalized, "name": "cosmetic"}
    with pytest.raises(ConfigPackError, match="hash: integrity mismatch"):
        validate_pack(tampered, check_hashes=True)
    semantic_tamper = copy.deepcopy(finalized)
    semantic_tamper["questions"] = []
    semantic_tamper["decision"]["outcomes"] = [{
        "id": "o", "label": "O", "rules": [{"conditions": []}],
    }]
    semantic_tamper["hash"] = config_hash(semantic_tamper)
    with pytest.raises(ConfigPackError, match="fingerprint: integrity mismatch"):
        validate_pack(semantic_tamper, check_hashes=True)


def test_legal_empty_web_pack_and_require_decision_option():
    pack = empty_pack()
    pack["decision"]["enabled"] = False
    pack["decision"]["outcomes"] = [{
        "id": "empty", "label": "Empty", "rules": [{"conditions": []}],
    }]
    assert normalize_pack(pack)["decision"]["enabled"] is False
    with pytest.raises(ConfigPackError, match="decision.enabled"):
        normalize_pack(pack, require_decision=True)


def test_ids_are_required_unique_and_never_regenerated():
    missing_question = empty_pack()
    missing_question["questions"] = [{"type": "yes_no", "question": "Q"}]
    with pytest.raises(ConfigPackError, match=r"questions\[0\].id"):
        normalize_pack(missing_question)

    duplicate_questions = empty_pack()
    duplicate_questions["questions"] = [
        {"id": "same", "type": "yes_no"},
        {"id": "same", "type": "yes_no"},
    ]
    with pytest.raises(ConfigPackError, match="duplicate question id"):
        normalize_pack(duplicate_questions)

    missing_outcome = empty_pack()
    missing_outcome["decision"]["outcomes"] = [{"label": "O", "rules": []}]
    with pytest.raises(ConfigPackError, match=r"decision.outcomes\[0\].id"):
        normalize_pack(missing_outcome)

    duplicate_outcomes = empty_pack()
    duplicate_outcomes["decision"]["outcomes"] = [
        {"id": "same", "label": "One", "rules": []},
        {"id": "same", "label": "Two", "rules": []},
    ]
    with pytest.raises(ConfigPackError, match="duplicate outcome id"):
        normalize_pack(duplicate_outcomes)


def pack_with_rule():
    pack = empty_pack()
    pack["questions"] = [{"id": "q", "type": "yes_no", "question": "Q"}]
    pack["decision"]["outcomes"] = [{
        "id": "o", "label": "O",
        "rules": [{"conditions": [{"question": "q", "answer": "yes", "op": "gte", "threshold": 0.5}]}],
    }]
    return pack


@pytest.mark.parametrize("path,mutate,match", [
    ("threshold", lambda pack: pack["decision"]["outcomes"][0]["rules"][0]["conditions"][0].update(threshold=1.1), "threshold"),
    ("reference", lambda pack: pack["decision"]["outcomes"][0]["rules"][0]["conditions"][0].update(question="ghost"), "unknown question"),
    ("answer", lambda pack: pack["decision"]["outcomes"][0]["rules"][0]["conditions"][0].update(answer="maybe"), "has no answer"),
    ("defaults", lambda pack: pack["decision"]["outcomes"].append({"id": "o2", "label": "O2", "isDefault": True, "rules": []}) or pack["decision"]["outcomes"][0].update(isDefault=True), "at most one default"),
    ("mode", lambda pack: pack["settings"].update(mode="invalid"), "settings.mode"),
    ("temperature", lambda pack: pack["settings"].update(temperature=0), "settings.temperature"),
], ids=lambda value: value if isinstance(value, str) else None)
def test_structure_references_and_ranges(path, mutate, match):
    pack = pack_with_rule()
    mutate(pack)
    with pytest.raises(ConfigPackError, match=match):
        normalize_pack(pack)


def test_question_structure_matches_current_schema_limits():
    pack = empty_pack()
    pack["questions"] = [{"id": "c", "type": "choice", "options": [{"name": "A"}, {"name": "a"}]}]
    with pytest.raises(ConfigPackError, match="duplicate option"):
        normalize_pack(pack)
    pack["questions"] = [{"id": "s", "type": "score", "levels": ["only"]}]
    with pytest.raises(ConfigPackError, match="2..10"):
        normalize_pack(pack)
    pack["questions"] = [{"id": "q", "type": "yes_no", "direction": "up"}]
    with pytest.raises(ConfigPackError, match="direction"):
        normalize_pack(pack)
