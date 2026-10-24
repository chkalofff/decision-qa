"""Deterministic filesystem/stdin materials and validation input plans."""

from __future__ import annotations

import base64
import fnmatch
import hashlib
import json
import os
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Iterator

from dqa_common.config_pack import canonical_bytes
from dqa_common.materials import composite_content_sha256, raw_content_sha256

from .client import DqaError

TEXT_EXTENSIONS = {".txt", ".md", ".json"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
MIME_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif",
}
SKIP_REASONS = ("empty", "unreadable", "encoding", "duplicate", "unsupported")


@dataclass
class ImageAttachment:
    name: str
    path: Path | None
    sha256: str
    b64_chars: int
    _raw: bytes | None = field(default=None, repr=False)

    def metadata(self) -> dict[str, str]:
        return {"name": self.name, "sha256": self.sha256}

    def raw(self) -> bytes:
        if self._raw is not None:
            return self._raw
        if self.path is None:
            raise DqaError(70, f"Для изображения {self.name} нет исходного файла.")
        try:
            return self.path.read_bytes()
        except OSError as exc:
            raise DqaError(65, f"Не удалось повторно прочитать изображение {self.path}: {exc}") from exc

    def release_raw(self) -> None:
        self._raw = None

    def data_url(self) -> str:
        extension = self.path.suffix.lower() if self.path else ".png"
        return f"data:{MIME_TYPES[extension]};base64,{base64.b64encode(self.raw()).decode('ascii')}"


@dataclass
class Material:
    source_index: int
    i: int
    input: str | dict | list | None
    images: list[ImageAttachment]
    content_sha256: str
    path: str | None = None
    name: str | None = None
    kind: str = "text"
    status: str = "ok"
    encoding: str | None = None

    def material(self) -> dict[str, Any]:
        return {"type": self.kind, "images": [image.metadata() for image in self.images]}

    def summary(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "source_index": self.source_index, "i": self.i, "status": "ok",
            "material": self.material(), "content_sha256": self.content_sha256,
        }
        if self.path is not None:
            result["path"] = self.path
        if self.name is not None:
            result["name"] = self.name
        return result

    def payload(self) -> dict[str, Any]:
        result = self.summary()
        result.pop("source_index", None)
        result.pop("status", None)
        result.update({"input": self._payload_input(), "images": [image.data_url() for image in self.images]})
        return result

    def _payload_input(self) -> str | dict | list:
        if self.input is not None:
            return self.input
        if self.path is None:
            raise DqaError(70, f"Материал {self.name or self.i} не содержит input или исходного пути.")
        path = Path(self.path)
        try:
            raw = path.read_bytes()
            text = raw.decode(self.encoding or "utf-8-sig")
        except (OSError, UnicodeError, LookupError) as exc:
            raise DqaError(65, f"Не удалось прочитать материал {path} при подготовке upload: {exc}") from exc
        if path.suffix.lower() == ".json":
            try:
                parsed = json.loads(text)
                if isinstance(parsed, (dict, list)):
                    return parsed
            except json.JSONDecodeError:
                pass
        return text


@dataclass
class SkippedRecord:
    source_index: int
    reason: str
    path: str | None = None
    name: str | None = None
    material: dict[str, Any] = field(default_factory=lambda: {"type": "text", "images": []})
    content_sha256: str | None = None
    duplicates_of: str | None = None
    message: str | None = None
    status: str = "skipped"

    def summary(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "source_index": self.source_index, "status": self.status,
            "reason": self.reason, "material": self.material,
        }
        if self.message is not None:
            result["message"] = self.message
        if self.path is not None:
            result["path"] = self.path
        if self.name is not None:
            result["name"] = self.name
        if self.content_sha256 is not None:
            result["content_sha256"] = self.content_sha256
        if self.duplicates_of is not None:
            result["duplicates_of"] = self.duplicates_of
        return result


