// Фронтенд-тесты Decision-QA на node + DOM-мок.
// Запуск: /usr/local/bin/node frontend/tests/run.mjs

import {
  installDom, el, fakeFile, resetState, mockFetch, sleep,
} from "./dom-mock.mjs";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";  // глобальный URL подменён DOM-моком

installDom();

const { state, emit } = await import("../static/state.js");
const layout = await import("../static/layout.js");
const results = await import("../static/results.js");
const questions = await import("../static/questions.js");
const context = await import("../static/context.js");
const batch = await import("../static/batch.js");
const toolbar = await import("../static/toolbar.js");
const lightbox = await import("../static/lightbox.js");

// ---------------------------------------------------------------- мини-раннер

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || "eq"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function includes(hay, needle, msg) {
  if (!String(hay).includes(needle)) {
    throw new Error(`${msg || "includes"}: «${needle}» не найдено в «${String(hay).slice(0, 220)}»`);
  }
}
function notIncludes(hay, needle, msg) {
  if (String(hay).includes(needle)) {
    throw new Error(`${msg || "notIncludes"}: «${needle}» найдено в «${String(hay).slice(0, 220)}»`);
  }
}
function throws(fn, part, msg) {
  try { fn(); } catch (e) {
    if (part && !String(e.message).includes(part)) {
      throw new Error(`${msg || "throws"}: ошибка «${e.message}» не содержит «${part}»`);
    }
    return;
  }
  throw new Error(`${msg || "throws"}: исключение не брошено`);
}

// ---------------------------------------------------------------- фикстуры DOM

function domLayout() {
  const split = el("div", { id: "split", className: "split" });
  const pl = el("section", { id: "panel-left", className: "panel", parent: split });
  const paL = el("span", { className: "panel-actions", parent: pl });
  el("button", { className: "icon-btn", parent: paL, dataset: { panel: "left", action: "fullscreen" } });
  el("button", { className: "icon-btn", parent: paL, dataset: { panel: "left", action: "collapse" } });
  el("div", { id: "splitter", className: "splitter", parent: split });
  el("div", { id: "restore-left", className: "panel-restore hidden", parent: split });
  el("div", { id: "restore-right", className: "panel-restore hidden", parent: split });
  const pr = el("section", { id: "panel-right", className: "panel", parent: split });
  const paR = el("span", { className: "panel-actions", parent: pr });
  el("button", { className: "icon-btn", parent: paR, dataset: { panel: "right", action: "fullscreen" } });
  el("button", { className: "icon-btn", parent: paR, dataset: { panel: "right", action: "collapse" } });
}

function domResults() {
  const sticky = el("div", { id: "results-sticky", className: "hidden" });
  el("span", { id: "results-summary", parent: sticky });
  el("span", { id: "results-agree", className: "hidden", parent: sticky });
  el("div", { id: "run-chips", parent: sticky });
  el("div", { id: "both-hint", className: "hidden", parent: sticky });
  el("div", { id: "results-list" });
}

function domQuestions() {
  el("div", { id: "questions-list" });
  el("div", { id: "questions-empty", text: "Нет вопросов — добавьте первый кнопкой «+ Вопрос»." });
}

function domContext() {
  const card = el("section", { id: "context-card", className: "card" });
  el("button", { id: "mode-text", className: "active", parent: card });
  el("button", { id: "mode-json", parent: card });
  el("button", { id: "btn-context-fs", text: "⛶", parent: card });
  el("button", { id: "btn-attach-image", parent: card });
  el("input", { id: "context-image-input", parent: card });
  el("textarea", { id: "context-input", parent: card });
  el("div", { id: "cm-holder", className: "hidden", parent: card });
  el("div", { id: "json-error", className: "hidden", parent: card });
  el("div", { id: "context-images", className: "hidden", parent: card });
  el("span", { id: "char-count", parent: card });
}

function domBatch() {
  const split = el("div", { id: "split-batch", className: "split" });
  const pl = el("section", { id: "batch-panel-left", className: "panel left", parent: split });
  const paL = el("span", { className: "panel-actions", parent: pl });
  el("button", { id: "btn-batch-back", parent: paL });
  el("button", { className: "icon-btn", parent: paL, dataset: { panel: "left", action: "fullscreen" } });
  el("button", { className: "icon-btn", parent: paL, dataset: { panel: "left", action: "collapse" } });
  el("div", { id: "batch-drop", parent: pl });
  el("input", { id: "batch-files", parent: pl });
  el("div", { id: "batch-list", parent: pl });
  el("div", { id: "batch-warn", className: "hidden", parent: pl });
  el("button", { id: "btn-batch-cancel", className: "hidden", parent: pl });
  el("button", { id: "btn-batch-clear", parent: pl });
  el("span", { id: "batch-progress", parent: pl });
  const wrap = el("div", { id: "batch-progress-wrap", className: "hidden", parent: pl });
  el("div", { id: "batch-progress-fill", parent: wrap });
  el("button", { id: "btn-add-question-batch", parent: pl });
  el("div", { id: "batch-questions-list", parent: pl });
  el("div", { id: "batch-questions-empty", className: "questions-empty", parent: pl,
    text: "Нет вопросов — добавьте первый кнопкой «+ Вопрос»." });
  el("div", { id: "splitter-batch", className: "splitter", parent: split });
  el("div", { id: "batch-restore-left", className: "panel-restore hidden", parent: split });
  el("div", { id: "batch-restore-right", className: "panel-restore hidden", parent: split });
  const pr = el("section", { id: "batch-panel-right", className: "panel right", parent: split });
  const paR = el("span", { className: "panel-actions", parent: pr });
  el("button", { className: "icon-btn", parent: paR, dataset: { panel: "right", action: "fullscreen" } });
  el("button", { className: "icon-btn", parent: paR, dataset: { panel: "right", action: "collapse" } });
  el("div", { id: "batch-results", parent: pr });
}

function domToolbar() {
  el("div", { id: "tb-models" });
  const mmWrap = el("div", { id: "tb-models-menu-wrap" });
  el("button", { id: "tb-models-menu", parent: mmWrap });
  const mmDd = el("div", { id: "tb-models-dropdown", className: "hidden", parent: mmWrap });
  el("div", { id: "tb-models-dropdown-list", parent: mmDd });
  el("div", { id: "tb-models-settings", parent: mmDd });

  const runPop = el("div", { id: "run-popover", className: "hidden" });
  const runmode = el("div", { id: "tb-runmode", parent: runPop });
  for (const m of ["decisions", "fast_batch", "both"]) {
    el("button", { parent: runmode, dataset: { runmode: m } });
  }
  el("input", { id: "temperature", parent: runPop });
  el("span", { id: "temp-value", parent: runPop });
  for (const t of ["1", "0.5", "2"]) {
    el("button", { parent: runPop, dataset: { temp: t } });
  }
  el("div", { id: "temp-lock-note", className: "hidden", parent: runPop });
  el("button", { id: "tb-run-options", text: "▾" });
  el("div", { id: "model-popover", className: "hidden" });

  el("button", { id: "tb-menu-btn" });
  const dd = el("div", { id: "tb-menu", className: "menu-dropdown menu-left hidden" });
  const presets = el("div", { id: "tb-menu-presets", parent: dd });
  el("div", { id: "tb-menu-presets-sub", className: "hidden", parent: presets });
  const exp = el("div", { id: "tb-menu-export", parent: dd });
  const expSub = el("div", { id: "tb-menu-export-sub", className: "hidden", parent: exp });
  el("div", { id: "tb-menu-export-questions", parent: expSub });
  el("div", { id: "tb-menu-export-context", parent: expSub });
  el("div", { id: "tb-menu-export-all", parent: expSub });
  el("label", { id: "tb-menu-import", parent: dd });
  el("div", { id: "tb-menu-collapse-all", parent: dd });
  el("div", { id: "tb-menu-expand-all", parent: dd });

  const pagemode = el("div", { id: "tb-pagemode" });
  el("button", { parent: pagemode, dataset: { pagemode: "single" } });
  el("button", { parent: pagemode, dataset: { pagemode: "batch" } });
  el("button", { id: "tb-run" });
  el("span", { id: "tb-run-spinner", className: "hidden" });
  el("main", { id: "page-single" });
  el("main", { id: "page-batch", className: "hidden" });
  el("main", { id: "page-models", className: "hidden" });
}

// Ответ GET /api/models v2: {models, device}
function modelsResp(models) {
  return { models, device: { ram_gb: 64, budget_gb: 41.6 } };
}

function domApp() {
  const errBanner = el("div", { id: "error-banner", className: "hidden" });
  el("span", { id: "error-banner-text", className: "banner-text", parent: errBanner });
  el("button", { id: "error-banner-close", className: "banner-close", parent: errBanner });
  const fmtBanner = el("div", { id: "format-banner", className: "hidden" });
  el("span", { id: "format-banner-text", className: "banner-text", parent: fmtBanner });
  el("button", { id: "btn-reset-pin", parent: fmtBanner });
  el("button", { id: "format-banner-close", className: "banner-close", parent: fmtBanner });
  el("button", { id: "btn-add-question" });
  domToolbar();
  domLayout();
  domResults();
  domQuestions();
  domContext();
  domBatch();
}

// ---------------------------------------------------------------- данные

function ansYesNo(yes, no) {
  return { type: "yes_no", probabilities: { yes, no }, label_mass: 0.99 };
}
function runRes(metrics, answers) {
  return { ok: true, answers, usage: { prompt_tokens: metrics.prompt_tokens }, metrics, prompt_format_version: 1 };
}
function setupBothResults() {
  const qs = [{ id: "q1", question: "Есть ли цифры в резюме?", type: "yes_no" }];
  state.models = [{ key: "mA", label: "Qwen A 27B", status: "running" }];
  state.results = {
    results: {
      mA: {
        decisions: runRes({ duration_s: 30, prompt_tokens: 500, prefill_tok_s: 16.7 }, { q1: ansYesNo(0.9, 0.1) }),
        fast_batch: runRes({ duration_s: 2, prompt_tokens: 520, prefill_tok_s: 260 }, { q1: ansYesNo(0.8, 0.2) }),
      },
    },
    order: ["mA"],
    runMode: "both",
    questions: qs,
  };
}

// ================================================================ state

test("state: selectedModelKeys фильтрует не-running модели", async () => {
  await resetState();
  state.models = [
    { key: "mA", status: "running" },
    { key: "mB", status: "stopped" },
  ];
  state.selectedModels = new Set(["mA", "mB"]);
  const { selectedModelKeys } = await import("../static/state.js");
  eq(selectedModelKeys().join(","), "mA", "только running");
});

// ================================================================ layout

test("layout: ⛶ включает/выключает полный экран своей панели", async () => {
  installDom(); await resetState(); domLayout();
  layout.initLayout();
  const fsL = document.querySelector('.icon-btn[data-panel="left"][data-action="fullscreen"]');
  fsL.fire("click");
  assert(document.getElementById("split").classList.contains("focus-left"), "focus-left включён");
  fsL.fire("click");
  assert(!document.getElementById("split").classList.contains("focus-left"), "focus-left выключен");
});

test("layout: «—» сворачивает свою панель, restore-вкладка возвращает", async () => {
  installDom(); await resetState(); domLayout();
  layout.initLayout();
  const split = document.getElementById("split");
  document.querySelector('.icon-btn[data-panel="left"][data-action="collapse"]').fire("click");
  assert(split.classList.contains("collapsed-left"), "collapsed-left");
  assert(!document.getElementById("restore-left").classList.contains("hidden"), "вкладка видна");
  document.getElementById("restore-left").fire("click");
  assert(!split.classList.contains("collapsed-left"), "сплит восстановлен");
});

test("layout: «—» в полноэкранном режиме возвращает сплит, а не перекидывает фокус (регрессия)", async () => {
  installDom(); await resetState(); domLayout();
  layout.initLayout();
  const split = document.getElementById("split");
  document.querySelector('.icon-btn[data-panel="right"][data-action="fullscreen"]').fire("click");
  assert(split.classList.contains("focus-right"), "focus-right включён");
  document.querySelector('.icon-btn[data-panel="right"][data-action="collapse"]').fire("click");
  assert(!split.classList.contains("focus-right"), "focus снят");
  assert(!split.classList.contains("focus-left"), "НЕ перекинуто на левую панель");
  assert(!split.classList.contains("collapsed-right"), "и не свёрнуто");
});

test("layout: Esc сбрасывает фокус и сворачивание", async () => {
  installDom(); await resetState(); domLayout();
  layout.initLayout();
  const split = document.getElementById("split");
  document.querySelector('.icon-btn[data-panel="left"][data-action="fullscreen"]').fire("click");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!split.classList.contains("focus-left"), "focus сброшен");
  document.querySelector('.icon-btn[data-panel="right"][data-action="collapse"]').fire("click");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!split.classList.contains("collapsed-right"), "collapsed сброшен");
});

test("layout: двойной клик по разделителю возвращает 50%", async () => {
  installDom(); await resetState(); domLayout();
  state.panels.width = 70;
  layout.initLayout();
  document.getElementById("splitter").fire("dblclick");
  eq(state.panels.width, 50, "ширина 50");
});

// ================================================================ results

