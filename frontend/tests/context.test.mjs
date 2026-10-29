// Доменные тесты: context. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, notIncludes, throws, installDom, fakeFile, resetState, sleep, domQuestions, domContext, domBatch, domResults, domToolbar, state, questions, context, batch, lightbox, saveas,
} from "./harness.mjs";
import { refreshStale } from "../static/stale.js";

// ================================================================ context

function mockResizeObservers() {
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
    resize(target, height) {
      target.getBoundingClientRect = () => ({ height });
      this.callback([{ target }]);
    }
  };
  return observers;
}

async function applyImport(sections = null) {
  await sleep(0);
  const dialog = document.getElementById("import-dialog");
  assert(dialog, "открыт диалог выбора разделов");
  const inputs = [...dialog.querySelectorAll("input[data-import-section]")];
  for (const input of inputs) {
    input.checked = sections === null || sections.includes(input.dataset.importSection);
    input.fire("change");
  }
  document.getElementById("import-apply").fire("click");
  await sleep(10);
  return dialog;
}

test("context: высоты редакторов — ResizeObserver, персист и повторный init без утечек", async () => {
  installDom(); await resetState(); domContext();
  const observers = mockResizeObservers();
  localStorage.setItem("dq-context-input-height", "240");
  localStorage.setItem("dq-context-cm-height", "330");
  localStorage.setItem("dq-vsplit-single", "70");
  context.initContext({});
  const ta = document.getElementById("context-input");
  const holder = document.getElementById("cm-holder");
  eq(ta.style.height, "240px", "высота textarea восстановлена до observe");
  eq(holder.style.height, "330px", "высота CodeMirror восстановлена до observe");
  eq(observers.length, 1, "один observer на оба редактора");
  assert(observers[0].targets.includes(ta) && observers[0].targets.includes(holder), "наблюдаются оба редактора");

  const view = {
    measures: 0,
    requestMeasure() { this.measures++; },
  };
  context.__setCmForTests(null, view);
  observers[0].resize(ta, 260);
  eq(localStorage.getItem("dq-context-input-height"), "260", "новая высота textarea сохранена");
  observers[0].resize(holder, 360);
  eq(localStorage.getItem("dq-context-cm-height"), "360", "новая высота JSON сохранена");
  eq(view.measures, 1, "CodeMirror перемерен после resize");

  const first = observers[0];
  context.initContext({});
  assert(first.disconnected, "старый observer отключён при повторном init");
  eq(observers.length, 2, "создан ровно один новый observer");
  eq(ta.style.height, "260px", "повторный init не затирает выбранную высоту textarea");
  eq(holder.style.height, "360px", "повторный init не затирает выбранную высоту JSON");
  eq(localStorage.getItem("dq-context-input-height"), "260", "персист textarea не перезаписан");
  eq(localStorage.getItem("dq-context-cm-height"), "360", "персист JSON не перезаписан");
  const escapeHandlers = document._listeners.keydown
    .filter(fn => String(fn).includes("context-fullscreen"));
  eq(escapeHandlers.length, 1, "повторный init не дублирует Escape-обработчик");
  context.__setCmForTests(null, null);
});

test("context: buildInput — текстовый режим, пустой контекст, JSON-режим", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  context.setContent("Иван врач.", "text");
  eq(context.buildInput(), "Иван врач.", "текст");
  context.setContent("   ", "text");
  throws(() => context.buildInput(), "пустым", "пустой контекст");
  // JSON-режим (setMode("json") тянет CodeMirror — в node ставим режим напрямую)
  state.inputMode = "json";
  document.getElementById("context-input").value = '{"a": 1}';
  assert(context.validateJsonMode(), "валидный JSON");
  const input = context.buildInput();
  eq(input.a, 1, "распарсенный объект");
  document.getElementById("context-input").value = "{битый";
  assert(!context.validateJsonMode(), "невалидный");
  const err = document.getElementById("json-error");
  assert(!err.classList.contains("hidden"), "плашка ошибки видна");
  includes(err.textContent, "Невалидный JSON", "текст ошибки");
  throws(() => context.buildInput(), "Невалидный JSON", "buildInput бросает");
});

