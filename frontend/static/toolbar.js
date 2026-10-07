// Верхний рабочий бар: чипы запиненных моделей (статусы, выбор, поповер запуска),
// дропдаун «Модели ▾» (пины, переход в настройки), сегмент страницы,
// поповер настроек запуска (режим + температура) у кнопки Run, меню.

import { state, emit, subscribe, selectedModelKeys, initPinnedModels, togglePinnedModel } from "./state.js";
import { getModels, startModel, stopModel, downloadModel, getPresets } from "./api.js";
import { setAllCollapsed } from "./questions.js";
import { modelShortLabel, showTip, hideTip } from "./results.js";

const STATUS_LABELS = {
  not_downloaded: "не скачана",
  stopped: "остановлена",
  starting: "запускается",
  running: "работает",
  stopping: "останавливается",
  downloading: "скачивается",
  error: "ошибка",
  unreachable: "недоступна",
  no_credentials: "нет API-ключа",
};

// Статусы, при которых опрашиваем бэкенд чаще — иначе пользователь не видит
// завершения запуска/остановки/скачивания без ручного рефреша.
const ACTIVE_STATUSES = new Set(["starting", "stopping", "downloading"]);

// Подсказка на disabled-чекбоксе чипа по статусу модели.
const CHIP_DISABLED_TITLES = {
  no_credentials: "Задайте API-ключ в настройках модели",
  unreachable: "Облачная модель недоступна — проверьте base_url и ключ в настройках",
};

const NO_MODEL_TOOLTIP = "запустите хотя бы одну модель — кнопкой в чипе";

// Размещение модели для hover-инфо: локальные типы vs облако.
const LOCAL_TYPES = new Set(["sglang", "clef", "llamacpp"]);
function placementLabel(m) {
  return LOCAL_TYPES.has(m.type) ? "локально (MLX/GGUF)" : "облако";
}

// Роль "decision": модель участвует в прогонах (чипы, авто-выбор).
// Модели только с ролью "chat" обслуживают ассистента и в бар не попадают.
// Без поля roles (старый бэкенд) считаем модель прогонной.
function decisionRole(m) {
  return !Array.isArray(m.roles) || m.roles.includes("decision");
}

// Hover-инфо по чипу модели: имя, статус, размещение, память, vision, порт/URL.
// Данные — из уже загруженного state.models (ответ /api/models), без запросов.
function showChipTip(m, chip) {
  showTip(chip, (tip) => {
    const title = document.createElement("div");
    title.className = "dist-tip-title";
    title.textContent = m.label || m.key;
    tip.appendChild(title);
    const lines = [
      `Статус: ${STATUS_LABELS[m.status] || m.status}`,
      `Размещение: ${placementLabel(m)}`,
    ];
    if (m.peak_gb != null) lines.push(`Пик памяти: ~${Math.round(m.peak_gb)} ГБ`);
    if (LOCAL_TYPES.has(m.type) && m.download_gb != null) {
      lines.push(`Скачивание: ≈${m.download_gb} ГБ`);
    }
    lines.push(m.vision ? "🖼 понимает изображения" : "без поддержки изображений");
    if (m.port != null) lines.push(`Порт: ${m.port}`);
    else if (m.base_url) lines.push(`URL: ${m.base_url}`);
    const body = document.createElement("div");
    body.className = "chip-tip-lines";
    body.textContent = lines.join("\n");
    tip.appendChild(body);
  });
}

const RUNMODE_SUFFIX = { decisions: "обычный", fast_batch: "быстрый", both: "оба" };
const FORMAT_BANNER_DEFAULT = "Сервер сменил формат промпта.";

let onRunCb = () => {};
let onPageModeCb = () => {};
let applyPresetCb = () => {};
let onErrorCb = () => {};
let onExportQuestionsCb = () => {};
let onExportContextCb = () => {};
let onExportAllCb = () => {};
let onImportFileCb = () => {};
let onPresetsManagerCb = () => {};
let onSavePresetCb = () => {};
let pollTimer = null;

