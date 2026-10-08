// Точка входа: пресеты, запуск прогонов, связывание модулей.

import { state, selectedModelKeys } from "./state.js";
import { decide } from "./api.js";
import {
  addQuestion, buildQuestionsPayload, setQuestions, exportQuestions,
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
import { openGenerateDialog } from "./generate.js";
import { generateQuestions, generateDecision } from "./api.js";
import { initBatch, isBatchEmpty, resetBatch, runBatch, loadPresetFiles, batchFilesSnapshot } from "./batch.js";
import {
  initContext, buildInput, buildImagesPayload, setContent, setImages, hasContent,
  exportContext, contextSnapshot, downloadJson, importJsonFile,
} from "./context.js";

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
    if (hasAnything && !confirm(`Применить пресет «${p.name}»? Текущие вопросы и файлы батча будут заменены.`)) return;
    setQuestions(p.questions || []);
    setDecision(p.decision || null);
    loadPresetFiles(p.files || []);
    setPageMode("batch");
    hideError();
    if (presetImages && !hasVisionSelected()) {
      showFormatWarn("Для этого пресета нужны vision-модели (Clef)");
    }
    return;
  }
  const hasAnything = hasContent() || state.questions.length > 0;
  if (hasAnything && !confirm(`Применить пресет «${p.name}»? Текущий контекст и вопросы будут заменены.`)) return;
  const format = p.input_format || (typeof p.input === "string" ? "text" : "json");
  const text = typeof p.input === "string" ? p.input : JSON.stringify(p.input, null, 2);
  setContent(text, format === "json" ? "json" : "text");
  setImages(p.images || []);
  setQuestions(p.questions || []);
  setDecision(p.decision || null);
  setPageMode("single");
  hideError();
  if (presetImages && !hasVisionSelected()) {
    showFormatWarn("Для этого пресета нужны vision-модели (Clef)");
  }
}

// ---------------------------------------------------------------- экспорт

function exportAll() {
  try {
    const snap = contextSnapshot();
    const data = { ...snap, questions: withDirections(buildQuestionsPayload()) };
    if (state.decision && state.decision.outcomes && state.decision.outcomes.length) {
      data.decision = decisionSnapshotClean();
    }
    // Файлы батча входят в экспорт «Всё» независимо от текущей страницы.
    if (state.batch.files.length) data.batch_files = batchFilesSnapshot();
    downloadJson("session.json", data);
  } catch (e) {
    showError("Экспорт невозможен: " + e.message);
  }
}

// Импортированные batch_files: непустой батч заменяется после подтверждения,
// затем переключаемся на страницу «Батч» (как применение батч-пресета).
function handleImportedBatchFiles(files) {
  if (state.batch.files.length > 0 &&
      !confirm(`Импорт заменит файлы батча (${state.batch.files.length} → ${files.length}). Продолжить?`)) return;
  loadPresetFiles(files);
  setPageMode("batch");
  showFormatWarn(`Загружено файлов батча: ${files.length} — страница «Батч»`);
}

function confirmImportReplace(kind) {
  const what = kind === "questions" ? "текущий набор вопросов"
    : kind === "context" ? "текущий контекст"
    : kind === "batch" ? "файлы батча"
    : "текущий контекст и вопросы";
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
  hideError();
  let base, images;
  try {
    const input = buildInput();
    images = buildImagesPayload();
    const questions = buildQuestionsPayload();
    // Выключенное решение (enabled:false) не валидируем и не применяем.
    if (!state.decision || state.decision.enabled !== false) {
      validateDecision(state.decision, state.questions);
    }
    let models = selectedModelKeys();
    if (models.length === 0) throw new Error("Выберите хотя бы одну работающую модель.");
    if (images.length) {
      // Non-vision модели с картинками бессмысленны — пропускаем их (бэк ответил бы 422).
      const skipped = models.filter(k => !state.models.find(m => m.key === k)?.vision);
      models = models.filter(k => !skipped.includes(k));
      if (models.length === 0) {
        throw new Error("Ни одна из выбранных моделей не поддерживает изображения — выберите Clef.");
      }
      if (skipped.length) {
        const names = skipped.map(k => state.models.find(m => m.key === k)?.short_label || k).join(", ");
        showFormatWarn(`Модель ${names} не поддерживает изображения — она пропущена в этом прогоне.`);
      }
    }
    base = { input, questions, models };
    if (images.length) base.images = images;
    const pinned = new Set(models.map(k => state.pinnedFormats[k]).filter(v => v != null));
    if (pinned.size === 1) base.prompt_format_version = [...pinned][0];
  } catch (e) {
    showError(e.message);
    return;
  }

  state.running = true;
  refreshRunButton();
  try {
    let resultsData;
    if (state.runMode === "both") {
      // Последовательно, не Promise.all: SGLang обрабатывает запросы по одному,
      // иначе fast_batch ждёт в очереди и его метрики включают чужое время.
      // SystemOne-модели (clef/laya/облачные) детерминированы и режимов не имеют —
      // прогоняем один раз.
      const clefKeys = new Set(
        base.models.filter(k => state.models.find(m => m.key === k)?.api === "systemone")
      );
      const sglangModels = base.models.filter(k => !clefKeys.has(k));
      const d = await decide({ ...base, mode: "decisions", temperature: state.temperature });
      const f = sglangModels.length
        ? await decide({ ...base, models: sglangModels, mode: "fast_batch" })
        : { results: {} };
      resultsData = {};
      for (const key of base.models) {
        resultsData[key] = clefKeys.has(key)
          ? { clef: (d.results || {})[key] }
          : {
              decisions: (d.results || {})[key],
              fast_batch: (f.results || {})[key],
            };
      }
      handlePins(d.results);
      handlePins(f.results);
    } else {
      const body = { ...base, mode: state.runMode };
      if (state.runMode === "decisions") body.temperature = state.temperature;
      const data = await decide(body);
      resultsData = data.results || {};
      handlePins(data.results);
    }
    state.results = {
      results: resultsData,
      order: base.models,
      runMode: state.runMode,
      // Снапшот вопросов — с direction (display-only), для маркировки score.
      questions: withDirections(base.questions),
      // Снапшот правил решения на момент прогона (null — не заданы;
      // enabled:false внутри снапшота — чипы решений не показываются).
      decision: state.decision && state.decision.outcomes && state.decision.outcomes.length
        ? decisionSnapshotClean() : null,
      images: images && images.length ? images : null,
    };
    renderResults();
  } catch (e) {
    showError(e.message);
  } finally {
    state.running = false;
    refreshRunButton();
  }
}

// Глубокая копия правил решения без UI-состояния редактора (collapsed).
function decisionSnapshotClean() {
  const snap = JSON.parse(JSON.stringify(state.decision));
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

addQuestion();
initContext({ showError });
initToolbar({
  onRun: handleRun,
  onPageMode: handlePageMode,
  applyPreset,
  showError,
  onExportQuestions: () => { try { exportQuestions(); } catch (e) { showError(e.message); } },
  onExportContext: () => { try { exportContext(); } catch (e) { showError(e.message); } },
  onExportAll: exportAll,
  onImportFile: (file) => importJsonFile(file, {
    onError: showError, confirmReplace: confirmImportReplace, onBatchFiles: handleImportedBatchFiles,
  }),
  onPresetsManager: () => openPresetsPage(),
  onSavePreset: () => openSaveDialog(),
});
initLayout();
initBlockCollapse();
initBatch({ showError, onBack: () => setPageMode("single") });
initManager({ showError });
initPresets({ applyPreset, showError });
initUpdate();
initAssistant();
renderResults();
