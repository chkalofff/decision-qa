// Двухпанельная компоновка страницы «Одиночный» — инстанс panels.js.

import { state } from "./state.js";
import { createSplitLayout } from "./panels.js";

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
}
