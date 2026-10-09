"""Пресеты: встроенные (backend/presets/, read-only) + пользовательские
(backend/presets_user/, CRUD через API). Мердж по slug: пользовательский
пресет перекрывает встроенный с тем же slug. Запись атомарная (tmp + replace).
"""

from __future__ import annotations

import base64
import json
import os
import re

from pydantic import ValidationError

from backend.schemas import (
    MAX_IMAGES, MAX_IMAGES_B64_CHARS, Question, _DATA_URL_RE,
)

BUILTIN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "presets")
USER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "presets_user")

# slug — имя файла без .json: строгий алфавит, чтобы исключить path traversal.
SLUG_RE = re.compile(r"^[a-z0-9а-яё]([a-z0-9а-яё-]{0,62}[a-z0-9а-яё])?$")
_SLUG_BAD_RE = re.compile(r"[^a-z0-9а-яё]+")
MAX_FILE_IMAGES = 3          # изображений на один текстовый файл батча (как на фронте)
DIRECTIONS = {"up", "down", "neutral"}          # score
DIRECTIONS_YN = {"yes", "no", "neutral"}        # yes_no


def slugify(name: str) -> str:
    """Имя → slug: lowercase, не [a-z0-9а-яё] → '-', края обрезаны."""
    slug = _SLUG_BAD_RE.sub("-", name.strip().lower()).strip("-")
    return slug[:64].strip("-") or "preset"


def _user_path(slug: str) -> str | None:
    """Путь к файлу user-пресета; None для невалидного slug (traversal и пр.)."""
    if not SLUG_RE.match(slug):
        return None
    path = os.path.join(USER_DIR, slug + ".json")
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(USER_DIR):
        return None
    return path


def _read_dir(directory: str, source: str) -> dict[str, dict]:
    """{slug: preset} из папки; битые JSON пропускаем."""
    out: dict[str, dict] = {}
    if not os.path.isdir(directory):
        return out
    for fname in sorted(os.listdir(directory)):
        if not fname.endswith(".json"):
            continue
        path = os.path.join(directory, fname)
        try:
            with open(path, encoding="utf-8") as f:
                preset = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(preset, dict):
            continue
        preset["slug"] = fname[:-5]
        preset["source"] = source
        out[preset["slug"]] = preset
    return out


def list_presets() -> list[dict]:
    """Мердж builtin + user; user с тем же slug перекрывает builtin."""
    merged = _read_dir(BUILTIN_DIR, "builtin")
    merged.update(_read_dir(USER_DIR, "user"))
    return list(merged.values())


# ---------------------------------------------------------------- валидация

def _check_image(img, budget: list[int]) -> str | None:
    """Одно изображение: data URL / base64, декодируется, вписывается в бюджет."""
    if not isinstance(img, str) or not img:
        return "Изображение должно быть строкой: data URL (data:image/...;base64,...)"
    m = _DATA_URL_RE.match(img)
    b64 = m.group(1) if m else img
    try:
        base64.b64decode(b64, validate=True)
    except Exception:
        return "Изображение должно быть data URL (data:image/...;base64,...) или валидным base64"
    budget[0] += len(b64)
    if budget[0] > MAX_IMAGES_B64_CHARS:
        return "Суммарный объём изображений больше 20 МБ"
    return None


