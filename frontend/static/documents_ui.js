// File-menu document workflows, hash routing and cross-tab conflict UI.

import { getAuthOwner } from "./auth.js";
import { state } from "./state.js";
import {
  DEFAULT_DOCUMENT_ID, DocumentStorageError, documentRegistryKey, documentSnapshotKey,
  documentIdFromHash, readDocumentRegistry, readDocumentSnapshot, readDocumentConflictBackup,
  createDocumentMetadata, ensureDefaultDocument, migrateLegacyWorkspace,
  saveDocumentSnapshot, renameDocument, deleteDocument, writerId as storageWriterId,
} from "./documents.js";
import {
  initPersist, isPersistEnabled, currentDocument, activateDocument,
  resetDocumentState, restoreDocumentData, workspaceSnapshot, saveNow,
  setPersistCallbacks, setDocumentConflicted, setDocumentRevision, setDocumentName, documentStateVersion,
} from "./persist.js";
import { setPageMode } from "./toolbar.js";
import { addQuestion } from "./questions.js";
import { invalidateRun } from "./run_lifecycle.js";
import { closePanel as closeAssistantPanel } from "./assistant.js";
import { resetWorkshopSelection } from "./workshop_ui.js";

let owner = "local";
let conflict = null;
let onWarning = () => {};
let boundWindow = null;
let boundGuardDocument = null;
let switchDepth = 0;

function resolve(value) {
  return value && typeof value.then === "function" ? value : Promise.resolve(value);
}

function current() {
  return currentDocument();
}

