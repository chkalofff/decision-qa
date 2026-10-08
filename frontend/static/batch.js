// Режим C — батч документов: загрузка файлов, прогон, таблица файлы × вопросы,
// дрилдаун файла, агрегаты, экспорт CSV/JSON. Запуск — кнопкой Run в баре.

import { state, emit, selectedModelKeys } from "./state.js";
import { decide } from "./api.js";
import { buildQuestionsPayload } from "./questions.js";
import { createSplitLayout, createVSplit } from "./panels.js";
import {
  shortAnswer, modelLabel, modelShortLabel, answerConfidence, confClass,
  scoreDirClass, renderAnswerDrilldown, distributionBars, showTip, hideTip,
  attachDecisionTip,
} from "./results.js";
import { openLightbox } from "./lightbox.js";
import { openPreview } from "./preview.js";
import { evaluateDecision, explainDecision, validateDecision, OUTCOME_COLORS } from "./decision.js";
import { isSupportedImageFile, rejectedImagesMessage, IMAGE_EXT_RE, IMAGE_ACCEPT } from "./imageutil.js";

const MAX_CHARS = 200_000;
const MAX_FILE_IMAGES = 3;  // изображений на один текстовый файл
const PREVIEW_CHARS = 2000;
const TIP_CHARS = 600;   // hover-мини-превью текста
let batchModelSel = "all";
let onErrorCb = () => {};

function genId() {
  return "f_" + Math.random().toString(36).slice(2, 10);
}

export function isBatchEmpty() {
  return state.batch.files.length === 0 && Object.keys(state.batch.results).length === 0;
}

export function resetBatch() {
  state.batch.files = [];
  state.batch.results = {};
  state.batch.durations = {};
  state.batch.running = false;
  state.batch.cancelled = false;
  batchModelSel = "all";
  renderBatchList();
  renderBatchResults();
}

// ---------------------------------------------------------------- файлы

function isImageFile(file) {
  return isSupportedImageFile(file);
}

// Файлы-картинки в неподдерживаемом формате (HEIC и пр.) — для сообщения.
function isRejectedImage(file) {
  if (isSupportedImageFile(file)) return false;
  return (file.type && file.type.startsWith("image/")) ||
    /\.(heic|heif|avif|tiff?|bmp)$/i.test(file.name || "");
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Не удалось прочитать файл " + file.name));
    reader.readAsDataURL(file);
  });
}

// Оценка реального размера из data URL (base64 → байты).
function dataUrlSize(dataUrl) {
  const b64 = String(dataUrl).split(",")[1] || "";
  return Math.floor(b64.length * 3 / 4);
}

async function addFiles(fileList) {
  const rejected = [...fileList].filter(isRejectedImage);
  const msg = rejectedImagesMessage(rejected);
  if (msg) onErrorCb(msg);
  for (const file of fileList) {
    if (isRejectedImage(file)) continue;
    if (isImageFile(file)) {
      const dataUrl = await readAsDataUrl(file);
      state.batch.files.push({
        id: genId(),
        name: file.name,
        size: file.size || dataUrlSize(dataUrl),
        text: `Изображение: ${file.name}`,
        isImage: true,
        dataUrl,
        status: "pending",
        error: null,
        warn: false,
      });
      continue;
    }
    const text = await file.text();
    state.batch.files.push({
      id: genId(),
      name: file.name,
      size: file.size,
      text,
      images: [],
      status: "pending",
      error: null,
      warn: text.length > MAX_CHARS,
    });
  }
  renderBatchList();
  updateBatchButtons();
  emit("batch");
}

// Снапшот файлов батча для экспорта «Всё»: текстовый файл → {name, content,
// images?} (images — data URL прикреплённых картинок, только если есть),
// картинка → {name, image}. Размеры/статусы не экспортируются.
export function batchFilesSnapshot() {
  return state.batch.files.map(f => {
    if (f.isImage) return { name: f.name, image: f.dataUrl };
    const snap = { name: f.name, content: f.text };
    if (f.images && f.images.length) snap.images = f.images.map(img => img.dataUrl);
    return snap;
  });
}

// Файлы из батч-пресета или импорта: [{name, content, images?}] для текста или
// [{name, image}] для картинок (image/images — data URL). Форматы можно смешивать.
export function loadPresetFiles(files) {
  state.batch.files = [];
  state.batch.results = {};
  state.batch.durations = {};
  for (const f of files) {
    const dataUrl = f.image || f.dataUrl;
    if (dataUrl) {
      state.batch.files.push({
        id: genId(),
        name: f.name || "image.png",
        size: dataUrlSize(dataUrl),
        text: `Изображение: ${f.name || "image.png"}`,
        isImage: true,
        dataUrl,
        status: "pending",
        error: null,
        warn: false,
      });
      continue;
    }
    const text = String(f.content ?? "");
    const images = (Array.isArray(f.images) ? f.images : [])
      .filter(img => img && (typeof img === "string" ? img : img.dataUrl))
      .slice(0, MAX_FILE_IMAGES)
      .map((img, i) => typeof img === "string"
        ? { name: `${f.name || "file"} #${i + 1}`, dataUrl: img }
        : { name: img.name || `image_${i + 1}.png`, dataUrl: img.dataUrl });
    state.batch.files.push({
      id: genId(),
      name: f.name || "preset.txt",
      size: text.length,
      text,
      images,
      status: "pending",
      error: null,
      warn: text.length > MAX_CHARS,
    });
  }
  renderBatchList();
  renderBatchResults();
  updateBatchProgress();
  updateBatchButtons();
  emit("batch");
}

