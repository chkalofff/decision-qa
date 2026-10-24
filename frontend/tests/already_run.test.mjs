// Доменные тесты: «Уже прогнано» по provenance текущего документа.

import {
  test, assert, eq, includes, installDom, resetState, sleep, domContext, domResults, domBatch, domToolbar,
  state, context, batch, emit, alreadyRun,
} from "./harness.mjs";
import { singleFingerprint } from "../static/fingerprint.js";
import { refreshStale } from "../static/stale.js";

const ID_A = "run_" + "a".repeat(32);
const ID_B = "run_" + "b".repeat(32);

function runRecord(descriptor, runId = ID_A, overrides = {}) {
  return {
    runId, status: "completed",
    configFingerprint: descriptor.configFingerprint,
    materialsFingerprint: descriptor.materialsFingerprint,
    materialHashes: [...descriptor.materialHashes],
    ...overrides,
  };
}

async function singleFixture({ withDom = false } = {}) {
  if (withDom) { domContext(); context.initContext({}); }
  state.models = [
    { key: "mA", label: "A", status: "running" },
    { key: "mB", label: "B", status: "running" },
  ];
  state.selectedModels = new Set(["mA"]);
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no" }];
  state.decision = { enabled: true, outcomes: [{ id: "o1", label: "A", color: "green", rules: [] }] };
  if (withDom) context.setContent("материал", "text");
  const descriptor = await alreadyRun.currentSingleDescriptor();
  const run = runRecord(descriptor);
  state.results = {
    results: { mA: { ok: true } }, order: ["mA"], runMode: "decisions", questions: [],
    runIds: { mA: { decisions: ID_A } }, marks: [],
  };
  state.resultsMeta = { latestRun: ID_A, runs: { [ID_A]: run } };
  return descriptor;
}

test("already_run: single exact completed match и unambiguous compatible completed set", async () => {
  installDom(); await resetState();
  const descriptor = await singleFixture({ withDom: true });
  eq(alreadyRun.matchSingleAlreadyRun(descriptor)[0].runId, ID_A, "точный одиночный run найден");

  state.results.results.mB = { ok: true };
  state.results.order.push("mB");
  state.results.runIds.mB = { decisions: ID_B };
  state.resultsMeta.runs[ID_B] = runRecord(descriptor, ID_B);
  eq(alreadyRun.matchSingleAlreadyRun(descriptor).length, 2, "совместимый completed set накрывает весь view");
});

test("already_run: single edits, legacy, partial и mixed append не дают false positives", async () => {
  installDom(); await resetState();
  const descriptor = await singleFixture({ withDom: true });
  assert(alreadyRun.matchSingleAlreadyRun(descriptor), "baseline match");
  state.resultsStale = true;
  assert(!alreadyRun.matchSingleAlreadyRun(descriptor), "stale results не отмечаются даже при exact fingerprints");
  state.resultsStale = false;
  assert(!alreadyRun.matchSingleAlreadyRun({ ...descriptor, configFingerprint: "sha256:changed" }), "config edit не совпадает");
  assert(!alreadyRun.matchSingleAlreadyRun({ ...descriptor, materialsFingerprint: "sha256:changed" }), "material edit не совпадает");
  assert(!alreadyRun.matchSingleAlreadyRun({ ...descriptor, materialHashes: ["sha256:changed"] }), "ordered hashes обязательны");
  state.resultsMeta.runs[ID_A].status = "completed_partial";
  assert(!alreadyRun.matchSingleAlreadyRun(descriptor), "partial не отмечается");
  state.resultsMeta.runs[ID_A].status = "completed";
  delete state.results.runIds.mA;
  assert(!alreadyRun.matchSingleAlreadyRun(descriptor), "legacy без link не угадывается");

  state.results.runIds.mA = { decisions: ID_A };
  state.results.results.mB = { ok: true };
  state.results.runIds.mB = { decisions: ID_B };
  state.resultsMeta.runs[ID_B] = runRecord(descriptor, ID_B, { configFingerprint: "sha256:other" });
  assert(!alreadyRun.matchSingleAlreadyRun(descriptor), "mixed append не накрывается одним runId");
});

