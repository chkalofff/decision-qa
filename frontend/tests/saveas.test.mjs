// Доменные тесты: saveas (диалог «Экспорт данных»). Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, installDom, resetState, sleep, restoreGlobalProperty, domContext, domQuestions, domBatch, domToolbar,
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
  eq(cli.config.fingerprint, full.config.fingerprint, "CLI и полный документ имеют одинаковый semantic fingerprint");
  assert(!cli.config.ui, "document-only UI state не попадает в CLI");
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
  includes(dlg.textContent, "Экспорт данных", "диалог называется экспортом");
  eq(document.getElementById("saveas-ok").textContent, "Экспортировать", "основное действие — экспорт");
  eq(document.getElementById("saveas-filename").value, "session", "пустой контекст → session");
  const radios = dlg.querySelectorAll("input").filter(i => i.name === "saveas-scope");
  eq(radios.length, 4, "четыре состава в одном диалоге");
  eq((radios.find(r => r.checked) || {}).value, "full", "дефолт — с правилами решений");

  const resultsCb = document.getElementById("saveas-with-results");
  const marksCb = document.getElementById("saveas-with-marks");
  eq(resultsCb.checked && resultsCb.disabled, true, "полный документ обязательно содержит результаты");
  eq(marksCb.checked && marksCb.disabled, true, "полный документ обязательно содержит разметку");

  // Для частичной копии разметка зависит от результатов.
  radios.forEach(r => { r.checked = r.value === "materials"; });
  radios.find(r => r.checked).fire("change");
  eq(resultsCb.disabled, false, "для частичной копии результаты можно выбрать");
  resultsCb.checked = true;
  resultsCb.fire("change");
  eq(marksCb.disabled, false, "enabled вместе с результатами");
  resultsCb.checked = false;
  resultsCb.fire("change");
  eq(marksCb.disabled, true, "снова disabled");

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

test("saveas: CLI — POSIX/Windows команда, синхронизация filename и clipboard fallback", async () => {
  const posix = saveas.buildCliCommand({ filename: "мой файл", server: "http://dqa.local:8000", threads: 4 });
  assert(posix.includes("'cli/bin/dqa' run 'путь/к/материалам'"), "POSIX shim и входной placeholder");
  assert(posix.includes("--config 'мой файл.json'"), "POSIX quoting и .json");
  assert(posix.includes("--server 'http://dqa.local:8000' --threads 4"), "origin и threads");
  const quoted = saveas.buildCliCommand({ filename: "отчёт'1" });
  assert(quoted.includes("'отчёт'\\''1.json'"), "одиночная кавычка экранирована для shell");
  const windows = saveas.buildCliCommand({ platform: "windows", filename: 'мой "файл', server: "http://server/100%" });
  assert(windows.includes('"cli\\bin\\dqa.cmd"'), "Windows shim");
  assert(windows.includes('"путь\\к\\материалам"'), "Windows input placeholder");
  assert(windows.includes('100%%'), "percent экранирован для cmd");
  assert(windows.includes('мой \\"файл.json'), "кавычка в имени экранирована");

  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domToolbar();
  context.initContext({});
  batch.initBatch({});
  questions.setQuestions([{ question: "Q?", type: "yes_no" }]);
  state.threads = 3;
  globalThis.location = { origin: "http://localhost:8765" };
  let copied = null;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    clipboard: { writeText: async value => { copied = value; } },
  } });
  try {
    saveas.openSaveAsDialog({ onError: message => { throw new Error(message); } });
    const scopeRadios = [...document.querySelectorAll("input")].filter(input => input.name === "saveas-scope");
    const cliDetails = document.getElementById("saveas-cli");
    eq(cliDetails.open, false, "CLI — необязательный свёрнутый блок");
    scopeRadios.forEach(input => { input.checked = input.value === "questions"; });
    const radio = scopeRadios.find(input => input.checked);
    radio.fire("change");
    cliDetails.open = true;
    const command = document.getElementById("saveas-cli-command");
    includes(cliDetails.textContent, "Без правил решений", "объяснён запуск CLI только с вопросами");
    includes(cliDetails.textContent, "Материалы из файла не используются", "явно описан внешний источник материалов");
    assert(command.value.includes("--threads 3"), "текущие threads в команде");
    assert(command.value.includes("http://localhost:8765"), "текущий origin в команде");
    assert(document.getElementById("saveas-with-results").classList.contains("hidden") ||
      document.getElementById("saveas-with-results").disabled, "результаты не предлагаются для состава без материалов");
    includes(cliDetails.textContent, "пути", "дисклеймер о корректировке путей");

    const name = document.getElementById("saveas-filename");
    name.value = "новый конфиг";
    name.fire("input");
    assert(command.value.includes("новый конфиг.json"), "команда следует за filename");
    document.querySelector(".saveas-cli-platform[data-platform=windows]").fire("click");
    assert(command.value.includes("dqa.cmd"), "переключение ОС меняет команду");
    document.getElementById("saveas-cli-copy").fire("click");
    await sleep(10);
    eq(copied, command.value, "кнопка копирует актуальную команду");
    eq(document.getElementById("saveas-cli-copy-status").textContent, "Скопировано", "успешное копирование подтверждено");

    globalThis.navigator.clipboard.writeText = async () => { throw new Error("denied"); };
    document.getElementById("saveas-cli-copy").fire("click");
    await sleep(10);
    includes(document.getElementById("saveas-cli-copy-status").textContent, "Ctrl/Cmd+C", "fallback предлагает ручное копирование");
  } finally {
    restoreGlobalProperty("navigator", oldNavigator);
  }
});
