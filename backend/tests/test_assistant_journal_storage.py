"""Owner-scoped журнал ассистента и безопасная legacy-миграция только в local."""

from __future__ import annotations

import json

from backend.assistant import journal


def test_journal_owner_isolation_and_local_legacy_migration(monkeypatch, tmp_path):
    legacy = tmp_path / "logs" / "assistant.jsonl"
    legacy.parent.mkdir()
    legacy.write_text('{"type":"chat","legacy":true}\n', encoding="utf-8")
    users = tmp_path / "users"
    monkeypatch.setattr(journal, "JOURNAL_PATH", legacy)
    monkeypatch.setattr(journal, "LEGACY_JOURNAL_PATH", legacy)
    monkeypatch.setattr(journal, "STATE_USERS_DIR", users)

    journal.append_record({"type": "event", "owner_test": "remote"}, owner="alice")
    assert legacy.exists(), "remote не запускает и не забирает legacy-миграцию"
    assert not (users / "local").exists()
    assert json.loads((users / "alice" / "assistant.jsonl").read_text())[
        "owner_test"] == "remote"

    journal.append_record({"type": "event", "owner_test": "local"})
    local_path = users / "local" / "assistant.jsonl"
    records = [json.loads(line) for line in local_path.read_text().splitlines()]
    assert records[0]["legacy"] is True and records[-1]["owner_test"] == "local"
    assert not legacy.exists()
    backups = list(legacy.parent.glob("assistant.jsonl.pre-owner-migration*.bak"))
    assert len(backups) == 1
    assert json.loads(backups[0].read_text())["legacy"] is True


def test_journal_path_monkeypatch_keeps_legacy_direct_calls(monkeypatch, tmp_path):
    redirected = tmp_path / "redirected.jsonl"
    monkeypatch.setattr(journal, "JOURNAL_PATH", redirected)
    journal.append_record({"type": "event"})
    assert json.loads(redirected.read_text())["type"] == "event"
