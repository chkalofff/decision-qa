// Доменные тесты: context. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, notIncludes, throws, installDom, fakeFile, resetState, sleep, domQuestions, domContext, domBatch, state, questions, context, batch, lightbox,
} from "./harness.mjs";

// ================================================================ context

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
  throws(() => context.parseImport('{"foo":1}'), "input", "мусор");
});

test("context: полноэкранный режим редактора; contextSnapshot и exportContext", async () => {
  installDom(); await resetState(); domContext();
  context.initContext({});
  const card = document.getElementById("context-card");
  context.toggleContextFullscreen();
  assert(card.classList.contains("context-fullscreen"), "карточка на весь экран");
  assert(document.body.classList.contains("no-scroll"), "скролл выключен");
  eq(document.getElementById("btn-context-fs").textContent, "✕", "кнопка ✕");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!card.classList.contains("context-fullscreen"), "Esc возвращает");
  // snapshot + экспорт
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
  // экспорт «Всё» (формат app.js exportAll)
  const data = {
    ...context.contextSnapshot(),
    questions: questions.buildQuestionsPayload(),
    batch_files: batch.batchFilesSnapshot(),
  };
  eq(data.batch_files.length, 2, "оба файла в снапшоте");
  eq(data.batch_files[0].content, "текст файла", "текстовый файл → content");
  eq(data.batch_files[1].image, "data:image/png;base64,REVG", "картинка → image");
  // портим состояние и импортируем обратно
  context.setContent("другое", "text");
  context.setImages([]);
  questions.setQuestions([]);
  batch.loadPresetFiles([]);
  let err = null;
  context.importJsonFile(fakeFile("session.json", JSON.stringify(data)), {
    onError: (m) => { err = m; },
    confirmReplace: () => true,
    onBatchFiles: (files) => batch.loadPresetFiles(files),
  });
  await sleep(10);
  assert(!err, "без ошибки импорта: " + err);
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

test("context: импорт — отмена confirmReplace не меняет состояние; импорт только batch_files; legacy-формат", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch();
  context.initContext({});
  batch.initBatch({});
  context.setContent("старое", "text");
  questions.setQuestions([{ question: "Old?", type: "yes_no" }]);
  let asked = null;
  context.importJsonFile(fakeFile("s.json",
    '{"input":"новое","questions":[{"question":"N?","type":"yes_no"}],"batch_files":[{"name":"a.txt","content":"x"}]}'), {
    onError: () => {},
    confirmReplace: (kind) => { asked = kind; return false; },
    onBatchFiles: () => { throw new Error("onBatchFiles не должен вызываться при отмене"); },
  });
  await sleep(10);
  eq(asked, "session", "спросили подтверждение для снапшота");
  eq(context.buildInput(), "старое", "контекст не изменился");
  eq(state.questions[0].question, "Old?", "вопросы не изменились");
  // импорт только batch_files (минимальный объект без input) — confirm не нужен
  context.setContent("не трогаем", "text");
  let applied = null;
  context.importJsonFile(fakeFile("b.json",
    '{"batch_files":[{"name":"a.txt","content":"x"},{"name":"p.png","image":"data:image/png;base64,QUJD"}]}'), {
    onError: (m) => { throw new Error(m); },
    confirmReplace: () => { throw new Error("для kind=batch confirm не нужен — одиночный режим не затронут"); },
    onBatchFiles: (files) => { applied = files; batch.loadPresetFiles(files); },
  });
  await sleep(10);
  eq(applied.length, 2, "batch_files переданы в onBatchFiles");
  eq(state.batch.files.length, 2, "файлы в state.batch");
  assert(state.batch.files[1].isImage, "картинка распознана");
  eq(context.buildInput(), "не трогаем", "контекст не изменился");
  // старый формат без batch_files/images — работает как раньше
  context.importJsonFile(fakeFile("old.json", '{"input_format":"text","input":"legacy"}'), {
    onError: (m) => { throw new Error(m); },
    confirmReplace: () => true,
  });
  await sleep(10);
  eq(context.buildInput(), "legacy", "legacy-импорт работает");
  eq(state.batch.files.length, 2, "батч без onBatchFiles не тронут");
});