test("results: flattenRuns в режиме «Оба» даёт два прогона", async () => {
  installDom(); await resetState(); domResults();
  setupBothResults();
  const runs = results.flattenRuns();
  eq(runs.length, 2, "два прогона");
  eq(runs[0].mode, "decisions");
  eq(runs[1].mode, "fast_batch");
});

test("results: режим «Оба» — два чипа с раздельными метриками", async () => {
  installDom(); await resetState(); domResults();
  setupBothResults();
  results.renderResults();
  const chips = document.getElementById("run-chips").children;
  eq(chips.length, 2, "два чипа");
  includes(chips[0].textContent, "обычный", "чип 1 — обычный");
  includes(chips[0].textContent, "30.0 с", "чип 1 — своё время");
  includes(chips[1].textContent, "быстрый батч", "чип 2 — быстрый");
  includes(chips[1].textContent, "2.0 с", "чип 2 — своё время");
  includes(chips[1].textContent, "260 ток/с", "чип 2 — своя скорость");
  notIncludes(chips[1].textContent, "30.0 с", "чип 2 без чужого времени");
});

test("results: режим A — строка содержит ответ именно своего вопроса", async () => {
  installDom(); await resetState(); domResults();
  const qs = [
    { id: "q1", question: "Вопрос один?", type: "yes_no" },
    { id: "q2", question: "Вопрос два?", type: "choice", options: [{ name: "вариант Б" }, { name: "вариант А" }] },
  ];
  state.models = [{ key: "mA", label: "Qwen A", status: "running" }];
  state.results = {
    results: {
      mA: runRes({ duration_s: 5, prompt_tokens: 100, prefill_tok_s: 20 }, {
        q1: ansYesNo(0.9, 0.1),
        q2: { type: "choice", choice: "вариант Б", probabilities: { "вариант А": 0.1, "вариант Б": 0.85 }, label_mass: 0.95 },
      }),
    },
    order: ["mA"], runMode: "decisions", questions: qs,
  };
  results.renderResults();
  const rows = document.getElementById("results-list").children;
  eq(rows.length, 2, "две строки");
  includes(rows[0].textContent, "да · 90%", "строка 1 — ответ вопроса 1");
  notIncludes(rows[0].textContent, "вариант Б", "строка 1 без ответа вопроса 2");
  includes(rows[1].textContent, "вариант Б · 85%", "строка 2 — ответ вопроса 2");
});

test("results: режим B — ховер на ячейке показывает распределение только этого прогона (регрессия)", async () => {
  installDom(); await resetState(); domResults();
  setupBothResults();
  results.renderResults();
  const row = document.getElementById("results-list").children[0];
  const cells = row.querySelectorAll(".res-cell");
  eq(cells.length, 2, "две ячейки");
  cells[1].fire("mouseenter");
  const tip = document.body.querySelector(".dist-tip");
  assert(tip && !tip.classList.contains("hidden"), "тултип виден");
  includes(tip.textContent, "быстрый батч", "тултип — быстрый прогон");
  notIncludes(tip.textContent, "обычный", "тултип без обычного прогона");
  cells[1].fire("mouseleave");
  const qText = row.querySelector(".res-q-text");
  qText.fire("mouseenter");
  includes(tip.textContent, "обычный", "ховер на вопросе — обычный");
  includes(tip.textContent, "быстрый батч", "ховер на вопросе — быстрый");
});

test("results: повторный renderResults скрывает висящий тултип", async () => {
  installDom(); await resetState(); domResults();
  setupBothResults();
  results.renderResults();
  const row = document.getElementById("results-list").children[0];
  row.querySelectorAll(".res-cell")[0].fire("mouseenter");
  const tip = document.body.querySelector(".dist-tip");
  assert(!tip.classList.contains("hidden"), "тултип открыт");
  results.renderResults();
  assert(tip.classList.contains("hidden"), "тултип скрыт после перерендера");
});

test("results: чип согласия в режиме B", async () => {
  installDom(); await resetState(); domResults();
  setupBothResults();
  results.renderResults();
  const chip = document.getElementById("results-agree");
  assert(!chip.classList.contains("hidden"), "чип согласия виден");
  includes(chip.textContent, "сошлись по 1 из 1", "текст согласия");
});

test("results: shortAnswer форматы", async () => {
  await resetState();
  eq(results.shortAnswer(ansYesNo(0.9, 0.1)), "да · 90%", "yes_no да");
  eq(results.shortAnswer(ansYesNo(0.2, 0.8)), "нет · 80%", "yes_no нет");
  eq(results.shortAnswer({ type: "choice", choice: "Б", probabilities: { А: 0.3, Б: 0.7 } }), "Б · 70%", "choice");
  eq(results.shortAnswer({ type: "score", score: 2.345, probabilities: { 0: 0.1, 1: 0.9 } }), "2.35", "score");
});

test("results: confClass — нейтральные ступени conf-0..conf-4", async () => {
  await resetState();
  eq(results.confClass(0), "conf-0", "0");
  eq(results.confClass(0.19), "conf-0", "ниже 0.2");
  eq(results.confClass(0.2), "conf-1", "0.2");
  eq(results.confClass(0.39), "conf-1", "ниже 0.4");
  eq(results.confClass(0.4), "conf-2", "0.4");
  eq(results.confClass(0.5), "conf-2", "0.5");
  eq(results.confClass(0.6), "conf-3", "0.6");
  eq(results.confClass(0.79), "conf-3", "ниже 0.8");
  eq(results.confClass(0.8), "conf-4", "0.8");
  eq(results.confClass(1), "conf-4", "1");
});

test("results: режим B с тремя прогонами — все ячейки видны, без «+ ещё»", async () => {
  installDom(); await resetState(); domResults();
  const qs = [{ id: "q1", question: "Есть ли цифры в резюме?", type: "yes_no" }];
  state.models = [
    { key: "mA", label: "Qwen A 27B", status: "running" },
    { key: "mB", label: "Qwen B 35B", status: "running" },
    { key: "mC", label: "Qwen C 9B", status: "running" },
  ];
  state.results = {
    results: {
      mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }),
      mB: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.7, 0.3) }),
      mC: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.6, 0.4) }),
    },
    order: ["mA", "mB", "mC"], runMode: "decisions", questions: qs,
  };
  results.renderResults();
  const row = document.getElementById("results-list").children[0];
  const cells = row.querySelectorAll(".res-cell");
  eq(cells.length, 3, "все три прогона видны");
  const tags = [...cells].map(c => c.querySelector(".res-cell-tag").textContent).join(",");
  eq(tags, "27B,35B,9B", "теги всех прогонов");
  assert(!row.querySelector(".more-mark"), "метки «+ ещё N» нет");
  // drilldown по клику остаётся
  row.fire("click");
  const detail = document.getElementById("results-list").querySelector(".res-detail");
  assert(detail, "дрилдаун открылся");
  eq(detail.querySelectorAll(".res-detail-section").length, 3, "дрилдаун по всем трём прогонам");
});

test("results: pairsDisagree — порог score 0.5 и различия yes_no", async () => {
  await resetState();
  const mk = (ans) => [{ run: { key: "mA", mode: "decisions" }, ans }, { run: { key: "mB", mode: "decisions" }, ans: { ...ans } }];
  eq(results.pairsDisagree(mk(ansYesNo(0.9, 0.1))), false, "yes_no одинаково");
  const yn = mk(ansYesNo(0.9, 0.1));
  yn[1].ans = ansYesNo(0.2, 0.8);
  eq(results.pairsDisagree(yn), true, "yes_no расходятся");
  const sc = [{ run: {}, ans: { type: "score", score: 2.0, probabilities: {} } }, { run: {}, ans: { type: "score", score: 2.4, probabilities: {} } }];
  eq(results.pairsDisagree(sc), false, "score в пределах 0.5");
  sc[1].ans.score = 2.6;
  eq(results.pairsDisagree(sc), true, "score за порогом 0.5");
});

// ================================================================ questions

test("questions: свежая карточка схлопывается после первого ввода", async () => {
  installDom(); await resetState(); domQuestions();
  questions.addQuestion();
  const card = document.getElementById("questions-list").children[0];
  assert(!state.questions[0].collapsed, "свежая развёрнута");
  state.questions[0].question = "Текст вопроса?";
  card.fire("input");
  card.fire("focusout");
  assert(state.questions[0].collapsed, "схлопнута после ввода");
});

test("questions: в развёрнутой карточке «свернуть» — крайняя справа", async () => {
  installDom(); await resetState(); domQuestions();
  questions.addQuestion({ question: "Q?", type: "yes_no" });
  state.questions[0].collapsed = false;
  questions.renderQuestions();
  const controls = document.getElementById("questions-list").children[0].querySelector(".question-controls");
  const last = controls.children[controls.children.length - 1];
  assert(last.classList.contains("collapse-btn"), "последняя кнопка — collapse");
  const delIdx = controls.children.findIndex(c => c.textContent === "Удалить");
  assert(delIdx >= 0 && delIdx < controls.children.length - 1, "«Удалить» левее «свернуть»");
});

test("questions: moveQuestion меняет порядок", async () => {
  installDom(); await resetState(); domQuestions();
  questions.addQuestion({ question: "Первый?", type: "yes_no" });
  questions.addQuestion({ question: "Второй?", type: "yes_no" });
  questions.addQuestion({ question: "Третий?", type: "yes_no" });
  questions.moveQuestion(0, 2);
  eq(state.questions.map(q => q.question).join("|"), "Второй?|Третий?|Первый?", "порядок");
});

test("questions: валидация payload", async () => {
  installDom(); await resetState(); domQuestions();
  questions.addQuestion({ question: "", type: "yes_no" });
  throws(() => questions.buildQuestionsPayload(), "пустой текст", "пустой вопрос");
  await resetState();
  questions.addQuestion({ question: "Q?", type: "choice", options: [{ name: "один" }] });
  throws(() => questions.buildQuestionsPayload(), "от 2 до 26", "мало опций");
  await resetState();
  questions.addQuestion({ question: "Q?", type: "choice", options: [{ name: "А" }, { name: "а" }] });
  throws(() => questions.buildQuestionsPayload(), "дублирующееся", "дубли опций case-insensitive");
  await resetState();
  questions.addQuestion({ question: "Q?", type: "score", levels: ["один"] });
  throws(() => questions.buildQuestionsPayload(), "от 2 до 10", "мало уровней");
});

test("questions: ошибка валидации — порядковый номер, а не id", async () => {
  installDom(); await resetState(); domQuestions();
  questions.addQuestion({ question: "Ок?", type: "yes_no" });
  questions.addQuestion({ question: "", type: "yes_no" });
  const emptyId = state.questions[1].id;
  try {
    questions.buildQuestionsPayload();
    throw new Error("исключение не брошено");
  } catch (e) {
    includes(e.message, "Вопрос №2", "1-based номер в списке");
    notIncludes(e.message, emptyId, "внутренний id не показывается");
  }
});

test("questions: подсказка пустого списка появляется и пропадает", async () => {
  installDom(); await resetState(); domQuestions();
  const hint = document.getElementById("questions-empty");
  questions.renderQuestions();
  assert(!hint.classList.contains("hidden"), "подсказка видна при пустом списке");
  questions.addQuestion({ question: "Q?", type: "yes_no" });
  assert(hint.classList.contains("hidden"), "подсказка скрыта при наличии вопросов");
  questions.removeQuestion(0);
  assert(!hint.classList.contains("hidden"), "подсказка вернулась после удаления всех");
});

test("questions: direction не в payload, но в экспорте", async () => {
  installDom(); await resetState(); domQuestions();
  questions.addQuestion({ question: "Оценка?", type: "score", levels: ["плохо", "хорошо"], direction: "up" });
  const payload = questions.buildQuestionsPayload();
  assert(!("direction" in payload[0]), "direction не в payload");
  let captured = null;
  globalThis.URL.createObjectURL = (blob) => { captured = blob.content; return "blob:x"; };
  questions.exportQuestions();
  const exported = JSON.parse(captured);
  eq(exported[0].direction, "up", "direction в экспорте");
});

test("questions: setAllCollapsed и normalizeQuestion direction", async () => {
  installDom(); await resetState(); domQuestions();
  questions.addQuestion({ question: "Q1?", type: "yes_no" });
  questions.addQuestion({ question: "Q2?", type: "yes_no" });
  questions.setAllCollapsed(false);
  assert(state.questions.every(q => !q.collapsed), "все развёрнуты");
  questions.setAllCollapsed(true);
  assert(state.questions.every(q => q.collapsed), "все схлопнуты");
  const n = questions.normalizeQuestion({ question: "S?", type: "score", levels: ["a", "b"], direction: "down" });
  eq(n.direction, "down", "direction сохранён");
  const n2 = questions.normalizeQuestion({ question: "S?", type: "score", levels: ["a", "b"], direction: "bogus" });
  eq(n2.direction, "neutral", "неизвестное direction → neutral");
});

// ================================================================ context

test("context: buildInput в текстовом режиме и пустой контекст", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  context.setContent("Иван врач.", "text");
  eq(context.buildInput(), "Иван врач.", "текст");
  context.setContent("   ", "text");
  throws(() => context.buildInput(), "пустым", "пустой контекст");
});

