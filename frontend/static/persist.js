// Автосохранение активного документа. documents.js задаёт owner/id,
// revision/contentHash/writerId и ключи dq-workspace:<owner>:<doc>; без активного
// документа сохраняется legacy dq-workspace для обратной совместимости.
// Дебаунс ~800 мс по событиям state. Полный snapshot включает материалы,
// вопросы/decision, files/images, results/marks/provenance и run settings.
// Открытие проходит через documents_ui: destructive reset + invalidation,
// затем restoreDocumentData с remap batch ids. Ошибки записи, конфликты и
// fallback >4 МБ видны через callbacks. persist-off удаляет snapshots только
// текущего owner; legacy local:default дополнительно имеет compatibility mirror.

import { state, subscribe } from "./state.js";
import { currentText, setContent, setImages } from "./context.js";
import { setQuestions } from "./questions.js";
import { setDecision } from "./decision.js";
import { loadPresetFiles, batchFilesSnapshot, resetBatch } from "./batch.js";
import { clearSingleResults, restoreSingleResults, restoreBatchResults } from "./stale.js";
import { invalidateRun } from "./run_lifecycle.js";
import {
  LEGACY_WORKSPACE_KEY, LEGACY_ENABLED_KEY, documentsEnabledKey, documentSnapshotKey,
  saveDocumentSnapshot, readDocumentSnapshot, deleteOwnerSnapshots,
  DocumentConflictError, DocumentStorageError, writerId as documentWriterId,
} from "./documents.js";

const WORKSPACE_KEY = LEGACY_WORKSPACE_KEY;
const LEGACY_UNMAPPED_KEY = "dq-workspace-legacy-unmapped";
const ENABLED_KEY = LEGACY_ENABLED_KEY;
const DEBOUNCE_MS = 800;
// Сериализация больше ~4 МБ не влезет в квоту localStorage — сохраняем
// вариант без изображений (imagesOmitted: true).
const MAX_SNAPSHOT_CHARS = 4 * 1024 * 1024;

let paused = false;
let timer = null;
let activeDocument = null;
let stateVersion = 0;
let documentGeneration = 0;
let callbacks = { onConflict: () => {}, onError: () => {}, onNotice: () => {} };

const TRACKED_EVENTS = new Set(["context", "questions", "decision", "images", "batch", "pagemode", "results", "review"]);

export function setPersistCallbacks(handlers = {}) {
  callbacks = { ...callbacks, ...handlers };
}

export function documentStateVersion() {
  return stateVersion;
}

export function activateDocument(owner, metadata, snapshot = null) {
  activeDocument = {
    owner,
    id: metadata.id,
    name: metadata.name,
    createdAt: metadata.createdAt || snapshot?.createdAt || new Date().toISOString(),
    revision: snapshot?.revision || 0,
    contentHash: snapshot?.contentHash || null,
    backupKey: snapshot?.backupKey || null,
    writerId: activeDocument?.writerId || documentWriterId(),
    conflicted: false,
    generation: ++documentGeneration,
  };
  return activeDocument;
}

export function currentDocument() {
  return activeDocument ? { ...activeDocument } : null;
}

export function setDocumentConflicted(value) {
  if (activeDocument) activeDocument.conflicted = !!value;
}

export function setDocumentRevision(revision, contentHash = undefined) {
  if (!activeDocument) return;
  activeDocument.revision = revision;
  if (contentHash !== undefined) activeDocument.contentHash = contentHash;
}

export function isPersistEnabled(owner = activeDocument?.owner) {
  const key = owner ? documentsEnabledKey(owner) : ENABLED_KEY;
  return localStorage.getItem(key) !== "0";
}

