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

test("decision: trace — детали условий для hit, default и «не определено»", async () => {
  await resetState();
  const d = { outcomes: [
    { id: "ban", label: "Забанить", color: "red", rules: [
      { anyOf: false, conditions: [{ question: "spam", answer: "yes", op: "gte", threshold: 0.6 }] },
      { anyOf: false, conditions: [
        { question: "spam", answer: "yes", op: "lt", threshold: 0.05 },
        { question: "quality", op: "gte", score: 1.5 }] },
    ] },
    { id: "man", label: "Ручная", color: "yellow", isDefault: true, rules: [] },
  ] };
  // hit по второму правилу: trace — оба проверенных правила, сработавшее последнее
  const r = decision.evaluateDecision(d, answers());
  eq(r.label, "Забанить");
  eq(r.ruleIdx, 1);
  eq(r.trace.length, 2, "оба проверенных правила в trace");
  assert(!r.trace[0].hit && r.trace[1].hit, "hit-флаги");
  const c0 = r.trace[0].conditions[0];
  eq(c0.ok, false, "первое условие не выполнено");
  eq(c0.kind, "prob");
  eq(c0.answer, "yes");
  eq(c0.value, 0.03, "фактическая вероятность");
  eq(c0.threshold, 0.6);
  eq(c0.op, "gte");
  const c1 = r.trace[1].conditions[1];
  eq(c1.kind, "score");
  eq(c1.value, 1.6, "фактический балл");
  eq(c1.threshold, 1.5);
  eq(c1.ok, true);
  // default: trace всех правил с hit:false
  const weak = answers({
    spam: { type: "yes_no", probabilities: { yes: 0.3, no: 0.7 } },
    quality: { type: "score", probabilities: {}, score: 1.0 },
  });
  const r2 = decision.evaluateDecision(d, weak);
  assert(r2.isDefault, "default-исход");
  eq(r2.trace.length, 2, "проверены все правила");
  assert(r2.trace.every(t => !t.hit), "ни одно не сработало");
  // без default → null, но explainDecision отдаёт полный trace
  const d2 = { outcomes: [d.outcomes[0]] };
  eq(decision.evaluateDecision(d2, weak), null, "не определено");
  const ex = decision.explainDecision(d2, weak);
  eq(ex.res, null);
  eq(ex.trace.length, 2, "trace для «не определено»");
  assert(ex.trace.every(t => !t.hit));
  // висячая ссылка / нет ответа → value null
  const d3 = { outcomes: [{ id: "x", label: "X", color: "gray", rules: [
    { anyOf: false, conditions: [{ question: "ghost", answer: "yes", op: "gte", threshold: 0.5 }] }] }] };
  const ex3 = decision.explainDecision(d3, answers());
  eq(ex3.trace[0].conditions[0].value, null, "нет ответа → value null");
  eq(ex3.trace[0].conditions[0].ok, false);
});