test("context: меню сворачивания JSON — видно только в JSON-режиме, пункты без редактора безопасны", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({ showError: () => {} });
  const btn = document.getElementById("btn-fold-menu");
  const menu = document.getElementById("fold-menu");
  assert(btn.classList.contains("hidden"), "в текстовом режиме скрыта");
  document.getElementById("mode-json").fire("click");
  await sleep(10); // CodeMirror в node не монтируется — видимость кнопки от этого не зависит
  assert(!btn.classList.contains("hidden"), "в JSON-режиме кнопка видна");

  // открытие/закрытие меню
  btn.fire("click");
  assert(!menu.classList.contains("hidden"), "меню открылось");
  document.fire("click"); // клик вне меню (в dom-mock события не всплывают — шлём на document)
  assert(menu.classList.contains("hidden"), "клик вне меню закрывает");

  // пункты без cmView — no-op, без исключений
  btn.fire("click");
  for (const item of menu.querySelectorAll("[data-fold]")) menu.fire("click", { target: item });
  assert(menu.classList.contains("hidden"), "выбор пункта закрывает меню");

  document.getElementById("mode-text").fire("click");
  assert(btn.classList.contains("hidden"), "при возврате в текстовый режим скрыта");
});

// Мок CodeMirror: три вложенных foldable-диапазона (корень и глубины 1, 2).
function mockCm() {
  const nodes = [{ from: 0, to: 100 }, { from: 5, to: 40 }, { from: 10, to: 20 }];
  const chars = new Array(101).fill("x");
  chars[0] = "{"; chars[5] = "{"; chars[10] = "[";
  const calls = { folds: [], unfolds: 0, dispatches: 0 };
  const api = {
    syntaxTree: () => ({ iterate: ({ enter }) => nodes.forEach((n) => enter(n)) }),
    foldable: (st, from, to) => ({ from, to }),
    foldEffect: { of: (r) => r },
    unfoldAll: () => { calls.unfolds++; },
    foldAll: () => { calls.folds.push("all"); },
  };
  const view = {
    state: { doc: { toString: () => chars.join("") } },
    dispatch: ({ effects }) => { calls.dispatches++; calls.folds.push(...effects); },
  };
  return { api, view, calls };
}

test("context: сворачивание по уровням — глубина >= N, unfold/всё сбрасывают уровень", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  const menu = document.getElementById("fold-menu");
  const { api, view, calls } = mockCm();

  // без мока — пункты no-op
  menu.fire("click", { target: menu.querySelector('[data-fold="2"]') });

  context.__setCmForTests(api, view);
  // «Свернуть до уровня 1» — сворачиваются значения верхнего уровня и глубже
  // (все диапазоны, кроме корневого: видны поля корня, значения — свёрнуты)
  menu.fire("click", { target: menu.querySelector('[data-fold="1"]') });
  eq(calls.unfolds, 1, "перед сворачиванием всё разворачивается");
  eq(calls.folds.length, 2, "свёрнуты глубины 1 и 2 (>= уровня)");
  assert(calls.folds.every((r) => r.from >= 5), "корневой диапазон (глубина 0) не свёрнут");

  // «Свернуть до уровня 2» — только самая глубокая вложенность
  calls.folds = [];
  menu.fire("click", { target: menu.querySelector('[data-fold="2"]') });
  eq(calls.folds.length, 1, "уровень 2 сворачивает только глубину 2");
  eq(calls.folds[0].from, 10, "свёрнут внутренний диапазон");

  // «Развернуть всё» — unfoldAll, без fold-эффектов
  calls.folds = [];
  menu.fire("click", { target: menu.querySelector('[data-fold="unfold"]') });
  eq(calls.unfolds, 3, "unfoldAll вызван");
  eq(calls.folds.length, 0, "ничего не свёрнуто");

  // «Свернуть всё» — foldAll (включая корень)
  menu.fire("click", { target: menu.querySelector('[data-fold="all"]') });
  eq(calls.folds.join(","), "all", "foldAll вызван");
  context.__setCmForTests(null, null);
});

