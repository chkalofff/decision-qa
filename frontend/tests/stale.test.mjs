// Доменные тесты: stale (актуальность результатов) + fingerprint.
// Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, installDom, resetState,
  domResults, domQuestions, domBatch, domToolbar, state, questions, results, batch,
} from "./harness.mjs";
import { setDecision } from "../static/decision.js";
import { singleFingerprint, batchFingerprint } from "../static/fingerprint.js";
import { refreshStale, clearSingleResults, restoreSingleResults, restoreBatchResults } from "../static/stale.js";

// ================================================================ fingerprint

test("fingerprint: меняется при правке вопроса/контекста/решения/картинок, стабилен без правок", async () => {
  installDom(); await resetState(); domQuestions();
  questions.setQuestions([{ id: "q1", question: "Есть цифры?", type: "yes_no", direction: "yes" }]);
  setDecision({ outcomes: [{ id: "ok", label: "Ок", color: "green", isDefault: true, rules: [] }] });

  const base = singleFingerprint("текст материала");
  eq(singleFingerprint("текст материала"), base, "без правок — тот же хеш");
  // UI-состояние (collapsed) не влияет на fingerprint
  state.questions[0].collapsed = false;
  state.decision.outcomes[0].collapsed = true;
  eq(singleFingerprint("текст материала"), base, "collapsed не влияет");
  state.questions[0].collapsed = true;
  state.decision.outcomes[0].collapsed = false;

  state.questions[0].question = "Есть ли цифры?";
  assert(singleFingerprint("текст материала") !== base, "правка вопроса меняет хеш");
  state.questions[0].question = "Есть цифры?";
  eq(singleFingerprint("текст материала"), base, "откат вопроса возвращает хеш");

  assert(singleFingerprint("другой текст") !== base, "правка контекста меняет хеш");

  state.decision.outcomes[0].label = "Хорошо";
  assert(singleFingerprint("текст материала") !== base, "правка решения меняет хеш");
  state.decision.outcomes[0].label = "Ок";
  eq(singleFingerprint("текст материала"), base, "откат решения возвращает хеш");

  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }];
  const withImg = singleFingerprint("текст материала");
  assert(withImg !== base, "изображение меняет хеш");
  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }];
  eq(singleFingerprint("текст материала"), withImg, "та же картинка — тот же хеш");
  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,RUVGR0VJRw==" }];
  assert(singleFingerprint("текст материала") !== withImg, "другой размер картинки меняет хеш");
  state.contextImages = [];

  state.questions[0].direction = "no";
  assert(singleFingerprint("текст материала") !== base, "direction влияет на хеш");
});

test("fingerprint: батч — файлы (порядок значим), вопросы и решение", async () => {
  installDom(); await resetState(); domBatch(); domToolbar(); // toolbar подписан на emit("batch") — нужны его элементы
  batch.loadPresetFiles([{ name: "a.txt", content: "текст" }, { name: "b.txt", content: "ещё" }]);
  questions.setQuestions([{ id: "q1", question: "Q?", type: "yes_no" }]);

  const base = batchFingerprint();
  eq(batchFingerprint(), base, "без правок — тот же хеш");

  state.questions[0].question = "Q2?";
  assert(batchFingerprint() !== base, "правка вопроса меняет хеш пакета");
  state.questions[0].question = "Q?";
  eq(batchFingerprint(), base, "откат возвращает хеш");

  // перестановка файлов меняет входные данные прогона
  const [f0] = state.batch.files.splice(0, 1);
  state.batch.files.push(f0);
  assert(batchFingerprint() !== base, "порядок файлов значим");
});

// ================================================================ stale-флаги

// Результаты-заглушка: один ok-прогон по вопросу q1.
function fakeSingleResults() {
  return {
    results: { mA: { ok: true, answers: { q1: { type: "yes_no", probabilities: { yes: 0.9, no: 0.1 } } }, usage: {}, metrics: {} } },
    order: ["mA"], runMode: "decisions",
    questions: [{ id: "q1", question: "Q?", type: "yes_no" }],
  };
}

test("stale: правка после прогона помечает результаты, откат снимает пометку; плашка в DOM", async () => {
  installDom(); await resetState(); domResults(); domQuestions();
  questions.setQuestions([{ id: "q1", question: "Q?", type: "yes_no" }]);
  const getText = () => document.getElementById("context-input")?.value ?? "текст";
  el_context("текст");

  // прогон: результаты + fingerprint на момент прогона
  state.results = fakeSingleResults();
  state.resultsMeta = { fingerprint: singleFingerprint("текст") };
  state.resultsStale = false;
  results.renderResults();
  assert(!document.getElementById("results-stale"), "плашки нет после свежего прогона");

  // правка вопроса → stale + плашка
  state.questions[0].question = "Другой?";
  refreshStale(getText);
  eq(state.resultsStale, true, "stale выставлен");
  const plaque = document.getElementById("results-stale");
  assert(plaque, "плашка отрисована");
  includes(plaque.textContent, "неактуальн", "текст плашки");

  // откат правки → пометка снята, плашка убрана
  state.questions[0].question = "Q?";
  refreshStale(getText);
  eq(state.resultsStale, false, "stale снят после отката");
  assert(!document.getElementById("results-stale"), "плашка убрана");

  // правка контекста → stale
  el_context("изменённый текст");
  refreshStale(getText);
  eq(state.resultsStale, true, "правка контекста помечает stale");
});

