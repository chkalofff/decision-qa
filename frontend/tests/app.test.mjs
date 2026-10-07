// Доменные тесты: app. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, installDom, el, fakeFile, resetState, mockFetch, sleep, domApp, modelsResp, ansYesNo, runRes, state, results, questions, context, batch, toolbar, update, assistant,
} from "./harness.mjs";

// ================================================================ app (режим «Оба» — последовательность)
test("app: режим «Оба» — fast_batch уходит только после ответа decisions (регрессия метрик)", async () => {
  installDom(); await resetState(); domApp();
  const decideCalls = [];
  const resolvers = [];
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A 27B", status: "running" }]),
    "GET /api/presets": [],
    "POST /api/decide": (call) => {
      decideCalls.push(call.body);
      return new Promise((resolve) => resolvers.push(resolve));
    },
  });
  await import("../static/app.js");
  await sleep(30); // поллинг моделей → авто-выбор running

  state.runMode = "both";
  document.getElementById("context-input").value = "Иван врач.";
  state.questions[0].question = "Иван врач?";
  document.getElementById("tb-run").fire("click");
  await sleep(10);

  eq(decideCalls.length, 1, "первый запрос один");
  eq(decideCalls[0].mode, "decisions", "сначала обычный");
  resolvers[0]({ results: { mA: runRes({ duration_s: 30, prompt_tokens: 500, prefill_tok_s: 16.7 }, {}) } });
  await sleep(10);

  eq(decideCalls.length, 2, "второй запрос после ответа первого");
  eq(decideCalls[1].mode, "fast_batch", "затем быстрый");
  resolvers[1]({ results: { mA: runRes({ duration_s: 2, prompt_tokens: 520, prefill_tok_s: 260 }, {}) } });
  await sleep(10);

  assert(state.results, "результаты сохранены");
  eq(state.results.runMode, "both", "режим both");
  eq(state.results.results.mA.decisions.metrics.duration_s, 30, "метрики обычного свои");
  eq(state.results.results.mA.fast_batch.metrics.prefill_tok_s, 260, "метрики быстрого свои");

  // баннер ошибки: текст в .banner-text и закрытие крестиком
  document.getElementById("context-input").value = "";
  document.getElementById("tb-run").fire("click");
  await sleep(10);
  const errBanner = document.getElementById("error-banner");
  assert(!errBanner.classList.contains("hidden"), "баннер ошибки показан");
  includes(document.getElementById("error-banner-text").textContent, "Контекст", "текст ошибки в .banner-text");
  document.getElementById("error-banner-close").fire("click");
  assert(errBanner.classList.contains("hidden"), "баннер закрыт крестиком");
  const fmtBanner = document.getElementById("format-banner");
  fmtBanner.classList.remove("hidden");
  document.getElementById("format-banner-close").fire("click");
  assert(fmtBanner.classList.contains("hidden"), "format-баннер тоже закрывается");
});

// Эти тесты идут после app-теста выше: модуль app.js уже инициализирован на
// текущем DOM (переустановка DOM отвязала бы обработчики), поэтому без installDom.
test("app: картинки — пресет грузит изображения (+ баннер «нужны vision»), прогон шлёт images и пропускает non-vision", async () => {
  await resetState();
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running", vision: false }]),
    "GET /api/presets": [
      { name: "UGC", description: "d", page: "single", input: "пост",
        images: ["data:image/png;base64,QUJD"],
        questions: [{ id: "q1", question: "Q?", type: "yes_no" }] },
    ],
  });
  document.getElementById("tb-menu-btn").fire("click");
  document.getElementById("tb-menu-presets").fire("click");
  await sleep(10);
  const item = [...document.getElementById("tb-menu-presets-sub").children]
    .find(i => i.textContent.includes("UGC"));
  assert(item, "пресет в меню");
  includes(item.textContent, "🖼", "бейдж 🖼 у пресета с картинками");
  item.fire("click");
  eq(state.contextImages.length, 1, "картинка из пресета загружена");
  eq(state.contextImages[0].dataUrl, "data:image/png;base64,QUJD", "dataUrl");
  const fmtBanner = document.getElementById("format-banner");
  assert(!fmtBanner.classList.contains("hidden"), "format-баннер показан");
  includes(document.getElementById("format-banner-text").textContent, "vision-модели", "текст баннера");
  // прогон с картинкой — images в payload, non-vision модели пропущены
  let captured = null;
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A", status: "running", vision: false, api: "decisions" },
      { key: "cB", label: "Clef B", status: "running", vision: true, api: "systemone" },
    ]),
    "GET /api/presets": [],
    "POST /api/decide": (call) => {
      captured = call.body;
      return { results: { cB: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }) } };
    },
  });
  toolbar.refreshModels();
  await sleep(10); // поллинг → авто-выбор обеих running
  document.getElementById("context-input").value = ""; // пустой текст + картинка
  state.questions = [{ id: "q1", question: "Есть телефон?", type: "yes_no", collapsed: true }];
  document.getElementById("tb-run").fire("click");
  await sleep(10);
  assert(captured, "decide вызван");
  eq(captured.models.join(","), "cB", "non-vision модель пропущена");
  eq(captured.images.join(","), "data:image/png;base64,QUJD", "images в теле запроса");
  eq(captured.input, "", "пустой текст допустим с картинкой");
  assert(state.results && state.results.images, "images в state.results (бейдж чипа)");
  await sleep(10);
});

