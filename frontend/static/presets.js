// Менеджер пресетов: страница со списком всех пресетов (встроенные read-only +
// пользовательские из backend/presets_user/). Действия: применить, сохранить
// текущее состояние как пресет, переименовать/удалить (user), экспорт/импорт
// самодостаточного .json (картинки — встроенные base64).

import { state } from "./state.js";
import { getPresets, createPreset, renamePreset, deletePreset, generatePreset } from "./api.js";
import { setPageMode } from "./toolbar.js";
import { buildQuestionsPayload, withDirections } from "./questions.js";
import { contextSnapshot, downloadJson } from "./context.js";
import { batchFilesSnapshot } from "./batch.js";
import { validateDecision } from "./decision.js";
import { openGenerateDialog } from "./generate.js";

let applyPresetCb = () => {};
let showErrorCb = () => {};
let returnMode = "single";  // куда ведёт «← К прогону» и откуда «Сохранить как пресет»

export function initPresets({ applyPreset, showError } = {}) {
  applyPresetCb = applyPreset || applyPresetCb;
  showErrorCb = showError || showErrorCb;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDialog();
  });
}

export function openPresetsPage() {
  if (state.pageMode === "single" || state.pageMode === "batch") {
    returnMode = state.pageMode;
  }
  setPageMode("presets");
  renderPresetsPage();
  reloadList();
}

// ---------------------------------------------------------------- страница

function renderPresetsPage() {
  const page = document.getElementById("page-presets");
  page.innerHTML = "";

  const head = document.createElement("section");
  head.className = "card";
  const headRow = document.createElement("div");
  headRow.className = "section-head";
  const h2 = document.createElement("h2");
  h2.textContent = "Пресеты";
  headRow.appendChild(h2);
  const back = document.createElement("button");
  back.type = "button";
  back.id = "btn-presets-back";
  back.className = "btn btn-small";
  back.textContent = "← К прогону";
  back.title = "Вернуться к основной странице";
  back.onclick = () => setPageMode(returnMode);
  headRow.appendChild(back);
  head.appendChild(headRow);
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Встроенные пресеты read-only; свои хранятся в backend/presets_user/ и не затираются обновлениями. Экспорт — самодостаточный .json (картинки встроены base64), переносится между компьютерами через «Импорт».";
  head.appendChild(hint);
  const actions = document.createElement("div");
  actions.className = "mgr-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.id = "btn-preset-save-as";
  saveBtn.className = "btn btn-small";
  saveBtn.textContent = "Сохранить как пресет…";
  saveBtn.title = returnMode === "batch"
    ? "Текущие вопросы и файлы батча → новый пресет"
    : "Текущий контекст, изображения и вопросы → новый пресет";
  saveBtn.onclick = () => openSaveDialog(returnMode);
  actions.appendChild(saveBtn);
  const genBtn = document.createElement("button");
  genBtn.type = "button";
  genBtn.id = "btn-preset-generate";
  genBtn.className = "btn btn-small";
  genBtn.textContent = "✨ Сгенерировать…";
  genBtn.title = "LLM-генерация набора вопросов chat-моделью по описанию задачи";
  genBtn.onclick = () => openGenerateDialog({
    title: "Сгенерировать пресет",
    taskPlaceholder: "Описание задачи (например: скрининг резюме Java-разработчиков)…",
    onGenerate: async (modelKey, task, thinking) => {
      const data = await generatePreset({ model_key: modelKey, description: task, thinking });
      await createPreset({
        name: data.name || task.slice(0, 60),
        description: data.description || task,
        page: "single",
        payload: { input: task, questions: data.questions },
      });
      reloadList();
    },
  });
  actions.appendChild(genBtn);
  const importLabel = document.createElement("label");
  importLabel.className = "btn btn-small";
  importLabel.id = "btn-preset-import";
  importLabel.textContent = "Импорт…";
  importLabel.title = "Импорт пресета из .json (сохраняется как пользовательский)";
  const importInput = document.createElement("input");
  importInput.type = "file";
  importInput.id = "preset-import-input";
  importInput.accept = ".json,application/json";
  importInput.className = "hidden";
  importInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) importPreset(e.target.files[0]);
    e.target.value = "";
  });
  importLabel.appendChild(importInput);
  actions.appendChild(importLabel);
  head.appendChild(actions);
  page.appendChild(head);

  const list = document.createElement("div");
  list.id = "presets-list";
  page.appendChild(list);
}

