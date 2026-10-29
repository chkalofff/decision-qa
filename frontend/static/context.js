// Контекст: режимы Текст/JSON, CodeMirror-редактор для JSON (подсветка,
// схлопывание, линт), полноэкранный режим, экспорт/импорт JSON.

import { state, emit } from "./state.js";
import { setQuestions } from "./questions.js";
import { setDecision } from "./decision.js";
import { clearSingleResults, restoreSingleResults, restoreBatchResults } from "./stale.js";
import { openLightbox } from "./lightbox.js";
import { isSupportedImageFile, rejectedImagesMessage } from "./imageutil.js";
import { setBlocksCollapsed, updateBlockCounters } from "./blockcollapse.js";
import { normalizePack, applyPackSettings, DOCUMENT_FORMAT, DOCUMENT_VERSION } from "./config_pack.js";

let onErrorCb = (msg) => { throw new Error(msg); };

// ---------------------------------------------------------------- CodeMirror (ленивая загрузка)

let cmApi = null;      // модуль vendor/cm.bundle.js
let cmView = null;     // EditorView

async function ensureCm() {
  if (!cmApi) cmApi = await import("./vendor/cm.bundle.js");
  return cmApi;
}

function cmValue() {
  return cmView ? cmView.state.doc.toString() : null;
}

async function mountCm() {
  const holder = document.getElementById("cm-holder");
  holder.innerHTML = "";
  const cm = await ensureCm();
  const textarea = document.getElementById("context-input");
  cmView = new cm.EditorView({
    doc: textarea.value,
    extensions: [
      cm.lineNumbers(),
      cm.history(),
      cm.keymap.of([...cm.foldKeymap, ...cm.defaultKeymap, ...cm.historyKeymap]),
      cm.codeFolding(),
      cm.foldGutter(),
      cm.bracketMatching(),
      cm.syntaxHighlighting(cm.defaultHighlightStyle, { fallback: true }),
      cm.json(),
      cm.linter(cm.jsonParseLinter()),
      cm.lintGutter(),
      cm.EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          syncFromEditor(cmView.state.doc.toString());
        }
      }),
      cm.EditorView.theme({
        "&": { fontSize: "13px", height: "100%", maxHeight: "100%" },
        ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
      }),
    ],
    parent: holder,
  });
  cmView.requestMeasure();
}

function destroyCm() {
  if (cmView) {
    cmView.destroy();
    cmView = null;
  }
}

// Сворачивание по уровням: уровень N сворачивает значения глубины N и глубже
// (после разворачивания родителя вложенные остаются свёрнутыми). Глубина —
// число незакрытых {/[ перед началом диапазона: значения верхнего уровня
// (вложенные прямо в корень) — глубина 1, «Свернуть всё» сворачивает и
// корень. Детерминировано по тексту: вложенность foldable-диапазонов в
// json-грамматике даёт сдвинутые глубины из-за служебных узлов.
let foldLevel = null; // текущий уровень сворачивания; null — развёрнуто полностью

function collectFoldRanges() {
  const cm = cmApi;
  const st = cmView.state;
  const seen = new Set();
  const ranges = [];
  cm.syntaxTree(st).iterate({
    enter(node) {
      const r = cm.foldable(st, node.from, node.to);
      if (r) {
        const key = r.from + ":" + r.to;
        if (!seen.has(key)) {
          seen.add(key);
          ranges.push(r);
        }
      }
    },
  });
  return ranges;
}

function foldRangesDepth(ranges) {
  // Глубина по незакрытым скобкам перед началом диапазона (корень — 0).
  const text = cmView.state.doc.toString();
  const depths = new Map(); // позиция символа -> глубина после него
  let d = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "[") { depths.set(i, d); d++; }
    else if (ch === "}" || ch === "]") d = Math.max(0, d - 1);
  }
  return (r) => {
    for (let i = r.from; i >= 0; i--) if (depths.has(i)) return depths.get(i);
    return 0;
  };
}

// Максимальная глубина foldable-диапазонов текущего документа (0 — нет диапазонов).
function maxFoldDepth() {
  if (!cmApi || !cmView) return 0;
  const ranges = collectFoldRanges();
  const depth = foldRangesDepth(ranges);
  return ranges.reduce((m, r) => Math.max(m, depth(r)), 0);
}

