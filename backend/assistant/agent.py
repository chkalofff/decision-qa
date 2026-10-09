"""Агентный цикл ассистента.

Локальные chat-модели (SGLang MLX, bonsai) раздают /v1/chat/completions без
tool-парсера: Qwen отдаёт вызовы инструментов hermes-разметкой прямо в
content — парсим сами. Облачные (run_remote_agent) — нативный OpenAI tool
calling (message.tool_calls), с фолбэком на hermes-разметку в content.
Стриминг ответа проксируем наружу с отложенным буфером: текст, который может
оказаться началом <tool_call> или thinking-блока, на клиент не уходит.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from collections.abc import AsyncGenerator

import httpx

from backend.assistant.prompts import (HERMES_FORMAT_HINT, SYSTEM_PROMPT,
                                       _MAX_SNAPSHOT_CHARS_REMOTE,
                                       serialize_snapshot)
from backend.assistant.tools import (PROPOSAL_TOOLS, TOOLS, validate_args)

MAX_STEPS = 6
MAX_HISTORY = 20
log = logging.getLogger("decision_qa.assistant")
# Таймауты по шагам вместо одного общего: каждый шаг генерации — свой лимит,
# весь цикл — общий потолок; любой таймаут завершается честным SSE error.
STEP_TIMEOUT = 300.0        # максимум на один шаг генерации модели
TOTAL_TIMEOUT = 900.0       # максимум на весь агентный цикл
# Лимит рассуждений. Нативных способов нет: sglang max_thinking_tokens
# требует --enable-strict-thinking при запуске сервера (в run_server.sh не
# включён, бэкенд MLX), chat_template_kwargs thinking_budget шаблонами
# Qwen3.5/3.8 и bonsai не поддерживается (проверено по chat_template.jinja
# паков), у bonsai serve.py ручной цикл генерации без капа. Поэтому кап —
# здесь: по времени фазы thinking стрим прерывается и шаг повторяется с
# enable_thinking=false.
THINKING_TIME_CAP = 90.0    # секунд на фазу рассуждения за шаг
TOOL_CALL_RE = re.compile(
    r"<tool_call>\s*<function=(\w+)>\s*(.*?)</function>\s*</tool_call>", re.S)
PARAM_RE = re.compile(r"<parameter=(\w+)>\s*(.*?)</parameter>", re.S)
LEGACY_CALL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.S)
BARE_FUNCTION_CALL_RE = re.compile(r"<function=(\w+)>\s*(.*?)</function>", re.S)
THINK_BLOCK_RE = re.compile(r"<think>\s*(.*?)</think>", re.S)
# Спецтокены tool-вызовов (Qwen/DeepSeek-варианты): (начало, конец).
_SPECIAL_CALL_PAIRS = (("<|tool_call|>", "<|tool_call_end|>"),
                       ("<｜tool▁call｜>", "<｜tool▁call▁end｜>"))
SPECIAL_CALL_RES = [re.compile(re.escape(s) + r".*?" + re.escape(e), re.S)
                    for s, e in _SPECIAL_CALL_PAIRS]

_PROPOSAL_TITLES = {
    "propose_questions": "Набор вопросов",
    "propose_context": "Материал",
    "propose_run": "Запуск прогона",
    "propose_save_preset": "Сохранить пресет",
    "propose_decision": "Правила решения",
}


def _proposal_title(name: str, args: dict) -> str:
    if name == "propose_context" and args.get("file"):
        return "Текст файла пакета"
    if name == "propose_save_preset" and args.get("slug"):
        return "Обновить пресет"
    return _PROPOSAL_TITLES.get(name, name)


def _snapshot_images(snapshot: dict | None) -> list[str]:
    """dataUrl картинок из снапшота (контекст + файлы батча) — для
    мультимодального user-сообщения, когда у chat-модели vision."""
    images = []
    ctx = (snapshot or {}).get("context") or {}
    for u in ctx.get("images") or []:
        if isinstance(u, str) and u.startswith("data:"):
            images.append(u)
    for f in (snapshot or {}).get("batchFiles") or []:
        if isinstance(f, dict):
            for u in f.get("images") or []:
                if isinstance(u, str) and u.startswith("data:"):
                    images.append(u)
    return images[:8]


def _user_message(text: str, snapshot: dict | None, vision: bool) -> dict:
    """User-сообщение: строка или content-массив с image_url частями
    (OpenAI-формат) — только для vision-модели и при наличии картинок."""
    if vision:
        images = _snapshot_images(snapshot)
        if images:
            return {"role": "user", "content":
                    [{"type": "text", "text": text}] +
                    [{"type": "image_url", "image_url": {"url": u}}
                     for u in images]}
    return {"role": "user", "content": text}


def _parse_params(body: str) -> dict:
    """<parameter=k>v</parameter> → dict; значения — JSON, если парсятся."""
    args: dict = {}
    for pname, pval in PARAM_RE.findall(body):
        pval = pval.strip()
        try:
            args[pname] = json.loads(pval)
        except json.JSONDecodeError:
            args[pname] = pval
    return args


def parse_tool_calls(content: str) -> list[tuple[str, dict, str]]:
    """Hermes-разметка Qwen → [(имя, аргументы, сырой_кусок)]. Остаток — текст.
    Понимает обёрнутый <tool_call><function=…>, голый <function=…> и
    JSON-форму <tool_call>{…}</tool_call>."""
    calls = [(name, _parse_params(body), "")
             for name, body in TOOL_CALL_RE.findall(content)]
    if not calls:
        calls = [(name, _parse_params(body), "")
                 for name, body in BARE_FUNCTION_CALL_RE.findall(content)]
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


def _has_call_markup(content: str) -> bool:
    """В ответе есть признаки вызова инструмента, но parse_tool_calls его не
    разобрал (слабая модель ломает разметку) — такой ответ нельзя показывать
    как чистый текст, надо дать модели повторить вызов."""
    return ("<tool_call" in content or "<function=" in content
            or any(s in content for s, _e in _SPECIAL_CALL_PAIRS))


# Просьба повторить сломанный вызов — следующим шагом цикла.
_RETRY_BROKEN_CALL = ("Вызов инструмента в твоём ответе не распознан: разметка "
                      "сломана. Повтори вызов строго по формату из инструкции, "
                      "без лишнего текста вокруг.")


def strip_tool_markup(content: str) -> str:
    """Текст ответа без tool_call-разметки (все варианты) и think-блоков."""
    text = TOOL_CALL_RE.sub("", content)
    text = LEGACY_CALL_RE.sub("", text)
    text = BARE_FUNCTION_CALL_RE.sub("", text)
    for rx in SPECIAL_CALL_RES:
        text = rx.sub("", text)
    text = THINK_BLOCK_RE.sub("", text)
    return text.strip()


def split_thinking(content: str) -> tuple[str, str]:
    """(thinking, answer): SGLang без reasoning-парсера кладёт рассуждение
    в content, отделяя маркером </think>; явный <think> у thinking срезаем."""
    if "</think>" in content:
        think, _, answer = content.partition("</think>")
        think = think.strip()
        if think.startswith("<think>"):
            think = think[len("<think>"):].strip()
        return think, answer.strip()
    return "", content


async def run_remote_agent(
    history: list[dict],
    user_message: str,
    snapshot: dict | None,
    entry,
    read_tools: dict | None = None,
    action_tools: dict | None = None,
    thinking: bool = False,
    step_timeout: float = STEP_TIMEOUT,
    thinking_time_cap: float = THINKING_TIME_CAP,
    total_timeout: float = TOTAL_TIMEOUT,
    vision: bool = False,
) -> AsyncGenerator[str, None]:
    """Ассистент на облачной chat-модели (remote_llm): полный агентный цикл
    с нативным OpenAI tool calling (tools + message.tool_calls). Стриминг
    включён всегда: tool_calls приходят в дельтах. Фолбэк: если провайдер не
    разобрал вызовы и модель выдала hermes-разметку в content — парсим её.
    События — тем же SSE-протоколом, что и run_agent. Таймауты — как в
    run_agent (по шагам + общий), отмена клиентом закрывает upstream-стрим.

    thinking: openrouter → reasoning {"enabled": bool}; прочие OpenAI-
    совместимые API → reasoning_effort high/low с фолбэком (на 400/422 —
    ретрай шага без параметра, паттерн remote_llm.remote_chat). Кап
    рассуждения — как локально: дольше thinking_time_cap в фазе reasoning
    (delta.reasoning / delta.reasoning_content) → заметка и ретрай шага с
    выключенным рассуждением. Обрыв по length с пустым content после
    рассуждения — понятный SSE error вместо молчаливого done."""
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
                 "content": SYSTEM_PROMPT + serialize_snapshot(
                     snapshot, max_chars=_MAX_SNAPSHOT_CHARS_REMOTE)}]
    messages.extend(history[-MAX_HISTORY:])
    messages.append(_user_message(user_message, snapshot, vision))

    reasoning_dropped = False  # API не принял reasoning_effort (400/422)
    broken_call_retried = False  # hermes-фолбэк со сломанной разметкой — 1 ретрай

    try:
        async with asyncio.timeout(total_timeout):
            async with httpx.AsyncClient(
                    timeout=httpx.Timeout(step_timeout, connect=10.0)) as client:
                for _step in range(MAX_STEPS):
                    payload = {
                        "model": entry.api_model or entry.key,
                        "messages": messages,
                        "tools": TOOLS,
                        "temperature": 0.3,
                        # reasoning-токены делят max_tokens с ответом — с запасом
                        "max_tokens": 4096 if thinking else 2048,
                        "stream": True,
                    }
                    if entry.api == "openrouter":
                        payload["reasoning"] = {"enabled": thinking}
                    elif not reasoning_dropped:
                        payload["reasoning_effort"] = "high" if thinking else "low"
                    filt = _StreamFilter(False)
                    full = ""
                    # native tool_calls из дельт: index → {id, name, arguments}
                    tc_acc: dict[int, dict] = {}
                    finish_reason: str | None = None
                    reasoning_started: float | None = None
                    capped = False
                    step_cm = asyncio.timeout(step_timeout)
                    try:
                        async with step_cm:
                            async with client.stream("POST", url, json=payload,
                                                     headers=headers) as resp:
                                if resp.status_code != 200:
                                    body = (await resp.aread()).decode("utf-8", "replace")[:500]
                                    if resp.status_code in (400, 422) \
                                            and "reasoning_effort" in payload:
                                        # API не знает параметр — ретрай без него
                                        reasoning_dropped = True
                                        continue
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
                                        choice = chunk["choices"][0]
                                        delta = choice.get("delta") or {}
                                    except (json.JSONDecodeError, KeyError, IndexError):
                                        continue
                                    finish_reason = choice.get("finish_reason") \
                                        or finish_reason
                                    reasoning = (delta.get("reasoning")
                                                 or delta.get("reasoning_content") or "")
                                    if reasoning:
                                        if reasoning_started is None:
                                            reasoning_started = time.monotonic()
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
                                    if reasoning_started is not None \
                                            and not full and not tc_acc \
                                            and time.monotonic() - reasoning_started \
                                            > thinking_time_cap:
                                        capped = True  # выход закроет стрим
                                        break
                    except TimeoutError:
                        if not step_cm.expired():
                            raise  # общий total_timeout — внешний except
                        yield ev({"type": "error",
                                  "message": f"API не уложился в {int(step_timeout)} с — шаг прерван."})
                        return
                    if capped:
                        # мыслит слишком долго: ретрай шага без рассуждения
                        thinking = False
                        reasoning_dropped = True  # generic: без reasoning_effort
                        yield ev({"type": "tool", "name": "thinking",
                                  "status": "done",
                                  "message": "Рассуждение обрезано по лимиту времени — отвечаю без размышлений"})
                        continue
                    for kind, text in filt.finish():
                        yield ev({"type": kind, "text": text})

                    tc_list = [tc_acc[i] for i in sorted(tc_acc)]
                    if finish_reason == "length" and not full.strip() \
                            and not tc_list and reasoning_started is not None:
                        yield ev({"type": "error",
                                  "message": "Модель исчерпала лимит токенов на "
                                             "рассуждение — выключите «Рассуждение» "
                                             "или задайте вопрос короче."})
                        return

                    calls: list[tuple[str, dict, str]] = []
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
                        if _has_call_markup(full) and not broken_call_retried \
                                and _step + 1 < MAX_STEPS:
                            # hermes-фолбэк со сломанной разметкой — повтор (1 раз)
                            broken_call_retried = True
                            log.warning("сломанный tool-call (remote), ретрай: %.300s",
                                        full)
                            messages.append({"role": "assistant", "content": full})
                            messages.append({"role": "user",
                                             "content": _RETRY_BROKEN_CALL})
                            yield ev({"type": "tool", "name": "retry",
                                      "status": "done",
                                      "message": "Вызов инструмента сломан — повторяю"})
                            continue
                        if _has_call_markup(full):
                            log.warning("сломанный tool-call (remote), ретрай уже "
                                        "был — отдаём текст: %.300s", full)
                        answer = strip_tool_markup(full) or full
                        _, answer = split_thinking(answer)
                        if not filt.emitted and answer \
                                and not _has_call_markup(answer):
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
    except TimeoutError:
        yield ev({"type": "error",
                  "message": f"Превышено общее время работы агента ({int(total_timeout)} с) — прервано."})
    except httpx.ConnectError:
        yield ev({"type": "error",
                  "message": f"API недоступен ({base}): нет соединения."})
    except httpx.ReadTimeout:
        yield ev({"type": "error",
                  "message": "API не ответил вовремя (таймаут чтения)."})


async def _exec_tool(name: str, args, read_tools: dict,
                     action_tools: dict | None) -> tuple[dict, list[dict]]:
    """Исполнение одного вызова: валидация → proposal/action/read.
    → (результат для tool-сообщения, SSE-события для клиента)."""
    log.info("tool %s args=%.300s", name,
             json.dumps(args, ensure_ascii=False, default=str))
    args, error = validate_args(name, args)
    if error:
        log.warning("tool %s: валидация — %s", name, error)
        return {"ok": False, "error": error}, [
            {"type": "tool", "name": name, "status": "error", "message": error}]
    if name in PROPOSAL_TOOLS:
        proposal = {
            "id": uuid.uuid4().hex[:8],
            "kind": name,
            "title": _proposal_title(name, args),
            "payload": args,
        }
        return {"ok": True, "note": "Предложение показано пользователю "
                                    "и ждёт подтверждения (кнопки «Принять»/"
                                    "«Отклонить»). Не называй его применённым."}, [
            {"type": "proposal", "proposal": proposal}]
    if action_tools and name in action_tools:
        events = [{"type": "tool", "name": name, "status": "start"}]
        try:
            result, extra_events = await action_tools[name](args)
        except Exception as e:  # noqa: BLE001 — отдаём модели как есть
            result, extra_events = {"ok": False, "error": str(e)}, []
        if not result.get("ok"):
            log.warning("tool %s: ошибка — %s", name, result.get("error"))
        events += extra_events
        events.append({"type": "tool", "name": name,
                       "status": "done" if result.get("ok") else "error",
                       "message": None if result.get("ok")
                                  else result.get("error")})
        return result, events
    events = [{"type": "tool", "name": name, "status": "start"}]
    try:
        result = await read_tools[name](args)
    except Exception as e:  # noqa: BLE001 — отдаём модели как есть
        log.warning("tool %s: исключение — %s", name, e)
        result = {"ok": False, "error": str(e)}
    events.append({"type": "tool", "name": name, "status": "done"})
    return result, events


class _StreamFilter:
    """Отложенный буфер стрима: решает, что из content — текст для клиента,
    а что — thinking или tool_call-разметка (наружу не отдаём).

    Прячет: hermes <tool_call><function=…> и JSON-форму, голый <function=…>
    без обёртки, спецтокены (<|tool_call|>, <｜tool▁call｜>), явные блоки
    <think>…</think> (независимо от thinking_expected). finish() добирает
    хвост буфера при обрыве стрима: текст отдаётся, обрывки разметки
    выбрасываются, недописанное рассуждение уходит thinking-событием."""

    _TOOL_MARKERS = (("<tool_call>", "</tool_call>"),
                     ("<function=", "</function>")) + _SPECIAL_CALL_PAIRS
    _STARTS = tuple(s for s, _ in _TOOL_MARKERS)
    _THINK_START = "<think>"
    _THINK_END = "</think>"

    def __init__(self, thinking: bool):
        self.buf = ""
        self.mode = "pending"  # pending → text | toolcall | (thinking → pending)
        self.tool_end = ""     # end-маркер текущего toolcall-блока
        self.thinking_expected = thinking
        self.emitted = False   # клиенту уже ушёл хоть один token

    @staticmethod
    def _hold_len(buf: str, markers: tuple[str, ...]) -> int:
        """Длина хвоста buf, который может оказаться началом маркера."""
        longest = max(len(m) for m in markers)
        for n in range(min(len(buf), longest - 1), 0, -1):
            tail = buf[-n:]
            if any(m.startswith(tail) and len(m) > n for m in markers):
                return n
        return 0

    def _marker_at_start(self, s: str) -> str | None:
        """end-маркер, если s начинается с tool-маркера, иначе None."""
        for start, end in self._TOOL_MARKERS:
            if s.startswith(start):
                return end
        return None

    def feed(self, chunk: str) -> list[tuple[str, str]]:
        """Возвращает события [(type, text)]: token | thinking."""
        self.buf += chunk
        out: list[tuple[str, str]] = []
        while True:
            if self.mode == "text":
                hit, end_m = -1, ""
                for start, end in self._TOOL_MARKERS:
                    i = self.buf.find(start)
                    if 0 <= i and (hit < 0 or i < hit):
                        hit, end_m = i, end
                if hit >= 0:  # tool-разметка в середине текста — до неё отдаём
                    if hit:
                        out.append(("token", self.buf[:hit]))
                    self.buf = self.buf[hit:]
                    self.mode = "toolcall"
                    self.tool_end = end_m
                    continue
                hold = self._hold_len(self.buf, self._STARTS)
                emit = self.buf if not hold else self.buf[:-hold]
                self.buf = self.buf[-hold:] if hold else ""
                if emit:
                    out.append(("token", emit))
                    self.emitted = True
                return out
            if self.mode == "toolcall":
                if self.tool_end in self.buf:
                    _, _, self.buf = self.buf.partition(self.tool_end)
                    self.mode = "pending"
                    continue
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
            if stripped.startswith(self._THINK_START):
                # явный <think> — thinking-блок независимо от thinking_expected
                self.buf = stripped[len(self._THINK_START):]
                self.mode = "thinking"
                continue
            if self.thinking_expected and not stripped.startswith("<"):
                self.mode = "thinking"
                continue
            end_m = self._marker_at_start(stripped)
            if end_m is not None:
                self.buf = stripped
                self.mode = "toolcall"
                self.tool_end = end_m
                continue
            if any(m.startswith(stripped)
                   for m in self._STARTS + (self._THINK_START,)):
                return out  # ещё может стать разметкой — ждём
            self.mode = "text"
        return out

    def finish(self) -> list[tuple[str, str]]:
        """Хвост буфера в конце стрима: текст наружу, обрывки разметки — вон."""
        out: list[tuple[str, str]] = []
        if self.mode == "text":
            hold = self._hold_len(self.buf, self._STARTS)
            emit = self.buf if not hold else self.buf[:-hold]
            if emit:
                out.append(("token", emit))
        elif self.mode == "pending":
            stripped = self.buf.strip()
            looks_markup = (self._marker_at_start(stripped) is not None
                            or any(m.startswith(stripped)
                                   for m in self._STARTS + (self._THINK_START,)))
            if stripped and not looks_markup:
                out.append(("token", stripped))
        elif self.mode == "thinking":
            if self.buf.strip():
                out.append(("thinking", self.buf))
        # toolcall — недописанный вызов выбрасываем
        self.buf = ""
        self.emitted = self.emitted or any(k == "token" for k, _ in out)
        return out


async def run_agent(
    history: list[dict],
    user_message: str,
    snapshot: dict | None,
    chat_url: str,
    thinking: bool,
    read_tools: dict,
    action_tools: dict | None = None,
    step_timeout: float = STEP_TIMEOUT,
    thinking_time_cap: float = THINKING_TIME_CAP,
    total_timeout: float = TOTAL_TIMEOUT,
    vision: bool = False,
) -> AsyncGenerator[str, None]:
    """SSE-события (строки data: {...}). read_tools: {name: async callable()}.
    action_tools: {name: async callable(args) -> (result, extra_sse_events)} —
    авто-исполняемые на сервере инструменты (run_trial).

    Таймауты: step_timeout — на шаг генерации, total_timeout — на весь цикл;
    любой таймаут завершается SSE error (а не мёртвым обрывом). Отмена
    клиентом (disconnect/abort) доезжает до модельного сервера: CancelledError
    внутри `async with client.stream` закрывает upstream-стрим, генерация на
    sglang останавливается (bonsai-воркер в фоне догенерирует — его поток
    неубиваем, но HTTP-соединение закрыто).
    Лимит рассуждений: если фаза thinking длится дольше thinking_time_cap,
    стрим прерывается и шаг повторяется с enable_thinking=false (нативных
    способов капа у sglang-MLX/bonsai нет — см. THINKING_TIME_CAP)."""

    def ev(payload: dict) -> str:
        return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"

    messages = [{"role": "system",
                 "content": SYSTEM_PROMPT
                            + HERMES_FORMAT_HINT
                            + serialize_snapshot(snapshot)}]
    messages.extend(history[-MAX_HISTORY:])
    messages.append(_user_message(user_message, snapshot, vision))

    max_tokens = 2048
    context_retried = False
    broken_call_retried = False

    try:
        async with asyncio.timeout(total_timeout):
            async with httpx.AsyncClient(
                    timeout=httpx.Timeout(step_timeout, connect=10.0)) as client:
                for _step in range(MAX_STEPS):
                    payload = {
                        "model": "assistant",
                        "messages": messages,
                        "temperature": 0.3,
                        "max_tokens": max_tokens,
                        "stream": True,
                        "chat_template_kwargs": {"enable_thinking": thinking},
                        "tools": TOOLS,
                    }
                    filt = _StreamFilter(thinking)
                    full = ""
                    capped = False
                    step_cm = asyncio.timeout(step_timeout)
                    try:
                        async with step_cm:
                            step_started = time.monotonic()
                            async with client.stream("POST", chat_url,
                                                     json=payload) as resp:
                                if resp.status_code != 200:
                                    body = (await resp.aread()).decode(
                                        "utf-8", "replace")[:500]
                                    if resp.status_code == 400 \
                                            and "context length" in body \
                                            and not context_retried \
                                            and len(messages) > 2:
                                        # не влезли в контекст: режем историю
                                        # и max_tokens, повторяем
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
                                    if thinking and filt.mode == "thinking" \
                                            and time.monotonic() - step_started \
                                            > thinking_time_cap:
                                        capped = True  # выход закроет стрим
                                        break
                    except TimeoutError:
                        if not step_cm.expired():
                            raise  # сработал общий total_timeout — внешний except
                        yield ev({"type": "error",
                                  "message": f"Модель не уложилась в {int(step_timeout)} с — шаг прерван. "
                                             "Попробуйте переформулировать или сократить контекст."})
                        return
                    if capped:
                        # мыслит слишком долго: повтор шага без рассуждений
                        thinking = False
                        yield ev({"type": "tool", "name": "thinking",
                                  "status": "done",
                                  "message": "Рассуждение обрезано по лимиту времени — отвечаю без размышлений"})
                        continue
                    for kind, text in filt.finish():
                        yield ev({"type": kind, "text": text})

                    calls = parse_tool_calls(full)
                    if not calls:
                        if _has_call_markup(full) and not broken_call_retried \
                                and _step + 1 < MAX_STEPS:
                            # модель пыталась вызвать инструмент, но сломала
                            # разметку — не показываем огрызок как ответ,
                            # даём повторить вызов следующим шагом (один раз:
                            # повторный слом — фолбэк на текст ниже)
                            broken_call_retried = True
                            log.warning("сломанный tool-call (local), ретрай: %.300s",
                                        full)
                            messages.append({"role": "assistant", "content": full})
                            messages.append({"role": "user",
                                             "content": _RETRY_BROKEN_CALL})
                            yield ev({"type": "tool", "name": "retry",
                                      "status": "done",
                                      "message": "Вызов инструмента сломан — повторяю"})
                            continue
                        if _has_call_markup(full):
                            log.warning("сломанный tool-call (local), ретрай уже был "
                                        "— отдаём текст: %.300s", full)
                        full = strip_tool_markup(full) or full
                        _, answer = split_thinking(full)
                        if not filt.emitted and answer \
                                and not _has_call_markup(answer):
                            # ничего не стримилось (или всё съел фильтр) — ответ целиком;
                            # сырую битую разметку наружу не отдаём
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
    except TimeoutError:
        yield ev({"type": "error",
                  "message": f"Превышено общее время работы агента ({int(total_timeout)} с) — прервано."})
    except httpx.ConnectError:
        yield ev({"type": "error",
                  "message": "Chat-модель недоступна: нет соединения. Запущена ли модель?"})
    except httpx.ReadTimeout:
        yield ev({"type": "error",
                  "message": "Модель не ответила вовремя (таймаут чтения)."})
