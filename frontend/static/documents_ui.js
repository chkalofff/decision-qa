// File-first document workflows. Документы не синхронизируются между вкладками.

import { state } from "./state.js";
import { applyImportedContext, currentText } from "./context.js";
import { addQuestion, setQuestions } from "./questions.js";
import { setDecision } from "./decision.js";
import { loadPresetFiles } from "./batch.js";
import { restoreSingleResults, restoreBatchResults } from "./stale.js";
import { applyPackSettings } from "./config_pack.js";
import { setPageMode } from "./toolbar.js";
import { closePanel as closeAssistantPanel } from "./assistant.js";
import { resetWorkshopSelection } from "./workshop_ui.js";
import {
  activateDocument, currentDocument, initPersist, markDocumentSaved,
  pausePersist, resetDocumentState, restoreDocumentData, resumePersist,
  setPersistCallbacks,
} from "./persist.js";
import { buildExportDocument } from "./saveas.js";
import {
  documentFromWorkspace, openDocumentFromDisk, readLegacyDocuments, saveDocumentToDisk,
} from "./document_file.js";

let onWarning = () => {};
let onError = () => {};
let beforeUnloadBound = false;

function current() {
  return currentDocument();
}

function showDocumentError(message) {
  if (onError) onError(message);
  else onWarning(message);
}

export function renderDocumentMenu() {
  const doc = current();
  const name = document.getElementById("tb-document-name");
  const status = document.getElementById("tb-document-status");
  if (name) {
    name.textContent = doc?.name || "Без названия";
    name.title = doc ? `Текущий документ: ${doc.name}` : "Текущий документ";
  }
  if (!status) return;
  const labels = {
    new: "Новый документ",
    dirty: "● Требует сохранения",
    saving: "Сохранение…",
    saved: "✓ Сохранено",
    downloaded: "↓ Файл скачан",
  };
  status.textContent = labels[doc?.status] || labels.new;
  status.classList.toggle("dirty", doc?.status === "dirty");
}

function dialogButton(text, id, primary = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.className = primary ? "btn btn-primary" : "btn";
  button.textContent = text;
  return button;
}

function closeDialog(id) {
  document.getElementById(id)?.remove();
}

