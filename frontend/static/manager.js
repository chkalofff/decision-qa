// Страница «Модели»: менеджер моделей — статусы и прогресс, скачивание и
// удаление файлов, запуск/остановка, переименование, вкл/выкл в баре,
// роли (прогоны/ассистент), длина контекста sglang,
// облачные модели (base_url + API-ключ), форма добавления и карточка
// «Память» с настройкой бюджета (MODELS_BUDGET_FRACTION).

import { state, subscribe } from "./state.js";
import {
  startModel, stopModel, downloadModel, deleteModelFiles,
  patchModel, createRemoteModel, removeModel, putCredentials, deleteCredentials,
  setBudgetFraction,
} from "./api.js";
import { refreshModels, setPageMode } from "./toolbar.js";
import { CHAT_APIS, isChatRemote } from "./remote.js";

const STATUS_LABELS = {
  not_downloaded: "не скачана",
  stopped: "остановлена",
  starting: "запускается…",
  running: "работает",
  stopping: "останавливается…",
  downloading: "скачивается…",
  error: "ошибка",
  unreachable: "недоступна",
  no_credentials: "нет API-ключа",
};

const TYPE_LABELS = {
  sglang: "SGLang",
  clef: "Clef (MLX)",
  llamacpp: "llama.cpp",
  remote: "облако",
};

const FIT_LABELS = { ok: "влезает", tight: "впритык", no: "не влезает в бюджет" };

const ROLE_LABELS = { decision: "Прогоны", chat: "Ассистент" };
const DEFAULT_CONTEXT_LENGTH = 32768;  // дефолт sglang-раннера, совпадает с backend

// Роли модели из статуса; без поля (старый бэкенд) — только прогоны.
function modelRoles(m) {
  return Array.isArray(m.roles) && m.roles.length ? m.roles : ["decision"];
}

let showErrorCb = () => {};