export function initToolbar({ onRun, onPageMode, applyPreset, showError, onExportQuestions, onExportContext, onExportAll, onImportFile, onPresetsManager, onSavePreset }) {
  onRunCb = onRun || onRunCb;
  onPageModeCb = onPageMode || onPageModeCb;
  applyPresetCb = applyPreset || applyPresetCb;
  onErrorCb = showError || onErrorCb;
  onExportQuestionsCb = onExportQuestions || onExportQuestionsCb;
  onExportContextCb = onExportContext || onExportContextCb;
  onExportAllCb = onExportAll || onExportAllCb;
  onImportFileCb = onImportFile || onImportFileCb;
  onPresetsManagerCb = onPresetsManager || onPresetsManagerCb;
  onSavePresetCb = onSavePreset || onSavePresetCb;

  initRunModeSeg();
  initTempControls();
  initRunPopover();
  initModelsMenu();
  initMenu();
  initPageModeSeg();

  document.getElementById("tb-run").addEventListener("click", () => onRunCb());
  subscribe((event) => {
    if (event === "batch" || event === "images") {
      renderChips();  // подсветка non-vision чипов при прикреплённых изображениях
      refreshRunButton();
    }
  });

  poll();
  refreshRunButton();
}

// ---------------------------------------------------------------- модели: опрос

// Немедленный внеплановый опрос — страница «Модели» дёргает его после действий.
export function refreshModels() {
  poll();
}

async function poll() {
  clearTimeout(pollTimer);
  try {
    const data = await getModels();
    const models = data.models || [];
    state.models = models;
    state.device = data.device || null;
    initPinnedModels(models.filter(m => m.enabled !== false && decisionRole(m)).map(m => m.key));
    // авто-выбор всех running при первом появлении; дальше выбор запоминается
    const selected = new Set();
    for (const m of models) {
      if (m.status === "running" && m.enabled !== false && decisionRole(m) && (!state._seenModels || !state._seenModels.has(m.key) || state.selectedModels.has(m.key))) {
        selected.add(m.key);
      }
    }
    state._seenModels = new Set(models.map(m => m.key));
    state.selectedModels = selected;
    renderChips();
    if (!document.getElementById("tb-models-dropdown").classList.contains("hidden")) renderModelsMenu();
    emit("models");
    refreshRunButton();
    const anyActive = models.some(m => ACTIVE_STATUSES.has(m.status));
    pollTimer = setTimeout(poll, anyActive ? 2000 : 15000);
  } catch (e) {
    onErrorCb(e.message);
    pollTimer = setTimeout(poll, 15000);
  }
}

// ---------------------------------------------------------------- модели: чипы