function foldToLevel(level) {
  if (!cmApi || !cmView) return;
  const cm = cmApi;
  const ranges = collectFoldRanges();
  const depth = foldRangesDepth(ranges);
  const effects = ranges.filter((r) => depth(r) >= level).map((r) => cm.foldEffect.of(r));
  cm.unfoldAll(cmView);
  if (effects.length) cmView.dispatch({ effects });
  foldLevel = level;
}

function unfoldAllJson() {
  if (!cmApi || !cmView) return;
  cmApi.unfoldAll(cmView);
  foldLevel = null;
}

function foldAllJson() {
  if (!cmApi || !cmView) return;
  cmApi.foldAll(cmView);
  foldLevel = maxFoldDepth();
}

// Тестовый хук: подмена моков CodeMirror (в node реальный бандл не монтируется).
export function __setCmForTests(api, view) {
  cmApi = api;
  cmView = view;
}

// ---------------------------------------------------------------- состояние режима

const textarea = () => document.getElementById("context-input");
const jsonError = () => document.getElementById("json-error");

const EDITOR_HEIGHTS = {
  text: { id: "context-input", key: "dq-context-input-height", initial: 192, min: 96, max: 720 },
  cm: { id: "cm-holder", key: "dq-context-cm-height", initial: 280, min: 120, max: 720 },
};
const preferredEditorHeights = { text: 192, cm: 280 };
let editorResizeObserver = null;

function clampEditorHeight(kind, value) {
  const cfg = EDITOR_HEIGHTS[kind];
  const viewportMax = Math.floor((window.innerHeight || cfg.max) * 0.7);
  return Math.min(cfg.max, Math.max(cfg.min, value), Math.max(cfg.min, viewportMax));
}

function setEditorInlineHeights(enabled) {
  for (const [kind, cfg] of Object.entries(EDITOR_HEIGHTS)) {
    const el = document.getElementById(cfg.id);
    if (el) el.style.height = enabled ? `${preferredEditorHeights[kind]}px` : "";
  }
}

function initEditorResizing() {
  if (editorResizeObserver) {
    editorResizeObserver.disconnect();
    editorResizeObserver = null;
  }
  for (const [kind, cfg] of Object.entries(EDITOR_HEIGHTS)) {
    const saved = parseFloat(localStorage.getItem(cfg.key));
    preferredEditorHeights[kind] = Number.isFinite(saved) && saved > 0
      ? clampEditorHeight(kind, saved)
      : cfg.initial;
  }
  setEditorInlineHeights(true);

  const Observer = globalThis.ResizeObserver;
  if (typeof Observer !== "function") return;
  editorResizeObserver = new Observer((entries) => {
    const fullscreen = document.getElementById("context-card")?.classList.contains("context-fullscreen");
    for (const entry of entries) {
      const found = Object.entries(EDITOR_HEIGHTS).find(([, cfg]) => cfg.id === entry.target.id);
      if (!found) continue;
      const [kind, cfg] = found;
      if (entry.target !== document.getElementById(cfg.id)) continue;
      if (kind === "cm" && cmView) cmView.requestMeasure();
      if (fullscreen) continue;
      const height = Math.round(entry.target.getBoundingClientRect().height);
      if (!height) continue;
      const clamped = clampEditorHeight(kind, height);
      preferredEditorHeights[kind] = clamped;
      const saved = String(clamped);
      if (localStorage.getItem(cfg.key) !== saved) localStorage.setItem(cfg.key, saved);
    }
  });
  for (const cfg of Object.values(EDITOR_HEIGHTS)) {
    const el = document.getElementById(cfg.id);
    if (el) editorResizeObserver.observe(el);
  }
}

export function currentText() {
  if (state.inputMode === "json" && cmView) return cmView.state.doc.toString();
  return textarea().value;
}

function syncFromEditor(text) {
  document.getElementById("char-count").textContent = text.length;
  validateJsonMode();
  emit("context");
}

export function hasContent() {
  return currentText().trim().length > 0 || state.contextImages.length > 0;
}

function setMode(mode) {
  if (mode === state.inputMode && (mode !== "json" || cmView)) {
    validateJsonMode();
    return;
  }
  state.inputMode = mode;
  updateBlockCounters();
  document.getElementById("mode-text").classList.toggle("active", mode === "text");
  document.getElementById("mode-json").classList.toggle("active", mode === "json");
  // Меню сворачивания JSON — только в JSON-режиме (folding CodeMirror).
  const foldMenuBtn = document.getElementById("btn-fold-menu");
  if (foldMenuBtn) {
    foldMenuBtn.classList.toggle("hidden", mode !== "json");
    if (mode !== "json") document.getElementById("fold-menu")?.classList.add("hidden");
  }
  const ta = textarea();
  const holder = document.getElementById("cm-holder");
  if (mode === "json") {
    ta.classList.add("hidden");
    holder.classList.remove("hidden");
    ta.placeholder = "";
    mountCm().then(() => validateJsonMode()).catch((e) => onErrorCb("Не удалось загрузить JSON-редактор: " + e.message));
  } else {
    if (cmView) ta.value = cmValue();
    destroyCm();
    holder.classList.add("hidden");
    ta.classList.remove("hidden");
  }
  ta.placeholder = mode === "json"
    ? ""
    : "Вставьте текст материала…";
  validateJsonMode();
}