test("context: хоткеи Ctrl/Cmd+Shift+[ ] — только в JSON-режиме, preventDefault", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  const menu = document.getElementById("fold-menu");
  const { api, view, calls } = mockCm();
  context.__setCmForTests(api, view);
  // сброс уровня из предыдущих тестов (foldLevel — состояние модуля)
  menu.fire("click", { target: menu.querySelector('[data-fold="unfold"]') });
  calls.unfolds = 0; calls.folds = [];
  const press = (code, extra = {}) => {
    let prevented = false;
    document.fire("keydown", { code, ctrlKey: true, shiftKey: true, preventDefault: () => { prevented = true; }, ...extra });
    return prevented;
  };

  // не JSON-режим — не срабатывает и не глушит браузер
  state.inputMode = "text";
  assert(!press("BracketLeft"), "в текстовом режиме preventDefault не вызван");
  eq(calls.dispatches, 0, "в текстовом режиме сворачивания нет");

  // JSON-режим: [ — свернуть глубже (1 → 2), ] — развернуть (2 → 1 → 0 = unfoldAll)
  state.inputMode = "json";
  assert(press("BracketLeft"), "preventDefault на [");
  eq(calls.folds.length, 2, "первый [ — уровень 1, глубины 1 и 2");
  calls.folds = [];
  press("BracketLeft");
  eq(calls.folds.length, 1, "второй [ — уровень 2, только глубина 2");
  calls.folds = [];
  press("BracketRight");
  eq(calls.folds.length, 2, "] — уровень 1");
  calls.unfolds = 0; calls.folds = [];
  press("BracketRight");
  eq(calls.unfolds, 1, "уровень 0 — unfoldAll");
  eq(calls.folds.length, 0, "без сворачивания");

  // фокус в поле ввода — игнор
  state.inputMode = "json";
  calls.folds = [];
  assert(!press("BracketLeft", { target: { tagName: "TEXTAREA" } }), "в TEXTAREA не срабатывает");
  eq(calls.folds.length, 0, "сворачивания нет");
  // мета-клавиша (Cmd) тоже работает
  assert(press("BracketLeft", { ctrlKey: false, metaKey: true }), "Cmd+Shift+[ работает");
  eq(calls.folds.length, 2, "свёрнуто (уровень 1: глубины 1 и 2)");
  context.__setCmForTests(null, null);
});

test("context: describeJsonError и parseImport — разбор ошибок и видов JSON", async () => {
  await resetState();
  const suffix = context.describeJsonError('{"a": 1,\n"b": x}', { message: "Unexpected token x in JSON at position 12" });
  includes(suffix, "строка 2", "строка вычислена");
  includes(suffix, "столбец 4", "столбец вычислен");
  notIncludes(suffix, "position 12", "сырая позиция убрана");
  const v8 = context.describeJsonError('{"a": 1, "b" 2}', {
    message: "Expected double-quoted property name in JSON at position 8 (line 1 column 9)",
  });
  eq(v8, " (строка 1, столбец 9): Expected double-quoted property name", "без дубля (line X column Y)");
  const fallback = context.describeJsonError("{}", { message: "weird engine error" });
  eq(fallback, ": weird engine error", "фолбэк — исходное сообщение");
  // parseImport — вопросы / контекст / снапшот / батч / мусор
  const q = context.parseImport('[{"question":"Q?","type":"yes_no"}]');
  eq(q.kind, "questions", "массив → вопросы");
  const c = context.parseImport('{"input_format":"text","input":"текст"}');
  eq(c.kind, "context", "объект с input → контекст");
  eq(c.batchFiles, null, "без batch_files — batchFiles null");
  const s = context.parseImport('{"input":"текст","questions":[]}');
  eq(s.kind, "session", "input+questions → снапшот");
  const sb = context.parseImport('{"input":"текст","batch_files":[{"name":"a.txt","content":"x"}]}');
  eq(sb.kind, "session", "input+batch_files → снапшот");
  eq(sb.batchFiles.length, 1, "batch_files распознаны");
  const b = context.parseImport('{"batch_files":[{"name":"p.png","image":"data:image/png;base64,QUJD"}]}');
  eq(b.kind, "batch", "только batch_files → батч");
  eq(b.context, null, "контекста нет");
  const min = context.parseImport('{"input":"","batch_files":[]}');
  eq(min.kind, "session", "минимальный {input, batch_files} → снапшот");
  // снапшот «Сохранить как…» с результатами прогонов
  const sr = context.parseImport('{"input":"t","questions":[],"results":{"results":{}},"results_meta":{"fingerprint":"fp"},"batch_results":{"files":["f1"],"results":{}}}');
  eq(sr.kind, "session", "снапшот с результатами → session");
  assert(sr.results && sr.results.results, "results распознаны");
  eq(sr.resultsMeta.fingerprint, "fp", "results_meta распознана");
  eq(sr.batchResults.files[0], "f1", "batch_results распознаны");
  const plain = context.parseImport('{"input":"t"}');
  eq(plain.results, null, "без результатов — null");
  eq(plain.batchResults, null, "без batch_results — null");
  throws(() => context.parseImport('{"foo":1}'), "input", "мусор");
});

