// Доменные тесты: presets. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, installDom, fakeFile, resetState, mockFetch, sleep, domApp, modelsResp, state, layout, questions, context, batch, toolbar, presetsMod, assistant,
} from "./harness.mjs";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";  // глобальный URL подменён DOM-моком

// ================================================================ presets (менеджер)

const PRESET_BUILTIN = {
  name: "Встроенный", description: "из поставки", slug: "vstroenny", source: "builtin",
  input: "текст", questions: [{ id: "q1", question: "Ок?", type: "yes_no" }],
};
const PRESET_USER = {
  name: "Мой", description: "пользовательский", slug: "moy", source: "user",
  input: "мой текст", images: ["data:image/png;base64,QUJD"],
  questions: [{ id: "q1", question: "Ок?", type: "yes_no" }],
};
const PRESET_USER_BATCH = {
  name: "Мой батч", slug: "moy-batch", source: "user", page: "batch",
  questions: [{ id: "q1", question: "Ок?", type: "yes_no" }],
  files: [{ name: "a.txt", content: "текст" }],
};

function domPresetsFetch(presets, extra = {}) {
  return mockFetch({
    "GET /api/models": modelsResp([]),
    "GET /api/presets": presets,
    ...extra,
  });
}

test("presets: менеджер — список с бейджами, rename/delete user шлют PATCH/DELETE, «← К прогону»", async () => {
  installDom(); await resetState(); domApp();
  const calls = domPresetsFetch([PRESET_BUILTIN, PRESET_USER, PRESET_USER_BATCH], {
    "DELETE /api/presets/moy": { slug: "moy" },
    "PATCH /api/presets/moy": { ...PRESET_USER, name: "Новое" },
  });
  let applied = null;
  toolbar.initToolbar({ onPresetsManager: () => presetsMod.openPresetsPage() });
  presetsMod.initPresets({ applyPreset: (p) => { applied = p; } });
  document.getElementById("tb-menu-btn").fire("click");
  document.getElementById("tb-menu-presets-manager").fire("click");
  await sleep(10);
  eq(state.pageMode, "presets", "страница presets открыта");
  const page = document.getElementById("page-presets");
  assert(!page.classList.contains("hidden"), "page-presets видна");
  const cards = [...page.querySelectorAll(".preset-card")];
  eq(cards.length, 3, "три карточки");
  includes(cards[0].textContent, "встроенный", "бейдж builtin");
  includes(cards[1].textContent, "мой", "бейдж user");
  includes(cards[1].textContent, "🖼", "бейдж картинок");
  includes(cards[2].textContent, "пакет", "бейдж пакета");
  includes(cards[1].textContent, "moy.json", "slug в мете");
  // применение из менеджера
  [...cards[0].querySelectorAll("button")].find(b => b.textContent === "Применить").fire("click");
  assert(applied && applied.name === "Встроенный", "применение делегировано applyPreset");
  // у builtin нет кнопок удалить/переименовать, у user — есть
  const btnTexts = (c) => [...c.querySelectorAll("button")].map(b => b.textContent);
  assert(!btnTexts(cards[0]).includes("Удалить"), "у builtin нет «Удалить»");
  assert(!btnTexts(cards[0]).includes("Переименовать"), "у builtin нет «Переименовать»");
  assert(btnTexts(cards[0]).includes("Экспорт"), "экспорт есть у всех");
  assert(btnTexts(cards[1]).includes("Удалить"), "у user есть «Удалить»");
  // переименование через диалог
  [...cards[1].querySelectorAll("button")].find(b => b.textContent === "Переименовать").fire("click");
  const dlg = document.getElementById("preset-dialog");
  assert(dlg, "диалог переименования открыт");
  document.getElementById("preset-dlg-name").value = "Новое";
  document.getElementById("preset-dlg-ok").fire("click");
  await sleep(10);
  const patch = calls.find(c => c.key === "PATCH /api/presets/moy");
  assert(patch, "PATCH отправлен");
  eq(patch.body.name, "Новое", "тело PATCH — новое имя");
  // удаление с confirm
  globalThis.confirm = () => true;
  const card2 = [...page.querySelectorAll(".preset-card")][1];
  [...card2.querySelectorAll("button")].find(b => b.textContent === "Удалить").fire("click");
  await sleep(10);
  assert(calls.some(c => c.key === "DELETE /api/presets/moy"), "DELETE отправлен");
  // назад
  const back = document.getElementById("btn-presets-back");
  assert(back, "кнопка возврата есть");
  back.fire("click");
  eq(state.pageMode, "single", "вернулись в single");
  await sleep(10); // дождаться полла
});

