// Общий харнес фронтенд-тестов: мини-раннер, ассерты, DOM-фикстуры,
// общие данные-хелперы и синглтоны модулей frontend/static.
// Доменные тесты — в *.test.mjs рядом; точка входа — run.mjs.

import {
  installDom, el, fakeFile, resetState, mockFetch, sleep,
} from "./dom-mock.mjs";

export { installDom, el, fakeFile, resetState, mockFetch, sleep };

installDom();

export const { state, emit } = await import("../static/state.js");
export const layout = await import("../static/layout.js");
export const results = await import("../static/results.js");
export const questions = await import("../static/questions.js");
export const context = await import("../static/context.js");
export const batch = await import("../static/batch.js");
export const toolbar = await import("../static/toolbar.js");
export const lightbox = await import("../static/lightbox.js");
export const preview = await import("../static/preview.js");
export const update = await import("../static/update.js");
export const presetsMod = await import("../static/presets.js");
export const assistant = await import("../static/assistant.js");

// ---------------------------------------------------------------- мини-раннер

const tests = [];
export function test(name, fn) { tests.push([name, fn]); }

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}
export function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || "eq"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
export function includes(hay, needle, msg) {
  if (!String(hay).includes(needle)) {
    throw new Error(`${msg || "includes"}: «${needle}» не найдено в «${String(hay).slice(0, 220)}»`);
  }
}
export function notIncludes(hay, needle, msg) {
  if (String(hay).includes(needle)) {
    throw new Error(`${msg || "notIncludes"}: «${needle}» найдено в «${String(hay).slice(0, 220)}»`);
  }
}
export function throws(fn, part, msg) {
  try { fn(); } catch (e) {
    if (part && !String(e.message).includes(part)) {
      throw new Error(`${msg || "throws"}: ошибка «${e.message}» не содержит «${part}»`);
    }
    return;
  }
  throw new Error(`${msg || "throws"}: исключение не брошено`);
}