function removeFile(id) {
  if (state.batch.running) return;
  state.batch.files = state.batch.files.filter(f => f.id !== id);
  delete state.batch.results[id];
  delete state.batch.durations[id];
  renderBatchList();
  renderBatchResults();
  updateBatchButtons();
  emit("batch");
}

function clearFiles() {
  if (state.batch.running) return;
  state.batch.files = [];
  state.batch.results = {};
  state.batch.durations = {};
  batchModelSel = "all";
  renderBatchList();
  renderBatchResults();
  updateBatchProgress();
  updateBatchButtons();
  emit("batch");
}

// Прикрепить изображения к текстовому файлу (максимум MAX_FILE_IMAGES).
// Не-картинки в выборе отфильтровываются; image-файлы и прогон — no-op.
export async function attachImagesToFile(id, fileList) {
  const f = state.batch.files.find(x => x.id === id);
  if (!f || f.isImage || state.batch.running) return;
  if (!Array.isArray(f.images)) f.images = [];
  const images = [...fileList].filter(isImageFile);
  const rejected = [...fileList].filter(isRejectedImage);
  const msg = rejectedImagesMessage(rejected);
  if (msg) onErrorCb(msg);
  if (!images.length) return;
  for (const file of images) {
    if (f.images.length >= MAX_FILE_IMAGES) {
      onErrorCb(`К файлу можно прикрепить не больше ${MAX_FILE_IMAGES} изображений — лишние пропущены.`);
      break;
    }
    const dataUrl = await readAsDataUrl(file);
    f.images.push({ name: file.name, dataUrl });
  }
  renderBatchList();
  updateBatchButtons();
  emit("batch");
}

export function removeFileImage(id, idx) {
  const f = state.batch.files.find(x => x.id === id);
  if (!f || !f.images || state.batch.running) return;
  f.images.splice(idx, 1);
  renderBatchList();
  updateBatchButtons();
  emit("batch");
}

// Перестановка файла drag&drop: порядок списка = порядок прогона и строк таблицы.
function moveFile(from, to) {
  if (state.batch.running) return;
  if (from < 0 || from >= state.batch.files.length || to < 0 || to >= state.batch.files.length) return;
  const [f] = state.batch.files.splice(from, 1);
  state.batch.files.splice(to, 0, f);
  renderBatchList();
  renderBatchResults();
  emit("batch");
}

const STATUS_MARKS = {
  pending: ["·", "batch-status-pending", "в очереди"],
  working: ["⏳", "batch-status-working", "в работе"],
  ok: ["✓", "batch-status-ok", "готово"],
  error: ["✗", "batch-status-error", "ошибка"],
};

// Текст превью: для .json — pretty-print, иначе как есть.
function previewText(f) {
  if (f.name.toLowerCase().endsWith(".json")) {
    try {
      return JSON.stringify(JSON.parse(f.text), null, 2);
    } catch { /* битый JSON — показываем сырой текст */ }
  }
  return f.text;
}

// Hover-мини-превью текстового файла: первые TIP_CHARS символов с «…».
function attachTextPreview(anchor, f) {
  anchor.addEventListener("mouseenter", () => {
    showTip(anchor, (tip) => {
      const pre = document.createElement("pre");
      pre.className = "tip-text";
      const text = previewText(f);
      pre.textContent = text.length > TIP_CHARS ? text.slice(0, TIP_CHARS) + "…" : text;
      tip.appendChild(pre);
    });
  });
  anchor.addEventListener("mouseleave", hideTip);
  anchor.addEventListener("click", () => {
    hideTip();
    openPreview({ kind: "text", text: previewText(f), name: f.name });
  });
}

