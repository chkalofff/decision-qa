// Общий харнес фронтенд-тестов: мини-раннер, ассерты, DOM-фикстуры,
// общие данные-хелперы и синглтоны модулей frontend/static.
// Доменные тесты — в *.test.mjs рядом; точка входа — run.mjs.

import {
  installDom, el, fakeFile, resetState, mockFetch, sleep, restoreGlobalProperty,
} from "./dom-mock.mjs";

export { installDom, el, fakeFile, resetState, mockFetch, sleep, restoreGlobalProperty };

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
export const persist = await import("../static/persist.js");
export const saveas = await import("../static/saveas.js");
export const review = await import("../static/review.js");
export const runClient = await import("../static/run_client.js");
export const alreadyRun = await import("../static/already_run.js");
export const configPack = await import("../static/config_pack.js");
export const documents = await import("../static/documents.js");
export const documentsUi = await import("../static/documents_ui.js");
export const workshop = await import("../static/workshop.js");
export const workshopUi = await import("../static/workshop_ui.js");

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
  const card = el("div", { id: "results-card", className: "panel-body" });
  const sticky = el("div", { id: "results-sticky", className: "hidden", parent: card });
  el("span", { id: "results-summary", parent: sticky });
  el("span", { id: "results-agree", className: "hidden", parent: sticky });
  el("div", { id: "run-chips", parent: sticky });
  el("div", { id: "decision-chips", className: "hidden", parent: sticky });
  el("div", { id: "both-hint", className: "hidden", parent: sticky });
  el("div", { id: "results-list", parent: card });
}

export function domQuestions() {
  el("div", { id: "questions-list" });
  el("div", { id: "questions-empty", text: "Нет вопросов — добавьте первый кнопкой «+ Вопрос»." });
}

export function domContext() {
  const card = el("section", { id: "context-card", className: "card" });
  const head = el("div", { className: "section-head", parent: card });
  el("h2", { text: "Материалы", parent: head });
  const modeToggle = el("div", { className: "mode-toggle", parent: head });
  const modeSeg = el("div", { className: "mode-seg", parent: modeToggle });
  el("button", { id: "mode-text", className: "active", parent: modeSeg });
  el("button", { id: "mode-json", parent: modeSeg });
  const wrap = el("div", { className: "menu-wrap fold-menu-wrap", parent: modeToggle });
  el("button", { id: "btn-fold-menu", className: "icon-btn hidden", parent: wrap });
  const menu = el("div", { id: "fold-menu", className: "hidden", parent: wrap });
  for (const action of ["unfold", "1", "2", "3", "4", "all"]) {
    el("div", { className: "menu-item", parent: menu }).dataset.fold = action;
  }
  el("button", { id: "btn-context-fs", text: "⛶", parent: modeToggle });
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
  const filesHead = el("div", { className: "section-head", parent: filesCard });
  el("h2", { text: "Материалы", parent: filesHead });
  el("div", { id: "batch-drop", parent: filesCard });
  el("input", { id: "batch-files", parent: filesCard });
  el("div", { id: "batch-list", parent: filesCard });
  el("div", { id: "batch-warn", className: "hidden", parent: filesCard });
  el("button", { id: "btn-batch-clear", parent: filesCard });
  const qCard = el("section", { id: "batch-questions-card", className: "card", parent: body });
  const qHead = el("div", { className: "section-head", parent: qCard });
  el("h2", { text: "Вопросы", parent: qHead });
  el("button", { id: "btn-add-question-batch", parent: qCard });
  el("div", { id: "batch-questions-list", parent: qCard });
  el("div", { id: "batch-questions-empty", className: "questions-empty", parent: qCard,
    text: "Нет вопросов — добавьте первый кнопкой «+ Вопрос»." });
  const dCard = el("section", { id: "batch-decision-card", className: "card", parent: body });
  const dHead = el("div", { className: "section-head", parent: dCard });
  el("h2", { text: "Решение", parent: dHead });
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
  el("input", { id: "run-threads", parent: runPop });
  el("div", { id: "run-threads-note", parent: runPop });
  for (const t of ["1", "0.5", "2"]) {
    el("button", { parent: runPop, dataset: { temp: t } });
  }
  el("div", { id: "temp-lock-note", className: "hidden", parent: runPop });
  el("div", { id: "model-popover", className: "hidden" });

  el("button", { id: "tb-menu-btn" });
  const dd = el("div", { id: "tb-menu", className: "menu-dropdown menu-left hidden" });
  el("span", { id: "tb-document-name" });
  el("div", { id: "tb-menu-documents-open", parent: dd });
  el("div", { id: "tb-menu-doc-duplicate", parent: dd });
  el("div", { id: "tb-menu-doc-rename", parent: dd });
  el("div", { id: "tb-menu-new", parent: dd });
  const openLbl = el("label", { id: "tb-menu-open", parent: dd });
  el("input", { id: "import-file", parent: openLbl });
  el("div", { id: "tb-menu-save-as", parent: dd });
  const presets = el("div", { id: "tb-menu-presets", parent: dd });
  el("div", { id: "tb-menu-presets-sub", className: "hidden", parent: presets });
  el("div", { id: "tb-menu-save-preset", parent: dd });
  el("div", { id: "tb-menu-presets-manager", parent: dd });
  const persistLbl = el("label", { id: "tb-menu-persist-item", parent: dd });
  el("input", { id: "tb-menu-persist", parent: persistLbl });

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
  el("span", { id: "assistant-mode", parent: panel });
  el("span", { id: "assistant-pending", className: "assistant-pending-chip hidden", parent: panel });
  const msgs = el("div", { id: "assistant-messages", parent: chat });
  el("div", { className: "assistant-intro", parent: msgs, text: "Примеры запросов" });
  el("div", { id: "assistant-chips", parent: chat });
  const area = el("div", { className: "assistant-input-area", parent: chat });
  el("textarea", { id: "assistant-input", parent: area });
  el("button", { id: "assistant-send", parent: area });
  const footer = el("div", { className: "assistant-footer", parent: panel });
  el("select", { id: "assistant-model", parent: footer });
  el("input", { id: "assistant-thinking", parent: footer });
  el("button", { id: "assistant-reset", parent: footer });
}

