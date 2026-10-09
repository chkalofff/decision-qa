// Доменные тесты: results. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, notIncludes, installDom, resetState, domResults, ansYesNo, runRes, setupBothResults, state, results, questions,
} from "./harness.mjs";

// ================================================================ results

test("results: режим «Оба» — flattenRuns, раздельные чипы метрик, чип согласия", async () => {
  installDom(); await resetState(); domResults();
  setupBothResults();
  const runs = results.flattenRuns();
  eq(runs.length, 2, "два прогона");
  eq(runs[0].mode, "decisions");
  eq(runs[1].mode, "fast_batch");
  results.renderResults();
  const chips = document.getElementById("run-chips").children;
  eq(chips.length, 2, "два чипа");
  includes(chips[0].textContent, "обычный", "чип 1 — обычный");
  includes(chips[0].textContent, "30.0 с", "чип 1 — своё время");
  includes(chips[1].textContent, "быстрый режим", "чип 2 — быстрый");
  includes(chips[1].textContent, "2.0 с", "чип 2 — своё время");
  includes(chips[1].textContent, "260 ток/с", "чип 2 — своя скорость");
  notIncludes(chips[1].textContent, "30.0 с", "чип 2 без чужого времени");
  const agree = document.getElementById("results-agree");
  assert(!agree.classList.contains("hidden"), "чип согласия виден");
  includes(agree.textContent, "сошлись по 1 из 1", "текст согласия");
});

test("results: режим A — строка содержит ответ именно своего вопроса", async () => {
  installDom(); await resetState(); domResults();
  const qs = [
    { id: "q1", question: "Вопрос один?", type: "yes_no" },
    { id: "q2", question: "Вопрос два?", type: "choice", options: [{ name: "вариант Б" }, { name: "вариант А" }] },
  ];
  state.models = [{ key: "mA", label: "Qwen A", status: "running" }];
  state.results = {
    results: {
      mA: runRes({ duration_s: 5, prompt_tokens: 100, prefill_tok_s: 20 }, {
        q1: ansYesNo(0.9, 0.1),
        q2: { type: "choice", choice: "вариант Б", probabilities: { "вариант А": 0.1, "вариант Б": 0.85 }, label_mass: 0.95 },
      }),
    },
    order: ["mA"], runMode: "decisions", questions: qs,
  };
  results.renderResults();
  const rows = document.getElementById("results-list").children;
  eq(rows.length, 2, "две строки");
  includes(rows[0].textContent, "да · 90%", "строка 1 — ответ вопроса 1");
  notIncludes(rows[0].textContent, "вариант Б", "строка 1 без ответа вопроса 2");
  includes(rows[1].textContent, "вариант Б · 85%", "строка 2 — ответ вопроса 2");
});

test("results: режим B — тултип распределения; перерендер скрывает висящий тултип", async () => {
  installDom(); await resetState(); domResults();
  setupBothResults();
  results.renderResults();
  const row = document.getElementById("results-list").children[0];
  const cells = row.querySelectorAll(".res-cell");
  eq(cells.length, 2, "две ячейки");
  cells[1].fire("mouseenter");
  const tip = document.body.querySelector(".dist-tip");
  assert(tip && !tip.classList.contains("hidden"), "тултип виден");
  includes(tip.textContent, "быстрый режим", "тултип — быстрый прогон");
  notIncludes(tip.textContent, "обычный", "тултип без обычного прогона");
  cells[1].fire("mouseleave");
  const qText = row.querySelector(".res-q-text");
  qText.fire("mouseenter");
  includes(tip.textContent, "обычный", "ховер на вопросе — обычный");
  includes(tip.textContent, "быстрый режим", "ховер на вопросе — быстрый");
  // повторный renderResults скрывает висящий тултип
  assert(!tip.classList.contains("hidden"), "тултип открыт");
  results.renderResults();
  assert(tip.classList.contains("hidden"), "тултип скрыт после перерендера");
});