function renderBatchList() {
  const list = document.getElementById("batch-list");
  list.innerHTML = "";
  state.batch.files.forEach((f, idx) => {
    const row = document.createElement("div");
    row.className = "batch-file-row";
    const [mark, markCls, markTitle] = STATUS_MARKS[f.status] || STATUS_MARKS.pending;

    // drag&drop порядка (во время прогона заблокирован)
    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "⠿";
    handle.title = "Перетащите, чтобы изменить порядок";
    handle.draggable = !state.batch.running;
    handle.addEventListener("dragstart", (e) => {
      if (state.batch.running) { e.preventDefault(); return; }
      e.dataTransfer.setData("text/plain", String(idx));
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    handle.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (e) => {
      if (state.batch.running) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", (e) => {
      if (state.batch.running) return;
      e.preventDefault();
      row.classList.remove("drop-target");
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      if (!isNaN(from) && from !== idx) moveFile(from, idx);
    });

    const status = document.createElement("span");
    status.className = "batch-status " + markCls;
    status.textContent = mark;
    status.title = f.error ? f.error : markTitle;
    row.append(handle, status);
    if (f.isImage) {
      const thumb = document.createElement("img");
      thumb.className = "batch-thumb";
      thumb.src = f.dataUrl;
      thumb.alt = f.name;
      thumb.title = f.name + " — клик: увеличить";
      // hover — увеличенное превью в тултипе, клик — лайтбокс.
      thumb.addEventListener("mouseenter", () => {
        showTip(thumb, (tip) => {
          const img = document.createElement("img");
          img.className = "tip-img";
          img.src = f.dataUrl;
          img.alt = f.name;
          tip.appendChild(img);
        });
      });
      thumb.addEventListener("mouseleave", hideTip);
      thumb.addEventListener("click", () => {
        hideTip();
        openLightbox({ src: f.dataUrl, name: f.name });
      });
      row.appendChild(thumb);
    }
    const name = document.createElement("span");
    name.className = "batch-file-name";
    name.textContent = f.name;
    name.title = f.name;
    // Текстовые файлы: hover по имени — мини-превью в тултипе, клик — оверлей.
    if (!f.isImage) {
      name.classList.add("batch-file-name-preview");
      name.title = f.name + " — клик: превью содержимого";
      attachTextPreview(name, f);
    }
    const size = document.createElement("span");
    size.className = "batch-file-size";
    size.textContent = `${(f.size / 1024).toFixed(1)} КБ`;
    row.append(name, size);
    // К текстовому файлу можно прикрепить до MAX_FILE_IMAGES изображений (📎).
    if (!f.isImage) {
      const attach = document.createElement("button");
      attach.className = "btn btn-small batch-attach-btn";
      attach.textContent = "📎";
      attach.disabled = state.batch.running || (f.images || []).length >= MAX_FILE_IMAGES;
      attach.title = attach.disabled && (f.images || []).length >= MAX_FILE_IMAGES
        ? `Уже ${MAX_FILE_IMAGES} изображения — максимум`
        : `Прикрепить изображение (до ${MAX_FILE_IMAGES})`;
      const imgInput = document.createElement("input");
      imgInput.type = "file";
      imgInput.accept = IMAGE_ACCEPT;
      imgInput.multiple = true;
      imgInput.className = "hidden";
      imgInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files.length) {
          attachImagesToFile(f.id, [...e.target.files]).catch(err => onErrorCb(err.message));
        }
        e.target.value = "";
      });
      attach.onclick = () => imgInput.click();
      row.append(attach, imgInput);
      // Миниатюры прикреплённых: hover — тултип с картинкой, клик — превью, ✕ — удалить.
      if (f.images && f.images.length) {
        const imgs = document.createElement("div");
        imgs.className = "batch-file-images";
        f.images.forEach((img, i) => {
          const thumb = document.createElement("span");
          thumb.className = "batch-att-thumb";
          const pic = document.createElement("img");
          pic.className = "batch-thumb";
          pic.src = img.dataUrl;
          pic.alt = img.name;
          pic.title = img.name + " — клик: увеличить";
          pic.addEventListener("mouseenter", () => {
            showTip(pic, (tip) => {
              const full = document.createElement("img");
              full.className = "tip-img";
              full.src = img.dataUrl;
              full.alt = img.name;
              tip.appendChild(full);
            });
          });
          pic.addEventListener("mouseleave", hideTip);
          pic.addEventListener("click", () => {
            hideTip();
            openPreview({ kind: "image", src: img.dataUrl, name: img.name });
          });
          thumb.appendChild(pic);
          const rm = document.createElement("button");
          rm.className = "batch-att-remove";
          rm.textContent = "✕";
          rm.title = "Убрать изображение";
          rm.disabled = state.batch.running;
          rm.onclick = (e) => { e.stopPropagation(); removeFileImage(f.id, i); };
          thumb.appendChild(rm);
          imgs.appendChild(thumb);
        });
        row.appendChild(imgs);
      }
    }
    if (f.warn) {
      const warn = document.createElement("span");
      warn.className = "batch-file-warn";
      warn.textContent = `⚠ > ${Math.round(MAX_CHARS / 1000)}k символов`;
      row.appendChild(warn);
    }
    if (f.status === "error" && f.error) {
      const err = document.createElement("span");
      err.className = "batch-file-error";
      err.textContent = f.error;
      row.appendChild(err);
    }
    const del = document.createElement("button");
    del.className = "btn btn-danger btn-small";
    del.textContent = "✕";
    del.title = "Убрать файл";
    del.disabled = state.batch.running;
    del.onclick = () => removeFile(f.id);
    row.appendChild(del);
    list.appendChild(row);
  });
  const warnBox = document.getElementById("batch-warn");
  const nWarn = state.batch.files.filter(f => f.warn).length;
  if (nWarn > 0) {
    warnBox.textContent = `${nWarn} ${nWarn === 1 ? "файл превышает" : "файлов превышают"} ${Math.round(MAX_CHARS / 1000)}k символов — модель может обработать не весь текст.`;
    warnBox.classList.remove("hidden");
  } else {
    warnBox.classList.add("hidden");
  }
}

