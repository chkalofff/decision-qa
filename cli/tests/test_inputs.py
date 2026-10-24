from __future__ import annotations

from types import SimpleNamespace

from dqa.inputs import build_plan


def args(**changes):
    values = {
        "materials": [], "image": [], "null": False, "files_from": None,
        "manifest": None, "stdin": False, "name": None, "glob": "*",
        "recursive": False, "encoding": "utf-8",
    }
    values.update(changes)
    return SimpleNamespace(**values)


def capabilities():
    return {"max_files_per_job": 100, "max_images": 8, "max_images_b64_chars": 1000}


def test_material_payload_structured_text_images_and_contiguous_indices(tmp_path, monkeypatch):
    from pathlib import Path

    structured = tmp_path / "object.json"
    structured.write_text('{"a": 1}')
    fallback = tmp_path / "fallback.json"
    fallback.write_text("{broken")
    image = tmp_path / "image.png"
    image.write_bytes(b"png")
    reads = []
    original_read_bytes = Path.read_bytes

    def counted_read_bytes(path):
        if path in {structured, fallback}:
            reads.append(path)
        return original_read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", counted_read_bytes)
    plan = build_plan(args(materials=[str(structured), str(fallback), str(image)]), capabilities())
    assert [material.i for material in plan.materials] == [0, 1, 2]
    assert reads == [structured, fallback]
    assert plan.materials[0].input is None and plan.materials[1].input is None

    reads.clear()
    assert plan.materials[0].payload()["input"] == {"a": 1}
    assert reads == [structured]
    assert plan.materials[1].payload()["input"] == "{broken"
    assert reads == [structured, fallback]
    image_payload = plan.materials[2].payload()
    assert image_payload["input"] == "Изображение: image.png"
    assert image_payload["images"] == ["data:image/png;base64,cG5n"]
    assert image_payload["material"] == {"type": "image", "images": [{"name": "image.png", "sha256": plan.materials[2].images[0].sha256}]}


def test_filesystem_payload_read_failure_is_clear_validation_error(tmp_path):
    import pytest

    from dqa.client import DqaError

    source = tmp_path / "gone.txt"
    source.write_text("content")
    material = build_plan(args(materials=[str(source)]), capabilities()).materials[0]
    source.unlink()
    with pytest.raises(DqaError) as caught:
        material.payload()
    assert caught.value.code == 65
    assert str(source) in caught.value.message and "upload" in caught.value.message