async function reloadList() {
  const list = document.getElementById("presets-list");
  if (!list) return;
  list.innerHTML = "";
  let presets;
  try {
    presets = await getPresets();
  } catch (e) {
    showErrorCb(e.message);
    return;
  }
  if (!presets.length) {
    const empty = document.createElement("div");
    empty.className = "results-empty";
    empty.textContent = "Пресетов нет.";
    list.appendChild(empty);
    return;
  }
  for (const p of presets) list.appendChild(presetCard(p));
}

function presetHasImages(p) {
  return (Array.isArray(p.images) && p.images.length > 0) ||
    (Array.isArray(p.files) && p.files.some(f => f.image || f.dataUrl || (f.images || []).length));
}

function presetCard(p) {
  const card = document.createElement("section");
  card.className = "card mgr-card preset-card";

  const head = document.createElement("div");
  head.className = "mgr-head";
  const name = document.createElement("span");
  name.className = "preset-name";
  name.textContent = p.name;
  head.appendChild(name);
  const srcBadge = document.createElement("span");
  srcBadge.className = "mgr-badge preset-src-" + (p.source === "user" ? "user" : "builtin");
  srcBadge.textContent = p.source === "user" ? "мой" : "встроенный";
  srcBadge.title = p.source === "user"
    ? "Пользовательский пресет (backend/presets_user/)"
    : "Встроенный пресет — read-only";
  head.appendChild(srcBadge);
  const pageBadge = document.createElement("span");
  pageBadge.className = "mgr-badge";
  pageBadge.textContent = p.page === "batch" ? "батч" : "одиночный";
  head.appendChild(pageBadge);
  if (presetHasImages(p)) {
    const img = document.createElement("span");
    img.className = "mgr-badge mgr-vision";
    img.textContent = "🖼";
    img.title = "Пресет с изображениями — нужны vision-модели (Clef)";
    head.appendChild(img);
  }
  card.appendChild(head);

  if (p.description) {
    const desc = document.createElement("div");
    desc.className = "hint preset-desc";
    desc.textContent = p.description;
    card.appendChild(desc);
  }
  if (p.slug) {
    const meta = document.createElement("div");
    meta.className = "mgr-meta hint";
    meta.textContent = p.slug + ".json";
    card.appendChild(meta);
  }

  const actions = document.createElement("div");
  actions.className = "mgr-actions";
  const mkBtn = (label, onclick, { danger = false, id = "", title = "" } = {}) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-small" + (danger ? " btn-danger" : "");
    if (id) b.id = id;
    b.textContent = label;
    if (title) b.title = title;
    b.onclick = () => onclick();
    return b;
  };
  actions.appendChild(mkBtn("Применить", () => applyPresetCb(p),
    { title: "Заменить текущий контекст/вопросы содержимым пресета" }));
  if (p.source === "user") {
    actions.appendChild(mkBtn("Переименовать", () => openRenameDialog(p)));
    actions.appendChild(mkBtn("Удалить", async () => {
      if (!confirm(`Удалить пресет «${p.name}»?`)) return;
      try {
        await deletePreset(p.slug);
      } catch (e) {
        showErrorCb(e.message);
        return;
      }
      reloadList();
    }, { danger: true }));
  }
  actions.appendChild(mkBtn("Клонировать", () => openCloneDialog(p),
    { title: "Создать редактируемую пользовательскую копию этого пресета" }));
  actions.appendChild(mkBtn("Экспорт", () => exportPreset(p),
    { title: "Скачать самодостаточный .json (картинки встроены base64)" }));
  card.appendChild(actions);
  return card;
}

function openCloneDialog(p) {
  const { name, description, page, slug, source, ...payload } = p;
  openDialog({
    title: "Клонировать пресет",
    name: `Копия ${name}`,
    description: description || "",
    submitLabel: "Создать копию",
    onSubmit: async (n, d) => {
      await createPreset({
        name: n,
        description: d,
        page: page === "batch" ? "batch" : "single",
        payload,
      });
      reloadList();
    },
  });
}

// ---------------------------------------------------------------- экспорт / импорт

function exportPreset(p) {
  const { slug, source, ...data } = p;
  downloadJson(`${slug || "preset"}.json`, data);
}

// Принимает оба формата: плоский (как у встроенных/экспорта) и
// {name, description?, page, payload} (формат POST /api/presets).
export function normalizePresetImport(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Файл должен содержать объект пресета.");
  }
  const name = String(data.name || "").trim();
  if (!name) throw new Error("В файле нет имени пресета (name).");
  const page = data.page === "batch" ? "batch" : "single";
  let payload;
  if (data.payload && typeof data.payload === "object") {
    payload = data.payload;
  } else {
    const { name: _n, description: _d, page: _p, slug: _s, source: _src, ...rest } = data;
    payload = rest;
  }
  return { name, description: String(data.description || ""), page, payload };
}