@dataclass
class InputPlan:
    records: list[Material | SkippedRecord]
    warnings: list[dict[str, Any]] = field(default_factory=list)

    @property
    def materials(self) -> list[Material]:
        return [record for record in self.records if isinstance(record, Material)]

    @property
    def skipped(self) -> list[SkippedRecord]:
        return [record for record in self.records if isinstance(record, SkippedRecord)]

    def summary(self, pack: Any, *, skip_processed: dict[str, Any] | None = None) -> dict[str, Any]:
        materials = self.materials
        skipped = self.skipped
        reasons = {reason: 0 for reason in SKIP_REASONS}
        for record in skipped:
            reasons[record.reason] += 1
        successful = [record.summary() for record in materials[:50]]
        skipped_records = [record.summary() for record in skipped]
        result = {
            "schema": 1,
            "type": "validation",
            "files_total": len(self.records),
            "files_ok": len(materials),
            "files_skipped": len(skipped),
            "skipped_reasons": reasons,
            "files": successful + skipped_records,
            "files_returned": len(successful) + len(skipped_records),
            "files_truncated": max(0, len(materials) - 50),
            "models": pack.models,
            "models_pack": pack.original["settings"]["models"],
            "mode": pack.mode,
            "mode_pack": pack.original["settings"]["mode"],
            "models_overridden": pack.models_overridden,
            "mode_overridden": pack.mode_overridden,
            "effective_hash": pack.effective["hash"],
            "effective_fingerprint": pack.effective["fingerprint"],
            "est_requests": len(materials) * len(pack.models),
            "estimate": None,
            "warnings": self.warnings,
            "errors": [],
        }
        if skip_processed is not None:
            result["skip_processed"] = skip_processed
        return result


def build_plan(args: Any, capabilities: dict[str, Any], *, stdin: BinaryIO | None = None) -> InputPlan:
    stdin = sys.stdin.buffer if stdin is None else stdin
    records: list[Material | SkippedRecord] = []
    warnings: list[dict[str, Any]] = []
    for item in _sources(args, stdin):
        if isinstance(item, tuple) and item and item[0] == "warning":
            warnings.append(item[1])
            continue
        item.source_index = len(records)
        records.append(item)
    records = _deduplicate(records)
    materials: list[Material] = []
    for record in records:
        if isinstance(record, Material):
            record.i = len(materials)
            materials.append(record)
    if not materials:
        raise DqaError(65, "Нет валидных материалов. Проверьте вход, кодировку и поддерживаемые расширения.")
    if len(materials) > capabilities["max_files_per_job"]:
        raise DqaError(65, f"Материалов {len(materials)} больше max_files_per_job={capabilities['max_files_per_job']}. Разбейте вход или поднимите лимит на сервере.")
    _check_image_limits(materials, capabilities, warnings)
    return InputPlan(records, warnings)


def _sources(args: Any, stdin: BinaryIO) -> Iterator[Material | SkippedRecord | tuple[str, dict[str, Any]]]:
    positional = list(args.materials or [])
    explicit_images = list(args.image or [])
    if args.null and not args.files_from:
        raise DqaError(64, "--null используется только вместе с --files-from.")
    if args.name and not args.stdin and positional:
        raise DqaError(64, "--name задаёт имя stdin-материала; для файлов используйте --manifest.")
    if explicit_images and (len(positional) > 1 or args.files_from or args.manifest):
        raise DqaError(64, "--image относится к одному материалу; для пакетной группировки используйте --manifest.")
    manifest_items = _read_manifest(args.manifest) if args.manifest else []
    has_source = bool(positional or args.files_from or manifest_items or args.stdin or explicit_images)
    if not has_source and not sys.stdin.isatty():
        args.stdin = True
    if args.stdin and (positional or args.files_from or manifest_items):
        raise DqaError(64, "Явный --stdin нельзя смешивать с файлами или --manifest.")
    if not positional and not args.files_from and not manifest_items and not args.stdin and explicit_images:
        yield _image_material(None, args.name or "image", 0, explicit_images)
        return
    bases: Iterable[Any] = positional
    if args.files_from:
        from itertools import chain
        bases = chain(bases, _files_from(args.files_from, args.null))
    if args.stdin:
        from itertools import chain
        bases = chain(bases, [_StdinSource(stdin, args.name or "stdin")])
    for base in bases:
        if isinstance(base, _StdinSource):
            yield _stdin_material(base, 0, explicit_images, args.encoding)
            continue
        path = Path(base).expanduser()
        if not path.exists():
            raise DqaError(66, f"Входной путь не существует: {path}")
        if path.is_dir():
            if explicit_images:
                raise DqaError(64, "--image требует одиночный файл/stdin, а не каталог; используйте --manifest.")
            yield from _directory_materials(path, args.glob, args.recursive, args.encoding)
        else:
            yield _file_material(path, 0, args.encoding, image_paths=explicit_images)
    for item in manifest_items:
        yield from _manifest_material(item, Path(args.manifest).resolve().parent, args.encoding)


class _StdinSource:
    def __init__(self, stream: BinaryIO, name: str):
        self.stream = stream
        self.name = name