test("results: форматтеры — shortAnswer, confClass, scoreDirClass, pairsDisagree", async () => {
  await resetState();
  // shortAnswer
  eq(results.shortAnswer(ansYesNo(0.9, 0.1)), "да · 90%", "yes_no да");
  eq(results.shortAnswer(ansYesNo(0.2, 0.8)), "нет · 80%", "yes_no нет");
  eq(results.shortAnswer({ type: "choice", choice: "Б", probabilities: { А: 0.3, Б: 0.7 } }), "Б · 70%", "choice");
  eq(results.shortAnswer({ type: "score", score: 2.345, probabilities: { 0: 0.1, 1: 0.9 } }), "2.35", "score");
  // confClass — нейтральные ступени conf-0..conf-4
  eq(results.confClass(0), "conf-0", "0");
  eq(results.confClass(0.19), "conf-0", "ниже 0.2");
  eq(results.confClass(0.2), "conf-1", "0.2");
  eq(results.confClass(0.39), "conf-1", "ниже 0.4");
  eq(results.confClass(0.4), "conf-2", "0.4");
  eq(results.confClass(0.5), "conf-2", "0.5");
  eq(results.confClass(0.6), "conf-3", "0.6");
  eq(results.confClass(0.79), "conf-3", "ниже 0.8");
  eq(results.confClass(0.8), "conf-4", "0.8");
  eq(results.confClass(1), "conf-4", "1");
  // scoreDirClass — границы 0.33/0.67, инверсия down, null-кейсы
  const sc = (levels, direction) => ({
    type: "score", levels: Array.from({ length: levels }, (_, i) => "l" + i), direction,
  });
  // шкала 1..101: value 34 → p=0.33, value 68 → p=0.67
  const q101 = sc(101, "up");
  eq(results.scoreDirClass(q101, 34), "dir-bad", "p=0.33 — bad");
  eq(results.scoreDirClass(q101, 35), "dir-mid", "p>0.33 — mid");
  eq(results.scoreDirClass(q101, 67), "dir-mid", "p<0.67 — mid");
  eq(results.scoreDirClass(q101, 68), "dir-good", "p=0.67 — good");
  eq(results.scoreDirClass(sc(5, "up"), 5), "dir-good", "up: максимум — хорошо");
  eq(results.scoreDirClass(sc(5, "up"), 1), "dir-bad", "up: минимум — плохо");
  eq(results.scoreDirClass(sc(5, "up"), 3), "dir-mid", "up: середина");
  eq(results.scoreDirClass(sc(5, "down"), 5), "dir-bad", "down инвертирует максимум");
  eq(results.scoreDirClass(sc(5, "down"), 1), "dir-good", "down: минимум — хорошо");
  eq(results.scoreDirClass(sc(5, "neutral"), 5), null, "neutral → null");
  eq(results.scoreDirClass(sc(5, "up"), null), null, "нет значения → null");
  eq(results.scoreDirClass({ type: "yes_no" }, 1), null, "не score → null");
  eq(results.scoreDirClass(sc(1, "up"), 1), null, "один уровень → null");
  // pairsDisagree — порог score 0.5 и различия yes_no
  const mk = (ans) => [{ run: { key: "mA", mode: "decisions" }, ans }, { run: { key: "mB", mode: "decisions" }, ans: { ...ans } }];
  eq(results.pairsDisagree(mk(ansYesNo(0.9, 0.1))), false, "yes_no одинаково");
  const yn = mk(ansYesNo(0.9, 0.1));
  yn[1].ans = ansYesNo(0.2, 0.8);
  eq(results.pairsDisagree(yn), true, "yes_no расходятся");
  const scp = [{ run: {}, ans: { type: "score", score: 2.0, probabilities: {} } }, { run: {}, ans: { type: "score", score: 2.4, probabilities: {} } }];
  eq(results.pairsDisagree(scp), false, "score в пределах 0.5");
  scp[1].ans.score = 2.6;
  eq(results.pairsDisagree(scp), true, "score за порогом 0.5");
});

// Фикстура score-прогона: три вопроса (up / down / neutral), score = максимум.
function setupScoreDirResults() {
  const qs = [
    { id: "q1", question: "Качество?", type: "score", levels: ["плохо", "средне", "хорошо"], direction: "up" },
    { id: "q2", question: "Риск?", type: "score", levels: ["низкий", "средний", "высокий"], direction: "down" },
    { id: "q3", question: "Нейтральный?", type: "score", levels: ["а", "б", "в"], direction: "neutral" },
  ];
  const ans = (score) => ({
    type: "score", score, probabilities: { 0: 0.05, 1: 0.1, 2: 0.85 }, label_mass: 0.99,
  });
  return { qs, ans };
}

