"""Replay-регрессионные сценарии ассистента (scripts/assistant_eval.py).

Каждый сценарий docs/evals/scenarios/*.json — отдельный тест: детерминированный
replay записанных ответов модели через фейк-транспорт, грейдеры по исходу
(события/псевдо-журнал). Офлайн, сети нет. Новый инцидент пользователя =
новый сценарий-файл, тест появится сам.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "assistant_eval", ROOT / "scripts" / "assistant_eval.py")
assistant_eval = importlib.util.module_from_spec(_spec)
sys.modules["assistant_eval"] = assistant_eval
_spec.loader.exec_module(assistant_eval)

SCENARIO_NAMES = [s["name"] for s in assistant_eval.load_scenarios()]

# docs/evals/ — локальный (gitignored) каталог: на свежем клоне сценариев
# нет, регрессия исполняется на машине разработчика (см. AGENTS.md).
pytestmark = pytest.mark.skipif(
    not SCENARIO_NAMES, reason="docs/evals/scenarios отсутствует (локальный "
                             "каталог, в репозиторий не входит)")


@pytest.mark.parametrize("name", SCENARIO_NAMES)
def test_replay_scenario(name):
    rep = assistant_eval.run_scenario(assistant_eval.load_scenario(name))
    assert rep.ok, "\n".join(rep.failures)


def test_dismantle_phantom_guard():
    """Демонтажный прогон: с выключенным phantom_guard сценарии, требующие
    его, обязаны падать — иначе грейдер не измеряет стража."""
    guarded = [s for s in assistant_eval.load_scenarios()
               if any("phantom_guard" in (t.get("graders") or {})
                      .get("required_tools", [])
                      for t in s.get("turns") or [])]
    assert guarded, "в сьютe нет сценариев, требующих phantom_guard"
    for scn in guarded:
        rep = assistant_eval.run_scenario(scn, guards_off=["phantom"])
        assert not rep.ok, f"{scn['name']} прошёл без phantom_guard"
