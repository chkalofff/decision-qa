// Per-tab state: snapshots, dirty tracking, reset и восстановление полного workspace.

import {
  test, assert, eq, installDom, resetState, domApp, domContext, domQuestions, domBatch, domToolbar,
  state, questions, context, batch, persist,
} from "./harness.mjs";

test("persist: snapshot и dirty tracking без localStorage-документа", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domToolbar();
  context.initContext({}); batch.initBatch({}); localStorage.clear();
  persist.activateDocument(); persist.initPersist();
  context.setContent("текст материала", "text");
  state.results = { results: { mA: { ok: true } }, order: ["mA"], runMode: "decisions", questions: [], marks: [{ id: "m_1" }] };
  batch.loadPresetFiles([{ name: "a.txt", content: "файл" }]);
  const fid = state.batch.files[0].id;
  state.batch.results[fid] = { mA: { ok: true } };
  state.batch.marks = [{ id: "m_2" }];
  const data = persist.workspaceSnapshot();
  eq(data.input, "текст материала", "контекст в снапшоте");
  eq(data.results.marks[0].id, "m_1", "single marks в снапшоте");
  eq(data.batchResults.results[fid].mA.ok, true, "batch results в снапшоте");
  eq(data.batchResults.marks[0].id, "m_2", "batch marks в снапшоте");
  eq(persist.currentDocument().dirty, true, "правка отметила dirty");
  eq(localStorage.getItem("dq-workspace"), null, "автосохранения нет");

  persist.pausePersist();
  context.setContent("тур", "text");
  assert(!persist.currentDocument().dirty || persist.currentDocument().status === "dirty", "пауза не вызывает запись");
  eq(localStorage.getItem("dq-workspace"), null, "во время тура тоже нет записи");
  persist.resumePersist();
});

test("persist: resetDocumentState полностью очищает документ и batch running/cancelled", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domToolbar();
  context.initContext({}); batch.initBatch({});
  context.setContent("материал", "text");
  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }];
  questions.setQuestions([{ id: "q1", question: "Q?", type: "yes_no" }]);
  state.decision = { enabled: true, outcomes: [{ id: "o1", label: "A", color: "green", rules: [] }] };
  state.results = { results: { mA: { ok: true } }, order: ["mA"], runMode: "decisions", questions: [], marks: [] };
  state.resultsMeta = { fingerprint: "single" };
  state.resultsStale = true;
  batch.loadPresetFiles([{ name: "a.txt", content: "A" }]);
  const fid = state.batch.files[0].id;
  state.batch.results[fid] = { mA: { ok: true } };
  state.batch.durations[fid] = 2;
  state.batch.resultsMeta = { fingerprint: "batch" };
  state.batch.resultsStale = true;
  state.batch.decision = { enabled: true, outcomes: [{ id: "o1", label: "A", rules: [] }] };
  state.batch.questions = [{ id: "q1", question: "Q?", type: "yes_no" }];
  state.batch.marks = [{ id: "m1", target: { scope: "batch", file: fid }, verdict: "accept" }];
  state.batch.running = true;
  state.batch.cancelled = true;
  state.batch.startedAt = 10;
  state.batch.finishedAt = 20;
  document.getElementById("btn-batch-cancel").classList.remove("hidden");
  document.getElementById("batch-progress-wrap").classList.remove("hidden");
  document.getElementById("batch-progress").textContent = "обработано 1 из 1";

  persist.resetDocumentState();

  eq(context.currentText(), "", "контекст очищен");
  eq(state.contextImages.length, 0, "изображения очищены");
  eq(state.questions.length, 0, "вопросы очищены");
  eq(state.decision.outcomes.length, 0, "решение очищено");
  eq(state.results, null, "single results очищены");
  eq(state.resultsMeta, null, "single meta очищена");
  eq(state.resultsStale, false, "single stale сброшен");
  eq(state.batch.files.length, 0, "batch files очищены");
  eq(Object.keys(state.batch.results).length, 0, "batch results очищены");
  eq(Object.keys(state.batch.durations).length, 0, "durations очищены");
  eq(state.batch.resultsMeta, null, "batch meta очищена");
  eq(state.batch.resultsStale, false, "batch stale сброшен");
  eq(state.batch.decision, null, "batch decision очищен");
  eq(state.batch.questions, null, "batch questions очищены");
  eq(state.batch.marks.length, 0, "batch marks очищены");
  eq(state.batch.running, false, "running сброшен");
  eq(state.batch.cancelled, false, "cancelled сброшен");
  eq(state.batch.startedAt, null, "startedAt очищен");
  eq(state.batch.finishedAt, null, "finishedAt очищен");
  assert(document.getElementById("btn-batch-clear").disabled, "очистка пустого пакета disabled");
  assert(document.getElementById("btn-batch-cancel").classList.contains("hidden"), "cancel скрыт");
  assert(document.getElementById("batch-progress-wrap").classList.contains("hidden"), "прогресс скрыт");
  eq(document.getElementById("batch-progress").textContent, "", "текст прогресса очищен");
});