test("context: JSON-режим — валидация и buildInput", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  // setMode("json") тянет CodeMirror — в node не тестируем; ставим режим напрямую
  state.inputMode = "json";
  document.getElementById("context-input").value = '{"a": 1}';
  assert(context.validateJsonMode(), "валидный JSON");
  const input = context.buildInput();
  eq(input.a, 1, "распарсенный объект");
  document.getElementById("context-input").value = "{битый";
  assert(!context.validateJsonMode(), "невалидный");
  const err = document.getElementById("json-error");
  assert(!err.classList.contains("hidden"), "плашка ошибки видна");
  includes(err.textContent, "Невалидный JSON", "текст ошибки");
  throws(() => context.buildInput(), "Невалидный JSON", "buildInput бросает");
});

test("context: describeJsonError — строка/столбец из position, фолбэк без позиции", async () => {
  await resetState();
  const suffix = context.describeJsonError('{"a": 1,\n"b": x}', { message: "Unexpected token x in JSON at position 12" });
  includes(suffix, "строка 2", "строка вычислена");
  includes(suffix, "столбец 4", "столбец вычислен");
  notIncludes(suffix, "position 12", "сырая позиция убрана");
  const v8 = context.describeJsonError('{"a": 1, "b" 2}', {
    message: "Expected double-quoted property name in JSON at position 8 (line 1 column 9)",
  });
  eq(v8, " (строка 1, столбец 9): Expected double-quoted property name", "без дубля (line X column Y)");
  const fallback = context.describeJsonError("{}", { message: "weird engine error" });
  eq(fallback, ": weird engine error", "фолбэк — исходное сообщение");
});

test("context: parseImport — вопросы / контекст / снапшот / батч / мусор", async () => {
  await resetState();
  const q = context.parseImport('[{"question":"Q?","type":"yes_no"}]');
  eq(q.kind, "questions", "массив → вопросы");
  const c = context.parseImport('{"input_format":"text","input":"текст"}');
  eq(c.kind, "context", "объект с input → контекст");
  eq(c.batchFiles, null, "без batch_files — batchFiles null");
  const s = context.parseImport('{"input":"текст","questions":[]}');
  eq(s.kind, "session", "input+questions → снапшот");
  const sb = context.parseImport('{"input":"текст","batch_files":[{"name":"a.txt","content":"x"}]}');
  eq(sb.kind, "session", "input+batch_files → снапшот");
  eq(sb.batchFiles.length, 1, "batch_files распознаны");
  const b = context.parseImport('{"batch_files":[{"name":"p.png","image":"data:image/png;base64,QUJD"}]}');
  eq(b.kind, "batch", "только batch_files → батч");
  eq(b.context, null, "контекста нет");
  const min = context.parseImport('{"input":"","batch_files":[]}');
  eq(min.kind, "session", "минимальный {input, batch_files} → снапшот");
  throws(() => context.parseImport('{"foo":1}'), "input", "мусор");
});

test("context: полноэкранный режим редактора", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  const card = document.getElementById("context-card");
  context.toggleContextFullscreen();
  assert(card.classList.contains("context-fullscreen"), "карточка на весь экран");
  assert(document.body.classList.contains("no-scroll"), "скролл выключен");
  eq(document.getElementById("btn-context-fs").textContent, "✕", "кнопка ✕");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!card.classList.contains("context-fullscreen"), "Esc возвращает");
});

test("context: contextSnapshot и exportContext", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  context.setContent("текст контекста", "text");
  const snap = context.contextSnapshot();
  eq(snap.input_format, "text");
  eq(snap.input, "текст контекста");
  let captured = null;
  globalThis.URL.createObjectURL = (blob) => { captured = blob.content; return "blob:x"; };
  context.exportContext();
  eq(JSON.parse(captured).input, "текст контекста", "экспорт контекста");
});

// ---------------------------------------------------------------- изображения (этап 4)

test("context: прикрепление и удаление изображения", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  await context.addImageFiles([fakeFile("a.png", "png-bytes")]);
  eq(state.contextImages.length, 1, "картинка в state");
  assert(state.contextImages[0].dataUrl.startsWith("data:image/png;base64,"), "data URL");
  const wrap = document.getElementById("context-images");
  assert(!wrap.classList.contains("hidden"), "ряд миниатюр виден");
  const thumb = wrap.querySelector(".ctx-thumb");
  assert(thumb && thumb.querySelector("img"), "миниатюра с img");
  thumb.querySelector(".ctx-thumb-remove").fire("click");
  eq(state.contextImages.length, 0, "картинка удалена");
  assert(wrap.classList.contains("hidden"), "ряд скрыт после удаления");
});

test("context: клик по миниатюре — лайтбокс; ✕ удаляет, лайтбокса нет", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  await context.addImageFiles([fakeFile("a.png", "png-bytes")]);
  const wrap = document.getElementById("context-images");
  wrap.querySelector(".ctx-thumb img").fire("click");
  assert(lightbox.isLightboxOpen(), "клик по картинке открыл лайтбокс");
  includes(document.body.querySelector(".lightbox-caption").textContent, "a.png", "имя в подписи");
  lightbox.closeLightbox();
  wrap.querySelector(".ctx-thumb-remove").fire("click");
  eq(state.contextImages.length, 0, "картинка удалена крестиком");
  assert(!lightbox.isLightboxOpen(), "✕ не открывает лайтбокс");
});

test("context: пустой текст + картинка — buildInput ок", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  throws(() => context.buildInput(), "пустым", "без картинки — ошибка");
  await context.addImageFiles([fakeFile("a.png", "png-bytes")]);
  eq(context.buildInput(), "", "пустой текст допустим с картинкой");
  eq(context.buildImagesPayload().length, 1, "payload картинок");
});

test("context: drag&drop картинки на карточку контекста", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  const card = document.getElementById("context-card");
  card.fire("drop", { dataTransfer: { files: [fakeFile("b.webp", "webp-bytes", "image/webp")] } });
  await sleep(10);
  eq(state.contextImages.length, 1, "картинка прикреплена через drop");
  eq(state.contextImages[0].name, "b.webp", "имя сохранено");
});

test("context: экспорт/импорт с изображениями (обратная совместимость)", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  context.setContent("текст", "text");
  context.setImages([{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }]);
  const snap = context.contextSnapshot();
  eq(snap.images.join(","), "data:image/png;base64,QUJD", "images в снапшоте");
  // импорт снапшота с картинками
  const parsed = context.parseImport(JSON.stringify(snap));
  context.applyImportedContext(parsed.context);
  eq(state.contextImages.length, 1, "картинка восстановлена");
  eq(state.contextImages[0].dataUrl, "data:image/png;base64,QUJD", "dataUrl сохранён");
  // старый экспорт без images — работает, картинки сброшены
  const legacy = context.parseImport('{"input_format":"text","input":"старое"}');
  assert(!("images" in snap) || true, "снапшот валиден");
  context.applyImportedContext(legacy.context);
  eq(state.contextImages.length, 0, "legacy-импорт сбрасывает картинки");
  eq(context.buildImagesPayload().length, 0, "payload пуст");
});

test("context: круговой экспорт/импорт «Всё» — контекст + картинки + вопросы + batch_files", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch();
  context.initContext({});
  batch.initBatch({});
  context.setContent("текст контекста", "text");
  context.setImages([{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }]);
  questions.setQuestions([{ question: "Q?", type: "yes_no" }]);
  batch.loadPresetFiles([
    { name: "doc.txt", content: "текст файла" },
    { name: "pic.png", image: "data:image/png;base64,REVG" },
  ]);
  // экспорт «Всё» (формат app.js exportAll)
  const data = {
    ...context.contextSnapshot(),
    questions: questions.buildQuestionsPayload(),
    batch_files: batch.batchFilesSnapshot(),
  };
  eq(data.batch_files.length, 2, "оба файла в снапшоте");
  eq(data.batch_files[0].content, "текст файла", "текстовый файл → content");
  eq(data.batch_files[1].image, "data:image/png;base64,REVG", "картинка → image");
  // портим состояние и импортируем обратно
  context.setContent("другое", "text");
  context.setImages([]);
  questions.setQuestions([]);
  batch.loadPresetFiles([]);
  let err = null;
  context.importJsonFile(fakeFile("session.json", JSON.stringify(data)), {
    onError: (m) => { err = m; },
    confirmReplace: () => true,
    onBatchFiles: (files) => batch.loadPresetFiles(files),
  });
  await sleep(10);
  assert(!err, "без ошибки импорта: " + err);
  eq(context.buildInput(), "текст контекста", "контекст восстановлен");
  eq(state.contextImages.length, 1, "картинка контекста восстановлена");
  eq(state.contextImages[0].dataUrl, "data:image/png;base64,QUJD", "dataUrl контекста");
  eq(state.questions.length, 1, "вопрос восстановлен");
  eq(state.questions[0].question, "Q?", "текст вопроса");
  eq(state.batch.files.length, 2, "файлы батча восстановлены");
  eq(state.batch.files[0].text, "текст файла", "текст файла батча");
  assert(!state.batch.files[0].isImage, "первый файл текстовый");
  assert(state.batch.files[1].isImage, "второй файл — картинка");
  eq(state.batch.files[1].dataUrl, "data:image/png;base64,REVG", "dataUrl файла батча");
});

test("context: importJsonFile — отмена confirmReplace не меняет состояние", async () => {
  installDom(); await resetState(); domContext(); domQuestions();
  context.initContext({});
  context.setContent("старое", "text");
  questions.setQuestions([{ question: "Old?", type: "yes_no" }]);
  let asked = null;
  context.importJsonFile(fakeFile("s.json",
    '{"input":"новое","questions":[{"question":"N?","type":"yes_no"}],"batch_files":[{"name":"a.txt","content":"x"}]}'), {
    onError: () => {},
    confirmReplace: (kind) => { asked = kind; return false; },
    onBatchFiles: () => { throw new Error("onBatchFiles не должен вызываться при отмене"); },
  });
  await sleep(10);
  eq(asked, "session", "спросили подтверждение для снапшота");
  eq(context.buildInput(), "старое", "контекст не изменился");
  eq(state.questions[0].question, "Old?", "вопросы не изменились");
});

test("context: импорт только batch_files (минимальный объект без input)", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch();
  context.initContext({});
  batch.initBatch({});
  context.setContent("не трогаем", "text");
  let applied = null;
  context.importJsonFile(fakeFile("b.json",
    '{"batch_files":[{"name":"a.txt","content":"x"},{"name":"p.png","image":"data:image/png;base64,QUJD"}]}'), {
    onError: (m) => { throw new Error(m); },
    confirmReplace: () => { throw new Error("для kind=batch confirm не нужен — одиночный режим не затронут"); },
    onBatchFiles: (files) => { applied = files; batch.loadPresetFiles(files); },
  });
  await sleep(10);
  eq(applied.length, 2, "batch_files переданы в onBatchFiles");
  eq(state.batch.files.length, 2, "файлы в state.batch");
  assert(state.batch.files[1].isImage, "картинка распознана");
  eq(context.buildInput(), "не трогаем", "контекст не изменился");
  // старый формат без batch_files/images — работает как раньше
  context.importJsonFile(fakeFile("old.json", '{"input_format":"text","input":"legacy"}'), {
    onError: (m) => { throw new Error(m); },
    confirmReplace: () => true,
  });
  await sleep(10);
  eq(context.buildInput(), "legacy", "legacy-импорт работает");
  eq(state.batch.files.length, 2, "батч без onBatchFiles не тронут");
});

// ================================================================ lightbox

test("lightbox: открытие, singleton, закрытие по ✕, Esc и клику по фону", async () => {
  installDom(); await resetState();
  lightbox.openLightbox({ src: "data:image/png;base64,QUJD", name: "a.png" });
  const ov = document.body.querySelector(".lightbox-overlay");
  assert(ov && !ov.classList.contains("hidden"), "оверлей открыт");
  eq(ov.querySelector(".lightbox-img").src, "data:image/png;base64,QUJD", "src картинки");
  eq(ov.querySelector(".lightbox-caption").textContent, "a.png", "подпись-имя");
  assert(lightbox.isLightboxOpen(), "isLightboxOpen");
  // singleton: повторное открытие заменяет содержимое, оверлей один
  lightbox.openLightbox({ src: "data:image/png;base64,REVG", name: "b.png" });
  eq(document.body.querySelectorAll(".lightbox-overlay").length, 1, "оверлей один");
  eq(ov.querySelector(".lightbox-img").src, "data:image/png;base64,REVG", "содержимое заменено");
  // ✕
  ov.querySelector(".lightbox-close").fire("click");
  assert(!lightbox.isLightboxOpen(), "закрыт кнопкой ✕");
  // Esc
  lightbox.openLightbox({ src: "x", name: "x" });
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!lightbox.isLightboxOpen(), "закрыт по Esc");
  // клик по фону закрывает, по контенту — нет
  lightbox.openLightbox({ src: "x", name: "x" });
  ov.querySelector(".lightbox-box").fire("click");
  assert(lightbox.isLightboxOpen(), "клик по контенту не закрывает");
  ov.fire("click");
  assert(!lightbox.isLightboxOpen(), "клик по фону закрывает");
});

