import json
from pathlib import Path

import pytest

from dqa_common.aggregation import aggregate_mean_probability_v1

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "config_pack_parity.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", FIXTURE["aggregationCases"], ids=lambda case: case["name"])
def test_mean_probability_v1_golden(case):
    result = aggregate_mean_probability_v1(case["config"], case["runs"])
    for key in ("policy", "answers", "decision", "errors", "usage", "metrics"):
        assert result[key] == case["expected"][key]
    assert result["runs"] == case["runs"]
    assert result["runs"] is not case["runs"]
    for model, expected_outcome in case["expected"]["modelOutcomes"].items():
        ordinary = [run for run in case["runs"] if run["model"] == model]
        assert result["by_model"][model]["runs"] == ordinary
        decision = result["by_model"][model]["decision"]
        assert (decision or {}).get("outcomeId") == expected_outcome


def test_all_ordinary_failures_do_not_fabricate_default_decision():
    case = FIXTURE["aggregationCases"][0]
    runs = [
        {"model": "m1", "mode": "decisions", "ok": False, "error": "down", "answers": {}},
        {
            "model": "m1", "mode": "fast_batch", "ok": True,
            "answers": case["runs"][0]["answers"], "usage": {"prompt_tokens": 7},
        },
    ]
    result = aggregate_mean_probability_v1(case["config"], runs)
    assert result["answers"] == {}
    assert result["decision"] is None
    assert result["trace"] == []
    assert result["errors"] == [{"model": "m1", "mode": "decisions", "error": "down"}]
    assert result["usage"] == {"prompt_tokens": 7}
    assert len(result["runs"]) == 2


def test_wall_duration_stays_in_raw_run_metrics_not_aggregate_usage():
    case = FIXTURE["aggregationCases"][0]
    result = aggregate_mean_probability_v1(case["config"], case["runs"])
    assert "duration_s" not in result["usage"]
    assert result["by_model"]["m1"]["runs"][0]["metrics"]["duration_s"] == 9
    assert result["by_model"]["m1"]["runs"][1]["metrics"]["duration_s"] == 1


def test_fast_only_aggregates_each_sole_available_pass_once():
    case = FIXTURE["aggregationCases"][0]
    config = {**case["config"], "settings": {"mode": "fast_batch"}}
    runs = [
        {
            "model": "native", "mode": "fast_batch", "ok": True,
            "answers": case["runs"][0]["answers"],
        },
        {
            "model": "systemone", "mode": "decisions", "ok": True,
            "answers": case["runs"][1]["answers"],
        },
    ]
    result = aggregate_mean_probability_v1(config, runs)
    assert result["answers"]["q_yes"]["probabilities"]["yes"] == pytest.approx(0.6)
    assert set(result["answers"]["q_yes"]["by_model"]) == {"native", "systemone"}
    assert result["decision"]["outcomeId"] == "o_accept"
    assert result["by_model"]["native"]["decision"]["outcomeId"] == "o_accept"
    assert result["by_model"]["systemone"]["decision"]["outcomeId"] == "o_review"
