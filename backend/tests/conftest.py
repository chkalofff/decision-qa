"""Общие фикстуры backend-тестов."""
from __future__ import annotations

import pytest

from backend.assistant import journal, receipts


@pytest.fixture(autouse=True)
def _journal_redirect(monkeypatch, tmp_path):
    """Журнал диалогов ассистента — в tmp, а не в реальный
    server/logs/assistant.jsonl (защита от побочки любых тестов,
    которые ходят в /api/assistant/*)."""
    monkeypatch.setattr(journal, "JOURNAL_PATH", tmp_path / "assistant.jsonl")


@pytest.fixture(autouse=True)
def _receipts_redirect(monkeypatch, tmp_path):
    """Production SQLite тоже только в tmp: тесты не трогают server/state."""
    store = receipts.ReceiptStore(path=tmp_path / "assistant-receipts.sqlite3")
    monkeypatch.setattr(receipts, "STORE", store)
    yield
    store.close()