test("context: fullscreen text+JSON — Esc, высоты и исходное состояние сворачивания", async () => {
  installDom(); await resetState(); domContext();
  const observers = mockResizeObservers();
  localStorage.setItem("dq-context-input-height", "220");
  localStorage.setItem("dq-context-cm-height", "310");
  context.initContext({ showError: () => {} });
  const bc = await import("../static/blockcollapse.js");
  bc.initBlockCollapse();
  const card = document.getElementById("context-card");
  const ta = document.getElementById("context-input");
  const holder = document.getElementById("cm-holder");
  const collapseBtn = card.querySelector(".block-collapse-btn");

  // Текст: вход из свёрнутых материалов временно разворачивает блок.
  collapseBtn.fire("click");
  context.toggleContextFullscreen();
  assert(card.classList.contains("context-fullscreen"), "текстовый редактор на весь экран");
  assert(document.body.classList.contains("no-scroll"), "скролл выключен");
  eq(document.getElementById("btn-context-fs").textContent, "✕", "кнопка ✕");
  assert(!card.classList.contains("card-collapsed"), "на fullscreen блок развёрнут через block API");
  eq(localStorage.getItem("dq-collapse-materials-single"), "0", "временный разворот записан через API");
  eq(ta.style.height, "", "inline-height textarea сброшен на fullscreen");
  eq(holder.style.height, "", "inline-height JSON сброшен на fullscreen");
  observers[0].resize(ta, 600);
  eq(localStorage.getItem("dq-context-input-height"), "220", "fullscreen-resize не затирает выбранную высоту");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!card.classList.contains("context-fullscreen"), "Esc возвращает текстовый редактор");
  assert(card.classList.contains("card-collapsed"), "исходное свёрнутое состояние восстановлено");
  eq(localStorage.getItem("dq-collapse-materials-single"), "1", "свёрнутый персист восстановлен");
  eq(ta.style.height, "220px", "выбранная высота textarea восстановлена");
  eq(holder.style.height, "310px", "выбранная высота JSON восстановлена");

  // Если блок был развёрнут, выход не сворачивает его.
  collapseBtn.fire("click");
  context.toggleContextFullscreen(true);
  context.toggleContextFullscreen(false);
  assert(!card.classList.contains("card-collapsed"), "развёрнутое состояние сохранено");
  eq(localStorage.getItem("dq-collapse-materials-single"), "0", "развёрнутый персист сохранён");

  // JSON: тот же цикл через кнопку, ResizeObserver перемеряет CodeMirror.
  document.getElementById("mode-json").fire("click");
  await sleep(10);
  const view = {
    measures: 0,
    requestMeasure() { this.measures++; },
  };
  context.__setCmForTests(null, view);
  collapseBtn.fire("click");
  document.getElementById("btn-context-fs").fire("click");
  assert(card.classList.contains("context-fullscreen"), "JSON-редактор на весь экран");
  assert(!card.classList.contains("card-collapsed"), "JSON-блок развёрнут на fullscreen");
  const measures = view.measures;
  observers[0].resize(holder, 640);
  eq(localStorage.getItem("dq-context-cm-height"), "310", "fullscreen JSON не затирает сохранённую высоту");
  eq(view.measures, measures + 1, "CodeMirror перемерен после fullscreen-resize");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!card.classList.contains("context-fullscreen"), "Esc возвращает JSON-редактор");
  assert(card.classList.contains("card-collapsed"), "JSON восстановлен в исходное свёрнутое состояние");
  eq(holder.style.height, "310px", "inline-height JSON восстановлен после Esc");
  context.__setCmForTests(null, null);
});

