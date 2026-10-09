"""Pydantic-модели запросов приложения «Вердикт»."""

from __future__ import annotations

import base64
import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

MAX_IMAGES = 8
MAX_IMAGES_B64_CHARS = 20 * 1024 * 1024  # суммарный base64-объём ~20 МБ
_DATA_URL_RE = re.compile(r"^data:image/(?:png|jpe?g|webp|gif);base64,(.*)$", re.DOTALL)


class ChoiceOption(BaseModel):
    name: str
    description: str | None = None

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Имя опции не может быть пустым")
        if "\n" in v or "\r" in v:
            raise ValueError("Имя опции не должно содержать переводов строк")
        return v


class Question(BaseModel):
    id: str
    question: str = ""
    type: str
    # yes_no
    yes: str | None = None
    no: str | None = None
    # choice
    options: list[ChoiceOption] | None = None
    # score
    levels: list[str] | None = None

    @field_validator("id")
    @classmethod
    def id_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("id вопроса не может быть пустым")
        return v

    @model_validator(mode="after")
    def check_type_fields(self) -> "Question":
        if self.type == "yes_no":
            pass
        elif self.type == "choice":
            if not self.options or not (2 <= len(self.options) <= 26):
                raise ValueError("Вопрос типа choice должен содержать от 2 до 26 опций")
            seen: set[str] = set()
            for opt in self.options:
                key = opt.name.strip().casefold()
                if key in seen:
                    raise ValueError(f"Дублирующееся имя опции: {opt.name!r}")
                seen.add(key)
        elif self.type == "score":
            if not self.levels or not (2 <= len(self.levels) <= 10):
                raise ValueError("Вопрос типа score должен содержать от 2 до 10 уровней")
        else:
            raise ValueError(f"Неизвестный тип вопроса: {self.type!r}")
        return self


class DecideRequest(BaseModel):
    input: str | dict | list
    temperature: float | None = Field(default=None, gt=0)
    prompt_format_version: int | None = None
    return_prompt_token_ids: bool | None = None
    mode: Literal["decisions", "fast_batch"] = "decisions"
    questions: list[Question]
    models: list[str]
    # Изображения для vision-моделей: data URL (data:image/...;base64,...) или чистый base64
    images: list[str] | None = None

    @model_validator(mode="after")
    def check_questions(self) -> "DecideRequest":
        if not self.images:
            # Пустой input допустим только с изображениями (вопросы по картинке).
            if isinstance(self.input, str):
                if not self.input.strip():
                    raise ValueError("Текст материала (input) не может быть пустым")
            elif not self.input:
                raise ValueError("Материал (input) не может быть пустым")
        if not self.questions:
            raise ValueError("Нужен хотя бы один вопрос")
        ids = [q.id for q in self.questions]
        if len(ids) != len(set(ids)):
            raise ValueError("id вопросов должны быть уникальными")
        if not self.models:
            raise ValueError("Нужна хотя бы одна модель (models)")
        return self

    @field_validator("images")
    @classmethod
    def images_valid(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return v
        if len(v) > MAX_IMAGES:
            raise ValueError(f"Не больше {MAX_IMAGES} изображений за прогон")
        total = 0
        for img in v:
            if not isinstance(img, str) or not img:
                raise ValueError("Изображение должно быть строкой: data URL (data:image/...;base64,...) или base64")
            m = _DATA_URL_RE.match(img)
            if m is None and img.startswith("data:"):
                raise ValueError(
                    "Неподдерживаемый формат изображения — нужны data:image/png|jpeg|webp|gif. "
                    "HEIC и другие форматы сконвертируйте в JPEG")
            b64 = m.group(1) if m else img
            try:
                base64.b64decode(b64, validate=True)
            except Exception:
                raise ValueError(
                    "Изображение должно быть data URL (data:image/...;base64,...) или валидным base64")
            total += len(b64)
        if total > MAX_IMAGES_B64_CHARS:
            raise ValueError("Суммарный объём изображений больше 20 МБ")
        return v


def build_sglang_payload(req: DecideRequest) -> dict:
    """Общая часть payload для всех моделей (без поля models)."""
    payload: dict = {"input": req.input}
    if req.temperature is not None:
        payload["temperature"] = req.temperature
    if req.prompt_format_version is not None:
        payload["prompt_format_version"] = req.prompt_format_version
    if req.return_prompt_token_ids is not None:
        payload["return_prompt_token_ids"] = req.return_prompt_token_ids
    payload["questions"] = [q.model_dump(exclude_none=True) for q in req.questions]
    return payload
