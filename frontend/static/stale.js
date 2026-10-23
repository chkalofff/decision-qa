// Актуальность результатов прогонов: отслеживание правок входных данных
// (события pub/sub state.js), выставление stale-флагов и очистка результатов
// при загрузке пресетов/импорте. Fingerprint'ы — в fingerprint.js.

import { state, subscribe } from "./state.js";
import { singleFingerprint, batchFingerprint } from "./fingerprint.js";
import { renderResults } from "./results.js";
import { renderBatchList, renderBatchResults } from "./batch.js";
import { sanitizeMarks, MARKS_VERSION } from "./review.js";
import { normalizeQuestion } from "./questions.js";

// Полная очистка результатов одиночного режима (пресет, импорт).
export function clearSingleResults() {
  state.results = null;
  state.resultsMeta = null;
  state.resultsStale = false;
  renderResults();
}

// Восстановление результатов из импортированного снапшота сессии («Открыть…»):
// результаты считаются актуальными — stale не помечается. Fingerprint берём из
// файла (resultsMeta), иначе вычисляем заново по уже применённым входным данным.
// Разметка замещается (не мерджится): marks из файла или []; marks_version
// новее поддерживаемой — разметка пропускается (предупреждение — в importJsonFile).
export function restoreSingleResults(results, meta, getContextText) {
  state.results = results;
  state.results.marks = (results.marks_version || MARKS_VERSION) > MARKS_VERSION
    ? []
    : sanitizeMarks(results.marks, "single");
  state.resultsMeta = meta && meta.fingerprint
    ? { ...meta }
    : { fingerprint: singleFingerprint(getContextText()) };
  state.resultsStale = false;
  renderResults();
}

// Снапшот вопросов прогона пакета из файла: массив вопросов в формате
// normalizeQuestion, иначе фолбэк на живые вопросы (поведение до разметки).
function validQuestionSnap(list) {
  if (!Array.isArray(list) || !list.length) return null;
  try {
    return list.map(q => normalizeQuestion(q));
  } catch {
    return null;
  }
}

// Результаты пакета из снапшота сессии. Файлы при импорте получают новые id —
// в файле лежит br.files (id в порядке batch_files), по нему remap на новые id.
// Тем же idMap перекодируется target.file пометок; пометки файлов вне remap
// отбрасываются. Без marks — замещение пустым массивом (не мердж).
export function restoreBatchResults(br) {
  const idMap = Object.create(null);
  if (Array.isArray(br.files)) {
    br.files.forEach((oldId, i) => {
      const f = state.batch.files[i];
      if (f) idMap[oldId] = f.id;
    });
  } else {
    // Без явного списка допускаем только уже существующие id; неизвестный ключ
    // результата никогда не присваиваем файлу по позиции и не оставляем сиротой.
    for (const f of state.batch.files) idMap[f.id] = f.id;
  }
  const results = {};
  for (const [oldId, res] of Object.entries(br.results || {})) {
    const newId = idMap[oldId];
    if (!newId) continue;
    results[newId] = res;
    const f = state.batch.files.find(x => x.id === newId);
    if (f && res) f.status = "ok";
  }
  const durations = {};
  for (const [oldId, d] of Object.entries(br.durations || {})) {
    if (idMap[oldId]) durations[idMap[oldId]] = d;
  }
  const marks = [];
  if ((br.marks_version || MARKS_VERSION) <= MARKS_VERSION) {
    for (const m of sanitizeMarks(br.marks, "batch")) {
      if (m.target.file) {
        const newId = idMap[m.target.file];
        if (!newId) continue; // файл не попал в remap — пометка отбрасывается
        m.target = { ...m.target, file: newId };
      }
      marks.push(m);
    }
  }
  state.batch.marks = marks;
  state.batch.questions = validQuestionSnap(br.questions);
  state.batch.results = results;
  state.batch.durations = durations;
  state.batch.decision = br.decision ?? null;
  const meta = br.results_meta || br.resultsMeta;
  state.batch.resultsMeta = meta && meta.fingerprint
    ? { ...meta }
    : { fingerprint: batchFingerprint() };
  state.batch.resultsStale = false;
  renderBatchList();
  renderBatchResults();
}

// Пересчёт fingerprint'ов: если входные данные отличаются от момента прогона —
// resultsStale (и флаг пакета) + перерендер плашки. Вызывается
// дебаунсированно из initStaleTracking; в тестах — напрямую.
export function refreshStale(getContextText) {
  if (state.results && state.resultsMeta) {
    const stale = singleFingerprint(getContextText()) !== state.resultsMeta.fingerprint;
    if (stale !== state.resultsStale) {
      state.resultsStale = stale;
      renderResults();
    }
  }
  if (state.batch.resultsMeta && Object.keys(state.batch.results).length) {
    const stale = batchFingerprint() !== state.batch.resultsMeta.fingerprint;
    if (stale !== state.batch.resultsStale) {
      state.batch.resultsStale = stale;
      renderBatchResults();
    }
  }
}

// Правки, влияющие на вход прогона: контекст, вопросы, решение, изображения,
// файлы пакета. События эмитят модули редакторов (questions/decision/context/batch).
const STALE_EVENTS = new Set(["context", "questions", "decision", "images", "batch"]);

// Подписка на правки с дебаунсом — на каждый keystroke не пересчитываем.
export function initStaleTracking({ getContextText, debounceMs = 350 }) {
  let timer = null;
  subscribe((event) => {
    if (!STALE_EVENTS.has(event)) return;
    clearTimeout(timer);
    timer = setTimeout(() => refreshStale(getContextText), debounceMs);
  });
}
