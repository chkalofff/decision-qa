"""SQLite-персистентность и owner/session-изоляция квитанций ассистента."""

from __future__ import annotations

from backend.assistant.receipts import ReceiptStore


def test_sqlite_restart_drain_once_idempotency_and_owner_isolation(tmp_path):
    path = tmp_path / "receipts.sqlite3"
    store = ReceiptStore(path=path)
    first = {"event_id": "p1:applied", "kind": "propose_questions",
             "outcome": "applied", "title": "Один"}
    assert store.put("same-session", first, owner="alice")
    assert store.put("same-session", {"event_id": "p2:declined", "outcome": "declined"},
                     owner="bob")
    assert not store.put("same-session", first, owner="alice")
    assert store.drain("same-session", owner="alice") == [first]
    assert store.drain("same-session", owner="alice") == []
    store.close()

    restarted = ReceiptStore(path=path)
    assert not restarted.put("same-session", first, owner="alice"), \
        "seen event_id переживает drain и restart"
    assert restarted.drain("same-session", owner="alice") == []
    assert restarted.drain("same-session", owner="bob") == [
        {"event_id": "p2:declined", "outcome": "declined"}]
    restarted.put("same-session", {"event_id": "later", "outcome": "undone"}, owner="alice")
    restarted.close()

    again = ReceiptStore(path=path)
    assert again.drain("same-session", owner="alice") == [
        {"event_id": "later", "outcome": "undone"}]
    assert again.drain("missing", owner="alice") == []
    again.close()


def test_sqlite_concurrent_connections_do_not_lose_or_duplicate_receipts(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    path = tmp_path / "receipts.sqlite3"
    first = ReceiptStore(path=path)
    second = ReceiptStore(path=path)
    for index in range(20):
        first.put("shared", {"event_id": f"a{index}", "payload": index}, owner="alice")
        second.put("shared", {"event_id": f"b{index}", "payload": index}, owner="alice")
        with ThreadPoolExecutor(max_workers=2) as pool:
            drains = list(pool.map(lambda store: store.drain("shared", owner="alice"), [first, second]))
        flattened = [item["event_id"] for batch in drains for item in batch]
        assert sorted(flattened) == sorted([f"a{index}", f"b{index}"]), \
            "каждая запись доставляется ровно один раз даже при гонке двух подключений"
    first.close()
    second.close()


def test_sqlite_wall_clock_ttl_caps_and_lru(tmp_path):
    clock = [10_000.0]
    store = ReceiptStore(path=tmp_path / "receipts.sqlite3", clock=lambda: clock[0],
                         ttl_s=60, cap_per_session=3, max_sessions=2)
    for i in range(5):
        store.put("a", {"event_id": f"e{i}", "n": i}, owner="alice")
    assert [r["n"] for r in store.drain("a", owner="alice")] == [2, 3, 4]
    store.put("a", {"event_id": "old", "n": 0}, owner="alice")
    clock[0] += 61
    store.put("a", {"event_id": "new", "n": 1}, owner="alice")
    assert [r["n"] for r in store.drain("a", owner="alice")] == [1]
    # Повтор старого id после TTL снова допустим, seen тоже ограничен TTL.
    assert store.put("a", {"event_id": "old", "n": 2}, owner="alice")

    store.put("s1", {"n": 1}, owner="alice")
    store.put("s2", {"n": 2}, owner="alice")
    store.drain("s1", owner="alice")
    store.put("s3", {"n": 3}, owner="alice")
    assert store.drain("s2", owner="alice") == []
    assert store.drain("s3", owner="alice") == [{"n": 3}]
    store.close()
