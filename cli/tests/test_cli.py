from __future__ import annotations

import hashlib
import json
import os
import unicodedata
from pathlib import Path

from dqa_common.config_pack import canonical_bytes
from dqa_common.materials import composite_content_sha256


def data(result):
    assert result.stdout, result.stderr.decode()
    return json.loads(result.stdout)


def ok(result):
    assert result.returncode == 0, result.stderr.decode()
    return data(result)


def test_config_profiles_precedence_masking_and_permissions(dqa, http_server):
    created = ok(dqa("config", "init", "--server", "http://profile:8000", token=None))
    path = Path(created["config_path"])
    if os.name == "posix":
        assert path.stat().st_mode & 0o777 == 0o600
    ok(dqa("config", "set", "--profile", "staging", "server", "http://staging:8000", token=None))
    ok(dqa("config", "set", "--profile", "staging", "token", "dqa_1234567890abcdf3a9", token=None))
    shown = ok(dqa("config", "show", "--profile", "staging", token=None))
    assert shown["server"] == "http://staging:8000"
    assert shown["token"] == "dqa_…f3a9"
    assert "1234567890" not in json.dumps(shown)
    assert shown["sources"] == {"server": "profile staging", "profile": "flag --profile", "token": "profile staging"}
    overridden = ok(dqa("config", "show", "--profile", "staging", token="env-secret",
                        env_extra={"DQA_SERVER": "http://env:8000"}))
    assert overridden["server"] == "http://env:8000"
    assert overridden["sources"]["server"] == "env DQA_SERVER"
    assert overridden["sources"]["token"] == "env DQA_TOKEN"
    flagged = ok(dqa("config", "show", "--profile", "staging", "--server", http_server["url"], token=None))
    assert flagged["sources"]["server"] == "flag --server"


def test_pack_overrides_validate_and_bearer(validate, dqa, pack_file, http_server, tmp_path):
    material = tmp_path / "one.txt"
    material.write_text("текст", encoding="utf-8")
    summary = ok(dqa("run", str(material), "--config", str(pack_file), "--server", http_server["url"],
                     "--models", "beta", "--mode", "both", "--dry-run"))
    assert summary["models"] == ["beta"]
    assert summary["models_pack"] == ["alpha"]
    assert summary["mode"] == "both" and summary["mode_pack"] == "decisions"
    assert summary["models_overridden"] is True and summary["mode_overridden"] is True
    assert summary["effective_hash"] != json.loads(pack_file.read_text())["hash"]
    assert summary["est_requests"] == 1 and summary["estimate"] is None
    assert http_server["requests"][-1]["authorization"] == "Bearer secret"
    packed = ok(dqa("pack", "show", str(pack_file)))
    assert packed["outcome_ids"] == ["reject", "ok"]
    assert packed["questions"][0]["id"] == "q1"


def test_directory_convention_direct_files_and_orphans(validate, tmp_path):
    directory = tmp_path / "inbox"
    directory.mkdir()
    (directory / "claim.txt").write_text("letter", encoding="utf-8")
    (directory / "claim_p2.png").write_bytes(b"p2")
    (directory / "claim_p1.png").write_bytes(b"p1")
    (directory / "orphan.jpg").write_bytes(b"orphan")
    summary = ok(validate(str(directory)))
    assert summary["files_ok"] == 2
    grouped = summary["files"][0]
    assert grouped["material"]["type"] == "text+images"
    assert [image["name"] for image in grouped["material"]["images"]] == ["claim_p1.png", "claim_p2.png"]
    assert summary["files"][1]["material"]["type"] == "image"
    assert summary["warnings"][0]["code"] == "orphan_image"
    direct = ok(validate(str(directory / "claim.txt"), str(directory / "claim_p1.png")))
    assert direct["files_ok"] == 2
    assert all(item["material"]["type"] != "text+images" for item in direct["files"])


def test_recursive_glob_and_first_50(validate, tmp_path):
    root = tmp_path / "tree"
    nested = root / "nested"
    nested.mkdir(parents=True)
    (root / "a.txt").write_text("a")
    (root / "a.md").write_text("markdown")
    (nested / "b.txt").write_text("b")
    recursive = ok(validate(str(root), "-r"))
    assert recursive["files_ok"] == 3
    only_txt = ok(validate(str(root), "-r", "--glob", "*.txt"))
    assert only_txt["files_ok"] == 2
    many = tmp_path / "many"
    many.mkdir()
    for index in range(53):
        (many / f"{index:03}.txt").write_text(str(index))
    truncated = ok(validate(str(many)))
    assert truncated["files_ok"] == 53 and truncated["files_returned"] == 50
    assert truncated["files_truncated"] == 3 and len(truncated["files"]) == 50


