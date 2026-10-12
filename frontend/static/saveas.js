// Диалог «Сохранить как…» (меню «Файл»): скачивание снапшота сессии в JSON.
// Состав — радио-выбор: только вопросы / материалы + вопросы /
// материалы + вопросы + правила решений (дефолт); чекбокс добавляет результаты
// прогонов (results + results_meta, batch_results). Формат совместим с
// parseImport/importJsonFile (context.js) — открывается пунктом «Открыть…».

import { state } from "./state.js";
import { buildQuestionsPayload, withDirections } from "./questions.js";
import { contextSnapshot, downloadJson, currentText } from "./context.js";
import { batchFilesSnapshot } from "./batch.js";

// Глубокая копия правил решения без UI-состояния редактора (collapsed).
function decisionClean() {
  if (!state.decision || !state.decision.outcomes || !state.decision.outcomes.length) return null;
  const snap = JSON.parse(JSON.stringify(state.decision));
  for (const o of snap.outcomes) delete o.collapsed;
  return snap;
}

// Тело файла сессии. scope: "questions" (массив — как старый экспорт вопросов),
// "materials" (контекст + вопросы + batch_files) или "full" (+ decision).
// withResults добавляет results/results_meta (одиночный) и batch_results
// (пакет; files — id файлов в порядке batch_files, нужен для remap при импорте).
export function buildSessionData(scope, withResults) {
  const questions = withDirections(buildQuestionsPayload());
  if (scope === "questions") return questions;
  const data = { ...contextSnapshot(), questions };
  if (state.batch.files.length) data.batch_files = batchFilesSnapshot();
  if (scope === "full") {
    const decision = decisionClean();
    if (decision) data.decision = decision;
  }
  if (withResults) {
    if (state.results) {
      data.results = state.results;
      if (state.resultsMeta) data.results_meta = state.resultsMeta;
    }
    if (Object.keys(state.batch.results).length) {
      data.batch_results = {
        files: state.batch.files.map(f => f.id),
        results: state.batch.results,
        durations: state.batch.durations,
        decision: state.batch.decision,
      };
      if (state.batch.resultsMeta) data.batch_results.results_meta = state.batch.resultsMeta;
    }
  }
  return data;
}

// Имя файла по умолчанию: первые слова контекста, иначе «session».
export function defaultFileName() {
  let text = "";
  try { text = currentText(); } catch { /* редактора может не быть */ }
  const words = String(text).replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join("-");
  const clean = words.toLowerCase().replace(/[^a-zа-яё0-9_-]+/gi, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (clean || "session").slice(0, 60);
}

const SCOPES = [
  ["questions", "Только вопросы"],
  ["materials", "Материалы + вопросы"],
  ["full", "Материалы + вопросы + правила решений"],
];

export function openSaveAsDialog({ onError } = {}) {
  closeSaveAsDialog();
  const overlay = document.createElement("div");
  overlay.className = "preset-dialog-overlay";
  overlay.id = "saveas-dialog";
  const box = document.createElement("div");
  box.className = "preset-dialog-box";
  const h = document.createElement("div");
  h.className = "preset-dialog-title";
  h.textContent = "Сохранить как…";
  box.appendChild(h);

  const scopeWrap = document.createElement("div");
  scopeWrap.className = "saveas-scope";
  const radios = [];
  for (const [value, label] of SCOPES) {
    const row = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "saveas-scope";
    radio.value = value;
    radio.checked = value === "full";
    radios.push(radio);
    row.appendChild(radio);
    row.appendChild(document.createTextNode(label));
    scopeWrap.appendChild(row);
  }
  box.appendChild(scopeWrap);

  const resultsRow = document.createElement("label");
  resultsRow.className = "saveas-results";
  const resultsCb = document.createElement("input");
  resultsCb.type = "checkbox";
  resultsCb.id = "saveas-with-results";
  resultsRow.appendChild(resultsCb);
  resultsRow.appendChild(document.createTextNode("Включить результаты прогона"));
  box.appendChild(resultsRow);

  const nameIn = document.createElement("input");
  nameIn.className = "mgr-input";
  nameIn.id = "saveas-filename";
  nameIn.placeholder = "Имя файла";
  nameIn.value = defaultFileName();
  box.appendChild(nameIn);

  const row = document.createElement("div");
  row.className = "mgr-actions";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.id = "saveas-ok";
  ok.className = "btn";
  ok.textContent = "Сохранить";
  ok.onclick = () => {
    const checked = radios.find(r => r.checked);
    const scope = checked ? checked.value : "full";
    let name = nameIn.value.trim() || "session";
    if (!/\.json$/i.test(name)) name += ".json";
    let data;
    try {
      data = buildSessionData(scope, resultsCb.checked);
    } catch (e) {
      if (onError) onError("Экспорт невозможен: " + e.message);
      return;
    }
    downloadJson(name, data);
    closeSaveAsDialog();
  };
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.id = "saveas-cancel";
  cancel.className = "btn";
  cancel.textContent = "Отмена";
  cancel.onclick = closeSaveAsDialog;
  row.append(ok, cancel);
  box.appendChild(row);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSaveAsDialog(); });
  document.body.appendChild(overlay);
}

export function closeSaveAsDialog() {
  const dlg = document.getElementById("saveas-dialog");
  if (dlg) dlg.remove();
}
