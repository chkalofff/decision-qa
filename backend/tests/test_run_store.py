"""Temporary spool, event persistence, TTL and restart policy tests."""

from __future__ import annotations

import asyncio
import json
import os

import pytest

from backend.run_jobs import RunManager
from backend.run_schemas import RunAPIError, RunLimits
from backend.run_store import RunStore
from backend.tests.run_support import (
    FakeEngine, create_request, file_payload, pack, reset_fake, upload_all,
)


def make_job(store, owner="local", key="idem"):
    return store.create_job(
        owner=owner, idempotency_key=key, request_hash="sha256:" + "2" * 64,
        effective_config=pack(),
        material_count=1, expected_materials_fingerprint="sha256:" + "0" * 64,
        materials_fingerprint="sha256:" + "0" * 64, run_fingerprint="sha256:" + "3" * 64,
        threads_requested=None,
    )[0]


def test_restart_removes_orphans_without_resume(tmp_path):
    root = tmp_path / "runs"
    first = RunStore(root)
    job = make_job(first)
    directory = root / "local" / job.run_id
    (directory / "orphan.txt").write_text("raw", encoding="utf-8")
    second = RunStore(root)
    assert second.jobs == {}
    assert not directory.exists()
    with pytest.raises(RunAPIError) as error:
        second.get("local", job.run_id)
    assert error.value.status_code == 404


def test_ttl_deletes_results_events_and_idempotency_together(tmp_path):
    store = RunStore(tmp_path / "runs", RunLimits(job_ttl_s=10))
    job = make_job(store)
    store.append_event(job, {"type": "run_start"})
    store.record_file(job, {"type": "file", "i": 0, "status": "ok"})
    job.expires_monotonic = 0
    store.cleanup_expired()
    assert not (tmp_path / "runs" / "local" / job.run_id).exists()
    assert not store.jobs and not store.idempotency


def test_abandoned_upload_also_expires(tmp_path):
    store = RunStore(tmp_path / "runs", RunLimits(job_ttl_s=10))
    job = make_job(store)
    assert job.expires_monotonic is not None
    job.expires_monotonic = 0
    store.cleanup_expired()
    assert not store.jobs and not store.idempotency
    assert not (tmp_path / "runs" / "local" / job.run_id).exists()


def test_event_is_on_disk_before_subscriber_notification(tmp_path):
    store = RunStore(tmp_path / "runs")
    job = make_job(store)

    class CheckingQueue(asyncio.Queue):
        def put_nowait(self, item):
            path = tmp_path / "runs" / "local" / job.run_id / "events.jsonl"
            persisted = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
            assert persisted[-1]["seq"] == item["seq"]
            return super().put_nowait(item)

    queue = CheckingQueue()
    job.subscribers.add(queue)
    event = store.append_event(job, {"type": "run_start"})
    assert event["seq"] == 1
    assert queue.get_nowait()["seq"] == 1
    assert [item["seq"] for item in store.events_after(job, 0)] == [1]


def test_results_are_paged_and_client_path_is_only_metadata(tmp_path):
    reset_fake()
    store = RunStore(tmp_path / "runs")
    service = RunManager(store, engine_factory=FakeEngine)
    job, _ = service.create("local", create_request(3), "paging")
    upload_all(service, job, [file_payload(i, path="../../etc/passwd") for i in range(3)])
    for i in (2, 0, 1):
        store.record_file(job, {"type": "file", "i": i, "status": "ok"})
    page = store.read_results(job, 1, 1)
    assert [item["i"] for item in page["files"]] == [1]
    assert page["next_offset"] == 2
    assert store.load_material(job, 0)["path"] == "../../etc/passwd"
    assert not (tmp_path / "etc").exists()
    store.finish(job, "completed", duration_s=0)
    assert not (tmp_path / "runs" / "local" / job.run_id / "chunks").exists()
    assert len(list(store.events_after(job, 0))) == 3


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission contract")
def test_owner_directories_and_spool_files_are_private(tmp_path):
    reset_fake()
    store = RunStore(tmp_path / "runs")
    service = RunManager(store, engine_factory=FakeEngine)
    job, _ = service.create("local", create_request(1), "permissions")
    upload_all(service, job, [file_payload(0)])
    directory = tmp_path / "runs" / "local" / job.run_id
    assert directory.parent.stat().st_mode & 0o777 == 0o700
    assert directory.stat().st_mode & 0o777 == 0o700
    assert (directory / "chunks" / "00000000.json").stat().st_mode & 0o777 == 0o600
    store.append_event(job, {"type": "run_start"})
    assert (directory / "events.jsonl").stat().st_mode & 0o777 == 0o600