function renderChips() {
  hideTip(); // чипы пересоздаются — висящий тултип со ссылкой на старый чип недопустим
  const wrap = document.getElementById("tb-models");
  wrap.innerHTML = "";
  // Отключённые в менеджере и chat-only модели в баре прогонов не показываем
  const enabled = state.models.filter(m => m.enabled !== false && decisionRole(m));
  if (enabled.length === 0) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tb-btn";
    btn.textContent = "Модели…";
    btn.title = "Открыть менеджер моделей";
    btn.addEventListener("click", () => setPageMode("models"));
    wrap.appendChild(btn);
    return;
  }
  const visible = enabled.filter(m => state.pinnedModels.has(m.key));
  if (visible.length === 0) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tb-btn";
    btn.id = "tb-models-pick";
    btn.textContent = "Выбрать модели…";
    btn.title = "Ни одна модель не закреплена в баре — выберите в списке";
    btn.addEventListener("click", () => openModelsMenu());
    wrap.appendChild(btn);
    return;
  }
  for (const m of visible) {
    const chip = document.createElement("span");
    chip.className = "model-chip";
    chip.title = m.label || m.key;

    const dot = document.createElement("span");
    dot.className = "status-dot dot-" + m.status;
    dot.title = STATUS_LABELS[m.status] || m.status;
    chip.appendChild(dot);

    const name = document.createElement("span");
    name.className = "chip-name";
    name.textContent = modelShortLabel(m.key);
    if (m.status === "downloading" && m.progress != null) {
      name.textContent += ` ≈${Math.round(m.progress * 100)}%`;
    }
    chip.appendChild(name);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "chip-check";
    cb.title = m.status === "running" ? "Использовать в прогоне"
      : (CHIP_DISABLED_TITLES[m.status] || "модель не запущена");
    cb.disabled = m.status !== "running";
    cb.checked = m.status === "running" && state.selectedModels.has(m.key);
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      if (cb.checked) state.selectedModels.add(m.key);
      else state.selectedModels.delete(m.key);
      emit("models");
      refreshRunButton();
    });
    chip.appendChild(cb);

    if (m.vision) {
      const vb = document.createElement("span");
      vb.className = "vision-badge";
      vb.textContent = "🖼";
      vb.title = "понимает изображения";
      chip.appendChild(vb);
    } else {
      chip.title = (m.label || m.key) + " — без поддержки изображений";
    }
    // Бейдж на выбранном non-vision чипе при прикреплённых изображениях —
    // такая модель будет пропущена при прогоне с картинками.
    if (!m.vision && cb.checked && hasImagesAttached()) {
      const nb = document.createElement("span");
      nb.className = "novision-badge";
      nb.textContent = "🚫🖼";
      nb.title = "Не поддерживает изображения — будет пропущена при прогоне с картинками";
      chip.appendChild(nb);
    }

    chip.addEventListener("mouseenter", () => showChipTip(m, chip));
    chip.addEventListener("mouseleave", hideTip);
    chip.addEventListener("click", (e) => {
      if (e.target === cb) return;
      hideTip();
      openModelPopover(m, chip);
    });
    wrap.appendChild(chip);
  }
}

// ---------------------------------------------------------------- модели: дропдаун «Модели ▾»

const modelsDropdown = () => document.getElementById("tb-models-dropdown");

function openModelsMenu() {
  renderModelsMenu();
  modelsDropdown().classList.remove("hidden");
}

function closeModelsMenu() {
  modelsDropdown().classList.add("hidden");
}

function renderModelsMenu() {
  const list = document.getElementById("tb-models-dropdown-list");
  list.innerHTML = "";
  const enabled = state.models.filter(m => m.enabled !== false && decisionRole(m));
  if (enabled.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-item menu-item-disabled";
    empty.textContent = "Нет включённых моделей";
    list.appendChild(empty);
    return;
  }
  for (const m of enabled) {
    const row = document.createElement("label");
    row.className = "menu-item models-menu-item";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "pin-check";
    cb.title = "показывать в баре";
    cb.checked = state.pinnedModels.has(m.key);
    cb.addEventListener("change", () => {
      togglePinnedModel(m.key);
      renderChips();
      refreshRunButton();
    });
    row.appendChild(cb);

    const dot = document.createElement("span");
    dot.className = "status-dot dot-" + m.status;
    dot.title = STATUS_LABELS[m.status] || m.status;
    row.appendChild(dot);

    const name = document.createElement("span");
    name.className = "models-menu-name";
    name.textContent = modelShortLabel(m.key);
    name.title = m.vision ? (m.label || m.key) : (m.label || m.key) + " — без картинок";
    row.appendChild(name);

    if (m.vision) {
      const vb = document.createElement("span");
      vb.className = "vision-badge";
      vb.textContent = "🖼";
      vb.title = "понимает изображения";
      row.appendChild(vb);
    }

    list.appendChild(row);
  }
}

function initModelsMenu() {
  document.getElementById("tb-models-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    if (modelsDropdown().classList.contains("hidden")) openModelsMenu();
    else closeModelsMenu();
  });
  document.getElementById("tb-models-settings").addEventListener("click", () => {
    closeModelsMenu();
    setPageMode("models");
  });
}

// ---------------------------------------------------------------- модели: поповер

let openPopover = null;

function closeModelPopover() {
  if (openPopover) {
    openPopover.classList.add("hidden");
    openPopover = null;
  }
}

