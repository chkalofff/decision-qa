// Точка входа: пресеты, запуск прогонов, связывание модулей.

import { state, emit, selectedModelKeys } from "./state.js";
import { executeRun, singleResultsFromFile, singleRunLinks } from "./run_client.js";
import {
  addQuestion, buildQuestionsPayload, setQuestions,
  mountQuestions, renderQuestions, withDirections, normalizeQuestion,
} from "./questions.js";
import { mountDecision, addOutcome, validateDecision, setDecision } from "./decision.js";
import { renderResults } from "./results.js";
import { initToolbar, refreshRunButton, refreshModels, setPageMode } from "./toolbar.js";
import { initManager } from "./manager.js";
import { initPresets, openPresetsPage, openSaveDialog } from "./presets.js";
import { initLayout } from "./layout.js";
import { initBlockCollapse } from "./blockcollapse.js";
import { initUpdate } from "./update.js";
import { initAssistant, updateModeChip } from "./assistant.js";
import { initHelp, tourWillAutoStart } from "./help.js";
import { openGenerateDialog } from "./generate.js";
import { generateQuestions, generateDecision } from "./api.js";
import { initBatch, isBatchEmpty, resetBatch, runBatch, loadPresetFiles, batchFilesSnapshot, renderBatchList, renderBatchResults } from "./batch.js";
import { applyDemoSingleRun, applyDemoBatchResults } from "./demo-data.js";
import {
  initContext, buildInput, buildImagesPayload, setContent, setImages, hasContent,
  contextSnapshot, importJsonFile, currentText,
} from "./context.js";
import { singleFingerprint } from "./fingerprint.js";
import { initStaleTracking, clearSingleResults } from "./stale.js";
import { openSaveAsDialog } from "./saveas.js";
import { packFromState, effectivePack } from "./config_pack.js";
import { pausePersist, resumePersist } from "./persist.js";
import { initDocuments, createNewDocument } from "./documents_ui.js";
import { initReview, resetFilter } from "./review.js";
import { initNavigator } from "./navigator.js";
import { askAppendOrReplace } from "./rerun.js";
import { apiFetch, initAuth } from "./auth.js";
import { initAlreadyRun } from "./already_run.js";
import { beginRun, runIsCurrent, trackRunJob, finishRun } from "./run_lifecycle.js";
import { initWorkshop } from "./workshop_ui.js";

// ---------------------------------------------------------------- баннеры

function showError(msg) {
  document.getElementById("error-banner-text").textContent = msg;
  document.getElementById("error-banner").classList.remove("hidden");
}

function hideError() {
  document.getElementById("error-banner").classList.add("hidden");
}

function showFormatBanner() {
  // Баннер переиспользуется тулбаром для автопереключения режима —
  // восстанавливаем исходный текст и кнопку сброса закрепления.
  const text = document.getElementById("format-banner-text");
  if (text) text.textContent = "Сервер сменил формат промпта.";
  const reset = document.getElementById("btn-reset-pin");
  if (reset) reset.classList.remove("hidden");
  document.getElementById("format-banner").classList.remove("hidden");
}

function hideFormatBanner() {
  document.getElementById("format-banner").classList.add("hidden");
}

// Постоянное (не таймерное) предупреждение через format-banner.
function showFormatWarn(text) {
  const el = document.getElementById("format-banner-text");
  if (el) el.textContent = text;
  const reset = document.getElementById("btn-reset-pin");
  if (reset) reset.classList.add("hidden");
  document.getElementById("format-banner").classList.remove("hidden");
}

// Есть ли среди выбранных работающих моделей vision (нужны для пресетов с картинками).
function hasVisionSelected() {
  return selectedModelKeys().some(k => state.models.find(m => m.key === k)?.vision);
}

// ---------------------------------------------------------------- пресеты

