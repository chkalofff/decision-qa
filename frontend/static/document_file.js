import { downloadJson, parseImport } from "./context.js";

const JSON_TYPES = [{ description: "Документ Вердикта", accept: { "application/json": [".json"] } }];

function abortLike(error) {
  return error?.name === "AbortError" || /отмен|cancel/i.test(error?.message || "");
}

function jsonBlob(data) {
  return new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
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
