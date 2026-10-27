// Доменные тесты: saveas (диалог «Сохранить как…»). Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, installDom, resetState, sleep, domContext, domQuestions, domBatch, domToolbar,
  state, questions, context, batch, saveas,
} from "./harness.mjs";
import { setDecision } from "../static/decision.js";

// ================================================================ saveas

test("saveas: единый контейнер — scope, материалы, результаты и стабильные hashes", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domToolbar();
  context.initContext({});
  batch.initBatch({});
  state.models = [{ key: "mA", label: "A", status: "running", api: "sglang" }];
  state.selectedModels = new Set(["mA"]);
  context.setContent("текст материала", "text");
  questions.setQuestions([{ id: "q1", question: "Q?", type: "yes_no", direction: "yes" }]);
  setDecision({ enabled: true, outcomes: [{ id: "ok", label: "Ок", color: "green", isDefault: true, rules: [], collapsed: false }] });
  batch.loadPresetFiles([{ name: "a.txt", content: "x" }]);

  const qOnly = await saveas.buildExportDocument("questions", false);
  eq(qOnly.format, "decision-qa-document", "единый marker");
  eq(qOnly.scope, "questions", "scope частичного импорта");
  eq(qOnly.config.questions[0].direction, "yes", "direction в вопросах");
  assert(!qOnly.materials && !qOnly.results, "только конфигурация без materials/results");

  const mat = await saveas.buildExportDocument("materials", false);
  eq(mat.materials.input, "текст материала", "контекст включён");
  eq(mat.config.questions.length, 1, "вопросы включены");
  eq(mat.config.decision.outcomes.length, 0, "состав без правил");
  eq(mat.materials.batch_files.length, 1, "batch_files включены");

  const full = await saveas.buildExportDocument("full", false);
  eq(full.config.decision.outcomes[0].label, "Ок", "decision включён");
  assert(!("collapsed" in full.config.decision.outcomes[0]), "collapsed вырезан");
  assert(!full.results, "без чекбокса результатов нет");

  const fid = state.batch.files[0].id;
  const runId = "run_" + "d".repeat(32);
  state.results = { results: { mA: { ok: true } }, order: ["mA"], runMode: "decisions", questions: [],
    runIds: { mA: { decisions: runId } } };
  state.resultsMeta = { fingerprint: "fp-single", latestRun: runId, runs: {} };
  state.batch.results[fid] = { mA: { ok: true } };
  state.batch.runIds[fid] = { mA: runId };
  state.batch.durations[fid] = 1.5;
  state.batch.decision = { outcomes: [] };
  state.batch.resultsMeta = { fingerprint: "fp-batch" };
  state.results.marks = [{ id: "m_1", target: { scope: "single", model: "mA", mode: "decisions", question: "q1" }, verdict: "reject", comment: "плохо", criterion: "correctness", author: "local", created_at: "t", updated_at: "t" }];
  state.batch.marks = [{ id: "m_2", target: { scope: "batch", file: fid, question: "q1", model: "mA" }, verdict: "accept", comment: "", criterion: "correctness", author: "local", created_at: "t", updated_at: "t" }];
  state.batch.questions = [{ id: "q1", question: "Q?", type: "yes_no", direction: "yes" }];
  const withRes = await saveas.buildExportDocument("full", true);
  eq(withRes.results.results.results.mA.ok, true, "результаты одиночного прогона");
  eq(withRes.results.results_meta.fingerprint, "fp-single", "fingerprint одиночного прогона");
  eq(withRes.results.results.runIds.mA.decisions, runId, "single provenance в экспорте");
  eq(withRes.results.results_meta.latestRun, runId, "latestRun в экспорте");
  eq(withRes.results.batch_results.results[fid].mA.ok, true, "результаты пакета");
  eq(withRes.results.batch_results.runIds[fid].mA, runId, "batch provenance в экспорте");
  eq(withRes.results.batch_results.durations[fid], 1.5, "durations пакета");
  eq(withRes.results.batch_results.files[0], fid, "id файлов для remap при импорте");
  eq(withRes.results.batch_results.results_meta.fingerprint, "fp-batch", "fingerprint пакета");
  eq(withRes.results.results.marks[0].verdict, "reject", "разметка одиночного прогона в файле");
  eq(withRes.results.batch_results.marks[0].target.file, fid, "разметка пакета со старым id файла");
  eq(withRes.results.batch_results.questions[0].direction, "yes", "снапшот вопросов пакета в файле");
  eq(withRes.config.hash, full.config.hash, "materials/results не меняют config hash");
  eq(withRes.config.fingerprint, full.config.fingerprint, "materials/results не меняют fingerprint");

  const noMarks = await saveas.buildExportDocument("full", true, false);
  eq(noMarks.results.results.marks.length, 0, "без галочки — marks одиночного пустые");
  eq(noMarks.results.results.marks_version, 1, "marks_version на месте");
  eq(noMarks.results.batch_results.marks.length, 0, "без галочки — marks пакета пустые");
  const withMarks = await saveas.buildExportDocument("full", true, true);
  eq(withMarks.results.results.marks[0].verdict, "reject", "с галочкой — marks одиночного на месте");
  eq(withMarks.results.batch_results.marks[0].target.file, fid, "с галочкой — marks пакета на месте");
  const cli = await saveas.buildExportDocument("cli", false);
  eq(cli.config.settings.models.join(","), "mA", "CLI содержит выбранные модели");
  eq(cli.config.hash, full.config.hash, "CLI — та же конфигурация без materials/results");
  assert(!cli.materials && !cli.results, "CLI не содержит materials/results");
});

