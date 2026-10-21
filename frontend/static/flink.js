// Ссылки на файлы пакета (flink, концепция «Рамс», V-2): имя файла — моно с
// пунктирной underline (отличие от действия-ссылки по двум каналам, не
// цветом); hover → превью-поповер (начало текста или миниатюра + «Открыть на
// весь экран»; единственная тень в системе — отслойка оверлея), клик →
// полный экран через preview.js, Esc / клик мимо → закрыть. Один паттерн для
// txt и изображений. Несуществующий файл — не ссылка, обычный моно-текст.
// Покрытие: только развёрнутое содержимое карточек; в свёрнутых строках и
// summary файлы остаются обычным текстом (там кликабельна вся строка).
// Данные — из state.batch.files (text/dataUrl уже на фронте, без запросов);
// если текста нет — превью честно показывает только мету.

import { state } from "./state.js";
import { openPreview } from "./preview.js";

const PREVIEW_CHARS = 400;   // начало текста в поповере
const HIDE_DELAY = 200;      // мс на переход курсора ссылка → поповер

export function findBatchFile(name) {
  return state.batch.files.find(f => f.name === name) || null;
}

function fileMeta(f) {
  if (f.isImage) return f.size ? `${Math.round(f.size / 1024)} КБ` : "изображение";
  const len = String(f.text || "").length;
  return `${len} симв.`;
}

function openFileFull(f) {
  if (f.isImage) openPreview({ kind: "image", src: f.dataUrl, name: f.name });
  else openPreview({ kind: "text", text: String(f.text || ""), name: f.name });
}

// ---------------------------------------------------------------- поповер (синглтон)

let popover = null;
let pvName, pvMeta, pvBody, pvImg;
let hideTimer = null;
let wired = false;

function buildPopover() {
  popover = document.createElement("div");
  popover.className = "assistant-flink-popover hidden";
  const head = document.createElement("div");
  head.className = "assistant-flink-pv-head";
  pvName = document.createElement("span");
  pvName.className = "assistant-flink-pv-name";
  pvMeta = document.createElement("span");
  pvMeta.className = "assistant-flink-pv-meta";
  head.append(pvName, pvMeta);
  pvBody = document.createElement("div");
  pvBody.className = "assistant-flink-pv-body";
  pvImg = document.createElement("img");
  pvImg.className = "assistant-flink-pv-img hidden";
  pvImg.alt = "";
  const foot = document.createElement("div");
  foot.className = "assistant-flink-pv-foot";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "assistant-decline";  // ghost-ярус
  open.textContent = "Открыть на весь экран";
  open.addEventListener("click", () => {
    const f = popover._file;
    hidePopover();
    if (f) openFileFull(f);
  });
  const hint = document.createElement("span");
  hint.className = "assistant-flink-pv-hint";
  hint.textContent = "Esc или клик мимо — закрыть";
  foot.append(open, hint);
  popover.append(head, pvBody, pvImg, foot);
  // курсор над поповером удерживает его открытым
  popover.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  popover.addEventListener("mouseleave", scheduleHide);
  document.body.appendChild(popover);
}

function wireGlobal() {
  if (wired) return;
  wired = true;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hidePopover();
  });
  document.addEventListener("mousedown", (e) => {
    if (!popover || popover.classList.contains("hidden")) return;
    if (popover.contains(e.target)) return;
    if (e.target && e.target.classList
        && e.target.classList.contains("assistant-flink")) return;
    hidePopover();
  });
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hidePopover, HIDE_DELAY);
}

function showPopover(link, f) {
  if (!popover) buildPopover();
  wireGlobal();
  clearTimeout(hideTimer);
  popover._file = f;
  pvName.textContent = f.name;
  pvMeta.textContent = fileMeta(f);
  if (f.isImage) {
    pvImg.src = f.dataUrl || "";
    pvImg.classList.remove("hidden");
    pvBody.classList.add("hidden");
  } else {
    pvImg.classList.add("hidden");
    pvBody.classList.remove("hidden");
    const text = String(f.text || "");
    pvBody.textContent = text
      ? (text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + "…" : text)
      : "(пустой файл)";
  }
  popover.classList.remove("hidden");
  // позиция: над ссылкой, не хватает места — под ней; от правого края не вылезаем
  const r = link.getBoundingClientRect();
  const w = popover.offsetWidth || 320;
  const h = popover.offsetHeight || 120;
  const iw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const ih = typeof window !== "undefined" ? window.innerHeight : 800;
  popover.style.left = Math.max(8, Math.min(r.left, iw - w - 8)) + "px";
  popover.style.top = (r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8) + "px";
  if (r.bottom + 8 + h > ih && r.top - h - 8 >= 8) {
    popover.style.top = (r.top - h - 8) + "px";
  }
}

function hidePopover() {
  clearTimeout(hideTimer);
  if (popover) popover.classList.add("hidden");
}

// Ссылка на файл пакета по имени; файла нет (несуществующий/чужой) — обычный
// моно-текст без поведения.
export function fileLinkEl(name) {
  const f = findBatchFile(name);
  if (!f) {
    const s = document.createElement("span");
    s.className = "assistant-flink-plain";
    s.textContent = name;
    return s;
  }
  const b = document.createElement("button");
  b.type = "button";
  b.className = "assistant-flink";
  b.textContent = name;
  b.title = "Навести — превью, клик — на весь экран";
  b.addEventListener("mouseenter", () => showPopover(b, f));
  b.addEventListener("mouseleave", scheduleHide);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    hidePopover();
    openFileFull(f);
  });
  return b;
}
