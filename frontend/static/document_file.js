import { downloadJson, parseImport } from "./context.js";
import {
  AGGREGATION_POLICY, DOCUMENT_FORMAT, DOCUMENT_VERSION, PACK_VERSION,
  FINGERPRINT_VERSION, finalizePack,
} from "./config_pack.js";

const JSON_TYPES = [{ description: "Документ Вердикта", accept: { "application/json": [".json"] } }];

function abortLike(error) {
  return error?.name === "AbortError" || /отмен|cancel/i.test(error?.message || "");
}

function jsonBlob(data) {
  return new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
}

export async function documentFromWorkspace(data) {
  const settings = {
    mode: data.runMode || "decisions",
    models: Array.isArray(data.selectedModels) ? data.selectedModels : [],
    aggregation: AGGREGATION_POLICY,
  };
  if (typeof data.temperature === "number" && data.temperature > 0) settings.temperature = data.temperature;
  if (data.pinnedFormats && Object.keys(data.pinnedFormats).length) settings.prompt_formats = data.pinnedFormats;
  const config = await finalizePack({
    version: PACK_VERSION,
    fingerprint_version: FINGERPRINT_VERSION,
    questions: Array.isArray(data.questions) ? data.questions : [],
    decision: data.decision || { enabled: true, outcomes: [] },
    settings,
    ui: { pageMode: data.pageMode || "single", threads: data.threads ?? null },
  });
  const materials = {
    input_format: data.input_format || "text",
    input: data.input ?? "",
  };
  if (Array.isArray(data.images) && data.images.length) materials.images = data.images;
  if (Array.isArray(data.batchFiles) && data.batchFiles.length) materials.batch_files = data.batchFiles;
  const results = {};
  if (data.results) results.results = data.results;
  if (data.resultsMeta) results.results_meta = data.resultsMeta;
  if (data.batchResults && Object.keys(data.batchResults).length) {
    results.batch_results = {
      ...data.batchResults,
      results_meta: data.batchResults.resultsMeta || data.batchResults.results_meta || null,
    };
    delete results.batch_results.resultsMeta;
  }
  const document = { format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION, scope: "full", config, materials };
  if (Object.keys(results).length) document.results = results;
  return document;
}

export async function openDocumentFromDisk() {
  try {
    if (typeof globalThis.showOpenFilePicker === "function") {
      const [handle] = await globalThis.showOpenFilePicker({ types: JSON_TYPES, multiple: false });
      const file = await handle.getFile();
      return { handle, name: handle.name, parsed: parseImport(await file.text()) };
    }
  } catch (error) {
    if (abortLike(error)) return null;
    throw error;
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      try {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        resolve({ handle: null, name: file.name, parsed: parseImport(await file.text()) });
      } catch (error) { reject(error); }
    }, { once: true });
    input.click();
  });
}

export async function saveDocumentToDisk(data, { handle = null, filename = "документ.json" } = {}) {
  let target = handle;
  if (!target && typeof globalThis.showSaveFilePicker === "function") {
    try {
      target = await globalThis.showSaveFilePicker({ suggestedName: filename, types: JSON_TYPES });
    } catch (error) {
      if (abortLike(error)) return null;
      throw error;
    }
  }
  if (target) {
    const writable = await target.createWritable();
    try { await writable.write(jsonBlob(data)); }
    finally { await writable.close(); }
    return { handle: target, name: target.name, status: "saved" };
  }
  downloadJson(filename, data);
  return { handle: null, name: filename, status: "downloaded" };
}

export function readLegacyDocuments(owner = "local") {
  const result = [];
  const registryKey = `dq-documents:${owner}:registry`;
  let registry = null;
  try { registry = JSON.parse(localStorage.getItem(registryKey) || "null"); } catch { /* повреждённые записи не переносим */ }
  if (registry?.documents && typeof registry.documents === "object") {
    for (const [docId, metadata] of Object.entries(registry.documents)) {
      try {
        const snapshot = JSON.parse(localStorage.getItem(`dq-workspace:${owner}:${docId}`) || "null");
        if (snapshot?.data) result.push({ id: docId, name: metadata.name || `Документ ${docId}`, data: snapshot.data });
      } catch { /* один повреждённый документ не мешает остальным */ }
    }
  }
  if (!result.length && owner === "local") {
    try {
      const data = JSON.parse(localStorage.getItem("dq-workspace") || "null");
      if (data && typeof data === "object") result.push({ id: "default", name: "Документ 1", data });
    } catch { /* legacy не мешает запуску */ }
  }
  return result;
}