test("presets: «Сохранить как пресет» — direction/images (single) и files-снапшот (batch) в теле POST", async () => {
  installDom(); await resetState(); domApp();
  const calls = domPresetsFetch([], {
    "POST /api/presets": (call) => ({ ...call.body.payload, name: call.body.name, slug: "moy", source: "user" }),
  });
  toolbar.initToolbar({ onSavePreset: () => presetsMod.openSaveDialog() });
  presetsMod.initPresets({});
  document.getElementById("context-input").value = "контекст для пресета";
  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }];
  state.questions = [{ id: "q1", question: "S?", type: "score", levels: ["a", "b"], direction: "down", collapsed: true }];
  document.getElementById("tb-menu-save-preset").fire("click");
  const dlg = document.getElementById("preset-dialog");
  assert(dlg, "диалог сохранения открыт");
  document.getElementById("preset-dlg-name").value = "Мой пресет";
  document.getElementById("preset-dlg-desc").value = "описание";
  document.getElementById("preset-dlg-ok").fire("click");
  await sleep(10);
  const post = calls.find(c => c.key === "POST /api/presets");
  assert(post, "POST /api/presets отправлен");
  eq(post.body.name, "Мой пресет", "имя из диалога");
  eq(post.body.description, "описание", "описание из диалога");
  eq(post.body.page, "single", "page=single");
  eq(post.body.payload.input, "контекст для пресета", "контекст в payload");
  eq(post.body.payload.questions[0].direction, "down", "direction вопроса сохранён");
  eq(post.body.payload.images.join(","), "data:image/png;base64,QUJD", "images в payload");
  assert(!document.getElementById("preset-dialog"), "диалог закрыт после сохранения");
  // из батча — files-снапшот
  calls.length = 0;
  toolbar.setPageMode("batch");
  state.questions = [{ id: "q1", question: "S?", type: "score", levels: ["a", "b"], direction: "up", collapsed: true }];
  batch.loadPresetFiles([
    { name: "doc.txt", content: "текст", images: ["data:image/png;base64,QUJD"] },
    { name: "p.png", image: "data:image/png;base64,REVG" },
  ]);
  document.getElementById("tb-menu-save-preset").fire("click");
  document.getElementById("preset-dlg-name").value = "Батчевый";
  document.getElementById("preset-dlg-ok").fire("click");
  await sleep(10);
  const postB = calls.find(c => c.key === "POST /api/presets");
  assert(postB, "POST отправлен");
  eq(postB.body.page, "batch", "page=batch");
  eq(postB.body.payload.questions[0].direction, "up", "direction вопроса");
  eq(postB.body.payload.files.length, 2, "оба файла");
  eq(postB.body.payload.files[0].content, "текст", "текстовый файл → content");
  eq(postB.body.payload.files[0].images.join(","), "data:image/png;base64,QUJD", "картинки файла");
  eq(postB.body.payload.files[1].image, "data:image/png;base64,REVG", "картинка → image");
  await sleep(10);
});

test("presets: экспорт → импорт round-trip; «Клонировать» — POST с payload исходного", async () => {
  installDom(); await resetState(); domApp();
  const calls = domPresetsFetch([PRESET_USER, PRESET_BUILTIN], {
    "POST /api/presets": (call) => ({ name: call.body.name, slug: "imported", source: "user" }),
  });
  toolbar.initToolbar({});
  presetsMod.initPresets({});
  presetsMod.openPresetsPage();
  await sleep(10);
  // экспорт
  let captured = null;
  globalThis.URL.createObjectURL = (blob) => { captured = blob.content; return "blob:x"; };
  const card = document.getElementById("page-presets").querySelector(".preset-card");
  [...card.querySelectorAll("button")].find(b => b.textContent === "Экспорт").fire("click");
  assert(captured, "файл экспортирован");
  const exported = JSON.parse(captured);
  assert(!("slug" in exported) && !("source" in exported), "slug/source не экспортируются");
  eq(exported.images.join(","), "data:image/png;base64,QUJD", "картинки встроены base64");
  // импорт того же файла
  const input = document.getElementById("preset-import-input");
  input.fire("change", { target: { files: [fakeFile("moy.json", captured)], value: "" } });
  await sleep(10);
  const post = calls.find(c => c.key === "POST /api/presets");
  assert(post, "импорт пошёл в POST /api/presets");
  eq(post.body.name, "Мой", "имя сохранилось");
  eq(post.body.page, "single", "page выведен");
  eq(post.body.payload.input, "мой текст", "input сохранился");
  eq(post.body.payload.images.join(","), "data:image/png;base64,QUJD", "images пережили round-trip");
  eq(post.body.payload.questions[0].question, "Ок?", "вопросы сохранились");
  // «Клонировать» builtin — диалог с «Копия …», POST с payload исходного
  calls.length = 0;
  const cardB = [...document.getElementById("page-presets").querySelectorAll(".preset-card")]
    .find(c => c.textContent.includes("Встроенный"));
  [...cardB.querySelectorAll("button")].find(b => b.textContent === "Клонировать").fire("click");
  const nameIn = document.getElementById("preset-dlg-name");
  eq(nameIn.value, "Копия Встроенный", "имя предзаполнено копией");
  document.getElementById("preset-dlg-ok").fire("click");
  await sleep(10);
  const postC = calls.find(c => c.key === "POST /api/presets");
  assert(postC, "POST /api/presets отправлен");
  eq(postC.body.name, "Копия Встроенный");
  eq(postC.body.page, "single");
  eq(postC.body.payload.input, "текст", "payload исходного пресета");
  eq(postC.body.payload.questions[0].question, "Ок?");
  assert(!("slug" in postC.body.payload) && !("source" in postC.body.payload), "slug/source не уезжают в payload");
  await sleep(10);
});

