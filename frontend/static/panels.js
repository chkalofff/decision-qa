// Переиспользуемый двухпанельный сплит: drag-разделитель (ширина в localStorage),
// «⛶» — панель на весь экран, «—» — свернуть (restore-вкладка возвращает), Esc — восстановить.
// Используется страницами «Одиночный» (layout.js) и «Батч» (batch.js).

const MIN_W = 35, MAX_W = 75;

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