test("already_run: видимые «Показать результаты»/«Всё равно прогнать»; edit скрывает, inference не пропускается", async () => {
  installDom(); await resetState(); domResults(); domBatch();
  await singleFixture({ withDom: true });
  let shown = 0;
  let rerun = 0;
  alreadyRun.initAlreadyRun({ onShow: () => { shown += 1; }, onRun: () => { rerun += 1; } });
  alreadyRun.refreshAlreadyRun();
  await sleep(300);
  const panel = document.getElementById("already-run-single");
  assert(!panel.classList.contains("hidden"), "«Уже прогнано» видно");
  includes(panel.textContent, "Уже прогнано", "видимый статус");
  panel.querySelector(".already-run-show").fire("click");
  eq(shown, 1, "«Показать результаты» раскрывает существующий view");
  panel.querySelector(".already-run-rerun").fire("click");
  eq(rerun, 1, "явный rerun всегда вызывает обычный запуск");

  state.resultsMeta.fingerprint = singleFingerprint(context.currentText());
  state.questions[0].direction = "no";
  refreshStale(context.currentText);
  await sleep(300);
  eq(state.resultsStale, true, "direction edit перевёл results в stale");
  assert(panel.classList.contains("hidden"), "stale transition скрыл marker");
  delete state.questions[0].direction;
  refreshStale(context.currentText);
  await sleep(300);
  assert(!panel.classList.contains("hidden"), "откат direction восстановил exact fresh match");

  state.decision.outcomes[0].label = "B";
  refreshStale(context.currentText);
  await sleep(300);
  assert(panel.classList.contains("hidden"), "label-only edit тоже скрыл marker");
  state.decision.outcomes[0].label = "A";
  refreshStale(context.currentText);
  await sleep(300);
  assert(!panel.classList.contains("hidden"), "откат label восстановил marker");

  document.getElementById("context-input").value = "изменённый материал";
  emit("context");
  await sleep(300);
  assert(panel.classList.contains("hidden"), "после edit false positive отсутствует");
});

test("already_run: batch file/model links, ordered files/images и безопасная очистка provenance", async () => {
  installDom(); await resetState(); domBatch(); domToolbar(); batch.initBatch({});
  state.models = [{ key: "mA", label: "A", status: "running", vision: true }];
  state.selectedModels = new Set(["mA"]);
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no" }];
  batch.loadPresetFiles([{ name: "a.txt", content: "A", images: ["data:image/png;base64,QUJD"] }]);
  const descriptor = await alreadyRun.currentBatchDescriptor();
  const fileId = state.batch.files[0].id;
  state.batch.results = { [fileId]: { mA: { ok: true } } };
  state.batch.runIds = { [fileId]: { mA: ID_A } };
  state.batch.resultsMeta = { latestRun: ID_A, runs: { [ID_A]: runRecord(descriptor) } };
  assert(alreadyRun.matchBatchAlreadyRun(descriptor), "batch exact match с изображением");
  state.batch.resultsStale = true;
  assert(!alreadyRun.matchBatchAlreadyRun(descriptor), "stale batch не отмечается даже при exact fingerprints");
  state.batch.resultsStale = false;
  assert(!alreadyRun.matchBatchAlreadyRun({ ...descriptor, materialHashes: ["sha256:image-edit"] }), "image edit учитывается");
  state.batch.runIds[fileId].mA = ID_B;
  assert(!alreadyRun.matchBatchAlreadyRun(descriptor), "чужой file/model link не совпадает");

  const cleaned = alreadyRun.cleanProvenance({
    latestRun: "bad", runs: {
      bad: { runId: "bad" },
      [ID_A]: { ...runRecord(descriptor), status: "completed" },
    },
  });
  eq(Object.keys(cleaned.runs).join(","), ID_A, "malformed runs отброшены");
  eq(cleaned.latestRun, undefined, "malformed latestRun отброшен");
  eq(Object.keys(alreadyRun.cleanRunIds({ f: { mA: "bad", mB: ID_B } }).f).join(","), "mB",
    "malformed links отброшены");
});
