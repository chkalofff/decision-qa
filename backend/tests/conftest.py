"""Общие фикстуры backend-тестов."""
from __future__ import annotations

import pytest

from backend.assistant import journal


@pytest.fixture(autouse=True)
def _journal_redirect(monkeypatch, tmp_path):
    """Журнал диалогов ассистента — в tmp, а не в реальный
    server/logs/assistant.jsonl (защита от побочки любых тестов,
    которые ходят в /api/assistant/*)."""
    monkeypatch.setattr(journal, "JOURNAL_PATH", tmp_path / "assistant.jsonl")