export function setContent(text, mode) {
  setMode(mode === "json" ? "json" : "text");
  textarea().value = text;
  if (cmView) {
    cmView.dispatch({ changes: { from: 0, to: cmView.state.doc.length, insert: text } });
  } else if (state.inputMode === "json") {
    // редактор ещё монтируется — значение подхватится из textarea при mountCm
  }
  syncFromEditor(text);
}

// Суффикс к «Невалидный JSON»: если движок сообщает позицию, переводим её
// в строку/столбец по исходному тексту; иначе возвращаем исходное сообщение.
export function describeJsonError(text, e) {
  const msg = (e && e.message) || String(e);
  const m = /position (\d+)/.exec(msg);
  if (!m) return ": " + msg;
  const pos = Math.min(parseInt(m[1], 10), text.length);
  let line = 1, lastBreak = -1;
  for (let i = 0; i < pos; i++) if (text[i] === "\n") { line++; lastBreak = i; }
  const brief = msg
    .replace(/\s*(?:in JSON\s+)?at position \d+\.?/, "")
    .replace(/\s*\(line \d+ column \d+\)\s*$/, "")
    .trim() || msg;
  return ` (строка ${line}, столбец ${pos - lastBreak}): ${brief}`;
}

export function validateJsonMode() {
  const ta = textarea();
  if (state.inputMode !== "json") {
    ta.classList.remove("invalid");
    jsonError().classList.add("hidden");
    return true;
  }
  const text = currentText().trim();
  if (!text) {
    ta.classList.remove("invalid");
    jsonError().classList.add("hidden");
    return true;
  }
  try {
    JSON.parse(text);
    ta.classList.remove("invalid");
    jsonError().classList.add("hidden");
    return true;
  } catch (e) {
    ta.classList.add("invalid");
    jsonError().textContent = "Невалидный JSON" + describeJsonError(text, e);
    jsonError().classList.remove("hidden");
    return false;
  }
}

export function buildInput() {
  const text = currentText();
  if (!text.trim()) {
    // Пустой текст допустим, если прикреплены изображения (вопросы по картинке).
    if (state.contextImages.length) return "";
    throw new Error("Материал не может быть пустым — введите текст или прикрепите изображение.");
  }
  if (state.inputMode === "json") {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("Невалидный JSON в материале" + describeJsonError(text, e));
    }
  }
  return text;
}

// ---------------------------------------------------------------- изображения контекста

const MAX_CONTEXT_IMAGES = 8;

export function buildImagesPayload() {
  return state.contextImages.map(img => img.dataUrl);
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Не удалось прочитать файл " + file.name));
    reader.readAsDataURL(file);
  });
}

export async function addImageFiles(files) {
  const all = [...files];
  const images = all.filter(isSupportedImageFile);
  const rejected = all.filter(f => /\.(png|jpe?g|webp|gif|heic|heif|avif|tiff?|bmp)$/i.test(f.name || "") ||
    (f.type && f.type.startsWith("image/"))).filter(f => !isSupportedImageFile(f));
  const msg = rejectedImagesMessage(rejected);
  if (msg) onErrorCb(msg);
  if (!images.length) return;
  for (const file of images) {
    if (state.contextImages.length >= MAX_CONTEXT_IMAGES) {
      onErrorCb(`Не больше ${MAX_CONTEXT_IMAGES} изображений — лишние пропущены.`);
      break;
    }
    const dataUrl = await readAsDataUrl(file);
    state.contextImages.push({ name: file.name, dataUrl });
  }
  renderContextImages();
  emit("images");
}

function removeContextImage(idx) {
  state.contextImages.splice(idx, 1);
  renderContextImages();
  emit("images");
}

export function setImages(images) {
  state.contextImages = (images || []).slice(0, MAX_CONTEXT_IMAGES).map((img, i) =>
    typeof img === "string" ? { name: `image_${i + 1}.png`, dataUrl: img } : img);
  renderContextImages();
  emit("images");
}