def test_stdin_implicit_explicit_name_and_image_only(validate, tmp_path):
    implicit = ok(validate(input_bytes="неявный".encode()))
    assert implicit["files"][0]["name"] == "stdin"
    explicit = ok(validate("--stdin", "--name", "case.txt", input_bytes="явный".encode()))
    assert explicit["files"][0]["name"] == "case.txt"
    image = tmp_path / "one.png"
    image.write_bytes(b"png")
    only = ok(validate("--image", str(image), "--name", "photo"))
    assert only["files"][0]["material"]["type"] == "image"
    assert only["files"][0]["material"]["images"][0]["sha256"] == hashlib.sha256(b"png").hexdigest()


def test_files_from_comments_and_nul(validate, dqa, pack_file, http_server, tmp_path):
    first = tmp_path / "first file.txt"
    second = tmp_path / "кириллица.txt"
    first.write_text("one")
    second.write_text("two")
    listing = tmp_path / "list.txt"
    listing.write_text(f"# comment\n{first}\n\n{second}\n", encoding="utf-8")
    lines = ok(validate("--files-from", str(listing)))
    assert lines["files_ok"] == 2
    nul = ok(dqa("validate", "--config", str(pack_file), "--server", http_server["url"],
                 "--files-from", "-", "--null", input_bytes=f"{first}\0{second}\0".encode()))
    assert nul["files_ok"] == 2
    assert [item["source_index"] for item in nul["files"]] == [0, 1]


def test_manifest_and_repeated_image_order_and_empty_text(validate, tmp_path):
    text = tmp_path / "post.txt"
    text.write_bytes(b"")
    second = tmp_path / "z.png"
    first = tmp_path / "a.png"
    second.write_bytes(b"z")
    first.write_bytes(b"a")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps([{"path": "post.txt", "name": "renamed", "images": ["z.png", "a.png"]}]))
    summary = ok(validate("--manifest", str(manifest)))
    item = summary["files"][0]
    assert item["status"] == "ok" and item["material"]["type"] == "text+images"
    assert [image["name"] for image in item["material"]["images"]] == ["z.png", "a.png"]
    repeated = ok(validate(str(text), "--image", str(second), "--image", str(first)))
    assert [image["name"] for image in repeated["files"][0]["material"]["images"]] == ["z.png", "a.png"]


def test_cp1251_bom_raw_hash_json_fallback_duplicates_and_rename(validate, tmp_path):
    cp = tmp_path / "win.txt"
    raw_cp = "Привет".encode("cp1251")
    cp.write_bytes(raw_cp)
    failed = validate(str(cp))
    assert failed.returncode == 65
    decoded = ok(validate(str(cp), "--encoding", "cp1251"))
    assert decoded["files"][0]["content_sha256"] == composite_content_sha256(raw_cp)
    bom = tmp_path / "bom.txt"
    raw_bom = b"\xef\xbb\xbfhello"
    bom.write_bytes(raw_bom)
    bom_summary = ok(validate(str(bom)))
    assert bom_summary["files"][0]["content_sha256"] == composite_content_sha256(raw_bom)
    assert bom_summary["files"][0]["content_sha256"] != composite_content_sha256(b"hello")
    renamed = tmp_path / "renamed.txt"
    renamed.write_bytes(raw_bom)
    duplicates = ok(validate(str(bom), str(renamed)))
    assert duplicates["files_ok"] == 1 and duplicates["files_skipped"] == 1
    skipped = next(item for item in duplicates["files"] if item["status"] == "skipped")
    assert skipped["reason"] == "duplicate" and skipped["duplicates_of"] == str(bom)
    structured = tmp_path / "structured.json"
    structured.write_text('{"a": 1}')
    invalid = tmp_path / "invalid.json"
    invalid.write_text('{broken')
    parsed = ok(validate(str(structured), str(invalid)))
    assert parsed["files_ok"] == 2


def test_basename_ambiguity_nfc_and_case(validate, tmp_path):
    ambiguous = tmp_path / "ambiguous"
    ambiguous.mkdir()
    (ambiguous / "claim.txt").write_text("a")
    (ambiguous / "claim_557.txt").write_text("b")
    (ambiguous / "claim_557_p1.jpg").write_bytes(b"jpg")
    result = validate(str(ambiguous))
    assert result.returncode == 65 and "подпадает под две группы" in result.stderr.decode()
    nfc = tmp_path / "nfc"
    nfc.mkdir()
    composed = "претензия_е"
    decomposed = unicodedata.normalize("NFD", composed)
    (nfc / f"{composed}.txt").write_text("nfc")
    (nfc / f"{decomposed}_p1.png").write_bytes(b"png")
    grouped = ok(validate(str(nfc)))
    assert grouped["files_ok"] == 1 and grouped["files"][0]["material"]["type"] == "text+images"
    cased = tmp_path / "case"
    cased.mkdir()
    (cased / "Claim.TXT").write_text("case")
    (cased / "claim_p1.jpg").write_bytes(b"jpg")
    separate = ok(validate(str(cased)))
    assert separate["files_ok"] == 2
    assert "регистр" in separate["warnings"][0]["message"]