test("app: direction — применяется из пресета и попадает в снапшот результатов (маркировка score)", async () => {
  await resetState();
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running" }]),
    "GET /api/presets": [
      { name: "ScorePreset", description: "d", page: "single", input: "текст",
        questions: [{ id: "q1", question: "Оценка?", type: "score", levels: ["плохо", "хорошо"], direction: "up" }] },
    ],
  });
  document.getElementById("tb-menu-btn").fire("click");
  document.getElementById("tb-menu-presets").fire("click");
  await sleep(10);
  const item = [...document.getElementById("tb-menu-presets-sub").children]
    .find(i => i.textContent.includes("ScorePreset"));
  assert(item, "пресет в меню");
  item.fire("click");
  eq(state.questions.length, 1, "вопрос из пресета применён");
  eq(state.questions[0].direction, "up", "direction из пресета сохранён (не сброшен нормализацией)");
  // прогон — снапшот вопросов в результатах несёт direction
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running" }]),
    "GET /api/presets": [],
    "POST /api/decide": () => ({
      results: { mA: runRes({ duration_s: 1, prompt_tokens: 10 }, {
        q1: { type: "score", score: 1, probabilities: { 0: 0.1, 1: 0.9 }, label_mass: 0.99 },
      }) },
    }),
  });
  toolbar.refreshModels();
  await sleep(10);
  document.getElementById("context-input").value = "контекст";
  document.getElementById("tb-run").fire("click");
  await sleep(10);
  assert(state.results, "результаты сохранены");
  eq(state.results.questions[0].direction, "up", "direction в снапшоте результатов");
  const ans = document.querySelector("#results-list .res-answer");
  assert(ans.classList.contains("dir-good"), "значение промаркировано dir-good");
  await sleep(10);
});

test("app: экспорт «Всё» — direction score-вопросов и batch_files независимо от страницы", async () => {
  await resetState();
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  state.questions = [{ id: "q1", question: "S?", type: "score", levels: ["a", "b"], direction: "down", collapsed: true }];
  document.getElementById("context-input").value = "контекст";
  batch.loadPresetFiles([
    { name: "a.txt", content: "текст" },
    { name: "p.png", image: "data:image/png;base64,QUJD" },
  ]);
  let captured = null;
  globalThis.URL.createObjectURL = (blob) => { captured = blob.content; return "blob:x"; };
  document.getElementById("tb-menu-export-all").fire("click");
  assert(captured, "файл экспортирован");
  const data = JSON.parse(captured);
  eq(data.input, "контекст", "контекст в экспорте");
  eq(data.questions[0].direction, "down", "direction в экспорте «Всё»");
  eq(data.batch_files.length, 2, "batch_files в экспорте");
  eq(data.batch_files[0].content, "текст", "текстовый файл → content");
  eq(data.batch_files[1].image, "data:image/png;base64,QUJD", "картинка → image (dataUrl)");
  await sleep(10);
});

test("app: импорт batch_files — страница «Батч», баннер, замена через confirm", async () => {
  await resetState();
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  globalThis.confirm = () => true;
  const label = document.getElementById("tb-menu-import");
  const payload = JSON.stringify({ input: "", batch_files: [
    { name: "a.txt", content: "x" },
    { name: "p.png", image: "data:image/png;base64,QUJD" },
  ] });
  label.fire("change", { target: { files: [fakeFile("s.json", payload)], value: "" } });
  await sleep(10);
  eq(state.batch.files.length, 2, "файлы загружены в батч");
  assert(state.batch.files[1].isImage, "картинка распознана");
  eq(state.pageMode, "batch", "страница переключена на «Батч»");
  const fmt = document.getElementById("format-banner-text");
  assert(!document.getElementById("format-banner").classList.contains("hidden"), "баннер показан");
  includes(fmt.textContent, "батч", "текст баннера про файлы батча");
  // повторный импорт при непустом батче: отмена confirm — ничего не меняется
  globalThis.confirm = () => false;
  label.fire("change", { target: { files: [fakeFile("s2.json", '{"batch_files":[{"name":"b.txt","content":"y"}]}')], value: "" } });
  await sleep(10);
  eq(state.batch.files.length, 2, "отмена confirm — батч не изменился");
  eq(state.batch.files[0].name, "a.txt", "старые файлы на месте");
  globalThis.confirm = () => true;
  await sleep(10);
});