// Текст контекста в тестах — через textarea (JSON-режим без CodeMirror).
function el_context(text) {
  let ta = document.getElementById("context-input");
  if (!ta) {
    ta = document.createElement("textarea");
    ta.id = "context-input";
    document.body.appendChild(ta);
  }
  ta.value = text;
}

test("stale: clearSingleResults очищает результаты, мету и плашку", async () => {
  installDom(); await resetState(); domResults(); domQuestions();
  state.results = fakeSingleResults();
  state.resultsMeta = { fingerprint: singleFingerprint("") };
  state.resultsStale = true;
  results.renderResults();
  assert(document.getElementById("results-stale"), "плашка была");
  clearSingleResults();
  eq(state.results, null, "результаты очищены");
  eq(state.resultsMeta, null, "мета очищена");
  eq(state.resultsStale, false, "stale сброшен");
  assert(!document.getElementById("results-stale"), "плашка убрана");
  includes(document.getElementById("results-list").textContent, "Запустите прогон", "пустое состояние");
});

test("stale: восстановление разметки из снапшота — remap fileId, marks_version, замещение, снапшот вопросов", async () => {
  installDom(); await resetState(); domResults(); domQuestions(); domBatch(); domToolbar(); // toolbar подписан на emit("batch")
  questions.setQuestions([{ id: "q1", question: "Q?", type: "yes_no" }]);
  batch.loadPresetFiles([{ name: "a.txt", content: "текст" }]);
  const f = state.batch.files[0];

  // одиночный: marks из файла замещают текущие; битые записи отбрасываются
  state.results = { results: {}, order: [], runMode: "decisions", questions: [],
    marks: [{ id: "m_old", target: { scope: "single", model: "gone", mode: "decisions" }, verdict: "accept" }] };
  const resWithMarks = {
    results: { mA: { ok: true, answers: { q1: { type: "yes_no", probabilities: { yes: 0.9, no: 0.1 } } }, usage: {}, metrics: {} } },
    order: ["mA"], runMode: "decisions",
    questions: [{ id: "q1", question: "Q?", type: "yes_no" }],
    marks: [
      { id: "m_1", target: { scope: "single", model: "mA", mode: "decisions", question: "q1" }, verdict: "reject", comment: "ошибка" },
      { target: { scope: "single" }, verdict: "bogus" }, // битая — пропускается
    ],
    marks_version: 1,
  };
  restoreSingleResults(resWithMarks, { fingerprint: "fp" }, () => "текст");
  eq(state.results.marks.length, 1, "только валидная пометка");
  eq(state.results.marks[0].verdict, "reject", "замещение, не мердж");
  eq(state.results.marks[0].comment, "ошибка");
  // marks_version из будущего — разметка пропускается
  restoreSingleResults({ ...resWithMarks, marks_version: 2 }, { fingerprint: "fp" }, () => "текст");
  eq(state.results.marks.length, 0, "marks_version > 1 — разметка не загружена");
  // файла без marks — пустой массив (замещение)
  restoreSingleResults({ results: {}, order: [], runMode: "decisions", questions: [] }, { fingerprint: "fp" }, () => "текст");
  assert(Array.isArray(state.results.marks) && state.results.marks.length === 0, "без marks — []");

  // пакет: target.file перекодируется по br.files; пометка файла вне remap отбрасывается;
  // снапшот вопросов восстанавливается
  restoreBatchResults({
    files: ["f_old"],
    results: { f_old: { mA: { ok: true, answers: { q1: { type: "yes_no", probabilities: { yes: 0.8, no: 0.2 } } }, usage: {}, metrics: {} } } },
    durations: {},
    decision: null,
    questions: [{ id: "q1", question: "Q? (снапшот)", type: "yes_no", direction: "no" }],
    marks: [
      { id: "m_b1", target: { scope: "batch", file: "f_old", question: "q1", model: "mA" }, verdict: "reject", comment: "" },
      { id: "m_b2", target: { scope: "batch", file: "f_other", question: "q1", model: "mA" }, verdict: "accept", comment: "" },
      { id: "m_b3", target: { scope: "batch", model: "mA" }, verdict: "unsure", comment: "по модели" },
    ],
    marks_version: 1,
  });
  eq(state.batch.marks.length, 2, "пометка файла вне remap отброшена");
  eq(state.batch.marks[0].target.file, f.id, "target.file перекодирован на новый id");
  eq(state.batch.marks[1].verdict, "unsure", "пометка уровня модели без file — без remap");
  assert(state.batch.questions, "снапшот вопросов восстановлен");
  eq(state.batch.questions[0].question, "Q? (снапшот)");
  eq(state.batch.questions[0].direction, "no", "direction из снапшота");
  // битый снапшот вопросов — фолбэк на живые вопросы, renderBatchResults не падает
  restoreBatchResults({ files: ["f_old"], results: {}, questions: [{ nope: true }], marks: [] });
  eq(state.batch.questions, null, "битый снапшот вопросов → живой редактор");
  // marks_version пакета из будущего — пометки пропущены
  restoreBatchResults({ files: ["f_old"], results: {}, marks: [{ id: "m_x", target: { scope: "batch", model: "mA" }, verdict: "accept" }], marks_version: 2 });
  eq(state.batch.marks.length, 0, "marks_version пакета > 1 — пропуск");
});

