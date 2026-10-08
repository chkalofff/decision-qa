// Доменные тесты: decision (движок правил решения, подсказки, валидация).

import { test, assert, eq, includes, throws, installDom, resetState, state } from "./harness.mjs";
import * as decision from "../static/decision.js";

const QS = [
  { id: "spam", question: "Спам?", type: "yes_no" },
  { id: "topic", question: "Тема?", type: "choice", options: [{ name: "Продажа" }, { name: "Услуга" }] },
  { id: "quality", question: "Качество?", type: "score", levels: ["плохо", "норм", "отлично"] },
];

function answers(over = {}) {
  return {
    spam: { type: "yes_no", probabilities: { yes: 0.03, no: 0.97 } },
    topic: { type: "choice", probabilities: { "Продажа": 0.9, "Услуга": 0.1 }, choice: "Продажа" },
    quality: { type: "score", probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 }, score: 1.6 },
    ...over,
  };
}

function rules(...conds) {
  return [{ anyOf: false, conditions: conds }];
}

// ================================================================ evaluateDecision

test("decision: evaluate — пороги вероятности (gte/lt), И внутри правила", async () => {
  await resetState();
  const d = { outcomes: [
    { id: "ok", label: "Опубликовать", color: "green", rules: rules(
      { question: "spam", answer: "yes", op: "lt", threshold: 0.05 },
      { question: "topic", answer: "Продажа", op: "gte", threshold: 0.85 }) },
  ] };
  const r = decision.evaluateDecision(d, answers());
  eq(r.label, "Опубликовать", "правило сработало");
  eq(r.ruleIdx, 0);
  // спам выше порога → не сработало
  eq(decision.evaluateDecision(d, answers({ spam: { type: "yes_no", probabilities: { yes: 0.2, no: 0.8 } } })), null);
  // topic ниже порога → не сработало
  eq(decision.evaluateDecision(d, answers({ topic: { type: "choice", probabilities: { "Продажа": 0.7, "Услуга": 0.3 } } })), null);
});

test("decision: evaluate — anyOf (ИЛИ), приоритет исходов, default, score по среднему", async () => {
  await resetState();
  const d = { outcomes: [
    { id: "ban", label: "Забанить", color: "red", rules: [{ anyOf: true, conditions: [
      { question: "spam", answer: "yes", op: "gte", threshold: 0.6 },
      { question: "quality", op: "lt", score: 1 },           // средний балл < 1
    ] }] },
    { id: "pub", label: "Опубликовать", color: "green", rules: rules(
      { question: "spam", answer: "yes", op: "lt", threshold: 0.05 }) },
    { id: "manual", label: "Ручная проверка", color: "yellow", isDefault: true, rules: [] },
  ] };
  // ban не сработал (спам 3%, балл 1.6), pub сработал
  eq(decision.evaluateDecision(d, answers()).label, "Опубликовать");
  // спам высокий → ban (приоритет выше pub)
  const r2 = decision.evaluateDecision(d, answers({ spam: { type: "yes_no", probabilities: { yes: 0.8, no: 0.2 } } }));
  eq(r2.label, "Забанить", "первый исход в приоритете");
  // низкий балл → ban через ИЛИ по score
  const r3 = decision.evaluateDecision(d, answers({ quality: { type: "score", probabilities: {}, score: 0.4 } }));
  eq(r3.label, "Забанить", "ИЛИ: score-условие");
  // ничего не сработало → default
  const r4 = decision.evaluateDecision(d, answers({
    spam: { type: "yes_no", probabilities: { yes: 0.3, no: 0.7 } },
    topic: { type: "choice", probabilities: { "Продажа": 0.5, "Услуга": 0.5 } },
  }));
  eq(r4.label, "Ручная проверка", "default-исход");
  assert(r4.isDefault, "помечен как default");
  // без default → null («не определено»)
  const d2 = { outcomes: d.outcomes.slice(0, 2) };
  eq(decision.evaluateDecision(d2, answers({
    spam: { type: "yes_no", probabilities: { yes: 0.3, no: 0.7 } },
  })), null, "без default — не определено");
  // висячая ссылка / нет ответа → условие не выполнено
  const d3 = { outcomes: [{ id: "x", label: "X", color: "gray", rules: rules(
    { question: "ghost", answer: "yes", op: "gte", threshold: 0.5 }) }] };
  eq(decision.evaluateDecision(d3, answers()), null, "висячая ссылка не срабатывает");
});

