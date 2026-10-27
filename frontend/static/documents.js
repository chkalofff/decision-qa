// Owner-scoped local document registry and revisioned snapshot storage.
// No server document registry: all data stays in this origin's localStorage.

export const DEFAULT_DOCUMENT_ID = "default";
export const LEGACY_WORKSPACE_KEY = "dq-workspace";
export const LEGACY_ENABLED_KEY = "dq-workspace-enabled";

const REGISTRY_SCHEMA = 1;
const SNAPSHOT_SCHEMA = 1;
const ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;

export class DocumentStorageError extends Error {
  constructor(message, { code = "storage", cause = null, snapshot = null, backupKey = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DocumentStorageError";
    this.code = code;
    this.snapshot = snapshot;
    this.backupKey = backupKey;
  }
}

export class DocumentConflictError extends DocumentStorageError {
  constructor(snapshot, backupKey = null) {
    super("Документ изменён в другой вкладке", { code: "conflict", snapshot, backupKey });
    this.name = "DocumentConflictError";
  }
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function validId(value, kind) {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new DocumentStorageError(`Некорректный ${kind}: ${String(value)}`, { code: "corrupt" });
  }
  return value;
}

export function documentRegistryKey(owner) {
  return `dq-documents:${validId(owner, "owner")}:registry`;
}

export function documentSnapshotKey(owner, docId) {
  return `dq-workspace:${validId(owner, "owner")}:${validId(docId, "document id")}`;
}

export function documentsEnabledKey(owner) {
  return `dq-documents:${validId(owner, "owner")}:enabled`;
}

function migrationKey(owner) {
  return `dq-documents:${validId(owner, "owner")}:legacy-migrated`;
}

function emptyRegistry(currentDocId = DEFAULT_DOCUMENT_ID) {
  return { schema: REGISTRY_SCHEMA, currentDocId, documents: {} };
}

function validateRegistryMetadata(docId, meta) {
  if (!ID_RE.test(docId) || !isRecord(meta) || meta.id !== docId ||
      typeof meta.name !== "string" || typeof meta.createdAt !== "string" ||
      typeof meta.updatedAt !== "string") {
    throw new DocumentStorageError("Метаданные документа повреждены", { code: "corrupt" });
  }
}

function registryEntryKey(owner, docId) {
  return `dq-documents:${validId(owner, "owner")}:entry:${validId(docId, "document id")}`;
}

export function documentConflictBackupKey(owner, docId, backupId) {
  return `dq-document-conflicts:${validId(owner, "owner")}:${validId(docId, "document id")}:${validId(backupId, "backup id")}`;
}

export function readDocumentRegistry(owner) {
  const raw = localStorage.getItem(documentRegistryKey(owner));
  let registry = emptyRegistry();
  if (raw) {
    try { registry = JSON.parse(raw); } catch (error) {
      throw new DocumentStorageError("Реестр документов повреждён", { code: "corrupt", cause: error });
    }
  }
  if (!isRecord(registry) || registry.schema !== REGISTRY_SCHEMA ||
      !isRecord(registry.documents) || !ID_RE.test(registry.currentDocId || "")) {
    throw new DocumentStorageError("Реестр документов имеет неизвестный формат", { code: "corrupt" });
  }
  for (const [docId, meta] of Object.entries(registry.documents)) validateRegistryMetadata(docId, meta);
  if (typeof localStorage.length === "number" && typeof localStorage.key === "function") {
    const prefix = `dq-documents:${owner}:entry:`;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const docId = key.slice(prefix.length);
      let metadata;
      try { metadata = JSON.parse(localStorage.getItem(key)); } catch (error) {
        throw new DocumentStorageError("Резервные метаданные документа повреждены", { code: "corrupt", cause: error });
      }
      validateRegistryMetadata(docId, metadata);
      if (!registry.documents[docId]) registry.documents[docId] = metadata;
    }
  }
  return registry;
}

function writeRawDocumentRegistry(owner, registry) {
  try {
    localStorage.setItem(documentRegistryKey(owner), JSON.stringify(registry));
  } catch (error) {
    throw new DocumentStorageError("Не удалось сохранить реестр документов. Освободите место в хранилище браузера.", { code: "quota", cause: error });
  }
}

