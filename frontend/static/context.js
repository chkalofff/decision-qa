// Контекст: режимы Текст/JSON, CodeMirror-редактор для JSON (подсветка,
// схлопывание, линт), полноэкранный режим, экспорт/импорт JSON.

import { state, emit } from "./state.js";
import { setQuestions } from "./questions.js";
import { setDecision } from "./decision.js";
import { openLightbox } from "./lightbox.js";
import { isSupportedImageFile, rejectedImagesMessage } from "./imageutil.js";

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
      cm.keymap.of([...cm.defaultKeymap, ...cm.historyKeymap]),
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
        "&": { fontSize: "13px", maxHeight: "100%" },
        ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
      }),
    ],
    parent: holder,
  });
}

function destroyCm() {
  if (cmView) {
    cmView.destroy();
    cmView = null;
  }
}

// ---------------------------------------------------------------- состояние режима

const textarea = () => document.getElementById("context-input");
const jsonError = () => document.getElementById("json-error");

function currentText() {
  if (state.inputMode === "json" && cmView) return cmView.state.doc.toString();
  return textarea().value;
}

function syncFromEditor(text) {
  document.getElementById("char-count").textContent = text.length;
  validateJsonMode();
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
  document.getElementById("mode-text").classList.toggle("active", mode === "text");
  document.getElementById("mode-json").classList.toggle("active", mode === "json");
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
    : "Вставьте текст-контекст…";
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
    throw new Error("Контекст не может быть пустым — введите текст или прикрепите изображение.");
  }
  if (state.inputMode === "json") {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("Невалидный JSON в контексте" + describeJsonError(text, e));
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

// Инлайн-height от vsplit-сплиттера (panels.js) перебивает inset у
// position:fixed — на время fullscreen очищаем его и восстанавливаем после.
let savedInlineHeight = null;

export function toggleContextFullscreen(force) {
  const card = document.getElementById("context-card");
  const on = force != null ? force : !card.classList.contains("context-fullscreen");
  if (on && !card.classList.contains("context-fullscreen")) {
    savedInlineHeight = card.style.height || "";
    card.style.height = "";
  }
  card.classList.toggle("context-fullscreen", on);
  if (!on && savedInlineHeight !== null) {
    card.style.height = savedInlineHeight;
    savedInlineHeight = null;
  }
  document.body.classList.toggle("no-scroll", on);
  const btn = document.getElementById("btn-context-fs");
  if (btn) btn.textContent = on ? "✕" : "⛶";
  if (on && cmView) cmView.requestMeasure();
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

// Единый импорт: массив → вопросы; объект с input → контекст (+ вопросы и/или
// batch_files, если есть); объект только с batch_files → файлы батча.
// batch_files: [{name, content}] для текста, [{name, image}] для картинок
// (image — data URL) — тот же формат, что у батч-пресетов.
// onBatchFiles — колбэк применения файлов батча (подтверждение замены непустого
// батча и переключение страницы делает вызывающий).
export function parseImport(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return { kind: "questions", questions: data };
  if (data && typeof data === "object" && ("input" in data || Array.isArray(data.batch_files))) {
    const hasInput = "input" in data;
    const batchFiles = Array.isArray(data.batch_files) ? data.batch_files : null;
    return {
      kind: !hasInput ? "batch" : (Array.isArray(data.questions) || batchFiles ? "session" : "context"),
      context: hasInput ? { input_format: data.input_format, input: data.input, images: data.images } : null,
      questions: Array.isArray(data.questions) ? data.questions : null,
      decision: data.decision !== undefined ? data.decision : null,
      batchFiles,
    };
  }
  throw new Error("Файл должен содержать массив вопросов или объект с полем input.");
}

export function importJsonFile(file, { onError, confirmReplace, onBatchFiles }) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseImport(reader.result);
      const hasAnything = hasContent() || state.questions.length > 0;
      const touchesSingle = parsed.kind !== "batch";
      if (touchesSingle && hasAnything && confirmReplace && !confirmReplace(parsed.kind)) return;
      if (parsed.kind === "questions") {
        setQuestions(parsed.questions);
      } else if (parsed.context) {
        applyImportedContext(parsed.context);
        if (parsed.questions) setQuestions(parsed.questions);
        if (parsed.kind === "session" || parsed.kind === "context") setDecision(parsed.decision);
      }
      if (parsed.batchFiles && onBatchFiles) onBatchFiles(parsed.batchFiles);
    } catch (e) {
      onError("Ошибка импорта: " + e.message);
    }
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------- init

export function initContext({ showError }) {
  if (showError) onErrorCb = showError;

  document.getElementById("mode-text").onclick = () => setMode("text");
  document.getElementById("mode-json").onclick = () => setMode("json");
  document.getElementById("btn-context-fs").onclick = () => toggleContextFullscreen();

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

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.getElementById("context-card").classList.contains("context-fullscreen")) {
      toggleContextFullscreen(false);
    }
  });

  setMode("text");
}