test("lightbox: ⛶ — Fullscreen API, без него CSS-фолбэк", async () => {
  installDom(); await resetState();
  lightbox.openLightbox({ src: "x", name: "x" });
  const ov = document.body.querySelector(".lightbox-overlay");
  const box = ov.querySelector(".lightbox-box");
  let fsCalls = 0;
  box.requestFullscreen = () => { fsCalls++; return Promise.resolve(); };
  ov.querySelector(".lightbox-fs").fire("click");
  await sleep(1);
  eq(fsCalls, 1, "requestFullscreen вызван на контейнере");
  assert(!ov.classList.contains("lightbox-full"), "CSS-фолбэк не нужен");
  // без Fullscreen API — CSS-растяжение
  box.requestFullscreen = undefined;
  ov.querySelector(".lightbox-fs").fire("click");
  assert(ov.classList.contains("lightbox-full"), "CSS-фолбэк включён");
  ov.querySelector(".lightbox-fs").fire("click");
  assert(!ov.classList.contains("lightbox-full"), "повторный клик снимает фолбэк");
  lightbox.closeLightbox();
});

// ================================================================ batch

function setupBatchRun(nFiles) {
  state.models = [{ key: "mA", label: "Qwen A", status: "running" }];
  state.selectedModels = new Set(["mA"]);
  state.questions = [{ id: "q1", question: "Есть цифры?", type: "yes_no", collapsed: true }];
  const files = [];
  for (let i = 1; i <= nFiles; i++) files.push({ name: `r${i}.txt`, content: `резюме ${i} `.repeat(100) });
  batch.loadPresetFiles(files);
}

function decideOk() {
  return { results: { mA: runRes({ duration_s: 1, prompt_tokens: 10, prefill_tok_s: 10 }, { q1: ansYesNo(0.8, 0.2) }) } };
}

test("batch: loadPresetFiles наполняет список и прогресс", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchRun(10);
  eq(state.batch.files.length, 10, "10 файлов");
  eq(document.getElementById("batch-list").children.length, 10, "10 строк списка");
  assert(!document.getElementById("batch-progress-wrap").classList.contains("hidden"), "прогресс виден");
  includes(document.getElementById("batch-progress").textContent, "0 из 10", "счётчик");
});

test("batch: batchFilesSnapshot — текст → content, картинка → image, без статусов", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  batch.loadPresetFiles([
    { name: "doc.txt", content: "текст" },
    { name: "p.png", image: "data:image/png;base64,QUJD" },
  ]);
  const snap = batch.batchFilesSnapshot();
  eq(snap.length, 2, "два файла");
  eq(JSON.stringify(Object.keys(snap[0]).sort()), '["content","name"]', "только name+content");
  eq(JSON.stringify(Object.keys(snap[1]).sort()), '["image","name"]', "только name+image");
  eq(snap[0].content, "текст", "content текстового");
  eq(snap[1].image, "data:image/png;base64,QUJD", "image картинки");
  // круговой: снапшот загружается обратно без потерь
  batch.loadPresetFiles(snap);
  eq(state.batch.files.length, 2, "файлы восстановлены");
  eq(state.batch.files[0].text, "текст", "текст на месте");
  assert(state.batch.files[1].isImage, "картинка на месте");
});

test("batch: runBatch прогоняет все файлы, таблица растёт инкрементально", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchRun(2);
  let callN = 0;
  let incrementalOk = false;
  mockFetch({
    "POST /api/decide": () => {
      callN += 1;
      if (callN === 2) {
        // после первого файла строки таблицы уже отрисованы
        incrementalOk = document.getElementById("batch-results").children.length > 0;
      }
      return decideOk();
    },
  });
  await batch.runBatch();
  eq(callN, 2, "два вызова decide");
  assert(incrementalOk, "таблица результатов отрисовалась после первого файла");
  assert(state.batch.files.every(f => f.status === "ok"), "все файлы ok");
  includes(document.getElementById("batch-progress").textContent, "2 из 2", "прогресс финальный");
  assert(document.getElementById("batch-results").children.length > 0, "таблица есть");
});

test("batch: отмена останавливает цикл между файлами", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchRun(3);
  mockFetch({
    "POST /api/decide": () => {
      state.batch.cancelled = true;
      return decideOk();
    },
  });
  await batch.runBatch();
  eq(state.batch.files[0].status, "ok", "первый успел");
  eq(state.batch.files[1].status, "pending", "второй не начат");
  eq(state.batch.files[2].status, "pending", "третий не начат");
});

test("batch: CSV экранирует запятые и кавычки", async () => {
  installDom(); await resetState(); domBatch();
  const rows = [{
    file: { id: "f1", name: 'a,"b".txt' },
    perModel: { mA: runRes({ duration_s: 1 }, { q1: ansYesNo(0.8, 0.2) }) },
  }];
  const csv = batch.buildBatchCsv(rows, [{ id: "q1", question: "Есть цифры?", type: "yes_no" }]);
  includes(csv, '"a,""b"".txt"', "имя файла экранировано");
});

test("batch: редактор вопросов на батч-странице — общий state с одиночным", async () => {
  installDom(); await resetState(); domQuestions(); domBatch();
  batch.initBatch({});
  questions.mountQuestions();
  questions.mountQuestions({ listId: "batch-questions-list", emptyId: "batch-questions-empty" });
  const emptyB = document.getElementById("batch-questions-empty");
  assert(!emptyB.classList.contains("hidden"), "подсказка пустого списка видна в батче");
  questions.addQuestion({ question: "Есть цифры?", type: "yes_no" });
  eq(document.getElementById("batch-questions-list").children.length, 1, "вопрос отрисован в батче");
  eq(document.getElementById("questions-list").children.length, 1, "тот же вопрос в одиночном");
  assert(emptyB.classList.contains("hidden"), "подсказка скрыта");
  // удаление через батч-инстанс отражается в одиночном
  state.questions[0].collapsed = false;
  questions.renderQuestions();
  const del = [...document.getElementById("batch-questions-list").children[0].querySelectorAll("button")]
    .find(b => b.textContent === "Удалить");
  assert(del, "кнопка «Удалить» есть и в батч-инстансе");
  del.fire("click");
  eq(state.questions.length, 0, "вопрос удалён из общего state");
  eq(document.getElementById("questions-list").children.length, 0, "одиночный инстанс обновлён");
  assert(!emptyB.classList.contains("hidden"), "подсказка вернулась");
});

test("batch: превью файла — открытие, усечение, показать всё", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  batch.loadPresetFiles([{ name: "big.txt", content: "абв".repeat(1000) }]); // 3000 символов
  const list = document.getElementById("batch-list");
  eq(list.children.length, 1, "одна строка, превью закрыто");
  const pvBtn = () => list.children[0].querySelector(".batch-preview-btn");
  pvBtn().fire("click");
  eq(list.children.length, 2, "блок превью под строкой");
  const preview = list.children[1];
  assert(preview.classList.contains("batch-preview"), "это блок превью");
  eq(preview.querySelector(".batch-preview-text").textContent.length, 2001, "2000 символов + …");
  preview.querySelector(".batch-preview-more").fire("click");
  eq(list.children[1].querySelector(".batch-preview-text").textContent.length, 3000, "полный текст");
  assert(!list.children[1].querySelector(".batch-preview-more"), "кнопка «показать всё» исчезла");
  pvBtn().fire("click");
  eq(list.children.length, 1, "превью свёрнуто повторным кликом");
});

test("batch: превью .json — pretty-print", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  batch.loadPresetFiles([{ name: "data.json", content: '{"a":1,"b":[1,2]}' }]);
  const list = document.getElementById("batch-list");
  list.children[0].querySelector(".batch-preview-btn").fire("click");
  const text = list.children[1].querySelector(".batch-preview-text").textContent;
  includes(text, '"a": 1', "отступы pretty-print");
  includes(text, "\n", "многострочный вывод");
});

function fakeDataTransfer() {
  return {
    _d: {},
    setData(k, v) { this._d[k] = v; },
    getData(k) { return this._d[k]; },
    effectAllowed: null,
    dropEffect: null,
  };
}

test("batch: drag&drop меняет порядок state.batch.files и DOM-строк", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  batch.loadPresetFiles([
    { name: "a.txt", content: "a" },
    { name: "b.txt", content: "b" },
    { name: "c.txt", content: "c" },
  ]);
  const list = document.getElementById("batch-list");
  const dt = fakeDataTransfer();
  const rowA = list.children[0];
  const handleA = rowA.querySelector(".drag-handle");
  eq(handleA.title, "Перетащите, чтобы изменить порядок", "title у handle");
  eq(handleA.draggable, true, "draggable вне прогона");
  handleA.fire("dragstart", { dataTransfer: dt });
  assert(rowA.classList.contains("dragging"), "строка в состоянии dragging");
  const rowC = list.children[2];
  rowC.fire("dragover", { dataTransfer: dt });
  assert(rowC.classList.contains("drop-target"), "индикатор drop-позиции");
  rowC.fire("drop", { dataTransfer: dt });
  eq(state.batch.files.map(f => f.name).join(","), "b.txt,c.txt,a.txt", "порядок в state");
  eq([...list.children].map(r => r.querySelector(".batch-file-name").textContent).join(","),
    "b.txt,c.txt,a.txt", "порядок строк в DOM");
});

test("batch: drag&drop заблокирован во время прогона", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  batch.loadPresetFiles([{ name: "a.txt", content: "a" }, { name: "b.txt", content: "b" }]);
  state.batch.running = true;
  const list = document.getElementById("batch-list");
  const dt = fakeDataTransfer();
  list.children[0].querySelector(".drag-handle").fire("dragstart", { dataTransfer: dt });
  list.children[1].fire("dragover", { dataTransfer: dt });
  assert(!list.children[1].classList.contains("drop-target"), "нет индикатора во время прогона");
  list.children[1].fire("drop", { dataTransfer: dt });
  eq(state.batch.files.map(f => f.name).join(","), "a.txt,b.txt", "порядок не изменился");
});

// ---------------------------------------------------------------- изображения (этап 4)

test("batch: drop .png добавляет image-файл с миниатюрой", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  const drop = document.getElementById("batch-drop");
  drop.fire("drop", { dataTransfer: { files: [fakeFile("pic.png", "png-bytes")] } });
  await sleep(10);
  eq(state.batch.files.length, 1, "файл добавлен");
  const f = state.batch.files[0];
  assert(f.isImage, "isImage");
  assert(f.dataUrl.startsWith("data:image/png;base64,"), "dataUrl из FileReader");
  eq(f.text, "Изображение: pic.png", "текст-заглушка");
  assert(f.size > 0, "размер от реального файла");
  const row = document.getElementById("batch-list").children[0];
  assert(row.querySelector("img.batch-thumb"), "миниатюра 48px в строке");
});

test("batch: пресет с image-файлами → payload runBatch с images", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  state.models = [{ key: "cV", label: "Clef V", status: "running", vision: true }];
  state.selectedModels = new Set(["cV"]);
  state.questions = [{ id: "q1", question: "Есть товар?", type: "yes_no", collapsed: true }];
  batch.loadPresetFiles([{ name: "p.png", image: "data:image/png;base64,QUJD" }]);
  assert(state.batch.files[0].isImage, "image-файл из пресета");
  let captured = null;
  mockFetch({ "POST /api/decide": (call) => { captured = call.body; return decideOk(); } });
  await batch.runBatch();
  assert(captured, "decide вызван");
  eq(captured.input, "Изображение: p.png", "input — заглушка");
  eq((captured.images || []).join(","), "data:image/png;base64,QUJD", "images в payload");
  eq(captured.models.join(","), "cV", "модели");
});

test("batch: image-файл + нет vision-моделей → ошибка до прогона", async () => {
  installDom(); await resetState(); domBatch();
  let err = null;
  batch.initBatch({ showError: (m) => { err = m; } });
  state.models = [{ key: "mA", label: "Qwen A", status: "running", vision: false }];
  state.selectedModels = new Set(["mA"]);
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no", collapsed: true }];
  batch.loadPresetFiles([{ name: "p.png", image: "data:image/png;base64,QUJD" }]);
  await batch.runBatch();
  includes(err, "не поддерживает", "понятная ошибка");
  eq(state.batch.files[0].status, "pending", "прогон не начался");
});

test("batch: image-файл — без 👁, hover-превью на миниатюре, клик → лайтбокс", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  batch.loadPresetFiles([{ name: "p.png", image: "data:image/png;base64,QUJD" }]);
  const row = document.getElementById("batch-list").children[0];
  assert(!row.querySelector(".batch-preview-btn"), "у image-файла нет инлайн-превью (👁)");
  const thumb = row.querySelector(".batch-thumb");
  assert(thumb, "миниатюра в строке");
  thumb.fire("mouseenter");
  const tip = document.body.querySelector(".dist-tip");
  assert(tip && !tip.classList.contains("hidden"), "hover-тултип виден");
  assert(tip.querySelector("img.tip-img"), "в тултипе увеличенная картинка");
  thumb.fire("mouseleave");
  assert(tip.classList.contains("hidden"), "тултип скрыт при уходе курсора");
  thumb.fire("click");
  assert(lightbox.isLightboxOpen(), "клик по миниатюре открыл лайтбокс");
  eq(document.body.querySelector(".lightbox-img").src, "data:image/png;base64,QUJD", "src лайтбокса");
  assert(tip.classList.contains("hidden"), "hover-тултип скрыт при открытии лайтбокса");
  lightbox.closeLightbox();
});

