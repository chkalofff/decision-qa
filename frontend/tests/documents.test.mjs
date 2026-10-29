// File-first документы: полное сохранение/открытие, dirty guard и legacy-перенос.

import {
  test, assert, eq, includes, installDom, resetState, domApp,
  state, context, batch, persist, documents, documentsUi,
} from "./harness.mjs";

const RUN_ID = "run_" + "a".repeat(32);

async function setup() {
  installDom(); await resetState(); domApp();
  context.initContext({});
  batch.initBatch({});
  persist.resumePersist();
  localStorage.clear();
  await documentsUi.initDocuments({ onError: () => {} });
}

function fillCompleteDocument() {
  state.models = [
    { key: "mA", label: "A", status: "running" },
    { key: "mB", label: "B", status: "running" },
  ];
  state.selectedModels = new Set(["mB"]);
  state.runMode = "decisions";
  state.temperature = 0.65;
  state.threads = 4;
  state.pinnedFormats = { mB: 2 };
  context.setContent("материал default", "text");
  context.setImages(["data:image/png;base64,QUJD"]);
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no", direction: "no" }];
  state.decision = { enabled: true, outcomes: [{ id: "o1", label: "A", color: "green", rules: [] }] };
  state.results = {
    results: { mB: { ok: true, answers: {}, usage: {}, metrics: {} } },
    order: ["mB"], runMode: "both", questions: state.questions,
    runIds: { mB: { decisions: RUN_ID, fast_batch: RUN_ID } },
    marks: [{ id: "mark1", target: { scope: "single", model: "mB", mode: "decisions", question: "q1" },
      verdict: "accept", comment: "ok", criterion: "correctness", author: "local", created_at: "t", updated_at: "t" }],
  };
  state.resultsMeta = {
    fingerprint: "single-fp", latestRun: RUN_ID,
    runs: { [RUN_ID]: {
      runId: RUN_ID, status: "completed", configFingerprint: "sha256:config",
      materialsFingerprint: "sha256:materials", materialHashes: ["sha256:one"],
    } },
  };
  batch.loadPresetFiles([{ name: "a.txt", content: "batch A" }]);
  const fileId = state.batch.files[0].id;
  state.batch.results[fileId] = { mB: { ok: true, answers: {}, usage: {}, metrics: {} } };
  state.batch.runIds[fileId] = { mB: RUN_ID };
  state.batch.marks = [{ id: "mark2", target: { scope: "batch", file: fileId, question: "q1", model: "mB" },
    verdict: "reject", comment: "bad", criterion: "correctness", author: "local", created_at: "t", updated_at: "t" }];
  state.batch.resultsMeta = { fingerprint: "batch-fp" };
  state.batch.questions = state.questions;
  state.batch.decision = state.decision;
}

function nativeFile() {
  const handle = {
    name: "полный-документ.json", content: "",
    createWritable: async () => ({
      write: async blob => { handle.content = blob.content; },
      close: async () => {},
    }),
    getFile: async () => ({ text: async () => handle.content }),
  };
  globalThis.showSaveFilePicker = async () => handle;
  globalThis.showOpenFilePicker = async () => [handle];
  return handle;
}

test("documents: полный save/open восстанавливает materials/results/marks/provenance и threads", async () => {
  await setup(); fillCompleteDocument();
  const handle = nativeFile();
  assert(await documentsUi.saveCurrentDocumentAs(), "Save As записал файл");
  const data = JSON.parse(handle.content);
  eq(data.scope, "full", "полный состав");
  eq(data.config.ui.threads, 4, "threads в config.ui");
  eq(data.results.results.marks.length, 1, "single marks сохранены");
  eq(data.results.batch_results.marks.length, 1, "batch marks сохранены");
  eq(persist.currentDocument().dirty, false, "save снял dirty");
  eq(persist.currentDocument().status, "saved", "статус saved");

  context.setContent("другой текст", "text");
  state.threads = 1;
  assert(persist.currentDocument().dirty, "правка снова включила dirty");
  assert(await documentsUi.saveCurrentDocument(), "Save перезаписал связанный файл");
  eq(JSON.parse(handle.content).materials.input, "другой текст", "новый текст в файле");

  assert(await documentsUi.openDocumentFile(), "open выполнен");
  eq(context.currentText(), "другой текст", "материал восстановлен");
  eq(state.contextImages.length, 1, "images восстановлены");
  eq(state.questions[0].direction, "no", "questions восстановлены");
  eq(state.decision.outcomes[0].label, "A", "decision восстановлен");
  eq(state.results.marks.length, 1, "single marks восстановлены");
  eq(state.resultsMeta.latestRun, RUN_ID, "single provenance восстановлена");
  eq(state.batch.marks.length, 1, "batch marks восстановлены");
  eq(state.threads, 1, "threads восстановлены из config.ui");
  eq(state.temperature, 0.65, "temperature восстановлена");
  eq(state.pinnedFormats.mB, 2, "prompt pins восстановлены");
  eq(persist.currentDocument().dirty, false, "открытый файл чист");
});