function guardSwitchEvent(event) {
  if (!switchDepth) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function bindSwitchGuard() {
  if (boundGuardDocument === document) return;
  boundGuardDocument = document;
  for (const type of ["beforeinput", "input", "change", "click", "keydown", "paste", "drop"]) {
    document.addEventListener(type, guardSwitchEvent, true);
  }
}

async function saveOutgoingDocument() {
  const initial = current();
  if (!initial || !isPersistEnabled()) return;
  for (;;) {
    const doc = current();
    if (!doc || doc.id !== initial.id || doc.generation !== initial.generation) {
      throw new DocumentStorageError("Активный документ изменился во время переключения.", { code: "storage" });
    }
    if (doc.conflicted) {
      throw new DocumentStorageError("Сначала разрешите конфликт текущего документа — переключение отменено.", { code: "conflict" });
    }
    const version = documentStateVersion();
    const saved = await resolve(saveNow());
    if (!saved) {
      throw new DocumentStorageError("Не удалось сохранить текущий документ. Переключение отменено.", { code: "storage" });
    }
    if (current()?.conflicted) {
      throw new DocumentStorageError("Сначала разрешите конфликт текущего документа — переключение отменено.", { code: "conflict" });
    }
    if (version === documentStateVersion()) return;
  }
}

function setHash(docId) {
  const next = `#doc=${docId}`;
  if (globalThis.location?.hash === next) return;
  if (globalThis.history?.replaceState) {
    globalThis.history.replaceState(null, "", next);
  } else if (globalThis.location) {
    globalThis.location.hash = next;
  }
}

function closeFileMenu() {
  document.getElementById("tb-menu")?.classList.add("hidden");
}

export function showDocumentError(message) {
  const banner = document.getElementById("doc-storage-banner");
  if (!banner) return;
  document.getElementById("doc-storage-text").textContent = message;
  banner.classList.remove("hidden");
}

function hideDocumentError() {
  document.getElementById("doc-storage-banner")?.classList.add("hidden");
}

function conflictBackups(keys, docId) {
  const backups = [];
  for (const key of new Set(keys.filter(Boolean))) {
    const backupId = key.slice(key.lastIndexOf(":") + 1);
    try {
      const snapshot = readDocumentConflictBackup(owner, docId, backupId);
      if (snapshot) backups.push({ key, snapshot });
    } catch (error) {
      showDocumentError(`Не удалось прочитать резервную копию: ${error.message}`);
    }
  }
  return backups.sort((left, right) => right.snapshot.updatedAt.localeCompare(left.snapshot.updatedAt));
}

function showConflict(snapshot, expectedRevision = null, saveError = null) {
  const doc = current();
  const backups = conflictBackups([doc?.backupKey, snapshot?.backupKey, saveError?.backupKey], doc?.id);
  conflict = {
    snapshot,
    expectedRevision: expectedRevision ?? snapshot?.revision ?? 0,
    backups,
  };
  invalidateRun("single");
  invalidateRun("batch");
  state.running = false;
  state.batch.running = false;
  setDocumentConflicted(true);
  const banner = document.getElementById("doc-conflict-banner");
  if (!banner) return;
  const message = snapshot
    ? `«${doc?.name}» изменён в другой вкладке (ревизия ${snapshot.revision}). Выберите версию — автоматического слияния нет.`
    : `«${doc?.name}» удалён или его снапшот сброшен в другой вкладке. Выберите версию.`;
  document.getElementById("doc-conflict-text").textContent = message;
  const picker = document.getElementById("doc-backup-picker");
  const select = document.getElementById("doc-conflict-backups");
  if (picker && select) {
    select.innerHTML = "";
    for (const backup of backups) {
      const option = document.createElement("option");
      option.value = backup.key;
      option.textContent = `ревизия ${backup.snapshot.revision} · ${backup.snapshot.updatedAt.replace("T", " ").slice(0, 16)}`;
      select.appendChild(option);
    }
    select.value = backups[0]?.key || "";
    picker.classList.toggle("hidden", backups.length === 0);
  }
  banner.classList.remove("hidden");
}

function hideConflict() {
  conflict = null;
  setDocumentConflicted(false);
  document.getElementById("doc-conflict-banner")?.classList.add("hidden");
  document.getElementById("doc-backup-picker")?.classList.add("hidden");
}

export function renderDocumentMenu() {
  const currentDoc = current();
  const label = document.getElementById("tb-document-name");
  if (!label) return;
  label.textContent = currentDoc?.name || "Документ";
  label.title = currentDoc ? `Текущий документ: ${currentDoc.name}` : "Текущий документ";
}

export async function openDocument(docId, { updateHash = true, restore = true, saveBeforeSwitch = true } = {}) {
  switchDepth += 1;
  try {
    const registry = await resolve(ensureDefaultDocument(owner, { createDefault: false }));
    const metadata = registry.documents[docId];
    if (!metadata) {
      throw new DocumentStorageError(`Документ «${docId}» не найден. Откройте другой документ или создайте новый.`, { code: "not_found" });
    }
    if (saveBeforeSwitch) await saveOutgoingDocument();
    const snapshot = restore && isPersistEnabled(owner) ? readDocumentSnapshot(owner, docId) : null;
    closeAssistantPanel();
    hideConflict();
    resetWorkshopSelection();
    resetDocumentState();
    activateDocument(owner, metadata, snapshot);
    let page = null;
    if (snapshot) page = restoreDocumentData(snapshot.data, { onWarning });
    if (!snapshot && state.questions.length === 0) addQuestion();
    if (page === "single" || page === "batch") setPageMode(page);
    if (updateHash) setHash(docId);
    hideDocumentError();
    renderDocumentMenu();
    const enabled = document.getElementById("tb-menu-persist");
    if (enabled) enabled.checked = isPersistEnabled();
    return page;
  } finally {
    switchDepth -= 1;
  }
}

export async function createNewDocument({ saveBeforeSwitch = true } = {}) {
  switchDepth += 1;
  try {
    const metadata = await resolve(createDocumentMetadata(owner));
    return await openDocument(metadata.id, { saveBeforeSwitch });
  } finally {
    switchDepth -= 1;
  }
}

export async function duplicateCurrentDocument() {
  switchDepth += 1;
  try {
    const source = current();
    if (!source) return await createNewDocument();
    await saveOutgoingDocument();
    const data = workspaceSnapshot(true);
    const metadata = await resolve(createDocumentMetadata(owner, { name: `${source.name} — копия` }));
    await resolve(saveDocumentSnapshot(owner, metadata, data, {
      expectedRevision: 0,
      writerId: source.writerId,
    }));
    return await openDocument(metadata.id);
  } finally {
    switchDepth -= 1;
  }
}

export async function duplicateDocument(docId) {
  if (docId === current()?.id) return duplicateCurrentDocument();
  const registry = readDocumentRegistry(owner);
  const source = registry.documents[docId];
  if (!source) throw new DocumentStorageError("Документ не найден.", { code: "not_found" });
  const snapshot = readDocumentSnapshot(owner, docId);
  const metadata = await resolve(createDocumentMetadata(owner, { name: `${source.name} — копия` }));
  await resolve(saveDocumentSnapshot(owner, metadata, snapshot?.data || {}, {
    expectedRevision: 0,
    writerId: storageWriterId(),
  }));
  return metadata;
}

export async function renameDocumentById(docId, name) {
  if (docId === current()?.id) await saveOutgoingDocument();
  const result = await resolve(renameDocument(owner, docId, name, { writerId: current()?.writerId || storageWriterId() }));
  if (docId === current()?.id) {
    setDocumentName(result.metadata.name);
    if (result.snapshot) setDocumentRevision(result.snapshot.revision, result.snapshot.contentHash);
    renderDocumentMenu();
  }
  return result.metadata;
}

export async function deleteDocumentById(docId) {
  const nextId = await resolve(deleteDocument(owner, docId));
  if (docId !== current()?.id) return nextId;
  if (nextId) await openDocument(nextId, { saveBeforeSwitch: false });
  else await createNewDocument({ saveBeforeSwitch: false });
  return nextId;
}

export function openDocumentInNewTab(docId) {
  const href = globalThis.location?.href || "";
  const base = href ? href.split("#")[0] : "";
  globalThis.window?.open?.(`${base}#doc=${docId}`, "_blank", "noopener");
}

function closeDocumentDialogs() {
  for (const id of ["documents-dialog", "document-name-dialog", "document-delete-dialog"]) {
    document.getElementById(id)?.remove();
  }
}

function documentDialog(id, titleText) {
  closeDocumentDialogs();
  const overlay = document.createElement("div");
  overlay.className = "preset-dialog-overlay";
  overlay.id = id;
  const box = document.createElement("div");
  box.className = "preset-dialog-box";
  const title = document.createElement("div");
  title.className = "preset-dialog-title";
  title.textContent = titleText;
  box.appendChild(title);
  overlay.appendChild(box);
  overlay.addEventListener("click", event => { if (event.target === overlay) closeDocumentDialogs(); });
  document.body.appendChild(overlay);
  return { overlay, box };
}

function dialogButton(text, id = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  button.textContent = text;
  if (id) button.id = id;
  return button;
}

export function openDocumentsManager() {
  closeFileMenu();
  const { box } = documentDialog("documents-dialog", "Мои документы");
  box.classList.add("documents-dialog-box");
  const list = document.createElement("div");
  list.id = "documents-list";
  list.className = "documents-list";
  box.appendChild(list);
  const actions = document.createElement("div");
  actions.className = "mgr-actions documents-actions";
  box.appendChild(actions);
  const close = dialogButton("Закрыть", "documents-close");
  close.onclick = closeDocumentDialogs;
  box.appendChild(close);
  let selectedId = current()?.id || null;

  const refresh = () => {
    const registry = readDocumentRegistry(owner);
    const documents = Object.values(registry.documents).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!registry.documents[selectedId]) selectedId = documents[0]?.id || null;
    list.innerHTML = "";
    actions.innerHTML = "";
    for (const metadata of documents) {
      const row = document.createElement("div");
      row.className = "documents-row";
      row.dataset.docId = metadata.id;
      const select = document.createElement("input");
      select.type = "radio";
      select.name = "documents-selected";
      select.checked = metadata.id === selectedId;
      select.setAttribute("aria-label", `Выбрать ${metadata.name}`);
      select.onchange = () => { selectedId = metadata.id; refresh(); };
      const info = document.createElement("div");
      info.className = "documents-row-info";
      const name = document.createElement("div");
      name.className = "documents-row-name";
      name.textContent = metadata.name;
      const date = document.createElement("div");
      date.className = "documents-row-date";
      date.textContent = `Изменён ${metadata.updatedAt.replace("T", " ").slice(0, 16)}`;
      info.append(name, date);
      const rowActions = document.createElement("div");
      rowActions.className = "documents-row-actions";
      const open = dialogButton("Открыть");
      open.classList.add("btn-small");
      open.dataset.openDocument = metadata.id;
      open.onclick = async () => {
        closeDocumentDialogs();
        if (metadata.id !== current()?.id) {
          try { await openDocument(metadata.id); } catch (error) { showDocumentError(error.message); }
        }
      };
      const newTab = dialogButton("В новой вкладке");
      newTab.classList.add("btn-small");
      newTab.dataset.newTabDocument = metadata.id;
      newTab.onclick = () => openDocumentInNewTab(metadata.id);
      rowActions.append(open, newTab);
      if (metadata.id === current()?.id) {
        const currentMark = document.createElement("span");
        currentMark.className = "documents-current-mark";
        currentMark.textContent = "Открыт здесь";
        info.appendChild(currentMark);
      }
      row.append(select, info, rowActions);
      list.appendChild(row);
    }
    const duplicate = dialogButton("Создать копию", "documents-duplicate");
    duplicate.onclick = async () => {
      if (!selectedId) return;
      try {
        if (selectedId === current()?.id) {
          closeDocumentDialogs();
          await duplicateCurrentDocument();
        } else {
          await duplicateDocument(selectedId);
          refresh();
        }
      } catch (error) { showDocumentError(error.message); }
    };
    const rename = dialogButton("Переименовать", "documents-rename");
    rename.onclick = () => { if (selectedId) openDocumentNameDialog(selectedId); };
    const remove = dialogButton("Удалить", "documents-delete");
    remove.onclick = () => { if (selectedId) openDocumentDeleteDialog(selectedId); };
    actions.append(duplicate, rename, remove);
  };
  refresh();
}

