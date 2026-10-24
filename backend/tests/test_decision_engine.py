import json
from pathlib import Path

import pytest

from dqa_common.decision import evaluate_decision, explain_decision

FIXTURE = Path(__file__).parent / "fixtures" / "decision_parity.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_decision_js_python_golden_parity(case):
    actual = evaluate_decision(case["decision"], case["answers"])
    assert actual == case["expected"]
    explanation = explain_decision(case["decision"], case["answers"])
    assert explanation == {"res": case["expected"], "trace": case["expectedTrace"]}
    if actual is not None:
        assert actual["trace"] == case["expectedTrace"]


def test_explain_rejects_none_answers_without_trace():
    assert evaluate_decision({"outcomes": []}, None) is None
    assert explain_decision({"outcomes": []}, None) == {"res": None, "trace": []}