// ================================================================ hints / validate

test("decision: hints — нет default, пустой исход, висячие ссылки, неиспользуемые вопросы", async () => {
  await resetState();
  const d = { outcomes: [
    { id: "a", label: "А", color: "green", rules: rules(
      { question: "spam", answer: "yes", op: "gte", threshold: 0.6 },
      { question: "ghost", answer: "yes", op: "gte", threshold: 0.5 }) },
    { id: "b", label: "Б", color: "red", rules: [] },
  ] };
  const hints = decision.decisionHints(d, QS).join("\n");
  includes(hints, "Нет исхода по умолчанию");
  includes(hints, "«Б» не содержит правил");
  includes(hints, "удалённый вопрос");
  includes(hints, "Не используются в правилах");
  // ответ, которого нет у вопроса
  const d2 = { outcomes: [{ id: "a", label: "А", color: "green", isDefault: true, rules: rules(
    { question: "topic", answer: "Нет такой", op: "gte", threshold: 0.5 }) }] };
  includes(decision.decisionHints(d2, QS).join("\n"), "нет ответа «Нет такой»");
  // пустой decision → без подсказок
  eq(decision.decisionHints(null, QS).length, 0);
});

test("decision: validate — ошибки с понятным текстом, пустое решение валидно", async () => {
  await resetState();
  decision.validateDecision(null, QS);
  decision.validateDecision({ outcomes: [] }, QS);
  const good = { outcomes: [
    { id: "a", label: "А", color: "green", rules: rules(
      { question: "spam", answer: "yes", op: "lt", threshold: 0.05 },
      { question: "quality", op: "gte", score: 1.5 }) },
    { id: "b", label: "Б", color: "gray", isDefault: true, rules: [] },
  ] };
  decision.validateDecision(good, QS);
  throws(() => decision.validateDecision({ outcomes: [
    { id: "a", label: "А", color: "green", rules: rules({ question: "spam", answer: "yes", threshold: 1.5 }) },
  ] }, QS), "порог вероятности 0–100%", "порог > 1");
  throws(() => decision.validateDecision({ outcomes: [
    { id: "a", label: "А", color: "green", rules: rules({ question: "quality", op: "gte", score: 5 }) },
  ] }, QS), "0..2", "score вне диапазона шкалы");
  throws(() => decision.validateDecision({ outcomes: [
    { id: "a", label: "А", color: "green", isDefault: true, rules: [] },
    { id: "b", label: "Б", color: "red", isDefault: true, rules: [] },
  ] }, QS), "только один", "два default");
  throws(() => decision.validateDecision({ outcomes: [
    { id: "a", label: "А", color: "green", rules: rules({ question: "ghost", answer: "yes", threshold: 0.5 }) },
  ] }, QS), "вопрос не найден", "висячая ссылка");
  throws(() => decision.validateDecision({ outcomes: [
    { id: "a", label: "", color: "green", rules: [] },
  ] }, QS), "пустое название", "пустой label");
});