function applyPreset(p) {
  const presetImages = (Array.isArray(p.images) && p.images.length > 0) ||
    (Array.isArray(p.files) && p.files.some(f => f.image || f.dataUrl));
  if (p.page === "batch") {
    const hasAnything = state.questions.length > 0 || state.batch.files.length > 0;
    if (hasAnything && !confirm(`Применить пресет «${p.name}»? Текущие вопросы и файлы пакета будут заменены.`)) return;
    setQuestions(p.questions || []);
    setDecision(p.decision || null);
    loadPresetFiles(p.files || []);
    clearSingleResults(); // вопросы/решение общие — одиночный прогон тоже обнуляем
    setPageMode("batch");
    hideError();
    if (presetImages && !hasVisionSelected()) {
      showFormatWarn("Для этого пресета нужны vision-модели (Clef)");
    }
    return;
  }
  const hasAnything = hasContent() || state.questions.length > 0;
  if (hasAnything && !confirm(`Применить пресет «${p.name}»? Текущий материал и вопросы будут заменены.`)) return;
  const format = p.input_format || (typeof p.input === "string" ? "text" : "json");
  const text = typeof p.input === "string" ? p.input : JSON.stringify(p.input, null, 2);
  setContent(text, format === "json" ? "json" : "text");
  setImages(p.images || []);
  setQuestions(p.questions || []);
  setDecision(p.decision || null);
  clearSingleResults(); // новые входные данные — прошлый прогон неактуален
  setPageMode("single");
  hideError();
  if (presetImages && !hasVisionSelected()) {
    showFormatWarn("Для этого пресета нужны vision-модели (Clef)");
  }
}

// ---------------------------------------------------------------- «Новый» / импорт

// Меню «Файл» → «Новый»: полная очистка рабочего состояния (материалы,
// изображения, вопросы, правила решения, файлы пакета, результаты прогонов).
async function newSession() {
  const hasAnything = hasContent() || state.questions.length > 0 ||
    state.batch.files.length > 0 || state.results ||
    Object.keys(state.batch.results).length > 0;
  if (hasAnything &&
      !confirm("Создать новый документ? Текущие материалы, вопросы, правила решения, файлы пакета и результаты останутся в прежнем документе.")) return;
  await createNewDocument();
  hideError();
}

// Импортированные batch_files: непустой батч заменяется после подтверждения,
// затем переключаемся на страницу «Батч» (как применение батч-пресета).
function handleImportedBatchFiles(files) {
  if (state.batch.files.length > 0 &&
      !confirm(`Импорт заменит файлы пакета (${state.batch.files.length} → ${files.length}). Продолжить?`)) return;
  loadPresetFiles(files);
  setPageMode("batch");
  showFormatWarn(`Загружено файлов пакета: ${files.length} — страница «Пакет материалов»`);
}

function confirmImportReplace(kind) {
  const what = kind === "questions" ? "текущий набор вопросов"
    : kind === "context" ? "текущий материал"
    : kind === "batch" ? "файлы пакета"
    : kind === "config" ? "текущие вопросы, правила и настройки прогона"
    : "текущий материал и вопросы";
  return confirm(`Импорт заменит ${what}. Продолжить?`);
}

// ---------------------------------------------------------------- страница

function handlePageMode(mode) {
  if (mode === "single" && isBatchEmpty()) resetBatch();
  if (mode === "models") refreshModels();  // свежие статусы сразу при открытии
  renderQuestions();  // оба инстанса редактора (одиночный + батч) на общем state
  renderResults();
  refreshRunButton();
  updateModeChip();
}

// ---------------------------------------------------------------- запуск

function handlePins(results) {
  for (const [key, res] of Object.entries(results || {})) {
    if (res.ok && res.prompt_format_version != null) {
      state.pinnedFormats[key] = res.prompt_format_version;
    } else if (!res.ok && res.error && /prompt_format_version|формат/i.test(res.error)) {
      showFormatBanner();
    }
  }
}