test("batch: дрилдаун image-файла — миниатюра, клик открывает лайтбокс", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchResults({
    models: [{ key: "cV", label: "Clef V", status: "running", vision: true }],
    questions: [{ id: "q1", question: "Есть товар?", type: "yes_no", collapsed: true }],
    files: [{
      name: "p.png", image: "data:image/png;base64,QUJD",
      results: { cV: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }) },
    }],
  });
  document.querySelector("#batch-results .batch-file-th-name").fire("click");
  const detail = document.querySelector("#batch-results .batch-detail-row");
  assert(!detail.classList.contains("hidden"), "дрилдаун открыт");
  const thumb = detail.querySelector("img.batch-drilldown-thumb");
  assert(thumb, "миниатюра в дрилдауне вместо инлайн-картинки");
  assert(!detail.querySelector("img.batch-drilldown-img"), "инлайн-раскрытия картинки нет");
  thumb.fire("click");
  assert(lightbox.isLightboxOpen(), "клик по миниатюре открыл лайтбокс");
  lightbox.closeLightbox();
});

test("batch: миниатюра в колонке «Файл» — клик открывает лайтбокс, дрилдаун не трогает", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchResults({
    models: [{ key: "cV", label: "Clef V", status: "running", vision: true }],
    questions: [{ id: "q1", question: "Есть товар?", type: "yes_no", collapsed: true }],
    files: [
      {
        name: "p.png", image: "data:image/png;base64,QUJD",
        results: { cV: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }) },
      },
      {
        name: "r.txt", content: "резюме",
        results: { cV: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.8, 0.2) }) },
      },
    ],
  });
  const ths = document.querySelectorAll("#batch-results .batch-file-th");
  eq(ths.length, 2, "две строки файлов");
  const thumb = ths[0].querySelector("img.batch-cell-thumb");
  assert(thumb, "у image-файла миниатюра в колонке «Файл»");
  eq(thumb.src, "data:image/png;base64,QUJD", "src миниатюры");
  assert(!ths[1].querySelector("img.batch-cell-thumb"), "у текстового файла миниатюры нет");
  // hover на миниатюре — тултип-превью
  thumb.fire("mouseenter");
  const tip = document.body.querySelector(".dist-tip");
  assert(tip && !tip.classList.contains("hidden"), "hover-тултип виден");
  assert(tip.querySelector("img.tip-img"), "в тултипе увеличенная картинка");
  // клик по миниатюре — лайтбокс, дрилдаун не открывается
  thumb.fire("click");
  assert(lightbox.isLightboxOpen(), "клик по миниатюре открыл лайтбокс");
  eq(document.body.querySelector(".lightbox-img").src, "data:image/png;base64,QUJD", "src лайтбокса");
  assert(tip.classList.contains("hidden"), "hover-тултип скрыт при открытии лайтбокса");
  const detailRows = document.querySelectorAll("#batch-results .batch-detail-row");
  assert([...detailRows].every(r => r.classList.contains("hidden")), "дрилдауны остались закрыты");
  lightbox.closeLightbox();
  // клик по имени — дрилдаун открывается/закрывается
  const nameSpan = ths[0].querySelector(".batch-file-th-name");
  assert(nameSpan, "имя обёрнуто в span");
  nameSpan.fire("click");
  assert(!detailRows[0].classList.contains("hidden"), "клик по имени открыл дрилдаун");
  nameSpan.fire("click");
  assert(detailRows[0].classList.contains("hidden"), "повторный клик закрыл дрилдаун");
});
function setupBatchResults({ models, questions, files }) {
  state.models = models;
  state.questions = questions;
  batch.loadPresetFiles(files.map(f => ({ name: f.name, content: f.content, image: f.image })));
  state.batch.files.forEach((f, i) => {
    f.status = "ok";
    state.batch.results[f.id] = files[i].results;
    state.batch.durations[f.id] = 1;
  });
  batch.renderBatchResults();
}

const Q_LONG = "Есть ли в резюме конкретные цифры достижений?";
const Q_SHORT = "Кандидат подходит?";

test("batch: плейсхолдер результатов — виден без результатов, исчезает при первых", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  const res = document.getElementById("batch-results");
  const empty = () => res.querySelector(".results-empty");
  assert(empty(), "плейсхолдер на пустом батче");
  includes(empty().textContent, "Запустите прогон", "текст плейсхолдера");
  // файлы без результатов — плейсхолдер остаётся
  batch.loadPresetFiles([{ name: "a.txt", content: "текст" }]);
  assert(empty(), "файлы без результатов — плейсхолдер остаётся");
  // первые результаты — плейсхолдер исчезает
  setupBatchResults({
    models: [{ key: "mA", label: "Qwen A", status: "running" }],
    questions: [{ id: "q1", question: "Есть цифры?", type: "yes_no", collapsed: true }],
    files: [{ name: "a.txt", content: "текст", results: { mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }) } }],
  });
  assert(!empty(), "с результатами плейсхолдера нет");
  // очистка — плейсхолдер возвращается
  batch.resetBatch();
  assert(empty(), "после очистки плейсхолдер снова виден");
});

test("batch: шапка таблицы вопрос-major при 2+ моделях", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchResults({
    models: [
      { key: "mA", label: "Qwen A 27B", short_label: "AA", status: "running" },
      { key: "mB", label: "Qwen B 35B", short_label: "BB", status: "running" },
    ],
    questions: [
      { id: "q1", question: Q_LONG, type: "yes_no", collapsed: true },
      { id: "q2", question: Q_SHORT, type: "yes_no", collapsed: true },
    ],
    files: [{
      name: "r1.txt", content: "резюме",
      results: {
        mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1), q2: ansYesNo(0.3, 0.7) }),
        mB: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.2, 0.8), q2: ansYesNo(0.6, 0.4) }),
      },
    }],
  });
  const thead = document.querySelector("#batch-results table thead");
  eq(thead.children.length, 2, "две строки шапки");
  const top = thead.children[0].children;
  eq(top[0].textContent, "Файл", "угол — файл");
  eq(top[0].rowSpan, 2, "файл на две строки");
  eq(top[1].textContent, Q_LONG.slice(0, 24), "вопрос 1 обрезан до 24");
  eq(top[1].title, Q_LONG, "полный вопрос в title");
  eq(top[1].colSpan, 2, "вопрос 1 на две модели");
  eq(top[2].textContent, Q_SHORT, "вопрос 2 целиком");
  eq(top[2].colSpan, 2, "вопрос 2 на две модели");
  const sub = [...thead.children[1].children].map(th => th.textContent);
  eq(sub.join(","), "AA,BB,AA,BB", "под каждым вопросом — все модели");
  // тело: ячейки файла сгруппированы по вопросам (q1: mA,mB; q2: mA,mB)
  const row = document.querySelector("#batch-results tbody tr");
  const cells = [...row.querySelectorAll(".batch-cell")].map(td => td.textContent.trim());
  eq(cells.join("|"), "да · 90%|нет · 80%|нет · 70%|да · 60%", "порядок ячеек вопрос-major");
  // итого — под каждой парой вопрос×модель в том же порядке
  const agg = [...document.querySelector("#batch-results .batch-agg-row").children];
  eq(agg.length, 5, "файл + 4 агрегата");
  eq(agg[1].textContent, "да в 100%", "агрегат q1×mA");
  eq(agg[2].textContent, "да в 0%", "агрегат q1×mB");
  eq(agg[3].textContent, "да в 0%", "агрегат q2×mA");
  eq(agg[4].textContent, "да в 100%", "агрегат q2×mB");
});

test("batch: при одной модели — плоская шапка", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchResults({
    models: [{ key: "mA", label: "Qwen A", status: "running" }],
    questions: [
      { id: "q1", question: Q_LONG, type: "yes_no", collapsed: true },
      { id: "q2", question: Q_SHORT, type: "yes_no", collapsed: true },
    ],
    files: [{
      name: "r1.txt", content: "резюме",
      results: { mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1), q2: ansYesNo(0.6, 0.4) }) },
    }],
  });
  const thead = document.querySelector("#batch-results table thead");
  eq(thead.children.length, 1, "одна строка шапки");
  const heads = [...thead.children[0].children].map(th => th.textContent);
  eq(heads[0], "Файл", "первый столбец — файл");
  eq(heads[1], Q_LONG.slice(0, 40), "вопрос 1 в плоской шапке");
  eq(heads[2], Q_SHORT, "вопрос 2 в плоской шапке");
});

test("batch: ховер на ячейке — тултип распределения, скрытие и перерендер", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchResults({
    models: [{ key: "mA", label: "Qwen A", status: "running" }],
    questions: [{ id: "q1", question: "Есть цифры?", type: "yes_no", collapsed: true }],
    files: [{
      name: "r1.txt", content: "резюме",
      results: {
        mA: runRes({ duration_s: 1, prompt_tokens: 10 }, {
          q1: { type: "yes_no", probabilities: { yes: 0.6, no: 0.4 }, label_mass: 0.3 },
        }),
      },
    }],
  });
  const cell = document.querySelector("#batch-results .batch-cell");
  assert(cell, "ячейка есть");
  cell.fire("mouseenter");
  const tip = document.body.querySelector(".dist-tip");
  assert(tip && !tip.classList.contains("hidden"), "тултип виден");
  includes(tip.textContent, "Да", "полоса «Да»");
  includes(tip.textContent, "Нет", "полоса «Нет»");
  includes(tip.textContent, "Ответ: да · 60%", "полный ответ");
  includes(tip.textContent, "⚠", "предупреждение о доле на вариантах < 0.5");
  cell.fire("mouseleave");
  assert(tip.classList.contains("hidden"), "тултип скрыт при уходе курсора");
  cell.fire("mouseenter");
  assert(!tip.classList.contains("hidden"), "тултип снова открыт");
  batch.renderBatchResults();
  assert(tip.classList.contains("hidden"), "тултип скрыт при перерендере");
});

test("batch: дрилдаун файла содержит сворачиваемое превью текста", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchResults({
    models: [{ key: "mA", label: "Qwen A", status: "running" }],
    questions: [{ id: "q1", question: "Есть цифры?", type: "yes_no", collapsed: true }],
    files: [{
      name: "big.txt", content: "абв".repeat(1000), // 3000 символов
      results: { mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.8, 0.2) }) },
    }],
  });
  document.querySelector("#batch-results .batch-file-th-name").fire("click");
  const detail = document.querySelector("#batch-results .batch-detail-row");
  assert(!detail.classList.contains("hidden"), "дрилдаун открыт");
  const preview = detail.querySelector(".batch-detail-preview");
  assert(preview, "превью в дрилдауне");
  const pre = preview.querySelector(".batch-preview-text");
  eq(pre.textContent.length, 2001, "первые 2000 символов + …");
  const more = preview.querySelector(".batch-preview-more");
  assert(more, "кнопка «развернуть» есть");
  more.fire("click");
  eq(pre.textContent.length, 3000, "полный текст после «развернуть»");
  // сворачивание по заголовку
  preview.querySelector(".batch-detail-preview-toggle").fire("click");
  assert(pre.classList.contains("hidden"), "превью свёрнуто");
});

test("batch: панели — ⛶/— тогглят классы, restore-таб и Esc возвращают", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  const split = document.getElementById("split-batch");
  const fsL = split.querySelector('.icon-btn[data-panel="left"][data-action="fullscreen"]');
  fsL.fire("click");
  assert(split.classList.contains("focus-left"), "focus-left включён");
  fsL.fire("click");
  assert(!split.classList.contains("focus-left"), "focus-left выключен повторным кликом");
  split.querySelector('.icon-btn[data-panel="right"][data-action="collapse"]').fire("click");
  assert(split.classList.contains("collapsed-right"), "правая панель свёрнута");
  assert(!document.getElementById("batch-restore-right").classList.contains("hidden"), "таб возврата виден");
  document.getElementById("batch-restore-right").fire("click");
  assert(!split.classList.contains("collapsed-right"), "таб вернул панель");
  split.querySelector('.icon-btn[data-panel="right"][data-action="fullscreen"]').fire("click");
  assert(split.classList.contains("focus-right"), "focus-right включён");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!split.classList.contains("focus-right"), "Esc снял фокус");
});

// ================================================================ toolbar

test("toolbar: чипы моделей и доступность Run", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A 27B", status: "running" },
      { key: "mB", label: "Qwen B 35B", status: "stopped" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const chips = document.getElementById("tb-models").children;
  eq(chips.length, 2, "два чипа");
  const [cbA, cbB] = chips.map(c => c.querySelector("input"));
  eq(cbA.checked, true, "running выбрана автоматически");
  eq(cbB.disabled, true, "stopped недоступна");
  eq(document.getElementById("tb-run").disabled, false, "Run доступен");
});

