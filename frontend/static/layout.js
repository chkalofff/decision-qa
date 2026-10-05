// Двухпанельная компоновка страницы «Одиночный» — инстанс panels.js.

import { state } from "./state.js";
import { createSplitLayout, createVSplit } from "./panels.js";

let single = null;

export function initLayout() {
  single = createSplitLayout({
    split: document.getElementById("split"),
    splitter: document.getElementById("splitter"),
    restoreLeft: document.getElementById("restore-left"),
    restoreRight: document.getElementById("restore-right"),
    panels: state.panels,
    widthKey: "dq-panel-width",
  });
  single.init();

  // Вертикальный сплит «Контекст | Вопросы» внутри левой панели.
  const ctxCard = document.getElementById("context-card");
  const vsplit = document.getElementById("vsplit-single");
  if (ctxCard && vsplit && ctxCard.parentNode) {
    createVSplit({
      top: ctxCard,
      splitter: vsplit,
      container: ctxCard.parentNode,
      heightKey: "dq-vsplit-single",
    }).init();
  }
}
