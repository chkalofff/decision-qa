// Browser client for the job-scoped /api/run protocol. No model dispatch here:
// the server owns execution, prompt formats and canonical decisions.

import { apiFetch } from "./auth.js";
import {
  compositeContentSha256, imageContentSha256, materialHash, materialsFingerprint,
} from "./config_pack.js";

const TERMINAL = new Set(["completed", "completed_partial", "cancelled", "failed"]);

export class RunClientError extends Error {
  constructor(message, { status = 0, path = "", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RunClientError";
    this.status = status;
    this.path = path;
  }
}

function id() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replaceAll("-", "");
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function detail(response) {
  try {
    const data = await response.json();
    if (data && data.detail != null) return String(data.detail);
  } catch { /* non-JSON error response */ }
  return response.statusText || "без описания";
}

async function request(path, options = {}, { expected = [200], retries = 2, retryDelayMs = 200 } = {}) {
  let failure = 0;
  while (true) {
    let response;
    try {
      response = await apiFetch(path, options);
    } catch (error) {
      if (options.signal?.aborted || failure >= retries) {
        throw new RunClientError(`Сетевая ошибка ${options.method || "GET"} ${path}: ${error.message}`, { path, cause: error });
      }
      failure += 1;
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * failure));
      continue;
    }
    if (response.status === 429 && failure < retries) {
      failure += 1;
      const retryAfter = Number(response.headers?.get?.("Retry-After"));
      await new Promise(resolve => setTimeout(resolve, Number.isFinite(retryAfter) ? retryAfter * 1000 : retryDelayMs * failure));
      continue;
    }
    if (response.status >= 500 && failure < retries) {
      failure += 1;
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * failure));
      continue;
    }
    if (!expected.includes(response.status)) {
      throw new RunClientError(`Ошибка ${response.status} для ${path}: ${await detail(response)}`, { status: response.status, path });
    }
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch (error) {
      throw new RunClientError(`Сервер вернул не JSON для ${path}. Проверьте совместимость версий.`, { status: response.status, path, cause: error });
    }
  }
}

export function getRunCapabilities() {
  return request("/api/run/capabilities");
}

function imageParts(images) {
  return (images || []).map((image, index) => {
    if (typeof image === "string") return { payload: image, name: `image-${index + 1}.png` };
    const payload = image?.dataUrl ?? image?.data_url ?? image?.base64 ?? image?.data;
    if (typeof payload !== "string" || !payload) throw new RunClientError(`Изображение ${index + 1} не содержит data URL/base64.`);
    return { payload, name: String(image.name || `image-${index + 1}.png`) };
  });
}

function materialType(input, images, declared) {
  if (!images.length) return "text";
  if (declared === "text+images") return declared;
  return input == null || input === "" ? "image" : "text+images";
}

export async function prepareMaterial(source, i) {
  const input = source.input;
  const images = imageParts(source.images);
  const payloads = images.map(image => image.payload);
  const contentSha256 = await compositeContentSha256(input, payloads);
  const imageMetadata = [];
  for (const [index, image] of images.entries()) {
    imageMetadata.push({ name: image.name, sha256: await imageContentSha256(image.payload, index) });
  }
  const type = materialType(input, images, source.material?.type);
  const material = { type, images: imageMetadata };
  const metadata = { material };
  if (source.path != null) metadata.path = source.path;
  if (source.name != null) metadata.name = source.name;
  const hash = await materialHash(input, payloads, metadata, contentSha256);
  const file = {
    i, input, content_sha256: contentSha256,
    material, material_hash: hash,
  };
  if (source.path != null) file.path = source.path;
  if (source.name != null) file.name = source.name;
  if (payloads.length) file.images = payloads;
  return file;
}