function renderContextImages() {
  const wrap = document.getElementById("context-images");
  if (!wrap) return;
  wrap.innerHTML = "";
  wrap.classList.toggle("hidden", state.contextImages.length === 0);
  state.contextImages.forEach((img, idx) => {
    const thumb = document.createElement("span");
    thumb.className = "ctx-thumb";
    const pic = document.createElement("img");
    pic.src = img.dataUrl;
    pic.alt = img.name;
    pic.title = img.name + " — клик: увеличить";
    pic.addEventListener("click", () => openLightbox({ src: img.dataUrl, name: img.name }));
    thumb.appendChild(pic);
    const del = document.createElement("button");
    del.className = "ctx-thumb-remove";
    del.textContent = "✕";
    del.title = "Убрать изображение";
    del.onclick = () => removeContextImage(idx);
    thumb.appendChild(del);
    wrap.appendChild(thumb);
  });
}

// ---------------------------------------------------------------- полный экран

let restoreMaterialsCollapsed = null;

export function toggleContextFullscreen(force) {
  const card = document.getElementById("context-card");
  const wasOn = card.classList.contains("context-fullscreen");
  const on = force != null ? force : !wasOn;
  if (on && !wasOn) {
    restoreMaterialsCollapsed = card.classList.contains("card-collapsed");
    if (restoreMaterialsCollapsed) setBlocksCollapsed(false, ["context-card"]);
    setEditorInlineHeights(false);
  }
  card.classList.toggle("context-fullscreen", on);
  if (!on && wasOn) {
    setEditorInlineHeights(true);
    if (restoreMaterialsCollapsed !== null) {
      setBlocksCollapsed(restoreMaterialsCollapsed, ["context-card"]);
      restoreMaterialsCollapsed = null;
    }
  }
  document.body.classList.toggle("no-scroll", on);
  const btn = document.getElementById("btn-context-fs");
  if (btn) btn.textContent = on ? "✕" : "⛶";
  if (cmView) cmView.requestMeasure();
}

// ---------------------------------------------------------------- экспорт / импорт

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function contextSnapshot() {
  const input = state.inputMode === "json" && currentText().trim() ? buildInput() : currentText();
  const snap = { input_format: state.inputMode, input };
  if (state.contextImages.length) {
    snap.images = state.contextImages.map(img => img.dataUrl);
  }
  return snap;
}

export function exportContext() {
  let snap;
  try {
    snap = contextSnapshot();
  } catch (e) {
    throw new Error("Экспорт невозможен: " + e.message);
  }
  downloadJson("context.json", snap);
}

// Применяет импортированный контекст (объект {input_format, input, images?}).
export function applyImportedContext(data) {
  const format = data.input_format === "json" || typeof data.input !== "string" ? "json" : "text";
  const text = typeof data.input === "string" ? data.input : JSON.stringify(data.input, null, 2);
  setContent(text, format);
  // Обратная совместимость: старые экспорты без images — просто сбрасываем картинки.
  setImages(Array.isArray(data.images) ? data.images : []);
}

// Импорт единого decision-qa-document и raw config pack раскладывает config,
// materials и results по текущему state с учётом scope. Legacy-массив вопросов и
// session {input, batch_files} обрабатываются по прежним правилам. Результаты и
// разметка восстанавливаются через stale.js с remap файловых id.
function parseConfigDocument(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const isDocument = data.format === DOCUMENT_FORMAT;
  const isRawPack = data.format === undefined && data.version === 1 &&
    Array.isArray(data.questions) && data.decision && data.settings;
  if (!isDocument && !isRawPack) return null;
  let scope = "cli";
  let configSource = data;
  let materials = {};
  let results = {};
  if (isDocument) {
    const allowed = new Set(["format", "version", "scope", "config", "materials", "results"]);
    const unknown = Object.keys(data).filter(key => !allowed.has(key));
    if (unknown.length) throw new Error(`Неизвестные поля документа: ${unknown.sort().join(", ")}`);
    if (data.version !== DOCUMENT_VERSION) throw new Error(`Неподдерживаемая версия документа: ${data.version}`);
    if (!["questions", "materials", "full", "cli"].includes(data.scope)) throw new Error("Неизвестный состав документа.");
    for (const key of ["materials", "results"]) {
      if (key in data && (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key]))) {
        throw new Error(`Секция ${key} должна быть объектом.`);
      }
    }
    scope = data.scope;
    configSource = data.config;
    materials = data.materials || {};
    results = data.results || {};
  }
  const config = normalizePack(configSource);
  const hasMaterials = scope === "materials" || scope === "full";
  const hasInput = hasMaterials && "input" in materials;
  const batchFiles = hasMaterials && Array.isArray(materials.batch_files) ? materials.batch_files : null;
  return {
    kind: scope === "questions" ? "questions" : (scope === "cli" ? "config" : (!hasInput && batchFiles ? "batch" : "session")),
    context: hasInput ? { input_format: materials.input_format, input: materials.input, images: materials.images } : null,
    questions: config.questions,
    decision: config.decision,
    batchFiles,
    results: results.results && typeof results.results === "object" ? results.results : null,
    resultsMeta: results.results_meta && typeof results.results_meta === "object" ? results.results_meta : null,
    batchResults: results.batch_results && typeof results.batch_results === "object" ? results.batch_results : null,
    settings: config.settings,
    scope,
    ui: scope === "full" && config.ui && typeof config.ui === "object" ? config.ui : null,
    configImport: scope !== "questions",
    decisionImport: scope !== "questions",
  };
}