export function openDocumentNameDialog(docId) {
  const returnToManager = !!document.getElementById("documents-dialog");
  const metadata = readDocumentRegistry(owner).documents[docId];
  if (!metadata) return showDocumentError("Документ не найден.");
  const { box } = documentDialog("document-name-dialog", "Переименовать документ");
  const input = document.createElement("input");
  input.id = "document-name-input";
  input.className = "mgr-input";
  input.maxLength = 120;
  input.value = metadata.name;
  box.appendChild(input);
  const error = document.createElement("div");
  error.className = "document-dialog-error";
  box.appendChild(error);
  const actions = document.createElement("div");
  actions.className = "mgr-actions";
  const save = dialogButton("Сохранить", "document-name-save");
  save.onclick = async () => {
    try {
      await renameDocumentById(docId, input.value);
      closeDocumentDialogs();
      if (returnToManager) openDocumentsManager();
    } catch (caught) { error.textContent = caught.message; }
  };
  const cancel = dialogButton("Отмена", "document-name-cancel");
  cancel.onclick = () => { if (returnToManager) openDocumentsManager(); else closeDocumentDialogs(); };
  actions.append(save, cancel);
  box.appendChild(actions);
  input.focus();
  input.select?.();
}

function openDocumentDeleteDialog(docId) {
  const metadata = readDocumentRegistry(owner).documents[docId];
  if (!metadata) return showDocumentError("Документ не найден.");
  const { box } = documentDialog("document-delete-dialog", "Удалить документ?");
  const text = document.createElement("div");
  text.textContent = `«${metadata.name}» будет удалён из этого браузера вместе с материалами и результатами. Это действие нельзя отменить.`;
  box.appendChild(text);
  const actions = document.createElement("div");
  actions.className = "mgr-actions";
  const remove = dialogButton("Удалить", "document-delete-confirm");
  remove.onclick = async () => {
    try {
      closeDocumentDialogs();
      await deleteDocumentById(docId);
    } catch (error) { showDocumentError(error.message); }
  };
  const cancel = dialogButton("Отмена", "document-delete-cancel");
  cancel.onclick = openDocumentsManager;
  actions.append(remove, cancel);
  box.appendChild(actions);
}