test("documents: invalid open и отмена dirty guard не стирают текущий документ", async () => {
  await setup();
  context.setContent("keep me", "text");
  globalThis.showOpenFilePicker = async () => {
    const handle = { name: "bad.json", getFile: async () => ({ text: async () => "{bad" }) };
    return [handle];
  };
  eq(await documentsUi.openDocumentFile(), false, "invalid JSON отклонён");
  eq(context.currentText(), "keep me", "текущий материал не изменился");

  globalThis.showOpenFilePicker = async () => {
    const handle = {
      name: "cli.json",
      getFile: async () => ({ text: async () => JSON.stringify({ format: "decision-qa-document", version: 1, scope: "cli" }) }),
    };
    return [handle];
  };
  eq(await documentsUi.openDocumentFile(), false, "частичный CLI нельзя открыть как полный документ");
  eq(context.currentText(), "keep me", "и после wrong scope материал сохранён");

  const pending = documentsUi.createNewDocument();
  assert(document.getElementById("document-unsaved-dialog"), "dirty guard показан");
  document.getElementById("document-cancel").fire("click");
  eq(await pending, false, "отмена не создала документ");
  eq(context.currentText(), "keep me", "после отмены состояние прежнее");
});

test("documents: dirty guard «Не сохранять» создаёт независимый чистый документ", async () => {
  await setup(); fillCompleteDocument();
  const oldId = persist.currentDocument().id;
  const pending = documentsUi.createNewDocument();
  document.getElementById("document-discard").fire("click");
  assert(await pending, "new подтверждён");
  assert(persist.currentDocument().id !== oldId, "новый per-tab id");
  eq(state.results, null, "blank не наследует single results");
  eq(Object.keys(state.batch.results).length, 0, "blank не наследует batch results");
  eq(persist.currentDocument().status, "new", "статус нового документа");
  eq(persist.currentDocument().dirty, false, "blank чист");
});

test("documents: fallback сохраняет скачанный полный файл без File System Access API", async () => {
  await setup(); fillCompleteDocument();
  delete globalThis.showSaveFilePicker;
  delete globalThis.showOpenFilePicker;
  let downloaded = null;
  globalThis.URL.createObjectURL = blob => { downloaded = blob.content; return "blob:x"; };
  assert(await documentsUi.saveCurrentDocumentAs(), "fallback save выполнен");
  assert(downloaded, "JSON скачан");
  eq(JSON.parse(downloaded).scope, "full", "скачан полный документ");
  eq(persist.currentDocument().status, "downloaded", "честный fallback-статус");
  eq(persist.currentDocument().fileHandle, null, "исходный handle не выдуман");
});

test("documents: legacy перенос предлагает файлы и не удаляет старые данные", async () => {
  installDom(); await resetState(); domApp();
  context.initContext({}); batch.initBatch({}); persist.resumePersist(); localStorage.clear();
  const legacy = { input: "legacy", questions: [], decision: null, pageMode: "single", selectedModels: [] };
  localStorage.setItem("dq-documents:local:registry", JSON.stringify({ currentDocId: "old", documents: { old: { id: "old", name: "Старый документ" } } }));
  localStorage.setItem("dq-workspace:local:old", JSON.stringify({ data: legacy }));
  const handle = nativeFile();
  await documentsUi.initDocuments({ onError: () => {} });
  assert(document.getElementById("legacy-documents-dialog"), "показан явный перенос");
  document.getElementById("legacy-save-old").fire("click");
  await new Promise(resolve => setTimeout(resolve, 20));
  eq(JSON.parse(handle.content).scope, "full", "legacy сохранён как полный документ");
  assert(localStorage.getItem("dq-workspace:local:old"), "legacy snapshot не удалён");
});

test("documents: правки не создают localStorage-снапшоты и storage listener отсутствует", async () => {
  await setup();
  context.setContent("только в памяти", "text");
  eq(localStorage.getItem("dq-workspace"), null, "нет legacy записи");
  eq(localStorage.getItem("dq-workspace:local:default"), null, "нет scoped записи");
  eq(persist.currentDocument().dirty, true, "dirty только в памяти");
  eq(typeof documentsUi.handleDocumentStorageEvent, "undefined", "межвкладочный conflict handler удалён");
});
