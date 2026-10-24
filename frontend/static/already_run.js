// «Уже прогнано» — только точные совпадения с provenance текущего документа.
// Здесь нет server registry и нет автоматического пропуска inference.

import { state, subscribe, selectedModelKeys } from "./state.js";
import { buildInput } from "./context.js";
import { effectivePack, packFromState } from "./config_pack.js";
import { prepareMaterials, cleanProvenance, cleanRunIds } from "./run_client.js";

const RUN_ID = /^run_[0-9a-f]{32}$/;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export { cleanProvenance, cleanRunIds };

function sameMaterials(run, descriptor) {
  return run.materialsFingerprint === descriptor.materialsFingerprint &&
    run.materialHashes.length === descriptor.materialHashes.length &&
    run.materialHashes.every((hash, index) => hash === descriptor.materialHashes[index]);
}

function compatibleRuns(meta, links, descriptor) {
  if (!record(meta?.runs)) return null;
  const ids = [...new Set(links)];
  if (!ids.length) return null;
  const runs = [];
  for (const runId of ids) {
    const run = meta.runs[runId];
    if (!run || run.status !== "completed" || run.configFingerprint !== descriptor.configFingerprint ||
        !sameMaterials(run, descriptor)) return null;
    runs.push(run);
  }
  return runs;
}

export function matchSingleAlreadyRun(descriptor, source = state) {
  if (source.resultsStale) return null;
  const results = source.results;
  if (!record(results?.results) || !record(results.runIds)) return null;
  const links = [];
  for (const [model, value] of Object.entries(results.results)) {
    const byMode = results.runIds[model];
    if (!record(byMode)) return null;
    if (results.runMode === "both") {
      for (const mode of Object.keys(value || {})) {
        if (!RUN_ID.test(byMode[mode] || "")) return null;
        links.push(byMode[mode]);
      }
    } else {
      if (!RUN_ID.test(byMode[results.runMode] || "")) return null;
      links.push(byMode[results.runMode]);
    }
  }
  return compatibleRuns(source.resultsMeta, links, descriptor);
}

export function matchBatchAlreadyRun(descriptor, source = state) {
  if (source.batch?.resultsStale) return null;
  if (!record(source.batch?.results) || !record(source.batch.runIds) || !Object.keys(source.batch.results).length) return null;
  const links = [];
  for (const [fileId, perModel] of Object.entries(source.batch.results)) {
    if (!source.batch.files.some(file => file.id === fileId) || !record(source.batch.runIds[fileId])) return null;
    for (const model of Object.keys(perModel || {})) {
      const runId = source.batch.runIds[fileId][model];
      if (!RUN_ID.test(runId || "")) return null;
      links.push(runId);
    }
  }
  return compatibleRuns(source.batch.resultsMeta, links, descriptor);
}

async function descriptorFor(pack, models, mode, materials) {
  const effective = await effectivePack(pack, { models, mode });
  const prepared = await prepareMaterials(materials);
  return {
    configFingerprint: effective.fingerprint,
    materialsFingerprint: prepared.fingerprint,
    materialHashes: prepared.hashes,
  };
}

export async function currentSingleDescriptor() {
  try {
    const images = state.contextImages.map(image => image.dataUrl);
    let models = selectedModelKeys();
    if (images.length) models = models.filter(key => state.models.find(model => model.key === key)?.vision);
    if (!models.length) return null;
    return await descriptorFor(packFromState(), models, state.runMode, [{ input: buildInput(), images }]);
  } catch {
    return null;
  }
}

function batchInput(file) {
  if (file.isImage) return file.text;
  if (file.name.toLowerCase().endsWith(".json")) {
    try { return JSON.parse(file.text); } catch { return file.text; }
  }
  return file.text;
}

export function currentBatchDescriptor() {
  const models = selectedModelKeys();
  if (!models.length || !state.batch.files.length) return Promise.resolve(null);
  const materials = state.batch.files.map(file => ({
    name: file.name, input: batchInput(file),
    images: file.isImage ? [file.dataUrl] : (file.images || []).map(image => image.dataUrl),
  }));
  return descriptorFor(packFromState(), models, "decisions", materials).catch(() => null);
}

const panels = { single: null, batch: null };
const generations = { single: 0, batch: 0 };
let timer = null;
let onRunCallback = () => {};
let onShowCallback = () => {};

function makePanel(scope) {
  const card = document.getElementById(scope === "single" ? "results-card" : "batch-results-card");
  if (!card) return null;
  const panel = document.createElement("div");
  panel.id = `already-run-${scope}`;
  panel.className = "already-run hidden";
  const text = document.createElement("span");
  text.className = "already-run-label";
  text.textContent = "Уже прогнано";
  const show = document.createElement("button");
  show.type = "button";
  show.className = "btn btn-small already-run-show";
  show.textContent = "Показать результаты";
  show.onclick = () => onShowCallback(scope);
  const rerun = document.createElement("button");
  rerun.type = "button";
  rerun.className = "btn btn-small already-run-rerun";
  rerun.textContent = "Всё равно прогнать";
  rerun.onclick = () => onRunCallback(scope);
  panel.append(text, show, rerun);
  card.insertBefore(panel, card.firstChild);
  return panel;
}

function hide(scope) {
  generations[scope] += 1;
  panels[scope]?.classList.add("hidden");
}

async function refresh(scope) {
  const generation = ++generations[scope];
  const descriptor = scope === "single" ? await currentSingleDescriptor() : await currentBatchDescriptor();
  if (generation !== generations[scope]) return;
  const running = scope === "single" ? state.running : state.batch.running;
  const match = descriptor && !running && (scope === "single"
    ? matchSingleAlreadyRun(descriptor)
    : matchBatchAlreadyRun(descriptor));
  panels[scope]?.classList.toggle("hidden", !match);
}

export function refreshAlreadyRun() {
  clearTimeout(timer);
  for (const scope of ["single", "batch"]) hide(scope);
  timer = setTimeout(() => {
    refresh("single");
    refresh("batch");
  }, 200);
}

export function initAlreadyRun({ onRun, onShow } = {}) {
  onRunCallback = onRun || (() => {});
  onShowCallback = onShow || (() => {});
  for (const scope of ["single", "batch"]) {
    if (!panels[scope] || !document.contains(panels[scope])) panels[scope] = makePanel(scope);
  }
  subscribe(event => {
    if (["context", "questions", "decision", "images", "batch", "models", "runSettings", "results", "pagemode", "stale"].includes(event)) {
      refreshAlreadyRun();
    }
  });
  refreshAlreadyRun();
}
