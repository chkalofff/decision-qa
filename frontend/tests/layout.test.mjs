// Доменные тесты: layout. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, notIncludes, installDom, el, resetState, sleep, domLayout, domBatch, domContext, state, layout, context, batch, questions,
} from "./harness.mjs";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";  // глобальный URL подменён DOM-моком

// ================================================================ layout

test("layout: ⛶ и «—» переключают свою панель, Esc и dblclick сбрасывают", async () => {
  installDom(); await resetState(); domLayout();
  layout.initLayout();
  const split = document.getElementById("split");
  const fsL = document.querySelector('.icon-btn[data-panel="left"][data-action="fullscreen"]');
  fsL.fire("click");
  assert(split.classList.contains("focus-left"), "focus-left включён");
  fsL.fire("click");
  assert(!split.classList.contains("focus-left"), "focus-left выключен");
  // «—» сворачивает свою панель, restore-вкладка возвращает
  document.querySelector('.icon-btn[data-panel="left"][data-action="collapse"]').fire("click");
  assert(split.classList.contains("collapsed-left"), "collapsed-left");
  assert(!document.getElementById("restore-left").classList.contains("hidden"), "вкладка видна");
  document.getElementById("restore-left").fire("click");
  assert(!split.classList.contains("collapsed-left"), "сплит восстановлен");
  // «—» в полноэкранном режиме возвращает сплит, а не перекидывает фокус (регрессия)
  document.querySelector('.icon-btn[data-panel="right"][data-action="fullscreen"]').fire("click");
  assert(split.classList.contains("focus-right"), "focus-right включён");
  document.querySelector('.icon-btn[data-panel="right"][data-action="collapse"]').fire("click");
  assert(!split.classList.contains("focus-right"), "focus снят");
  assert(!split.classList.contains("focus-left"), "НЕ перекинуто на левую панель");
  assert(!split.classList.contains("collapsed-right"), "и не свёрнуто");
  // Esc сбрасывает фокус и сворачивание
  document.querySelector('.icon-btn[data-panel="left"][data-action="fullscreen"]').fire("click");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!split.classList.contains("focus-left"), "focus сброшен по Esc");
  document.querySelector('.icon-btn[data-panel="right"][data-action="collapse"]').fire("click");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!split.classList.contains("collapsed-right"), "collapsed сброшен по Esc");
  // двойной клик по разделителю возвращает 50%
  state.panels.width = 70;
  layout.initLayout();
  document.getElementById("splitter").fire("dblclick");
  eq(state.panels.width, 50, "ширина 50");
});

test("contract: вертикальные сплиттеры удалены, горизонтальные остаются", async () => {
  const html = readFileSync(new NodeURL("../static/index.html", import.meta.url), "utf8");
  includes(html, 'id="splitter"', "горизонтальный сплиттер single сохранён");
  includes(html, 'id="splitter-batch"', "горизонтальный сплиттер batch сохранён");
  notIncludes(html, "vsplit", "разметки вертикальных сплиттеров нет");
  for (const file of ["layout.js", "batch.js", "panels.js", "style.css"]) {
    const src = readFileSync(new NodeURL("../static/" + file, import.meta.url), "utf8");
    notIncludes(src, "vsplit", `${file}: вертикальный сплит и его стили удалены`);
  }
  const panelsSrc = readFileSync(new NodeURL("../static/panels.js", import.meta.url), "utf8");
  includes(panelsSrc, "createSplitLayout", "фабрика горизонтальных панелей сохранена");
});

// ================================================================ blockcollapse

function domBlockCard(id) {
  const card = el("section", { id, className: "card" });
  const head = el("div", { className: "section-head", parent: card });
  el("h2", { parent: head, text: "Заголовок" });
  return card;
}

test("blockcollapse: материалы single — режим в сводке, персист и восстановление", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({ showError: () => {} });
  const bc = await import("../static/blockcollapse.js");
  bc.initBlockCollapse();
  const card = document.getElementById("context-card");
  const btn = card.querySelector(".block-collapse-btn");
  assert(btn, "у материалов single есть кнопка сворачивания");
  btn.fire("click");
  assert(card.classList.contains("card-collapsed"), "материалы single свёрнуты");
  eq(localStorage.getItem("dq-collapse-materials-single"), "1", "состояние single сохранено");
  eq(card.querySelector(".block-count").textContent, "· Текст", "сводка текстового режима");

  // Смена режима обновляет сводку уже свёрнутой карточки.
  document.getElementById("mode-json").fire("click");
  await sleep(10);
  eq(card.querySelector(".block-count").textContent, "· JSON", "сводка следует за режимом");
  context.__setCmForTests(null, null);
  btn.fire("click");
  eq(localStorage.getItem("dq-collapse-materials-single"), "0", "разворот сохранён");
  eq(card.querySelector(".block-count").textContent, "", "сводка скрыта в развёрнутом виде");

  installDom(); await resetState(); domContext();
  localStorage.setItem("dq-collapse-materials-single", "1");
  bc.initBlockCollapse();
  assert(document.getElementById("context-card").classList.contains("card-collapsed"),
    "свёрнутое состояние single восстановлено");
});

