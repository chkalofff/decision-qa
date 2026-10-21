"""Квитанции исходов карточек (A4, v1.2): замкнутый контур действий.

Биконы исходов с фронта (/api/assistant/event) кроме журнала кладутся в
in-memory очередь по session-id вкладки; в начале следующего хода агентный
цикл дрейнит очередь и инжектирует квитанции в контекст одним системным
сообщением — модель перестаёт быть единственным участником без обратной
связи (диагноз P1). В v1.3 переедет в серверное состояние — интерфейс
(ReceiptStore) уже отделён от транспорта.

Семантика очереди: «прочитано = удалено» (drain забирает и очищает), TTL
сутки, cap на сессию с вытеснением старых, cap на число сессий (LRU по
активности). Idempotency-key (event_id от фронта, «proposal_id:outcome»)
— повторная доставка той же квитанции (двойной клик, два таба, ретрай
сети) не плодит дубль.

Ревизия состояния (сверка «снапшот важнее квитанции»): хеш djb2/base36 от
канонической JSON-сериализации — ТО ЖЕ, что hashString на фронте
(fingerprint.js), канонизация одинаковая по обе стороны (см.
canonical_state). Расхождение ревизии квитанции с текущим снапшотом при
инжекции → пометка «после этого состояние менялось вручную».
"""
from __future__ import annotations

import json
import time
from collections import OrderedDict

# ------------------------------------------------------------------ ревизия

def _djb2_base36(s: str) -> str:
    """Зеркало hashString (fingerprint.js): djb2 c 32-битным усечением на
    каждом шаге, вывод — base36. Не криптография — маркер «изменилось/нет».
    JS: ((h << 5) + h + code) >>> 0 — h<<5 в JS усекается к int32 (со
    знаком), затем численное сложение и ToUint32."""
    h = 5381
    for ch in s:
        t = (h << 5) & 0xFFFFFFFF
        if t >= 0x80000000:
            t -= 0x100000000  # JS int32 со знаком
        h = (t + h + ord(ch)) & 0xFFFFFFFF
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if h == 0:
        return "0"
    out = ""
    while h:
        out = digits[h % 36] + out
        h //= 36
    return out


def canonical_state(snapshot: dict) -> dict:
    """Каноническая форма релевантной части снапшота для ревизии (контракт
    A4 — зеркалится фронтом в assistant.js canonicalState):
    q — вопросы [id, type, текст] (порядок значим); d — исходы решения
    [label, isDefault, правила [anyOf, условия [question(id), op, answer,
    threshold, score]]] (пороги в %, как в снапшоте); c — текст материала
    (урезанный, как в снапшоте); b — имена файлов пакета."""
    qs = [[str(q.get("id") or ""), str(q.get("type") or ""),
           str(q.get("question") or "")]
          for q in (snapshot or {}).get("questions") or []
          if isinstance(q, dict)]
    decision = (snapshot or {}).get("decision") or {}
    outcomes = decision.get("outcomes")
    d = None
    if isinstance(outcomes, list) and outcomes:
        d = [[str(o.get("label") or ""), bool(o.get("isDefault")),
              [[bool(r.get("anyOf")),
                [[str(c.get("question") or ""), str(c.get("op") or ""),
                  c.get("answer"), c.get("threshold"), c.get("score")]
                 for c in r.get("conditions") or [] if isinstance(c, dict)]]
               for r in o.get("rules") or [] if isinstance(r, dict)]]
             for o in outcomes if isinstance(o, dict)]
    ctx = ((snapshot or {}).get("context") or {}).get("text") or ""
    files = [str(f.get("name") or "")
             for f in (snapshot or {}).get("batchFiles") or []
             if isinstance(f, dict)]
    return {"q": qs, "d": d, "c": ctx, "b": files}


def revision_of_snapshot(snapshot: dict | None) -> str | None:
    """Ревизия состояния = djb2/base36 от компактной канонической JSON
    (без пробелов, юникод как есть — идентично JSON.stringify на фронте).
    None — снапшота нет (сверка не делается)."""
    if not snapshot:
        return None
    canon = json.dumps(canonical_state(snapshot), ensure_ascii=False,
                       separators=(",", ":"))
    return _djb2_base36(canon)


# ------------------------------------------------------------------ очередь

RECEIPT_TTL_S = 24 * 3600      # сутки
RECEIPTS_PER_SESSION = 50      # вытеснение старых внутри сессии
MAX_SESSIONS = 500             # LRU по последней активности