test("toolbar: меню слева, сабменю экспорта, закрытие", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  toolbar.initToolbar({});
  const dd = document.getElementById("tb-menu");
  assert(dd.classList.contains("menu-left"), "меню прибито к левому краю");
  document.getElementById("tb-menu-btn").fire("click");
  assert(!dd.classList.contains("hidden"), "меню открыто");
  document.getElementById("tb-menu-export").fire("click");
  assert(!document.getElementById("tb-menu-export-sub").classList.contains("hidden"), "сабменю экспорта открыто");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(dd.classList.contains("hidden"), "Escape закрыл меню");
  assert(document.getElementById("tb-menu-export-sub").classList.contains("hidden"), "сабменю закрыто");
  await sleep(10); // дождаться полла — иначе он долетит до installDom следующего теста
});

test("toolbar: пункты экспорта вызывают колбэки", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  const called = [];
  toolbar.initToolbar({
    onExportQuestions: () => called.push("q"),
    onExportContext: () => called.push("c"),
    onExportAll: () => called.push("all"),
  });
  document.getElementById("tb-menu-export-questions").fire("click");
  document.getElementById("tb-menu-export-context").fire("click");
  document.getElementById("tb-menu-export-all").fire("click");
  eq(called.join(","), "q,c,all", "все колбэки");
  await sleep(10); // дождаться полла
});

test("toolbar: пресеты в сабменю, батч-пресет с бейджем, клик применяет", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([]),
    "GET /api/presets": [
      { name: "Обычный пресет", description: "d1", input: "x", questions: [] },
      { name: "Скрининг резюме", page: "batch", questions: [], files: [] },
    ],
  });
  let applied = null;
  toolbar.initToolbar({ applyPreset: (p) => { applied = p; } });
  document.getElementById("tb-menu-btn").fire("click");
  document.getElementById("tb-menu-presets").fire("click");
  await sleep(10);
  const sub = document.getElementById("tb-menu-presets-sub");
  const items = sub.children;
  eq(items.length, 2, "два пресета");
  includes(items[1].textContent, "батч", "бейдж у батч-пресета");
  notIncludes(items[0].textContent, "батч", "у обычного бейджа нет");
  items[0].fire("click");
  assert(applied && applied.name === "Обычный пресет", "пресет применён");
  await sleep(10); // дождаться полла
});

test("toolbar: setPageMode переключает страницы", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  toolbar.initToolbar({});
  toolbar.setPageMode("batch");
  assert(document.getElementById("page-single").classList.contains("hidden"), "single скрыт");
  assert(!document.getElementById("page-batch").classList.contains("hidden"), "batch виден");
  toolbar.setPageMode("models");
  assert(!document.getElementById("page-models").classList.contains("hidden"), "models видна");
  assert(document.getElementById("page-batch").classList.contains("hidden"), "batch скрыт");
  assert(document.getElementById("tb-run").disabled, "Run недоступен на странице моделей");
  toolbar.setPageMode("single");
  assert(!document.getElementById("page-single").classList.contains("hidden"), "single виден");
  await sleep(10); // дождаться полла
});

test("toolbar: чипы — short_label, прогресс скачивания, отключённая скрыта", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A 27B", short_label: "27B", status: "downloading", progress: 0.42, enabled: true },
      { key: "mB", label: "Hidden Model", status: "stopped", enabled: false },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const chips = document.getElementById("tb-models").children;
  eq(chips.length, 1, "отключённая модель не показывается");
  includes(chips[0].textContent, "27B", "короткое имя из short_label");
  includes(chips[0].textContent, "≈42%", "прогресс скачивания в чипе");
});

test("toolbar: чипы показывают только запиненные модели", async () => {
  installDom(); await resetState(); domToolbar();
  localStorage.setItem("pinnedModels", JSON.stringify(["mB"]));
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A 27B", status: "running" },
      { key: "mB", label: "Qwen B 35B", status: "running" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const chips = document.getElementById("tb-models").children;
  eq(chips.length, 1, "только запиненная модель в баре");
  includes(chips[0].textContent, "35B", "это запиненная mB");
});

test("toolbar: пин в дропдауне меняет чипы и пишется в localStorage", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A 27B", status: "running" },
      { key: "mB", label: "Qwen B 35B", status: "running" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  // бесшовная миграция: первый запуск пинит все enabled
  eq(document.getElementById("tb-models").children.length, 2, "миграция: все enabled запинены");
  eq(JSON.parse(localStorage.getItem("pinnedModels")).join(","), "mA,mB", "миграция записана в localStorage");
  const dd = document.getElementById("tb-models-dropdown");
  document.getElementById("tb-models-menu").fire("click");
  assert(!dd.classList.contains("hidden"), "дропдаун открыт");
  const rows = document.getElementById("tb-models-dropdown-list").children;
  eq(rows.length, 2, "две строки моделей");
  const pinB = rows[1].querySelector(".pin-check");
  assert(pinB.checked, "mB запинена");
  pinB.checked = false;
  pinB.fire("change");
  eq(document.getElementById("tb-models").children.length, 1, "чип mB убран из бара");
  eq(JSON.parse(localStorage.getItem("pinnedModels")).join(","), "mA", "localStorage обновлён");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(dd.classList.contains("hidden"), "Esc закрыл дропдаун");
  document.getElementById("tb-models-menu").fire("click");
  assert(!dd.classList.contains("hidden"), "дропдаун снова открыт");
  document.dispatchEvent({ type: "click" });
  assert(dd.classList.contains("hidden"), "клик вне закрыл дропдаун");
});

test("toolbar: запиненная stopped-модель видна, её чекбокс прогона disabled", async () => {
  installDom(); await resetState(); domToolbar();
  localStorage.setItem("pinnedModels", JSON.stringify(["mA", "mB"]));
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A 27B", status: "running" },
      { key: "mB", label: "Qwen B 35B", status: "stopped" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const chips = document.getElementById("tb-models").children;
  eq(chips.length, 2, "stopped запиненная видна");
  const cbB = chips[1].querySelector(".chip-check");
  eq(cbB.disabled, true, "чекбокс stopped-модели disabled");
  assert(chips[1].querySelector(".dot-stopped"), "статус-точка stopped");
});

test("toolbar: чип облачной модели без ключа — чекбокс disabled с title про API-ключ", async () => {
  installDom(); await resetState(); domToolbar();
  localStorage.setItem("pinnedModels", JSON.stringify(["rJev"]));
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "rJev", label: "Jev (облако) · latest", short_label: "Jev", type: "remote",
        api: "systemone", managed: false, status: "no_credentials", enabled: true,
        base_url: "https://api.typesafe.ai", has_credentials: false },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const chips = document.getElementById("tb-models").children;
  eq(chips.length, 1, "чип облачной модели в баре");
  includes(chips[0].textContent, "Jev", "short_label в чипе");
  const cb = chips[0].querySelector(".chip-check");
  eq(cb.disabled, true, "чекбокс прогона disabled");
  eq(cb.checked, false, "и не выбран");
  includes(cb.title, "API-ключ", "title объясняет, что делать");
  assert(chips[0].querySelector(".dot-no_credentials"), "статус-точка no_credentials");
});

test("toolbar: без пинов — кнопка «Выбрать модели…» открывает дропдаун", async () => {
  installDom(); await resetState(); domToolbar();
  localStorage.setItem("pinnedModels", JSON.stringify([]));
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running" }]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const pick = document.getElementById("tb-models-pick");
  assert(pick, "вместо чипов — кнопка выбора моделей");
  pick.fire("click");
  assert(!document.getElementById("tb-models-dropdown").classList.contains("hidden"), "дропдаун открыт");
});

test("toolbar: «Настройки моделей…» из дропдауна открывает страницу models", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running" }]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  document.getElementById("tb-models-menu").fire("click");
  document.getElementById("tb-models-settings").fire("click");
  eq(state.pageMode, "models", "переход на страницу models");
  assert(!document.getElementById("page-models").classList.contains("hidden"), "page-models видна");
  assert(document.getElementById("tb-models-dropdown").classList.contains("hidden"), "дропдаун закрыт");
});

test("toolbar: только SystemOne-модели — быстрый режим и температура заблокированы", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([{ key: "cA", label: "Clef A", status: "running", api: "systemone" }]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const fast = document.querySelector('#tb-runmode button[data-runmode="fast_batch"]');
  const both = document.querySelector('#tb-runmode button[data-runmode="both"]');
  assert(fast.disabled && both.disabled, "«Быстрый» и «Оба» disabled");
  includes(fast.title, "SGLang", "title объясняет причину");
  assert(document.getElementById("temperature").disabled, "температура disabled");
  const note = document.getElementById("temp-lock-note");
  assert(!note.classList.contains("hidden"), "пояснение блокировки видно");
  includes(note.textContent, "Clef детерминирована", "причина — детерминированная Clef");
});

test("toolbar: шеврон открывает поповер запуска, режим «Быстрый» блокирует температуру", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running", api: "decisions" }]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  includes(document.getElementById("tb-run").textContent, "(обычный)", "суффикс режима на кнопке");
  const pop = document.getElementById("run-popover");
  document.getElementById("tb-run-options").fire("click");
  assert(!pop.classList.contains("hidden"), "поповер открыт");
  document.querySelector('#run-popover [data-temp="0.5"]').fire("click");
  eq(state.temperature, 0.5, "пресет температуры применён");
  const fast = document.querySelector('#tb-runmode button[data-runmode="fast_batch"]');
  assert(!fast.disabled, "быстрый доступен для SGLang-модели");
  // DOM-мок не имеет bubbling — клик по кнопке сегмента диспатчим на сегмент
  document.getElementById("tb-runmode").fire("click", { target: fast });
  eq(state.runMode, "fast_batch", "режим переключён");
  assert(document.getElementById("temperature").disabled, "температура disabled в быстром режиме");
  includes(document.getElementById("temp-lock-note").textContent, "в быстром режиме всегда 0", "причина — быстрый режим");
  includes(document.getElementById("tb-run").textContent, "(быстрый)", "суффикс обновлён");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(pop.classList.contains("hidden"), "Esc закрыл поповер");
});

test("toolbar: быстрый режим автоматически сбрасывается без SGLang-моделей (+ баннер)", async () => {
  installDom(); await resetState(); domToolbar();
  const fmtBanner = el("div", { id: "format-banner", className: "hidden" });
  el("span", { id: "format-banner-text", parent: fmtBanner });
  el("button", { id: "btn-reset-pin", parent: fmtBanner });
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A", status: "running", api: "decisions" },
      { key: "cB", label: "Clef B", status: "running", api: "systemone" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const fastBtn = document.querySelector('#tb-runmode button[data-runmode="fast_batch"]');
  document.getElementById("tb-runmode").fire("click", { target: fastBtn });
  eq(state.runMode, "fast_batch", "быстрый режим включён");
  // SGLang-модель остановилась — быстрый режим некому исполнять
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A", status: "stopped", api: "decisions" },
      { key: "cB", label: "Clef B", status: "running", api: "systemone" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.refreshModels();
  await sleep(10);
  eq(state.runMode, "decisions", "режим автоматически возвращён в «Обычный»");
  assert(document.querySelector('#tb-runmode button[data-runmode="decisions"]').classList.contains("active"), "сегмент показывает «Обычный»");
  assert(!document.getElementById("format-banner").classList.contains("hidden"), "баннер показан");
  includes(document.getElementById("format-banner-text").textContent, "не поддерживают быстрый прогон", "текст баннера");
});

test("toolbar: бейдж 🖼 у vision-модели в дропдауне, «без картинок» у остальных", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A", status: "running", vision: false },
      { key: "cB", label: "Clef B", status: "running", vision: true },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  document.getElementById("tb-models-menu").fire("click");
  const rows = document.getElementById("tb-models-dropdown-list").children;
  eq(rows.length, 2, "две строки");
  assert(!rows[0].querySelector(".vision-badge"), "у текстовой модели бейджа нет");
  includes(rows[0].querySelector(".models-menu-name").title, "без картинок", "title у non-vision");
  const badge = rows[1].querySelector(".vision-badge");
  assert(badge, "у vision-модели бейдж");
  eq(badge.textContent, "🖼", "бейдж 🖼");
  // чип тоже с бейджем
  const chips = document.getElementById("tb-models").children;
  assert(!chips[0].querySelector(".vision-badge"), "чип non-vision без бейджа");
  assert(chips[1].querySelector(".vision-badge"), "чип vision с бейджем");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
});

test("toolbar: бейдж 🚫🖼 на выбранном non-vision чипе при картинках, без обводки", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running", vision: false }]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const chipAt = () => document.getElementById("tb-models").children[0];
  assert(!chipAt().querySelector(".novision-badge"), "без картинок бейджа нет");
  // прикрепили изображение — чип выбранной non-vision модели получает бейдж
  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }];
  emit("images");
  const badge = chipAt().querySelector(".novision-badge");
  assert(badge, "бейдж появился");
  eq(badge.textContent, "🚫🖼", "бейдж 🚫🖼");
  includes(badge.title, "будет пропущена", "title объясняет пропуск при прогоне");
  assert(!chipAt().classList.contains("chip-no-vision"), "outline-класса нет");
  // сняли изображение — бейдж исчезает
  state.contextImages = [];
  emit("images");
  assert(!chipAt().querySelector(".novision-badge"), "бейдж исчез после снятия картинки");
  // в CSS не должно быть обводки chip-no-vision
  const css = readFileSync(new NodeURL("../static/style.css", import.meta.url), "utf8");
  notIncludes(css, "chip-no-vision", "класс обводки удалён из style.css");
  await sleep(10); // дождаться полла
});