test("blockcollapse: материалы batch — число файлов со склонением и персист", async () => {
  installDom(); await resetState(); domBatch();
  const bc = await import("../static/blockcollapse.js");
  bc.initBlockCollapse();
  const card = document.getElementById("batch-files-card");
  card.querySelector(".block-collapse-btn").fire("click");
  const summary = () => card.querySelector(".block-count").textContent;
  eq(summary(), "· 0 файлов", "пустой пакет");
  eq(localStorage.getItem("dq-collapse-materials-batch"), "1", "состояние batch сохранено");

  // Все изменения списка проходят через renderBatchList и обновляют сводку.
  batch.loadPresetFiles([{ name: "a.txt", content: "a" }]);
  eq(summary(), "· 1 файл", "единственное число");
  batch.loadPresetFiles([{ name: "a.txt", content: "a" }, { name: "b.txt", content: "b" }]);
  eq(summary(), "· 2 файла", "форма 2–4");
  batch.loadPresetFiles(Array.from({ length: 5 }, (_, i) => ({ name: `${i}.txt`, content: "x" })));
  eq(summary(), "· 5 файлов", "форма от 5");

  installDom(); await resetState(); domBatch();
  localStorage.setItem("dq-collapse-materials-batch", "1");
  state.batch.files = [{ id: "f1", name: "a.txt" }, { id: "f2", name: "b.txt" }];
  bc.initBlockCollapse();
  const restored = document.getElementById("batch-files-card");
  assert(restored.classList.contains("card-collapsed"), "свёрнутое состояние batch восстановлено");
  eq(restored.querySelector(".block-count").textContent, "· 2 файла", "сводка восстановлена по state");
});

test("blockcollapse: блок сворачивается целиком со счётчиком и персистом", async () => {
  installDom(); await resetState();
  const card = domBlockCard("questions-card");
  el("div", { id: "questions-list", parent: card });
  el("div", { id: "questions-empty", parent: card });
  state.questions = [
    { id: "q1", question: "В1?", type: "yes_no" },
    { id: "q2", question: "В2?", type: "yes_no" },
  ];
  const { initBlockCollapse } = await import("../static/blockcollapse.js");
  initBlockCollapse();
  const btn = card.querySelector(".block-collapse-btn");
  assert(btn, "кнопка сворачивания добавлена");
  eq(btn.textContent, "▾", "изначально развёрнут");
  btn.fire("click");
  assert(card.classList.contains("card-collapsed"), "блок свёрнут");
  eq(btn.textContent, "▸", "иконка свёрнутого");
  eq(localStorage.getItem("dq-collapse-questions-single"), "1", "состояние сохранено");
  eq(card.querySelector(".block-count").textContent, "· 2 вопроса", "счётчик в шапке");
  // счётчик следует за renderQuestions
  state.questions.push({ id: "q3", question: "В3?", type: "yes_no" });
  questions.renderQuestions();
  eq(card.querySelector(".block-count").textContent, "· 3 вопроса", "счётчик обновлён");
  btn.fire("click");
  assert(!card.classList.contains("card-collapsed"), "блок развёрнут");
  eq(localStorage.getItem("dq-collapse-questions-single"), "0", "персист снят");
  eq(card.querySelector(".block-count").textContent, "", "счётчик скрыт");
  // восстановление из localStorage при повторном init
  localStorage.setItem("dq-collapse-questions-single", "1");
  const card2 = domBlockCard("questions-card");
  initBlockCollapse();
  assert(card2.classList.contains("card-collapsed"), "свёрнутое состояние восстановлено");
});

test("blockcollapse: блок «Решение» считает исходы со склонением", async () => {
  installDom(); await resetState();
  const card = domBlockCard("decision-card");
  el("div", { id: "decision-list", parent: card });
  el("div", { id: "decision-empty", parent: card });
  el("div", { id: "decision-hints", parent: card });
  state.decision = { outcomes: [
    { id: "o1", label: "А", color: "green", rules: [] },
    { id: "o2", label: "Б", color: "red", rules: [] },
    { id: "o3", label: "В", color: "gray", isDefault: true, rules: [] },
  ] };
  const { initBlockCollapse } = await import("../static/blockcollapse.js");
  initBlockCollapse();
  card.querySelector(".block-collapse-btn").fire("click");
  eq(card.querySelector(".block-count").textContent, "· 3 исхода", "счётчик исходов");
});

test("blockcollapse: setBlocksCollapsed — массовое сворачивание блоков страницы", async () => {
  installDom(); await resetState();
  const mc = domBlockCard("context-card");
  const qc = domBlockCard("questions-card");
  const dc = domBlockCard("decision-card");
  const bmc = domBlockCard("batch-files-card");
  const bqc = domBlockCard("batch-questions-card");
  const bc = await import("../static/blockcollapse.js");
  bc.initBlockCollapse();
  // сворачиваем только блоки одиночной страницы, включая материалы
  bc.setBlocksCollapsed(true, ["context-card", "questions-card", "decision-card"]);
  assert(mc.classList.contains("card-collapsed"), "материалы single свёрнуты");
  assert(qc.classList.contains("card-collapsed"), "вопросы single свёрнуты");
  assert(dc.classList.contains("card-collapsed"), "решение single свёрнуто");
  assert(!bmc.classList.contains("card-collapsed") && !bqc.classList.contains("card-collapsed"),
    "батч-блоки не тронуты");
  eq(localStorage.getItem("dq-collapse-materials-single"), "1", "персист материалов single");
  eq(localStorage.getItem("dq-collapse-questions-single"), "1", "персист single");
  eq(localStorage.getItem("dq-collapse-materials-batch"), null, "персист материалов батча не задан");
  eq(localStorage.getItem("dq-collapse-questions-batch"), null, "персист батча не задан");
  // разворачиваем всё без фильтра страницы
  bc.setBlocksCollapsed(false);
  assert(!mc.classList.contains("card-collapsed") && !qc.classList.contains("card-collapsed") &&
    !dc.classList.contains("card-collapsed"), "развёрнуты");
  eq(localStorage.getItem("dq-collapse-decision-single"), "0", "персист снят");
});
