// Per-tab document state and full workspace snapshots. Содержимое документа
// больше не сохраняется автоматически: запись выполняется только через Файл.

import { state, subscribe } from "./state.js";
import { currentText, setContent, setImages } from "./context.js";
import { setQuestions } from "./questions.js";
import { setDecision } from "./decision.js";
import { loadPresetFiles, batchFilesSnapshot, resetBatch } from "./batch.js";
import { clearSingleResults, restoreSingleResults, restoreBatchResults } from "./stale.js";
import { invalidateRun } from "./run_lifecycle.js";

const TRACKED_EVENTS = new Set(["context", "questions", "decision", "images", "batch", "pagemode", "results", "review"]);
const LEGACY_UNMAPPED_KEY = "dq-workspace-legacy-unmapped";

let paused = false;
let subscribed = false;
let activeDocument = null;
let stateVersion = 0;
let documentGeneration = 0;
let callbacks = { onChange: () => {} };

export function setPersistCallbacks(handlers = {}) {
  callbacks = { ...callbacks, ...handlers };
}

function changed() {
  if (activeDocument) callbacks.onChange(currentDocument());
}

function freshDocumentId() {
  return `doc_${globalThis.crypto?.randomUUID?.().replaceAll("-", "") || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}`;
}

export function activateDocument({ id = null, name = "Без названия", fileHandle = null, dirty = false, status = "new" } = {}) {
  activeDocument = {
    id: id || freshDocumentId(), name, fileHandle, dirty, status,
    generation: ++documentGeneration,
  };
  changed();
  return activeDocument;
}

export function currentDocument() {
  return activeDocument ? { ...activeDocument } : null;
}

export function documentStateVersion() {
  return stateVersion;
}

export function setDocumentName(name) {
  if (!activeDocument) return;
  activeDocument.name = name;
  changed();
}

export function markDocumentSaved({ name, fileHandle = null, status = "saved" }) {
  if (!activeDocument) return;
  activeDocument.name = name;
  activeDocument.fileHandle = fileHandle;
  activeDocument.dirty = false;
  activeDocument.status = status;
  changed();
}

export function markDocumentDirty() {
  if (paused) return;
  stateVersion += 1;
  if (activeDocument) {
    activeDocument.dirty = true;
    activeDocument.status = "dirty";
    changed();
  }
}