export async function prepareMaterials(sources) {
  if (!Array.isArray(sources) || !sources.length) throw new RunClientError("Нужен хотя бы один материал.");
  const files = [];
  for (const [i, source] of sources.entries()) files.push(await prepareMaterial(source, i));
  return {
    files,
    hashes: files.map(file => file.material_hash),
    fingerprint: await materialsFingerprint(files.map(file => file.material_hash)),
  };
}

function chunks(files, capabilities) {
  const maxFiles = capabilities.max_files_per_chunk || capabilities.default_files_per_chunk || 50;
  const maxBytes = capabilities.max_chunk_bytes || 24 * 1024 * 1024;
  const output = [];
  let current = [];
  let bytes = 0;
  for (const file of files) {
    const size = new TextEncoder().encode(JSON.stringify(file)).length;
    if (size + 128 > maxBytes) {
      throw new RunClientError(`Материал ${file.i + 1} не помещается в лимит чанка ${maxBytes} байт.`);
    }
    if (current.length && (current.length >= maxFiles || bytes + size + 96 > maxBytes)) {
      output.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += size + 1;
  }
  if (current.length) output.push(current);
  return output.map((filesInChunk, chunkIndex) => ({ chunk_index: chunkIndex, files: filesInChunk }));
}

export async function uploadRunChunks(runId, files, capabilities, options = {}) {
  for (const chunk of chunks(files, capabilities)) {
    const body = JSON.stringify(chunk);
    if (new TextEncoder().encode(body).length > capabilities.max_chunk_bytes) {
      throw new RunClientError(`Чанк ${chunk.chunk_index} превышает ${capabilities.max_chunk_bytes} байт.`);
    }
    await request(`/api/run/${encodeURIComponent(runId)}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: options.signal,
    }, options);
  }
}

function sseEvents(text) {
  const events = [];
  for (const block of text.replaceAll("\r\n", "\n").split("\n\n")) {
    const data = [];
    let lastEventId = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      else if (line.startsWith("id:")) lastEventId = line.slice(3).trim();
    }
    if (data.length) events.push({ data: data.join("\n"), lastEventId });
  }
  return events;
}

async function readSse(response, onEvent) {
  if (!response.body?.getReader) {
    throw new RunClientError("Браузер не поддерживает потоковое чтение SSE.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    buffer = buffer.replaceAll("\r\n", "\n");
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const event of sseEvents(block + "\n\n")) await onEvent(event);
    }
    if (done) break;
  }
  if (buffer.trim()) throw new RunClientError("SSE оборвался в середине события.");
}

export async function watchRun(runId, { onEvent = () => {}, signal, retries = 3, retryDelayMs = 250, after = 0 } = {}) {
  const seen = new Set();
  let cursor = after;
  let failures = 0;
  while (true) {
    let replay = false;
    let sawEnd = false;
    try {
      const path = `/api/run/${encodeURIComponent(runId)}/events?after=${cursor}`;
      const response = await apiFetch(path, {
        headers: { Accept: "text/event-stream", "Last-Event-ID": String(cursor) },
        signal,
      });
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && failures < retries) {
          failures += 1;
          await new Promise(resolve => setTimeout(resolve, retryDelayMs * failures));
          continue;
        }
        throw new RunClientError(`Ошибка ${response.status} SSE ${runId}: ${await detail(response)}`, { status: response.status, path });
      }
      await readSse(response, async ({ data }) => {
        let event;
        try { event = JSON.parse(data); } catch (error) {
          throw new RunClientError(`SSE содержит невалидный JSON; run_id=${runId}`, { cause: error });
        }
        if (event.type === "resync_required") {
          replay = true;
          return;
        }
        if (!Number.isInteger(event.seq)) throw new RunClientError(`SSE без числового seq; run_id=${runId}`);
        if (seen.has(event.seq) || event.seq <= cursor) return;
        seen.add(event.seq);
        cursor = event.seq;
        failures = 0;
        if (signal?.aborted) throw new RunClientError("SSE отменён клиентом.");
        if (event.type === "run_end") sawEnd = true;
        await onEvent(event);
      });
      if (replay) {
        failures += 1;
        if (failures > retries) throw new RunClientError(`SSE требует повторного replay; run_id=${runId}`);
        continue;
      }
      if (sawEnd) return cursor;
      throw new RunClientError(`SSE завершился без run_end; run_id=${runId}`);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof RunClientError && error.status && error.status < 500 && error.status !== 429) throw error;
      failures += 1;
      if (failures > retries) {
        throw new RunClientError(`SSE оборвался после reconnect; run_id=${runId}; задание может продолжаться на сервере: ${error.message}`, { cause: error });
      }
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * failures));
    }
  }
}

export async function getRunMetadata(runId, options = {}) {
  return request(`/api/run/${encodeURIComponent(runId)}`, { signal: options.signal }, options);
}

export async function getRunResults(runId, capabilities = {}, options = {}) {
  const limit = Math.min(capabilities.max_page_limit || 200, capabilities.default_page_limit || 50);
  const files = [];
  let offset = 0;
  while (true) {
    const page = await request(`/api/run/${encodeURIComponent(runId)}/files?offset=${offset}&limit=${limit}`, { signal: options.signal }, options);
    if (!Array.isArray(page.files)) throw new RunClientError("Несовместимая страница результатов: files не список.");
    files.push(...page.files);
    if (page.next_offset == null) break;
    if (!Number.isInteger(page.next_offset) || page.next_offset <= offset) {
      throw new RunClientError("Несовместимая страница результатов: next_offset не увеличивается.");
    }
    offset = page.next_offset;
  }
  return files;
}

export function cancelRun(runId) {
  return request(`/api/run/${encodeURIComponent(runId)}/cancel`, { method: "POST" }, { retries: 1 });
}

export function executeRun({ pack, materials, overrides = {}, threads = null, capabilities, idempotencyKey = null, onEvent = () => {}, signal, retries = 2, retryDelayMs = 200 }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  let runId = null;
  let cancelRequested = false;
  let cancelFailure = null;
  const done = (async () => {
    const caps = capabilities || await getRunCapabilities();
    const prepared = await prepareMaterials(materials);
    if (prepared.files.length > (caps.max_files_per_job || 100000)) {
      throw new RunClientError(`Материалов больше лимита ${caps.max_files_per_job}.`);
    }
    chunks(prepared.files, caps);
    if (cancelRequested) throw new RunClientError("Прогон отменён до создания задания.");
    const body = {
      pack, overrides, material_count: prepared.files.length,
      materials_fingerprint: prepared.fingerprint,
    };
    if (threads != null) body.threads = threads;
    const created = await request("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey || id() },
      body: JSON.stringify(body), signal: controller.signal,
    }, { expected: [200, 201], retries, retryDelayMs });
    runId = created.run_id;
    if (cancelRequested) {
      await cancelRun(runId);
      const metadata = await getRunMetadata(runId, { retries, retryDelayMs });
      return { metadata, files: [], materialHashes: prepared.hashes, materialsFingerprint: prepared.fingerprint };
    }
    await uploadRunChunks(runId, prepared.files, caps, { signal: controller.signal, retries, retryDelayMs });
    await request(`/api/run/${encodeURIComponent(runId)}/start`, { method: "POST", signal: controller.signal }, { retries, retryDelayMs });
    try {
      await watchRun(runId, { onEvent, signal: controller.signal, retries: retries + 1, retryDelayMs });
    } catch (error) {
      if (!cancelRequested) throw error;
    }
    const metadata = await getRunMetadata(runId, { signal: cancelRequested ? undefined : controller.signal, retries, retryDelayMs });
    if (cancelFailure) throw cancelFailure;
    if (!TERMINAL.has(metadata.status)) throw new RunClientError(`Прогон ${runId} завершил SSE без terminal-статуса.`);
    const files = await getRunResults(runId, caps, { signal: cancelRequested ? undefined : controller.signal, retries, retryDelayMs });
    if (metadata.status === "failed") throw new RunClientError(metadata.error || `Прогон ${runId} завершился ошибкой.`);
    return { metadata, files, materialHashes: prepared.hashes, materialsFingerprint: prepared.fingerprint };
  })();
  return {
    done,
    get runId() { return runId; },
    async cancel() {
      cancelRequested = true;
      try {
        if (runId) await cancelRun(runId);
      } catch (error) {
        cancelFailure = error;
        throw error;
      } finally {
        abort();
      }
    },
  };
}

function legacyResult(run) {
  const result = {
    ok: run.ok === true,
    answers: run.answers || {},
    usage: run.usage || {},
    metrics: run.metrics || {},
  };
  if (run.prompt_format_version != null) result.prompt_format_version = run.prompt_format_version;
  if (!result.ok) result.error = run.error || "Неизвестная ошибка модели";
  return result;
}

function mapRuns(file, mapRun) {
  const output = {};
  for (const run of file.runs || []) mapRun(output, run);
  return output;
}

function mapSingleRuns(file, mode, systemOneModels, mapValue, nested) {
  return mapRuns(file, (output, run) => {
    if (mode !== "both" && !nested) {
      output[run.model] = mapValue(run);
      return;
    }
    let slot = mode;
    if (mode === "both") {
      if (run.mode === "fast_batch") slot = "fast_batch";
      else if (systemOneModels.has(run.model)) slot = "clef";
      else slot = "decisions";
    }
    const current = output[run.model] || {};
    current[slot] = mapValue(run);
    output[run.model] = current;
  });
}

function mapBatchRuns(file, mapValue) {
  return mapRuns(file, (output, run) => {
    if (run.mode === "decisions" || !(run.model in output)) output[run.model] = mapValue(run);
  });
}

export function singleResultsFromFile(file, mode, systemOneModels = new Set()) {
  return mapSingleRuns(file, mode, systemOneModels, legacyResult, false);
}

export function batchResultsFromFile(file) {
  return mapBatchRuns(file, legacyResult);
}

export function singleRunLinks(file, runId, mode, systemOneModels = new Set()) {
  return mapSingleRuns(file, mode, systemOneModels, () => runId, true);
}

export function batchRunLinks(file, runId) {
  return mapBatchRuns(file, () => runId);
}

const RUN_ID = /^run_[0-9a-f]{32}$/;
const PROVENANCE_STATUSES = new Set(["completed", "completed_partial", "cancelled", "failed"]);

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function cleanProvenance(meta) {
  if (!isRecord(meta)) return meta;
  const cleaned = { ...meta };
  const runs = {};
  if (isRecord(meta.runs)) {
    for (const [key, value] of Object.entries(meta.runs)) {
      if (!RUN_ID.test(key) || !isRecord(value) || value.runId !== key ||
          !PROVENANCE_STATUSES.has(value.status) || typeof value.configFingerprint !== "string" ||
          typeof value.materialsFingerprint !== "string" || !Array.isArray(value.materialHashes) ||
          value.materialHashes.some(hash => typeof hash !== "string")) continue;
      runs[key] = { ...value, materialHashes: [...value.materialHashes] };
    }
  }
  if (Object.keys(runs).length) cleaned.runs = runs;
  else {
    delete cleaned.runs;
    delete cleaned.latestRun;
  }
  if (cleaned.latestRun != null && !runs[cleaned.latestRun]) delete cleaned.latestRun;
  return cleaned;
}

export function cleanRunIds(value) {
  if (!isRecord(value)) return {};
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isRecord(item)) continue;
    const links = {};
    for (const [mode, runId] of Object.entries(item)) if (RUN_ID.test(runId)) links[mode] = runId;
    if (Object.keys(links).length) output[key] = links;
  }
  return output;
}
