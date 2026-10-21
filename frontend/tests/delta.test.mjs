// Доменные тесты: delta (движок мгновенной дельты правок правил, v0.7).
// DOM не нужен: движок чистый (state + decision.js).

import { test, assert, eq, includes, resetState, state, ansYesNo, runRes } from "./harness.mjs";
import { ruleDelta, decisionFromProposal } from "../static/delta.js";

// Фикстура: single-прогон mA по q1/q2 + правила «Эскалация» (q1 да ≥ 50%)
// / default «В архив»; пометки на исходах.
function setupSingle() {
  state.questions = [
    { id: "q1", question: "Есть ли жалоба?", type: "yes_no" },
    { id: "q2", question: "Раздражение", type: "score" },
  ];
  state.decision = {
    enabled: true,
    outcomes: [
      { id: "o1", label: "Эскалация", color: "red",
        rules: [{ anyOf: false, conditions: [{ question: "q1", answer: "yes", op: "gte", threshold: 0.5 }] }] },
      { id: "o2", label: "В архив", color: "gray", isDefault: true, rules: [] },
    ],
  };
  state.results = {
    results: {
      mA: runRes({}, { q1: ansYesNo(0.4, 0.6) }),  // 40% < 50% → «В архив»
      mB: runRes({}, { q1: ansYesNo(0.8, 0.2) }),  // 80% → «Эскалация»
    },
    order: ["mA", "mB"], runMode: "decisions",
    questions: state.questions, decision: state.decision,
    marks: [
      { id: "m1", target: { scope: "single", model: "mA", mode: "decisions", decision: true },
        verdict: "reject", comment: "это была эскалация" },   // «В архив» неверно
      { id: "m2", target: { scope: "single", model: "mB", mode: "decisions", decision: true },
        verdict: "accept", comment: "" },                     // «Эскалация» верно
      { id: "m3", target: { scope: "single", model: "mA", mode: "decisions", question: "q1" },
        verdict: "reject", comment: "пометка ответа — не в счёт" },
    ],
  };
}

// Предложение: понизить порог 50% → 30% (propose_decision payload, вопросы по
// id — контракт A3, пороги в %).
function proposedPayload(thrPct) {
  return { outcomes: [
    { label: "Эскалация", color: "red",
      rules: [{ conditions: [{ question: "q1", answer: "yes", op: "gte", threshold: thrPct }] }] },
    { label: "В архив", isDefault: true },
  ] };
}

test("delta: конвертация propose_decision — id насквозь, пороги % → 0..1, ошибки", async () => {
  await resetState();
  state.questions = [{ id: "q1", question: "Ок?", type: "yes_no" }];
  const d = decisionFromProposal(proposedPayload(30), state.questions);
  eq(d.outcomes[0].rules[0].conditions[0].question, "q1", "id вопроса — без трансляции");
  eq(d.outcomes[0].rules[0].conditions[0].threshold, 0.3, "30% → 0.3");
  eq(d.outcomes[1].isDefault, true, "default сохранён");
  assertThrowsDecision({ outcomes: [{ label: "X", rules: [{ conditions: [{ question: "q9", answer: "yes" }] }] }] },
    "несуществующий id q9");
  assertThrowsDecision({ outcomes: [] }, "нет исходов");
});

function assertThrowsDecision(payload, msg) {
  let err = null;
  try { decisionFromProposal(payload, state.questions); } catch (e) { err = e; }
  assert(err, `брошена ошибка: ${msg}`);
  includes(err.message, msg.includes("q9") ? "вопрос не найден" : "исходов", msg);
}

