"""Агентный цикл ассистента.

Локальные chat-модели (SGLang MLX, bonsai) раздают /v1/chat/completions без
tool-парсера: Qwen отдаёт вызовы инструментов hermes-разметкой прямо в
content — парсим сами. Облачные (run_remote_agent) — нативный OpenAI tool
calling (message.tool_calls), с фолбэком на hermes-разметку в content.
Стриминг ответа проксируем наружу с отложенным буфером: текст, который может
оказаться началом <tool_call> или thinking-блока, на клиент не уходит.
"""
from __future__ import annotations

import json
import re
import uuid
from collections.abc import AsyncGenerator

import httpx

from backend.assistant.prompts import (HERMES_FORMAT_HINT, SYSTEM_PROMPT,
                                       serialize_snapshot)
from backend.assistant.tools import (PROPOSAL_TOOLS, TOOLS, validate_args)

MAX_STEPS = 6
MAX_HISTORY = 20
TOOL_CALL_RE = re.compile(
    r"<tool_call>\s*<function=(\w+)>\s*(.*?)</function>\s*</tool_call>", re.S)
PARAM_RE = re.compile(r"<parameter=(\w+)>\s*(.*?)</parameter>", re.S)
LEGACY_CALL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.S)

_PROPOSAL_TITLES = {
    "propose_questions": "Набор вопросов",
    "propose_context": "Контекст",
    "propose_run": "Запуск прогона",
    "propose_save_preset": "Сохранить пресет",
}


def parse_tool_calls(content: str) -> list[tuple[str, dict, str]]:
    """Hermes-разметка Qwen → [(имя, аргументы, сырой_кусок)]. Остаток — текст."""
    calls = []
    for name, body in TOOL_CALL_RE.findall(content):
        args: dict = {}
        for pname, pval in PARAM_RE.findall(body):
            pval = pval.strip()
            try:
                args[pname] = json.loads(pval)
            except json.JSONDecodeError:
                args[pname] = pval
        calls.append((name, args, ""))
    if calls:
        return calls
    for raw in LEGACY_CALL_RE.findall(content):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        name = data.get("name", "")
        args = data.get("arguments") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {}
        if name:
            calls.append((name, args, ""))
    return calls


def strip_tool_markup(content: str) -> str:
    """Текст ответа без tool_call-разметки."""
    text = TOOL_CALL_RE.sub("", content)
    text = LEGACY_CALL_RE.sub("", text)
    return text.strip()


def split_thinking(content: str) -> tuple[str, str]:
    """(thinking, answer): SGLang без reasoning-парсера кладёт рассуждение
    в content, отделяя маркером </think>."""
    if "</think>" in content:
        think, _, answer = content.partition("</think>")
        return think.strip(), answer.strip()
    return "", content


