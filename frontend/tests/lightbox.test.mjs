// Доменные тесты: lightbox. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, installDom, resetState, sleep, lightbox,
} from "./harness.mjs";

// ================================================================ lightbox

test("lightbox: открытие, singleton, закрытие по ✕, Esc и клику по фону", async () => {
  installDom(); await resetState();
  lightbox.openLightbox({ src: "data:image/png;base64,QUJD", name: "a.png" });
  const ov = document.body.querySelector(".lightbox-overlay");
  assert(ov && !ov.classList.contains("hidden"), "оверлей открыт");
  eq(ov.querySelector(".lightbox-img").src, "data:image/png;base64,QUJD", "src картинки");
  eq(ov.querySelector(".lightbox-caption").textContent, "a.png", "подпись-имя");
  assert(lightbox.isLightboxOpen(), "isLightboxOpen");
  // singleton: повторное открытие заменяет содержимое, оверлей один
  lightbox.openLightbox({ src: "data:image/png;base64,REVG", name: "b.png" });
  eq(document.body.querySelectorAll(".lightbox-overlay").length, 1, "оверлей один");
  eq(ov.querySelector(".lightbox-img").src, "data:image/png;base64,REVG", "содержимое заменено");
  // ✕
  ov.querySelector(".lightbox-close").fire("click");
  assert(!lightbox.isLightboxOpen(), "закрыт кнопкой ✕");
  // Esc
  lightbox.openLightbox({ src: "x", name: "x" });
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!lightbox.isLightboxOpen(), "закрыт по Esc");
  // клик по фону закрывает, по контенту — нет
  lightbox.openLightbox({ src: "x", name: "x" });
  ov.querySelector(".lightbox-box").fire("click");
  assert(lightbox.isLightboxOpen(), "клик по контенту не закрывает");
  ov.fire("click");
  assert(!lightbox.isLightboxOpen(), "клик по фону закрывает");
});

test("lightbox: ⛶ — Fullscreen API, без него CSS-фолбэк", async () => {
  installDom(); await resetState();
  lightbox.openLightbox({ src: "x", name: "x" });
  const ov = document.body.querySelector(".lightbox-overlay");
  const box = ov.querySelector(".lightbox-box");
  let fsCalls = 0;
  box.requestFullscreen = () => { fsCalls++; return Promise.resolve(); };
  ov.querySelector(".lightbox-fs").fire("click");
  await sleep(1);
  eq(fsCalls, 1, "requestFullscreen вызван на контейнере");
  assert(!ov.classList.contains("lightbox-full"), "CSS-фолбэк не нужен");
  // без Fullscreen API — CSS-растяжение
  box.requestFullscreen = undefined;
  ov.querySelector(".lightbox-fs").fire("click");
  assert(ov.classList.contains("lightbox-full"), "CSS-фолбэк включён");
  ov.querySelector(".lightbox-fs").fire("click");
  assert(!ov.classList.contains("lightbox-full"), "повторный клик снимает фолбэк");
  lightbox.closeLightbox();
});