function importPreset(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const body = normalizePresetImport(JSON.parse(reader.result));
      await createPreset(body);
      reloadList();
    } catch (e) {
      showErrorCb("Импорт пресета: " + e.message);
    }
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------- диалоги

// Диалог с полями имени и описания. onSubmit(name, description) может бросать —
// текст ошибки уйдёт в общий баннер, диалог останется открытым.
function openDialog({ title, name = "", description = "", submitLabel = "Сохранить",
                      showDescription = true, onSubmit }) {
  closeDialog();
  const overlay = document.createElement("div");
  overlay.className = "preset-dialog-overlay";
  overlay.id = "preset-dialog";
  const box = document.createElement("div");
  box.className = "preset-dialog-box";
  const h = document.createElement("div");
  h.className = "preset-dialog-title";
  h.textContent = title;
  box.appendChild(h);
  const nameIn = document.createElement("input");
  nameIn.className = "mgr-input";
  nameIn.id = "preset-dlg-name";
  nameIn.placeholder = "Имя пресета";
  nameIn.value = name;
  box.appendChild(nameIn);
  const descIn = document.createElement("input");
  descIn.className = "mgr-input";
  descIn.id = "preset-dlg-desc";
  descIn.placeholder = "Описание (необязательно)";
  descIn.value = description;
  if (showDescription) box.appendChild(descIn);
  const row = document.createElement("div");
  row.className = "mgr-actions";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.id = "preset-dlg-ok";
  ok.className = "btn";
  ok.textContent = submitLabel;
  ok.onclick = async () => {
    const n = nameIn.value.trim();
    if (!n) { showErrorCb("Введите имя пресета"); return; }
    try {
      await onSubmit(n, descIn.value.trim());
    } catch (e) {
      showErrorCb(e.message);
      return;
    }
    closeDialog();
  };
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.id = "preset-dlg-cancel";
  cancel.className = "btn";
  cancel.textContent = "Отмена";
  cancel.onclick = closeDialog;
  row.append(ok, cancel);
  box.appendChild(row);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDialog(); });
  document.body.appendChild(overlay);
}

export function closeDialog() {
  const dlg = document.getElementById("preset-dialog");
  if (dlg) dlg.remove();
}

// Снапшот текущего состояния → тело POST /api/presets.
function buildSaveBody(name, description, sourceMode) {
  const questions = withDirections(buildQuestionsPayload());
  let decision = null;
  if (state.decision && state.decision.outcomes && state.decision.outcomes.length) {
    validateDecision(state.decision, state.questions);
    decision = JSON.parse(JSON.stringify(state.decision));
  }
  if (sourceMode === "batch") {
    const files = batchFilesSnapshot();
    if (!files.length) throw new Error("В батче нет файлов — нечего сохранять в пресет.");
    const payload = { questions, files };
    if (decision) payload.decision = decision;
    return { name, description, page: "batch", payload };
  }
  const snap = contextSnapshot();
  const payload = { input_format: snap.input_format, input: snap.input, questions };
  if (snap.images && snap.images.length) payload.images = snap.images;
  if (decision) payload.decision = decision;
  return { name, description, page: "single", payload };
}

// «Сохранить как пресет»: из меню — текущая страница, из менеджера — returnMode.
// prefill — необязательные предзаполненные имя/описание (ассистент).
export function openSaveDialog(sourceMode, prefill) {
  const mode = sourceMode === "batch" || sourceMode === "single"
    ? sourceMode
    : (state.pageMode === "batch" ? "batch" : "single");
  openDialog({
    title: mode === "batch"
      ? "Сохранить пресет: вопросы + файлы батча"
      : "Сохранить пресет: контекст + изображения + вопросы",
    name: prefill?.name || "",
    description: prefill?.description || "",
    onSubmit: async (name, description) => {
      await createPreset(buildSaveBody(name, description, mode));
      reloadList();
    },
  });
}

function openRenameDialog(p) {
  openDialog({
    title: `Переименовать «${p.name}»`,
    name: p.name,
    submitLabel: "Переименовать",
    showDescription: false,
    onSubmit: async (name) => {
      await renamePreset(p.slug, name);
      reloadList();
    },
  });
}