async function run() {
  if (state.running) return;
  const generation = beginRun("single");
  let job = null;
  state.running = true;
  refreshRunButton();
  try {
    hideError();
    let snap;
    try {
      const input = buildInput();
      const images = buildImagesPayload();
      const questions = buildQuestionsPayload();
      if (!state.decision || state.decision.enabled !== false) validateDecision(state.decision, state.questions);
      let models = selectedModelKeys();
      if (!models.length) throw new Error("Выберите хотя бы одну работающую модель.");
      if (images.length) {
        const skipped = models.filter(k => !state.models.find(m => m.key === k)?.vision);
        models = models.filter(k => !skipped.includes(k));
        if (!models.length) throw new Error("Ни одна из выбранных моделей не поддерживает изображения — выберите Clef.");
        if (skipped.length) {
          const names = skipped.map(k => state.models.find(m => m.key === k)?.short_label || k).join(", ");
          showFormatWarn(`Модель ${names} не поддерживает изображения — она пропущена в этом прогоне.`);
        }
      }
      const runMode = state.runMode;
      const temperature = state.temperature;
      const threads = state.threads;
      const fingerprint = singleFingerprint(currentText());
      const questionsWithDirections = withDirections(questions);
      const decision = state.decision && state.decision.outcomes && state.decision.outcomes.length
        ? decisionSnapshotClean(state.decision) : null;
      const clefKeys = new Set(models.filter(k => state.models.find(m => m.key === k)?.api === "systemone"));
      const pack = packFromState();
      const effective = await effectivePack(pack, { models, mode: runMode });
      snap = {
        input, images, models, pack, runMode, temperature, threads, fingerprint, clefKeys,
        configFingerprint: effective.fingerprint,
        questions: questionsWithDirections,
        decision,
      };
    } catch (e) {
      if (runIsCurrent("single", generation)) showError(e.message);
      return;
    }
    if (!runIsCurrent("single", generation)) return;

    const choice = await askAppendOrReplace("single", {
      fingerprint: snap.fingerprint, runMode: snap.runMode, temperature: snap.temperature,
    });
    if (!choice || !runIsCurrent("single", generation)) return;
    if (choice === "replace") resetFilter("single");

    const prevResults = choice === "append" ? state.results : null;
    const prevMeta = choice === "append" ? state.resultsMeta : null;
    const acceptSingleFile = (file, runId, provisional) => {
      if (!runIsCurrent("single", generation)) return;
      const adapted = singleResultsFromFile(file, snap.runMode, snap.clefKeys);
      if (provisional) {
        for (const [model, value] of Object.entries(adapted)) {
          if (snap.runMode === "both") {
            for (const res of Object.values(value)) handlePins({ [model]: res });
          } else handlePins({ [model]: value });
        }
      }
      const links = singleRunLinks(file, runId, snap.runMode, snap.clefKeys);
      state.results = {
        results: { ...(prevResults?.results || {}), ...adapted },
        order: (prevResults?.order || []).concat(snap.models.filter(k => !prevResults?.order?.includes(k))),
        runIds: Object.fromEntries(Object.entries({ ...(prevResults?.runIds || {}), ...links }).map(([key, value]) => [key, { ...value }])),
        runMode: snap.runMode,
        questions: snap.questions,
        decision: snap.decision,
        images: snap.images.length ? snap.images : null,
        marks: prevResults?.marks || [],
      };
      if (provisional) {
        state.resultsMeta = {
          fingerprint: snap.fingerprint, runMode: snap.runMode, temperature: snap.temperature,
          latestRun: prevMeta?.latestRun || null, runs: { ...(prevMeta?.runs || {}) },
        };
        renderResults();
      }
    };
    try {
      job = executeRun({
        pack: snap.pack,
        materials: [{ input: snap.input, images: snap.images }],
        overrides: { models: snap.models, mode: snap.runMode },
        threads: snap.threads,
        onEvent: (event) => {
          if (event.type === "file") acceptSingleFile(event, event.run_id || job.runId, true);
        },
      });
      if (!trackRunJob("single", generation, job)) return;
      const outcome = await job.done;
      if (!runIsCurrent("single", generation)) return;
      const file = outcome.files[0];
      if (file) acceptSingleFile(file, job.runId, false);
      const runId = outcome.metadata.run_id;
      state.resultsMeta = {
        fingerprint: snap.fingerprint, runMode: snap.runMode, temperature: snap.temperature,
        latestRun: runId,
        runs: {
          ...(prevMeta?.runs || {}),
          [runId]: {
            runId, status: outcome.metadata.status,
            configFingerprint: outcome.metadata.config_fingerprint || snap.configFingerprint,
            requestedConfigFingerprint: snap.configFingerprint,
            effectiveConfigFingerprint: outcome.metadata.config_fingerprint,
            materialsFingerprint: outcome.materialsFingerprint,
            materialHashes: outcome.materialHashes,
            runFingerprint: outcome.metadata.run_fingerprint,
            models: [...snap.models], mode: snap.runMode, threads: snap.threads,
          },
        },
      };
      state.resultsStale = singleFingerprint(currentText()) !== snap.fingerprint;
      emit("runFinished");
    } catch (e) {
      if (runIsCurrent("single", generation)) showError(e.message);
    }
  } finally {
    if (finishRun("single", generation, job)) {
      state.running = false;
      refreshRunButton();
      renderResults();
      emit("results");
    }
  }
}