test("saveas: диалог — дефолтный состав «полный», имя файла, скачивание, отмена", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domToolbar();
  context.initContext({});
  batch.initBatch({});
  context.setContent("", "text");
  questions.setQuestions([{ question: "Q?", type: "yes_no" }]);
  let captured = null;
  globalThis.URL.createObjectURL = (blob) => { captured = blob.content; return "blob:x"; };

  saveas.openSaveAsDialog({ onError: (m) => { throw new Error(m); } });
  const dlg = document.getElementById("saveas-dialog");
  assert(dlg, "диалог открыт");
  eq(document.getElementById("saveas-filename").value, "session", "пустой контекст → session");
  const radios = dlg.querySelectorAll("input").filter(i => i.name === "saveas-scope");
  eq(radios.length, 4, "три документных состава и CLI в одном диалоге");
  eq((radios.find(r => r.checked) || {}).value, "full", "дефолт — с правилами решений");

  // зависимая галочка разметки: выключена и disabled без результатов
  const resultsCb = document.getElementById("saveas-with-results");
  const marksCb = document.getElementById("saveas-with-marks");
  eq(marksCb.checked, true, "разметка включена по умолчанию");
  eq(marksCb.disabled, true, "disabled без галочки результатов");
  resultsCb.checked = true;
  resultsCb.fire("change");
  eq(marksCb.disabled, false, "enabled вместе с результатами");
  resultsCb.checked = false;
  resultsCb.fire("change");
  eq(marksCb.disabled, true, "снова disabled");
  eq(marksCb.checked, true, "состояние галочки сохраняется");

  // выбор «Только вопросы», имя без расширения → дописывается .json
  radios.forEach(r => { r.checked = r.value === "questions"; });
  radios.find(r => r.checked).fire("change");
  assert(resultsCb.disabled, "для только вопросов результаты не предлагаются");
  document.getElementById("saveas-filename").value = "мой файл";
  document.getElementById("saveas-ok").fire("click");
  await sleep(10);
  const a = globalThis.__clicks[globalThis.__clicks.length - 1];
  eq(a.download, "мой файл.json", ".json дописано");
  eq(JSON.parse(captured).scope, "questions", "скачан единый контейнер состава «только вопросы»");
  assert(!document.getElementById("saveas-dialog"), "диалог закрыт после сохранения");

  // имя по умолчанию из контекста + отмена ничего не скачивает
  context.setContent("Проверка объявления на спам", "text");
  saveas.openSaveAsDialog({ onError: () => {} });
  eq(document.getElementById("saveas-filename").value, "проверка-объявления-на-спам", "имя из первых слов контекста");
  captured = null;
  document.getElementById("saveas-cancel").fire("click");
  eq(captured, null, "отмена не скачивает");
  assert(!document.getElementById("saveas-dialog"), "диалог закрыт отменой");
});