function fmtDur(sec) {
  if (sec < 60) return `${Math.round(sec)} с`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m} мин ${s} с`;
}

function updateBatchProgress() {
  const total = state.batch.files.length;
  const done = state.batch.files.filter(f => f.status === "ok" || f.status === "error").length;
  const wrap = document.getElementById("batch-progress-wrap");
  const fill = document.getElementById("batch-progress-fill");
  const label = document.getElementById("batch-progress");
  if (!total) {
    wrap.classList.add("hidden");
    label.textContent = "";
    return;
  }
  wrap.classList.remove("hidden");
  fill.style.width = ((done / total) * 100).toFixed(1) + "%";
  const parts = [`обработано ${done} из ${total}`];
  if (state.batch.running) {
    const current = state.batch.files.find(f => f.status === "working");
    if (current) parts.push(`сейчас: ${current.name}`);
    if (state.batch.startedAt && done > 0) {
      const elapsed = (Date.now() - state.batch.startedAt) / 1000;
      const eta = (elapsed / done) * (total - done);
      parts.push(`прошло ${fmtDur(elapsed)}`);
      if (eta > 2) parts.push(`осталось ≈ ${fmtDur(eta)}`);
    } else if (state.batch.startedAt) {
      parts.push(`прошло ${fmtDur((Date.now() - state.batch.startedAt) / 1000)}`);
    }
  } else if (done === total && total > 0 && state.batch.startedAt && state.batch.finishedAt) {
    parts.push(`готово за ${fmtDur((state.batch.finishedAt - state.batch.startedAt) / 1000)}`);
  }
  label.textContent = parts.join(" · ");
}

function updateBatchButtons() {
  document.getElementById("btn-batch-clear").disabled =
    state.batch.running || state.batch.files.length === 0;
  document.getElementById("btn-batch-cancel").classList.toggle("hidden", !state.batch.running);
}

// ---------------------------------------------------------------- прогон

function parseFileInput(f) {
  if (f.name.toLowerCase().endsWith(".json")) {
    try {
      return JSON.parse(f.text);
    } catch {
      return f.text;
    }
  }
  return f.text;
}

export async function runBatch() {
  let questions, models;
  try {
    if (state.batch.files.length === 0) throw new Error("Добавьте хотя бы один файл.");
    questions = buildQuestionsPayload();
    models = selectedModelKeys();
    if (models.length === 0) throw new Error("Выберите хотя бы одну работающую модель.");
    if (state.batch.files.some(f => f.isImage || (f.images && f.images.length > 0)) &&
        !models.some(k => state.models.find(m => m.key === k)?.vision)) {
      throw new Error("В батче есть изображения, но ни одна из выбранных моделей их не поддерживает — выберите Clef.");
    }
    // Выключенное решение (enabled:false) не валидируем и не применяем.
    if (!state.decision || state.decision.enabled !== false) {
      validateDecision(state.decision, state.questions);
    }
  } catch (e) {
    onErrorCb(e.message);
    return;
  }
  // Для файлов с картинками (image-файл или прикреплённые изображения)
  // non-vision модели пропускаем (бэк ответил бы 422 на весь запрос).
  const visionModels = models.filter(k => state.models.find(m => m.key === k)?.vision);

  state.batch.running = true;
  state.batch.cancelled = false;
  state.batch.startedAt = Date.now();
  state.batch.finishedAt = null;
  // Снапшот правил решения на момент прогона (null — не заданы или выключены;
  // collapsed — UI-состояние редактора, в снапшот не идёт).
  state.batch.decision = state.decision && state.decision.enabled !== false &&
    state.decision.outcomes && state.decision.outcomes.length
    ? JSON.parse(JSON.stringify(state.decision)) : null;
  if (state.batch.decision) for (const o of state.batch.decision.outcomes) delete o.collapsed;
  updateBatchButtons();
  emit("batch");
  for (const f of state.batch.files) {
    f.status = "pending";
    f.error = null;
  }
  renderBatchList();
  updateBatchProgress();

  const tick = setInterval(updateBatchProgress, 1000);
  try {
    for (const f of state.batch.files) {
      if (state.batch.cancelled) break;
      f.status = "working";
      renderBatchList();
      updateBatchProgress();
      const t0 = Date.now();
      try {
        const needsVision = f.isImage || (f.images && f.images.length > 0);
        const body = {
          input: f.isImage ? f.text : parseFileInput(f),
          questions,
          models: needsVision ? visionModels : models,
          mode: "decisions",
          temperature: state.temperature,
        };
        if (f.isImage) body.images = [f.dataUrl];
        else if (needsVision) body.images = f.images.map(img => img.dataUrl);
        const pinned = new Set(models.map(k => state.pinnedFormats[k]).filter(v => v != null));
        if (pinned.size === 1) body.prompt_format_version = [...pinned][0];
        const data = await decide(body);
        state.batch.results[f.id] = data.results || {};
        state.batch.durations[f.id] = (Date.now() - t0) / 1000;
        f.status = "ok";
        for (const [key, res] of Object.entries(data.results || {})) {
          if (res.ok && res.prompt_format_version != null) {
            state.pinnedFormats[key] = res.prompt_format_version;
          }
        }
      } catch (e) {
        f.status = "error";
        f.error = e.message;
      }
      renderBatchList();
      updateBatchProgress();
      renderBatchResults(); // инкрементально: готовые строки появляются по ходу прогона
    }
  } finally {
    clearInterval(tick);
  }

  state.batch.running = false;
  state.batch.finishedAt = Date.now();
  updateBatchButtons();
  updateBatchProgress();
  renderBatchResults();
  emit("batch");
}

// ---------------------------------------------------------------- результаты

function okFileResults() {
  // [{file, perModel: {key: res}}] только для успешных файлов
  const out = [];
  for (const f of state.batch.files) {
    if (f.status !== "ok" || !state.batch.results[f.id]) continue;
    out.push({ file: f, perModel: state.batch.results[f.id] });
  }
  return out;
}

function modelKeysInResults() {
  const keys = [];
  for (const { perModel } of okFileResults()) {
    for (const k of Object.keys(perModel)) {
      if (perModel[k] && perModel[k].ok && !keys.includes(k)) keys.push(k);
    }
  }
  return keys;
}

function batchCell(ans, q, key) {
  const td = document.createElement("td");
  td.className = "batch-cell";
  const val = document.createElement("span");
  val.className = "batch-cell-answer " + confClass(answerConfidence(ans));
  // score с направлением: dir-* поверх conf-* (в CSS правила dir-* идут позже).
  const dirCls = ans.type === "score" ? scoreDirClass(q, (ans.score ?? 0) + 1) : null;
  if (dirCls) val.classList.add(dirCls);
  val.textContent = shortAnswer(ans);
  td.appendChild(val);
  if (ans.label_mass != null && ans.label_mass < 0.5) {
    const warn = document.createElement("span");
    warn.className = "answer-warn";
    warn.textContent = " ⚠";
    warn.title = "модель скорее ответила бы чем-то другим";
    td.appendChild(warn);
  }
  // Ховер — тултип распределения, как в одиночном режиме.
  td.addEventListener("mouseenter", () => {
    showTip(td, (tip) => {
      const t = document.createElement("div");
      t.className = "dist-tip-title";
      t.textContent = `${modelLabel(key)} · ${q.question}`;
      tip.appendChild(t);
      tip.appendChild(distributionBars(ans, q));
      const full = document.createElement("div");
      full.className = "dist-tip-answer";
      full.textContent = "Ответ: " + shortAnswer(ans);
      tip.appendChild(full);
      if (ans.label_mass != null && ans.label_mass < 0.5) {
        const mass = document.createElement("div");
        mass.className = "dist-tip-warn";
        mass.textContent = `⚠ модель скорее ответила бы чем-то другим (доля на вариантах ${(ans.label_mass * 100).toFixed(0)}%)`;
        tip.appendChild(mass);
      }
    });
  });
  td.addEventListener("mouseleave", hideTip);
  return td;
}

// Правила решения заданы и включены для текущего батч-прогона?
function hasBatchDecision() {
  const d = state.batch.decision;
  return !!(d && d.enabled !== false && d.outcomes && d.outcomes.length);
}

// Ячейка-бейдж решения по файлу×модели.
function batchDecisionCell(perModel, key, questions) {
  const td = document.createElement("td");
  td.className = "batch-cell batch-decision-cell";
  const res = perModel[key];
  if (!res || !res.ok) { td.textContent = "—"; return td; }
  const { res: dec, trace } = explainDecision(state.batch.decision, res.answers || {});
  const badge = document.createElement("span");
  badge.className = "decision-chip";
  if (dec) {
    const colors = OUTCOME_COLORS[dec.color] || OUTCOME_COLORS.gray;
    badge.style.background = colors.bg;
    badge.style.color = colors.fg;
    badge.style.borderColor = colors.border;
    badge.textContent = dec.label;
  } else {
    badge.classList.add("decision-chip-none");
    badge.textContent = "не определено";
  }
  attachDecisionTip(badge, dec, trace, questions);
  td.appendChild(badge);
  return td;
}

// Сворачиваемое превью содержимого файла для дрилдауна (первые PREVIEW_CHARS
// символов; для image-файла — миниатюра, клик открывает лайтбокс).
function renderDrilldownPreview(file) {
  const box = document.createElement("div");
  box.className = "batch-preview batch-detail-preview";
  const cap = document.createElement("div");
  cap.className = "batch-detail-model-title batch-detail-preview-toggle";
  cap.textContent = "▾ Содержимое файла";
  cap.title = "Клик: свернуть/развернуть";
  box.appendChild(cap);
  if (file.isImage) {
    // Миниатюра вместо инлайн-картинки: клик открывает лайтбокс.
    const img = document.createElement("img");
    img.className = "batch-drilldown-thumb";
    img.src = file.dataUrl;
    img.alt = file.name;
    img.title = file.name + " — клик: увеличить";
    img.addEventListener("click", (e) => {
      e.stopPropagation();
      openLightbox({ src: file.dataUrl, name: file.name });
    });
    box.appendChild(img);
    let collapsed = false;
    cap.addEventListener("click", () => {
      collapsed = !collapsed;
      img.classList.toggle("hidden", collapsed);
      cap.textContent = (collapsed ? "▸" : "▾") + " Содержимое файла";
    });
    return box;
  }
  const pre = document.createElement("pre");
  pre.className = "batch-preview-text";
  const text = previewText(file);
  const truncated = text.length > PREVIEW_CHARS;
  pre.textContent = truncated ? text.slice(0, PREVIEW_CHARS) + "…" : text;
  box.appendChild(pre);
  let more = null;
  if (truncated) {
    more = document.createElement("button");
    more.className = "btn btn-small batch-preview-more";
    more.textContent = `Развернуть полностью (${text.length} символов)`;
    more.onclick = (e) => {
      e.stopPropagation();
      pre.textContent = text;
      more.remove();
      more = null;
    };
    box.appendChild(more);
  }
  // Прикреплённые изображения: миниатюры под текстом, клик — лайтбокс.
  let imgRow = null;
  if (file.images && file.images.length) {
    imgRow = document.createElement("div");
    imgRow.className = "batch-drilldown-images";
    for (const img of file.images) {
      const pic = document.createElement("img");
      pic.className = "batch-drilldown-thumb";
      pic.src = img.dataUrl;
      pic.alt = img.name;
      pic.title = img.name + " — клик: увеличить";
      pic.addEventListener("click", (e) => {
        e.stopPropagation();
        openLightbox({ src: img.dataUrl, name: img.name });
      });
      imgRow.appendChild(pic);
    }
    box.appendChild(imgRow);
  }
  let collapsed = false;
  cap.addEventListener("click", () => {
    collapsed = !collapsed;
    pre.classList.toggle("hidden", collapsed);
    if (more) more.classList.toggle("hidden", collapsed);
    if (imgRow) imgRow.classList.toggle("hidden", collapsed);
    cap.textContent = (collapsed ? "▸" : "▾") + " Содержимое файла";
  });
  return box;
}

// Дрилдаун файла: превью содержимого + режим A для этого файла по каждой показанной модели.
function renderFileDrilldown(file, perModel, questions, shownKeys) {
  const td = document.createElement("td");
  td.colSpan = 1 + shownKeys.length * questions.length
    + (hasBatchDecision() ? shownKeys.length : 0);
  td.appendChild(renderDrilldownPreview(file));
  const wrap = document.createElement("div");
  wrap.className = "batch-detail-models";
  for (const k of shownKeys) {
    const res = perModel[k];
    if (!res || !res.ok) continue;
    const block = document.createElement("div");
    const title = document.createElement("div");
    title.className = "batch-detail-model-title";
    title.textContent = modelLabel(k);
    block.appendChild(title);
    if (hasBatchDecision()) {
      const decLine = document.createElement("div");
      decLine.className = "batch-detail-decision";
      decLine.appendChild(batchDecisionCell(perModel, k, questions).firstChild || document.createTextNode("—"));
      block.appendChild(decLine);
    }
    for (const q of questions) {
      const ans = res.answers && res.answers[q.id];
      if (!ans) continue;
      block.appendChild(renderAnswerDrilldown(ans, q, { key: k, mode: res.metrics?.mode || "decisions" }));
    }
    wrap.appendChild(block);
  }
  td.appendChild(wrap);
  return td;
}

function aggregateValue(q, answers) {
  if (!answers.length) return "—";
  if (q.type === "yes_no") {
    const yesN = answers.filter(a => (a.probabilities?.yes ?? 0) >= (a.probabilities?.no ?? 0)).length;
    return `да в ${((yesN / answers.length) * 100).toFixed(0)}%`;
  }
  if (q.type === "choice") {
    const tops = answers.map(a => a.choice ?? null).filter(Boolean);
    if (!tops.length) return "—";
    const counts = {};
    for (const t of tops) counts[t] = (counts[t] || 0) + 1;
    const [topName, topN] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return `${topName} · ${((topN / answers.length) * 100).toFixed(0)}%`;
  }
  if (q.type === "score") {
    const mean = answers.reduce((s, a) => s + (a.score ?? 0), 0) / answers.length;
    return `в среднем ${mean.toFixed(2)}`;
  }
  return "—";
}

export function renderBatchResults() {
  hideTip(); // перерендер сбрасывает висящий тултип со ссылкой на старые ячейки
  const wrap = document.getElementById("batch-results");
  wrap.innerHTML = "";
  const rows = okFileResults();
  updateBatchButtons();
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "results-empty";
    empty.textContent = "Запустите прогон — результаты появятся здесь.";
    wrap.appendChild(empty);
    return;
  }

  const questions = buildQuestionsPayloadQuiet() || [];

  // сводные чипы
  const chips = document.createElement("div");
  chips.className = "batch-chips";
  const nWarnFiles = state.batch.files.filter(f => {
    const per = state.batch.results[f.id];
    if (!per) return false;
    return Object.values(per).some(res =>
      res && res.ok && Object.values(res.answers || {}).some(a => a.label_mass != null && a.label_mass < 0.5));
  }).length;
  const durs = Object.values(state.batch.durations);
  const meanDur = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0;
  chips.textContent = [
    `обработано ${rows.length} из ${state.batch.files.length}`,
    nWarnFiles ? `файлов с ⚠: ${nWarnFiles}` : null,
    durs.length ? `среднее время/файл ${meanDur.toFixed(1)} c` : null,
  ].filter(Boolean).join(" · ");
  wrap.appendChild(chips);

  // селектор модели
  const keys = modelKeysInResults();
  const selRow = document.createElement("div");
  selRow.className = "batch-sel-row";
  const selLabel = document.createElement("span");
  selLabel.className = "hint";
  selLabel.textContent = "Модель:";
  const sel = document.createElement("select");
  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = "Все модели";
  sel.appendChild(allOpt);
  for (const k of keys) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = modelLabel(k);
    sel.appendChild(opt);
  }
  sel.value = keys.includes(batchModelSel) ? batchModelSel : "all";
  batchModelSel = sel.value;
  sel.onchange = () => { batchModelSel = sel.value; renderBatchResults(); };
  selRow.append(selLabel, sel);
  wrap.appendChild(selRow);

  const shownKeys = batchModelSel === "all" ? keys : keys.filter(k => k === batchModelSel);

  // таблица файлы × вопросы
  const tableWrap = document.createElement("div");
  tableWrap.className = "batch-table-wrap";
  const table = document.createElement("table");
  table.className = "compare-table batch-table";

  const thead = document.createElement("thead");
  if (shownKeys.length > 1) {
    // Вопрос-major: верхняя строка — вопросы (colSpan по моделям), нижняя — модели.
    const hrowTop = document.createElement("tr");
    const corner = document.createElement("th");
    corner.rowSpan = 2;
    corner.textContent = "Файл";
    hrowTop.appendChild(corner);
    const hrowSub = document.createElement("tr");
    for (const q of questions) {
      const th = document.createElement("th");
      th.colSpan = shownKeys.length;
      th.textContent = (q.question || "").slice(0, 24);
      th.title = q.question;
      hrowTop.appendChild(th);
      for (const k of shownKeys) {
        const thSub = document.createElement("th");
        thSub.textContent = modelShortLabel(k);
        thSub.title = modelLabel(k);
        hrowSub.appendChild(thSub);
      }
    }
    if (hasBatchDecision()) {
      const th = document.createElement("th");
      th.colSpan = shownKeys.length;
      th.textContent = "Решение";
      hrowTop.appendChild(th);
      for (const k of shownKeys) {
        const thSub = document.createElement("th");
        thSub.textContent = modelShortLabel(k);
        thSub.title = modelLabel(k);
        hrowSub.appendChild(thSub);
      }
    }
    thead.append(hrowTop, hrowSub);
  } else {
    const hrow = document.createElement("tr");
    const corner = document.createElement("th");
    corner.textContent = "Файл";
    hrow.appendChild(corner);
    for (const q of questions) {
      const th = document.createElement("th");
      th.textContent = (q.question || "").slice(0, 40);
      th.title = q.question;
      hrow.appendChild(th);
    }
    if (hasBatchDecision()) {
      const th = document.createElement("th");
      th.textContent = "Решение";
      hrow.appendChild(th);
    }
    thead.appendChild(hrow);
  }
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const openDrilldowns = new Set();
  for (const { file, perModel } of rows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.className = "compare-question batch-file-th";
    if (file.isImage) {
      const thumb = document.createElement("img");
      thumb.className = "batch-cell-thumb";
      thumb.src = file.dataUrl;
      thumb.alt = file.name;
      thumb.title = file.name + " — клик: увеличить";
      thumb.addEventListener("mouseenter", () => {
        showTip(thumb, (tip) => {
          const img = document.createElement("img");
          img.className = "tip-img";
          img.src = file.dataUrl;
          img.alt = file.name;
          tip.appendChild(img);
        });
      });
      thumb.addEventListener("mouseleave", hideTip);
      thumb.addEventListener("click", (e) => {
        e.stopPropagation();
        hideTip();
        openLightbox({ src: file.dataUrl, name: file.name });
      });
      th.appendChild(thumb);
    }
    // Прикреплённые картинки текстового файла — миниатюры рядом с именем.
    if (!file.isImage && file.images && file.images.length) {
      for (const img of file.images) {
        const thumb = document.createElement("img");
        thumb.className = "batch-cell-thumb";
        thumb.src = img.dataUrl;
        thumb.alt = img.name;
        thumb.title = img.name + " — клик: увеличить";
        thumb.addEventListener("mouseenter", () => {
          showTip(thumb, (tip) => {
            const full = document.createElement("img");
            full.className = "tip-img";
            full.src = img.dataUrl;
            full.alt = img.name;
            tip.appendChild(full);
          });
        });
        thumb.addEventListener("mouseleave", hideTip);
        thumb.addEventListener("click", (e) => {
          e.stopPropagation();
          hideTip();
          openLightbox({ src: img.dataUrl, name: img.name });
        });
        th.appendChild(thumb);
      }
    }
    const nameSpan = document.createElement("span");
    nameSpan.className = "batch-file-th-name";
    nameSpan.textContent = file.name;
    th.appendChild(nameSpan);
    // Дрилдаун: для image-файла — по клику на имя (как раньше); для текстового
    // имя открывает превью, а дрилдаун — по стрелке рядом.
    let drillToggle = nameSpan;
    if (!file.isImage) {
      nameSpan.classList.add("batch-file-name-preview");
      nameSpan.title = file.name + " — клик: превью содержимого";
      attachTextPreview(nameSpan, file);
      const chevron = document.createElement("span");
      chevron.className = "batch-file-th-chevron";
      chevron.textContent = "▾";
      chevron.title = file.name + " — клик: детали по вопросам";
      th.appendChild(chevron);
      drillToggle = chevron;
    } else {
      nameSpan.title = file.name + " — клик: детали по вопросам";
    }
    tr.appendChild(th);
    for (const q of questions) {
      for (const k of shownKeys) {
        const res = perModel[k];
        const ans = res && res.ok && res.answers && res.answers[q.id];
        if (ans) {
          tr.appendChild(batchCell(ans, q, k));
        } else {
          const td = document.createElement("td");
          td.textContent = res && !res.ok ? "✗" : "—";
          if (res && !res.ok) td.title = res.error || "ошибка";
          tr.appendChild(td);
        }
      }
    }
    if (hasBatchDecision()) {
      for (const k of shownKeys) tr.appendChild(batchDecisionCell(perModel, k, questions));
    }
    tbody.appendChild(tr);

    // дрилдаун файла (режим A) по клику на имя/стрелку
    const detailTr = document.createElement("tr");
    detailTr.className = "batch-detail-row hidden";
    detailTr.appendChild(renderFileDrilldown(file, perModel, questions, shownKeys));
    drillToggle.addEventListener("click", () => {
      if (openDrilldowns.has(file.id)) {
        openDrilldowns.delete(file.id);
        detailTr.classList.add("hidden");
      } else {
        openDrilldowns.add(file.id);
        detailTr.classList.remove("hidden");
      }
    });
    tbody.appendChild(detailTr);
  }

  // агрегатная строка
  const aggTr = document.createElement("tr");
  aggTr.className = "batch-agg-row";
  const aggTh = document.createElement("th");
  aggTh.textContent = "Итого";
  aggTr.appendChild(aggTh);
  for (const q of questions) {
    for (const k of shownKeys) {
      const answers = rows
        .map(({ perModel }) => perModel[k])
        .filter(res => res && res.ok && res.answers && res.answers[q.id])
        .map(res => res.answers[q.id]);
      const td = document.createElement("td");
      td.className = "batch-agg";
      td.textContent = aggregateValue(q, answers);
      aggTr.appendChild(td);
    }
  }
  if (hasBatchDecision()) {
    for (const k of shownKeys) {
      const counts = {};
      for (const { perModel } of rows) {
        const res = perModel[k];
        if (!res || !res.ok) continue;
        const dec = evaluateDecision(state.batch.decision, res.answers || {});
        const lbl = dec ? dec.label : "не определено";
        counts[lbl] = (counts[lbl] || 0) + 1;
      }
      const td = document.createElement("td");
      td.className = "batch-agg";
      td.textContent = Object.entries(counts).sort((a, b) => b[1] - a[1])
        .map(([l, c]) => `${l}×${c}`).join(", ") || "—";
      aggTr.appendChild(td);
    }
  }
  tbody.appendChild(aggTr);
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);

  // экспорт
  const expRow = document.createElement("div");
  expRow.className = "batch-export-row";
  const csvBtn = document.createElement("button");
  csvBtn.className = "btn btn-small";
  csvBtn.textContent = "Экспорт CSV";
  csvBtn.onclick = () => download(buildBatchCsv(rows, questions), "batch_results.csv", "text/csv");
  const jsonBtn = document.createElement("button");
  jsonBtn.className = "btn btn-small";
  jsonBtn.textContent = "Экспорт JSON";
  jsonBtn.onclick = () => {
    const withDecision = hasBatchDecision();
    const dump = {
      files: state.batch.files.map(f => ({ name: f.name, size: f.size, status: f.status, error: f.error, duration_s: state.batch.durations[f.id] ?? null })),
      questions,
      results: state.batch.results,
    };
    if (withDecision) {
      dump.decision = state.batch.decision;
      dump.decisions = {};
      for (const f of state.batch.files) {
        const per = state.batch.results[f.id];
        if (!per) continue;
        for (const [key, res] of Object.entries(per)) {
          if (!res || !res.ok) continue;
          const dec = evaluateDecision(state.batch.decision, res.answers || {});
          (dump.decisions[f.name] = dump.decisions[f.name] || {})[key] =
            dec ? { label: dec.label, isDefault: dec.isDefault } : null;
        }
      }
    }
    download(JSON.stringify(dump, null, 2), "batch_results.json", "application/json");
  };
  expRow.append(csvBtn, jsonBtn);
  wrap.appendChild(expRow);

  updateBatchButtons();
}

function buildQuestionsPayloadQuiet() {
  let payload;
  try {
    payload = buildQuestionsPayload();
  } catch {
    payload = state.questions;
  }
  // direction живёт только в state.questions — подмешиваем для маркировки ячеек.
  return payload.map(q => {
    if (q.type !== "score" || q.direction) return q;
    const src = state.questions.find(x => x.id === q.id);
    return src && src.direction ? { ...q, direction: src.direction } : q;
  });
}

function csvEscape(s) {
  const str = String(s ?? "");
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function buildBatchCsv(rows, questions) {
  const withDecision = hasBatchDecision();
  const header = ["файл", "модель", "вопрос", "ответ", "вероятность_ответа", "доля_на_вариантах"];
  if (withDecision) header.push("решение");
  const lines = [header.join(",")];
  for (const { file, perModel } of rows) {
    for (const [key, res] of Object.entries(perModel)) {
      if (!res || !res.ok) continue;
      const dec = withDecision ? evaluateDecision(state.batch.decision, res.answers || {}) : null;
      for (const q of questions) {
        const ans = res.answers && res.answers[q.id];
        if (!ans) continue;
        const cols = [
          csvEscape(file.name),
          csvEscape(key),
          csvEscape(q.question),
          csvEscape(shortAnswer(ans)),
          (answerConfidence(ans)).toFixed(4),
          ans.label_mass == null ? "" : ans.label_mass.toFixed(4),
        ];
        if (withDecision) cols.push(csvEscape(dec ? dec.label : "не определено"));
        lines.push(cols.join(","));
      }
    }
  }
  return lines.join("\n") + "\n";
}

function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------- init

export function initBatch({ showError, onBack }) {
  onErrorCb = showError || (() => {});

  const backBtn = document.getElementById("btn-batch-back");
  if (backBtn && onBack) backBtn.addEventListener("click", onBack);

  // Двухпанельный сплит «Ввод | Результаты» — тот же механизм, что у одиночного режима.
  const split = document.getElementById("split-batch");
  if (split && state.batchPanels) {
    createSplitLayout({
      split,
      splitter: document.getElementById("splitter-batch"),
      restoreLeft: document.getElementById("batch-restore-left"),
      restoreRight: document.getElementById("batch-restore-right"),
      panels: state.batchPanels,
      widthKey: "dq-batch-panel-width",
    }).init();
  }

  // Вертикальный сплит «Файлы | Вопросы» внутри левой панели батча.
  const filesCard = document.getElementById("batch-files-card");
  const vsplit = document.getElementById("vsplit-batch");
  if (filesCard && vsplit && filesCard.parentNode) {
    createVSplit({
      top: filesCard,
      splitter: vsplit,
      container: filesCard.parentNode,
      heightKey: "dq-vsplit-batch",
    }).init();
  }

  const drop = document.getElementById("batch-drop");
  const input = document.getElementById("batch-files");
  input.addEventListener("change", (e) => {
    if (e.target.files.length) addFiles([...e.target.files]).catch(err => onErrorCb(err.message));
    e.target.value = "";
  });
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("drag-over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag-over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag-over");
    const files = [...e.dataTransfer.files].filter(f =>
      /\.(txt|md|json)$/i.test(f.name) || isImageFile(f) || isRejectedImage(f));
    if (files.length) addFiles(files).catch(err => onErrorCb(err.message));
  });

  document.getElementById("btn-batch-cancel").onclick = () => {
    state.batch.cancelled = true;
  };
  document.getElementById("btn-batch-clear").onclick = clearFiles;

  renderBatchList();
  renderBatchResults();
  updateBatchButtons();
  emit("batch");
}
