"""A2.2 (v1.2): контролируемый live-эксперимент «thinking у flash-модели».

Три плеча × k прогонов × сценарии-одноходовки против реального OpenRouter
(через настоящий run_remote_agent — весь цикл со стражами; read-tools и
run_trial — фейки assistant_eval, эксперимент меряет поведение chat-модели,
а не качество decision-моделей):
- A: qwen3.8-flash без рассуждения;
- B: qwen3.8-flash с рассуждением (reasoning.max_tokens ~1800, OpenRouter
  unified reasoning; поверх — штатный THINKING_TIME_CAP по времени);
- C: qwen3-30b-a3b-instruct-2507 без рассуждения (нерассуждающий референс).

Метрики хода: валидная первая попытка (исход done, ни одной ошибки
инструмента и ни одного срабатывания стражей — починок не понадобилось),
ошибки валидации, phantom/degrade-сигналы, латентность (wall time хода),
токены/стоимость (usage с usage.include — токены реальные; стоимость =
токены × тариф OpenRouter на 21.10.2026, usage.cost провайдер в стриме
не отдаёт).

Запуск: .venv-test/bin/python scripts/thinking_experiment.py [--k 3]
        [--arms A,B,C] [--scenarios name,...]
Требует ключ OpenRouter (env OPENROUTER_API_KEY или credentials.json).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import json as jsonlib  # алиас: в _RecClient.stream параметр json зашадоуил модуль
import statistics
import sys
import time
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
for p in (str(ROOT), str(ROOT / "scripts")):
    if p not in sys.path:
        sys.path.insert(0, p)

import httpx  # noqa: E402

import assistant_eval as ev  # noqa: E402  (фейк read/action tools)
from backend import remote_llm  # noqa: E402
from backend.assistant import agent  # noqa: E402

GUARD_TOOLS = ("phantom_guard", "degrade_guard", "retry", "steps")

# тарифы OpenRouter, USD за токен (снимок /api/v1/models от 21.10.2026)
PRICES = {
    "qwen/qwen3.8-flash": {"prompt": 0.00000015, "completion": 0.00000047},
    "qwen/qwen3-30b-a3b-instruct-2507": {"prompt": 0.00000009,
                                         "completion": 0.0000003},
}

FIXTURES = ROOT / "docs" / "evals" / "fixtures"

# Сценарии — одноходовки (user + snapshot). «validation_retry» — обязательный
# по протоколу сценарий «ретрай после ошибки валидации»: просьба ссылается на
# несуществующий №7 — модель либо заметит по снапшоту (первая попытка
# валидна), либо словит ошибку валидации и починится (первая попытка невалидна
# — это и измеряем).
SCENARIOS = [
    {"name": "text_answer", "snapshot": "snapshot_single.json",
     "user": "Что у меня сейчас на экране?"},
    {"name": "analyze_marks", "snapshot": "snapshot_single.json",
     "user": "Разбери мой последний прогон и скажи, что поправить."},
    {"name": "propose_decision", "snapshot": "snapshot_dup.json",
     "user": "Настрой правила решения: «Требует разбора», если по №2 «нет» "
             "от 60% или по №4 «Негативная» от 70%; «Качественно» — №1 «да» "
             "от 80% и балл №5 от 2."},
    {"name": "edit_split", "snapshot": "snapshot_dup.json",
     "user": "Разбей вопрос №4 на два: тональность и благодарность."},
    {"name": "validation_retry", "snapshot": "snapshot_dup.json",
     "user": "Собери правила: исход «Плохо», если по вопросу №7 «нет» "
             "больше 50%. Учти его в «Качественно» тоже."},
    {"name": "edit_add", "snapshot": "snapshot_dup.json",
     "user": "Добавь вопрос: клиент поблагодарил оператора в конце диалога?"},
    {"name": "trial_run", "snapshot": "snapshot_single.json",
     "user": "Прогони пробно вопросы №1–2, гипотеза — формулировка сроков "
             "слишком мягкая."},
    {"name": "snapshot_recall", "snapshot": "snapshot_dup.json",
     "user": "Напомни условия исхода «Качественно» и порог по вопросу №5."},
]


def _entry(key: str, api_model: str) -> SimpleNamespace:
    return SimpleNamespace(key=key, label=key, api="openrouter",
                           api_model=api_model, base_url=None)


ARMS = {
    # ключ записи с ключом в credentials.json; api_model — реальная модель
    "A": ("qwen3.8-flash, thinking off",
          _entry("remote-qwen3-8-flash-openrouter", "qwen/qwen3.8-flash"),
          False),
    "B": ("qwen3.8-flash, thinking on (reasoning.max_tokens 1800)",
          _entry("remote-qwen3-8-flash-openrouter", "qwen/qwen3.8-flash"),
          True),
    "C": ("qwen3-30b-a3b-instruct-2507, thinking off",
          _entry("remote-qwen3-8-flash-openrouter",
                 "qwen/qwen3-30b-a3b-instruct-2507"),
          False),
}

REASONING_MAX_TOKENS = 1800


# ------------------------------------------------------- запись usage/времени

class _RecClient(httpx.AsyncClient):
    """httpx.AsyncClient + запись usage-чанков и длительности каждого запроса
    (usage включается пробросом "usage": {"include": true} в payload — см.
    патч build_payload ниже; агент чужие поля/чанки без choices игнорирует)."""

    records: list[dict] = []

    def stream(self, method, url, json=None, **kwargs):
        rec = {"t0": time.monotonic(), "usage": None, "dt": None}
        _RecClient.records.append(rec)
        cm = super().stream(method, url, json=json, **kwargs)

        class _CM:
            async def __aenter__(self):
                resp = await cm.__aenter__()

                class _Resp:
                    status_code = resp.status_code

                    async def aread(self):
                        return await resp.aread()

                    async def aiter_lines(self):
                        async for line in resp.aiter_lines():
                            if line.startswith("data:"):
                                data = line[5:].strip()
                                if data and data != "[DONE]":
                                    try:
                                        chunk = jsonlib.loads(data)
                                    except jsonlib.JSONDecodeError:
                                        chunk = None
                                    if chunk and chunk.get("usage"):
                                        rec["usage"] = chunk["usage"]
                            yield line
                        rec["dt"] = time.monotonic() - rec["t0"]

                return _Resp()

            async def __aexit__(self, *a):
                return await cm.__aexit__(*a)

        return _CM()


_orig_build_payload = agent._RemoteTransport.build_payload


def _build_payload_with_usage(self, messages, final_step):
    payload = _orig_build_payload(self, messages, final_step)
    payload["usage"] = {"include": True}
    if self.thinking and self.entry.api == "openrouter":
        # плечо B: кап рассуждения по токенам (OpenRouter unified reasoning)
        payload["reasoning"] = {"max_tokens": REASONING_MAX_TOKENS}
    return payload


# ------------------------------------------------------------------- прогон

async def run_turn(entry, thinking: bool, user: str, snapshot: dict) -> dict:
    _RecClient.records = []
    events = []
    t0 = time.monotonic()
    gen = agent.run_remote_agent(
        [], user, snapshot, entry,
        read_tools=ev._read_tools(snapshot),
        action_tools=ev._action_tools(snapshot, {"ok": True}),
        thinking=thinking)
    async for line in gen:
        events.append(json.loads(line[len("data: "):]))
    wall = time.monotonic() - t0
    recs = list(_RecClient.records)

    tool_errors = [e for e in events
                   if e.get("type") == "tool" and e.get("status") == "error"]
    guards = [e["name"] for e in events
              if e.get("type") == "tool" and e.get("name") in GUARD_TOOLS]
    outcome = "error" if any(e.get("type") == "error" for e in events) \
        else "done" if any(e.get("type") == "done" for e in events) \
        else "incomplete"
    proposals = [(e.get("proposal") or {}).get("kind")
                 for e in events if e.get("type") == "proposal"]
    prompt_tokens = sum((r["usage"] or {}).get("prompt_tokens") or 0
                        for r in recs)
    completion_tokens = sum((r["usage"] or {}).get("completion_tokens") or 0
                            for r in recs)
    reasoning_tokens = sum((((r["usage"] or {}).get("completion_tokens_details")
                             or {}).get("reasoning_tokens")) or 0
                           for r in recs)
    price = PRICES.get(entry.api_model)
    cost = None
    if price:
        cost = prompt_tokens * price["prompt"] \
            + completion_tokens * price["completion"]
    return {
        "outcome": outcome,
        "valid_first_attempt": outcome == "done" and not tool_errors
        and not guards,
        "requests": len(recs),
        "tool_errors": len(tool_errors),
        "validation_errors": sum(
            1 for e in tool_errors if e.get("internal")),
        "guards": guards,
        "proposals": proposals,
        "trials": sum(1 for e in events if e.get("type") == "trial"),
        "wall_s": round(wall, 2),
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "reasoning_tokens": reasoning_tokens,
        "cost_usd": round(cost, 6) if cost is not None else None,
        "answer_chars": sum(len(e.get("text") or "")
                            for e in events if e.get("type") == "token"),
    }


async def main_async(args) -> int:
    arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    scenarios = [s for s in SCENARIOS
                 if not args.scenarios or s["name"] in args.scenarios.split(",")]
    for key in arms:
        if key not in ARMS:
            print(f"неизвестное плечо {key!r}, доступные: {sorted(ARMS)}")
            return 2
    if not remote_llm.has_key("openrouter",
                              ARMS[arms[0]][1].key):
        print("Нет ключа OpenRouter (env OPENROUTER_API_KEY или "
              "credentials.json) — live-прогон невозможен.")
        return 2

    agent.httpx.AsyncClient = _RecClient
    agent._RemoteTransport.build_payload = _build_payload_with_usage
    rows = []
    try:
        for key in arms:
            label, entry, thinking = ARMS[key]
            for scn in scenarios:
                snapshot = json.loads(
                    (FIXTURES / scn["snapshot"]).read_text(encoding="utf-8"))
                for i in range(args.k):
                    try:
                        r = await run_turn(entry, thinking, scn["user"],
                                           snapshot)
                    except Exception as e:  # noqa: BLE001 — честно фиксируем
                        r = {"outcome": f"exception: {e}",
                             "valid_first_attempt": False, "requests": 0,
                             "tool_errors": 0, "validation_errors": 0,
                             "guards": [], "proposals": [], "trials": 0,
                             "wall_s": 0, "prompt_tokens": 0,
                             "completion_tokens": 0, "reasoning_tokens": 0,
                             "cost_usd": None, "answer_chars": 0}
                    r.update({"arm": key, "scenario": scn["name"], "run": i + 1})
                    rows.append(r)
                    print(f"[{key}] {scn['name']} #{i + 1}: {r['outcome']}, "
                          f"1st_ok={r['valid_first_attempt']}, "
                          f"req={r['requests']}, err={r['tool_errors']}, "
                          f"guards={r['guards'] or '—'}, "
                          f"{r['wall_s']}s, tok={r['prompt_tokens']}+"
                          f"{r['completion_tokens']}"
                          f"(reasoning {r['reasoning_tokens']}), "
                          f"cost={r['cost_usd']}")
    finally:
        agent.httpx.AsyncClient = httpx.AsyncClient
        agent._RemoteTransport.build_payload = _orig_build_payload

    # ------------------------------------------------------------- сводка
    print("\n===== СВОДКА ПО ПЛЕЧАМ =====")
    for key in arms:
        label = ARMS[key][0]
        rs = [r for r in rows if r["arm"] == key]
        walls = sorted(r["wall_s"] for r in rs)
        p50 = statistics.median(walls)
        p95 = walls[min(len(walls) - 1, int(len(walls) * 0.95 + 0.9999) - 1)]
        pass3 = 0
        for scn in scenarios:
            srs = [r for r in rs if r["scenario"] == scn["name"]]
            if srs and all(r["valid_first_attempt"] for r in srs):
                pass3 += 1
        val_errors = sum(r["validation_errors"] for r in rs)
        phantom = sum(r["guards"].count("phantom_guard") for r in rs)
        degrade = sum(r["guards"].count("degrade_guard") for r in rs)
        timeouts = sum(1 for r in rs if r["outcome"] not in ("done",))
        tokens = sum(r["prompt_tokens"] + r["completion_tokens"] for r in rs)
        reasoning = sum(r["reasoning_tokens"] for r in rs)
        cost = sum(r["cost_usd"] or 0 for r in rs)
        n = len(rs)
        print(f"\nПлечо {key}: {label}")
        print(f"  ходов: {n}; pass^3: {pass3}/{len(scenarios)}; "
              f"valid-1st rate: "
              f"{sum(r['valid_first_attempt'] for r in rs)}/{n}")
        print(f"  ошибок валидации: {val_errors} "
              f"({val_errors / n:.2f}/ход); phantom_guard: {phantom}; "
              f"degrade_guard: {degrade}; не-done исходов: {timeouts}")
        print(f"  латентность хода: p50={p50:.1f}s p95={p95:.1f}s; "
              f"токены/ход: {tokens / n:.0f} (reasoning "
              f"{reasoning / n:.0f}); стоимость/ход: ${cost / n:.6f}, "
              f"всего ${cost:.4f}")

    out = ROOT / "docs" / "evals" / "results" / "thinking_experiment_raw.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    print(f"\nСырые данные: {out}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--k", type=int, default=3, help="прогонов на сценарий")
    ap.add_argument("--arms", default="A,B,C")
    ap.add_argument("--scenarios", default="",
                    help="имена через запятую (по умолчанию все)")
    args = ap.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