export function handleDocumentStorageEvent(event) {
  const doc = current();
  if (!doc || !event.key) return;
  if (event.key === documentRegistryKey(owner)) {
    renderDocumentMenu();
    return;
  }
  if (event.key !== documentSnapshotKey(owner, doc.id)) return;
  if (!event.newValue) {
    showConflict(null, 0);
    return;
  }
  let snapshot;
  try { snapshot = readDocumentSnapshot(owner, doc.id); } catch (error) {
    showDocumentError(error.message);
    return;
  }
  if (!snapshot || snapshot.writerId === doc.writerId) return;
  if (snapshot.revision < doc.revision) return;
  if (snapshot.revision === doc.revision && snapshot.contentHash === doc.contentHash) return;
  showConflict(snapshot);
}

function restoreConflictSnapshot(snapshot) {
  resetDocumentState();
  const metadata = { ...snapshot, id: snapshot.docId };
  activateDocument(owner, metadata, snapshot);
  const page = restoreDocumentData(snapshot.data, { onWarning });
  if (page === "single" || page === "batch") setPageMode(page);
  setDocumentRevision(snapshot.revision);
  setDocumentConflicted(false);
  renderDocumentMenu();
}

function saveConflictChoice() {
  if (!conflict) return;
  setDocumentRevision(conflict.expectedRevision);
  const saved = saveNow({ force: true });
  if (saved && typeof saved.then === "function") {
    saved.then(snapshot => { if (snapshot) hideConflict(); });
  } else if (saved) hideConflict();
}