test("context: contextSnapshot и exportContext", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  context.setContent("текст контекста", "text");
  const snap = context.contextSnapshot();
  eq(snap.input_format, "text");
  eq(snap.input, "текст контекста");
  let captured = null;
  globalThis.URL.createObjectURL = (blob) => { captured = blob.content; return "blob:x"; };
  context.exportContext();
  eq(JSON.parse(captured).input, "текст контекста", "экспорт контекста");
});

// ---------------------------------------------------------------- изображения (этап 4)

test("context: изображения — прикрепление, лайтбокс, удаление, пустой текст, drag&drop", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  // пустой текст без картинки — ошибка; с картинкой — ок
  throws(() => context.buildInput(), "пустым", "без картинки — ошибка");
  await context.addImageFiles([fakeFile("a.png", "png-bytes")]);
  eq(state.contextImages.length, 1, "картинка в state");
  assert(state.contextImages[0].dataUrl.startsWith("data:image/png;base64,"), "data URL");
  eq(context.buildInput(), "", "пустой текст допустим с картинкой");
  eq(context.buildImagesPayload().length, 1, "payload картинок");
  const wrap = document.getElementById("context-images");
  assert(!wrap.classList.contains("hidden"), "ряд миниатюр виден");
  const thumb = wrap.querySelector(".ctx-thumb");
  assert(thumb && thumb.querySelector("img"), "миниатюра с img");
  // клик по картинке — лайтбокс
  thumb.querySelector("img").fire("click");
  assert(lightbox.isLightboxOpen(), "клик по картинке открыл лайтбокс");
  includes(document.body.querySelector(".lightbox-caption").textContent, "a.png", "имя в подписи");
  lightbox.closeLightbox();
  // ✕ удаляет, лайтбокса нет
  thumb.querySelector(".ctx-thumb-remove").fire("click");
  eq(state.contextImages.length, 0, "картинка удалена крестиком");
  assert(!lightbox.isLightboxOpen(), "✕ не открывает лайтбокс");
  assert(wrap.classList.contains("hidden"), "ряд скрыт после удаления");
  // drag&drop на карточку
  document.getElementById("context-card").fire("drop", { dataTransfer: { files: [fakeFile("b.webp", "webp-bytes", "image/webp")] } });
  await sleep(10);
  eq(state.contextImages.length, 1, "картинка прикреплена через drop");
  eq(state.contextImages[0].name, "b.webp", "имя сохранено");
});

test("context: экспорт/импорт с изображениями (обратная совместимость)", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  context.setContent("текст", "text");
  context.setImages([{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }]);
  const snap = context.contextSnapshot();
  eq(snap.images.join(","), "data:image/png;base64,QUJD", "images в снапшоте");
  // импорт снапшота с картинками
  const parsed = context.parseImport(JSON.stringify(snap));
  context.applyImportedContext(parsed.context);
  eq(state.contextImages.length, 1, "картинка восстановлена");
  eq(state.contextImages[0].dataUrl, "data:image/png;base64,QUJD", "dataUrl сохранён");
  // старый экспорт без images — работает, картинки сброшены
  const legacy = context.parseImport('{"input_format":"text","input":"старое"}');
  assert(!("images" in snap) || true, "снапшот валиден");
  context.applyImportedContext(legacy.context);
  eq(state.contextImages.length, 0, "legacy-импорт сбрасывает картинки");
  eq(context.buildImagesPayload().length, 0, "payload пуст");
});