export function initManager({ showError } = {}) {
  showErrorCb = showError || showErrorCb;
  buildAddForm();
  subscribe((event) => {
    if (event !== "models" || state.pageMode !== "models") return;
    // Не перерендериваем, пока пользователь печатает в полях карточек/формы —
    // иначе поллинг уничтожит поле под курсором. Кнопки не считаются: после
    // клика по «Остановить» и т.п. карточка должна обновиться сразу.
    const page = document.getElementById("page-models");
    const ae = document.activeElement;
    if (page.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    renderManager();
  });
  renderManager();
}

async function action(fn) {
  try {
    await fn();
  } catch (e) {
    showErrorCb(e.message);
  }
  refreshModels();
}

// ---------------------------------------------------------------- рендер

function renderManager() {
  const page = document.getElementById("page-models");
  page.innerHTML = "";

  const head = document.createElement("section");
  head.className = "card";
  const headRow = document.createElement("div");
  headRow.className = "section-head";
  const h2 = document.createElement("h2");
  h2.textContent = "Модели";
  headRow.appendChild(h2);
  const back = document.createElement("button");
  back.type = "button";
  back.id = "btn-models-back";
  back.className = "btn btn-small";
  back.textContent = "← К прогону";
  back.title = "Вернуться к основной странице";
  back.onclick = () => setPageMode("single");
  headRow.appendChild(back);
  head.appendChild(headRow);
  const dev = state.device;
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = `Устройство: RAM ${dev ? Math.round(dev.ram_gb) : "?"} ГБ · бюджет моделей ${dev ? Math.round(dev.budget_gb) : "?"} ГБ (MODELS_BUDGET_FRACTION). Отключённые модели не показываются в верхнем баре и не участвуют в прогонах.`;
  head.appendChild(hint);
  page.appendChild(head);

  page.appendChild(memoryCard());

  for (const m of state.models) {
    page.appendChild(m.managed ? localCard(m) : remoteCard(m));
  }

  page.appendChild(addFormCard);
}

// ---------------------------------------------------------------- карточка «Память»

const DEFAULT_BUDGET_FRACTION = 0.65;
const BUDGET_SLIDER_MIN = 0.3;
const BUDGET_SLIDER_MAX = 0.95;
const BUDGET_SLIDER_STEP = 0.05;

function memoryCard() {
  const card = document.createElement("section");
  card.className = "card mgr-card";
  card.id = "memory-card";

  const title = document.createElement("h2");
  title.textContent = "Память";
  card.appendChild(title);

  const dev = state.device;
  const fraction = dev && dev.ram_gb
    ? dev.budget_gb / dev.ram_gb
    : DEFAULT_BUDGET_FRACTION;
  const current = document.createElement("div");
  current.className = "mgr-status";
  current.id = "memory-current";
  current.textContent = dev
    ? `Бюджет моделей: ${Math.round(dev.budget_gb)} ГБ из ${Math.round(dev.ram_gb)} ГБ RAM (${Math.round(fraction * 100)}%)`
    : "Бюджет моделей: данные устройства ещё не загружены";
  card.appendChild(current);

  const sliderRow = document.createElement("div");
  sliderRow.className = "mgr-actions";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.id = "budget-slider";
  slider.min = String(BUDGET_SLIDER_MIN);
  slider.max = String(BUDGET_SLIDER_MAX);
  slider.step = String(BUDGET_SLIDER_STEP);
  slider.value = String(Math.round(fraction / BUDGET_SLIDER_STEP) * BUDGET_SLIDER_STEP);
  slider.title = "Доля RAM под бюджет моделей";
  const value = document.createElement("span");
  value.id = "budget-value";
  const syncValue = () => {
    value.textContent = `${Math.round(parseFloat(slider.value) * 100)}%`;
  };
  slider.addEventListener("input", syncValue);
  syncValue();
  sliderRow.appendChild(slider);
  sliderRow.appendChild(value);
  const applyBtn = btn("Применить", () => setBudgetFraction(parseFloat(slider.value)));
  applyBtn.id = "btn-budget-apply";
  sliderRow.appendChild(applyBtn);
  const resetBtn = btn("Сбросить", () => {
    slider.value = String(DEFAULT_BUDGET_FRACTION);
    syncValue();
    return setBudgetFraction(DEFAULT_BUDGET_FRACTION);
  }, { title: `Вернуть значение по умолчанию (${Math.round(DEFAULT_BUDGET_FRACTION * 100)}%)` });
  resetBtn.id = "btn-budget-reset";
  sliderRow.appendChild(resetBtn);
  card.appendChild(sliderRow);

  const warn = document.createElement("div");
  warn.className = "hint mgr-warn";
  warn.textContent = "Изменение на свой страх и риск: высокие значения могут привести к свопу и зависанию системы.";
  card.appendChild(warn);
  return card;
}

// ---------------------------------------------------------------- общие части карточек

function badge(text, cls = "") {
  const b = document.createElement("span");
  b.className = "mgr-badge " + cls;
  b.textContent = text;
  return b;
}

function statusLine(m) {
  const div = document.createElement("div");
  div.className = "mgr-status";
  const dot = document.createElement("span");
  dot.className = "status-dot dot-" + m.status;
  div.appendChild(dot);
  const text = document.createElement("span");
  text.textContent = " " + (STATUS_LABELS[m.status] || m.status);
  div.appendChild(text);
  if (m.status === "downloading") {
    const wrap = document.createElement("div");
    wrap.className = "mgr-progress";
    const fill = document.createElement("div");
    fill.className = "mgr-progress-fill";
    const pct = m.progress != null ? Math.round(m.progress * 100) : 0;
    fill.style.width = pct + "%";
    wrap.appendChild(fill);
    div.appendChild(wrap);
    const note = document.createElement("span");
    note.className = "hint";
    note.textContent = m.dl_done_gb != null && m.download_gb
      ? ` ≈${pct}% (${m.dl_done_gb.toFixed(1)} / ≈${m.download_gb} ГБ)`
      : ` ≈${pct}%`;
    div.appendChild(note);
  }
  if (m.rss_gb != null) {
    div.appendChild(badge(`RSS ${m.rss_gb.toFixed(1)} ГБ`));
  }
  return div;
}

function errorLine(m) {
  if (m.status !== "error" || !m.error) return null;
  const err = document.createElement("div");
  err.className = "mp-error";
  err.textContent = m.error;
  return err;
}

function btn(label, onclick, { danger = false, disabled = false, title = "" } = {}) {
  const b = document.createElement("button");
  b.className = "btn btn-small" + (danger ? " btn-danger" : "");
  b.textContent = label;
  b.disabled = disabled;
  if (title) b.title = title;
  b.onclick = () => action(onclick);
  return b;
}

function textInput(value, placeholder, onSave, { type = "text", title = "" } = {}) {
  const input = document.createElement("input");
  input.type = type;
  input.className = "mgr-input";
  input.value = value || "";
  input.placeholder = placeholder;
  if (title) input.title = title;
  const save = () => {
    const v = input.value.trim();
    if (v !== (value || "")) action(() => onSave(v));
  };
  input.addEventListener("change", save);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  return input;
}

function enabledToggle(m) {
  const label = document.createElement("label");
  label.className = "mgr-enabled";
  label.title = "Показывать модель в верхнем баре и разрешать прогоны";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = m.enabled;
  cb.addEventListener("change", () => action(() => patchModel(m.key, { enabled: cb.checked })));
  label.appendChild(cb);
  label.appendChild(document.createTextNode(" в баре"));
  return label;
}

// Бейджи ролей в шапке карточки: «Прогоны» / «Ассистент».
function roleBadges(m) {
  return modelRoles(m).map(r => badge(ROLE_LABELS[r] || r, "mgr-role"));
}

// Чекбоксы ролей: модель должна сохранить хотя бы одну — иначе откат чекбокса.
function rolesEditor(m) {
  const wrap = document.createElement("div");
  wrap.className = "mgr-actions mgr-roles";
  const caption = document.createElement("span");
  caption.className = "hint";
  caption.textContent = "Роли:";
  wrap.appendChild(caption);
  for (const role of ["decision", "chat"]) {
    const label = document.createElement("label");
    label.className = "mgr-enabled";
    label.title = role === "decision"
      ? "Модель участвует в прогонах (чипы верхнего бара)"
      : "Модель доступна AI-ассистенту (chat completions)";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.role = role;
    cb.checked = modelRoles(m).includes(role);
    cb.addEventListener("change", () => {
      const roles = [...wrap.querySelectorAll("input[data-role]")]
        .filter(c => c.checked).map(c => c.dataset.role);
      if (!roles.length) {
        cb.checked = true;
        showErrorCb("Нужна хотя бы одна роль");
        return;
      }
      action(() => patchModel(m.key, { roles }));
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + (ROLE_LABELS[role] || role)));
    wrap.appendChild(label);
  }
  return wrap;
}

// Числовое поле «Контекст (токенов)» для sglang-моделей: пусто = дефолт 32768;
// значения выше дефолта — с предупреждением о росте потребления памяти.
function contextEditor(m) {
  const wrap = document.createElement("div");
  wrap.className = "mgr-actions mgr-context";
  const caption = document.createElement("label");
  caption.className = "hint";
  caption.textContent = "Контекст (токенов):";
  const input = document.createElement("input");
  input.type = "number";
  input.className = "mgr-input mgr-context-input";
  input.min = "1024";
  input.step = "1024";
  input.placeholder = String(DEFAULT_CONTEXT_LENGTH);
  input.value = m.context_length != null ? String(m.context_length) : "";
  input.title = "Длина контекста sglang-сервера; пусто — дефолт " + DEFAULT_CONTEXT_LENGTH;
  caption.appendChild(input);
  wrap.appendChild(caption);
  const warn = document.createElement("span");
  warn.className = "hint mgr-warn mgr-context-warn hidden";
  warn.textContent = "рост потребления памяти, на свой риск";
  wrap.appendChild(warn);
  const syncWarn = () => {
    warn.classList.toggle("hidden", !(parseInt(input.value, 10) > DEFAULT_CONTEXT_LENGTH));
  };
  input.addEventListener("input", syncWarn);
  input.addEventListener("change", () => {
    const v = input.value.trim();
    if (v === "") {
      if (m.context_length != null) action(() => patchModel(m.key, { context_length: null }));
      return;
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1024) {
      showErrorCb("Контекст — целое число токенов не меньше 1024");
      input.value = m.context_length != null ? String(m.context_length) : "";
      syncWarn();
      return;
    }
    if (n !== m.context_length) action(() => patchModel(m.key, { context_length: n }));
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  syncWarn();
  return wrap;
}

// ---------------------------------------------------------------- локальная модель

function localCard(m) {
  const card = document.createElement("section");
  card.className = "card mgr-card";

  const head = document.createElement("div");
  head.className = "mgr-head";
  head.appendChild(textInput(m.label, "Название", (v) => patchModel(m.key, { label: v })));
  head.appendChild(textInput(m.short_label, "Короткое", (v) => patchModel(m.key, { short_label: v }),
    { title: "Короткое имя для чипа в верхнем баре" }));
  head.appendChild(badge(TYPE_LABELS[m.type] || m.type));
  for (const b of roleBadges(m)) head.appendChild(b);
  if (m.fit) head.appendChild(badge(FIT_LABELS[m.fit] || m.fit, "mgr-fit-" + m.fit));
  const vb = badge(m.vision ? "🖼" : "без картинок", m.vision ? "mgr-vision" : "mgr-novision");
  vb.title = m.vision ? "понимает изображения" : "текст-only, изображения не поддерживает";
  head.appendChild(vb);
  card.appendChild(head);

  const meta = document.createElement("div");
  meta.className = "mgr-meta hint";
  meta.textContent = [m.hf_id, `порт ${m.port}`,
    m.peak_gb != null ? `пик ~${Math.round(m.peak_gb)} ГБ` : null,
    m.download_gb != null ? `образ ≈${m.download_gb} ГБ` : null,
    `server/logs/${m.key}.log`].filter(Boolean).join(" · ");
  card.appendChild(meta);

  card.appendChild(statusLine(m));
  const err = errorLine(m);
  if (err) card.appendChild(err);

  const actions = document.createElement("div");
  actions.className = "mgr-actions";
  const busy = m.status === "starting" || m.status === "stopping" || m.status === "downloading";
  if (m.status === "not_downloaded" || m.status === "error") {
    actions.appendChild(btn(`Скачать${m.download_gb ? ` ≈${m.download_gb} ГБ` : ""}`,
      () => downloadModel(m.key)));
  }
  actions.appendChild(btn("Запустить", () => startModel(m.key),
    { disabled: m.status === "running" || busy || m.status === "not_downloaded" || m.fit === "no",
      title: m.fit === "no" ? "Модель не влезает в бюджет памяти этого устройства" : "" }));
  actions.appendChild(btn("Остановить", () => stopModel(m.key),
    { danger: true, disabled: m.status !== "running" && m.status !== "starting" }));
  if (m.status === "stopped") {
    actions.appendChild(btn("Удалить файлы", async () => {
      if (!confirm(`Удалить скачанные файлы модели «${m.label}» из HF-кэша?`)) return;
      await deleteModelFiles(m.key);
    }, { danger: true }));
  }
  actions.appendChild(enabledToggle(m));
  card.appendChild(actions);
  card.appendChild(rolesEditor(m));
  if (m.type === "sglang") card.appendChild(contextEditor(m));
  return card;
}

// ---------------------------------------------------------------- облачная модель

function remoteCard(m) {
  const card = document.createElement("section");
  card.className = "card mgr-card";

  const head = document.createElement("div");
  head.className = "mgr-head";
  head.appendChild(textInput(m.label, "Название", (v) => patchModel(m.key, { label: v })));
  head.appendChild(textInput(m.short_label, "Короткое", (v) => patchModel(m.key, { short_label: v }),
    { title: "Короткое имя для чипа в верхнем баре" }));
  head.appendChild(badge(TYPE_LABELS.remote));
  for (const b of roleBadges(m)) head.appendChild(b);
  head.appendChild(badge(isChatRemote(m) ? `chat: ${m.api}` :
    m.api === "systemone" ? "/v1/systemone" : "/v1/decisions"));
  const vb = badge(m.vision ? "🖼" : "без картинок", m.vision ? "mgr-vision" : "mgr-novision");
  vb.title = m.vision ? "понимает изображения" : "текст-only, изображения не поддерживает";
  head.appendChild(vb);
  card.appendChild(head);

  const meta = document.createElement("div");
  meta.className = "mgr-meta";
  meta.appendChild(textInput(m.base_url, "https://…", (v) => patchModel(m.key, { base_url: v }),
    { title: "Базовый URL сервера (без /v1/…)" }));
  card.appendChild(meta);

  card.appendChild(statusLine(m));

  const credRow = document.createElement("div");
  credRow.className = "mgr-actions";
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.className = "mgr-input";
  keyInput.placeholder = m.has_credentials ? "API-ключ сохранён — введите новый" : "API-ключ";
  keyInput.autocomplete = "off";
  credRow.appendChild(keyInput);
  credRow.appendChild(btn("Сохранить ключ", async () => {
    const v = keyInput.value.trim();
    if (!v) { showErrorCb("Введите API-ключ"); return; }
    await putCredentials(m.key, v);
    keyInput.value = "";
  }));
  if (m.has_credentials) {
    credRow.appendChild(btn("Удалить ключ", () => deleteCredentials(m.key), { danger: true }));
  }
  card.appendChild(credRow);

  const actions = document.createElement("div");
  actions.className = "mgr-actions";
  actions.appendChild(btn("Удалить модель", async () => {
    if (!confirm(`Удалить облачную модель «${m.label}» из реестра?`)) return;
    await removeModel(m.key);
  }, { danger: true }));
  actions.appendChild(enabledToggle(m));
  card.appendChild(actions);
  card.appendChild(rolesEditor(m));
  return card;
}

// ---------------------------------------------------------------- форма добавления облачной

let addFormCard = null;

function buildAddForm() {
  addFormCard = document.createElement("section");
  addFormCard.className = "card mgr-card";

  const title = document.createElement("h2");
  title.textContent = "Добавить облачную модель";
  addFormCard.appendChild(title);
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.id = "model-add-hint";
  addFormCard.appendChild(hint);

  const form = document.createElement("div");
  form.className = "mgr-form";
  const labelIn = document.createElement("input");
  labelIn.className = "mgr-input";
  labelIn.id = "model-add-label";
  labelIn.placeholder = "Название (например, GPT-4o mini)";
  const apiSel = document.createElement("select");
  apiSel.className = "mgr-input";
  apiSel.id = "model-add-api";
  for (const [v, t] of [
    ["openrouter", "OpenRouter (chat)"],
    ["openai", "OpenAI (chat)"],
    ["clef", "Clef cloud — ai.1lab.club (chat)"],
    ["systemone", "SystemOne — облако или свой сервер"],
    ["laya", "Laya cloud (chat)"],
    ["decisions", "Свой сервер: SGLang /v1/decisions"],
  ]) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = t;
    apiSel.appendChild(opt);
  }
  const urlIn = document.createElement("input");
  urlIn.className = "mgr-input";
  urlIn.id = "model-add-base-url";
  const modelIn = document.createElement("input");
  modelIn.className = "mgr-input";
  modelIn.id = "model-add-name-input";
  const keyIn = document.createElement("input");
  keyIn.className = "mgr-input";
  keyIn.type = "password";
  keyIn.autocomplete = "off";
  keyIn.placeholder = "API-ключ (необязательно, если задан env)";

  // Для chat API base_url необязателен (дефолт провайдера), api_model нужен;
  // для decisions — нужен base_url своего сервера; systemone покрывает оба
  // случая: пустой base_url → облако api.system1.cloud, иначе протокол.
  const syncForm = () => {
    const api = apiSel.value;
    const chat = api in CHAT_APIS;
    urlIn.placeholder = chat
      ? `base_url (необязательно, дефолт ${CHAT_APIS[api].baseUrl})`
      : "base_url, https://host:port";
    modelIn.placeholder = chat
      ? "Имя модели у провайдера (api_model, обязательно)"
      : "api_model (необязательно: clef-flash, laya…)";
    hint.textContent = chat
      ? `Облачный chat API ${CHAT_APIS[api].label}: OpenAI-совместимый /chat/completions. Модель участвует в прогонах, ассистенте и генерации вопросов.`
      : api === "decisions"
        ? "Удалённый сервер нашего протокола: SGLang /v1/decisions. Локальные модели добавляются правкой backend/models_config.json."
        : "SystemOne: пустой base_url — облако api.system1.cloud (chat); укажите base_url своего сервера — протокол /v1/systemone (clef/laya).";
  };
  apiSel.addEventListener("change", syncForm);
  syncForm();

  const submit = document.createElement("button");
  submit.className = "btn";
  submit.textContent = "Добавить";
  submit.onclick = () => action(async () => {
    const data = {
      label: labelIn.value.trim(),
      api: apiSel.value,
      api_model: modelIn.value.trim() || undefined,
      api_key: keyIn.value.trim() || undefined,
    };
    const url = urlIn.value.trim();
    if (url) data.base_url = url;
    await createRemoteModel(data);
    labelIn.value = urlIn.value = modelIn.value = keyIn.value = "";
  });
  for (const el of [labelIn, apiSel, urlIn, modelIn, keyIn, submit]) form.appendChild(el);
  addFormCard.appendChild(form);
}