test("persist: restoreDocumentData восстанавливает результаты, разметку и batch remap", async () => {
  installDom(); await resetState(); domApp();
  context.initContext({}); batch.initBatch({});
  const runId = "run_" + "c".repeat(32);
  const data = {
    input_format: "text", input: "материал", questions: [], decision: null, pageMode: "single",
    batchFiles: [{ name: "a.txt", content: "A" }, { name: "b.txt", content: "B" }],
    results: {
      results: { mA: { ok: true, answers: {}, usage: {}, metrics: {} } }, order: ["mA"], runMode: "decisions", questions: [],
      runIds: { mA: { decisions: runId } },
      marks: [{ id: "m_1", target: { scope: "single", model: "mA", mode: "decisions", question: "q1" }, verdict: "reject", comment: "плохо", criterion: "correctness", author: "local", created_at: "t", updated_at: "t" }],
    },
    resultsMeta: {
      fingerprint: "fp-single", latestRun: runId,
      runs: { [runId]: {
        runId, status: "completed", configFingerprint: "sha256:config",
        materialsFingerprint: "sha256:materials", materialHashes: ["sha256:one", "sha256:two"],
      } },
    },
    batchResults: {
      files: ["f1", "f2"],
      results: { f2: { mA: { ok: true, metrics: { duration_s: 2 } } }, f1: { mA: { ok: true, metrics: { duration_s: 1 } } } },
      runIds: { f2: { mA: runId }, f1: { mA: runId } },
      durations: { f2: 22, f1: 11 }, decision: null, questions: [],
      marks: [{ id: "m_2", target: { scope: "batch", file: "f2", question: "q1", model: "mA" }, verdict: "accept", comment: "", created_at: "t", updated_at: "t" }],
      resultsMeta: { fingerprint: "fp-batch", runMode: "decisions", temperature: 0.4 },
    },
  };
  persist.resetDocumentState();
  const page = persist.restoreDocumentData(data);
  eq(page, "single", "страница восстановлена");
  eq(state.results.marks[0].id, "m_1", "single marks восстановлены");
  eq(state.resultsMeta.latestRun, runId, "single provenance восстановлена");
  eq(state.resultsStale, false, "single stale не выставлен");
  const [newF1, newF2] = state.batch.files;
  eq(state.batch.results[newF1.id].mA.metrics.duration_s, 1, "f1 по id");
  eq(state.batch.results[newF2.id].mA.metrics.duration_s, 2, "f2 по id");
  eq(state.batch.runIds[newF1.id].mA, runId, "batch provenance remap");
  eq(state.batch.durations[newF2.id], 22, "duration remap");
  eq(state.batch.marks[0].target.file, newF2.id, "mark file remap");
  eq(state.batch.resultsMeta.fingerprint, "fp-batch", "batch resultsMeta адаптирован");
  eq(state.batch.resultsMeta.temperature, 0.4, "batch temperature восстановлена");
  eq(state.batch.resultsStale, false, "batch stale не выставлен");
});