// Глубокая копия правил решения без UI-состояния редактора (collapsed).
function decisionSnapshotClean(decision) {
  const snap = JSON.parse(JSON.stringify(decision));
  for (const o of snap.outcomes || []) delete o.collapsed;
  return snap;
}

function handleRun() {
  if (state.pageMode === "batch") {
    runBatch().catch(e => showError(e.message));
  } else {
    run();
  }
}

// ---------------------------------------------------------------- init

await initAuth();  // owner известен до model polling и восстановления чата

document.getElementById("btn-add-question").onclick = () => addQuestion();
document.getElementById("btn-add-question-batch").onclick = () => addQuestion();

// LLM-генерация вопросов chat-моделью (менеджер вопросов).
function handleGenerateQuestions(withContext) {
  let ctxText = "";
  if (withContext) {
    try { ctxText = buildInput(); } catch { ctxText = ""; }
  }
  openGenerateDialog({
    title: "Сгенерировать вопросы",
    taskPlaceholder: "О чём спрашивать? (например: проверка резюме на цифры и стек)…",
    onGenerate: async (modelKey, task, thinking) => {
      const data = await generateQuestions({
        model_key: modelKey, input: ctxText || undefined, hint: task, thinking,
      });
      for (const q of data.questions || []) {
        // id генерируем заново — q1..qN из ответа LLM могут конфликтовать
        state.questions.push(normalizeQuestion({ ...q, id: undefined }));
      }
      renderQuestions();
    },
  });
}
document.getElementById("btn-gen-questions").onclick = () => handleGenerateQuestions(true);
document.getElementById("btn-gen-questions-batch").onclick = () => handleGenerateQuestions(false);

// LLM-генерация правил решения chat-моделью (редактор «Решение»).
function handleGenerateDecision(withContext) {
  let ctxText = "";
  if (withContext) {
    try { ctxText = buildInput(); } catch { ctxText = ""; }
  }
  openGenerateDialog({
    title: "Сгенерировать правила решения",
    taskPlaceholder: "Какие исходы нужны? (например: опубликовать / забанить / на ручную модерацию)…",
    onGenerate: async (modelKey, task, thinking) => {
      const data = await generateDecision({
        model_key: modelKey, input: ctxText || undefined, hint: task,
        questions: withDirections(buildQuestionsPayload()), thinking,
      });
      setDecision(data.decision || null);
    },
  });
}
document.getElementById("btn-gen-decision").onclick = () => handleGenerateDecision(true);
document.getElementById("btn-gen-decision-batch").onclick = () => handleGenerateDecision(false);
// Редактор вопросов живёт на обеих страницах (общий state.questions).
mountQuestions(); // одиночный: #questions-list
mountQuestions({ listId: "batch-questions-list", emptyId: "batch-questions-empty" });
mountDecision({ enabledId: "decision-enabled" }); // одиночный: #decision-list
mountDecision({ listId: "batch-decision-list", emptyId: "batch-decision-empty", hintsId: "batch-decision-hints", enabledId: "batch-decision-enabled" });
document.getElementById("btn-add-outcome").onclick = () => addOutcome();
document.getElementById("btn-add-outcome-batch").onclick = () => addOutcome();
document.getElementById("error-banner-close").onclick = hideError;
document.getElementById("format-banner-close").onclick = hideFormatBanner;
document.getElementById("btn-reset-pin").onclick = () => {
  state.pinnedFormats = {};
  hideFormatBanner();
};