test("presets: встроенный «Возвраты: претензии с фото» — бейдж 🖼 в меню, loadPresetFiles с images", async () => {
  const preset = JSON.parse(readFileSync(
    new NodeURL("../../backend/presets/batch_returns_claims.json", import.meta.url), "utf8"));
  eq(preset.page, "batch", "page=batch");
  // 🖼 в меню пресетов: детект по files[].images (не только по files[].image)
  installDom(); await resetState(); domApp();
  mockFetch({
    "GET /api/models": modelsResp([]),
    "GET /api/presets": [preset],
  });
  toolbar.initToolbar({});
  document.getElementById("tb-menu-btn").fire("click");
  document.getElementById("tb-menu-presets").fire("click");
  await sleep(10);
  const item = [...document.getElementById("tb-menu-presets-sub").children]
    .find(c => !c.classList.contains("menu-group-head"));
  includes(item.textContent, "🖼", "бейдж изображений у пресета с files[].images");
  // применение: файлы батча и их изображения
  toolbar.setPageMode("batch");
  batch.loadPresetFiles(preset.files);
  eq(state.batch.files.length, 5, "5 файлов претензий");
  const byName = Object.fromEntries(state.batch.files.map(f => [f.name, f]));
  eq((byName["claim_01.txt"].images || []).length, 3, "у claim_01 три изображения");
  eq((byName["claim_03.txt"].images || []).length, 0, "у claim_03 нет изображений");
  assert(byName["claim_01.txt"].images.every(i => i.dataUrl.startsWith("data:image/")),
    "изображения — data URL");
  // вопросы: score-вопросы с direction
  const scores = preset.questions.filter(q => q.type === "score");
  eq(scores.length, 2, "два score-вопроса");
  eq(scores.map(q => q.direction).join(","), "up,down", "direction у score-вопросов");
  await sleep(10);
});

test("presets: диалог закрывается «Отменой», кликом по фону и Esc", async () => {
  installDom(); await resetState(); domApp();
  domPresetsFetch([]);
  toolbar.initToolbar({ onSavePreset: () => presetsMod.openSaveDialog() });
  presetsMod.initPresets({});
  document.getElementById("tb-menu-save-preset").fire("click");
  assert(document.getElementById("preset-dialog"), "диалог открыт");
  document.getElementById("preset-dlg-cancel").fire("click");
  assert(!document.getElementById("preset-dialog"), "«Отмена» закрыла");
  presetsMod.openSaveDialog();
  document.getElementById("preset-dialog").fire("click"); // клик по фону
  assert(!document.getElementById("preset-dialog"), "клик по фону закрыл");
  presetsMod.openSaveDialog();
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!document.getElementById("preset-dialog"), "Esc закрыл");
  await sleep(10);
});

// ---------------------------------------------------------------- запуск

test("layout: «+ Вопрос» идёт после списка вопросов в index.html (обе страницы)", () => {
  const html = readFileSync(new NodeURL("../static/index.html", import.meta.url), "utf8");
  for (const [list, btn] of [["questions-list", "btn-add-question"], ["batch-questions-list", "btn-add-question-batch"]]) {
    const iList = html.indexOf(`id="${list}"`);
    const iBtn = html.indexOf(`id="${btn}"`);
    assert(iList !== -1 && iBtn !== -1, `${list} и ${btn} присутствуют`);
    assert(iList < iBtn, `${btn} идёт после ${list}`);
  }
});

