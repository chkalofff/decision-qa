// Fingerprint входных данных прогона: стабильный хеш (djb2) от контекста,
// вопросов, правил решения и изображений. Используется для пометки результатов
// неактуальными (stale) после правок. Листовой модуль — только state, без DOM,
// чтобы не плодить циклические импорты (текст контекста передаётся параметром).

import { state } from "./state.js";

// djb2 — достаточно для сравнения «изменилось/нет», это не криптография.
export function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Вопросы: только данные, влияющие на прогон (collapsed/_fresh — UI-состояние).
function questionsPart() {
  return state.questions.map(q => ({
    id: q.id, question: q.question, type: q.type,
    yes: q.yes, no: q.no,
    options: (q.options || []).map(o => ({ name: o.name, description: o.description })),
    levels: q.levels, direction: q.direction,
  }));
}

// Правила решения без UI-состояния редактора (collapsed).
function decisionPart() {
  if (!state.decision) return null;
  const snap = JSON.parse(JSON.stringify(state.decision));
  for (const o of snap.outcomes || []) delete o.collapsed;
  return snap;
}

// Изображения: имя + размер dataUrl (сам dataUrl не сериализуем — он огромный).
function imagesPart() {
  return state.contextImages.map(img => [img.name, (img.dataUrl || "").length]);
}

// Одиночный режим: текст контекста приходит параметром (currentText живёт в
// context.js — так избегаем циклического импорта context → fingerprint).
export function singleFingerprint(contextText) {
  return hashString(JSON.stringify({
    text: contextText, q: questionsPart(), d: decisionPart(), img: imagesPart(),
  }));
}

// Батч: список файлов (имя/размер/содержимое/прикреплённые картинки, порядок
// значим) + общие вопросы и правила решения.
export function batchFingerprint() {
  return hashString(JSON.stringify({
    files: state.batch.files.map(f => ({
      name: f.name, size: f.size,
      text: f.isImage ? (f.dataUrl || "").length : f.text,
      images: (f.images || []).map(img => [img.name, (img.dataUrl || "").length]),
    })),
    q: questionsPart(), d: decisionPart(),
  }));
}