test("delta: ruleDelta — исправленные/сломанные исходы по пометкам решений", async () => {
  await resetState(); setupSingle();
  // порог 30%: mA (40%) → «Эскалация» (было «В архив», пометка ✗ → исправлено),
  // mB (80%) → «Эскалация» без изменений (✓ остаётся верной)
  const proposed = decisionFromProposal(proposedPayload(30), state.questions);
  const d = ruleDelta(proposed);
  assert(d, "дельта посчитана");
  eq(d.total, 2, "только пометки исходов (ответы — не в счёт)");
  eq(d.errorsBefore, 1, "✗ до");
  eq(d.fixed, 1, "✗ исправлено сменой исхода");
  eq(d.broken, 0, "✓ не сломана");
  eq(d.errorsAfter, 0, "ошибок после: 0");
  eq(d.stale, false, "не stale");
  // порог 90%: mB (80%) → «В архив» (✓ сломана), mA — «В архив» без изменений
  const worse = ruleDelta(decisionFromProposal(proposedPayload(90), state.questions));
  eq(worse.broken, 1, "сломанная ✓ считается");
  eq(worse.errorsAfter, 2, "ошибок после: старая ✗ + новая от сломанной ✓");
  eq(worse.fixed, 0, "ничего не исправлено");
});

test("delta: batch-решения, runMode both, stale-гейт, пустые случаи", async () => {
  await resetState();
  state.questions = [{ id: "q1", question: "Ок?", type: "yes_no" }];
  state.decision = {
    enabled: true,
    outcomes: [
      { id: "o1", label: "Эскалация", color: "red",
        rules: [{ anyOf: false, conditions: [{ question: "q1", answer: "yes", op: "gte", threshold: 0.5 }] }] },
      { id: "o2", label: "В архив", color: "gray", isDefault: true, rules: [] },
    ],
  };
  // пакет: файл f1 mA — 40% («В архив», помечен ✗), f2 mA — 90% («Эскалация», ✓)
  state.batch.decision = state.decision;
  state.batch.results = {
    f1: { mA: runRes({}, { q1: ansYesNo(0.4, 0.6) }) },
    f2: { mA: runRes({}, { q1: ansYesNo(0.9, 0.1) }) },
  };
  state.batch.marks = [
    { id: "b1", target: { scope: "batch", file: "f1", model: "mA", decision: true }, verdict: "reject" },
    { id: "b2", target: { scope: "batch", file: "f2", model: "mA", decision: true }, verdict: "accept" },
    { id: "b3", target: { scope: "batch", file: "f1" }, verdict: "reject" }, // файл целиком — не в счёт
  ];
  const d = ruleDelta(decisionFromProposal(proposedPayload(30), state.questions));
  eq(d.total, 2, "batch: только ячеечные пометки исходов");
  eq(d.fixed, 1, "f1 исправлен");
  eq(d.errorsAfter, 0, "f2 не сломан");
  eq(d.cells[0].before, "В архив", "before из снапшота правил прогона");
  eq(d.cells[0].after, "Эскалация", "after по предложенным правилам");
  // stale-флаг пакета
  state.batch.resultsStale = true;
  eq(ruleDelta(decisionFromProposal(proposedPayload(30), state.questions)).stale, true,
    "stale-разметка — stale-дельта");
  state.batch.resultsStale = false;
  // runMode both: пометка решения с mode=fast_batch читает fast_batch-ответы
  state.batch.marks = []; state.batch.results = {}; // batch-фаза закончена
  state.results = {
    results: {
      mA: {
        decisions: runRes({}, { q1: ansYesNo(0.4, 0.6) }),
        fast_batch: runRes({}, { q1: ansYesNo(0.9, 0.1) }),
      },
    },
    order: ["mA"], runMode: "both",
    questions: state.questions, decision: state.decision,
    marks: [{ id: "m9", target: { scope: "single", model: "mA", mode: "fast_batch", decision: true },
      verdict: "accept" }],
  };
  const both = ruleDelta(decisionFromProposal(proposedPayload(95), state.questions));
  eq(both.broken, 1, "both: пересчёт по ответам fast_batch (90% < 95% → сломана)");
  // пустые случаи
  await resetState();
  state.questions = [{ id: "q1", question: "Ок?", type: "yes_no" }];
  eq(ruleDelta(decisionFromProposal(proposedPayload(30), state.questions)), null,
    "нет результатов — нет дельты");
  state.results = { results: { mA: runRes({}, { q1: ansYesNo(0.5, 0.5) }) },
    order: ["mA"], runMode: "decisions", questions: state.questions,
    decision: state.decision, marks: [] };
  eq(ruleDelta(decisionFromProposal(proposedPayload(30), state.questions)), null,
    "нет пометок исходов — нет дельты");
});