test("results: dir-класс на значении и маркере — режимы A и B", async () => {
  installDom(); await resetState(); domResults();
  const { qs, ans } = setupScoreDirResults();
  state.models = [{ key: "mA", label: "Qwen A", status: "running" }];
  state.results = {
    results: { mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ans(2), q2: ans(0), q3: ans(2) }) },
    order: ["mA"], runMode: "decisions", questions: qs,
  };
  results.renderResults();
  const rowsA = [...document.getElementById("results-list").children];
  eq(rowsA.length, 3, "три строки");
  const a1 = rowsA[0].querySelector(".res-answer");
  assert(a1.classList.contains("dir-good"), "up + максимум → dir-good");
  assert(a1.className.includes("conf-"), "conf-класс сохранён");
  assert(rowsA[0].querySelector(".score-marker").classList.contains("dir-good"), "маркер up → dir-good");
  const a2 = rowsA[1].querySelector(".res-answer");
  assert(a2.classList.contains("dir-good"), "down + минимум → dir-good");
  assert(rowsA[1].querySelector(".score-marker").classList.contains("dir-good"), "маркер down+минимум → dir-good");
  const a3 = rowsA[2].querySelector(".res-answer");
  assert(!a3.className.includes("dir-"), "neutral → без dir-класса на значении");
  assert(!rowsA[2].querySelector(".score-marker").className.includes("dir-"), "neutral → маркер без dir-класса");
  // режим B — dir-класс на значении ячейки сравнения
  state.models = [
    { key: "mA", label: "Qwen A", status: "running" },
    { key: "mB", label: "Qwen B", status: "running" },
  ];
  state.results = {
    results: {
      mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ans(2), q2: ans(0), q3: ans(2) }),
      mB: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ans(0), q2: ans(2), q3: ans(0) }),
    },
    order: ["mA", "mB"], runMode: "decisions", questions: qs,
  };
  results.renderResults();
  const rowsB = [...document.getElementById("results-list").children];
  const valsOf = (row) => [...row.querySelectorAll(".res-cell-val")];
  const v1 = valsOf(rowsB[0]);
  assert(v1.some(v => v.classList.contains("dir-good")), "up: высокий score → dir-good");
  assert(v1.some(v => v.classList.contains("dir-bad")), "up: низкий score → dir-bad");
  const v2 = valsOf(rowsB[1]);
  assert(v2.some(v => v.classList.contains("dir-good")), "down: низкий score → dir-good");
  assert(v2.some(v => v.classList.contains("dir-bad")), "down: высокий score → dir-bad");
  const v3 = valsOf(rowsB[2]);
  assert(v3.every(v => !v.className.includes("dir-")), "neutral → ни одна ячейка без dir-класса");
});

test("results: режим B с тремя прогонами — все ячейки видны, без «+ ещё»", async () => {
  installDom(); await resetState(); domResults();
  const qs = [{ id: "q1", question: "Есть ли цифры в резюме?", type: "yes_no" }];
  state.models = [
    { key: "mA", label: "Qwen A 27B", status: "running" },
    { key: "mB", label: "Qwen B 35B", status: "running" },
    { key: "mC", label: "Qwen C 9B", status: "running" },
  ];
  state.results = {
    results: {
      mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }),
      mB: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.7, 0.3) }),
      mC: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.6, 0.4) }),
    },
    order: ["mA", "mB", "mC"], runMode: "decisions", questions: qs,
  };
  results.renderResults();
  const row = document.getElementById("results-list").children[0];
  const cells = row.querySelectorAll(".res-cell");
  eq(cells.length, 3, "все три прогона видны");
  const tags = [...cells].map(c => c.querySelector(".res-cell-tag").textContent).join(",");
  eq(tags, "27B,35B,9B", "теги всех прогонов");
  assert(!row.querySelector(".more-mark"), "метки «+ ещё N» нет");
  // drilldown по клику остаётся
  row.fire("click");
  const detail = document.getElementById("results-list").querySelector(".res-detail");
  assert(detail, "дрилдаун открылся");
  eq(detail.querySelectorAll(".res-detail-section").length, 3, "дрилдаун по всем трём прогонам");
});