function openModelPopover(model, anchor) {
  const pop = document.getElementById("model-popover");
  pop.innerHTML = "";

  const title = document.createElement("div");
  title.className = "mp-title";
  title.textContent = model.label || model.key;
  pop.appendChild(title);

  let statusText = "Статус: " + (STATUS_LABELS[model.status] || model.status);
  if (model.status === "downloading") {
    statusText += model.progress != null ? ` ≈${Math.round(model.progress * 100)}%` : "";
    if (model.dl_done_gb != null && model.download_gb) {
      statusText += ` (${model.dl_done_gb.toFixed(1)} / ≈${model.download_gb} ГБ)`;
    }
  }
  if (model.managed && model.peak_gb != null) statusText += ` · пик ~${Math.round(model.peak_gb)} ГБ`;
  if (model.rss_gb != null) statusText += ` · RSS ${model.rss_gb.toFixed(1)} ГБ`;
  const status = document.createElement("div");
  status.className = "mp-line";
  status.textContent = statusText;
  pop.appendChild(status);

  if (model.status === "error" && model.error) {
    const err = document.createElement("div");
    err.className = "mp-error";
    err.textContent = model.error;
    pop.appendChild(err);
  }

  if (model.managed) {
    const log = document.createElement("div");
    log.className = "mp-log";
    log.textContent = `server/logs/${model.key}.log`;
    log.title = "Путь к логу на сервере";
    pop.appendChild(log);
  } else {
    const url = document.createElement("div");
    url.className = "mp-log";
    url.textContent = model.base_url || "";
    url.title = "Базовый URL облачной модели";
    pop.appendChild(url);
  }

  const actions = document.createElement("div");
  actions.className = "mp-actions";
  const addBtn = (label, onclick, { danger = false, disabled = false } = {}) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-small" + (danger ? " btn-danger" : "");
    btn.textContent = label;
    btn.disabled = disabled;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await onclick();
        closeModelPopover();
        poll();
      } catch (e) {
        onErrorCb(e.message);
        btn.disabled = false;
      }
    };
    actions.appendChild(btn);
  };
  if (model.managed) {
    if (model.status === "not_downloaded" || model.status === "error") {
      addBtn("Скачать", () => downloadModel(model.key));
    }
    if (model.status === "stopped" || model.status === "error") {
      addBtn("Запустить", () => startModel(model.key));
    }
    if (model.status === "running" || model.status === "starting") {
      addBtn("Остановить", () => stopModel(model.key), { danger: true });
    }
    if (model.status === "stopping") addBtn("Останавливается…", () => {}, { disabled: true });
    if (model.status === "downloading") addBtn("Скачивается…", () => {}, { disabled: true });
  }
  const mgr = document.createElement("button");
  mgr.className = "btn btn-small";
  mgr.textContent = "Настроить…";
  mgr.title = "Открыть менеджер моделей";
  mgr.onclick = () => { closeModelPopover(); setPageMode("models"); };
  actions.appendChild(mgr);
  pop.appendChild(actions);

  pop.classList.remove("hidden");
  openPopover = pop;

  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth || 300;
  pop.style.left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - pw - 8)) + "px";
  pop.style.top = (r.bottom + 6) + "px";
}

// ---------------------------------------------------------------- режим прогона и температура

// Температура не применяется, если выбраны только SystemOne-модели
// (clef/laya/облачные — детерминированы, сэмплинга нет).
function onlyClefSelected() {
  const keys = selectedModelKeys();
  return keys.length > 0 && keys.every(k => state.models.find(m => m.key === k)?.api === "systemone");
}

// Быстрый батч поддерживают только SGLang-модели (api !== "systemone").
function sglangSelected() {
  return selectedModelKeys().some(k => state.models.find(m => m.key === k)?.api !== "systemone");
}

// Прикреплены ли изображения: в одиночном — к контексту, в батче — image-файлы.
function hasImagesAttached() {
  if (state.pageMode === "batch") return state.batch.files.some(f => f.isImage);
  return state.contextImages.length > 0;
}

let runModeBannerTimer = null;