// Результаты НЕ перерендериваются по событию "models" (поллинг каждые 15 с):
// перерендер уничтожал строки под курсором и оставлял висеть тултип со старыми данными.

// ---------------------------------------------------------------- демо-режим тура
// Онбординг показывает интерфейс на живых примерах: на входе в тур делаем
// снапшот состояния и подгружаем демо-пресет, на шаге «Пакет материалов» —
// демо-пакет, при закрытии тура всё восстанавливается.

let tourSnap = null;
let tourDemoReady = null;
let tourSinglePreset = null;

async function fetchPresetBySlug(slug) {
  try {
    const resp = await apiFetch("/api/presets");
    if (!resp.ok) return null;
    const list = await resp.json();
    return (Array.isArray(list) ? list : []).find(p => p.slug === slug) || null;
  } catch {
    return null;
  }
}

function applySingleDemo(p) {
  const format = p.input_format || (typeof p.input === "string" ? "text" : "json");
  const text = typeof p.input === "string" ? p.input : JSON.stringify(p.input, null, 2);
  setContent(text, format === "json" ? "json" : "text");
  setImages([]);
  setQuestions(p.questions || []);
  setDecision(p.decision || null);
  clearSingleResults();
  setPageMode("single");
}

async function tourDemoEnter() {
  pausePersist(); // демо-данные тура не должны затирать автосейв
  tourSnap = {
    pageMode: state.pageMode,
    context: contextSnapshot(),
    // Сырая строка текста: contextSnapshot в JSON-режиме кладёт распарсенный
    // объект, а при выходе он пересериализуется (форматирование меняется) —
    // fingerprint расходился и результаты помечались неактуальными.
    contextText: currentText(),
    questions: JSON.parse(JSON.stringify(state.questions)),
    decision: state.decision ? JSON.parse(JSON.stringify(state.decision)) : null,
    batchFiles: state.batch.files.length ? batchFilesSnapshot() : null,
    results: state.results ? JSON.parse(JSON.stringify(state.results)) : null,
    resultsMeta: state.resultsMeta ? { ...state.resultsMeta } : null,
    resultsStale: state.resultsStale,
    batchResults: JSON.parse(JSON.stringify(state.batch.results)),
    batchRunIds: JSON.parse(JSON.stringify(state.batch.runIds || {})),
    batchResultsMeta: state.batch.resultsMeta ? { ...state.batch.resultsMeta } : null,
    batchResultsStale: state.batch.resultsStale,
    batchDurations: JSON.parse(JSON.stringify(state.batch.durations)),
    batchDecision: state.batch.decision ? JSON.parse(JSON.stringify(state.batch.decision)) : null,
    // Разметка: одиночная едет внутри deep-copy state.results; пакетная —
    // sibling результатов, поэтому явные поля (иначе потеряются на выходе).
    batchMarks: JSON.parse(JSON.stringify(state.batch.marks || [])),
    batchQuestions: state.batch.questions ? JSON.parse(JSON.stringify(state.batch.questions)) : null,
  };
  const p = await fetchPresetBySlug("content_moderation");
  if (p) { tourSinglePreset = p; applySingleDemo(p); }
}

async function tourDemoEnterAsync() {
  tourDemoReady = tourDemoEnter();
  await tourDemoReady;
}

