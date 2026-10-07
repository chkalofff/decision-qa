// Доменные тесты: layout. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, installDom, el, resetState, domLayout, domBatch, state, layout, context, batch,
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

// Вертикальный сплит «Контекст | Вопросы» внутри левой панели одиночного режима.
function domVSplitSingle() {
  const body = el("div", { className: "panel-body", parent: document.getElementById("panel-left") });
  el("section", { id: "context-card", className: "card", parent: body });
  el("div", { id: "vsplit-single", className: "vsplitter", parent: body });
  el("section", { className: "card", parent: body });
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
  const layoutSrc = readFileSync(new NodeURL("../static/layout.js", import.meta.url), "utf8");
  includes(layoutSrc, "dq-vsplit-single", "инстанс одиночного режима");
  const batchSrc = readFileSync(new NodeURL("../static/batch.js", import.meta.url), "utf8");
  includes(batchSrc, "dq-vsplit-batch", "инстанс батча");
});
