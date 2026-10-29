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
  if (scope === "full") pack.ui = { pageMode: state.pageMode, threads: state.threads };
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

function posixQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function windowsQuote(value) {
  return `"${String(value).replaceAll("%", "%%").replaceAll('"', '\\"')}"`;
}

export function buildCliCommand({ platform = "posix", filename = "decision-qa-config.json", server = "http://localhost:8000", threads = null } = {}) {
  if (platform !== "posix" && platform !== "windows") throw new Error(`Неизвестная платформа: ${platform}`);
  const quote = platform === "windows" ? windowsQuote : posixQuote;
  const executable = platform === "windows" ? "cli\\bin\\dqa.cmd" : "cli/bin/dqa";
  const materials = platform === "windows" ? "путь\\к\\материалам" : "путь/к/материалам";
  let configName = String(filename).trim() || "decision-qa-config.json";
  if (!/\.json$/i.test(configName)) configName += ".json";
  const parts = [quote(executable), "run", quote(materials), "--config", quote(configName), "--server", quote(server)];
  if (Number.isInteger(threads) && threads > 0) parts.push("--threads", String(threads));
  parts.push("--report", quote("run-report.json"));
  return parts.join(" ");
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
  box.className = "preset-dialog-box saveas-dialog-box";
  const h = document.createElement("div");
  h.className = "preset-dialog-title";
  h.textContent = "Сохранить копию в файл";
  box.appendChild(h);
  const description = document.createElement("div");
  description.className = "hint";
  description.textContent = "Отдельный JSON-файл выбранного состава. Текущий документ останется открыт и не изменится.";
  box.appendChild(description);

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
    const full = scope === "full";
    const withoutResults = scope === "questions" || scope === "cli";
    if (full) resultsCb.checked = true;
    if (withoutResults) resultsCb.checked = false;
    resultsCb.disabled = full || withoutResults;
    marksCb.disabled = full || withoutResults || !resultsCb.checked;
    resultsRow.classList.toggle("hidden", withoutResults);
    marksRow.classList.toggle("hidden", withoutResults);
    cliBlock.classList.toggle("hidden", scope !== "cli");
    if (scope === "cli") updateCommand();
  };

  const nameIn = document.createElement("input");
  nameIn.className = "mgr-input";
  nameIn.id = "saveas-filename";
  nameIn.placeholder = "Имя файла";
  nameIn.value = defaultFileName();
  box.appendChild(nameIn);

  const cliBlock = document.createElement("div");
  cliBlock.id = "saveas-cli";
  cliBlock.className = "saveas-cli hidden";
  const cliTitle = document.createElement("div");
  cliTitle.className = "saveas-cli-title";
  cliTitle.textContent = "Запуск из командной строки";
  cliBlock.appendChild(cliTitle);
  const platforms = document.createElement("div");
  platforms.className = "saveas-cli-platforms";
  let platform = "posix";
  const platformButtons = [];
  for (const [value, label] of [["posix", "macOS / Linux"], ["windows", "Windows"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-small saveas-cli-platform";
    button.textContent = label;
    button.dataset.platform = value;
    button.onclick = () => {
      platform = value;
      for (const item of platformButtons) item.classList.toggle("active", item === button);
      updateCommand();
    };
    platformButtons.push(button);
    platforms.appendChild(button);
  }
  cliBlock.appendChild(platforms);
  const command = document.createElement("textarea");
  command.id = "saveas-cli-command";
  command.className = "saveas-cli-command";
  command.readOnly = true;
  command.rows = 4;
  command.setAttribute("aria-label", "Команда запуска CLI");
  cliBlock.appendChild(command);
  const cliActions = document.createElement("div");
  cliActions.className = "mgr-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.id = "saveas-cli-copy";
  copy.className = "btn btn-small";
  copy.textContent = "Копировать команду";
  const copyStatus = document.createElement("span");
  copyStatus.id = "saveas-cli-copy-status";
  copyStatus.className = "saveas-cli-copy-status";
  cliActions.append(copy, copyStatus);
  cliBlock.appendChild(cliActions);
  const cliNote = document.createElement("div");
  cliNote.className = "saveas-cli-note";
  cliNote.textContent = "Перед запуском проверьте и при необходимости измените пути к утилите, файлу конфигурации, материалам и отчёту. Если сервер требует авторизацию, настройте DQA_TOKEN или защищённый профиль — токен в команду не подставляется.";
  cliBlock.appendChild(cliNote);
  box.appendChild(cliBlock);

  const updateCommand = () => {
    command.value = buildCliCommand({
      platform,
      filename: nameIn.value,
      server: globalThis.location?.origin || "http://localhost:8000",
      threads: state.threads,
    });
    copyStatus.textContent = "";
    for (const button of platformButtons) button.classList.toggle("active", button.dataset.platform === platform);
  };
  nameIn.addEventListener("input", updateCommand);
  copy.onclick = async () => {
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error("Clipboard API недоступен");
      await globalThis.navigator.clipboard.writeText(command.value);
      copyStatus.textContent = "Скопировано";
    } catch {
      command.focus();
      command.select?.();
      copyStatus.textContent = "Не удалось скопировать автоматически. Команда выделена — нажмите Ctrl/Cmd+C.";
    }
  };
  for (const radio of radios) radio.addEventListener("change", updateScope);
  updateScope();
  updateCommand();

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