function writeDocumentRegistry(owner, registry) {
  let desired = registry;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const latest = readDocumentRegistry(owner);
    desired = {
      ...desired,
      documents: { ...latest.documents, ...desired.documents },
    };
    writeRawDocumentRegistry(owner, desired);
    const verified = readDocumentRegistry(owner);
    if (Object.keys(desired.documents).every(docId => verified.documents[docId])) return verified;
    desired = { ...verified, documents: { ...verified.documents, ...desired.documents } };
  }
  throw new DocumentStorageError("Реестр изменён одновременно в другой вкладке; повторите действие.", { code: "registry" });
}

function writeDocumentEntry(owner, metadata) {
  try {
    localStorage.setItem(registryEntryKey(owner, metadata.id), JSON.stringify(metadata));
  } catch (error) {
    throw new DocumentStorageError("Не удалось сохранить метаданные документа", { code: "quota", cause: error });
  }
}

function hasWebLocks() {
  return typeof globalThis.navigator?.locks?.request === "function";
}

function withOwnerLock(owner, callback) {
  if (hasWebLocks()) {
    return globalThis.navigator.locks.request(`dq-documents:${owner}`, { mode: "exclusive" }, callback);
  }
  return callback();
}

function contentHash(data) {
  const text = JSON.stringify(data);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return `djb2:${hash.toString(36)}`;
}

function parseDocumentSnapshot(raw, docId) {
  if (!raw) return null;
  let snapshot;
  try { snapshot = JSON.parse(raw); } catch (error) {
    throw new DocumentStorageError(`Документ ${docId} повреждён и не может быть открыт`, { code: "corrupt", cause: error });
  }
  if (!isRecord(snapshot) || snapshot.schema !== SNAPSHOT_SCHEMA || snapshot.docId !== docId ||
      !Number.isInteger(snapshot.revision) || snapshot.revision < 0 ||
      typeof snapshot.writerId !== "string" || !snapshot.writerId ||
      typeof snapshot.contentHash !== "string" || !isRecord(snapshot.data) ||
      snapshot.contentHash !== contentHash(snapshot.data)) {
    throw new DocumentStorageError(`Документ ${docId} имеет неизвестный или повреждённый снапшот`, { code: "corrupt" });
  }
  return snapshot;
}

export function readDocumentSnapshot(owner, docId) {
  return parseDocumentSnapshot(localStorage.getItem(documentSnapshotKey(owner, docId)), docId);
}

export function readDocumentConflictBackup(owner, docId, backupId) {
  return parseDocumentSnapshot(localStorage.getItem(documentConflictBackupKey(owner, docId, backupId)), docId);
}

function sameSnapshotIdentity(left, right) {
  return !!left && !!right && left.revision === right.revision &&
    left.contentHash === right.contentHash && left.writerId === right.writerId &&
    (left.backupId || null) === (right.backupId || null);
}

function checkWriteAllowed(canCommit) {
  if (canCommit && !canCommit()) {
    throw new DocumentStorageError("Автосохранение отключено; отложенная запись отменена.", { code: "disabled" });
  }
}

