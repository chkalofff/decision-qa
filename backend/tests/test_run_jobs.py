"""Concurrency, cancellation and deadline contracts for the run manager."""

from __future__ import annotations

import asyncio

import pytest

from backend.run_jobs import RunManager
from backend.run_schemas import RunAPIError, RunLimits
from backend.run_store import RunStore
from backend.tests.run_support import (
    FakeEngine, create_request, file_payload, reset_fake, upload_all, wait_terminal,
)


def manager(tmp_path, **changes):
    limits = RunLimits(**changes)
    reset_fake()
    return RunManager(RunStore(tmp_path / "runs", limits), engine_factory=FakeEngine)


def new_job(service, count, *, owner="local", threads=None, prefix="a"):
    job, _ = service.create(owner, create_request(count, threads=threads), f"key-{owner}-{prefix}-{count}")
    upload_all(service, job, [file_payload(i, f"{prefix}{i}") for i in range(count)])
    return job


@pytest.mark.asyncio
async def test_global_inflight_bound_fair_fifo_and_per_job_cap(tmp_path):
    service = manager(tmp_path, max_threads=8, default_threads=8,
                      max_inflight_materials=2, max_concurrent_jobs=4)
    controller = FakeEngine.controller
    controller.release.clear()
    first = new_job(service, 4, threads=8, prefix="a")
    second = new_job(service, 4, owner="other", threads=8, prefix="b")
    await service.start(first)
    await service.start(second)
    await asyncio.sleep(0.02)
    assert first.threads_effective == 2
    assert second.threads_effective == 2
    assert controller.max_active == 2
    controller.release.set()
    await wait_terminal(service, first)
    await wait_terminal(service, second)
    assert first.status == second.status == "completed"
    assert controller.max_active == 2
    assert controller.calls[:6] == ["a0", "a1", "b0", "b1", "a2", "a3"]
    await service.close()


@pytest.mark.asyncio
async def test_max_jobs_and_idempotent_start_single_preflight(tmp_path):
    service = manager(tmp_path, max_concurrent_jobs=1)
    controller = FakeEngine.controller
    controller.release.clear()
    first = new_job(service, 1)
    await asyncio.gather(service.start(first), service.start(first))
    assert controller.preflight_calls == 1
    second = new_job(service, 1, prefix="b")
    with pytest.raises(RunAPIError) as error:
        await service.start(second)
    assert error.value.status_code == 429
    assert error.value.headers["Retry-After"] == "1"
    controller.release.set()
    await wait_terminal(service, first)
    await service.start(first)
    assert controller.calls == ["a0"]
    assert controller.preflight_calls == 1
    await service.close()


@pytest.mark.asyncio
async def test_cancel_active_work_retains_partial_and_releases_capacity(tmp_path):
    service = manager(tmp_path, max_inflight_materials=2)
    controller = FakeEngine.controller
    gate = asyncio.Event()

    async def hook(engine, material):
        if material["input"] != "a0":
            await gate.wait()

    controller.hook = hook
    job = new_job(service, 3)
    await service.start(job)
    async with asyncio.timeout(1):
        while not job.result_indices:
            await asyncio.sleep(0.005)
    await service.cancel(job)
    await service.cancel(job)
    assert job.status == "completed_partial"
    assert job.summary()["files_completed"] == 1
    assert service.scheduler.active == 0
    assert not (service.store.root / "local" / job.run_id / "chunks").exists()
    assert service.store.read_results(job, 0, 10)["files"][0]["status"] == "ok"
    assert [event["type"] for event in service.store.events_after(job, 0)][-2:] == [
        "run_cancelled", "run_end",
    ]
    await service.close()


@pytest.mark.asyncio
async def test_deadline_is_honest_failure_and_cancels_active_call(tmp_path):
    service = manager(tmp_path, job_deadline_s=0.05)
    controller = FakeEngine.controller
    controller.release.clear()
    job = new_job(service, 1)
    await service.start(job)
    await wait_terminal(service, job)
    assert job.status == "failed"
    assert "deadline" in job.error
    assert job.summary()["files_pending"] == 1
    assert controller.active == 0
    assert service.store.events_after(job, 0)
    assert list(service.store.events_after(job, 0))[-1]["status"] == "failed"
    await service.close()


@pytest.mark.asyncio
async def test_per_model_failure_does_not_make_job_partial(tmp_path):
    service = manager(tmp_path)
    original = FakeEngine.run_material

    async def partial(self, material):
        result = await original(self, material)
        self.execution_metadata["prompt_formats"] = {"fake": 7}
        result["runs"].append({
            "model": "other", "mode": "decisions", "ok": False,
            "answers": {}, "error": "controlled",
        })
        return result

    FakeEngine.run_material = partial
    try:
        job = new_job(service, 1)
        await service.start(job)
        await wait_terminal(service, job)
    finally:
        FakeEngine.run_material = original
    assert job.status == "completed"
    result = service.store.read_results(job, 0, 10)["files"][0]
    assert result["status"] == "ok"
    assert result["errors"][-1]["error"] == "controlled"
    assert job.effective_config["settings"]["prompt_formats"] == {"fake": 7}
    assert job.execution["prompt_formats"] == {"fake": 7}
    await service.close()