def test_unknown_heic_empty_and_no_valid_inputs(validate, tmp_path):
    directory = tmp_path / "mixed"
    directory.mkdir()
    (directory / "good.txt").write_text("good")
    (directory / "empty.txt").write_bytes(b"")
    (directory / "unknown.xyz").write_bytes(b"?")
    (directory / "photo.heic").write_bytes(b"heic")
    summary = ok(validate(str(directory)))
    assert summary["files_total"] == 4 and summary["files_ok"] == 1 and summary["files_skipped"] == 3
    assert summary["files_returned"] == len(summary["files"]) == 4
    assert summary["files_truncated"] == 0
    assert summary["skipped_reasons"]["empty"] == 1
    assert summary["skipped_reasons"]["unsupported"] == 2
    heic = next(item for item in summary["files"] if item.get("path", "").endswith(".heic"))
    assert "JPEG" in heic["message"]
    empty = tmp_path / "only-empty.txt"
    empty.write_bytes(b"")
    assert validate(str(empty)).returncode == 65
    assert validate(str(tmp_path / "missing.txt")).returncode == 66


def test_capabilities_models_auth_and_limits(validate, http_server, tmp_path):
    material = tmp_path / "a.txt"
    material.write_text("a")
    unknown = validate(str(material), "--models", "unknown")
    assert unknown.returncode == 65 and "alpha" in unknown.stderr.decode()
    stopped = validate(str(material), "--models", "stopped")
    assert stopped.returncode == 69 and "не запущены" in stopped.stderr.decode()
    denied = validate(str(material), token=None)
    assert denied.returncode == 77
    image = tmp_path / "a.png"
    image.write_bytes(b"png")
    wrong_mode = validate(str(image), "--mode", "fast_batch")
    assert wrong_mode.returncode == 65 and "decisions" in wrong_mode.stderr.decode()
    http_server["capabilities"]["max_images"] = 0
    over_limit = validate(str(image))
    assert over_limit.returncode == 65 and "лимит 0" in over_limit.stderr.decode()
    http_server["capabilities_status"] = 500
    unavailable = validate(str(material))
    assert unavailable.returncode == 69


def test_skip_processed_counts(validate, tmp_path):
    material = tmp_path / "same.txt"
    raw = b"same"
    material.write_bytes(raw)
    fingerprint_probe = ok(validate(str(material)))
    fingerprint = fingerprint_probe["effective_fingerprint"]
    content = composite_content_sha256(raw)
    key = hashlib.sha256(canonical_bytes({"content_sha256": content, "effective_fingerprint": fingerprint})).hexdigest()
    processed = tmp_path / "seen.ndjson"
    processed.write_text(json.dumps({"key": key, "outcome": "ok"}) + "\n")
    summary = ok(validate(str(material), "--skip-processed", str(processed)))
    assert summary["skip_processed"] == {"path": str(processed), "new": 0, "already_processed": 1}


def test_version_doctor_shim_and_explicit_intermediate_gaps(dqa, pack_file, http_server, tmp_path):
    version = ok(dqa("version", "--server", http_server["url"], shim=True))
    assert version["compatible"] is True and version["server_version"] == "1.3-test"
    http_server["capabilities"]["models"] = [model for model in http_server["capabilities"]["models"] if model["status"] == "running"]
    doctor = ok(dqa("doctor", "--config", str(pack_file), "--format", "json", "--server", http_server["url"]))
    assert doctor["ok"] is True
    assert {"python", "dependencies", "server", "capabilities", "auth", "pack"} <= {c["name"] for c in doctor["checks"]}
    material = tmp_path / "a.txt"
    material.write_text("a")
    run = dqa("run", str(material), "--config", str(pack_file), "--server", http_server["url"])
    assert run.returncode == 70 and "6B" in run.stderr.decode() and not run.stdout
    explain = dqa("explain", "a", "--report", "r.json")
    assert explain.returncode == 70 and "6C" in explain.stderr.decode()
    token_flag = dqa("version", "--token", "bad")
    assert token_flag.returncode == 64