export function saveDocumentSnapshot(owner, metadata, data, {
  expectedRevision = 0, expectedContentHash = null, writerId, canCommit = null,
} = {}) {
  const optimistic = !hasWebLocks();
  return withOwnerLock(owner, () => {
    checkWriteAllowed(canCommit);
    const docId = validId(metadata.id, "document id");
    if (typeof writerId !== "string" || !writerId) {
      throw new DocumentStorageError("Отсутствует writerId снапшота", { code: "storage" });
    }
    const current = readDocumentSnapshot(owner, docId);
    const actualRevision = current?.revision || 0;
    const conflicted = actualRevision !== expectedRevision ||
      (expectedContentHash !== null && current?.contentHash !== expectedContentHash);
    const now = new Date().toISOString();
    const snapshot = {
      schema: SNAPSHOT_SCHEMA,
      docId,
      name: metadata.name,
      createdAt: metadata.createdAt || current?.createdAt || now,
      updatedAt: now,
      revision: (conflicted ? expectedRevision : actualRevision) + 1,
      contentHash: contentHash(data),
      writerId,
      data,
    };
    if (optimistic) {
      snapshot.backupId = freshDocumentId();
      snapshot.backupKey = documentConflictBackupKey(owner, docId, snapshot.backupId);
      try {
        localStorage.setItem(snapshot.backupKey, JSON.stringify(snapshot));
      } catch (error) {
        throw new DocumentStorageError("Не удалось сохранить резервную копию документа. Освободите место или экспортируйте JSON.", { code: "quota", cause: error });
      }
    }
    if (conflicted) throw new DocumentConflictError(current, snapshot.backupKey);
    let overwrittenBackupKey = null;
    if (optimistic && current && (!current.backupKey || !localStorage.getItem(current.backupKey))) {
      const overwritten = { ...current, backupId: freshDocumentId() };
      overwritten.backupKey = documentConflictBackupKey(owner, docId, overwritten.backupId);
      overwrittenBackupKey = overwritten.backupKey;
      try {
        localStorage.setItem(overwrittenBackupKey, JSON.stringify(overwritten));
      } catch (error) {
        throw new DocumentStorageError("Не удалось сохранить перезаписываемую версию документа", { code: "quota", cause: error });
      }
    }
    if (canCommit && !canCommit()) {
      if (snapshot.backupKey) localStorage.removeItem(snapshot.backupKey);
      if (overwrittenBackupKey) localStorage.removeItem(overwrittenBackupKey);
      checkWriteAllowed(canCommit);
    }
    try {
      localStorage.setItem(documentSnapshotKey(owner, docId), JSON.stringify(snapshot));
    } catch (error) {
      throw new DocumentStorageError("Не удалось сохранить документ. Освободите место в хранилище браузера или экспортируйте JSON.", {
        code: "quota", cause: error, backupKey: snapshot.backupKey,
      });
    }
    const verified = readDocumentSnapshot(owner, docId);
    if (!sameSnapshotIdentity(verified, snapshot)) {
      throw new DocumentConflictError(verified, snapshot.backupKey);
    }
    const registry = readDocumentRegistry(owner);
    registry.currentDocId = docId;
    registry.documents[docId] = {
      id: docId,
      name: snapshot.name,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      revision: snapshot.revision,
    };
    try {
      writeDocumentEntry(owner, registry.documents[docId]);
      writeDocumentRegistry(owner, registry);
    } catch (error) {
      if (error instanceof DocumentStorageError) {
        error.code = "registry";
        error.snapshot = snapshot;
        error.backupKey = snapshot.backupKey;
        throw error;
      }
      throw new DocumentStorageError("Снапшот сохранён, но реестр не обновлён", {
        code: "registry", cause: error, snapshot, backupKey: snapshot.backupKey,
      });
    }
    return snapshot;
  });
}

