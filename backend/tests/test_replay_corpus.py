"""Replay-корпус сессий ассистента (scripts/replay_corpus.py) — гейт A1 v1.2.

Каждая сессия docs/evals/corpus/*.json — отдельный тест: многоходовый replay
записанных ответов модели через фейк-транспорт, действия над карточками между
ходами (accept/decline/ignore с эмуляцией применения к снапшоту), грейдеры
хода + ассерты сессии. Классы: фантомы, validation-петли, stale-адресация,
деградация длинных сессий (включая 86-ходовую). Офлайн, сети нет.
Демонтажные тесты в конце: с выключенным стражем сессии, требующие его,
обязаны падать — иначе корпус не измеряет стража.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "replay_corpus", ROOT / "scripts" / "replay_corpus.py")
replay_corpus = importlib.util.module_from_spec(_spec)
sys.modules["replay_corpus"] = replay_corpus
_spec.loader.exec_module(replay_corpus)

SESSION_NAMES = [s["name"] for s in replay_corpus.load_corpus()]

# docs/evals/ — локальный (gitignored) каталог: на свежем клоне корпуса нет,
# гейт исполняется на машине разработчика (см. AGENTS.md).
pytestmark = pytest.mark.skipif(
    not SESSION_NAMES, reason="docs/evals/corpus отсутствует (локальный "
                              "каталог, в репозиторий не входит)")


@pytest.mark.parametrize("name", SESSION_NAMES)
def test_corpus_session(name):
    rep = replay_corpus.run_session(replay_corpus.load_session(name))
    assert rep.ok, "\n".join(rep.failures)


def _sessions_requiring(guard: str) -> list[dict]:
    return [s for s in replay_corpus.load_corpus()
            if any(guard in (t.get("graders") or {}).get("required_tools", [])
                   for t in s.get("turns") or [])]


def test_dismantle_phantom_guard():
    """С выключенным phantom_guard все сессии, требующие его, падают."""
    guarded = _sessions_requiring("phantom_guard")
    assert guarded, "в корпусе нет сессий, требующих phantom_guard"
    for scn in guarded:
        rep = replay_corpus.run_session(scn, guards_off=["phantom"])
        assert not rep.ok, f"{scn['name']} прошла без phantom_guard"


def test_dismantle_degrade_guard():
    """С выключенным degrade_guard все сессии, требующие его, падают."""
    guarded = _sessions_requiring("degrade_guard")
    assert guarded, "в корпусе нет сессий, требующих degrade_guard"
    for scn in guarded:
        rep = replay_corpus.run_session(scn, guards_off=["degrade"])
        assert not rep.ok, f"{scn['name']} прошла без degrade_guard"


def test_corpus_class_coverage():
    """Каждый класс дефектов покрыт минимум тремя сессиями; класс long
    включает сессию на 80+ ходов."""
    by_class: dict[str, list[dict]] = {}
    for scn in replay_corpus.load_corpus():
        by_class.setdefault(scn.get("class", "?"), []).append(scn)
    for cls in ("phantom", "validation", "stale", "long"):
        assert len(by_class.get(cls, [])) >= 3, \
            f"класс {cls!r}: сессий {len(by_class.get(cls, []))} < 3"
    assert any(len(s.get("turns") or []) >= 80 for s in by_class["long"]), \
        "в классе long нет сессии на 80+ ходов"