test("app: ✨ генерация вопросов — диалог, POST с контекстом, вопросы добавлены", async () => {
  await resetState();
  state.models = [
    { key: "rG", label: "GPT cloud", type: "remote", api: "openai", enabled: true,
      base_url: "https://api.openai.com/v1", api_model: "gpt-4o" },
    { key: "mA", label: "Local", type: "sglang", status: "running" },  // не chat-remote — не в селекторе
  ];
  const calls = mockFetch({
    "GET /api/models": modelsResp(state.models),
    "GET /api/presets": [],
    "GET /api/assistant/models": { models: [
      { key: "rG", label: "GPT cloud", remote: true },
      { key: "bonsai2-27b", label: "Bonsai-2 27B 2bit", remote: false },
    ] },
    "POST /api/questions/generate": {
      questions: [
        { id: "q1", question: "Есть цифры?", type: "yes_no", yes: "цифры есть" },
        { id: "q2", question: "Стек?", type: "choice", options: [{ name: "Python" }, { name: "Go" }] },
      ],
    },
  });
  document.getElementById("context-input").value = "резюме Ивана";
  document.getElementById("btn-gen-questions").fire("click");
  await sleep(10);  // диалог открывается после fetch /api/assistant/models
  const dlg = document.getElementById("generate-dialog");
  assert(dlg, "диалог открыт");
  const sel = document.getElementById("generate-model");
  eq(sel.children.length, 2, "облачная и локальная chat-модели в селекторе");
  includes(sel.children[0].textContent, "☁", "облачная помечена ☁");
  includes(sel.children[1].textContent, "Bonsai", "bonsai видна в диалоге");
  assert(!document.getElementById("generate-thinking").checked,
    "рассуждение выключено по умолчанию");
  document.getElementById("generate-task").value = "проверка резюме";
  document.getElementById("generate-ok").fire("click");
  await sleep(10);
  const gen = calls.find(c => c.key === "POST /api/questions/generate");
  assert(gen, "generate вызван");
  eq(gen.body.model_key, "rG", "модель из селектора");
  eq(gen.body.thinking, false, "thinking=false без чекбокса");
  eq(gen.body.input, "резюме Ивана", "текущий контекст ушёл как input");
  eq(gen.body.hint, "проверка резюме", "описание задачи ушло как hint");
  const texts = state.questions.map(q => q.question);
  includes(texts.join("|"), "Есть цифры?", "сгенерированный вопрос добавлен");
  includes(texts.join("|"), "Стек?", "второй вопрос добавлен");
  const gen1 = state.questions.find(q => q.question === "Есть цифры?");
  eq(gen1.yes, "цифры есть", "yes-описание сохранено");
  assert(gen1.id !== "q1" || !state.questions.some(q => q !== gen1 && q.id === "q1"),
    "id перегенерирован");
  assert(!document.getElementById("generate-dialog"), "диалог закрыт после успеха");
  // ошибка API — остаётся в диалоге
  mockFetch({
    "GET /api/models": modelsResp(state.models),
    "GET /api/presets": [],
    "GET /api/assistant/models": { models: [{ key: "rG", label: "GPT cloud", remote: true }] },
    "POST /api/questions/generate": { __status: 502, detail: "API ответил 429" },
  });
  document.getElementById("btn-gen-questions-batch").fire("click");
  await sleep(10);  // диалог открывается после fetch /api/assistant/models
  document.getElementById("generate-task").value = "задача";
  document.getElementById("generate-ok").fire("click");
  await sleep(10);
  const err = document.getElementById("generate-error");
  assert(!err.classList.contains("hidden"), "ошибка показана в диалоге");
  includes(err.textContent, "429", "текст 502 в диалоге");
  assert(document.getElementById("generate-dialog"), "диалог остался открытым");
  document.getElementById("generate-cancel").fire("click");
  await sleep(10);
});

// ---------------------------------------------------------------- обновления

function domUpdateBanner() {
  const banner = el("div", { id: "update-banner", className: "error-banner hidden" });
  el("span", { id: "update-banner-text", className: "banner-text", parent: banner });
  const link = el("a", { id: "update-banner-link", parent: banner });
  el("button", { id: "update-banner-close", parent: banner });
  return { banner, link };
}

const GH_LATEST = "https://api.github.com/repos/chkalofff/decision-qa/releases/latest";

function clearUpdateStorage() {
  localStorage.removeItem("dq-update-check");
  localStorage.removeItem("dq-update-dismissed");
}