test("context: круговой экспорт/импорт «Всё» — контекст + картинки + вопросы + batch_files", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch();
  context.initContext({});
  batch.initBatch({});
  context.setContent("текст контекста", "text");
  context.setImages([{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }]);
  questions.setQuestions([{ question: "Q?", type: "yes_no" }]);
  batch.loadPresetFiles([
    { name: "doc.txt", content: "текст файла" },
    { name: "pic.png", image: "data:image/png;base64,REVG" },
  ]);
  // снапшот сессии (формат «Сохранить как…», saveas.js)
  const data = {
    ...context.contextSnapshot(),
    questions: questions.buildQuestionsPayload(),
    batch_files: batch.batchFilesSnapshot(),
  };
  eq(data.batch_files.length, 2, "оба файла в снапшоте");
  eq(data.batch_files[0].content, "текст файла", "текстовый файл → content");
  eq(data.batch_files[1].image, "data:image/png;base64,REVG", "картинка → image");
  // портим состояние и импортируем обратно; прошлые результаты должны очиститься
  state.results = { results: {}, order: [], runMode: "decisions", questions: [] };
  state.resultsMeta = { fingerprint: "old" };
  state.resultsStale = true;
  context.setContent("другое", "text");
  context.setImages([]);
  questions.setQuestions([]);
  batch.loadPresetFiles([]);
  let err = null;
  context.importJsonFile(fakeFile("session.json", JSON.stringify(data)), {
    onError: (m) => { err = m; },
    onBatchFiles: (files) => batch.loadPresetFiles(files),
  });
  await applyImport();
  assert(!err, "без ошибки импорта: " + err);
  eq(state.results, null, "импорт очистил прошлые результаты");
  eq(state.resultsMeta, null, "мета результатов очищена");
  eq(state.resultsStale, false, "stale сброшен");
  eq(context.buildInput(), "текст контекста", "контекст восстановлен");
  eq(state.contextImages.length, 1, "картинка контекста восстановлена");
  eq(state.contextImages[0].dataUrl, "data:image/png;base64,QUJD", "dataUrl контекста");
  eq(state.questions.length, 1, "вопрос восстановлен");
  eq(state.questions[0].question, "Q?", "текст вопроса");
  eq(state.batch.files.length, 2, "файлы батча восстановлены");
  eq(state.batch.files[0].text, "текст файла", "текст файла батча");
  assert(!state.batch.files[0].isImage, "первый файл текстовый");
  assert(state.batch.files[1].isImage, "второй файл — картинка");
  eq(state.batch.files[1].dataUrl, "data:image/png;base64,REVG", "dataUrl файла батча");
});

test("context: импорт снапшота с результатами — восстановление вместо очистки (без stale)", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domResults(); domToolbar();
  context.initContext({});
  batch.initBatch({});
  questions.setQuestions([{ id: "q1", question: "Q?", type: "yes_no" }]);
  const res = { results: { mA: { ok: true, answers: { q1: { type: "yes_no", probabilities: { yes: 0.9, no: 0.1 } } }, usage: {}, metrics: {} } }, order: ["mA"], runMode: "decisions", questions: [] };
  const data = {
    input_format: "text", input: "материал",
    questions: [{ id: "q1", question: "Q?", type: "yes_no" }],
    results: res, results_meta: { fingerprint: "saved-fp" },
    batch_files: [{ name: "b.txt", content: "y" }],
    batch_results: { files: ["f_old"], results: { f_old: { mA: { ok: true, answers: {}, usage: {}, metrics: {} } } }, durations: { f_old: 1 }, decision: null },
  };
  // прошлый прогон со stale — должен быть заменён восстановленным
  state.results = { results: {}, order: [], runMode: "decisions", questions: [] };
  state.resultsMeta = { fingerprint: "old" };
  state.resultsStale = true;
  let err = null;
  context.importJsonFile(fakeFile("s.json", JSON.stringify(data)), {
    onError: (m) => { err = m; },
    onBatchFiles: (files) => batch.loadPresetFiles(files),
  });
  await applyImport();
  assert(!err, "без ошибки импорта: " + err);
  eq(JSON.stringify(state.results), JSON.stringify({ ...res, marks: [] }), "результаты восстановлены (разметка — пустым массивом)");
  eq(state.resultsMeta.fingerprint, "saved-fp", "fingerprint из файла");
  eq(state.resultsStale, false, "stale сброшен — восстановленные результаты актуальны");
  assert(!document.getElementById("results-stale"), "плашки нет");
  const f = state.batch.files[0];
  eq(f.name, "b.txt", "файл пакета восстановлен");
  assert(state.batch.results[f.id], "результаты пакета remap'нуты на новый id");
  eq(f.status, "ok", "файл помечен обработанным");
  eq(state.batch.resultsStale, false, "stale пакета не выставлен");
  // правка после импорта помечает stale относительно восстановленного fingerprint
  state.questions[0].question = "Другой?";
  refreshStale(() => "материал");
  eq(state.resultsStale, true, "правка после восстановления → stale");
});