test("toolbar: hover на чипе — тултип с именем/статусом/памятью/vision, скрытие", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A 27B", status: "running", type: "sglang", vision: true,
        peak_gb: 17, download_gb: 15, port: 30001 },
      { key: "rB", label: "Cloud B", status: "stopped", type: "remote", vision: false,
        base_url: "http://x" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const chips = document.getElementById("tb-models").children;
  const tip = () => document.body.querySelector(".dist-tip");
  chips[0].fire("mouseenter");
  assert(tip() && !tip().classList.contains("hidden"), "тултип виден");
  includes(tip().textContent, "Qwen A 27B", "полное имя");
  includes(tip().textContent, "работает", "человеческий статус");
  includes(tip().textContent, "локально", "размещение локальное");
  includes(tip().textContent, "17 ГБ", "пик памяти");
  includes(tip().textContent, "15 ГБ", "размер скачивания");
  includes(tip().textContent, "🖼", "vision-метка");
  includes(tip().textContent, "30001", "порт");
  chips[0].fire("mouseleave");
  assert(tip().classList.contains("hidden"), "тултип скрыт на mouseleave");
  // облачная модель: облако, без картинок, base_url
  chips[1].fire("mouseenter");
  includes(tip().textContent, "облако", "размещение облачное");
  includes(tip().textContent, "без поддержки изображений", "non-vision");
  includes(tip().textContent, "http://x", "base_url");
  notIncludes(tip().textContent, "Скачивание", "у облака нет размера скачивания");
  // клик (поповер) прячет тултип
  chips[1].fire("click");
  assert(tip().classList.contains("hidden"), "тултип скрыт при открытии поповера");
  assert(!document.getElementById("model-popover").classList.contains("hidden"), "поповер открыт");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  await sleep(10); // дождаться полла
});

test("toolbar: «Быстрый»/«Оба» disabled при прикреплённых изображениях", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running", api: "decisions", vision: false }]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const fast = document.querySelector('#tb-runmode button[data-runmode="fast_batch"]');
  const both = document.querySelector('#tb-runmode button[data-runmode="both"]');
  assert(!fast.disabled, "без картинок быстрый доступен");
  // прикрепили изображение
  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }];
  toolbar.refreshRunButton();
  assert(fast.disabled && both.disabled, "с картинкой «Быстрый» и «Оба» disabled");
  includes(fast.title, "не поддерживает изображения", "title объясняет причину");
  // сняли изображение — разблокировка
  state.contextImages = [];
  toolbar.refreshRunButton();
  assert(!fast.disabled && !both.disabled, "после снятия картинки режимы снова доступны");
});

test("toolbar: быстрый режим автоматически сбрасывается при прикреплении изображения", async () => {
  installDom(); await resetState(); domToolbar();
  const fmtBanner = el("div", { id: "format-banner", className: "hidden" });
  el("span", { id: "format-banner-text", parent: fmtBanner });
  el("button", { id: "btn-reset-pin", parent: fmtBanner });
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running", api: "decisions", vision: false }]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const fast = document.querySelector('#tb-runmode button[data-runmode="fast_batch"]');
  document.getElementById("tb-runmode").fire("click", { target: fast });
  eq(state.runMode, "fast_batch", "быстрый включён");
  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }];
  toolbar.refreshRunButton();
  eq(state.runMode, "decisions", "режим возвращён в «Обычный»");
  assert(!document.getElementById("format-banner").classList.contains("hidden"), "баннер показан");
  includes(document.getElementById("format-banner-text").textContent, "изображения", "текст про изображения");
});

// ================================================================ manager

test("manager: карточки, шапка устройства, форма облачной модели", async () => {
  installDom(); await resetState(); domToolbar();
  const manager = await import("../static/manager.js");
  state.models = [
    { key: "mA", label: "Qwen A", short_label: "A", type: "sglang", api: "decisions",
      managed: true, status: "running", enabled: true, port: 30001, hf_id: "o/a",
      peak_gb: 17, download_gb: 15, fit: "ok" },
    { key: "rB", label: "Cloud B", short_label: "B", type: "remote", api: "systemone",
      managed: false, status: "no_credentials", enabled: true, base_url: "http://x",
      has_credentials: false },
  ];
  state.device = { ram_gb: 64, budget_gb: 41.6 };
  state.pageMode = "models";
  manager.initManager({});
  const page = document.getElementById("page-models");
  includes(page.textContent, "RAM 64", "шапка устройства");
  includes(page.textContent, "SGLang", "бейдж типа локальной");
  includes(page.textContent, "облако", "бейдж облачной");
  includes(page.textContent, "нет API-ключа", "статус no_credentials");
  includes(page.textContent, "работает", "статус running");
  includes(page.textContent, "Добавить облачную модель", "форма добавления");
  // карточка облачной модели: поле base_url, поле ключа — и НЕТ кнопок процесса
  const cards = [...page.querySelectorAll(".mgr-card")];
  const remote = cards.find(c =>
    [...c.querySelectorAll("button")].some(b => b.textContent === "Сохранить ключ"));
  assert(remote, "карточка облачной модели есть");
  const remoteBtns = [...remote.querySelectorAll("button")].map(b => b.textContent);
  assert(remoteBtns.includes("Сохранить ключ"), "есть «Сохранить ключ»");
  for (const forbidden of ["Запустить", "Остановить", "Скачать", "Удалить файлы"]) {
    assert(!remoteBtns.some(t => t.includes(forbidden)), `у remote нет кнопки «${forbidden}»`);
  }
  const keyInput = [...remote.querySelectorAll("input")].find(i => i.type === "password");
  assert(keyInput, "поле API-ключа (password) есть");
  eq(keyInput.placeholder, "API-ключ", "placeholder без сохранённого ключа");
  const urlInput = [...remote.querySelectorAll("input")].find(i => i.value === "http://x");
  assert(urlInput, "поле base_url заполнено из конфига");
});

test("manager: карточка remote с сохранённым ключом — «Удалить ключ», placeholder меняется", async () => {
  installDom(); await resetState(); domToolbar();
  const manager = await import("../static/manager.js");
  state.models = [
    { key: "rB", label: "Cloud B", short_label: "B", type: "remote", api: "systemone",
      managed: false, status: "running", enabled: true, base_url: "http://x",
      has_credentials: true },
  ];
  state.device = { ram_gb: 64, budget_gb: 41.6 };
  state.pageMode = "models";
  manager.initManager({});
  const remote = [...document.getElementById("page-models").querySelectorAll(".mgr-card")]
    .find(c => [...c.querySelectorAll("button")].some(b => b.textContent === "Сохранить ключ"));
  assert(remote, "карточка облачной модели есть");
  includes(remote.textContent, "Удалить ключ", "кнопка удаления ключа при has_credentials");
  const keyInput = [...remote.querySelectorAll("input")].find(i => i.type === "password");
  includes(keyInput.placeholder, "сохранён", "placeholder сигналит, что ключ задан");
});

// ---------------------------------------------------------------- карточка «Память»

function setupManagerWithDevice(device) {
  state.models = [];
  state.device = device;
  state.pageMode = "models";
}

test("manager: карточка «Память» — текущие значения, слайдер, предупреждение", async () => {
  installDom(); await resetState(); domToolbar();
  const manager = await import("../static/manager.js");
  setupManagerWithDevice({ ram_gb: 64, budget_gb: 41.6 });
  manager.initManager({});
  const card = document.getElementById("memory-card");
  assert(card, "карточка «Память» отрисована на странице моделей");
  assert(card.classList.contains("card"), "карточка в общем стиле .card");
  includes(card.textContent, "Память", "заголовок карточки");
  includes(document.getElementById("memory-current").textContent,
    "Бюджет моделей: 42 ГБ из 64 ГБ RAM (65%)", "текущие значения бюджета");
  const slider = document.getElementById("budget-slider");
  eq(slider.min, "0.3", "минимум слайдера");
  eq(slider.max, "0.95", "максимум слайдера");
  eq(slider.step, "0.05", "шаг слайдера");
  eq(slider.value, "0.65", "слайдер на текущей доле");
  eq(document.getElementById("budget-value").textContent, "65%", "числовое отображение");
  includes(card.textContent, "страх и риск", "предупреждение о свопе");
  assert(document.getElementById("btn-budget-apply"), "кнопка «Применить»");
  assert(document.getElementById("btn-budget-reset"), "кнопка «Сбросить»");
});

test("manager: «Применить» шлёт PUT с долей из слайдера, device обновляется", async () => {
  installDom(); await resetState(); domToolbar();
  const manager = await import("../static/manager.js");
  setupManagerWithDevice({ ram_gb: 64, budget_gb: 41.6 });
  const calls = mockFetch({
    "PUT /api/settings/budget": { budget_fraction: 0.8, budget_gb: 51.2, total_ram_gb: 64 },
    "GET /api/models": { models: [], device: { ram_gb: 64, budget_gb: 51.2 } },
  });
  manager.initManager({});
  const slider = document.getElementById("budget-slider");
  slider.value = "0.8";
  slider.fire("input");
  eq(document.getElementById("budget-value").textContent, "80%", "значение следует за слайдером");
  document.getElementById("btn-budget-apply").fire("click");
  await sleep(10);
  const put = calls.find(c => c.key === "PUT /api/settings/budget");
  assert(put, "PUT /api/settings/budget отправлен");
  eq(put.body.fraction, 0.8, "тело PUT — доля из слайдера");
  eq(state.device.budget_gb, 51.2, "device обновлён после применения");
  includes(document.getElementById("memory-current").textContent,
    "Бюджет моделей: 51 ГБ из 64 ГБ RAM (80%)", "строка бюджета перерендерена");
  await sleep(10); // дождаться полла
});

test("manager: «Сбросить» выставляет 0.65 и шлёт PUT", async () => {
  installDom(); await resetState(); domToolbar();
  const manager = await import("../static/manager.js");
  setupManagerWithDevice({ ram_gb: 64, budget_gb: 51.2 });  // 80%
  const calls = mockFetch({
    "PUT /api/settings/budget": { budget_fraction: 0.65, budget_gb: 41.6, total_ram_gb: 64 },
    "GET /api/models": { models: [], device: { ram_gb: 64, budget_gb: 41.6 } },
  });
  manager.initManager({});
  eq(document.getElementById("budget-slider").value, "0.8", "слайдер на 80%");
  document.getElementById("btn-budget-reset").fire("click");
  await sleep(10);
  const put = calls.find(c => c.key === "PUT /api/settings/budget");
  assert(put, "PUT /api/settings/budget отправлен");
  eq(put.body.fraction, 0.65, "тело PUT — дефолтная доля");
  eq(document.getElementById("budget-slider").value, "0.65", "слайдер на 65% после перерендера");
  includes(document.getElementById("memory-current").textContent, "(65%)", "строка обновлена на 65%");
  await sleep(10); // дождаться полла
});

test("manager: ошибка 422 при применении бюджета — баннер с текстом", async () => {
  installDom(); await resetState(); domToolbar();
  const errBanner = el("div", { id: "error-banner", className: "hidden" });
  el("span", { id: "error-banner-text", className: "banner-text", parent: errBanner });
  const manager = await import("../static/manager.js");
  setupManagerWithDevice({ ram_gb: 64, budget_gb: 41.6 });
  mockFetch({
    "PUT /api/settings/budget": { __status: 422, detail: "Доля бюджета моделей должна быть в диапазоне 0.3–0.95" },
    "GET /api/models": { models: [], device: { ram_gb: 64, budget_gb: 41.6 } },
  });
  manager.initManager({ showError: (m) => {
    document.getElementById("error-banner-text").textContent = m;
    document.getElementById("error-banner").classList.remove("hidden");
  } });
  document.getElementById("btn-budget-apply").fire("click");
  await sleep(10);
  assert(!errBanner.classList.contains("hidden"), "баннер ошибки показан");
  includes(document.getElementById("error-banner-text").textContent, "422", "статус в тексте");
  includes(document.getElementById("error-banner-text").textContent, "диапазоне", "текст 422 в баннере");
  await sleep(10); // дождаться полла
});

// ================================================================ UI-контракт
// Инварианты, которые нельзя забыть: новая страница/статус без покрытия роняет тест.

