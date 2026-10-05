// Превью файлов: единая точка входа openPreview({kind, src?, text?, name}).
// kind:"image" делегируется лайтбоксу; kind:"text" — синглтон-оверлей с
// моноширинным <pre>, шапкой (имя файла), кнопкой «⛶ На весь экран»
// (Fullscreen API с CSS-фолбэком), закрытием по Esc и клику по фону.

import { openLightbox } from "./lightbox.js";

let overlay = null;
let textEl = null;
let captionEl = null;
let escDoc = null;   // document, на котором уже висит Esc-обработчик

function build() {
  overlay = document.createElement("div");
  overlay.className = "preview-overlay hidden";

  const box = document.createElement("div");
  box.className = "preview-box";
  box.addEventListener("click", (e) => e.stopPropagation());

  const bar = document.createElement("div");
  bar.className = "preview-bar";

  captionEl = document.createElement("span");
  captionEl.className = "preview-caption";
  bar.appendChild(captionEl);

  const fsBtn = document.createElement("button");
  fsBtn.type = "button";
  fsBtn.className = "btn btn-small preview-fs";
  fsBtn.textContent = "⛶ На весь экран";
  fsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (typeof box.requestFullscreen === "function") {
      const p = box.requestFullscreen();
      if (p && p.catch) p.catch(() => overlay.classList.add("preview-full"));
    } else {
      // Фолбэк без Fullscreen API: растягиваем оверлей на весь вьюпорт.
      overlay.classList.toggle("preview-full");
    }
  });
  bar.appendChild(fsBtn);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn-small preview-close";
  closeBtn.textContent = "✕";
  closeBtn.title = "Закрыть (Esc)";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closePreview();
  });
  bar.appendChild(closeBtn);

  box.appendChild(bar);

  textEl = document.createElement("pre");
  textEl.className = "preview-text";
  box.appendChild(textEl);

  overlay.appendChild(box);
  overlay.addEventListener("click", () => closePreview());
  document.body.appendChild(overlay);
}

function openText({ text, name }) {
  if (!overlay) build();
  if (overlay.parentNode !== document.body) document.body.appendChild(overlay);
  if (escDoc !== document) {
    escDoc = document;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePreview();
    });
  }
  textEl.textContent = text ?? "";
  captionEl.textContent = name || "";
  overlay.classList.remove("hidden");
}

export function openPreview({ kind, src, text, name }) {
  if (kind === "image") {
    openLightbox({ src, name });
    return;
  }
  openText({ text, name });
}

export function closePreview() {
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.classList.remove("preview-full");
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen();
  }
}

export function isPreviewOpen() {
  return !!overlay && !overlay.classList.contains("hidden");
}