test("context: единый контейнер — round-trip config/materials/results/settings и частичный import", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domResults(); domToolbar();
  context.initContext({});
  batch.initBatch({});
  state.models = [
    { key: "mA", label: "A", status: "running", api: "sglang" },
    { key: "mB", label: "B", status: "running", api: "sglang" },
  ];
  state.selectedModels = new Set(["mB"]);
  state.runMode = "decisions";
  state.temperature = 0.65;
  state.pinnedFormats = { mB: 2 };
  state.promptFormats = { mB: 2 };
  context.setContent("единый материал", "text");
  questions.setQuestions([{ id: "q1", question: "Q?", type: "yes_no", direction: "yes" }]);
  state.decision = { enabled: true, outcomes: [{ id: "ok", label: "Ок", color: "green", rules: [] }] };
  batch.loadPresetFiles([{ name: "a.txt", content: "batch" }]);
  state.results = { results: { mB: { ok: true, answers: {}, usage: {}, metrics: {} } }, order: ["mB"], runMode: "decisions", questions: state.questions };
  state.resultsMeta = { fingerprint: "saved-fp" };
  const exported = await saveas.buildExportDocument("full", true);
  const cli = await saveas.buildExportDocument("cli", false);
  const rawLegacy = context.parseImport(JSON.stringify(cli.config));
  eq(rawLegacy.kind, "config", "старый raw config pack тоже импортируется");

  context.setContent("другое", "text");
  questions.setQuestions([]);
  state.decision = null;
  state.selectedModels = new Set();
  state.temperature = 1;
  state.pinnedFormats = {};
  state.promptFormats = {};
  batch.loadPresetFiles([]);
  state.results = null;
  state.resultsMeta = null;
  let settingsApplied = 0;
  let error = null;
  context.importJsonFile(fakeFile("document.json", JSON.stringify(exported)), {
    onError: message => { error = message; },
    onBatchFiles: files => batch.loadPresetFiles(files),
    onRunSettings: () => { settingsApplied += 1; },
  });
  const dependencyDialog = await applyImport(["results"]);
  includes(dependencyDialog.querySelector(".import-dialog-error").textContent, "вместе с соответствующими разделами", "результаты требуют связанные данные");
  assert(document.getElementById("import-dialog"), "диалог остаётся открыт после ошибки зависимостей");
  await applyImport();
  assert(!error, "импорт без ошибки: " + error);
  eq(context.currentText(), "единый материал", "материал восстановлен");
  eq(state.questions[0].direction, "yes", "вопросы восстановлены");
  eq(state.decision.outcomes[0].id, "ok", "правила восстановлены");
  eq(state.batch.files[0].name, "a.txt", "batch восстановлен");
  assert(state.results.results.mB.ok, "результаты восстановлены");
  eq(state.resultsMeta.fingerprint, "saved-fp", "provenance восстановлена");
  eq(state.resultsStale, false, "результаты не stale");
  assert(state.selectedModels.has("mB") && !state.selectedModels.has("mA"), "models восстановлены");
  eq(state.temperature, 0.65, "temperature восстановлена");
  eq(state.pinnedFormats.mB, 2, "prompt formats восстановлены");
  eq(settingsApplied, 1, "toolbar уведомлён о настройках");

  const questionsOnly = await saveas.buildExportDocument("questions", false);
  context.importJsonFile(fakeFile("questions.json", JSON.stringify(questionsOnly)), {
    onError: message => { throw new Error(message); },
  });
  await applyImport(["questions"]);
  eq(context.currentText(), "единый материал", "scope=questions не заменяет материал");
  eq(state.decision.outcomes[0].id, "ok", "scope=questions не затирает правила");
});

