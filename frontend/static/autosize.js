const MAX_HEIGHT = 172;
let observer = null;

export function resizeTextarea(field) {
  if (!field) return;
  field.style.height = "auto";
  const contentHeight = field.scrollHeight || 34;
  field.style.height = `${Math.min(MAX_HEIGHT, Math.max(34, contentHeight))}px`;
  field.style.overflowY = contentHeight > MAX_HEIGHT ? "auto" : "hidden";
}

export function autoGrowTextarea(field) {
  field.rows = 1;
  field.classList.add("autogrow");
  if (field.dataset.autosizeBound) {
    resizeTextarea(field);
    return field;
  }
  field.dataset.autosizeBound = "1";
  field.addEventListener("input", () => resizeTextarea(field));
  if (typeof globalThis.ResizeObserver === "function") {
    if (!observer) {
      observer = new globalThis.ResizeObserver(entries => {
        for (const entry of entries) {
          if (!entry.target.isConnected) {
            observer?.unobserve(entry.target);
            continue;
          }
          resizeTextarea(entry.target);
        }
      });
    }
    observer.observe(field);
  }
  resizeTextarea(field);
  return field;
}

export function autoGrowWithin(root) {
  root.querySelectorAll("textarea[data-autosize]").forEach(autoGrowTextarea);
}
