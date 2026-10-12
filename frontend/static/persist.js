// Автосохранение рабочего состояния в localStorage (ключ dq-workspace):
// дебаунс-снапшот (~800 мс) по событиям state (context/questions/decision/
// images/batch/pagemode). Сохраняются материалы, вопросы, правила решения,
// страница и файлы пакета — результаты прогонов НЕ сохраняются.
// При старте app.js восстанавливает снапshot через restoreWorkspace()
// (если не запускается демо-тур). Включение/выключение — чекбокс в меню
// «Файл» (localStorage dq-workspace-enabled, дефолт вкл; выключение удаляет
// снапшот). На время демо-тура подписка приостанавливается (pausePersist),
// после выхода — пересохранение (resumePersist), чтобы демо-данные не
// затирали автосейв.

import { state, subscribe } from "./state.js";
import { currentText, setContent, setImages } from "./context.js";
import { setQuestions } from "./questions.js";
import { setDecision } from "./decision.js";
import { loadPresetFiles, batchFilesSnapshot } from "./batch.js";

const WORKSPACE_KEY = "dq-workspace";
const ENABLED_KEY = "dq-workspace-enabled";
const DEBOUNCE_MS = 800;
// Сериализация больше ~4 МБ не влезет в квоту localStorage — сохраняем
// вариант без изображений (imagesOmitted: true).
const MAX_SNAPSHOT_CHARS = 4 * 1024 * 1024;

let paused = false;
let timer = null;

const TRACKED_EVENTS = new Set(["context", "questions", "decision", "images", "batch", "pagemode"]);

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
    localStorage.setItem(WORKSPACE_KEY, json);
  } catch { /* QuotaExceededError и пр. — молча пропускаем */ }
}

function scheduleSave() {
  if (paused) return;
  clearTimeout(timer);
  timer = setTimeout(saveNow, DEBOUNCE_MS);
}

// Восстановление снапшота при старте. Идёт через обычные сеттеры —
// результатов прогонов в снапшоте нет, поэтому stale-плашка не возникает.
// → сохранённый pageMode (или null, если снапшота нет / он битый).
export function restoreWorkspace() {
  if (!isPersistEnabled()) return null;
  const raw = localStorage.getItem(WORKSPACE_KEY);
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== "object") return null;
  try {
    const input = data.input;
    setContent(typeof input === "string" ? input : JSON.stringify(input ?? "", null, 2),
      data.input_format === "json" ? "json" : "text");
    setImages(Array.isArray(data.images) ? data.images : []);
    setQuestions(Array.isArray(data.questions) ? data.questions : []);
    setDecision(data.decision ?? null);
    loadPresetFiles(Array.isArray(data.batchFiles) ? data.batchFiles : []);
  } catch { return null; }
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