class ReceiptStore:
    """Очереди квитанций по session-id. Потокобезопасность не нужна
    (один event-loop FastAPI); чистый интерфейс — в v1.3 переедет в
    серверное состояние приложения."""

    def __init__(self, ttl_s: int = RECEIPT_TTL_S,
                 cap_per_session: int = RECEIPTS_PER_SESSION,
                 max_sessions: int = MAX_SESSIONS,
                 clock=time.monotonic):
        self.ttl_s = ttl_s
        self.cap = cap_per_session
        self.max_sessions = max_sessions
        self.clock = clock
        # session_id → {"items": [receipt], "seen": {event_id: ts},
        #               "ts": last}
        self._sessions: OrderedDict[str, dict] = OrderedDict()

    def _purge(self, s: dict) -> None:
        if self.ttl_s <= 0:
            return
        cutoff = self.clock() - self.ttl_s
        items = [r for r in s["items"] if r.get("_ts", 0) >= cutoff]
        if len(items) != len(s["items"]):
            s["items"] = items
        s["seen"] = {k: t for k, t in s["seen"].items() if t >= cutoff}

    def put(self, session_id: str, receipt: dict) -> bool:
        """→ False, если event_id уже был (двойная доставка — дубль не
        создаётся; seen переживает drain — поздний дубль прочитанной
        квитанции поглощается тоже)."""
        if not session_id:
            return False
        now = self.clock()
        s = self._sessions.get(session_id)
        if s is None:
            if len(self._sessions) >= self.max_sessions:
                self._sessions.popitem(last=False)  # старейшая сессия — вон
            s = {"items": [], "seen": {}, "ts": now}
            self._sessions[session_id] = s
        self._sessions.move_to_end(session_id)
        self._purge(s)
        event_id = receipt.get("event_id")
        if event_id and event_id in s["seen"]:
            return False
        receipt = dict(receipt, _ts=now)
        s["items"].append(receipt)
        if event_id:
            s["seen"][event_id] = now
        s["ts"] = now
        while len(s["items"]) > self.cap:
            s["items"].pop(0)  # вытеснение старых; seen остаётся (TTL)
        return True

    def drain(self, session_id: str) -> list[dict]:
        """Прочитано = удалено: забирает и очищает очередь сессии. Набор
        отгруженных event_id НЕ очищается: поздний дубль уже прочитанной
        квитанции (ретрай сети после доставки) поглощается тоже."""
        s = self._sessions.get(session_id)
        if not s:
            return []
        self._purge(s)
        items = s["items"]
        s["items"] = []
        s["ts"] = self.clock()
        self._sessions.move_to_end(session_id)
        return [{k: v for k, v in r.items() if not k.startswith("_")}
                for r in items]


# Синглтон процесса (router/agent ходят сюда; тесты подменяют clock).
STORE = ReceiptStore()


# ------------------------------------------------------------------ инжекция

_OUTCOME_TEXT = {
    "applied": "ПРИНЯТА и применена",
    "declined": "ОТКЛОНЕНА пользователем",
    "undone": "применена, затем ОТМЕНЕНА пользователем (откат)",
    "invalid": "НЕПРИМЕНИМА (невалидна)",
}

_KIND_TEXT = {
    "propose_questions": "вопросы",
    "propose_context": "материал",
    "propose_run": "запуск прогона",
    "propose_save_preset": "пресет",
    "propose_decision": "правила решения",
}


def format_turn_events(receipts: list[dict], current_revision: str | None,
                       prev_aborted: bool = False,
                       external_change: bool = False) -> str | None:
    """Системные события для контекста следующего хода (квитанции + abort +
    внешнее изменение) → текст user-сообщения; None — событий нет.

    Сверка ревизий: только ПОСЛЕДНЯЯ квитанция пачки сравнивается с текущим
    снапшотом — у более ранних ревизия по построению старше следующей
    квитанции той же пачки (иначе серия «принял 2 карточки» ложно помечалась
    бы «менялось вручную»)."""
    lines = []
    for i, r in enumerate(receipts):
        kind = str(r.get("kind") or "")
        title = str(r.get("title") or "") or _KIND_TEXT.get(kind, kind)
        outcome = _OUTCOME_TEXT.get(str(r.get("outcome") or ""),
                                    str(r.get("outcome") or "?"))
        line = f"- квитанция: карточка «{title}» ({kind}) — {outcome}"
        if r.get("outcome") == "invalid" and r.get("detail"):
            line += f": {r['detail']}"
        if r.get("post_state"):
            line += f"; состояние после: {r['post_state']}"
        if (i == len(receipts) - 1 and current_revision
                and r.get("revision") and r["revision"] != current_revision):
            line += (" — внимание: после этого состояние менялось вне "
                     "карточек (вручную или в другой вкладке), актуальное — "
                     "в снапшоте")
        lines.append(line)
    if prev_aborted:
        lines.append("- прошлый твой ответ был прерван пользователем — не "
                     "считай его доставленным")
    if external_change:
        lines.append("- состояние приложения менялось в другой вкладке — "
                     "сверяйся со снапшотом, а не с прошлыми ответами")
    if not lines:
        return None
    return ("[События, произошедшие после твоего прошлого ответа "
            "(квитанции о судьбе твоих карточек — учитывай: не перевыпускай "
            "принятое, не повторяй отклонённое без изменений):\n"
            + "\n".join(lines) + "]")