function askSaveChanges(action) {
  const doc = current();
  if (!doc?.dirty) return Promise.resolve("discard");
  closeDialog("document-unsaved-dialog");
  const overlay = document.createElement("div");
  overlay.className = "preset-dialog-overlay";
  overlay.id = "document-unsaved-dialog";
  const box = document.createElement("div");
  box.className = "preset-dialog-box";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  const title = document.createElement("div");
  title.className = "preset-dialog-title";
  title.textContent = `Сохранить изменения перед ${action}?`;
  const text = document.createElement("div");
  text.textContent = `Иначе несохранённые изменения в «${doc.name}» будут потеряны.`;
  const actions = document.createElement("div");
  actions.className = "mgr-actions";
  const discard = dialogButton("Не сохранять", "document-discard");
  const cancel = dialogButton("Отмена", "document-cancel");
  const save = dialogButton("Сохранить", "document-save", true);
  actions.append(discard, cancel, save);
  box.append(title, text, actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  return new Promise(resolve => {
    const done = value => { closeDialog("document-unsaved-dialog"); resolve(value); };
    discard.onclick = () => done("discard");
    cancel.onclick = () => done("cancel");
    save.onclick = () => done("save");
    overlay.addEventListener("click", event => { if (event.target === overlay) done("cancel"); });
  });
}

async function afterDirtyGuard(action, continuation) {
  const choice = await askSaveChanges(action);
  if (choice === "cancel") return false;
  if (choice === "save" && !await saveCurrentDocument()) return false;
  return continuation();
}

function safeFilename(name) {
  const clean = String(name || "документ").replace(/[\\/:*?"<>|]/g, "-").trim();
  return `${clean || "документ"}.json`;
}

export async function saveCurrentDocumentAs() {
  const doc = current();
  if (!doc) return false;
  try {
    const data = await buildExportDocument("full", true, true);
    const suggested = doc.name === "Без названия" ? "документ.json" : safeFilename(doc.name);
    const saved = await saveDocumentToDisk(data, { handle: null, filename: suggested });
    if (!saved) return false;
    markDocumentSaved(saved);
    renderDocumentMenu();
    return true;
  } catch (error) {
    showDocumentError(`Не удалось сохранить документ: ${error.message}`);
    return false;
  }
}

export async function saveCurrentDocument() {
  const doc = current();
  if (!doc) return false;
  if (!doc.fileHandle) return saveCurrentDocumentAs();
  try {
    doc.status = "saving";
    renderDocumentMenu();
    const data = await buildExportDocument("full", true, true);
    const saved = await saveDocumentToDisk(data, { handle: doc.fileHandle, filename: doc.name });
    if (!saved) return false;
    markDocumentSaved(saved);
    renderDocumentMenu();
    return true;
  } catch (error) {
    doc.status = "dirty";
    doc.dirty = true;
    renderDocumentMenu();
    showDocumentError(`Не удалось сохранить документ: ${error.message}`);
    return false;
  }
}

export async function createNewDocument() {
  return afterDirtyGuard("созданием нового документа", async () => {
    pausePersist();
    closeAssistantPanel();
    resetWorkshopSelection();
    resetDocumentState();
    activateDocument();
    if (!state.questions.length) addQuestion();
    setPageMode("single");
    resumePersist();
    renderDocumentMenu();
    return true;
  });
}

function restoreOpenedDocument(parsed, { name, handle }) {
  pausePersist();
  try {
    closeAssistantPanel();
    resetWorkshopSelection();
    resetDocumentState();
    if (parsed.context) applyImportedContext(parsed.context);
    if (parsed.questions) setQuestions(parsed.questions);
    if (parsed.decisionImport) setDecision(parsed.decision);
    if (parsed.batchFiles) loadPresetFiles(parsed.batchFiles);
    if (parsed.settings) applyPackSettings(parsed.settings);
    if (parsed.batchResults) restoreBatchResults(parsed.batchResults);
    if (parsed.results) restoreSingleResults(parsed.results, parsed.resultsMeta, currentText);
    if (parsed.ui && (parsed.ui.threads === null || Number.isInteger(parsed.ui.threads) && parsed.ui.threads >= 1)) {
      state.threads = parsed.ui.threads;
    }
    const page = parsed.ui?.pageMode || (parsed.kind === "batch" ? "batch" : "single");
    if (!state.questions.length) addQuestion();
    setPageMode(page);
    activateDocument({ name, fileHandle: handle, status: "saved" });
    resumePersist();
    renderDocumentMenu();
    return page;
  } catch (error) {
    resumePersist();
    throw error;
  }
}

export async function openDocumentFile() {
  let picked;
  try { picked = await openDocumentFromDisk(); }
  catch (error) { showDocumentError(`Не удалось открыть документ: ${error.message}`); return false; }
  if (!picked) return false;
  if (picked.parsed.scope !== "full") {
    showDocumentError("Это не полный документ Вердикта. Используйте «Импорт в текущий документ…».");
    return false;
  }
  return afterDirtyGuard("открытием документа", async () => {
    try { return restoreOpenedDocument(picked.parsed, picked); }
    catch (error) {
      showDocumentError(`Не удалось открыть документ: ${error.message}`);
      return false;
    }
  });
}

function openLegacyMigrationDialog(documents) {
  closeDialog("legacy-documents-dialog");
  const overlay = document.createElement("div");
  overlay.className = "preset-dialog-overlay";
  overlay.id = "legacy-documents-dialog";
  const box = document.createElement("div");
  box.className = "preset-dialog-box documents-dialog-box";
  const title = document.createElement("div");
  title.className = "preset-dialog-title";
  title.textContent = "Перенести прежние документы?";
  const note = document.createElement("div");
  note.className = "hint";
  note.textContent = "В этой версии документы хранятся в файлах, а не в браузере. Сохраните нужные документы по одному. Прежние данные не удаляются.";
  const list = document.createElement("div");
  list.className = "documents-list";
  for (const item of documents) {
    const row = document.createElement("div");
    row.className = "documents-row";
    const name = document.createElement("span");
    name.className = "documents-row-name";
    name.textContent = item.name;
    const save = dialogButton("Сохранить в файл", `legacy-save-${item.id}`);
    save.onclick = async () => {
      save.disabled = true;
      try {
        const data = await documentFromWorkspace(item.data);
        const saved = await saveDocumentToDisk(data, { filename: safeFilename(item.name) });
        if (saved) save.textContent = saved.status === "downloaded" ? "Скачано" : "Сохранено";
      } catch (error) { showDocumentError(`Не удалось перенести «${item.name}»: ${error.message}`); }
      save.disabled = false;
    };
    row.append(name, save);
    list.appendChild(row);
  }
  const close = dialogButton("Закрыть", "legacy-documents-close");
  close.onclick = () => closeDialog("legacy-documents-dialog");
  box.append(title, note, list, close);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

export async function initDocuments({ onWarning: warning, onError: error } = {}) {
  onWarning = warning || (() => {});
  onError = error || null;
  setPersistCallbacks({ onChange: renderDocumentMenu });
  activateDocument();
  initPersist();
  renderDocumentMenu();
  if (!beforeUnloadBound) {
    beforeUnloadBound = true;
    globalThis.addEventListener?.("beforeunload", event => {
      if (!current()?.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }
  const legacy = readLegacyDocuments();
  if (legacy.length) openLegacyMigrationDialog(legacy);
  return state.pageMode;
}

export { restoreDocumentData };