export function workspaceSnapshot(withImages = true) {
  let batchFiles = batchFilesSnapshot();
  if (!withImages) {
    batchFiles = batchFiles
      .filter(f => !f.image)
      .map(f => { const { images, ...rest } = f; return rest; });
  }
  const snap = {
    input_format: state.inputMode,
    input: currentText(),
    questions: JSON.parse(JSON.stringify(state.questions)),
    decision: state.decision ? JSON.parse(JSON.stringify(state.decision)) : null,
    pageMode: state.pageMode,
    selectedModels: [...state.selectedModels],
    runMode: state.runMode,
    temperature: state.temperature,
    threads: state.threads,
    pinnedFormats: JSON.parse(JSON.stringify(state.pinnedFormats || {})),
    panels: JSON.parse(JSON.stringify(state.panels)),
    batchPanels: JSON.parse(JSON.stringify(state.batchPanels)),
    batchFiles,
    results: state.results ? JSON.parse(JSON.stringify(state.results)) : null,
    resultsMeta: state.resultsMeta ? { ...state.resultsMeta } : null,
    batchResults: {
      files: state.batch.files.map(f => f.id),
      results: state.batch.results,
      runIds: state.batch.runIds,
      durations: state.batch.durations,
      decision: state.batch.decision,
      questions: state.batch.questions,
      marks: state.batch.marks,
      resultsMeta: state.batch.resultsMeta,
    },
  };
  if (withImages && state.contextImages.length) snap.images = state.contextImages.map(img => img.dataUrl);
  if (!withImages) snap.imagesOmitted = true;
  return snap;
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function prepareBatchRestore(data) {
  const br = data.batchResults;
  if (br == null) return null;
  if (!isRecord(br)) return { unmappable: true };
  const results = br.results ?? {};
  const durations = br.durations ?? {};
  const marks = Array.isArray(br.marks) ? br.marks : [];
  if (!isRecord(results) || !isRecord(durations)) return { unmappable: true };
  const resultIds = Object.keys(results);
  if (!resultIds.length) {
    return Object.keys(durations).length || marks.length ? { unmappable: true } : null;
  }
  const batchFiles = Array.isArray(data.batchFiles) ? data.batchFiles : [];
  let files;
  if (Array.isArray(br.files)) {
    files = br.files;
    const valid = files.length === batchFiles.length &&
      files.every(id => typeof id === "string" && id.length > 0) &&
      new Set(files).size === files.length;
    if (!valid) return { unmappable: true };
  } else {
    if (batchFiles.length !== 1 || resultIds.length !== 1) return { unmappable: true };
    files = [resultIds[0]];
  }
  const known = new Set(files);
  if (resultIds.some(id => !known.has(id) || !isRecord(results[id])) ||
      Object.keys(durations).some(id => !known.has(id))) return { unmappable: true };
  return {
    br: {
      ...br, files, results, durations,
      results_meta: br.resultsMeta || br.results_meta || null,
    },
  };
}

function unmappedWarning(raw) {
  const prefix = "Пакетные результаты не восстановлены: файлы автосохранения нельзя однозначно сопоставить. ";
  let backupKey = LEGACY_UNMAPPED_KEY;
  try {
    if (localStorage.getItem(backupKey) !== null) {
      let suffix = 2;
      do {
        backupKey = `${LEGACY_UNMAPPED_KEY}-${suffix}`;
        suffix += 1;
      } while (localStorage.getItem(backupKey) !== null);
    }
    localStorage.setItem(backupKey, raw);
  } catch {
    return prefix + "Не удалось сохранить резервную копию: localStorage недоступен или переполнен.";
  }
  return prefix + `Исходный JSON сохранён в ${backupKey}; прежние резервные копии не перезаписаны.`;
}

export function resetDocumentState() {
  invalidateRun("single");
  invalidateRun("batch");
  setContent("", "text");
  setImages([]);
  setQuestions([]);
  setDecision(null);
  resetBatch();
  clearSingleResults();
  state.selectedModels = new Set(state.models.filter(model => model.status === "running").map(model => model.key));
  state.runMode = "decisions";
  state.temperature = 1;
  state.threads = null;
  state.pinnedFormats = {};
  state.panels = { width: 50, focus: null, collapsed: null };
  state.batchPanels = { width: 50, focus: null, collapsed: null };
}

function applyRunSettings(data) {
  if (Array.isArray(data.selectedModels)) state.selectedModels = new Set(data.selectedModels);
  if (["decisions", "fast_batch", "both"].includes(data.runMode)) state.runMode = data.runMode;
  if (typeof data.temperature === "number" && Number.isFinite(data.temperature)) state.temperature = data.temperature;
  if (data.threads === null || Number.isInteger(data.threads) && data.threads >= 1) state.threads = data.threads;
  if (isRecord(data.pinnedFormats)) state.pinnedFormats = { ...data.pinnedFormats };
  if (isRecord(data.panels)) state.panels = JSON.parse(JSON.stringify(data.panels));
  if (isRecord(data.batchPanels)) state.batchPanels = JSON.parse(JSON.stringify(data.batchPanels));
}

export function restoreDocumentData(data, { onWarning, raw = null } = {}) {
  if (!isRecord(data) || (data.results != null && !isRecord(data.results))) return null;
  const batchPlan = prepareBatchRestore(data);
  let warning = null;
  try {
    const input = data.input;
    setContent(typeof input === "string" ? input : JSON.stringify(input ?? "", null, 2),
      data.input_format === "json" ? "json" : "text");
    setImages(Array.isArray(data.images) ? data.images : []);
    setQuestions(Array.isArray(data.questions) ? data.questions : []);
    setDecision(data.decision ?? null);
    loadPresetFiles(Array.isArray(data.batchFiles) ? data.batchFiles : []);
    if (data.results) restoreSingleResults(data.results, data.resultsMeta || data.results_meta || null, currentText);
    if (batchPlan && batchPlan.br) restoreBatchResults(batchPlan.br);
    if (batchPlan && batchPlan.unmappable) warning = unmappedWarning(raw ?? JSON.stringify(data));
    applyRunSettings(data);
  } catch { return null; }
  if (warning && onWarning) onWarning(warning);
  return typeof data.pageMode === "string" ? data.pageMode : null;
}

export function pausePersist() {
  paused = true;
}

export function resumePersist() {
  paused = false;
}

export function initPersist() {
  if (subscribed) return;
  subscribed = true;
  subscribe(event => {
    if (TRACKED_EVENTS.has(event)) markDocumentDirty();
  });
}