def _files_from(value: str, nul: bool) -> Iterator[str]:
    stream = sys.stdin.buffer if value == "-" else Path(value).open("rb")
    try:
        if nul:
            buffer = b""
            first = True
            while chunk := stream.read(65536):
                buffer += chunk
                parts = buffer.split(b"\0")
                buffer = parts.pop()
                for part in parts:
                    if part:
                        yield _decode_path(part, value, strip_bom=first)
                        first = False
            if buffer:
                yield _decode_path(buffer, value, strip_bom=first)
        else:
            for number, line in enumerate(stream):
                decoded = _decode_path(line.rstrip(b"\r\n"), value, strip_bom=number == 0)
                if decoded.strip() and not decoded.lstrip().startswith("#"):
                    yield decoded.strip()
    except OSError as exc:
        raise DqaError(65, f"Не удалось прочитать --files-from {value}: {exc}") from exc
    finally:
        if value != "-":
            stream.close()


def _decode_path(value: bytes, source: str, *, strip_bom: bool) -> str:
    try:
        return value.decode("utf-8-sig" if strip_bom else "utf-8")
    except UnicodeDecodeError as exc:
        raise DqaError(65, f"--files-from {source}: пути должны быть UTF-8: {exc}") from exc


def _read_manifest(value: str) -> list[dict[str, Any]]:
    try:
        data = json.loads(Path(value).read_bytes().decode("utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise DqaError(65, f"Не удалось прочитать --manifest {value}: {exc}") from exc
    if not isinstance(data, list):
        raise DqaError(65, "--manifest должен содержать JSON-массив.")
    for index, item in enumerate(data):
        if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not item["path"]:
            raise DqaError(65, f"manifest[{index}]: нужен непустой path.")
        if set(item) - {"path", "name", "images"} or not isinstance(item.get("images", []), list) or any(not isinstance(p, str) or not p for p in item.get("images", [])):
            raise DqaError(65, f"manifest[{index}]: допустимы path, name и images (список путей).")
    return data


def _manifest_material(item: dict[str, Any], parent: Path, encoding: str) -> Iterator[Material | SkippedRecord]:
    path = _resolve(parent, item["path"])
    if not path.exists():
        raise DqaError(66, f"Входной путь из manifest не существует: {path}")
    images = [str(_resolve(parent, image)) for image in item.get("images", [])]
    material = _file_material(path, 0, encoding, image_paths=images, name=item.get("name"))
    yield material


def _resolve(parent: Path, value: str) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else parent / path


def _stdin_material(source: _StdinSource, source_index: int, images: list[str], encoding: str) -> Material | SkippedRecord:
    try:
        raw = source.stream.read()
    except OSError as exc:
        return SkippedRecord(source_index, "unreadable", name=source.name)
    return _text_material(raw, None, source.name, source_index, encoding, images)


def _file_material(path: Path, source_index: int, encoding: str, *, image_paths: list[str] | None = None,
                   name: str | None = None) -> Material | SkippedRecord:
    extension = path.suffix.lower()
    display_name = name or path.name
    if extension in {".heic", ".heif"}:
        return SkippedRecord(source_index, "unsupported", str(path), display_name,
                             {"type": "image", "images": []},
                             message="HEIC/HEIF не поддерживается. Конвертируйте изображение в JPEG.")
    if extension not in TEXT_EXTENSIONS | IMAGE_EXTENSIONS:
        return SkippedRecord(source_index, "unsupported", str(path), display_name,
                             {"type": "unsupported", "images": []},
                             message="Неизвестное расширение; допустимы .txt/.md/.json и PNG/JPEG/WebP/GIF.")
    try:
        raw = path.read_bytes()
    except OSError:
        return SkippedRecord(source_index, "unreadable", str(path), display_name)
    if extension in IMAGE_EXTENSIONS:
        if image_paths:
            raise DqaError(64, "--image нельзя добавлять к позиционному image-материалу; используйте manifest.")
        return _image_material(path, display_name, source_index, None, raw=raw)
    return _text_material(raw, path, display_name, source_index, encoding, image_paths or [])


def _text_material(raw: bytes, path: Path | None, name: str, source_index: int,
                   encoding: str, image_paths: list[str]) -> Material | SkippedRecord:
    digest = raw_content_sha256(raw)
    try:
        text = raw.decode("utf-8-sig" if encoding == "utf-8" else encoding)
    except (UnicodeDecodeError, LookupError):
        return SkippedRecord(source_index, "encoding", str(path) if path else None, name,
                             content_sha256=digest,
                             message="Текст не соответствует выбранной кодировке; для Windows-файлов попробуйте --encoding cp1251.")
    input_value: str | dict | list = text
    if path is not None and path.suffix.lower() == ".json":
        try:
            parsed = json.loads(text)
            if isinstance(parsed, (dict, list)):
                input_value = parsed
        except json.JSONDecodeError:
            pass
    try:
        images = _load_images(image_paths)
    except _ImageReadError:
        return SkippedRecord(source_index, "unreadable", str(path) if path else None, name,
                             content_sha256=digest)
    if not images and ((isinstance(input_value, str) and not input_value.strip()) or not input_value):
        return SkippedRecord(source_index, "empty", str(path) if path else None, name,
                             content_sha256=digest)
    composite = composite_content_sha256(raw, [image.raw() for image in images])
    for image in images:
        image.release_raw()
    kind = "text+images" if images else "text"
    retained_input = None if path is not None else input_value
    recorded_encoding = ("utf-8-sig" if encoding == "utf-8" else encoding) if path is not None else None
    return Material(source_index, -1, retained_input, images, composite,
                    str(path) if path else None, name, kind, encoding=recorded_encoding)


def _image_material(path: Path | None, name: str, source_index: int,
                    image_paths: list[str] | None, *, raw: bytes | None = None) -> Material | SkippedRecord:
    if raw is not None:
        image = _attachment_from_bytes(name, path, raw)
        images = [image]
    else:
        try:
            images = _load_images(image_paths or [])
        except _ImageReadError:
            return SkippedRecord(source_index, "unreadable", str(path) if path else None, name,
                                 {"type": "image", "images": []})
    if not images:
        return SkippedRecord(source_index, "empty", str(path) if path else None, name,
                             {"type": "image", "images": []})
    composite = composite_content_sha256(None, [image.raw() for image in images])
    for image in images:
        image.release_raw()
    return Material(source_index, -1, f"Изображение: {name}", images, composite,
                    str(path) if path else None, name, "image")


class _ImageReadError(Exception):
    pass


def _load_images(paths: Iterable[str]) -> list[ImageAttachment]:
    result: list[ImageAttachment] = []
    seen: set[str] = set()
    for value in paths:
        path = Path(value).expanduser()
        extension = path.suffix.lower()
        if extension in {".heic", ".heif"}:
            raise DqaError(65, f"HEIC/HEIF не поддерживается: {path}. Конвертируйте изображение в JPEG.")
        if extension not in IMAGE_EXTENSIONS:
            raise DqaError(65, f"Неподдерживаемое изображение {path}. Допустимы PNG, JPEG, WebP и GIF.")
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise _ImageReadError(str(exc)) from exc
        image = _attachment_from_bytes(path.name, path, raw)
        if image.sha256 not in seen:
            seen.add(image.sha256)
            result.append(image)
    return result


def _attachment_from_bytes(name: str, path: Path | None, raw: bytes) -> ImageAttachment:
    return ImageAttachment(name, path, raw_content_sha256(raw), 4 * ((len(raw) + 2) // 3), raw)


def _directory_materials(root: Path, pattern: str, recursive: bool,
                         encoding: str) -> Iterator[Material | SkippedRecord | tuple[str, dict[str, Any]]]:
    if recursive:
        for directory, dirnames, filenames in os.walk(root):
            dirnames.sort()
            filenames.sort()
            current = Path(directory)
            relative = current.relative_to(root)
            selected = [name for name in filenames if _glob_match(str(relative / name) if str(relative) != "." else name, pattern)]
            yield from _directory_group(current, selected, encoding)
    else:
        try:
            names = sorted(entry.name for entry in os.scandir(root) if entry.is_file() and fnmatch.fnmatchcase(entry.name, pattern))
        except OSError as exc:
            raise DqaError(66, f"Не удалось перечислить каталог {root}: {exc}") from exc
        yield from _directory_group(root, names, encoding)


def _glob_match(relative: str, pattern: str) -> bool:
    if pattern == "**/*":
        return True
    return fnmatch.fnmatchcase(relative, pattern) or ("/" not in pattern and fnmatch.fnmatchcase(Path(relative).name, pattern))


def _directory_group(directory: Path, names: list[str], encoding: str) -> Iterator[Material | SkippedRecord | tuple[str, dict[str, Any]]]:
    texts = [name for name in names if Path(name).suffix.lower() in TEXT_EXTENSIONS]
    images = [name for name in names if Path(name).suffix.lower() in IMAGE_EXTENSIONS]
    others = [name for name in names if name not in texts and name not in images]
    bases = {name: unicodedata.normalize("NFC", Path(name).stem) for name in texts}
    attachments: dict[str, list[str]] = {name: [] for name in texts}
    orphans: list[str] = []
    for image in images:
        normalized = unicodedata.normalize("NFC", Path(image).stem)
        candidates = [text for text in texts if normalized == bases[text] or normalized.startswith(bases[text] + "_")]
        if len(candidates) > 1:
            raise DqaError(65, f"Файл {directory / image} подпадает под две группы: {', '.join(candidates)}. Переименуйте файл или задайте --manifest.")
        if candidates:
            attachments[candidates[0]].append(image)
        else:
            orphans.append(image)
    for text in texts:
        ordered = sorted(attachments[text])
        yield _file_material(directory / text, 0, encoding, image_paths=[str(directory / image) for image in ordered])
    for image in orphans:
        warning = {
            "code": "orphan_image", "path": str(directory / image),
            "message": "Изображение не подошло ни к одному тексту и станет отдельным материалом.",
        }
        folded = unicodedata.normalize("NFC", Path(image).stem).casefold()
        if any(unicodedata.normalize("NFC", base).casefold() == folded or folded.startswith(unicodedata.normalize("NFC", base).casefold() + "_") for base in bases.values()):
            warning["message"] += " Похожая база отличается регистром; сопоставление регистрозависимое."
        yield "warning", warning
        yield _file_material(directory / image, 0, encoding)
    for name in others:
        yield _file_material(directory / name, 0, encoding)


def _deduplicate(records: list[Material | SkippedRecord]) -> list[Material | SkippedRecord]:
    seen: dict[str, Material] = {}
    result: list[Material | SkippedRecord] = []
    for record in records:
        if not isinstance(record, Material):
            result.append(record)
            continue
        original = seen.get(record.content_sha256)
        if original is None:
            seen[record.content_sha256] = record
            result.append(record)
            continue
        result.append(SkippedRecord(
            record.source_index, "duplicate", record.path, record.name,
            record.material(), record.content_sha256,
            original.path or original.name or str(original.source_index),
        ))
    return result


def _check_image_limits(materials: list[Material], capabilities: dict[str, Any], warnings: list[dict[str, Any]]) -> None:
    errors: list[str] = []
    for material in materials:
        if len(material.images) > capabilities["max_images"]:
            errors.append(f"{material.path or material.name}: {len(material.images)} изображений, лимит {capabilities['max_images']}; используйте --manifest для явной пере группировки.")
        size = sum(image.b64_chars for image in material.images)
        if size > capabilities["max_images_b64_chars"]:
            errors.append(f"{material.path or material.name}: base64 изображений {size} символов, лимит {capabilities['max_images_b64_chars']}.")
        if len(material.images) >= 4:
            warnings.append({"code": "web_image_limit", "path": material.path, "message": "Материал с 4+ изображениями не откроется в текущем веб-интерфейсе (лимит 3)."})
    if errors:
        raise DqaError(65, "\n".join(errors))


def processed_counts(plan: InputPlan, filename: str, effective_fingerprint: str) -> dict[str, Any]:
    keys: set[str] = set()
    path = Path(filename)
    try:
        if path.exists():
            with path.open("r", encoding="utf-8") as stream:
                for number, line in enumerate(stream, 1):
                    if not line.strip():
                        continue
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise DqaError(65, f"{filename}:{number}: невалидный NDJSON: {exc}") from exc
                    if not isinstance(item, dict):
                        raise DqaError(65, f"{filename}:{number}: ожидался JSON-объект.")
                    if isinstance(item.get("key"), str):
                        keys.add(item["key"])
                    if isinstance(item.get("content_sha256"), str) and isinstance(item.get("fingerprint"), str):
                        keys.add(_processed_key(item["content_sha256"], item["fingerprint"]))
    except (OSError, UnicodeError) as exc:
        raise DqaError(65, f"Не удалось прочитать --skip-processed {filename}: {exc}") from exc
    already = sum(_processed_key(material.content_sha256, effective_fingerprint) in keys for material in plan.materials)
    return {"path": filename, "new": len(plan.materials) - already, "already_processed": already}


def _processed_key(content_sha256: str, fingerprint: str) -> str:
    return hashlib.sha256(canonical_bytes({"content_sha256": content_sha256, "effective_fingerprint": fingerprint})).hexdigest()
