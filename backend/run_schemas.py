"""Request contracts and coordinated limits for temporary server runs."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from backend.schemas import MAX_IMAGES, MAX_IMAGES_B64_CHARS
from dqa_common import AGGREGATION_POLICY, FINGERPRINT_VERSION, PACK_VERSION


@dataclass(frozen=True)
class RunLimits:
    default_threads: int = 2
    max_threads: int = 8
    max_concurrent_jobs: int = 4
    max_inflight_materials: int = 4
    max_files_per_chunk: int = 50
    max_files_per_job: int = 100_000
    max_chunk_bytes: int = 24 * 1024 * 1024
    max_images: int = MAX_IMAGES
    max_image_b64_chars: int = MAX_IMAGES_B64_CHARS
    default_page_limit: int = 50
    max_page_limit: int = 200
    job_ttl_s: float = 3600.0
    job_deadline_s: float = 3600.0
    heartbeat_s: float = 15.0

    @classmethod
    def from_env(cls) -> "RunLimits":
        defaults = cls()
        values = {}
        for name in cls.__dataclass_fields__:
            raw = os.environ.get(f"DQA_RUN_{name.upper()}")
            if raw is not None:
                values[name] = float(raw) if name.endswith("_s") else int(raw)
        limits = cls(**values)
        if limits.max_chunk_bytes < 1024 * 1024:
            raise ValueError("DQA_RUN_MAX_CHUNK_BYTES must fit at least a small image material")
        if limits.max_image_b64_chars >= limits.max_chunk_bytes:
            raise ValueError("DQA_RUN_MAX_CHUNK_BYTES must exceed DQA_RUN_MAX_IMAGE_B64_CHARS")
        for name in (
            "default_threads", "max_threads", "max_concurrent_jobs",
            "max_inflight_materials", "max_files_per_chunk", "max_files_per_job",
            "default_page_limit", "max_page_limit",
        ):
            if getattr(limits, name) < 1:
                raise ValueError(f"DQA_RUN_{name.upper()} must be positive")
        if limits.default_threads > limits.max_threads:
            raise ValueError("default_threads cannot exceed max_threads")
        if limits.default_page_limit > limits.max_page_limit:
            raise ValueError("default_page_limit cannot exceed max_page_limit")
        if limits.job_ttl_s <= 0 or limits.job_deadline_s <= 0 or limits.heartbeat_s <= 0:
            raise ValueError("run TTL, deadline and heartbeat must be positive")
        if limits.max_chunk_bytes < defaults.max_image_b64_chars + 64 * 1024:
            raise ValueError("max_chunk_bytes must fit one maximum-size image material")
        return limits

    def capabilities(self) -> dict:
        return {
            "schema": 1,
            "min_schema": 1,
            "max_schema": 1,
            "pack_version": PACK_VERSION,
            "fingerprint_version": FINGERPRINT_VERSION,
            "aggregation": AGGREGATION_POLICY,
            "default_threads": self.default_threads,
            "max_threads": self.max_threads,
            "max_concurrent_jobs": self.max_concurrent_jobs,
            "max_inflight_materials": self.max_inflight_materials,
            "default_files_per_chunk": self.max_files_per_chunk,
            "max_files_per_chunk": self.max_files_per_chunk,
            "max_files_per_job": self.max_files_per_job,
            "max_chunk_bytes": self.max_chunk_bytes,
            "max_images": self.max_images,
            "max_images_b64_chars": self.max_image_b64_chars,
            "default_page_limit": self.default_page_limit,
            "max_page_limit": self.max_page_limit,
            "job_ttl_s": self.job_ttl_s,
            "job_deadline_s": self.job_deadline_s,
            "features": {"after_seq": True, "cancel": True, "gzip": True},
            "modes": ["decisions", "fast_batch", "both"],
        }


class RunOverrides(BaseModel):
    models: list[str] | None = None
    mode: Literal["decisions", "fast_batch", "both"] | None = None


class RunCreateRequest(BaseModel):
    pack: dict[str, Any]
    overrides: RunOverrides = Field(default_factory=RunOverrides)
    threads: int | None = Field(default=None, ge=1)
    material_count: int = Field(ge=1)
    materials_fingerprint: str = Field(min_length=1, max_length=128)


class RunFileInput(BaseModel):
    i: int = Field(ge=0)
    path: str | None = Field(default=None, max_length=4096)
    name: str | None = Field(default=None, max_length=1024)
    input: Any
    images: list[str] | None = None
    material: dict[str, Any] | None = None
    content_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")

    @field_validator("images")
    @classmethod
    def image_strings(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and any(not isinstance(item, str) or not item for item in value):
            raise ValueError("images must contain nonempty base64/data URL strings")
        return value


class RunChunkRequest(BaseModel):
    chunk_index: int = Field(ge=0)
    files: list[RunFileInput] = Field(min_length=1)


class RunAPIError(Exception):
    def __init__(self, status_code: int, detail: str, *, headers: dict[str, str] | None = None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.headers = headers or {}
