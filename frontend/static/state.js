// Состояние приложения + простой pub/sub.

export const state = {
  models: [],              // из GET /api/models (поле models)
  device: null,            // {ram_gb, budget_gb} из GET /api/models
  questions: [],           // {id, question, type, ...}
  decision: null,          // {outcomes: [{id, label, color, isDefault?, rules}]} — правила решения
  contextImages: [],       // [{name, dataUrl}] — изображения к одиночному контексту
  selectedModels: new Set(),
  pinnedModels: new Set(),  // чипы в баре (persist в localStorage, ключ "pinnedModels")
  inputMode: "text",       // "text" | "json"
  temperature: 1,
  runMode: "decisions",    // "decisions" | "fast_batch" | "both"
  pageMode: "single",      // "single" | "batch" | "models" | "presets"
  pinnedFormats: {},       // model key -> prompt_format_version
  results: null,           // {results, order, runMode, questions}
  running: false,
  panels: {
    width: 50,             // ширина левой панели, % (35–75, в localStorage)
    focus: null,           // null | "left" | "right" — панель на весь экран
    collapsed: null,       // null | "left" | "right" — свёрнутая панель (restore-вкладка)
  },
  batchPanels: {           // то же для сплита страницы «Батч»
    width: 50,
    focus: null,
    collapsed: null,
  },
  batch: {
    files: [],             // {id, name, size, text, status, error, warn}
    running: false,
    cancelled: false,
    startedAt: null,       // метки времени прогона для прогресса/ETA
    finishedAt: null,
    results: {},           // fileId -> {modelKey -> backend result}
    durations: {},         // fileId -> seconds
    decision: null,        // снапшот правил решения на момент прогона
  },
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(event) {
  for (const fn of listeners) fn(event);
}

// Ключи выбранных работающих моделей (участников прогона).
export function selectedModelKeys() {
  return state.models
    .filter(m => m.status === "running" && state.selectedModels.has(m.key))
    .map(m => m.key);
}

// ---------------------------------------------------------------- пины моделей

const PINNED_KEY = "pinnedModels";

// Однократная инициализация пинов. При первом запуске (ключа нет в localStorage)
// пинятся все enabled-модели — бесшовная миграция со старого поведения
// «в баре все enabled».
export function initPinnedModels(enabledKeys) {
  if (state._pinnedLoaded) return;
  state._pinnedLoaded = true;
  const raw = localStorage.getItem(PINNED_KEY);
  if (raw !== null) {
    try {
      state.pinnedModels = new Set(JSON.parse(raw));
      return;
    } catch { /* битый JSON — миграция ниже */ }
  }
  state.pinnedModels = new Set(enabledKeys);
  savePinnedModels();
}

function savePinnedModels() {
  localStorage.setItem(PINNED_KEY, JSON.stringify([...state.pinnedModels]));
}

export function togglePinnedModel(key) {
  if (state.pinnedModels.has(key)) state.pinnedModels.delete(key);
  else state.pinnedModels.add(key);
  savePinnedModels();
}