export function parseImport(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return { kind: "questions", questions: data };
  const configDocument = parseConfigDocument(data);
  if (configDocument) return configDocument;
  if (data && typeof data === "object" && ("input" in data || Array.isArray(data.batch_files))) {
    const hasInput = "input" in data;
    const batchFiles = Array.isArray(data.batch_files) ? data.batch_files : null;
    return {
      kind: !hasInput ? "batch" : (Array.isArray(data.questions) || batchFiles ? "session" : "context"),
      context: hasInput ? { input_format: data.input_format, input: data.input, images: data.images } : null,
      questions: Array.isArray(data.questions) ? data.questions : null,
      decision: data.decision !== undefined ? data.decision : null,
      batchFiles,
      results: data.results != null ? data.results : null,
      resultsMeta: data.results_meta && typeof data.results_meta === "object" ? data.results_meta : null,
      batchResults: data.batch_results && typeof data.batch_results === "object" ? data.batch_results : null,
    };
  }
  throw new Error("Файл должен содержать документ Вердикта, массив вопросов или объект с полем input.");
}

export function importJsonFile(file, { onError, confirmReplace, onBatchFiles, onWarn, onRunSettings }) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseImport(reader.result);
      // Разметка из файла более новой версии формата не загружается (restore-
      // функции её пропускают) — предупреждаем в format-banner.
      const mv = Math.max(
        (parsed.results && parsed.results.marks_version) || 0,
        (parsed.batchResults && parsed.batchResults.marks_version) || 0);
      if (mv > 1 && onWarn) {
        onWarn(`Разметка из более новой версии формата (v${mv}) не загружена — результаты открыты без неё.`);
      }
      const hasAnything = hasContent() || state.questions.length > 0;
      const touchesSingle = parsed.kind !== "batch";
      if (touchesSingle && hasAnything && confirmReplace && !confirmReplace(parsed.kind)) return;
      if (parsed.kind === "questions") {
        setQuestions(parsed.questions);
      } else {
        if (parsed.context) applyImportedContext(parsed.context);
        if (parsed.questions && (parsed.context || parsed.configImport)) setQuestions(parsed.questions);
        if ((parsed.context && (parsed.kind === "session" || parsed.kind === "context")) ||
            (parsed.configImport && parsed.decisionImport)) setDecision(parsed.decision);
      }
      if (parsed.settings) {
        applyPackSettings(parsed.settings);
        if (onRunSettings) onRunSettings(parsed.settings);
      }
      if (parsed.batchFiles && onBatchFiles) onBatchFiles(parsed.batchFiles);
      // Результаты пакета — после onBatchFiles (загрузка файлов с новыми id,
      // remap по br.files из файла делает restoreBatchResults).
      if (parsed.batchResults) restoreBatchResults(parsed.batchResults);
      // Загрузка новых входных данных обнуляет прошлый прогон (одиночный режим) —
      // кроме снапшотов с результатами: они восстанавливаются как актуальные.
      if (touchesSingle) {
        if (parsed.results) restoreSingleResults(parsed.results, parsed.resultsMeta, currentText);
        else clearSingleResults();
      }
    } catch (e) {
      onError("Ошибка импорта: " + e.message);
    }
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------- init

let contextEscapeDocument = null;
let contextEscapeHandler = null;