def _check_decision(decision, questions) -> str | None:
    """Правила решения: исходы → правила (ИЛИ между ними) → условия (И/ИЛИ).
    Условие yes_no/choice: {question, answer, op: gte/lt, threshold 0..1} —
    порог вероятности ответа; score: {question, op, score} — порог среднего
    балла (0-based, как в результатах)."""
    if decision is None:
        return None
    if not isinstance(decision, dict) or not isinstance(decision.get("outcomes"), list):
        return "decision: нужен объект с outcomes"
    qmap = {q["id"]: q for q in questions}
    labels: list[str] = []
    defaults = 0
    for o in decision["outcomes"]:
        if not isinstance(o, dict):
            return "decision: исход должен быть объектом"
        label = str(o.get("label") or "").strip()
        if not label:
            return "decision: пустое название исхода"
        if label in labels:
            return f"decision: дублируется исход «{label}»"
        labels.append(label)
        if o.get("isDefault"):
            defaults += 1
        rules = o.get("rules") or []
        if not isinstance(rules, list):
            return f"decision: rules исхода «{label}» — список"
        for r in rules:
            conds = (r or {}).get("conditions")
            if not isinstance(conds, list) or not conds:
                return f"decision: у правила исхода «{label}» должно быть условие"
            for c in conds:
                if not isinstance(c, dict):
                    return f"decision: условие исхода «{label}» — объект"
                q = qmap.get(c.get("question"))
                if q is None:
                    return (f"decision: условие исхода «{label}» — "
                            f"неизвестный вопрос {c.get('question')!r}")
                if c.get("op") not in ("gte", "lt"):
                    return f"decision: условие исхода «{label}» — op: gte/lt"
                ans = c.get("answer")
                if ans is not None:
                    if q["type"] == "score":
                        return ("decision: для score-вопроса условие по среднему "
                                "баллу (score), без answer")
                    opts = (["yes", "no"] if q["type"] == "yes_no"
                            else [o2["name"] for o2 in q.get("options") or []])
                    if ans not in opts:
                        return f"decision: у вопроса {q['id']!r} нет ответа {ans!r}"
                    thr = c.get("threshold")
                    if not isinstance(thr, (int, float)) or isinstance(thr, bool) \
                            or not (0 <= thr <= 1):
                        return f"decision: threshold 0..1 у исхода «{label}»"
                else:
                    if q["type"] != "score":
                        return ("decision: для не-score вопроса нужны answer "
                                "и threshold")
                    s = c.get("score")
                    max_idx = len(q.get("levels") or []) - 1
                    if not isinstance(s, (int, float)) or isinstance(s, bool) \
                            or not (0 <= s <= max_idx):
                        return f"decision: score 0..{max_idx} у исхода «{label}»"
    if defaults > 1:
        return "decision: исход по умолчанию может быть только один"
    return None


def _check_questions(questions) -> str | None:
    if not isinstance(questions, list) or not questions:
        return "Нужен хотя бы один вопрос (questions)"
    ids = []
    for q in questions:
        if not isinstance(q, dict):
            return "Вопрос должен быть объектом"
        try:
            Question.model_validate(q)
        except ValidationError as e:
            return "Вопрос: " + "; ".join(err["msg"] for err in e.errors())
        direction = q.get("direction")
        if direction is not None:
            valid = {"yes_no": DIRECTIONS_YN, "score": DIRECTIONS}.get(q.get("type"))
            if valid is None:
                return "direction допустим только у вопросов yes_no и score"
            if direction not in valid:
                return (f"Неизвестное direction: {direction!r} "
                        f"({'/'.join(sorted(valid))})")
        ids.append(q["id"])
    if len(ids) != len(set(ids)):
        return "id вопросов должны быть уникальными"
    return None


def validate_payload(page: str, payload) -> str | None:
    """Сообщение об ошибке или None. Те же модели/лимиты, что у /api/decide."""
    if not isinstance(payload, dict):
        return "payload должен быть объектом"
    budget = [0]  # суммарный base64-объём всех изображений пресета
    err = _check_questions(payload.get("questions"))
    if err:
        return err
    err = _check_decision(payload.get("decision"), payload["questions"])
    if err:
        return err
    if page == "single":
        if "input" not in payload:
            return "Для одиночного пресета нужен input"
        inp = payload["input"]
        if not isinstance(inp, (str, dict, list)):
            return "input должен быть строкой или JSON (объект/массив)"
        images = payload.get("images")
        if images is not None:
            if not isinstance(images, list) or len(images) > MAX_IMAGES:
                return f"Не больше {MAX_IMAGES} изображений контекста"
            for img in images:
                err = _check_image(img, budget)
                if err:
                    return err
        if isinstance(inp, str) and not inp.strip() and not images:
            return "Пустой input допустим только с изображениями"
        fmt = payload.get("input_format")
        if fmt is not None and fmt not in ("text", "json"):
            return "input_format: text или json"
        return None
    # batch
    files = payload.get("files")
    if not isinstance(files, list) or not files:
        return "Для батч-пресета нужен непустой files"
    for f in files:
        if not isinstance(f, dict) or not isinstance(f.get("name"), str) or not f["name"].strip():
            return "У каждого файла должно быть непустое имя (name)"
        content = f.get("content")
        image = f.get("image")
        if (content is None) == (image is None):
            return f"{f['name']}: ровно одно из content / image"
        if content is not None and not isinstance(content, str):
            return f"{f['name']}: content должен быть строкой"
        if image is not None:
            err = _check_image(image, budget)
            if err:
                return f"{f['name']}: {err}"
        images = f.get("images")
        if images is not None:
            if image is not None:
                return f"{f['name']}: images — только у текстового файла (с content)"
            if not isinstance(images, list) or len(images) > MAX_FILE_IMAGES:
                return f"{f['name']}: не больше {MAX_FILE_IMAGES} изображений на файл"
            for img in images:
                err = _check_image(img, budget)
                if err:
                    return f"{f['name']}: {err}"
    return None