test("decision: редактор — карточка исхода, условия по типу вопроса, hint-полоса", async () => {
  installDom(); await resetState();
  const { el } = await import("./dom-mock.mjs");
  el("div", { id: "decision-list" });
  el("div", { id: "decision-empty" });
  el("div", { id: "decision-hints" });
  state.questions = QS.map(q => ({ ...q }));
  decision.mountDecision();
  decision.addOutcome();
  const list = document.getElementById("decision-list");
  eq(list.querySelectorAll(".outcome-card").length, 1, "карточка исхода");
  assert(document.getElementById("decision-empty").classList.contains("hidden"), "empty скрыт");
  includes(document.getElementById("decision-hints").textContent, "Нет исхода по умолчанию", "hint про default");
  // условие привязали к yes_no-вопросу → селектор P(да)/P(нет)
  const o = state.decision.outcomes[0];
  o.label = "Опубликовать";
  const c = o.rules[0].conditions[0];
  c.question = "spam";
  decision.renderDecision();
  const ansSel = list.querySelector(".cond-answer");
  includes(ansSel.textContent, "P(да)", "yes_no — варианты да/нет");
  // переключили на score-вопрос → «средний балл», без селектора ответа
  c.question = "quality"; delete c.answer; delete c.threshold; c.score = 1.5;
  decision.renderDecision();
  includes(list.textContent, "средний балл", "score — средний балл");
  assert(!list.querySelector(".cond-answer"), "score — без селектора ответа");
  // default-чекбокс снимает подсказку
  o.isDefault = true;
  decision.renderDecision();
  notIncludes0(document.getElementById("decision-hints").textContent, "Нет исхода по умолчанию");
});

function notIncludes0(hay, needle) {
  if (String(hay).includes(needle)) throw new Error(`«${needle}» найдено в «${String(hay).slice(0, 200)}»`);
}

test("decision: чипы решений в одиночных результатах, расхождение моделей", async () => {
  installDom(); await resetState();
  const { domResults } = await import("./harness.mjs");
  const results = (await import("../static/results.js"));
  domResults();
  state.models = [
    { key: "mA", label: "Model A", status: "running" },
    { key: "mB", label: "Model B", status: "running" },
  ];
  const d = { outcomes: [
    { id: "o1", label: "Опубликовать", color: "green", rules: [{ anyOf: false, conditions: [
      { question: "q1", answer: "yes", op: "gte", threshold: 0.8 }] }] },
    { id: "o2", label: "Забанить", color: "red", isDefault: true, rules: [] },
  ] };
  const ans = (yes) => ({ type: "yes_no", probabilities: { yes, no: 1 - yes } });
  state.results = {
    results: { mA: { ok: true, answers: { q1: ans(0.9) } }, mB: { ok: true, answers: { q1: ans(0.5) } } },
    order: ["mA", "mB"], runMode: "decisions",
    questions: [{ id: "q1", question: "Ок?", type: "yes_no" }],
    decision: d,
  };
  results.renderResults();
  const chips = document.getElementById("decision-chips");
  assert(!chips.classList.contains("hidden"), "баннер решений виден");
  includes(chips.textContent, "Model A: Опубликовать", "решение A");
  includes(chips.textContent, "Model B: Забанить", "решение B — default");
  includes(chips.textContent, "⚡ решения различаются", "расхождение");
  // без правил — баннер скрыт
  state.results.decision = null;
  results.renderResults();
  assert(document.getElementById("decision-chips").classList.contains("hidden"), "без правил скрыт");
});

test("decision: normalizeDecision/setDecision — дефолты, цвет, state", async () => {
  installDom(); await resetState();
  decision.setDecision({ outcomes: [
    { label: "Икс", color: "нецвет", rules: [{ conditions: [{ question: "spam", answer: "yes", op: "bad", threshold: "0.5" }] }] },
  ] });
  const o = state.decision.outcomes[0];
  assert(o.id, "id сгенерирован");
  eq(o.color, "gray", "неизвестный цвет → gray");
  eq(o.rules[0].anyOf, false, "anyOf по умолчанию И");
  eq(o.rules[0].conditions[0].op, "gte", "неизвестный op → gte");
  eq(o.rules[0].conditions[0].threshold, 0.5, "threshold → число");
  decision.setDecision(null);
  eq(state.decision.outcomes.length, 0, "null → пустое решение");
});