// Автопереключение режима: показываем format-banner на ~5 с.
function showRunModeBanner(text) {
  const banner = document.getElementById("format-banner");
  const textEl = document.getElementById("format-banner-text");
  if (!banner || !textEl) return;
  textEl.textContent = text ||
    "Режим переключён на «Обычный»: выбранные модели не поддерживают быстрый прогон";
  const reset = document.getElementById("btn-reset-pin");
  if (reset) reset.classList.add("hidden");
  banner.classList.remove("hidden");
  clearTimeout(runModeBannerTimer);
  runModeBannerTimer = setTimeout(() => {
    banner.classList.add("hidden");
    textEl.textContent = FORMAT_BANNER_DEFAULT;
    if (reset) reset.classList.remove("hidden");
  }, 5000);
}

// Предупреждение о non-vision моделях при прикреплённых изображениях — по фронту
// изменения (edge-triggered), чтобы не пересаживать баннер на каждый поллинг.
let lastNoVisionSig = "";

function checkNoVisionWarning() {
  const sig = hasImagesAttached()
    ? selectedModelKeys().filter(k => !state.models.find(m => m.key === k)?.vision).sort().join(",")
    : "";
  if (sig && sig !== lastNoVisionSig) {
    const names = sig.split(",").map(k => modelShortLabel(k)).join(", ");
    showRunModeBanner(
      `Модель ${names} не поддерживает изображения — она будет пропущена при прогоне с картинками`);
  }
  lastNoVisionSig = sig;
}

// Доступность контролов запуска: режим (нужны SGLang-модели) и температура.
// Вызывается из refreshRunButton — то есть на каждый поллинг статусов,
// изменение чекбоксов моделей и переключение страниц, — и из setRunMode.
function updateRunControls() {
  const keys = selectedModelKeys();
  const hasSglang = sglangSelected();
  const withImages = hasImagesAttached();
  const fastDisabled = keys.length === 0 || !hasSglang || withImages;
  const fastTitle = withImages
    ? "Быстрый режим не поддерживает изображения"
    : keys.length === 0
      ? "сначала выберите работающую модель"
      : "Быстрый режим поддерживают только SGLang-модели";
  for (const btn of document.querySelectorAll("#tb-runmode button")) {
    if (btn.dataset.runmode === "decisions") continue;
    btn.disabled = fastDisabled;
    btn.title = fastDisabled ? fastTitle : "";
  }
  // Текущий режим стал невалидным (sglang-моделей не осталось / появились картинки) —
  // назад в «Обычный».
  if (keys.length > 0 && state.runMode !== "decisions" && (!hasSglang || withImages)) {
    setRunMode("decisions");
    showRunModeBanner(withImages
      ? "Режим переключён на «Обычный»: быстрый режим не поддерживает изображения"
      : null);
  }
  checkNoVisionWarning();

  const lockedByMode = state.runMode !== "decisions";
  const lockedByClef = !lockedByMode && onlyClefSelected();
  const locked = lockedByMode || lockedByClef;
  const reason = lockedByMode
    ? "в быстром режиме всегда 0"
    : lockedByClef
      ? "Clef детерминирована — температура не применяется"
      : "";
  const slider = document.getElementById("temperature");
  if (slider) { slider.disabled = locked; slider.title = reason; }
  for (const b of document.querySelectorAll("#run-popover [data-temp]")) {
    b.disabled = locked;
    b.title = reason;
  }
  const note = document.getElementById("temp-lock-note");
  if (note) {
    note.textContent = reason;
    note.classList.toggle("hidden", !locked);
  }

  // Подпись кнопки запуска отражает выбранный режим.
  const runBtn = document.getElementById("tb-run");
  if (runBtn) {
    runBtn.textContent = "▶ Запустить";
    const suffix = document.createElement("span");
    suffix.className = "tb-run-mode";
    suffix.textContent = ` (${RUNMODE_SUFFIX[state.runMode] || state.runMode})`;
    runBtn.appendChild(suffix);
  }
}

function setRunMode(mode) {
  state.runMode = mode;
  for (const btn of document.querySelectorAll("#tb-runmode button")) {
    btn.classList.toggle("active", btn.dataset.runmode === mode);
  }
}