export function setPersistEnabled(on) {
  if (!activeDocument) {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
    if (on) saveNow();
    else localStorage.removeItem(WORKSPACE_KEY);
    return;
  }
  const doc = activeDocument;
  const wasEnabled = isPersistEnabled(doc.owner);
  localStorage.setItem(documentsEnabledKey(doc.owner), on ? "1" : "0");
  if (on) {
    if (!wasEnabled) doc.generation = ++documentGeneration;
    saveNow();
  } else {
    doc.generation = ++documentGeneration;
    clearTimeout(timer);
    timer = null;
    deleteOwnerSnapshots(doc.owner);
    doc.revision = 0;
    doc.contentHash = null;
    doc.backupKey = null;
    doc.conflicted = false;
  }
}

// Снапшот рабочего состояния. withImages=false — вариант без изображений
// (image-файлы пакета пропускаются, у текстовых файлов картинки срезаются).
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
    // Результаты прогонов с разметкой (marks внутри results) — для
    // восстановления сессии при повторном открытии.
    results: state.results ? JSON.parse(JSON.stringify(state.results)) : null,
    resultsMeta: state.resultsMeta ? { ...state.resultsMeta } : null,
    batchResults: {
      // id в порядке batchFiles: при восстановлении loadPresetFiles создаёт новые id.
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
  if (withImages && state.contextImages.length) {
    snap.images = state.contextImages.map(img => img.dataUrl);
  }
  if (!withImages) snap.imagesOmitted = true;
  return snap;
}

function snapshotPayload() {
  let data = workspaceSnapshot(true);
  let json = JSON.stringify(data);
  let notice = null;
  if (json.length > MAX_SNAPSHOT_CHARS) {
    data = workspaceSnapshot(false);
    json = JSON.stringify(data);
    notice = "Снапшот больше 4 МБ: изображения не сохранены. Остальное сохранено.";
  }
  if (json.length > MAX_SNAPSHOT_CHARS) {
    const fallback = workspaceSnapshot(false);
    delete fallback.results;
    delete fallback.resultsMeta;
    delete fallback.batchResults;
    console.warn("persist: снапшот больше лимита даже без изображений — результаты прогонов не сохранены");
    notice = "Результаты прогонов НЕ сохранены из-за размера. Экспортируйте JSON или уменьшите документ.";
    return { data: fallback, notice };
  }
  return { data, notice };
}

function sameOwnSnapshot(left, right) {
  return !!left && !!right && left.revision === right.revision &&
    left.contentHash === right.contentHash && left.writerId === right.writerId &&
    (left.backupId || null) === (right.backupId || null);
}

function cleanupLateSnapshot(doc, snapshot, data, backupKey = null) {
  const recoveryKey = snapshot?.backupKey || backupKey;
  if (recoveryKey) localStorage.removeItem(recoveryKey);
  if (!snapshot) return;
  const current = readDocumentSnapshot(doc.owner, doc.id);
  if (sameOwnSnapshot(current, snapshot)) localStorage.removeItem(documentSnapshotKey(doc.owner, doc.id));
  if (doc.owner === "local" && doc.id === "default" &&
      localStorage.getItem(WORKSPACE_KEY) === JSON.stringify(data)) {
    localStorage.removeItem(WORKSPACE_KEY);
  }
}

function saveError(error, doc = null, generation = null, data = null) {
  if (error.code === "disabled") return;
  if (doc && (doc.generation !== generation || !isPersistEnabled(doc.owner))) {
    try { cleanupLateSnapshot(doc, error.snapshot, data, error.backupKey); } catch (cleanupError) { callbacks.onError(cleanupError); }
    return;
  }
  if (doc && activeDocument !== doc) return;
  if (error instanceof DocumentConflictError) {
    if (doc) doc.conflicted = true;
    callbacks.onConflict(error.snapshot, error);
  } else {
    if (doc && error.snapshot && (error.code === "registry" || error.code === "mirror")) {
      doc.revision = error.snapshot.revision;
      doc.contentHash = error.snapshot.contentHash;
      doc.backupKey = error.snapshot.backupKey || null;
    }
    callbacks.onError(error);
  }
}