export function createDocumentMetadata(owner, { id = null, name = null } = {}) {
  return withOwnerLock(owner, () => {
    const registry = readDocumentRegistry(owner);
    const docId = id || freshDocumentId();
    validId(docId, "document id");
    if (registry.documents[docId]) throw new DocumentStorageError("Документ с таким id уже существует", { code: "storage" });
    const now = new Date().toISOString();
    const metadata = {
      id: docId,
      name: name || `Документ ${Object.keys(registry.documents).length + 1}`,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    writeDocumentEntry(owner, metadata);
    registry.documents[docId] = metadata;
    registry.currentDocId = docId;
    writeDocumentRegistry(owner, registry);
    return metadata;
  });
}

export function freshDocumentId() {
  if (globalThis.crypto?.randomUUID) return `doc_${crypto.randomUUID().replaceAll("-", "")}`;
  return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function renameDocument(owner, docId, name, { writerId: writer = writerId() } = {}) {
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new DocumentStorageError("Введите название документа.", { code: "validation" });
  if (cleanName.length > 120) throw new DocumentStorageError("Название документа не должно превышать 120 символов.", { code: "validation" });
  const registry = readDocumentRegistry(owner);
  const metadata = registry.documents[docId];
  if (!metadata) throw new DocumentStorageError("Документ не найден.", { code: "not_found" });
  const renamed = { ...metadata, name: cleanName };
  const snapshot = readDocumentSnapshot(owner, docId);
  if (!snapshot) {
    return withOwnerLock(owner, () => {
      const latest = readDocumentRegistry(owner);
      if (!latest.documents[docId]) throw new DocumentStorageError("Документ не найден.", { code: "not_found" });
      latest.documents[docId] = { ...latest.documents[docId], name: cleanName };
      writeDocumentEntry(owner, latest.documents[docId]);
      writeDocumentRegistry(owner, latest);
      return { metadata: latest.documents[docId], snapshot: null };
    });
  }
  const saved = await saveDocumentSnapshot(owner, renamed, snapshot.data, {
    expectedRevision: snapshot.revision,
    expectedContentHash: snapshot.contentHash,
    writerId: writer,
  });
  return { metadata: { ...renamed, updatedAt: saved.updatedAt, revision: saved.revision }, snapshot: saved };
}

export function deleteDocument(owner, docId) {
  return withOwnerLock(owner, () => {
    const registry = readDocumentRegistry(owner);
    if (!registry.documents[docId]) throw new DocumentStorageError("Документ не найден.", { code: "not_found" });
    delete registry.documents[docId];
    const remaining = Object.values(registry.documents).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (registry.currentDocId === docId) registry.currentDocId = remaining[0]?.id || DEFAULT_DOCUMENT_ID;
    try {
      localStorage.removeItem(registryEntryKey(owner, docId));
      localStorage.removeItem(documentSnapshotKey(owner, docId));
      const prefix = `dq-document-conflicts:${owner}:${docId}:`;
      if (typeof localStorage.length === "number" && typeof localStorage.key === "function") {
        for (let index = localStorage.length - 1; index >= 0; index -= 1) {
          const key = localStorage.key(index);
          if (key?.startsWith(prefix)) localStorage.removeItem(key);
        }
      }
      writeRawDocumentRegistry(owner, registry);
    } catch (error) {
      throw new DocumentStorageError("Не удалось удалить документ. Повторите действие.", { code: "storage", cause: error });
    }
    return remaining[0]?.id || null;
  });
}

export function ensureDefaultDocument(owner, { createDefault = true } = {}) {
  return withOwnerLock(owner, () => {
    const registry = readDocumentRegistry(owner);
    if (!registry.documents[DEFAULT_DOCUMENT_ID] && createDefault) {
      const now = new Date().toISOString();
      registry.documents[DEFAULT_DOCUMENT_ID] = {
        id: DEFAULT_DOCUMENT_ID, name: "Документ 1",
        createdAt: now, updatedAt: now, revision: 0,
      };
      writeDocumentEntry(owner, registry.documents[DEFAULT_DOCUMENT_ID]);
    } else if (registry.documents[DEFAULT_DOCUMENT_ID]?.name === "Основной документ") {
      registry.documents[DEFAULT_DOCUMENT_ID].name = "Документ 1";
      writeDocumentEntry(owner, registry.documents[DEFAULT_DOCUMENT_ID]);
    }
    if (!registry.documents[registry.currentDocId]) registry.currentDocId = DEFAULT_DOCUMENT_ID;
    writeDocumentRegistry(owner, registry);
    return registry;
  });
}

export async function migrateLegacyWorkspace(owner) {
  if (owner !== "local" || localStorage.getItem(migrationKey(owner)) || !localStorage.getItem(LEGACY_WORKSPACE_KEY)) return null;
  if (localStorage.getItem(LEGACY_ENABLED_KEY) === "0" || localStorage.getItem(documentsEnabledKey(owner)) === "0") return null;
  let data;
  try { data = JSON.parse(localStorage.getItem(LEGACY_WORKSPACE_KEY)); } catch { return null; }
  if (!isRecord(data)) return null;
  const registry = await ensureDefaultDocument(owner);
  const snapshot = await saveDocumentSnapshot(owner, registry.documents[DEFAULT_DOCUMENT_ID], data, {
    expectedRevision: readDocumentSnapshot(owner, DEFAULT_DOCUMENT_ID)?.revision || 0,
    writerId: "migration",
  });
  localStorage.setItem(migrationKey(owner), "1");
  return snapshot;
}

export function deleteOwnerSnapshots(owner) {
  const registry = readDocumentRegistry(owner);
  const keys = new Set(Object.keys(registry.documents).map(docId => documentSnapshotKey(owner, docId)));
  const prefixes = [`dq-workspace:${owner}:`, `dq-document-conflicts:${owner}:`];
  if (typeof localStorage.length === "number" && typeof localStorage.key === "function") {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (prefixes.some(prefix => key?.startsWith(prefix))) keys.add(key);
    }
  }
  for (const key of keys) localStorage.removeItem(key);
  if (owner === "local") localStorage.removeItem(LEGACY_WORKSPACE_KEY);
}

export function documentIdFromHash(hash) {
  const match = String(hash || "").match(/^#doc=([a-zA-Z0-9_-]{1,100})$/);
  return match ? match[1] : null;
}

export function writerId() {
  try {
    const existing = sessionStorage.getItem("dq-document-writer");
    if (existing) return existing;
    const value = freshDocumentId();
    sessionStorage.setItem("dq-document-writer", value);
    return value;
  } catch {
    return freshDocumentId();
  }
}