function initRunModeSeg() {
  const seg = document.getElementById("tb-runmode");
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-runmode]");
    if (!btn || btn.disabled) return;
    setRunMode(btn.dataset.runmode);
    refreshRunButton();
  });
  setRunMode(state.runMode);
}

// ---------------------------------------------------------------- температура

function setTemperature(v) {
  state.temperature = Math.min(Math.max(parseFloat(v) || 1, 0.05), 2);
  const slider = document.getElementById("temperature");
  if (slider) slider.value = state.temperature;
  const label = document.getElementById("temp-value");
  if (label) label.textContent = state.temperature.toFixed(2);
}

function initTempControls() {
  document.getElementById("temperature").addEventListener("input", (e) => setTemperature(e.target.value));
  for (const b of document.querySelectorAll("#run-popover [data-temp]")) {
    b.addEventListener("click", () => setTemperature(b.dataset.temp));
  }
  setTemperature(state.temperature);
}

// ---------------------------------------------------------------- поповер настроек запуска

const runPopover = () => document.getElementById("run-popover");

function closeRunPopover() {
  runPopover().classList.add("hidden");
}

function initRunPopover() {
  const pop = runPopover();
  const btn = document.getElementById("tb-run-options");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = pop.classList.contains("hidden");
    if (willOpen) {
      const r = btn.getBoundingClientRect();
      const pw = pop.offsetWidth || 340;
      pop.style.left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8)) + "px";
      pop.style.top = (r.bottom + 6) + "px";
    }
    pop.classList.toggle("hidden");
  });
  pop.addEventListener("click", (e) => e.stopPropagation());
}

// ---------------------------------------------------------------- меню

const menuDropdown = () => document.getElementById("tb-menu");
const menuPresetsSub = () => document.getElementById("tb-menu-presets-sub");
const menuExportSub = () => document.getElementById("tb-menu-export-sub");

function closeMenu() {
  menuDropdown().classList.add("hidden");
  menuPresetsSub().classList.add("hidden");
  menuExportSub().classList.add("hidden");
}

function requestPresets() {
  const sub = menuPresetsSub();
  sub.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "menu-item menu-item-disabled";
  loading.textContent = "Загрузка…";
  sub.appendChild(loading);
  getPresets()
    .then(presets => {
      sub.innerHTML = "";
      const renderItem = (p) => {
        const item = document.createElement("div");
        item.className = "menu-item";
        const name = document.createElement("span");
        name.textContent = p.name;
        item.appendChild(name);
        const withImages = (Array.isArray(p.images) && p.images.length > 0) ||
          (Array.isArray(p.files) && p.files.some(f => f.image || f.dataUrl || (Array.isArray(f.images) && f.images.length)));
        if (withImages) {
          const badge = document.createElement("span");
          badge.className = "menu-preset-badge";
          badge.textContent = "🖼";
          badge.title = "Пресет с изображениями — нужны vision-модели (Clef)";
          item.appendChild(badge);
        }
        if (p.description) {
          const desc = document.createElement("span");
          desc.className = "menu-preset-desc";
          desc.textContent = p.description;
          item.appendChild(desc);
        }
        item.onclick = () => {
          closeMenu();
          applyPresetCb(p);
        };
        sub.appendChild(item);
      };
      const groups = [
        ["Одиночные", presets.filter(p => p.page !== "batch")],
        ["Батч", presets.filter(p => p.page === "batch")],
      ];
      for (const [label, items] of groups) {
        if (!items.length) continue;
        const head = document.createElement("div");
        head.className = "menu-group-head";
        head.textContent = label;
        sub.appendChild(head);
        for (const p of items) renderItem(p);
      }
    })
    .catch(e => {
      sub.innerHTML = "";
      const err = document.createElement("div");
      err.className = "menu-item menu-item-disabled";
      err.textContent = "Ошибка: " + e.message;
      sub.appendChild(err);
    });
}