test("decision: describeDecision — наглядные тексты hover-объяснения", async () => {
  await resetState();
  const d = { outcomes: [
    { id: "pub", label: "Опубликовать", color: "green", rules: [{ anyOf: false, conditions: [
      { question: "spam", answer: "yes", op: "lt", threshold: 0.05 }] }] },
    { id: "man", label: "Ручная", color: "yellow", isDefault: true, rules: [] },
  ] };
  const qs = QS;
  // сработавшее правило: текст вопроса, ответ словом, факт vs порог
  const hit = decision.explainDecision(d, answers());
  const descHit = decision.describeDecision(hit.res, hit.trace, qs);
  eq(descHit.title, "Исход: Опубликовать");
  includes(descHit.lines.join("\n"), "Сработало правило №1");
  includes(descHit.lines.join("\n"), "✓ №1 «Спам?» → «да» 3% при пороге < 5%", "читаемая строка условия");
  // default: ключевые провалившиеся условия с именем исхода
  const def = decision.explainDecision(d, answers({ spam: { type: "yes_no", probabilities: { yes: 0.5, no: 0.5 } } }));
  const descDef = decision.describeDecision(def.res, def.trace, qs);
  eq(descDef.title, "Исход: Ручная (по умолчанию)");
  includes(descDef.lines.join("\n"), "Ни одно правило не сработало");
  includes(descDef.lines.join("\n"), "✗ №1 «Спам?» → «да» 50% при пороге < 5% — «Опубликовать»");
  // не определено
  const none = decision.explainDecision({ outcomes: [d.outcomes[0]] },
    answers({ spam: { type: "yes_no", probabilities: { yes: 0.5, no: 0.5 } } }));
  const descNone = decision.describeDecision(none.res, none.trace, qs);
  eq(descNone.title, "Решение не определено");
  includes(descNone.lines.join("\n"), "исход по умолчанию не задан");
  // score и нет ответа
  const dScore = { outcomes: [
    { id: "a", label: "А", color: "green", rules: rules(
      { question: "quality", op: "gte", score: 2 },
      { question: "ghost", answer: "yes", op: "gte", threshold: 0.5 }) },
  ] };
  const noneScore = decision.explainDecision(dScore, answers());
  const descScore = decision.describeDecision(noneScore.res, noneScore.trace, qs);
  includes(descScore.lines.join("\n"), "⚠ удалённый вопрос", "висячая ссылка помечена");
  includes(descScore.lines.join("\n"), "нет ответа (нужно P(да) ≥ 50%)");
  // структурированные items для вёрстки: ok — true/false у условий, null у вводных
  eq(descHit.items[0].ok, null, "вводная строка без маркера");
  eq(descHit.items[0].text, "Сработало правило №1:");
  eq(descHit.items[1].ok, true, "выполненное условие");
  eq(descHit.items[1].text, "№1 «Спам?» → «да» 3% при пороге < 5%", "текст без маркера");
  eq(descDef.items[1].ok, false, "проваленное условие");
  assert(descDef.items[1].text.endsWith("— «Опубликовать»"), "исход в хвосте строки");
  // lines — тот же контент с маркерами (обратная совместимость)
  eq(descHit.lines[1], "✓ " + descHit.items[1].text, "lines = маркер + текст");
});

test("decision: describeDecisionFull — все проверенные правила группами без лимита", async () => {
  await resetState();
  const d = { outcomes: [
    { id: "ban", label: "Бан", color: "red", rules: [
      { anyOf: false, conditions: [{ question: "spam", answer: "yes", op: "gte", threshold: 0.6 }] },
      { anyOf: false, conditions: [
        { question: "spam", answer: "yes", op: "lt", threshold: 0.05 },
        { question: "quality", op: "gte", score: 1.5 }] },
    ] },
    { id: "man", label: "Ручная", color: "yellow", isDefault: true, rules: [] },
  ] };
  // hit по второму правилу: обе проверенные группы, без обрезки условий
  const ex = decision.explainDecision(d, answers());
  const full = decision.describeDecisionFull(ex.res, ex.trace, QS);
  eq(full.title, "Исход: Бан");
  eq(full.note, null, "без примечания при hit");
  eq(full.groups.length, 2, "оба проверенных правила");
  eq(full.groups[0].hit, false, "первое правило не сработало");
  eq(full.groups[1].hit, true, "второе сработало");
  includes(full.groups[1].heading, "исход «Бан», правило №2");
  eq(full.groups[1].items.length, 2, "оба условия");
  eq(full.groups[1].items[0].ok, true);
  eq(full.groups[1].items[1].ok, true);
  // default: примечание + все провалившиеся правила
  const weak = answers({
    spam: { type: "yes_no", probabilities: { yes: 0.3, no: 0.7 } },
    quality: { type: "score", probabilities: {}, score: 1.0 },
  });
  const ex2 = decision.explainDecision(d, weak);
  const full2 = decision.describeDecisionFull(ex2.res, ex2.trace, QS);
  eq(full2.title, "Исход: Ручная (по умолчанию)");
  includes(full2.note, "по умолчанию");
  eq(full2.groups.length, 2, "оба провалившихся правила");
  assert(full2.groups.every(g => !g.hit), "ни одно не сработало");
  // «не определено» и пустой trace
  const ex3 = decision.explainDecision({ outcomes: [] }, weak);
  const full3 = decision.describeDecisionFull(ex3.res, ex3.trace, QS);
  eq(full3.title, "Решение не определено");
  includes(full3.note, "Правил с условиями нет");
  eq(full3.groups.length, 0);
});

