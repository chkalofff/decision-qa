const SECTION_LABELS = {
  materials: "Материалы",
  questions: "Вопросы",
  decision: "Правила решений",
  settings: "Модели и настройки прогона",
  results: "Результаты и разметка",
};

export function availableImportSections(parsed) {
  return Object.keys(SECTION_LABELS).filter(key => {
    if (key === "materials") return !!parsed.context || Array.isArray(parsed.batchFiles);
    if (key === "questions") return Array.isArray(parsed.questions);
    if (key === "decision") return parsed.decisionImport !== false && !!parsed.decision;
    if (key === "settings") return !!parsed.settings;
    return !!parsed.results || !!parsed.batchResults;
  });
}

export function chooseImportSections(parsed, { filename = "", validate = () => {} } = {}) {
  document.getElementById("import-dialog")?.remove();
  const available = availableImportSections(parsed);
  if (!available.length) return Promise.resolve(null);
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "preset-dialog-overlay";
    overlay.id = "import-dialog";
    const box = document.createElement("div");
    box.className = "preset-dialog-box saveas-dialog-box";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const title = document.createElement("div");
    title.className = "preset-dialog-title";
    title.textContent = "Импорт с заменой разделов";
    const file = document.createElement("div");
    file.className = "hint";
    file.textContent = filename ? `Файл: ${filename}` : "Выберите данные для импорта.";
    const warning = document.createElement("div");
    warning.className = "import-replace-warning";
    warning.textContent = "Выбранные разделы заменят текущие данные документа. Существующие элементы этих разделов будут удалены, а не объединены с импортированными.";
    const sections = document.createElement("div");
    sections.className = "saveas-scope";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.id = "import-apply";
    apply.className = "btn";
    apply.textContent = "Заменить выбранные разделы";
    apply.disabled = true;
    const error = document.createElement("div");
    error.className = "import-dialog-error";
    error.setAttribute("role", "alert");
    const close = value => {
      overlay.remove();
      resolve(value);
    };
    for (const key of available) {
      const row = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.importSection = key;
      input.id = `import-${key}`;
      row.append(input, document.createTextNode(SECTION_LABELS[key]));
      sections.appendChild(row);
      input.addEventListener("change", () => {
        apply.disabled = ![...sections.querySelectorAll("input")].filter(input => input.checked).length;
        error.textContent = "";
      });
    }
    apply.addEventListener("click", () => {
      const selected = new Set([...[...sections.querySelectorAll("input")].filter(input => input.checked)].map(input => input.dataset.importSection));
      const selection = Object.fromEntries(available.map(key => [key, selected.has(key)]));
      try { validate(selection); }
      catch (validationError) { error.textContent = validationError.message; return; }
      close(selection);
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.id = "import-cancel";
    cancel.className = "btn";
    cancel.textContent = "Отмена";
    cancel.addEventListener("click", () => close(null));
    const actions = document.createElement("div");
    actions.className = "mgr-actions";
    actions.append(apply, cancel);
    box.append(title, file, warning, sections, error, actions);
    overlay.appendChild(box);
    overlay.addEventListener("click", event => { if (event.target === overlay) close(null); });
    document.body.appendChild(overlay);
  });
}