// Шаг «Запуск»: в фоне — готовый демо-прогон по демо-пресету. Хук может
// сработать раньше, чем tourDemoEnter догрузил пресет (прыжок из оглавления) —
// ждём готовности.
function tourDemoRun() {
  if (!tourSnap) return;
  Promise.resolve(tourDemoReady).then(() => {
    if (!tourSnap) return;
    // Возврат с батч-шага: вопросы/решение могли быть перезаписаны демо-пакетом —
    // восстанавливаем одиночный демо-пресет, чтобы фон соответствовал результатам.
    if (tourSinglePreset) applySingleDemo(tourSinglePreset);
    applyDemoSingleRun();
    renderResults();
  }).catch(() => { /* демо опционально */ });
}

async function tourDemoBatch() {
  const p = await fetchPresetBySlug("batch_resume_screening");
  if (!p) return;
  setQuestions(p.questions || []);
  setDecision(p.decision || null);
  await loadPresetFiles(p.files || []);
  applyDemoBatchResults();
  renderBatchList();
  renderBatchResults();
}

function tourDemoExit() {
  const s = tourSnap;
  tourSnap = null;
  tourSinglePreset = null;
  if (!s) { resumePersist(); return; }
  try {
    setContent(typeof s.contextText === "string" ? s.contextText
      : (typeof s.context.input === "string" ? s.context.input : JSON.stringify(s.context.input, null, 2)),
      s.context.input_format === "json" ? "json" : "text");
    setImages(s.context.images || []);
    setQuestions(s.questions);
    setDecision(s.decision);
    // Файлы: если до тура пакет был пуст — демо-файлы убираем, а не оставляем.
    loadPresetFiles(s.batchFiles || []);
    state.batch.results = s.batchResults || {};
    state.batch.runIds = s.batchRunIds || {};
    state.batch.resultsMeta = s.batchResultsMeta || null;
    state.batch.resultsStale = !!s.batchResultsStale;
    state.batch.durations = s.batchDurations || {};
    state.batch.decision = s.batchDecision || null;
    state.batch.marks = s.batchMarks || [];
    state.batch.questions = s.batchQuestions || null;
    renderBatchList();
    renderBatchResults();
    state.results = s.results || null;
    state.resultsMeta = s.resultsMeta || null;
    state.resultsStale = !!s.resultsStale;
    renderResults();
    setPageMode(s.pageMode);
  } catch { /* восстановление опционально */ }
  resumePersist(); // пересохранить восстановленное состояние
}

addQuestion();
initContext({ showError });
initStaleTracking({ getContextText: currentText });
initToolbar({
  onRun: handleRun,
  onPageMode: handlePageMode,
  applyPreset,
  showError,
  onNew: newSession,
  onSaveAs: () => openSaveAsDialog({ onError: showError }),
  onImportFile: (file) => importJsonFile(file, {
    onError: showError, confirmReplace: confirmImportReplace, onBatchFiles: handleImportedBatchFiles,
    onWarn: showFormatWarn,
    onRunSettings: () => { refreshRunButton(); refreshModels(); },
  }),
  onPresetsManager: () => openPresetsPage(),
  onSavePreset: () => openSaveDialog(),
});
initLayout();
initBlockCollapse();
initBatch({ showError });
initManager({ showError });
initPresets({ applyPreset, showError });
initReview();
initNavigator();
await initDocuments({
  onWarning: showFormatWarn,
  restore: !tourWillAutoStart(),
});
initWorkshop();
initAlreadyRun({
  onRun: () => handleRun(),
  onShow: (scope) => {
    setPageMode(scope);
    document.getElementById(scope === "single" ? "results-card" : "batch-results-card")?.scrollIntoView();
  },
});
initUpdate();
initAssistant();
initHelp({
  onPageMode: (mode) => setPageMode(mode),
  onPageModeQuery: () => state.pageMode,
  onDemoEnter: tourDemoEnterAsync,
  onDemoRun: tourDemoRun,
  onDemoBatch: tourDemoBatch,
  onDemoExit: tourDemoExit,
});
renderResults();