test("images: HEIC отклоняется в контексте, батче и при attach; accept без image/*", async () => {
  installDom(); await resetState(); domApp();
  let err = null;
  context.initContext({ showError: (m) => { err = m; } });
  await context.addImageFiles([
    fakeFile("photo.HEIC", "heic-bytes", "image/heic"),
    fakeFile("scan.heic", "x"), // пустой MIME — ловим по расширению
    fakeFile("ok.png", "png-bytes", "image/png"),
  ]);
  assert(err && err.includes("photo.HEIC") && err.includes("scan.heic"), "баннер про оба HEIC: " + err);
  assert(err.includes("PNG/JPEG/WebP/GIF"), "подсказка про форматы");
  eq(state.contextImages.length, 1, "добавлен только png");
  eq(state.contextImages[0].name, "ok.png");
  // батч и attach
  err = null;
  batch.initBatch({ showError: (m) => { err = m; } });
  const input = document.getElementById("batch-files");
  input.fire("change", { target: { files: [fakeFile("p.heic", "x", "image/heic"), fakeFile("doc.txt", "текст")], value: "" } });
  await sleep(10);
  assert(err && err.includes("p.heic"), "баннер про HEIC: " + err);
  eq(state.batch.files.length, 1, "добавлен только txt");
  eq(state.batch.files[0].name, "doc.txt");
  err = null;
  await batch.attachImagesToFile(state.batch.files[0].id, [fakeFile("q.heic", "x", "image/heic")]);
  assert(err && err.includes("q.heic"), "баннер при attach: " + err);
  eq((state.batch.files[0].images || []).length, 0, "HEIC не прикреплён");
  const html = readFileSync(new NodeURL("../static/index.html", import.meta.url), "utf8");
  assert(!html.includes('accept="image/*"'), "в index.html нет accept=image/*");
});

test("presets: «✨ Сгенерировать…» — диалог, generate → createPreset; без chat-моделей — ошибка", async () => {
  installDom(); await resetState(); domApp();
  const calls = domPresetsFetch([PRESET_BUILTIN], {
    "GET /api/assistant/models": { models: [{ key: "rG", label: "GPT cloud", remote: true }] },
    "POST /api/presets/generate": {
      name: "Скрининг", description: "Проверка резюме",
      questions: [{ id: "q1", question: "Есть опыт?", type: "yes_no" }],
    },
    "POST /api/presets": (call) => ({ name: call.body.name, slug: "sgen", source: "user" }),
  });
  toolbar.initToolbar({});
  presetsMod.initPresets({});
  presetsMod.openPresetsPage();
  await sleep(10);
  document.getElementById("btn-preset-generate").fire("click");
  await sleep(10);  // диалог открывается после fetch /api/assistant/models
  const dlg = document.getElementById("generate-dialog");
  assert(dlg, "диалог генерации открыт");
  const sel = document.getElementById("generate-model");
  eq(sel.children.length, 1, "одна chat-модель");
  includes(sel.children[0].textContent, "☁", "облачная помечена ☁");
  includes(sel.children[0].textContent, "GPT cloud", "label в опции");
  document.getElementById("generate-task").value = "Скрининг резюме";
  document.getElementById("generate-thinking").checked = true;
  document.getElementById("generate-ok").fire("click");
  await sleep(10);
  const gen = calls.find(c => c.key === "POST /api/presets/generate");
  assert(gen, "generate вызван");
  eq(gen.body.model_key, "rG", "модель из селектора");
  eq(gen.body.thinking, true, "чекбокс «Рассуждение» передался");
  eq(gen.body.description, "Скрининг резюме", "описание из поля");
  const post = calls.find(c => c.key === "POST /api/presets");
  assert(post, "пресет создан");
  eq(post.body.name, "Скрининг", "имя из ответа LLM");
  eq(post.body.payload.questions[0].question, "Есть опыт?", "вопросы в payload");
  eq(post.body.payload.input, "Скрининг резюме", "описание задачи — input пресета");
  assert(!document.getElementById("generate-dialog"), "диалог закрыт после успеха");
  // без chat-моделей — понятная ошибка в диалоге
  installDom(); await resetState(); domApp();
  domPresetsFetch([], { "GET /api/assistant/models": { models: [] } });
  toolbar.initToolbar({});
  presetsMod.initPresets({});
  presetsMod.openPresetsPage();
  await sleep(10);
  document.getElementById("btn-preset-generate").fire("click");
  await sleep(10);  // диалог открывается после fetch /api/assistant/models
  const sel2 = document.getElementById("generate-model");
  includes(sel2.children[0].textContent, "Нет chat-моделей", "заглушка без моделей");
  document.getElementById("generate-task").value = "Задача";
  document.getElementById("generate-ok").fire("click");
  await sleep(10);
  const err = document.getElementById("generate-error");
  assert(!err.classList.contains("hidden"), "ошибка показана");
  includes(err.textContent, "Выберите chat-модель", "текст ошибки");
  document.getElementById("generate-cancel").fire("click");
  assert(!document.getElementById("generate-dialog"), "«Отмена» закрыла диалог");
  await sleep(10);
});