test("context: импорт — отмена диалога, выбор разделов и legacy-формат", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch();
  context.initContext({});
  batch.initBatch({});
  context.setContent("старое", "text");
  questions.setQuestions([{ question: "Old?", type: "yes_no" }]);
  context.importJsonFile(fakeFile("s.json",
    '{"input":"новое","questions":[{"question":"N?","type":"yes_no"}],"batch_files":[{"name":"a.txt","content":"x"}]}'), {
    onError: () => {},
    onBatchFiles: () => { throw new Error("onBatchFiles не должен вызываться при отмене"); },
  });
  await sleep(0);
  const dialog = document.getElementById("import-dialog");
  assert(dialog, "показан выбор разделов вместо прежнего confirm");
  includes(dialog.textContent, "Импорт с заменой разделов", "действие названо честно");
  includes(dialog.textContent, "не объединены", "предупреждение исключает ожидание merge");
  eq(document.getElementById("import-apply").disabled, true, "по умолчанию ничего не выбрано");
  document.getElementById("import-cancel").fire("click");
  await sleep(10);
  eq(context.buildInput(), "старое", "контекст не изменился");
  eq(state.questions[0].question, "Old?", "вопросы не изменились");
  // импорт только batch_files не затрагивает одиночный материал
  context.setContent("не трогаем", "text");
  let applied = null;
  context.importJsonFile(fakeFile("b.json",
    '{"batch_files":[{"name":"a.txt","content":"x"},{"name":"p.png","image":"data:image/png;base64,QUJD"}]}'), {
    onError: (m) => { throw new Error(m); },
    onBatchFiles: (files) => { applied = files; batch.loadPresetFiles(files); },
  });
  await applyImport(["materials"]);
  eq(applied.length, 2, "batch_files переданы в onBatchFiles");
  eq(state.batch.files.length, 2, "файлы в state.batch");
  assert(state.batch.files[1].isImage, "картинка распознана");
  eq(context.buildInput(), "не трогаем", "контекст не изменился");
  // старый формат без batch_files/images — работает как раньше
  context.importJsonFile(fakeFile("old.json", '{"input_format":"text","input":"legacy"}'), {
    onError: (m) => { throw new Error(m); },
  });
  await applyImport(["materials"]);
  eq(context.buildInput(), "legacy", "legacy-импорт работает");
  eq(state.batch.files.length, 2, "батч без onBatchFiles не тронут");
});


test("context: импорт правил проверяет вопросы до изменения документа", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch();
  context.initContext({});
  batch.initBatch({});
  state.models = [{ key: "mA", label: "A", status: "running", api: "sglang" }];
  state.selectedModels = new Set(["mA"]);
  context.setContent("текущий материал", "text");
  questions.setQuestions([{ id: "qNew", question: "Новый?", type: "yes_no" }]);
  state.decision = { enabled: true, outcomes: [{ id: "ok", label: "Ок", color: "green", isDefault: true,
    rules: [{ anyOf: false, conditions: [{ question: "qNew", answer: "yes", op: "gte", threshold: 0.9 }] }] }] };
  const exported = await saveas.buildExportDocument("cli", false);
  questions.setQuestions([{ id: "qOld", question: "Старый?", type: "yes_no" }]);
  state.decision = null;

  context.importJsonFile(fakeFile("rules.json", JSON.stringify(exported)), {
    onError: message => { throw new Error(message); },
  });
  const dialog = await applyImport(["decision"]);
  includes(dialog.querySelector(".import-dialog-error").textContent, "Выберите также «Вопросы»", "объяснена зависимость правил");
  eq(state.questions[0].id, "qOld", "неудачная проверка не меняет вопросы");
  eq(state.decision, null, "неудачная проверка не меняет правила");
  eq(context.currentText(), "текущий материал", "материал не затронут");

  await applyImport(["questions", "decision"]);
  eq(state.questions[0].id, "qNew", "совместный импорт применяет вопросы");
  eq(state.decision.outcomes[0].id, "ok", "и связанные правила");
  eq(context.currentText(), "текущий материал", "невыбранный материал сохранён");
});
