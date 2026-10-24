from __future__ import annotations

import json


def record(digest, path, name, outcome, *, yes=0.8, score=1.0, reused=False):
    return {
        "i": 0, "path": path, "name": name, "content_sha256": digest,
        "status": "skipped" if reused else "ok", "reason": "already_processed" if reused else None,
        "material": {"type": "text", "images": []},
        "decision": {"outcome": outcome, "label": outcome, "rule": "q1.yes>=0.5", "is_default": False},
        "answers": None if reused else {
            "q1": {"type": "yes_no", "answer": "yes", "confidence": yes,
                   "probabilities": {"yes": yes, "no": 1 - yes}, "by_model": {"alpha": {"yes": yes}}},
            "q2": {"type": "score", "score": score},
        },
        "by_model": {"alpha": {"decision": {"outcomeId": outcome}}},
        "trace": [{"outcomeId": outcome, "hit": True}], "errors": [],
    }


def write_json_report(path, files, *, status="completed"):
    total = len(files)
    root = {
        "schema": 1, "run_id": "run_test", "status": status,
        "config": {"effective_fingerprint": "sha256:fp"},
        "summary": {"files_total": total, "files_completed": total,
                    "files_pending": 0, "files_truncated": 0},
        "files": files,
    }
    path.write_text(json.dumps(root, ensure_ascii=False), encoding="utf-8")


def write_ndjson_report(path, files):
    events = [{"schema": 1, "type": "run_start", "run_id": "run_test", "files_total": len(files)},
              *({"type": "file", **record} for record in files),
              {"type": "run_end", "run_id": "run_test", "status": "completed",
               "summary": {"files_total": len(files), "files_completed": len(files), "files_pending": 0}}]
    path.write_text("".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events), encoding="utf-8")


def test_explain_json_ndjson_rename_and_ambiguous(dqa, tmp_path):
    first = tmp_path / "first.json"
    original = record("h1", "/old/a.txt", "same.txt", "ok")
    write_json_report(first, [original, record("h2", "/other/b.txt", "same.txt", "reject")])
    exact = dqa("explain", "/old/a.txt", "--report", str(first))
    assert exact.returncode == 0, exact.stderr.decode()
    explained = json.loads(exact.stdout)
    assert explained["type"] == "explain" and explained["complete"] is True
    assert explained["file"]["decision"]["rule"] == "q1.yes>=0.5"
    assert explained["file"]["answers"]["q1"]["by_model"]["alpha"]["yes"] == 0.8
    ambiguous = dqa("explain", "same.txt", "--report", str(first))
    assert ambiguous.returncode == 65

    second = tmp_path / "second.ndjson"
    write_ndjson_report(second, [record("h1", "/new/renamed.txt", "renamed.txt", "reject")])
    renamed = dqa("explain", "renamed.txt", "--report", str(second))
    assert renamed.returncode == 0 and json.loads(renamed.stdout)["matched_path"] == "/new/renamed.txt"
    missing = dqa("explain", "missing.txt", "--report", str(second))
    assert missing.returncode == 66


def test_diff_transitions_deltas_already_processed_and_partial(dqa, tmp_path):
    first = tmp_path / "first.json"
    second = tmp_path / "second.ndjson"
    write_json_report(first, [
        record("h1", "/old/a.txt", "a.txt", "ok", yes=0.7, score=1.0),
        record("h2", "/old/b.txt", "b.txt", "ok"),
    ])
    write_ndjson_report(second, [
        record("h1", "/new/a.txt", "a.txt", "reject", yes=0.9, score=1.6),
        record("h2", "/new/b.txt", "b.txt", "reject", reused=True),
    ])
    result = dqa("diff", str(first), str(second), "--format", "json")
    assert result.returncode == 0, result.stderr.decode()
    value = json.loads(result.stdout)
    assert value["schema"] == 1 and value["type"] == "diff"
    assert value["transitions"] == {"ok->reject": 2}
    assert value["summary"] == {"transitions": 2, "changed_files": 2, "answer_changes": 3}
    changed = {item["content_sha256"]: item for item in value["files"]}
    assert changed["h1"]["previous_path"] == "/old/a.txt" and changed["h1"]["path"] == "/new/a.txt"
    assert len(changed["h1"]["answer_deltas"]) == 3
    assert changed["h2"]["answer_deltas"] == []
    assert value["thresholds"] == {"probability": 0.1, "score": 0.5}

    partial = tmp_path / "partial.json"
    write_json_report(partial, [record("h1", "/new/a.txt", "a.txt", "reject")], status="completed_partial")
    rejected = dqa("diff", str(first), str(partial))
    assert rejected.returncode == 65
    explained = dqa("explain", "/new/a.txt", "--report", str(partial))
    assert explained.returncode == 0 and json.loads(explained.stdout)["complete"] is False


def test_ndjson_loader_is_incremental_and_rejects_forged_counts(tmp_path, monkeypatch):
    from pathlib import Path

    from dqa.analysis import load_report

    path = tmp_path / "events.ndjson"
    write_ndjson_report(path, [record("h1", "/a.txt", "a.txt", "ok")])
    monkeypatch.setattr(Path, "read_text", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("read_text forbidden")))
    loaded = load_report(str(path))
    assert loaded.complete and [item["content_sha256"] for item in loaded.iter_files()] == ["h1"]
    assert "config" not in loaded.metadata

    events = [json.loads(line) for line in path.open().readlines()]
    events[-1]["summary"]["files_completed"] = 2
    path.write_text("".join(json.dumps(event) + "\n" for event in events))
    assert not load_report(str(path)).complete

    start_only = tmp_path / "start-only.ndjson"
    start_only.write_text(json.dumps(events[0]) + "\n")
    loaded = load_report(str(start_only))
    assert loaded.format == "ndjson" and not loaded.complete