test("update: semver-парсинг и сравнение версий", () => {
  eq(JSON.stringify(update.parseVersion("0.2.0")), "[0,2,0]", "0.2.0");
  eq(JSON.stringify(update.parseVersion("v1.10.3")), "[1,10,3]", "v-префикс");
  eq(update.parseVersion("dev"), null, "dev — не semver");
  eq(update.parseVersion(""), null, "пустая строка");
  assert(update.isNewerVersion("v0.3.0", "0.2.0"), "0.3.0 новее 0.2.0");
  assert(update.isNewerVersion("0.2.1", "0.2.0"), "0.2.1 новее 0.2.0");
  assert(!update.isNewerVersion("0.2.0", "0.2.0"), "равные — не новее");
  assert(!update.isNewerVersion("0.2.0", "v0.3.0"), "старая не новее новой");
  assert(!update.isNewerVersion("1.0", "0.2.0"), "не-semver игнорируется");
});

test("update: новый релиз → баннер с версией и командой", async () => {
  installDom(); clearUpdateStorage();
  const { banner, link } = domUpdateBanner();
  const calls = mockFetch({
    "GET /api/version": { version: "0.2.0" },
    [`GET ${GH_LATEST}`]: { tag_name: "v0.3.0", html_url: "https://github.com/chkalofff/decision-qa/releases/tag/v0.3.0" },
  });
  const info = await update.checkForUpdate();
  assert(info, "инфо о новой версии");
  eq(info.version, "0.3.0", "версия без v");
  update.renderUpdateBanner(info);
  assert(!banner.classList.contains("hidden"), "баннер виден");
  includes(document.getElementById("update-banner-text").textContent, "0.3.0", "текст с версией");
  includes(document.getElementById("update-banner-text").textContent, "update_mac.sh", "команда обновления");
  eq(link.href, "https://github.com/chkalofff/decision-qa/releases/tag/v0.3.0", "ссылка на релиз");
  // закрытие скрывает баннер и запоминает dismissed-версию
  document.getElementById("update-banner-close").fire("click");
  assert(banner.classList.contains("hidden"), "баннер скрыт");
  eq(JSON.parse(localStorage.getItem("dq-update-dismissed")), "v0.3.0", "dismissed записан");
  // повторная проверка той же версии → null
  clearUpdateStorage();
  localStorage.setItem("dq-update-dismissed", JSON.stringify("v0.3.0"));
  const again = await update.checkForUpdate();
  eq(again, null, "закрытая версия не предлагается повторно");
});

test("update: равные версии и ошибки сети → без баннера, GitHub не опрашивается лишний раз", async () => {
  installDom(); clearUpdateStorage();
  domUpdateBanner();
  const calls = mockFetch({
    "GET /api/version": { version: "0.2.0" },
    [`GET ${GH_LATEST}`]: { tag_name: "v0.2.0", html_url: "u" },
  });
  eq(await update.checkForUpdate(), null, "та же версия — null");
  eq(calls.filter(c => c.key === `GET ${GH_LATEST}`).length, 1, "один запрос к GitHub");
  assert(document.getElementById("update-banner").classList.contains("hidden"), "баннер не показан");
  // ошибки — тихий фейл
  clearUpdateStorage();
  mockFetch({
    "GET /api/version": { version: "0.2.0" },
    [`GET ${GH_LATEST}`]: { __status: 403, detail: "rate limit" },
  });
  eq(await update.checkForUpdate(), null, "ошибка GitHub — null");
  assert(document.getElementById("update-banner").classList.contains("hidden"), "баннер не показан");
  mockFetch({});
  eq(await update.checkForUpdate(), null, "backend не ответил — null");
});

test("update: кэш суток — повтор без запроса; протухший кэш → запрос", async () => {
  installDom(); clearUpdateStorage();
  domUpdateBanner();
  const calls = mockFetch({
    "GET /api/version": { version: "0.2.0" },
    [`GET ${GH_LATEST}`]: { tag_name: "v0.3.0", html_url: "u" },
  });
  await update.checkForUpdate();
  await update.checkForUpdate();
  await update.checkForUpdate();
  eq(calls.filter(c => c.key === `GET ${GH_LATEST}`).length, 1, "GitHub опрошен один раз");
  // протухший кэш → повторный запрос
  localStorage.setItem("dq-update-check", JSON.stringify({
    at: Date.now() - 25 * 60 * 60 * 1000, latest: { tag: "v0.1.0", url: "u" },
  }));
  const info = await update.checkForUpdate();
  assert(info && info.version === "0.3.0", "после протухания кэша версия свежая");
  eq(calls.filter(c => c.key === `GET ${GH_LATEST}`).length, 2, "запрос к GitHub выполнен повторно");
});
