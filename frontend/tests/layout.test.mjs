// Доменные тесты: layout. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, installDom, el, resetState, domLayout, domBatch, domContext, state, layout, context, batch, questions,
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

// Вертикальный сплит «Контекст | Вопросы + Решение» внутри левой панели одиночного режима.
function domVSplitSingle() {
  const body = el("div", { className: "panel-body", parent: document.getElementById("panel-left") });
  el("section", { id: "context-card", className: "card", parent: body });
  el("div", { id: "vsplit-single", className: "vsplitter", parent: body });
  const zone = el("div", { className: "vsplit-bottom-zone", parent: body });
  el("section", { className: "card", parent: zone });
  el("section", { className: "card", parent: zone });
  return zone;
}

test("vsplit single: drag меняет высоту контекста, сохраняет и восстанавливает, dblclick сбрасывает", async () => {
  installDom(); await resetState(); domLayout(); domVSplitSingle();
  layout.initLayout();
  const top = document.getElementById("context-card");
  const split = document.getElementById("vsplit-single");
  assert(split, "сплиттер в DOM");
  eq(top.style.height, "50%", "стартовая высота 50%");
  split.fire("mousedown");
  document.dispatchEvent({ type: "mousemove", clientY: 12 });
  eq(top.style.height, "60%", "высота по drag");
  document.dispatchEvent({ type: "mouseup" });
  eq(localStorage.getItem("dq-vsplit-single"), "60", "высота сохранена");
  assert(top.classList.contains("vsplit-top"), "верхней карточке выдан класс");
  // единая скролл-область «Вопросы + Решение» получает vsplit-bottom
  const zone = document.querySelector(".vsplit-bottom-zone");
  assert(zone.classList.contains("vsplit-bottom"), "зоне выдан класс vsplit-bottom");
  // восстановление из localStorage
  installDom(); await resetState(); domLayout(); domVSplitSingle();
  localStorage.setItem("dq-vsplit-single", "65");
  layout.initLayout();
  const top2 = document.getElementById("context-card");
  eq(top2.style.height, "65%", "высота из localStorage");
  document.getElementById("vsplit-single").fire("dblclick");
  eq(top2.style.height, "50%", "dblclick → 50%");
  eq(localStorage.getItem("dq-vsplit-single"), "50", "сброс сохранён");
});

test("vsplit batch: разделитель в DOM, drag меняет высоту «Файлы», dblclick сбрасывает", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  const top = document.getElementById("batch-files-card");
  const split = document.getElementById("vsplit-batch");
  assert(split, "сплиттер в DOM");
  eq(top.style.height, "50%", "стартовая высота 50%");
  split.fire("mousedown");
  document.dispatchEvent({ type: "mousemove", clientY: 8 });
  eq(top.style.height, "40%", "высота по drag");
  document.dispatchEvent({ type: "mouseup" });
  eq(localStorage.getItem("dq-vsplit-batch"), "40", "высота сохранена");
  split.fire("dblclick");
  eq(top.style.height, "50%", "dblclick → 50%");
  eq(localStorage.getItem("dq-vsplit-batch"), "50", "сброс сохранён");
});

test("contract: vsplit-разделители и их инстансы подключены", async () => {
  const html = readFileSync(new NodeURL("../static/index.html", import.meta.url), "utf8");
  includes(html, 'id="vsplit-single"', "vsplit-single в index.html");
  includes(html, 'id="vsplit-batch"', "vsplit-batch в index.html");
  const zones = html.split('class="vsplit-bottom-zone"').length - 1;
  eq(zones, 2, "зона «Вопросы + Решение» на обеих страницах");
  const layoutSrc = readFileSync(new NodeURL("../static/layout.js", import.meta.url), "utf8");
  includes(layoutSrc, "dq-vsplit-single", "инстанс одиночного режима");
  const batchSrc = readFileSync(new NodeURL("../static/batch.js", import.meta.url), "utf8");
  includes(batchSrc, "dq-vsplit-batch", "инстанс батча");
});

// ================================================================ blockcollapse

function domBlockCard(id) {
  const card = el("section", { id, className: "card" });
  const head = el("div", { className: "section-head", parent: card });
  el("h2", { parent: head, text: "Заголовок" });
  return card;
}

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

test("context fullscreen: инлайн-height сплиттера очищается и восстанавливается", async () => {
  installDom(); await resetState(); domContext();
  const card = document.getElementById("context-card");
  card.style.height = "60%";
  context.toggleContextFullscreen(true);
  assert(card.classList.contains("context-fullscreen"), "fullscreen включён");
  eq(card.style.height, "", "инлайн-height очищен — не перебивает inset");
  context.toggleContextFullscreen(false);
  assert(!card.classList.contains("context-fullscreen"), "fullscreen выключен");
  eq(card.style.height, "60%", "инлайн-height восстановлен");
});