export function initContext({ showError }) {
  if (showError) onErrorCb = showError;
  if (contextEscapeDocument && contextEscapeHandler) {
    contextEscapeDocument.removeEventListener("keydown", contextEscapeHandler);
  }
  contextEscapeDocument = document;
  contextEscapeHandler = (e) => {
    const card = document.getElementById("context-card");
    if (e.key === "Escape" && card?.classList.contains("context-fullscreen")) {
      toggleContextFullscreen(false);
    }
  };
  contextEscapeDocument.addEventListener("keydown", contextEscapeHandler);
  initEditorResizing();

  document.getElementById("mode-text").onclick = () => setMode("text");
  document.getElementById("mode-json").onclick = () => setMode("json");
  document.getElementById("btn-context-fs").onclick = () => toggleContextFullscreen();
  // Меню сворачивания JSON: уровни + свернуть/развернуть всё.
  const foldBtn = document.getElementById("btn-fold-menu");
  const foldMenu = document.getElementById("fold-menu");
  if (foldBtn && foldMenu) {
    // Без stopPropagation: клик по кнопке должен закрывать меню тулбара
    // (их document-обработчики в bubble-фазе); сам fold-дропдаун защищён
    // проверкой closest(".fold-menu-wrap") ниже.
    foldBtn.onclick = () => {
      if (foldMenu.classList.contains("hidden")) {
        // position: fixed — позиционируем по кнопке, правым краем к ней
        const r = foldBtn.getBoundingClientRect();
        foldMenu.style.top = `${r.bottom + 6}px`;
        foldMenu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
        foldMenu.style.left = "auto";
      }
      foldMenu.classList.toggle("hidden");
    };
    foldMenu.addEventListener("click", (e) => {
      const item = e.target?.closest?.("[data-fold]");
      if (!item) return;
      foldMenu.classList.add("hidden");
      if (!cmApi || !cmView) return;
      const action = item.dataset.fold;
      if (action === "unfold") unfoldAllJson();
      else if (action === "all") foldAllJson();
      else foldToLevel(Number(action));
    });
    // Capture-фаза: кнопки тулбара глушат всплытие (stopPropagation),
    // но клик по ним тоже должен закрывать fold-меню.
    document.addEventListener("click", (e) => {
      if (!e.target.closest?.(".fold-menu-wrap")) foldMenu.classList.add("hidden");
    }, true);
    // Меню position: fixed — при скролле/ресайзе «отрывается» от кнопки, закрываем
    document.addEventListener("scroll", () => foldMenu.classList.add("hidden"), true);
    window.addEventListener("resize", () => foldMenu.classList.add("hidden"));
  }

  // Прикрепление изображений: кнопка 📎 + drag&drop на карточку контекста.
  const attachBtn = document.getElementById("btn-attach-image");
  const imageInput = document.getElementById("context-image-input");
  if (attachBtn && imageInput) {
    attachBtn.onclick = () => imageInput.click();
    imageInput.addEventListener("change", (e) => {
      if (e.target.files.length) {
        addImageFiles([...e.target.files]).catch(err => onErrorCb(err.message));
      }
      e.target.value = "";
    });
  }
  const card = document.getElementById("context-card");
  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    card.classList.add("drag-over");
  });
  card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    card.classList.remove("drag-over");
    if (e.dataTransfer && e.dataTransfer.files.length) {
      addImageFiles([...e.dataTransfer.files]).catch(err => onErrorCb(err.message));
    }
  });

  textarea().addEventListener("input", () => {
    syncFromEditor(textarea().value);
  });

  // Горячие клавиши сворачивания: Ctrl/Cmd+Shift+[ — свернуть глубже,
  // Ctrl/Cmd+Shift+] — развернуть. Только в JSON-режиме и когда фокус
  // не в поле ввода/редакторе. Браузер переключает табы по этим комбо —
  // глушим preventDefault.
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    if (e.code !== "BracketLeft" && e.code !== "BracketRight") return;
    if (state.inputMode !== "json" || !cmApi || !cmView) return;
    const t = e.target;
    const tag = t && t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (t && t.closest && t.closest(".cm-focused")) return;
    e.preventDefault();
    if (e.code === "BracketLeft") {
      const max = maxFoldDepth();
      foldToLevel(Math.min((foldLevel == null ? 0 : foldLevel) + 1, max));
    } else {
      const next = (foldLevel == null ? 0 : foldLevel) - 1;
      if (next <= 0) unfoldAllJson();
      else foldToLevel(next);
    }
  });

  setMode("text");
}