export const TEST_RUN_ID = "run_" + "1".repeat(32);

export function runCapabilities(overrides = {}) {
  return {
    schema: 1, min_schema: 1, max_schema: 1, pack_version: 1, fingerprint_version: 1,
    default_threads: 2, max_threads: 8, max_files_per_chunk: 50,
    max_files_per_job: 100000, max_chunk_bytes: 24 * 1024 * 1024,
    max_images: 3, max_images_b64_chars: 1000000,
    default_page_limit: 50, max_page_limit: 200,
    features: { after_seq: true, cancel: true }, modes: ["decisions", "fast_batch", "both"],
    ...overrides,
  };
}

export function runApiRoutes({ runId = TEST_RUN_ID, onFile, onCreate, onStart, onSse } = {}) {
  const uploaded = [];
  let createBody = null;
  let effectiveConfig = null;
  let status = "uploading";
  const metadata = () => ({
    run_id: runId, status, material_count: createBody?.material_count || uploaded.length,
    config_fingerprint: effectiveConfig?.fingerprint || "sha256:config",
    materials_fingerprint: createBody?.materials_fingerprint,
    run_fingerprint: "sha256:run", effective_config: effectiveConfig || {},
    threads_requested: createBody?.threads ?? null, threads_effective: createBody?.threads || 2,
    summary: { files_total: uploaded.length, files_completed: uploaded.length,
      files_ok: uploaded.length, files_failed: 0, files_pending: 0 },
  });
  const file = async (item) => {
    if (onFile) return onFile(item, createBody);
    const models = createBody.overrides?.models || createBody.pack.settings.models;
    const mode = createBody.overrides?.mode || createBody.pack.settings.mode;
    const runs = [];
    for (const model of models) {
      runs.push({ model, mode: "decisions", ok: true,
        answers: { q1: ansYesNo(0.8, 0.2) }, usage: { prompt_tokens: 10 },
        metrics: { duration_s: 1, prompt_tokens: 10, prefill_tok_s: 10 }, prompt_format_version: 1 });
      if (mode === "both") runs.push({ model, mode: "fast_batch", ok: true,
        answers: { q1: ansYesNo(0.7, 0.3) }, usage: { prompt_tokens: 12 },
        metrics: { duration_s: 2, prompt_tokens: 12, prefill_tok_s: 6 }, prompt_format_version: 1 });
    }
    return { type: "file", i: item.i, name: item.name, content_sha256: item.content_sha256,
      status: "ok", runs, aggregate: {}, errors: [], models_skipped: [], duration_s: 1 };
  };
  const resultPage = async () => {
    const files = await Promise.all(uploaded.map(file));
    const visible = status === "cancelled" ? files.slice(0, 1) : files;
    return { files: visible, offset: 0, limit: 50, returned: visible.length,
      completed: visible.length, total: uploaded.length, next_offset: null, status };
  };
  const routes = {
    "GET /api/run/capabilities": runCapabilities(),
    "POST /api/run": async (call) => {
      createBody = call.body;
      effectiveConfig = await configPack.effectivePack(call.body.pack, call.body.overrides || {});
      if (onCreate) onCreate(call);
      return metadata();
    },
    [`POST /api/run/${runId}/files`]: (call) => {
      uploaded.push(...call.body.files);
      uploaded.sort((a, b) => a.i - b.i);
      routes[`GET /api/run/${runId}/files?offset=0&limit=50`] = resultPage;
      return { run_id: runId, chunk_index: call.body.chunk_index, accepted: true, uploaded: uploaded.length };
    },
    [`POST /api/run/${runId}/start`]: (call) => {
      status = "running";
      if (onStart) onStart(call);
      return metadata();
    },
    [`GET /api/run/${runId}`]: () => metadata(),
    [`GET /api/run/${runId}/files?offset=0&limit=50`]: resultPage,
    [`POST /api/run/${runId}/cancel`]: () => { status = "cancelled"; return metadata(); },
    [`GET /api/run/${runId}/events?after=0`]: async () => {
      status = "completed";
      const events = [{ type: "run_start", run_id: runId, files_total: uploaded.length,
        models: createBody.overrides?.models, mode: createBody.overrides?.mode, threads_effective: createBody?.threads || 2 }];
      const completedFiles = await Promise.all(uploaded.map(file));
      events.push(...completedFiles);
      const actualFormats = {};
      for (const item of completedFiles) {
        for (const run of item.runs || []) {
          if (run.prompt_format_version != null) actualFormats[run.model] = run.prompt_format_version;
        }
      }
      if (Object.keys(actualFormats).length) {
        effectiveConfig.settings.prompt_formats = {
          ...(effectiveConfig.settings.prompt_formats || {}), ...actualFormats,
        };
        effectiveConfig = await configPack.finalizePack(effectiveConfig);
      }
      events.push({ type: "run_end", run_id: runId, status, summary: metadata().summary, duration_s: 1 });
      const text = events.map((event, index) => `id: ${index + 1}\ndata: ${JSON.stringify({ ...event, seq: index + 1 })}\n\n`).join("");
      return { __sse: onSse ? await onSse(text) : text };
    },
  };
  return routes;
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
  const docConflict = el("div", { id: "doc-conflict-banner", className: "error-banner hidden" });
  el("span", { id: "doc-conflict-text", parent: docConflict });
  const backupPicker = el("span", { id: "doc-backup-picker", className: "hidden", parent: docConflict });
  el("select", { id: "doc-conflict-backups", parent: backupPicker });
  el("button", { id: "doc-recover-backup", parent: backupPicker });
  el("button", { id: "doc-reload", parent: docConflict });
  el("button", { id: "doc-keep", parent: docConflict });
  const docStorage = el("div", { id: "doc-storage-banner", className: "error-banner hidden" });
  el("span", { id: "doc-storage-text", parent: docStorage });
  el("button", { id: "doc-storage-close", parent: docStorage });
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