function initMenu() {
  document.getElementById("tb-menu-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const dd = menuDropdown();
    const willOpen = dd.classList.contains("hidden");
    if (willOpen) requestPresets();
    dd.classList.toggle("hidden");
    if (!willOpen) {
      menuPresetsSub().classList.add("hidden");
      menuExportSub().classList.add("hidden");
    }
  });
  document.getElementById("tb-menu-presets").addEventListener("click", (e) => {
    e.stopPropagation();
    requestPresets();
    menuExportSub().classList.add("hidden");
    menuPresetsSub().classList.toggle("hidden");
  });
  document.getElementById("tb-menu-export").addEventListener("click", (e) => {
    e.stopPropagation();
    menuPresetsSub().classList.add("hidden");
    menuExportSub().classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    closeMenu();
    if (openPopover && !e.target.closest(".model-chip") && !e.target.closest("#model-popover")) {
      closeModelPopover();
    }
    if (!e.target.closest("#tb-models-menu-wrap")) closeModelsMenu();
    if (!e.target.closest("#run-popover") && !e.target.closest("#tb-run-options")) closeRunPopover();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeMenu(); closeModelPopover(); closeModelsMenu(); closeRunPopover(); }
  });

  document.getElementById("tb-menu-export-questions").addEventListener("click", () => {
    closeMenu();
    onExportQuestionsCb();
  });
  document.getElementById("tb-menu-export-context").addEventListener("click", () => {
    closeMenu();
    onExportContextCb();
  });
  document.getElementById("tb-menu-export-all").addEventListener("click", () => {
    closeMenu();
    onExportAllCb();
  });
  document.getElementById("tb-menu-import").addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) onImportFileCb(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("tb-menu-collapse-all").addEventListener("click", () => { closeMenu(); setAllCollapsed(true); });
  document.getElementById("tb-menu-expand-all").addEventListener("click", () => { closeMenu(); setAllCollapsed(false); });
  document.getElementById("tb-menu-presets-manager").addEventListener("click", () => { closeMenu(); onPresetsManagerCb(); });
  document.getElementById("tb-menu-save-preset").addEventListener("click", () => { closeMenu(); onSavePresetCb(); });
}

// ---------------------------------------------------------------- страница: одиночный / батч

export function setPageMode(mode) {
  state.pageMode = mode;
  for (const btn of document.querySelectorAll("#tb-pagemode button")) {
    btn.classList.toggle("active", btn.dataset.pagemode === mode);
  }
  document.getElementById("page-single").classList.toggle("hidden", mode !== "single");
  document.getElementById("page-batch").classList.toggle("hidden", mode !== "batch");
  document.getElementById("page-models").classList.toggle("hidden", mode !== "models");
  document.getElementById("page-presets").classList.toggle("hidden", mode !== "presets");
  onPageModeCb(mode);
  refreshRunButton();
}

function initPageModeSeg() {
  document.getElementById("tb-pagemode").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-pagemode]");
    if (!btn) return;
    setPageMode(btn.dataset.pagemode);
  });
  setPageMode(state.pageMode);
}

// ---------------------------------------------------------------- кнопка Run

export function refreshRunButton() {
  updateRunControls();
  const btn = document.getElementById("tb-run");
  const spin = document.getElementById("tb-run-spinner");
  const busy = state.running || state.batch.running;
  let disabled = false;
  let tooltip = "";
  if (state.pageMode === "models" || state.pageMode === "presets") {
    disabled = true;
    tooltip = state.pageMode === "models"
      ? "страница управления моделями — прогон запускается со страниц «Одиночный»/«Батч»"
      : "менеджер пресетов — прогон запускается со страниц «Одиночный»/«Батч»";
  } else if (state.pageMode === "batch") {
    disabled = state.batch.files.length === 0 || selectedModelKeys().length === 0;
    if (disabled) {
      tooltip = state.batch.files.length === 0
        ? "добавьте файлы для батча"
        : NO_MODEL_TOOLTIP;
    }
  } else {
    disabled = selectedModelKeys().length === 0;
    if (disabled) tooltip = NO_MODEL_TOOLTIP;
  }
  btn.disabled = busy || disabled;
  btn.title = tooltip;
  spin.classList.toggle("hidden", !busy);
}