async def run_remote_agent(
    history: list[dict],
    user_message: str,
    snapshot: dict | None,
    entry,
    read_tools: dict | None = None,
    action_tools: dict | None = None,
) -> AsyncGenerator[str, None]:
    """Ассистент на облачной chat-модели (remote_llm): полный агентный цикл
    с нативным OpenAI tool calling (tools + message.tool_calls). Стриминг
    включён всегда: tool_calls приходят в дельтах. Фолбэк: если провайдер не
    разобрал вызовы и модель выдала hermes-разметку в content — парсим её.
    События — тем же SSE-протоколом, что и run_agent."""
    from backend import remote_llm  # локально: избегаем цикла импортов

    def ev(payload: dict) -> str:
        return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"

    base = remote_llm.chat_base_url(entry.api, entry.base_url)
    key = remote_llm.api_key(entry.api, entry.key)
    if base is None:
        yield ev({"type": "error", "message": f"Неизвестный chat API: {entry.api!r}"})
        return
    if key is None:
        yield ev({"type": "error",
                  "message": f"Нет API-ключа для «{entry.label}»."})
        return
    url = f"{base}/chat/completions"
    headers = {"Authorization": f"Bearer {key}"}
    read_tools = read_tools or {}

    messages = [{"role": "system",
                 "content": SYSTEM_PROMPT + serialize_snapshot(snapshot)}]
    messages.extend(history[-MAX_HISTORY:])
    messages.append({"role": "user", "content": user_message})

    try:
        async with httpx.AsyncClient(
                timeout=httpx.Timeout(300.0, connect=10.0)) as client:
            for _step in range(MAX_STEPS):
                payload = {
                    "model": entry.api_model or entry.key,
                    "messages": messages,
                    "tools": TOOLS,
                    "temperature": 0.3,
                    "max_tokens": 2048,
                    "stream": True,
                }
                filt = _StreamFilter(False)
                full = ""
                # native tool_calls из дельт: index → {id, name, arguments}
                tc_acc: dict[int, dict] = {}
                async with client.stream("POST", url, json=payload,
                                         headers=headers) as resp:
                    if resp.status_code != 200:
                        body = (await resp.aread()).decode("utf-8", "replace")[:500]
                        yield ev({"type": "error",
                                  "message": f"API ответил {resp.status_code}: {body}"})
                        return
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                            delta = chunk["choices"][0].get("delta") or {}
                        except (json.JSONDecodeError, KeyError, IndexError):
                            continue
                        reasoning = delta.get("reasoning") or ""
                        if reasoning:
                            yield ev({"type": "thinking", "text": reasoning})
                        piece = delta.get("content") or ""
                        if piece:
                            full += piece
                            for kind, text in filt.feed(piece):
                                yield ev({"type": kind, "text": text})
                        for tc in delta.get("tool_calls") or []:
                            slot = tc_acc.setdefault(tc.get("index", 0),
                                                     {"id": None, "name": "",
                                                      "arguments": ""})
                            if tc.get("id"):
                                slot["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] += fn["name"]
                            if fn.get("arguments"):
                                slot["arguments"] += fn["arguments"]

                calls: list[tuple[str, dict, str]] = []
                tc_list = [tc_acc[i] for i in sorted(tc_acc)]
                if tc_list:
                    # native tool calling
                    for slot in tc_list:
                        try:
                            args = json.loads(slot["arguments"] or "{}")
                        except json.JSONDecodeError:
                            args = {}
                        calls.append((slot["name"], args, slot["arguments"]))
                else:
                    # фолбэк: провайдер не разобрал tools, модель выдала hermes
                    calls = parse_tool_calls(full)

                if not calls:
                    answer = strip_tool_markup(full) or full
                    _, answer = split_thinking(answer)
                    if filt.mode != "text" and answer and not filt.emitted:
                        yield ev({"type": "token", "text": answer})
                    yield ev({"type": "done"})
                    return

                # шаг с инструментами
                if tc_list:
                    messages.append({
                        "role": "assistant",
                        "content": strip_tool_markup(full) or None,
                        "tool_calls": [
                            {"id": slot["id"] or f"call_{i}",
                             "type": "function",
                             "function": {"name": slot["name"],
                                          "arguments": slot["arguments"]}}
                            for i, slot in enumerate(tc_list)],
                    })
                else:
                    messages.append({"role": "assistant", "content": full})
                for i, (name, args, raw_args) in enumerate(calls):
                    result, events = await _exec_tool(name, args, read_tools,
                                                      action_tools)
                    for payload in events:
                        yield ev(payload)
                    tool_msg = {"role": "tool", "name": name,
                                "content": json.dumps(result, ensure_ascii=False,
                                                      default=str)[:8000]}
                    if tc_list:
                        tool_msg["tool_call_id"] = tc_list[i]["id"] or f"call_{i}"
                    messages.append(tool_msg)
            yield ev({"type": "error",
                      "message": "Превышен лимит шагов агента (6). Попробуйте переформулировать."})
    except httpx.ConnectError:
        yield ev({"type": "error",
                  "message": f"API недоступен ({base}): нет соединения."})
    except httpx.ReadTimeout:
        yield ev({"type": "error",
                  "message": "Модель не ответила за 5 минут (таймаут)."})


async def _exec_tool(name: str, args, read_tools: dict,
                     action_tools: dict | None) -> tuple[dict, list[dict]]:
    """Исполнение одного вызова: валидация → proposal/action/read.
    → (результат для tool-сообщения, SSE-события для клиента)."""
    args, error = validate_args(name, args)
    if error:
        return {"ok": False, "error": error}, [
            {"type": "tool", "name": name, "status": "error", "message": error}]
    if name in PROPOSAL_TOOLS:
        proposal = {
            "id": uuid.uuid4().hex[:8],
            "kind": name,
            "title": _PROPOSAL_TITLES.get(name, name),
            "payload": args,
        }
        return {"ok": True, "note": "Предложение показано пользователю "
                                    "и ждёт подтверждения. Не называй "
                                    "его применённым."}, [
            {"type": "proposal", "proposal": proposal}]
    if action_tools and name in action_tools:
        events = [{"type": "tool", "name": name, "status": "start"}]
        try:
            result, extra_events = await action_tools[name](args)
        except Exception as e:  # noqa: BLE001 — отдаём модели как есть
            result, extra_events = {"ok": False, "error": str(e)}, []
        events += extra_events
        events.append({"type": "tool", "name": name,
                       "status": "done" if result.get("ok") else "error",
                       "message": None if result.get("ok")
                                  else result.get("error")})
        return result, events
    events = [{"type": "tool", "name": name, "status": "start"}]
    try:
        result = await read_tools[name]()
    except Exception as e:  # noqa: BLE001 — отдаём модели как есть
        result = {"ok": False, "error": str(e)}
    events.append({"type": "tool", "name": name, "status": "done"})
    return result, events


class _StreamFilter:
    """Отложенный буфер стрима: решает, что из content — текст для клиента,
    а что — thinking или начало tool_call (наружу не отдаём)."""

    _TOOL_PREFIX = "<tool_call>"
    _THINK_END = "</think>"

    def __init__(self, thinking: bool):
        self.buf = ""
        self.mode = "pending"  # pending → text | toolcall | (thinking → pending)
        self.thinking_expected = thinking
        self.emitted = False  # клиенту уже ушёл хоть один token

    def feed(self, chunk: str) -> list[tuple[str, str]]:
        """Возвращает события [(type, text)]: token | thinking."""
        self.buf += chunk
        out: list[tuple[str, str]] = []
        while True:
            if self.mode == "text":
                idx = self.buf.find(self._TOOL_PREFIX)
                if idx >= 0:  # tool_call в середине текста — текст до него отдаём
                    if idx:
                        out.append(("token", self.buf[:idx]))
                    self.buf = self.buf[idx:]
                    self.mode = "toolcall"
                    continue
                # хвост, совпадающий с началом "<tool_call>", удерживаем в буфере
                hold = 0
                for n in range(min(len(self.buf), len(self._TOOL_PREFIX) - 1), 0, -1):
                    if self._TOOL_PREFIX.startswith(self.buf[-n:]):
                        hold = n
                        break
                emit = self.buf if not hold else self.buf[:-hold]
                self.buf = self.buf[-hold:] if hold else ""
                if emit:
                    out.append(("token", emit))
                self.emitted = self.emitted or any(k == "token" for k, _ in out)
                return out
            if self.mode == "toolcall":
                if "</tool_call>" in self.buf:
                    return out  # остаток доберётся в finish()
                return out
            if self.mode == "thinking":
                if self._THINK_END in self.buf:
                    think, _, rest = self.buf.partition(self._THINK_END)
                    if think.strip():
                        out.append(("thinking", think))
                    self.buf = rest
                    self.thinking_expected = False  # thinking-блок один за ответ
                    self.mode = "pending"
                    continue
                if len(self.buf) > 80:  # стримим рассуждение кусками
                    out.append(("thinking", self.buf[:80]))
                    self.buf = self.buf[80:]
                return out
            # mode == pending
            stripped = self.buf.lstrip()
            if not stripped:
                return out  # пустые чанки не должны решать режим
            if self.thinking_expected and not stripped.startswith("<"):
                self.mode = "thinking"
                continue
            if stripped.startswith(self._TOOL_PREFIX):
                self.mode = "toolcall"
                return out
            if self._TOOL_PREFIX.startswith(stripped):
                return out  # ещё может стать tool_call — ждём
            self.mode = "text"
        return out


async def run_agent(
    history: list[dict],
    user_message: str,
    snapshot: dict | None,
    chat_url: str,
    thinking: bool,
    read_tools: dict,
    action_tools: dict | None = None,
) -> AsyncGenerator[str, None]:
    """SSE-события (строки data: {...}). read_tools: {name: async callable()}.
    action_tools: {name: async callable(args) -> (result, extra_sse_events)} —
    авто-исполняемые на сервере инструменты (run_trial)."""

    def ev(payload: dict) -> str:
        return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"

    messages = [{"role": "system",
                 "content": SYSTEM_PROMPT
                            + HERMES_FORMAT_HINT
                            + serialize_snapshot(snapshot)}]
    messages.extend(history[-MAX_HISTORY:])
    messages.append({"role": "user", "content": user_message})

    max_tokens = 2048
    context_retried = False

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=10.0)) as client:
            for _step in range(MAX_STEPS):
                payload = {
                    "model": "assistant",
                    "messages": messages,
                    "temperature": 0.3,
                    "max_tokens": max_tokens,
                    "stream": True,
                    "chat_template_kwargs": {"enable_thinking": thinking},
                }
                payload["tools"] = TOOLS
                filt = _StreamFilter(thinking)
                full = ""
                async with client.stream("POST", chat_url, json=payload) as resp:
                    if resp.status_code != 200:
                        body = (await resp.aread()).decode("utf-8", "replace")[:500]
                        if resp.status_code == 400 and "context length" in body \
                                and not context_retried and len(messages) > 2:
                            # не влезли в контекст: режем историю и max_tokens, повторяем
                            context_retried = True
                            messages[:] = messages[:1] + messages[-1:]
                            max_tokens = 1024
                            yield ev({"type": "tool", "name": "context",
                                      "status": "done",
                                      "message": "Контекст переполнен — история диалога сокращена"})
                            continue
                        yield ev({"type": "error",
                                  "message": f"Модель ответила {resp.status_code}: {body}"})
                        return
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                            delta = chunk["choices"][0].get("delta") or {}
                            piece = delta.get("content") or ""
                        except (json.JSONDecodeError, KeyError, IndexError):
                            continue
                        full += piece
                        for kind, text in filt.feed(piece):
                            yield ev({"type": kind, "text": text})

                calls = parse_tool_calls(full)
                if not calls:
                    full = strip_tool_markup(full) or full
                    _, answer = split_thinking(full)
                    if filt.mode != "text" and answer and not filt.emitted:
                        # всё ещё сидели в pending/thinking — выдать ответ целиком
                        yield ev({"type": "token", "text": answer})
                    yield ev({"type": "done"})
                    return

                # шаг с инструментами: в историю — сырой ответ модели
                messages.append({"role": "assistant", "content": full})
                for name, args, _raw in calls:
                    result, events = await _exec_tool(name, args, read_tools,
                                                      action_tools)
                    for payload in events:
                        yield ev(payload)
                    messages.append({"role": "tool", "name": name,
                                     "content": json.dumps(result, ensure_ascii=False,
                                                           default=str)[:8000]})
            yield ev({"type": "error",
                      "message": "Превышен лимит шагов агента (6). Попробуйте переформулировать."})
    except httpx.ConnectError:
        yield ev({"type": "error",
                  "message": "Chat-модель недоступна: нет соединения. Запущена ли модель?"})
    except httpx.ReadTimeout:
        yield ev({"type": "error",
                  "message": "Модель не ответила за 5 минут (таймаут)."})
