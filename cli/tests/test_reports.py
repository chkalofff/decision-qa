from __future__ import annotations

import csv
import io
import json
from types import SimpleNamespace

from dqa.pack import load
from dqa.reports import NDJSONWriter, ReportArtifact, report_kind, write_csv, write_table
from test_run import cli_args, records, run_server, write_rule_pack


def test_json_ndjson_filter_output_and_full_report(dqa, pack_file, run_server, tmp_path):
    materials = []
    for name in ("a.txt", "b.txt"):
        path = tmp_path / name
        path.write_text(name)
        materials.append(str(path))
    output = tmp_path / "selected.json"
    audit = tmp_path / "audit.json"
    result = dqa(*cli_args(pack_file, run_server, *materials, "--outcome-filter", "reject",
                           "--output", str(output), "--report", str(audit), "--quiet"))
    assert result.returncode == 0 and not result.stdout
    selected = json.loads(output.read_text())
    assert selected["files"] == []
    assert selected["summary"] == {
        "files_total": 2, "files_returned": 0, "files_completed": 2,
        "files_ok": 0, "files_failed": 0, "files_skipped": 0,
        "files_pending": 0, "files_filtered_out": 2, "files_truncated": 0,
        "decisions": {},
    }
    assert len(json.loads(audit.read_text())["files"]) == 2

    streamed = dqa(*cli_args(pack_file, run_server, *materials, "--outcome-filter", "reject",
                             "--format", "ndjson", "--quiet"))
    events = [json.loads(line) for line in streamed.stdout.decode().splitlines()]
    assert [event["type"] for event in events] == ["run_start", "run_end"]
    assert events[-1]["summary"]["files_total"] == 2
    assert events[-1]["summary"]["files_returned"] == 0
    assert events[-1]["summary"]["files_filtered_out"] == 2
    calls = len(records(run_server["calls"]))
    invalid = dqa(*cli_args(pack_file, run_server, *materials, "--outcome-filter", "missing"))
    assert invalid.returncode == 64 and len(records(run_server["calls"])) == calls
    alias = dqa(*cli_args(pack_file, run_server, *materials, "--output", str(output),
                          "--report", str(tmp_path / "missing-dir" / ".." / output.name)))
    assert alias.returncode == 64 and len(records(run_server["calls"])) == calls


def test_csv_bom_columns_confidence_and_table_rejection(dqa, pack_file, run_server, tmp_path):
    pack = write_rule_pack(pack_file, tmp_path)
    material = tmp_path / "a.txt"
    material.write_text("a")
    result = dqa(*cli_args(pack, run_server, str(material), "--format", "csv", "--quiet"))
    assert result.returncode == 0, result.stderr.decode()
    assert result.stdout.startswith(b"\xef\xbb\xbf")
    rows = list(csv.DictReader(io.StringIO(result.stdout.decode("utf-8-sig"))))
    assert list(rows[0]) == ["path", "status", "outcome", "label", "confidence", "q1", "errors"]
    assert rows[0]["outcome"] == "reject" and rows[0]["confidence"] == "90.0%"
    assert rows[0]["q1"] == "yes (90.0%)" and "by_model" not in rows[0]
    table = dqa(*cli_args(pack, run_server, str(material), "--format", "table"))
    assert table.returncode == 64 and not table.stdout


def test_table_fallback_and_large_report_boundary(pack_file, tmp_path):
    assert report_kind(10_000) == "json" and report_kind(10_001) == "ndjson"
    pack = load(str(pack_file))
    record = {"path": "a.txt", "status": "ok", "decision": None,
              "answers": {}, "duration_s": 0.25, "errors": []}
    outcome = SimpleNamespace(pack=pack, iter_files=lambda: iter([record]))
    stream = io.StringIO()
    write_table(outcome, stream, color=False)
    assert stream.getvalue().startswith("FILE | OUTCOME | CONFIDENCE | DURATION")
    assert "a.txt" in stream.getvalue() and "\x1b" not in stream.getvalue()

    target = tmp_path / "large.ndjson"
    artifact = ReportArtifact(str(target), 10_001, pack)
    assert artifact.partial.exists()
    artifact.event_writer({"type": "run_start", "run_id": "run_x", "files_total": 10001})
    artifact.event_writer({"type": "file", "i": 0, "status": "ok"})
    artifact.event_writer({"type": "run_end", "run_id": "run_x", "status": "completed",
                           "summary": {"files_total": 10001, "files_completed": 10001,
                                       "files_pending": 0}})
    artifact.finish(None)
    assert not artifact.partial.exists()
    events = [json.loads(line) for line in target.read_text().splitlines()]
    assert [event["type"] for event in events] == ["run_start", "file", "run_end"]
    assert events[-1]["summary"]["files_returned"] == 1


def test_ndjson_seen_counts_and_paged_output_control(pack_file):
    from dqa.analysis import load_report
    from dqa.runner import _Control

    stream = io.StringIO()
    writer = NDJSONWriter(stream, {"reject"})
    writer({"type": "run_start", "run_id": "run_x", "files_total": 3})
    writer({"type": "file", "i": 0, "status": "ok", "decision": {"outcome": "ok", "is_default": True}})
    writer({"type": "file", "i": 1, "status": "ok", "decision": {"outcome": "ok", "is_default": True}})
    writer({"type": "run_end", "run_id": "run_x", "status": "completed",
            "summary": {"files_total": 3, "files_completed": 99, "files_pending": 0}})
    report_path = pack_file.parent / "filtered.ndjson"
    report_path.write_text(stream.getvalue())
    summary = load_report(str(report_path)).summary
    assert summary["files_completed"] == 2 and summary["files_returned"] == 0
    assert summary["files_filtered_out"] == 2 and summary["files_pending"] == 1
    assert summary["files_truncated"] == 1 and summary["decisions"] == {}
    assert not load_report(str(report_path)).complete

    pack = load(str(pack_file))
    outcome = SimpleNamespace(pack=pack, interrupted=None)
    def interrupted_files():
        raise _Control(75)
        yield
    outcome.iter_files = interrupted_files
    write_csv(outcome, io.StringIO())
    assert outcome.interrupted == 75
    outcome.interrupted = None
    write_table(outcome, io.StringIO())
    assert outcome.interrupted == 75


def test_sse_failure_preserves_previous_and_streams_usable_partial(dqa, pack_file, run_server, tmp_path):
    from test_run import set_control

    material = tmp_path / "a.txt"
    material.write_text("a")
    target = tmp_path / "audit.json"
    previous = {"previous": True}
    target.write_text(json.dumps(previous))
    set_control(run_server, break_sse=True)
    result = dqa(*cli_args(pack_file, run_server, str(material), "--retry", "0",
                           "--report", str(target), "--quiet"))
    assert result.returncode == 69
    assert json.loads(target.read_text()) == previous
    partial_path = tmp_path / "audit.json.partial"
    partial = json.loads(partial_path.read_text())
    assert partial["files"] == []
    assert partial["status"] in {"running", "failed"}
    assert partial["summary"]["files_total"] == 1
    assert partial["summary"]["files_completed"] == 0
    assert partial["summary"]["files_pending"] == 1
    assert partial["summary"]["files_truncated"] == 1
    assert partial["config"]["effective_fingerprint"]
