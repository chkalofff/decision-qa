"""Тесты менеджера пресетов: CRUD по backend/presets_user/, мердж с встроенными,
защита от traversal, валидация payload. Папки подменены на tmp_path —
реальные backend/presets* не трогаем."""

from __future__ import annotations

import json
import os

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import preset_store

client = TestClient(app_module.app)

IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


@pytest.fixture
def preset_dirs(monkeypatch, tmp_path):
    """BUILTIN_DIR/USER_DIR — во временные папки с двумя встроенными пресетами."""
    builtin = tmp_path / "presets"
    user = tmp_path / "presets_user"
    builtin.mkdir()
    (builtin / "модерация.json").write_text(json.dumps({
        "name": "Модерация", "description": "встроенная",
        "input": "текст", "questions": [{"id": "q1", "question": "Ок?", "type": "yes_no"}],
    }, ensure_ascii=False), encoding="utf-8")
    (builtin / "skrining.json").write_text(json.dumps({
        "name": "Скрининг", "page": "batch",
        "questions": [{"id": "q1", "question": "Ок?", "type": "yes_no"}],
        "files": [{"name": "a.txt", "content": "резюме"}],
    }, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(preset_store, "BUILTIN_DIR", str(builtin))
    monkeypatch.setattr(preset_store, "USER_DIR", str(user))
    return builtin, user


def single_body(name="Мой пресет", **over):
    body = {
        "name": name,
        "page": "single",
        "payload": {
            "input_format": "text",
            "input": "Текст контекста.",
            "questions": [{"id": "q1", "question": "Ок?", "type": "yes_no"}],
        },
    }
    body.update(over)
    return body


# ---------------------------------------------------------------- slugify

def test_slugify():
    assert preset_store.slugify("Модерация UGC!") == "модерация-ugc"
    assert preset_store.slugify("  Пробелы   и  знаки (№1) ") == "пробелы-и-знаки-1"
    assert preset_store.slugify("!!!") == "preset"
    assert preset_store.slugify("Ёлка") == "ёлка"


# ---------------------------------------------------------------- GET

def test_list_merges_and_marks_source(preset_dirs):
    r = client.get("/api/presets")
    assert r.status_code == 200
    presets = {p["slug"]: p for p in r.json()}
    assert presets["модерация"]["source"] == "builtin"
    assert presets["skrining"]["source"] == "builtin"

    r = client.post("/api/presets", json=single_body())
    assert r.status_code == 200
    presets = {p["slug"]: p for p in client.get("/api/presets").json()}
    assert presets["мой-пресет"]["source"] == "user"
    assert len(presets) == 3


def test_user_overrides_builtin_by_slug(preset_dirs):
    # user-пресет с именем, дающим slug встроенного, перекрывает его
    r = client.post("/api/presets", json=single_body("Модерация", description="моя"))
    assert r.status_code == 200
    assert r.json()["slug"] == "модерация"
    presets = {p["slug"]: p for p in client.get("/api/presets").json()}
    assert len(presets) == 2, "перекрытие, а не дубль"
    assert presets["модерация"]["source"] == "user"
    assert presets["модерация"]["description"] == "моя"


# ---------------------------------------------------------------- POST

def test_create_and_overwrite_by_name(preset_dirs):
    r = client.post("/api/presets", json=single_body())
    assert r.status_code == 200
    assert r.json()["slug"] == "мой-пресет"
    # повторный POST с тем же именем — перезапись, а не новый slug
    r = client.post("/api/presets", json=single_body(description="v2"))
    assert r.json()["slug"] == "мой-пресет"
    assert r.json()["description"] == "v2"
    files = list((preset_dirs[1]).glob("*.json"))
    assert len(files) == 1


def test_create_slug_collision_suffix(preset_dirs):
    client.post("/api/presets", json=single_body("Одинаковое имя"))
    r = client.post("/api/presets",
                    json=single_body("Одинаковое  имя"))  # slug тот же, имя другое
    assert r.json()["slug"] == "одинаковое-имя-2"


def test_create_with_images_roundtrip(preset_dirs):
    body = single_body("С картинками")
    body["payload"]["images"] = [IMG]
    r = client.post("/api/presets", json=body)
    assert r.status_code == 200
    # читается обратно из GET с теми же картинками
    got = {p["slug"]: p for p in client.get("/api/presets").json()}["с-картинками"]
    assert got["images"] == [IMG]
    # и лежит файлом в presets_user
    saved = json.loads((preset_dirs[1] / "с-картинками.json").read_text(encoding="utf-8"))
    assert saved["images"] == [IMG]
    assert "slug" not in saved and "source" not in saved


def test_create_batch_with_file_images(preset_dirs):
    body = {
        "name": "Батч мой",
        "page": "batch",
        "payload": {
            "questions": [{"id": "q1", "question": "Ок?", "type": "score",
                           "levels": ["плохо", "хорошо"], "direction": "up"}],
            "files": [
                {"name": "doc.txt", "content": "текст", "images": [IMG]},
                {"name": "pic.png", "image": IMG},
            ],
        },
    }
    r = client.post("/api/presets", json=body)
    assert r.status_code == 200, r.json()
    got = {p["slug"]: p for p in client.get("/api/presets").json()}["батч-мой"]
    assert got["questions"][0]["direction"] == "up", "direction сохраняется"
    assert got["files"][0]["images"] == [IMG]


@pytest.mark.parametrize("patch,part", [
    ({"name": ""}, "имя"),
    ({"page": "weird"}, "page"),
    ({"payload": {"questions": []}}, "вопрос"),
    ({"payload": {"input": "x", "questions": [{"id": "q1", "question": "Q?", "type": "unknown"}]}},
     "тип"),
    ({"payload": {"input": "", "questions": [{"id": "q1", "question": "Q?", "type": "yes_no"}]}},
     "input"),
    ({"payload": {"input": "x", "images": ["не-base64!!!"],
                  "questions": [{"id": "q1", "question": "Q?", "type": "yes_no"}]}}, "Изображени"),
])
def test_create_invalid_payload_422(preset_dirs, patch, part):
    body = single_body()
    body.update(patch)
    r = client.post("/api/presets", json=body)
    assert r.status_code == 422, r.json()
    assert part.lower() in r.json()["detail"].lower()
    assert not preset_dirs[1].exists() or not list(preset_dirs[1].glob("*.json"))


def test_create_batch_bad_files_422(preset_dirs):
    def batch(files):
        return {"name": "B", "page": "batch",
                "payload": {"questions": [{"id": "q1", "question": "Q?", "type": "yes_no"}],
                            "files": files}}

    r = client.post("/api/presets", json=batch([{"name": "x.txt"}]))  # ни content, ни image
    assert r.status_code == 422
    r = client.post("/api/presets", json=batch([{"name": "x.txt", "content": "a", "image": IMG}]))
    assert r.status_code == 422 and "ровно одно" in r.json()["detail"]
    r = client.post("/api/presets", json=batch(
        [{"name": "x.txt", "content": "a", "images": [IMG] * 4}]))  # > 3 на файл
    assert r.status_code == 422 and "3" in r.json()["detail"]


# ---------------------------------------------------------------- PATCH

def test_rename_user_preset(preset_dirs):
    client.post("/api/presets", json=single_body("Старое имя"))
    r = client.patch("/api/presets/старое-имя", json={"name": "Новое имя"})
    assert r.status_code == 200
    assert r.json()["slug"] == "новое-имя"
    assert not (preset_dirs[1] / "старое-имя.json").exists(), "старый файл удалён"
    assert (preset_dirs[1] / "новое-имя.json").exists()


def test_rename_collision_409(preset_dirs):
    client.post("/api/presets", json=single_body("Первый"))
    client.post("/api/presets", json=single_body("Второй"))
    r = client.patch("/api/presets/второй", json={"name": "Первый"})
    assert r.status_code == 409
    # коллизия со встроенным — тоже 409
    r = client.patch("/api/presets/второй", json={"name": "Модерация"})
    assert r.status_code == 409


def test_rename_builtin_422_unknown_404(preset_dirs):
    r = client.patch("/api/presets/модерация", json={"name": "Другое"})
    assert r.status_code == 422
    r = client.patch("/api/presets/net-takogo", json={"name": "Другое"})
    assert r.status_code == 404


# ---------------------------------------------------------------- DELETE

def test_delete_user_preset(preset_dirs):
    client.post("/api/presets", json=single_body())
    r = client.delete("/api/presets/мой-пресет")
    assert r.status_code == 200
    assert not (preset_dirs[1] / "мой-пресет.json").exists()
    presets = client.get("/api/presets").json()
    assert all(p["slug"] != "мой-пресет" for p in presets)


def test_delete_builtin_422(preset_dirs):
    r = client.delete("/api/presets/модерация")
    assert r.status_code == 422
    assert "Встроенный" in r.json()["detail"]
    assert (preset_dirs[0] / "модерация.json").exists(), "builtin не тронут"


def test_delete_unknown_404(preset_dirs):
    r = client.delete("/api/presets/net-takogo")
    assert r.status_code == 404


# ---------------------------------------------------------------- traversal

@pytest.mark.parametrize("slug", ["..%2F..%2Fapp", "..%2Fsecret", "a%2Fb", "a..b", "-bad-"])
def test_traversal_slugs_rejected(preset_dirs, slug):
    # httpx/Starlette могут нормализовать ../ ещё до роутера (405/404) —
    # важно, что ни один вариант не доходит до файловой операции.
    r = client.delete(f"/api/presets/{slug}")
    assert r.status_code in (404, 405, 422), (slug, r.status_code)
    r = client.patch(f"/api/presets/{slug}", json={"name": "x"})
    assert r.status_code in (404, 405, 422), (slug, r.status_code)


@pytest.mark.parametrize("slug", ["../secret", "../../app", "a/b", "a\\b", "..", "a..b", "-x"])
def test_traversal_slugs_rejected_at_store_level(preset_dirs, slug):
    status, err = preset_store.delete_preset(slug)
    assert status == 422 and err
    _, status, err = preset_store.rename_preset(slug, "новое")
    assert status == 422 and err
    # и файлы вне USER_DIR не пострадали
    assert (preset_dirs[0] / "модерация.json").exists()


# ------------------------------------------------- встроенный пресет «Возвраты»

RETURNS_PATH = os.path.join(os.path.dirname(preset_store.BUILTIN_DIR),
                            "presets", "batch_returns_claims.json")


def _load_returns():
    with open(RETURNS_PATH, encoding="utf-8") as f:
        return json.load(f)


def test_builtin_returns_claims_valid():
    """batch_returns_claims.json: структура, лимиты изображений, validate_payload."""
    import re
    p = _load_returns()
    assert p["page"] == "batch"
    assert len(p["files"]) == 5
    assert len(p["questions"]) == 5
    data_url = re.compile(r"^data:image/(jpeg|png);base64,[A-Za-z0-9+/=\s]+$")
    counts = {}
    for f in p["files"]:
        images = f.get("images") or []
        assert len(images) <= 3, f["name"]
        for img in images:
            assert data_url.match(img), f["name"]
        counts[f["name"]] = len(images)
    assert counts == {"claim_01.txt": 3, "claim_02.txt": 1, "claim_03.txt": 0,
                      "claim_04.txt": 2, "claim_05.txt": 3}
    scores = [q for q in p["questions"] if q["type"] == "score"]
    assert len(scores) == 2
    assert {q["direction"] for q in scores} == {"up", "down"}
    assert p["decision"]["outcomes"], "у пресета должны быть исходы decision"
    assert preset_store.validate_payload(p["page"], p) is None


def test_builtin_returns_claims_in_list():
    """Пресет виден в list_presets() со source builtin (реальные папки)."""
    found = [p for p in preset_store.list_presets()
             if p["slug"] == "batch_returns_claims"]
    assert len(found) == 1
    assert found[0]["source"] == "builtin"
    assert found[0]["name"] == "Возвраты: претензии с фото"


def test_builtin_presets_quality():
    """Все встроенные пресеты: у score-вопросов задан direction, есть decision
    с исходами, payload целиком проходит validate_payload,
    описания короткие (меню не должно переполняться)."""
    builtins = [p for p in preset_store.list_presets() if p["source"] == "builtin"]
    assert len(builtins) >= 8, "встроенных пресетов должно быть достаточно"
    for p in builtins:
        assert len(p.get("description") or "") <= 100, p["slug"]
        for q in p.get("questions", []):
            if q.get("type") == "score":
                assert q.get("direction") in ("up", "down"), (p["slug"], q["question"])
        outcomes = p.get("decision", {}).get("outcomes") or []
        assert outcomes, (p["slug"], "нет исходов decision")
        assert any(o.get("isDefault") for o in outcomes), (p["slug"], "нет default-исхода")
        err = preset_store.validate_payload(p.get("page", "single"), p)
        assert err is None, (p["slug"], err)