# ---------------------------------------------------------------- запись

def _write(slug: str, preset: dict) -> None:
    """Атомарная запись (tmp + os.replace), как save_registry в model_manager."""
    os.makedirs(USER_DIR, exist_ok=True)
    path = _user_path(slug)
    assert path is not None  # slug прошёл slugify/SLUG_RE до вызова
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(preset, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def _user_presets() -> dict[str, dict]:
    return _read_dir(USER_DIR, "user")


def create_preset(data) -> tuple[dict | None, str | None]:
    """Создать/перезаписать user-пресет. → (preset с slug/source, ошибка)."""
    if not isinstance(data, dict):
        return None, "Тело запроса должно быть объектом"
    name = str(data.get("name") or "").strip()
    if not name:
        return None, "Пустое имя пресета"
    page = data.get("page")
    if page not in ("single", "batch"):
        return None, 'page: "single" или "batch"'
    payload = data.get("payload")
    err = validate_payload(page, payload)
    if err:
        return None, err

    preset = {"name": name}
    description = str(data.get("description") or "").strip()
    if description:
        preset["description"] = description
    if page == "batch":
        preset["page"] = "batch"
    preset.update(payload)

    existing = _user_presets()
    # Перезапись по имени: тот же name (case-insensitive) → тот же slug.
    slug = next((s for s, p in existing.items()
                 if p.get("name", "").casefold() == name.casefold()), None)
    if slug is None:
        base = slugify(name)
        slug = base
        n = 2
        while slug in existing:  # коллизия с чужим user-пресетом → суффикс
            slug = f"{base}-{n}"
            n += 1
    _write(slug, preset)
    preset["slug"] = slug
    preset["source"] = "user"
    return preset, None


def rename_preset(slug: str, new_name: str) -> tuple[dict | None, int, str | None]:
    """Переименование user-пресета. → (preset, http_status, ошибка)."""
    path = _user_path(slug)
    if path is None:
        return None, 422, f"Недопустимый slug: {slug!r}"
    existing = _user_presets()
    if slug not in existing:
        if slug in _read_dir(BUILTIN_DIR, "builtin"):
            return None, 422, "Встроенный пресет нельзя переименовать"
        return None, 404, f"Неизвестный пресет: {slug!r}"
    name = new_name.strip()
    if not name:
        return None, 422, "Пустое имя пресета"
    new_slug = slugify(name)
    if new_slug != slug:
        if new_slug in existing or os.path.exists(
                os.path.join(BUILTIN_DIR, new_slug + ".json")):
            return None, 409, f"Имя занято: {name!r}"
    preset = existing[slug]
    preset["name"] = name
    preset.pop("slug", None)
    preset.pop("source", None)
    _write(new_slug, preset)
    if new_slug != slug:
        os.unlink(path)
    preset["slug"] = new_slug
    preset["source"] = "user"
    return preset, 200, None


def delete_preset(slug: str) -> tuple[int, str | None]:
    """Удаление user-пресета. → (http_status, ошибка)."""
    path = _user_path(slug)
    if path is None:
        return 422, f"Недопустимый slug: {slug!r}"
    if not os.path.exists(path):
        if slug in _read_dir(BUILTIN_DIR, "builtin"):
            return 422, "Встроенный пресет нельзя удалить"
        return 404, f"Неизвестный пресет: {slug!r}"
    os.unlink(path)
    return 200, None