test("decision: reorder вопросов не ломает правила и перенумеровывает объяснение", async () => {
  await resetState();
  const d = { outcomes: [
    { id: "pub", label: "Опубликовать", color: "green", rules: rules(
      { question: "spam", answer: "yes", op: "lt", threshold: 0.05 },
      { question: "quality", op: "gte", score: 1.5 }) },
    { id: "man", label: "Ручная", color: "yellow", isDefault: true, rules: [] },
  ] };
  const before = JSON.stringify(d);
  const qs1 = QS;
  const r1 = decision.evaluateDecision(d, answers());
  eq(r1.label, "Опубликовать", "исход до reorder");
  // reorder: качество становится №1, спам — №3 (условия по id — не меняются)
  const qs2 = [QS[2], QS[1], QS[0]];
  eq(JSON.stringify(d), before, "правила побайтово неизменны после reorder");
  const r2 = decision.evaluateDecision(d, answers());
  eq(r2.label, "Опубликовать", "тот же исход после reorder");
  const desc = decision.describeDecision(r2, r2.trace, qs2);
  includes(desc.lines.join("\n"), "№3 «Спам?»", "№ соответствует новому порядку");
  includes(desc.lines.join("\n"), "№1 «Качество?»", "перенумерация и для score");
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

test("decision: редактор — collapsed при загрузке, toggle, свотчи цвета", async () => {
  installDom(); await resetState();
  const { el } = await import("./dom-mock.mjs");
  el("div", { id: "decision-list" });
  el("div", { id: "decision-empty" });
  el("div", { id: "decision-hints" });
  state.questions = QS.map(q => ({ ...q }));
  // загрузка «пресета»: все заполненные исходы свёрнуты, включая default без правил
  decision.setDecision({ outcomes: [
    { label: "Опубликовать", color: "green", rules: [{ conditions: [{ question: "spam", answer: "yes", op: "gte", threshold: 0.9 }] }] },
    { label: "Корзина", color: "red", isDefault: true, rules: [] },
  ] });
  const list = document.getElementById("decision-list");
  const o1 = state.decision.outcomes[0];
  eq(o1.collapsed, true, "исход с правилами свёрнут");
  eq(state.decision.outcomes[1].collapsed, true, "исход без правил тоже свёрнут");
  const card1 = list.children[0];
  includes(card1.textContent, "Опубликовать", "label в свёрнутой шапке");
  includes(card1.textContent, "правил: 1", "счётчик правил");
  const dot = card1.querySelector(".outcome-dot");
  assert(dot, "точка цвета в свёрнутой шапке");
  eq(dot.style.background, decision.OUTCOME_COLORS.green.fg, "цвет точки");
  assert(!card1.querySelector(".rule-box"), "правила скрыты");
  // toggle разворачивает: свотчи вместо select
  card1.querySelector(".collapse-btn").fire("click");
  eq(o1.collapsed, false, "развёрнут по клику");
  const swatches = list.children[0].querySelectorAll(".color-swatch");
  eq(swatches.length, 6, "шесть свотчей");
  assert(swatches[0].classList.contains("active"), "текущий цвет выделен");
  eq(swatches[1].getAttribute("aria-label"), "красный", "aria-label цвета");
  swatches[2].fire("click");
  eq(o1.color, "yellow", "цвет сменился кликом по свотчу");
  assert(list.children[0].querySelectorAll(".color-swatch")[2].classList.contains("active"), "выделение переехало");
  // свернуть обратно — точка показывает новый цвет
  list.children[0].querySelector(".collapse-btn").fire("click");
  eq(list.children[0].querySelector(".outcome-dot").style.background, decision.OUTCOME_COLORS.yellow.fg, "точка нового цвета");
  // новый исход развёрнут; «свернуть все» — все свёрнуты
  decision.addOutcome();
  eq(state.decision.outcomes[2].collapsed, false, "новый исход развёрнут");
  decision.setAllOutcomesCollapsed(true);
  assert(state.decision.outcomes.every(o => o.collapsed), "все свёрнуты");
  decision.setAllOutcomesCollapsed(false);
  assert(state.decision.outcomes.every(o => !o.collapsed), "все развёрнуты");
});

test("decision: тумблер «Учитывать в прогоне» — дефолт включён, флаг пресета, запись в state", async () => {
  installDom(); await resetState();
  const { el } = await import("./dom-mock.mjs");
  el("div", { id: "decision-list" });
  el("div", { id: "decision-empty" });
  el("div", { id: "decision-hints" });
  const cb = el("input", { id: "decision-enabled" });
  decision.mountDecision({ enabledId: "decision-enabled" });
  eq(cb.checked, true, "без решения — включён");
  decision.setDecision({ enabled: false, outcomes: [
    { label: "А", color: "green", rules: [{ conditions: [{ question: "spam", answer: "yes", threshold: 0.5 }] }] },
  ] });
  eq(state.decision.enabled, false, "флаг enabled из пресета");
  eq(cb.checked, false, "чекбокс синхронизирован");
  cb.checked = true;
  cb.fire("change");
  eq(state.decision.enabled, true, "включили обратно");
  // без enabled в данных — дефолт true
  decision.setDecision({ outcomes: [{ label: "Б", color: "gray", rules: [] }] });
  eq(state.decision.enabled, true, "дефолт включён");
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
  // hover-объяснение «почему сработал исход» вместо нативного title
  const chipA = [...chips.querySelectorAll(".decision-chip")].find(c => c.textContent.includes("Model A"));
  eq(chipA.title, "", "нативного title нет (двойной тултип)");
  chipA.fire("mouseenter");
  const tip = document.body.querySelector(".dist-tip");
  assert(tip && !tip.classList.contains("hidden"), "тултип виден");
  includes(tip.textContent, "Исход: Опубликовать", "заголовок");
  includes(tip.textContent, "Сработало правило №1", "сработавшее правило");
  includes(tip.textContent, "✓ №1 «Ок?» → «да» 90% при пороге ≥ 80%", "условие: факт vs порог");
  chipA.fire("mouseleave");
  assert(tip.classList.contains("hidden"), "тултип скрыт при уходе");
  const chipB = [...chips.querySelectorAll(".decision-chip")].find(c => c.textContent.includes("Model B"));
  chipB.fire("mouseenter");
  includes(tip.textContent, "Исход: Забанить (по умолчанию)", "default-заголовок");
  includes(tip.textContent, "✗ №1 «Ок?» → «да» 50% при пороге ≥ 80%", "проваленное условие");
  includes(tip.textContent, "Клик — подробное объяснение", "подсказка про клик");
  chipB.fire("mouseleave");
  // клик по чипу — полный оверлей «как получилось решение»
  chipA.fire("click");
  const ov = document.body.querySelector(".decision-overlay");
  assert(ov && !ov.classList.contains("hidden"), "оверлей открыт кликом");
  includes(ov.textContent, "Model A", "модель в заголовке оверлея");
  includes(ov.textContent, "Исход: Опубликовать", "исход в оверлее");
  includes(ov.textContent, "Сработало — исход «Опубликовать», правило №1", "группа сработавшего правила");
  includes(ov.textContent, "✓ №1 «Ок?» → «да» 90% при пороге ≥ 80%", "условие в оверлее");
  eq(ov.querySelectorAll(".dec-group").length, 1, "одна проверенная группа (trace обрывается на hit)");
  ov.querySelector(".decision-overlay-close").fire("click");
  assert(ov.classList.contains("hidden"), "оверлей закрыт кнопкой");
  // оверлей для default-исхода: примечание + провалившееся правило
  chipB.fire("click");
  includes(ov.textContent, "Исход: Забанить (по умолчанию)", "default в оверлее");
  includes(ov.textContent, "Ни одно правило не сработало", "примечание default");
  includes(ov.textContent, "Не сработало — исход «Опубликовать», правило №1", "провалившаяся группа");
  ov.querySelector(".decision-overlay-close").fire("click");
  // выключенное решение (enabled:false) — чипов нет
  state.results.decision = { ...d, enabled: false };
  results.renderResults();
  assert(document.getElementById("decision-chips").classList.contains("hidden"), "enabled:false — скрыто");
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
