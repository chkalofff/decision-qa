"""Deterministic content, material and run fingerprints for CLI and web."""

from __future__ import annotations

import base64
import binascii
import copy
import hashlib
from collections.abc import Iterable, Mapping
from typing import Any

from .config_pack import canonical_bytes


def raw_content_sha256(content: bytes | bytearray | memoryview | str | dict | list) -> str:
    """Hash raw bytes/text; dict/list inputs use their RFC 8785 bytes."""
    if isinstance(content, (bytes, bytearray, memoryview)):
        data = bytes(content)
    elif isinstance(content, str):
        data = content.encode("utf-8")
    elif isinstance(content, (dict, list)):
        data = canonical_bytes(content)
    else:
        raise TypeError("content must be bytes, text, a dict or a list")
    return hashlib.sha256(data).hexdigest()


def _image_bytes(image: Any) -> bytes:
    if isinstance(image, (bytes, bytearray, memoryview)):
        return bytes(image)
    if isinstance(image, str):
        encoded = image.split(",", 1)[1] if image.startswith("data:") and "," in image else image
        try:
            return base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("image string must be base64 or a base64 data URL") from exc
    raise TypeError("image payload must be bytes or a base64 string")


def _image_parts(image: Any, index: int) -> tuple[bytes, dict]:
    if isinstance(image, Mapping):
        metadata = copy.deepcopy(dict(image.get("metadata") or {}))
        payload_keys = {"bytes", "data", "dataUrl", "data_url", "base64", "metadata"}
        for key, value in image.items():
            if key not in payload_keys:
                metadata[key] = copy.deepcopy(value)
        payload = next((image[key] for key in ("bytes", "data", "dataUrl", "data_url", "base64") if key in image), None)
        if payload is None:
            raise ValueError(f"images[{index}] has no raw payload")
        return _image_bytes(payload), metadata
    return _image_bytes(image), {}


def composite_content_sha256(content: bytes | bytearray | memoryview | str | dict | list | None,
                             images: Iterable[Any] = ()) -> str:
    """Return rename-stable SHA-256(concatenated raw content/image digests).

    Metadata and image names are deliberately excluded. Image order is retained;
    an image-only material has no synthetic text digest in the concatenation.
    """
    digest = hashlib.sha256()
    if content is not None:
        digest.update(bytes.fromhex(raw_content_sha256(content)))
    for index, image in enumerate(images):
        payload, _ = _image_parts(image, index)
        digest.update(bytes.fromhex(raw_content_sha256(payload)))
    return digest.hexdigest()


def material_hash(content: bytes | bytearray | memoryview | str | dict | list | None,
                  images: Iterable[Any] = (), metadata: Mapping[str, Any] | None = None) -> str:
    """Hash content, ordered raw images and JSON metadata via an explicit JCS projection.

    Names/paths belong in metadata, not in ``raw_content_sha256``. Image order is
    retained. The returned value has a ``sha256:`` prefix; raw content hashes do not.
    """
    projected_images = []
    for index, image in enumerate(images):
        payload, image_metadata = _image_parts(image, index)
        projected_images.append({
            "sha256": raw_content_sha256(payload),
            "metadata": image_metadata,
        })
    projection = {
        "content_sha256": None if content is None else raw_content_sha256(content),
        "images": projected_images,
        "metadata": copy.deepcopy(dict(metadata or {})),
    }
    return "sha256:" + hashlib.sha256(canonical_bytes(projection)).hexdigest()


def materials_fingerprint(material_hashes: Iterable[str]) -> str:
    """Hash the ordered material-hash array; no sorting or deduplication occurs."""
    hashes = list(material_hashes)
    if any(not isinstance(value, str) for value in hashes):
        raise TypeError("material hashes must be strings")
    return "sha256:" + hashlib.sha256(canonical_bytes(hashes)).hexdigest()


def run_fingerprint(config_fingerprint: str, materials_fingerprint_value: str) -> str:
    """Return SHA-256(JCS({config_fingerprint, materials_fingerprint}))."""
    if not isinstance(config_fingerprint, str) or not isinstance(materials_fingerprint_value, str):
        raise TypeError("config and materials fingerprints must be strings")
    projection = {
        "config_fingerprint": config_fingerprint,
        "materials_fingerprint": materials_fingerprint_value,
    }
    return "sha256:" + hashlib.sha256(canonical_bytes(projection)).hexdigest()
