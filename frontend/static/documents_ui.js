// File-menu document workflows, hash routing and cross-tab conflict UI.

import { getAuthOwner } from "./auth.js";
import { state } from "./state.js";
import {
  DEFAULT_DOCUMENT_ID, DocumentStorageError, documentRegistryKey, documentSnapshotKey,
  documentIdFromHash, readDocumentRegistry, readDocumentSnapshot, readDocumentConflictBackup,
  createDocumentMetadata, ensureDefaultDocument, migrateLegacyWorkspace,
  saveDocumentSnapshot,
} from "./documents.js";
import {
  initPersist, isPersistEnabled, currentDocument, activateDocument,
  resetDocumentState, restoreDocumentData, workspaceSnapshot, saveNow,
  setPersistCallbacks, setDocumentConflicted, setDocumentRevision, documentStateVersion,
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
  document.getElementById("tb-menu-documents-sub")?.classList.add("hidden");
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
  const currentLabel = document.getElementById("tb-doc-current");
  if (currentLabel) currentLabel.textContent = currentDoc ? `Текущий: ${currentDoc.name}` : "Документы";
  const list = document.getElementById("tb-doc-list");
  if (!list) return;
  list.innerHTML = "";
  let registry;
  try { registry = readDocumentRegistry(owner); } catch (error) {
    showDocumentError(error.message);
    return;
  }
  const documents = Object.values(registry.documents).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const metadata of documents) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "menu-item doc-open-item";
    item.dataset.docId = metadata.id;
    item.textContent = `${metadata.id === currentDoc?.id ? "✓ " : ""}${metadata.name}`;
    item.title = `${metadata.id} · ревизия ${metadata.revision || 0} · ${metadata.updatedAt}`;
    item.addEventListener("click", () => {
      closeFileMenu();
      openDocument(metadata.id).catch(error => showDocumentError(error.message));
    });
    list.appendChild(item);
  }
}

export async function openDocument(docId, { updateHash = true, restore = true, saveBeforeSwitch = true } = {}) {
  switchDepth += 1;
  try {
    const registry = await resolve(ensureDefaultDocument(owner));
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

export async function createNewDocument() {
  switchDepth += 1;
  try {
    const metadata = await resolve(createDocumentMetadata(owner));
    return await openDocument(metadata.id);
  } finally {
    switchDepth -= 1;
  }
}

export async function duplicateCurrentDocument() {
  switchDepth += 1;
  try {
    const source = current();
    if (!source) return await createNewDocument();
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
  const newButton = document.getElementById("tb-doc-new");
  if (newButton) newButton.onclick = () => {
    closeFileMenu();
    createNewDocument().catch(error => showDocumentError(error.message));
  };
  const duplicateButton = document.getElementById("tb-doc-duplicate");
  if (duplicateButton) duplicateButton.onclick = () => {
    closeFileMenu();
    duplicateCurrentDocument().catch(error => showDocumentError(error.message));
  };
  const documentsButton = document.getElementById("tb-menu-documents");
  if (documentsButton) documentsButton.onclick = event => {
    event.stopPropagation();
    renderDocumentMenu();
    document.getElementById("tb-menu-documents-sub")?.classList.toggle("hidden");
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
