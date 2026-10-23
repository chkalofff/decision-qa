// Автосохранение рабочего состояния в localStorage (ключ dq-workspace):
// дебаунс-снапшот (~800 мс) по событиям state (context/questions/decision/
// images/batch/pagemode/results/review). Сохраняются материалы, вопросы,
// правила решения, страница, файлы пакета и результаты прогонов вместе с
// разметкой (marks едут внутри results и batchResults; разметка эмитит
// «review»). Если сериализация больше ~4 МБ — вариант без изображений,
// затем без результатов (fallback: только входные данные).
// При старте app.js восстанавливает снапshot через restoreWorkspace()
// (если не запускается демо-тур): документ сначала полностью очищается, а
// результаты проходят через stale.js. Пакетные id и target.file пометок
// перекодируются по batchResults.files; неоднозначный legacy не прикрепляется,
// его сырой JSON сохраняется отдельной резервной копией без перезаписи.
// Включение/выключение — чекбокс в меню «Файл» (localStorage
// dq-workspace-enabled, дефолт вкл; выключение удаляет снапшот). На время
// демо-тура подписка приостанавливается (pausePersist), после выхода —
// пересохранение (resumePersist), чтобы демо-данные не затирали автосейв.

import { state, subscribe } from "./state.js";
import { currentText, setContent, setImages } from "./context.js";
import { setQuestions } from "./questions.js";
import { setDecision } from "./decision.js";
import { loadPresetFiles, batchFilesSnapshot, resetBatch } from "./batch.js";
import { clearSingleResults, restoreSingleResults, restoreBatchResults } from "./stale.js";

const WORKSPACE_KEY = "dq-workspace";
const LEGACY_UNMAPPED_KEY = "dq-workspace-legacy-unmapped";
const ENABLED_KEY = "dq-workspace-enabled";
const DEBOUNCE_MS = 800;
// Сериализация больше ~4 МБ не влезет в квоту localStorage — сохраняем
// вариант без изображений (imagesOmitted: true).
const MAX_SNAPSHOT_CHARS = 4 * 1024 * 1024;

let paused = false;
let timer = null;

const TRACKED_EVENTS = new Set(["context", "questions", "decision", "images", "batch", "pagemode", "results", "review"]);

export function isPersistEnabled() {
  return localStorage.getItem(ENABLED_KEY) !== "0";
}

export function setPersistEnabled(on) {
  localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  if (on) saveNow();
  else localStorage.removeItem(WORKSPACE_KEY);
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
    batchFiles,
    // Результаты прогонов с разметкой (marks внутри results) — для
    // восстановления сессии при повторном открытии.
    results: state.results ? JSON.parse(JSON.stringify(state.results)) : null,
    resultsMeta: state.resultsMeta ? { ...state.resultsMeta } : null,
    batchResults: {
      // id в порядке batchFiles: при восстановлении loadPresetFiles создаёт новые id.
      files: state.batch.files.map(f => f.id),
      results: state.batch.results,
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

export function saveNow() {
  if (paused || !isPersistEnabled()) return;
  try {
    let json = JSON.stringify(workspaceSnapshot(true));
    if (json.length > MAX_SNAPSHOT_CHARS) {
      json = JSON.stringify(workspaceSnapshot(false));
    }
    if (json.length > MAX_SNAPSHOT_CHARS) {
      // Фолбэк — старое поведение: только входные данные, без результатов.
      console.warn("persist: снапшот больше лимита даже без изображений — результаты прогонов не сохранены");
      const snap = workspaceSnapshot(false);
      delete snap.results;
      delete snap.resultsMeta;
      delete snap.batchResults;
      json = JSON.stringify(snap);
    }
    localStorage.setItem(WORKSPACE_KEY, json);
  } catch { /* QuotaExceededError и пр. — молча пропускаем */ }
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
  setContent("", "text");
  setImages([]);
  setQuestions([]);
  setDecision(null);
  resetBatch();
  clearSingleResults();
}

// Восстановление снапшота при старте. Сначала очищаем прежний документ, затем
// применяем входы и восстанавливаем результаты через stale.js: одиночные с
// sanitize/fingerprint, пакетные с remap fileId и target.file пометок.
// → сохранённый pageMode (или null, если снапшота нет / он битый).
export function restoreWorkspace({ onWarning } = {}) {
  if (!isPersistEnabled()) return null;
  const raw = localStorage.getItem(WORKSPACE_KEY);
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!isRecord(data) || (data.results != null && !isRecord(data.results))) return null;
  const batchPlan = prepareBatchRestore(data);
  let warning = null;
  try {
    resetDocumentState();
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
    if (batchPlan && batchPlan.unmappable) warning = unmappedWarning(raw);
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

export function initPersist() {
  subscribe((event) => {
    if (TRACKED_EVENTS.has(event)) scheduleSave();
  });
  const cb = document.getElementById("tb-menu-persist");
  if (cb) {
    cb.checked = isPersistEnabled();
    cb.addEventListener("change", () => setPersistEnabled(cb.checked));
  }
}