export function saveNow({ force = false } = {}) {
  if (paused || !isPersistEnabled() || (activeDocument?.conflicted && !force)) return null;
  const doc = activeDocument;
  if (doc?.savePromise) {
    return doc.savePromise.then(() => activeDocument === doc ? saveNow({ force }) : null);
  }
  const generation = doc?.generation;
  let data = null;
  try {
    const payload = snapshotPayload();
    data = payload.data;
    if (payload.notice) callbacks.onNotice(payload.notice);
    if (!doc) {
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(data));
      return data;
    }
    const result = saveDocumentSnapshot(doc.owner, doc, data, {
      expectedRevision: doc.revision,
      expectedContentHash: force ? null : doc.contentHash,
      writerId: doc.writerId,
      canCommit: () => doc.generation === generation && isPersistEnabled(doc.owner),
    });
    const complete = snapshot => {
      if (doc.generation !== generation || !isPersistEnabled(doc.owner)) {
        cleanupLateSnapshot(doc, snapshot, data);
        return null;
      }
      if (doc.owner === "local" && doc.id === "default") {
        try {
          localStorage.setItem(WORKSPACE_KEY, JSON.stringify(data));
        } catch (error) {
          throw new DocumentStorageError("Снапшот сохранён, но legacy mirror не записан", {
            code: "mirror", cause: error, snapshot, backupKey: snapshot.backupKey,
          });
        }
      }
      if (activeDocument === doc) {
        doc.revision = snapshot.revision;
        doc.contentHash = snapshot.contentHash;
        doc.backupKey = snapshot.backupKey || null;
        doc.name = snapshot.name;
        doc.conflicted = false;
      }
      return snapshot;
    };
    if (result && typeof result.then === "function") {
      const tracked = result.then(complete).catch(error => {
        saveError(error, doc, generation, data);
        return null;
      });
      doc.savePromise = tracked;
      const clear = () => {
        if (doc.savePromise === tracked) doc.savePromise = null;
      };
      tracked.then(clear, clear);
      return tracked;
    }
    return complete(result);
  } catch (error) {
    saveError(error, doc, generation, data);
    return null;
  }
}

function scheduleSave() {
  if (paused) return;
  clearTimeout(timer);
  timer = setTimeout(saveNow, DEBOUNCE_MS);
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Проверяем связь id результатов с файлами до очистки текущего состояния.
// Позиционный remap разрешён только по явному br.files, а не по порядку ключей
// results. В legacy без files однозначен лишь случай «один файл, один результат».
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
      Object.keys(durations).some(id => !known.has(id))) {
    return { unmappable: true };
  }
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

// Полная очистка документа через штатные сеттеры и рендереры. Используется
// пунктом «Новый» и перед применением уже распарсенного автосохранения.
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
    if (data.results) {
      restoreSingleResults(data.results, data.resultsMeta || data.results_meta || null, currentText);
    }
    if (batchPlan && batchPlan.br) restoreBatchResults(batchPlan.br);
    if (batchPlan && batchPlan.unmappable) warning = unmappedWarning(raw ?? JSON.stringify(data));
    applyRunSettings(data);
  } catch { return null; }
  if (warning && onWarning) onWarning(warning);
  return typeof data.pageMode === "string" ? data.pageMode : null;
}

// Пауза на время демо-тура: демо-данные не должны затирать автосейв.
export function pausePersist() {
  paused = true;
  clearTimeout(timer);
  timer = null;
}

// После тура — пересохранить восстановленное состояние.
export function resumePersist() {
  paused = false;
  saveNow();
}

export function initPersist({ documentMode = false } = {}) {
  if (!documentMode) activeDocument = null;
  subscribe((event) => {
    if (!TRACKED_EVENTS.has(event)) return;
    stateVersion += 1;
    scheduleSave();
  });
  const cb = document.getElementById("tb-menu-persist");
  if (cb) {
    cb.checked = isPersistEnabled();
    cb.addEventListener("change", () => setPersistEnabled(cb.checked));
  }
}