export async function runAll() {
  let passed = 0, failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`ok   ${name}`);
    } catch (e) {
      failed += 1;
      console.error(`FAIL ${name}\n     ${e.stack ? e.stack.split("\n").slice(0, 4).join("\n     ") : e.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------- фикстуры DOM

export function domLayout() {
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

export function domResults() {
  const sticky = el("div", { id: "results-sticky", className: "hidden" });
  el("span", { id: "results-summary", parent: sticky });
  el("span", { id: "results-agree", className: "hidden", parent: sticky });
  el("div", { id: "run-chips", parent: sticky });
  el("div", { id: "decision-chips", className: "hidden", parent: sticky });
  el("div", { id: "both-hint", className: "hidden", parent: sticky });
  el("div", { id: "results-list" });
}

export function domQuestions() {
  el("div", { id: "questions-list" });
  el("div", { id: "questions-empty", text: "Нет вопросов — добавьте первый кнопкой «+ Вопрос»." });
}

export function domContext() {
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

export function domBatch() {
  const split = el("div", { id: "split-batch", className: "split" });
  const pl = el("section", { id: "batch-panel-left", className: "panel left", parent: split });
  const paL = el("span", { className: "panel-actions", parent: pl });
  el("button", { className: "icon-btn", parent: paL, dataset: { panel: "left", action: "fullscreen" } });
  el("button", { className: "icon-btn", parent: paL, dataset: { panel: "left", action: "collapse" } });
  const body = el("div", { className: "panel-body", parent: pl });
  const filesCard = el("section", { id: "batch-files-card", className: "card", parent: body });
  el("div", { id: "batch-drop", parent: filesCard });
  el("input", { id: "batch-files", parent: filesCard });
  el("div", { id: "batch-list", parent: filesCard });
  el("div", { id: "batch-warn", className: "hidden", parent: filesCard });
  el("button", { id: "btn-batch-clear", parent: filesCard });
  el("div", { id: "vsplit-batch", className: "vsplitter", parent: body });
  const zone = el("div", { className: "vsplit-bottom-zone", parent: body });
  const qCard = el("section", { id: "batch-questions-card", className: "card", parent: zone });
  el("button", { id: "btn-add-question-batch", parent: qCard });
  el("div", { id: "batch-questions-list", parent: qCard });
  el("div", { id: "batch-questions-empty", className: "questions-empty", parent: qCard,
    text: "Нет вопросов — добавьте первый кнопкой «+ Вопрос»." });
  const dCard = el("section", { id: "batch-decision-card", className: "card", parent: zone });
  el("input", { id: "batch-decision-enabled", parent: dCard });
  el("div", { id: "batch-decision-list", parent: dCard });
  el("div", { id: "batch-decision-empty", parent: dCard });
  el("div", { id: "batch-decision-hints", parent: dCard });
  el("div", { id: "splitter-batch", className: "splitter", parent: split });
  el("div", { id: "batch-restore-left", className: "panel-restore hidden", parent: split });
  el("div", { id: "batch-restore-right", className: "panel-restore hidden", parent: split });
  const pr = el("section", { id: "batch-panel-right", className: "panel right", parent: split });
  const paR = el("span", { className: "panel-actions", parent: pr });
  el("button", { className: "icon-btn", parent: paR, dataset: { panel: "right", action: "fullscreen" } });
  el("button", { className: "icon-btn", parent: paR, dataset: { panel: "right", action: "collapse" } });
  const resultsCard = el("section", { id: "batch-results-card", className: "card", parent: pr });
  el("button", { id: "btn-batch-cancel", className: "hidden", parent: resultsCard });
  el("span", { id: "batch-progress", parent: resultsCard });
  const wrap = el("div", { id: "batch-progress-wrap", className: "hidden", parent: resultsCard });
  el("div", { id: "batch-progress-fill", parent: wrap });
  el("div", { id: "batch-results", parent: resultsCard });
}

export function domToolbar() {
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
  el("div", { id: "tb-menu-save-preset", parent: dd });
  el("div", { id: "tb-menu-presets-manager", parent: dd });

  // кнопки «свернуть/развернуть всё» в шапках панелей «Редактор»/«Ввод»
  el("button", { id: "btn-collapse-all-single" });
  el("button", { id: "btn-expand-all-single" });
  el("button", { id: "btn-collapse-all-batch" });
  el("button", { id: "btn-expand-all-batch" });

  const pagemode = el("div", { id: "tb-pagemode" });
  el("button", { parent: pagemode, dataset: { pagemode: "single" } });
  el("button", { parent: pagemode, dataset: { pagemode: "batch" } });
  const runGroup = el("div", { className: "tb-run-group" });
  el("button", { id: "tb-run", parent: runGroup });
  el("button", { id: "tb-run-options", text: "▾", parent: runGroup });
  el("span", { id: "tb-run-spinner", className: "hidden", parent: runGroup });
  el("main", { id: "page-single" });
  el("main", { id: "page-batch", className: "hidden" });
  el("main", { id: "page-models", className: "hidden" });
  el("main", { id: "page-presets", className: "hidden" });
}

export function domAssistant() {
  el("button", { id: "tb-assistant" });
  const panel = el("aside", { id: "assistant-panel", className: "assistant-panel hidden" });
  el("div", { id: "assistant-resize", parent: panel });
  el("button", { id: "assistant-close", parent: panel });
  const chat = el("div", { id: "assistant-chat", parent: panel });
  const msgs = el("div", { id: "assistant-messages", parent: chat });
  el("div", { className: "assistant-intro", parent: msgs, text: "Примеры запросов" });
  const area = el("div", { className: "assistant-input-area", parent: chat });
  el("textarea", { id: "assistant-input", parent: area });
  el("button", { id: "assistant-send", parent: area });
  const footer = el("div", { className: "assistant-footer", parent: panel });
  el("select", { id: "assistant-model", parent: footer });
  el("input", { id: "assistant-thinking", parent: footer });
  el("button", { id: "assistant-reset", parent: footer });
}

// Ответ GET /api/models v2: {models, device}
export function modelsResp(models) {
  return { models, device: { ram_gb: 64, budget_gb: 41.6 } };
}

export function domApp() {
  const errBanner = el("div", { id: "error-banner", className: "hidden" });
  el("span", { id: "error-banner-text", className: "banner-text", parent: errBanner });
  el("button", { id: "error-banner-close", className: "banner-close", parent: errBanner });
  const fmtBanner = el("div", { id: "format-banner", className: "hidden" });
  el("span", { id: "format-banner-text", className: "banner-text", parent: fmtBanner });
  el("button", { id: "btn-reset-pin", parent: fmtBanner });
  el("button", { id: "format-banner-close", className: "banner-close", parent: fmtBanner });
  el("button", { id: "btn-add-question" });
  el("button", { id: "btn-gen-questions" });
  el("button", { id: "btn-gen-questions-batch" });
  el("button", { id: "btn-add-outcome" });
  el("button", { id: "btn-add-outcome-batch" });
  el("button", { id: "btn-gen-decision" });
  el("button", { id: "btn-gen-decision-batch" });
  el("input", { id: "decision-enabled" });
  el("div", { id: "decision-list" });
  el("div", { id: "decision-empty" });
  el("div", { id: "decision-hints" });
  domToolbar();
  domLayout();
  domResults();
  domQuestions();
  domContext();
  domBatch();
  domAssistant();
}

// ---------------------------------------------------------------- данные

export function ansYesNo(yes, no) {
  return { type: "yes_no", probabilities: { yes, no }, label_mass: 0.99 };
}
export function runRes(metrics, answers) {
  return { ok: true, answers, usage: { prompt_tokens: metrics.prompt_tokens }, metrics, prompt_format_version: 1 };
}
export function setupBothResults() {
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