function reloadConflict() {
  if (!conflict) return;
  const pending = conflict;
  hideConflict();
  if (!pending.snapshot) {
    resetDocumentState();
    setDocumentRevision(0, null);
    renderDocumentMenu();
    return;
  }
  restoreConflictSnapshot(pending.snapshot);
}

function keepConflict() {
  saveConflictChoice();
}

function recoverConflictBackup() {
  if (!conflict) return;
  const key = document.getElementById("doc-conflict-backups")?.value;
  const backup = conflict.backups.find(candidate => candidate.key === key);
  if (!backup) {
    showDocumentError("Выберите доступную резервную копию.");
    return;
  }
  restoreConflictSnapshot(backup.snapshot);
  saveConflictChoice();
}

export async function initDocuments({ onWarning: warning, restore = true } = {}) {
  owner = getAuthOwner();
  onWarning = warning || (() => {});
  bindSwitchGuard();
  setPersistCallbacks({
    onConflict: (snapshot, error) => showConflict(snapshot, null, error),
    onError: error => showDocumentError(error?.message || String(error)),
    onNotice: showDocumentError,
  });
  await resolve(migrateLegacyWorkspace(owner));
  const registry = await resolve(ensureDefaultDocument(owner));
  const requested = documentIdFromHash(globalThis.location?.hash) || registry.currentDocId || DEFAULT_DOCUMENT_ID;
  let page;
  try {
    page = await openDocument(requested, { updateHash: true, restore, saveBeforeSwitch: false });
  } catch (error) {
    page = await openDocument(DEFAULT_DOCUMENT_ID, { updateHash: true, restore, saveBeforeSwitch: false });
    showDocumentError(error.message);
  }
  initPersist({ documentMode: true });
  const openButton = document.getElementById("tb-menu-documents-open");
  if (openButton) openButton.onclick = openDocumentsManager;
  const duplicateButton = document.getElementById("tb-menu-doc-duplicate");
  if (duplicateButton) duplicateButton.onclick = () => {
    closeFileMenu();
    duplicateCurrentDocument().catch(error => showDocumentError(error.message));
  };
  const renameButton = document.getElementById("tb-menu-doc-rename");
  if (renameButton) renameButton.onclick = () => {
    closeFileMenu();
    if (current()) openDocumentNameDialog(current().id);
  };
  const reloadButton = document.getElementById("doc-reload");
  if (reloadButton) reloadButton.onclick = reloadConflict;
  const keepButton = document.getElementById("doc-keep");
  if (keepButton) keepButton.onclick = keepConflict;
  const recoverButton = document.getElementById("doc-recover-backup");
  if (recoverButton) recoverButton.onclick = recoverConflictBackup;
  const storageClose = document.getElementById("doc-storage-close");
  if (storageClose) storageClose.onclick = hideDocumentError;
  if (boundWindow !== globalThis.window) {
    boundWindow = globalThis.window;
    boundWindow?.addEventListener?.("storage", handleDocumentStorageEvent);
    boundWindow?.addEventListener?.("hashchange", () => {
      const docId = documentIdFromHash(globalThis.location?.hash);
      if (!docId || docId === current()?.id) return;
      openDocument(docId).catch(error => {
        showDocumentError(error.message);
        if (current()) setHash(current().id);
      });
    });
  }
  renderDocumentMenu();
  return page;
}