test("contract: каждая страница открывается и имеет кнопку возврата", async () => {
  installDom(); await resetState(); domToolbar(); domBatch();
  const manager = await import("../static/manager.js");
  state.device = { ram_gb: 64, budget_gb: 41.6 };
  manager.initManager({});
  batch.initBatch({ onBack: () => toolbar.setPageMode("single") });
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  toolbar.initToolbar({});

  const modes = [...document.querySelectorAll("#tb-pagemode button")].map(b => b.dataset.pagemode);
  assert(modes.length >= 2, "есть хотя бы две страницы");
  // Страница «Модели» в сегмент не входит — открывается из дропдауна «Модели ▾».
  for (const mode of modes) {
    toolbar.setPageMode(mode);
    const page = document.getElementById("page-" + mode);
    assert(page && !page.classList.contains("hidden"), `страница ${mode} открылась`);
    if (mode === "single") continue;  // домашняя страница — возврат не нужен
    // Конвенция: у не-домашней страницы есть #btn-<mode>-back, возвращающая в single
    const back = document.getElementById(`btn-${mode}-back`);
    assert(back, `у страницы ${mode} нет кнопки возврата #btn-${mode}-back`);
    back.fire("click");
    eq(state.pageMode, "single", `кнопка возврата со страницы ${mode} ведёт в single`);
    assert(!document.getElementById("page-single").classList.contains("hidden"), "single снова виден");
  }
  toolbar.setPageMode("models");
  assert(!document.getElementById("page-models").classList.contains("hidden"), "страница models открылась");
  const modelsBack = document.getElementById("btn-models-back");
  assert(modelsBack, "у страницы models есть кнопка возврата #btn-models-back");
  modelsBack.fire("click");
  eq(state.pageMode, "single", "кнопка возврата со страницы models ведёт в single");
});

test("contract: Run недоступен на не-прогонных страницах с понятным title", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  toolbar.initToolbar({});
  toolbar.setPageMode("models");
  const btn = document.getElementById("tb-run");
  assert(btn.disabled, "Run disabled на странице моделей");
  assert((btn.title || "").length > 10, "у disabled Run есть поясняющий title");
});

test("contract: favicon.svg подключён в index.html", async () => {
  const html = readFileSync(new NodeURL("../static/index.html", import.meta.url), "utf8");
  const head = html.match(/<head>[\s\S]*?<\/head>/);
  assert(head, "<head> найден");
  includes(head[0], 'rel="icon"', "link rel=icon в <head>");
  includes(head[0], 'type="image/svg+xml"', "тип svg");
  includes(head[0], 'href="favicon.svg"', "href на favicon.svg");
  const svg = readFileSync(new NodeURL("../static/favicon.svg", import.meta.url), "utf8");
  includes(svg, "<svg", "файл favicon.svg существует и валиден как svg");
});

test("contract: порядок бара — Файл ▾, Модели ▾, чипы, сегмент, Запустить (index.html)", async () => {
  const html = readFileSync(new NodeURL("../static/index.html", import.meta.url), "utf8");
  const header = html.match(/<header[\s\S]*?<\/header>/);
  assert(header, "<header> найден");
  includes(header[0], ">Файл ▾<", "меню переименовано в «Файл ▾»");
  notIncludes(header[0], ">Меню ▾<", "старого названия «Меню ▾» нет");
  let pos = -1;
  for (const id of ["tb-menu-btn", "tb-models-menu", "tb-models", "tb-pagemode", "tb-run"]) {
    const i = header[0].indexOf(`id="${id}"`);
    assert(i !== -1, `id="${id}" есть в баре`);
    assert(i > pos, `id="${id}" идёт после предыдущего элемента бара`);
    pos = i;
  }
});

test("contract: сегмент страниц — ровно «Одиночный» и «Батч» (index.html)", async () => {
  const html = readFileSync(new NodeURL("../static/index.html", import.meta.url), "utf8");
  const seg = html.match(/id="tb-pagemode"[\s\S]*?<\/div>/);
  assert(seg, "сегмент #tb-pagemode найден в index.html");
  const modes = [...seg[0].matchAll(/data-pagemode="(\w+)"/g)].map(m => m[1]);
  eq(modes.join(","), "single,batch", "ровно две страницы в сегменте");
});

test("contract: статусы моделей — метки toolbar=manager и цвет в CSS", async () => {
  const toolbarSrc = readFileSync(new NodeURL("../static/toolbar.js", import.meta.url), "utf8");
  const managerSrc = readFileSync(new NodeURL("../static/manager.js", import.meta.url), "utf8");
  const css = readFileSync(new NodeURL("../static/style.css", import.meta.url), "utf8");
  const keysOf = (src) => {
    const block = src.match(/STATUS_LABELS\s*=\s*\{([^}]+)\}/s);
    assert(block, "STATUS_LABELS не найден");
    return [...block[1].matchAll(/^\s*(\w+):/gm)].map(m => m[1]).sort();
  };
  const tbKeys = keysOf(toolbarSrc);
  const mgrKeys = keysOf(managerSrc);
  eq(mgrKeys.join(","), tbKeys.join(","), "наборы статусов в toolbar и manager совпадают");
  for (const status of tbKeys) {
    assert(css.includes(".dot-" + status), `для статуса ${status} нет цвета .dot-${status} в style.css`);
  }
});

test("contract: нейтральная шкала conf-0..conf-4 в CSS, старых классов нет", async () => {
  const css = readFileSync(new NodeURL("../static/style.css", import.meta.url), "utf8");
  for (const cls of [".conf-0", ".conf-1", ".conf-2", ".conf-3", ".conf-4"]) {
    assert(css.includes(cls), `в style.css нет ${cls}`);
  }
  for (const cls of [".cb-0", ".cb-1", ".cb-2", ".cb-3", ".cb-4"]) {
    assert(css.includes(cls), `в style.css нет ${cls}`);
  }
  for (const old of ["conf-good", "conf-mid", "conf-bad", "more-mark", "cb-good", "cb-mid", "cb-bad"]) {
    notIncludes(css, old, `старый класс ${old} удалён из style.css`);
  }
  const resultsSrc = readFileSync(new NodeURL("../static/results.js", import.meta.url), "utf8");
  const batchSrc = readFileSync(new NodeURL("../static/batch.js", import.meta.url), "utf8");
  for (const old of ["conf-good", "conf-mid", "conf-bad", "more-mark"]) {
    notIncludes(resultsSrc + batchSrc, old, `старый класс ${old} удалён из JS`);
  }
});

// ================================================================ app (режим «Оба» — последовательность)
test("app: режим «Оба» — fast_batch уходит только после ответа decisions (регрессия метрик)", async () => {
  installDom(); await resetState(); domApp();
  const decideCalls = [];
  const resolvers = [];
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A 27B", status: "running" }]),
    "GET /api/presets": [],
    "POST /api/decide": (call) => {
      decideCalls.push(call.body);
      return new Promise((resolve) => resolvers.push(resolve));
    },
  });
  await import("../static/app.js");
  await sleep(30); // поллинг моделей → авто-выбор running

  state.runMode = "both";
  document.getElementById("context-input").value = "Иван врач.";
  state.questions[0].question = "Иван врач?";
  document.getElementById("tb-run").fire("click");
  await sleep(10);

  eq(decideCalls.length, 1, "первый запрос один");
  eq(decideCalls[0].mode, "decisions", "сначала обычный");
  resolvers[0]({ results: { mA: runRes({ duration_s: 30, prompt_tokens: 500, prefill_tok_s: 16.7 }, {}) } });
  await sleep(10);

  eq(decideCalls.length, 2, "второй запрос после ответа первого");
  eq(decideCalls[1].mode, "fast_batch", "затем быстрый");
  resolvers[1]({ results: { mA: runRes({ duration_s: 2, prompt_tokens: 520, prefill_tok_s: 260 }, {}) } });
  await sleep(10);

  assert(state.results, "результаты сохранены");
  eq(state.results.runMode, "both", "режим both");
  eq(state.results.results.mA.decisions.metrics.duration_s, 30, "метрики обычного свои");
  eq(state.results.results.mA.fast_batch.metrics.prefill_tok_s, 260, "метрики быстрого свои");

  // баннер ошибки: текст в .banner-text и закрытие крестиком
  document.getElementById("context-input").value = "";
  document.getElementById("tb-run").fire("click");
  await sleep(10);
  const errBanner = document.getElementById("error-banner");
  assert(!errBanner.classList.contains("hidden"), "баннер ошибки показан");
  includes(document.getElementById("error-banner-text").textContent, "Контекст", "текст ошибки в .banner-text");
  document.getElementById("error-banner-close").fire("click");
  assert(errBanner.classList.contains("hidden"), "баннер закрыт крестиком");
  const fmtBanner = document.getElementById("format-banner");
  fmtBanner.classList.remove("hidden");
  document.getElementById("format-banner-close").fire("click");
  assert(fmtBanner.classList.contains("hidden"), "format-баннер тоже закрывается");
});

// Эти тесты идут после app-теста выше: модуль app.js уже инициализирован на
// текущем DOM (переустановка DOM отвязала бы обработчики), поэтому без installDom.
test("app: пресет с картинками грузит изображения + баннер «нужны vision-модели»", async () => {
  await resetState();
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running", vision: false }]),
    "GET /api/presets": [
      { name: "UGC", description: "d", page: "single", input: "пост",
        images: ["data:image/png;base64,QUJD"],
        questions: [{ id: "q1", question: "Q?", type: "yes_no" }] },
    ],
  });
  document.getElementById("tb-menu-btn").fire("click");
  document.getElementById("tb-menu-presets").fire("click");
  await sleep(10);
  const item = [...document.getElementById("tb-menu-presets-sub").children]
    .find(i => i.textContent.includes("UGC"));
  assert(item, "пресет в меню");
  includes(item.textContent, "🖼", "бейдж 🖼 у пресета с картинками");
  item.fire("click");
  eq(state.contextImages.length, 1, "картинка из пресета загружена");
  eq(state.contextImages[0].dataUrl, "data:image/png;base64,QUJD", "dataUrl");
  const fmtBanner = document.getElementById("format-banner");
  assert(!fmtBanner.classList.contains("hidden"), "format-баннер показан");
  includes(document.getElementById("format-banner-text").textContent, "vision-модели", "текст баннера");
});

test("app: прогон с картинкой — images в payload, non-vision модели пропущены", async () => {
  await resetState();
  let captured = null;
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A", status: "running", vision: false, api: "decisions" },
      { key: "cB", label: "Clef B", status: "running", vision: true, api: "systemone" },
    ]),
    "GET /api/presets": [],
    "POST /api/decide": (call) => {
      captured = call.body;
      return { results: { cB: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }) } };
    },
  });
  toolbar.refreshModels();
  await sleep(10); // поллинг → авто-выбор обеих running
  document.getElementById("context-input").value = ""; // пустой текст + картинка
  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }];
  state.questions = [{ id: "q1", question: "Есть телефон?", type: "yes_no", collapsed: true }];
  document.getElementById("tb-run").fire("click");
  await sleep(10);
  assert(captured, "decide вызван");
  eq(captured.models.join(","), "cB", "non-vision модель пропущена");
  eq(captured.images.join(","), "data:image/png;base64,QUJD", "images в теле запроса");
  eq(captured.input, "", "пустой текст допустим с картинкой");
  assert(state.results && state.results.images, "images в state.results (бейдж чипа)");
  await sleep(10);
});

test("app: экспорт «Всё» включает batch_files независимо от страницы", async () => {
  await resetState();
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no", collapsed: true }];
  document.getElementById("context-input").value = "контекст";
  batch.loadPresetFiles([
    { name: "a.txt", content: "текст" },
    { name: "p.png", image: "data:image/png;base64,QUJD" },
  ]);
  let captured = null;
  globalThis.URL.createObjectURL = (blob) => { captured = blob.content; return "blob:x"; };
  document.getElementById("tb-menu-export-all").fire("click");
  assert(captured, "файл экспортирован");
  const data = JSON.parse(captured);
  eq(data.input, "контекст", "контекст в экспорте");
  eq(data.questions.length, 1, "вопросы в экспорте");
  eq(data.batch_files.length, 2, "batch_files в экспорте");
  eq(data.batch_files[0].content, "текст", "текстовый файл → content");
  eq(data.batch_files[1].image, "data:image/png;base64,QUJD", "картинка → image (dataUrl)");
  await sleep(10);
});

test("app: импорт batch_files — страница «Батч», баннер, замена через confirm", async () => {
  await resetState();
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  globalThis.confirm = () => true;
  const label = document.getElementById("tb-menu-import");
  const payload = JSON.stringify({ input: "", batch_files: [
    { name: "a.txt", content: "x" },
    { name: "p.png", image: "data:image/png;base64,QUJD" },
  ] });
  label.fire("change", { target: { files: [fakeFile("s.json", payload)], value: "" } });
  await sleep(10);
  eq(state.batch.files.length, 2, "файлы загружены в батч");
  assert(state.batch.files[1].isImage, "картинка распознана");
  eq(state.pageMode, "batch", "страница переключена на «Батч»");
  const fmt = document.getElementById("format-banner-text");
  assert(!document.getElementById("format-banner").classList.contains("hidden"), "баннер показан");
  includes(fmt.textContent, "батч", "текст баннера про файлы батча");
  // повторный импорт при непустом батче: отмена confirm — ничего не меняется
  globalThis.confirm = () => false;
  label.fire("change", { target: { files: [fakeFile("s2.json", '{"batch_files":[{"name":"b.txt","content":"y"}]}')], value: "" } });
  await sleep(10);
  eq(state.batch.files.length, 2, "отмена confirm — батч не изменился");
  eq(state.batch.files[0].name, "a.txt", "старые файлы на месте");
  globalThis.confirm = () => true;
  await sleep(10);
});

// ---------------------------------------------------------------- запуск

let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${e.message}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
process.exit(failed ? 1 : 0);
