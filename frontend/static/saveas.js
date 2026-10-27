// Диалог «Сохранить в файл»: единый decision-qa-document для веба и CLI.
// Config pack обязателен; materials/results добавляются выбранным составом.
// Старые session JSON остаются входным legacy-форматом context.js.

import { state } from "./state.js";
import { buildQuestionsPayload, withDirections } from "./questions.js";
import { contextSnapshot, downloadJson, currentText } from "./context.js";
import { batchFilesSnapshot } from "./batch.js";
import { packFromState, finalizePack, DOCUMENT_FORMAT, DOCUMENT_VERSION } from "./config_pack.js";

// Глубокая копия правил решения без UI-состояния редактора (collapsed).
function decisionClean() {
  if (!state.decision || !state.decision.outcomes || !state.decision.outcomes.length) return null;
  const snap = JSON.parse(JSON.stringify(state.decision));
  for (const o of snap.outcomes) delete o.collapsed;
  return snap;
}

// Legacy session-проекция, из которой buildExportDocument отделяет materials/results.
// withMarks=false оставляет marks_version, но очищает пометки.
export function buildSessionData(scope, withResults, withMarks = true) {
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
      // marks едут внутри results (разметка одиночного прогона), marks_version —
      // версия схемы разметки; без пометок — пустой массив.
      data.results = { ...state.results, marks: withMarks ? (state.results.marks || []) : [], marks_version: 1 };
      if (state.resultsMeta) data.results_meta = state.resultsMeta;
    }
    if (Object.keys(state.batch.results).length) {
      data.batch_results = {
        files: state.batch.files.map(f => f.id),
        // снапшот вопросов прогона пакета (с direction); у старых файлов поля
        // нет — при импорте фолбэк на живые вопросы
        questions: state.batch.questions || null,
        results: state.batch.results,
        runIds: state.batch.runIds,
        durations: state.batch.durations,
        decision: state.batch.decision,
        // пометки со СТАРЫМИ id файлов — remap при импорте по files
        marks: withMarks ? (state.batch.marks || []) : [],
        marks_version: 1,
      };
      if (state.batch.resultsMeta) data.batch_results.results_meta = state.batch.resultsMeta;
    }
  }
  return data;
}

export async function buildExportDocument(scope, withResults, withMarks = true) {
  if (!SCOPES.some(([value]) => value === scope)) throw new Error(`Неизвестный состав экспорта: ${scope}`);
  const pack = packFromState();
  if (scope === "questions" || scope === "materials") pack.decision = { enabled: true, outcomes: [] };
  const config = await finalizePack(pack);
  if (scope === "cli" && !config.settings.models.length) {
    throw new Error("Выберите хотя бы одну работающую модель перед экспортом конфигурации для CLI.");
  }
  const documentData = { format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION, scope, config };
  if (scope !== "materials" && scope !== "full") return documentData;
  const session = buildSessionData(scope, withResults, withMarks);
  const { questions, decision, results, results_meta, batch_results, ...materials } = session;
  documentData.materials = materials;
  const resultData = {};
  if (results != null) resultData.results = results;
  if (results_meta != null) resultData.results_meta = results_meta;
  if (batch_results != null) resultData.batch_results = batch_results;
  if (Object.keys(resultData).length) documentData.results = resultData;
  return documentData;
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
  ["cli", "Конфигурация для CLI"],
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
  h.textContent = "Сохранить в файл";
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

  const marksRow = document.createElement("label");
  marksRow.className = "saveas-marks";
  const marksCb = document.createElement("input");
  marksCb.type = "checkbox";
  marksCb.id = "saveas-with-marks";
  marksCb.checked = true;
  marksCb.disabled = true;
  resultsCb.addEventListener("change", () => { marksCb.disabled = !resultsCb.checked; });
  marksRow.appendChild(marksCb);
  marksRow.appendChild(document.createTextNode("Включить разметку (пометки и комментарии)"));
  box.appendChild(marksRow);

  const updateScope = () => {
    const scope = radios.find(radio => radio.checked)?.value || "full";
    const withoutResults = scope === "questions" || scope === "cli";
    if (withoutResults) resultsCb.checked = false;
    resultsCb.disabled = withoutResults;
    marksCb.disabled = withoutResults || !resultsCb.checked;
    resultsRow.classList.toggle("hidden", withoutResults);
    marksRow.classList.toggle("hidden", withoutResults);
  };
  for (const radio of radios) radio.addEventListener("change", updateScope);
  updateScope();

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
  ok.onclick = async () => {
    const checked = radios.find(r => r.checked);
    const scope = checked ? checked.value : "full";
    let name = nameIn.value.trim() || "session";
    if (!/\.json$/i.test(name)) name += ".json";
    ok.disabled = true;
    try {
      const data = await buildExportDocument(scope, resultsCb.checked, resultsCb.checked && marksCb.checked);
      downloadJson(name, data);
      closeSaveAsDialog();
    } catch (e) {
      ok.disabled = false;
      if (onError) onError("Экспорт невозможен: " + e.message);
    }
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
