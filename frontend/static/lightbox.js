// Лайтбокс изображений: оверлей поверх всех слоёв приложения, картинка по
// центру, кнопка «⛶ На весь экран» (Fullscreen API с CSS-фолбэком), ✕,
// закрытие по Esc и клику по фону. Singleton: повторное открытие заменяет
// содержимое того же оверлея.

let overlay = null;
let imgEl = null;
let captionEl = null;
let escDoc = null;   // document, на котором уже висит Esc-обработчик

function build() {
  overlay = document.createElement("div");
  overlay.className = "lightbox-overlay hidden";

  const box = document.createElement("div");
  box.className = "lightbox-box";
  box.addEventListener("click", (e) => e.stopPropagation());

  imgEl = document.createElement("img");
  imgEl.className = "lightbox-img";
  box.appendChild(imgEl);

  const bar = document.createElement("div");
  bar.className = "lightbox-bar";

  captionEl = document.createElement("span");
  captionEl.className = "lightbox-caption";
  bar.appendChild(captionEl);

  const fsBtn = document.createElement("button");
  fsBtn.type = "button";
  fsBtn.className = "btn btn-small lightbox-fs";
  fsBtn.textContent = "⛶ На весь экран";
  fsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (typeof box.requestFullscreen === "function") {
      const p = box.requestFullscreen();
      if (p && p.catch) p.catch(() => overlay.classList.add("lightbox-full"));
    } else {
      // Фолбэк без Fullscreen API: растягиваем оверлей на весь вьюпорт.
      overlay.classList.toggle("lightbox-full");
    }
  });
  bar.appendChild(fsBtn);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn-small lightbox-close";
  closeBtn.textContent = "✕";
  closeBtn.title = "Закрыть (Esc)";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeLightbox();
  });
  bar.appendChild(closeBtn);

  box.appendChild(bar);
  overlay.appendChild(box);
  overlay.addEventListener("click", () => closeLightbox());
  document.body.appendChild(overlay);
}

export function openLightbox({ src, name }) {
  if (!overlay) build();
  if (overlay.parentNode !== document.body) document.body.appendChild(overlay);
  if (escDoc !== document) {
    escDoc = document;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeLightbox();
    });
  }
  imgEl.src = src;
  imgEl.alt = name || "изображение";
  captionEl.textContent = name || "";
  overlay.classList.remove("hidden");
}

export function closeLightbox() {
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.classList.remove("lightbox-full");
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen();
  }
}

export function isLightboxOpen() {
  return !!overlay && !overlay.classList.contains("hidden");
}
