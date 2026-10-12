// Доменные тесты: saveas (диалог «Сохранить как…»). Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, installDom, resetState, domContext, domQuestions, domBatch, domToolbar,
  state, questions, context, batch, saveas,
} from "./harness.mjs";
import { setDecision } from "../static/decision.js";

// ================================================================ saveas

test("saveas: buildSessionData — составы без решений / с решениями / с результатами", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domToolbar();
  context.initContext({});
  batch.initBatch({});
  context.setContent("текст материала", "text");
  questions.setQuestions([{ id: "q1", question: "Q?", type: "yes_no", direction: "yes" }]);
  setDecision({ enabled: true, outcomes: [{ id: "ok", label: "Ок", color: "green", isDefault: true, rules: [], collapsed: false }] });
  batch.loadPresetFiles([{ name: "a.txt", content: "x" }]);

  // только вопросы — массив (совместимо со старым экспортом вопросов)
  const qOnly = saveas.buildSessionData("questions", false);
  assert(Array.isArray(qOnly), "только вопросы → массив");
  eq(qOnly[0].direction, "yes", "direction в вопросах");

  // материалы + вопросы — без decision
  const mat = saveas.buildSessionData("materials", false);
  eq(mat.input, "текст материала", "контекст включён");
  eq(mat.questions.length, 1, "вопросы включены");
  assert(!("decision" in mat), "без правил решений");
  eq(mat.batch_files.length, 1, "batch_files включены");

  // full (дефолт) — с правилами решения, без UI-состояния
  const full = saveas.buildSessionData("full", false);
  eq(full.decision.outcomes[0].label, "Ок", "decision включён");
  assert(!("collapsed" in full.decision.outcomes[0]), "collapsed вырезан");
  assert(!full.results && !full.batch_results, "без чекбокса результатов нет");

  // + результаты прогонов
  const fid = state.batch.files[0].id;
  state.results = { results: { mA: { ok: true } }, order: ["mA"], runMode: "decisions", questions: [] };
  state.resultsMeta = { fingerprint: "fp-single" };
  state.batch.results[fid] = { mA: { ok: true } };
  state.batch.durations[fid] = 1.5;
  state.batch.decision = { outcomes: [] };
  state.batch.resultsMeta = { fingerprint: "fp-batch" };
  const withRes = saveas.buildSessionData("full", true);
  eq(withRes.results.results.mA.ok, true, "результаты одиночного прогона");
  eq(withRes.results_meta.fingerprint, "fp-single", "fingerprint одиночного прогона");
  eq(withRes.batch_results.results[fid].mA.ok, true, "результаты пакета");
  eq(withRes.batch_results.durations[fid], 1.5, "durations пакета");
  eq(withRes.batch_results.files[0], fid, "id файлов для remap при импорте");
  eq(withRes.batch_results.results_meta.fingerprint, "fp-batch", "fingerprint пакета");
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
  eq(radios.length, 3, "три варианта состава");
  eq((radios.find(r => r.checked) || {}).value, "full", "дефолт — с правилами решений");

  // выбор «Только вопросы», имя без расширения → дописывается .json
  radios.forEach(r => { r.checked = r.value === "questions"; });
  document.getElementById("saveas-filename").value = "мой файл";
  document.getElementById("saveas-ok").fire("click");
  const a = globalThis.__clicks[globalThis.__clicks.length - 1];
  eq(a.download, "мой файл.json", ".json дописано");
  assert(Array.isArray(JSON.parse(captured)), "скачан состав «только вопросы»");
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