test("stale: восстановление результатов из снапшота сессии — без stale, fingerprint из файла", async () => {
  installDom(); await resetState(); domResults(); domQuestions(); domBatch(); domToolbar(); // toolbar подписан на emit("batch")
  questions.setQuestions([{ id: "q1", question: "Q?", type: "yes_no" }]);
  batch.loadPresetFiles([{ name: "a.txt", content: "текст" }]);

  // пакет: id файлов при импорте новые — remap по br.files
  restoreBatchResults({
    files: ["f_old"],
    results: { f_old: { mA: { ok: true, answers: { q1: { type: "yes_no", probabilities: { yes: 0.8, no: 0.2 } } }, usage: {}, metrics: {} } } },
    durations: { f_old: 2 },
    decision: null,
    results_meta: { fingerprint: "batch-fp" },
  });
  const f = state.batch.files[0];
  eq(f.status, "ok", "файл с результатами помечен обработанным");
  assert(state.batch.results[f.id], "результаты remap'нуты на новый id");
  eq(state.batch.durations[f.id], 2, "durations remap'нуты");
  eq(state.batch.resultsMeta.fingerprint, "batch-fp", "fingerprint пакета из файла");
  eq(state.batch.resultsStale, false, "stale пакета не выставлен");
  assert(!document.getElementById("batch-results").querySelector(".stale-banner"), "плашки пакета нет");

  // одиночный режим: fingerprint из файла
  restoreSingleResults(fakeSingleResults(), { fingerprint: "fp-x" }, () => "текст");
  eq(state.resultsMeta.fingerprint, "fp-x", "fingerprint из файла");
  eq(state.resultsStale, false, "stale не выставлен");
  assert(!document.getElementById("results-stale"), "плашки нет");
  // без меты в файле — fingerprint вычисляется заново по применённым входным
  restoreSingleResults(fakeSingleResults(), null, () => "текст");
  eq(state.resultsMeta.fingerprint, singleFingerprint("текст"), "fingerprint вычислен заново");
  eq(state.resultsStale, false, "и не stale");
  // правка после восстановления помечает stale относительно восстановленного fingerprint
  state.questions[0].question = "Другой?";
  refreshStale(() => "текст");
  eq(state.resultsStale, true, "правка после восстановления → stale");
});

test("stale: батч — правка вопросов помечает результаты пакета, плашка над таблицей", async () => {
  installDom(); await resetState(); domBatch(); domQuestions(); domToolbar(); // toolbar подписан на emit("batch")
  questions.setQuestions([{ id: "q1", question: "Q?", type: "yes_no" }]);
  batch.loadPresetFiles([{ name: "a.txt", content: "текст" }]);
  const f = state.batch.files[0];
  f.status = "ok";
  state.batch.results[f.id] = { mA: { ok: true, answers: { q1: { type: "yes_no", probabilities: { yes: 0.8, no: 0.2 } } }, usage: {}, metrics: {} } };
  state.batch.resultsMeta = { fingerprint: batchFingerprint() };
  state.batch.resultsStale = false;
  batch.renderBatchResults();
  assert(!document.getElementById("batch-results").querySelector(".stale-banner"), "плашки нет после свежего прогона");

  state.questions[0].question = "Другой?";
  refreshStale(() => "");
  eq(state.batch.resultsStale, true, "stale пакета выставлен");
  const plaque = document.getElementById("batch-results").querySelector(".stale-banner");
  assert(plaque, "плашка пакета отрисована");
  includes(plaque.textContent, "неактуальн", "текст плашки пакета");

  // загрузка нового пакета очищает результаты и stale
  batch.loadPresetFiles([{ name: "c.txt", content: "новый" }]);
  eq(Object.keys(state.batch.results).length, 0, "результаты пакета очищены");
  eq(state.batch.resultsMeta, null, "мета пакета очищена");
  eq(state.batch.resultsStale, false, "stale пакета сброшен");
  assert(!document.getElementById("batch-results").querySelector(".stale-banner"), "плашки нет после загрузки пакета");
});
