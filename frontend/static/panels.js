// Переиспользуемый двухпанельный сплит: drag-разделитель (ширина в localStorage),
// «⛶» — панель на весь экран, «—» — свернуть (restore-вкладка возвращает), Esc — восстановить.
// Используется страницами «Одиночный» (layout.js) и «Батч» (batch.js).
// createVSplit — вертикальный сплит двух карточек внутри одной панели.

const MIN_W = 35, MAX_W = 75;
const MIN_H = 25, MAX_H = 75;

function clampWidth(w) {
  return Math.min(MAX_W, Math.max(MIN_W, w));
}

// panels — живой объект {width, focus, collapsed} из state (по ссылке).
export function createSplitLayout({ split, splitter, restoreLeft, restoreRight, panels, widthKey }) {
  function loadWidth() {
    if (!widthKey) return;
    const saved = parseFloat(localStorage.getItem(widthKey));
    if (!isNaN(saved)) panels.width = clampWidth(saved);
  }

  function saveWidth() {
    if (!widthKey) return;
    localStorage.setItem(widthKey, String(Math.round(panels.width * 10) / 10));
  }

  // Применяет ширину, фокус и сворачивание к DOM.
  function apply() {
    split.style.setProperty("--left-w", panels.width + "%");
    split.classList.toggle("focus-left", panels.focus === "left");
    split.classList.toggle("focus-right", panels.focus === "right");
    split.classList.toggle("collapsed-left", panels.collapsed === "left");
    split.classList.toggle("collapsed-right", panels.collapsed === "right");
    const tabs = { left: restoreLeft, right: restoreRight };
    for (const side of ["left", "right"]) {
      const tab = tabs[side];
      if (tab) tab.classList.toggle("hidden", panels.collapsed !== side);
      const fsBtn = split.querySelector(`.icon-btn[data-panel="${side}"][data-action="fullscreen"]`);
      if (fsBtn) fsBtn.classList.toggle("active", panels.focus === side);
    }
  }

  // «⛶»: панель на весь экран; повторный клик — обратно к сплиту.
  function setFocus(panel) {
    panels.focus = panel;
    if (panel) panels.collapsed = null;
    apply();
  }

  // Восстановить сплит из любого состояния.
  function reset() {
    panels.focus = null;
    panels.collapsed = null;
    apply();
  }

  // «—»: свернуть свою панель (restore-вкладка вернёт); в фокусе — выйти из полного экрана.
  function collapse(panel) {
    if (panels.focus === panel) {
      panels.focus = null;
    } else {
      panels.focus = null;
      panels.collapsed = panel;
    }
    apply();
  }

  function init() {
    loadWidth();
    apply();

    if (splitter) {
      splitter.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const onMove = (ev) => {
          const rect = split.getBoundingClientRect();
          if (!rect.width) return;
          panels.width = clampWidth(((ev.clientX - rect.left) / rect.width) * 100);
          apply();
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          saveWidth();
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });

      splitter.addEventListener("dblclick", () => {
        panels.width = 50;
        apply();
        saveWidth();
      });
    }

    // Панельные кнопки — только внутри своего сплита (на странице может быть два сплита).
    for (const btn of split.querySelectorAll(".panel-actions .icon-btn")) {
      btn.addEventListener("click", () => {
        const panel = btn.dataset.panel;
        if (btn.dataset.action === "fullscreen") {
          setFocus(panels.focus === panel ? null : panel);
        } else {
          collapse(panel);
        }
      });
    }

    for (const tab of [restoreLeft, restoreRight]) {
      if (tab) tab.addEventListener("click", () => {
        panels.collapsed = null;
        apply();
      });
    }

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && (panels.focus || panels.collapsed)) reset();
    });
  }

  return { init };
}

function clampHeight(h) {
  return Math.min(MAX_H, Math.max(MIN_H, h));
}

// Вертикальный сплит: drag по Y (границы 25–75% высоты container), dblclick — 50/50,
// высота верхней карточки сохраняется в localStorage по heightKey.
// top — верхняя карточка, splitter — разделитель, container — их общий flex-родитель.
export function createVSplit({ top, splitter, container, heightKey }) {
  let height = 50;

  function loadHeight() {
    if (!heightKey) return;
    const saved = parseFloat(localStorage.getItem(heightKey));
    if (!isNaN(saved)) height = clampHeight(saved);
  }

  function saveHeight() {
    if (!heightKey) return;
    localStorage.setItem(heightKey, String(Math.round(height * 10) / 10));
  }

  function apply() {
    container.classList.add("vsplit-container");
    top.classList.add("vsplit-top");
    const bottom = container.children[container.children.indexOf(splitter) + 1];
    if (bottom) bottom.classList.add("vsplit-bottom");
    top.style.height = height + "%";
  }

  function init() {
    loadHeight();
    apply();

    if (splitter) {
      splitter.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const onMove = (ev) => {
          const rect = container.getBoundingClientRect();
          if (!rect.height) return;
          height = clampHeight(((ev.clientY - rect.top) / rect.height) * 100);
          apply();
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          saveHeight();
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });

      splitter.addEventListener("dblclick", () => {
        height = 50;
        apply();
        saveHeight();
      });
    }
  }

  return { init };
}
