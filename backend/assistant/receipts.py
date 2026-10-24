"""Квитанции исходов карточек (A4, v1.2): замкнутый контур действий.

Биконы исходов с фронта (/api/assistant/event) кроме журнала кладутся в
очередь по (owner, session-id) вкладки; в начале следующего хода агентный
цикл дрейнит очередь и инжектирует квитанции в контекст одним системным
сообщением. Продакшен-хранилище — server/state/assistant-receipts.sqlite3;
path=None оставляет in-memory реализацию для unit-тестов.

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
import sqlite3
import threading
import time
from collections import OrderedDict
from pathlib import Path

from backend.auth import safe_owner

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


RECEIPTS_DB_PATH = (Path(__file__).resolve().parent.parent.parent
                    / "server" / "state" / "assistant-receipts.sqlite3")


class ReceiptStore:
    """Очереди ``(owner, session_id)``; SQLite либо память при path=None."""

    def __init__(self, ttl_s: int = RECEIPT_TTL_S,
                 cap_per_session: int = RECEIPTS_PER_SESSION,
                 max_sessions: int = MAX_SESSIONS,
                 clock=None, path: str | Path | None = None):
        self.ttl_s = ttl_s
        self.cap = cap_per_session
        self.max_sessions = max_sessions
        self.path = Path(path) if path is not None else None
        self.clock = clock or (time.time if self.path is not None else time.monotonic)
        self._sessions: OrderedDict[tuple[str, str], dict] = OrderedDict()
        self._conn = None
        self._lock = threading.RLock()

    def _purge(self, s: dict) -> None:
        if self.ttl_s <= 0:
            return
        cutoff = self.clock() - self.ttl_s
        items = [r for r in s["items"] if r.get("_ts", 0) >= cutoff]
        if len(items) != len(s["items"]):
            s["items"] = items
        s["seen"] = {k: t for k, t in s["seen"].items() if t >= cutoff}

    def _db(self):
        if self._conn is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(self.path, check_same_thread=False)
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript("""
                CREATE TABLE IF NOT EXISTS sessions (
                    owner TEXT NOT NULL, session_id TEXT NOT NULL, last REAL NOT NULL,
                    PRIMARY KEY (owner, session_id));
                CREATE TABLE IF NOT EXISTS receipts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner TEXT NOT NULL, session_id TEXT NOT NULL,
                    payload TEXT NOT NULL, ts REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS receipts_queue
                    ON receipts (owner, session_id, id);
                CREATE TABLE IF NOT EXISTS seen (
                    owner TEXT NOT NULL, session_id TEXT NOT NULL,
                    event_id TEXT NOT NULL, ts REAL NOT NULL,
                    PRIMARY KEY (owner, session_id, event_id));
            """)
        return self._conn

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    def _purge_db(self, conn, owner: str, session_id: str, now: float) -> None:
        if self.ttl_s <= 0:
            return
        cutoff = now - self.ttl_s
        conn.execute("DELETE FROM receipts WHERE owner=? AND session_id=? AND ts<?",
                     (owner, session_id, cutoff))
        conn.execute("DELETE FROM seen WHERE owner=? AND session_id=? AND ts<?",
                     (owner, session_id, cutoff))

    def _trim_sessions_db(self, conn) -> None:
        excess = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] - self.max_sessions
        if excess <= 0:
            return
        stale = conn.execute(
            "SELECT owner, session_id FROM sessions ORDER BY last, rowid LIMIT ?",
            (excess,)).fetchall()
        for owner, session_id in stale:
            for table in ("receipts", "seen", "sessions"):
                conn.execute(f"DELETE FROM {table} WHERE owner=? AND session_id=?",
                             (owner, session_id))

    def put(self, session_id: str, receipt: dict, owner: str = "local") -> bool:
        """Атомарно добавить квитанцию; seen event_id переживает drain/restart."""
        if not session_id:
            return False
        owner = safe_owner(owner)
        now = self.clock()
        if self.path is not None:
            with self._lock, self._db() as conn:
                conn.execute("BEGIN IMMEDIATE")
                self._purge_db(conn, owner, session_id, now)
                event_id = receipt.get("event_id")
                if event_id and conn.execute(
                        "SELECT 1 FROM seen WHERE owner=? AND session_id=? AND event_id=?",
                        (owner, session_id, event_id)).fetchone():
                    return False
                conn.execute("INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)",
                             (owner, session_id, now))
                payload = json.dumps(dict(receipt), ensure_ascii=False,
                                     separators=(",", ":"), default=str)
                conn.execute("INSERT INTO receipts(owner, session_id, payload, ts) "
                             "VALUES (?, ?, ?, ?)", (owner, session_id, payload, now))
                conn.execute("DELETE FROM receipts WHERE owner=? AND session_id=? "
                             "AND id NOT IN (SELECT id FROM receipts WHERE owner=? "
                             "AND session_id=? ORDER BY id DESC LIMIT ?)",
                             (owner, session_id, owner, session_id, self.cap))
                if event_id:
                    conn.execute("INSERT OR REPLACE INTO seen VALUES (?, ?, ?, ?)",
                                 (owner, session_id, event_id, now))
                self._trim_sessions_db(conn)
                return True

        key = (owner, session_id)
        with self._lock:
            s = self._sessions.get(key)
            if s is None:
                if len(self._sessions) >= self.max_sessions:
                    self._sessions.popitem(last=False)
                s = {"items": [], "seen": {}, "ts": now}
                self._sessions[key] = s
            self._sessions.move_to_end(key)
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
                s["items"].pop(0)
            return True

    def drain(self, session_id: str, owner: str = "local") -> list[dict]:
        """Атомарно забрать и очистить очередь, сохраняя seen event_id."""
        owner = safe_owner(owner)
        now = self.clock()
        if self.path is not None:
            with self._lock, self._db() as conn:
                conn.execute("BEGIN IMMEDIATE")
                self._purge_db(conn, owner, session_id, now)
                rows = conn.execute("SELECT id, payload FROM receipts WHERE owner=? "
                                    "AND session_id=? ORDER BY id", (owner, session_id)).fetchall()
                if not rows:
                    return []
                conn.execute("DELETE FROM receipts WHERE owner=? AND session_id=?",
                             (owner, session_id))
                conn.execute("INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)",
                             (owner, session_id, now))
                return [json.loads(payload) for _, payload in rows]

        key = (owner, session_id)
        with self._lock:
            s = self._sessions.get(key)
            if not s:
                return []
            self._purge(s)
            items = s["items"]
            s["items"] = []
            s["ts"] = now
            self._sessions.move_to_end(key)
            return [{k: v for k, v in r.items() if not k.startswith("_")}
                    for r in items]


# Продакшен открывает SQLite лениво, при первой put/drain.
STORE = ReceiptStore(path=RECEIPTS_DB_PATH)


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
