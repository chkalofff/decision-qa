// Доменные тесты: toolbar. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, notIncludes, installDom, el, resetState, mockFetch, sleep, domToolbar, modelsResp, state, emit, questions, context, batch, toolbar,
} from "./harness.mjs";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";  // глобальный URL подменён DOM-моком

// ================================================================ toolbar

test("toolbar: чипы моделей — авто-выбор, доступность Run, short_label, прогресс, отключённая скрыта", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A 27B", status: "running" },
      { key: "mB", label: "Qwen B 35B", status: "stopped" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const chips = document.getElementById("tb-models").children;
  eq(chips.length, 2, "два чипа");
  const [cbA, cbB] = chips.map(c => c.querySelector("input"));
  eq(cbA.checked, true, "running выбрана автоматически");
  eq(cbB.disabled, true, "stopped недоступна");
  eq(document.getElementById("tb-run").disabled, false, "Run доступен");
  // short_label, прогресс скачивания, отключённая скрыта
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A 27B", short_label: "27B", status: "downloading", progress: 0.42, enabled: true },
      { key: "mB", label: "Hidden Model", status: "stopped", enabled: false },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const chips2 = document.getElementById("tb-models").children;
  eq(chips2.length, 1, "отключённая модель не показывается");
  includes(chips2[0].textContent, "27B", "короткое имя из short_label");
  includes(chips2[0].textContent, "≈42%", "прогресс скачивания в чипе");
});

test("toolbar: меню слева — сабменю экспорта, колбэки пунктов, закрытие", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  const called = [];
  toolbar.initToolbar({
    onExportQuestions: () => called.push("q"),
    onExportContext: () => called.push("c"),
    onExportAll: () => called.push("all"),
  });
  const dd = document.getElementById("tb-menu");
  assert(dd.classList.contains("menu-left"), "меню прибито к левому краю");
  document.getElementById("tb-menu-btn").fire("click");
  assert(!dd.classList.contains("hidden"), "меню открыто");
  document.getElementById("tb-menu-export").fire("click");
  assert(!document.getElementById("tb-menu-export-sub").classList.contains("hidden"), "сабменю экспорта открыто");
  document.getElementById("tb-menu-export-questions").fire("click");
  document.getElementById("tb-menu-export-context").fire("click");
  document.getElementById("tb-menu-export-all").fire("click");
  eq(called.join(","), "q,c,all", "все колбэки");
  // «Свернуть/развернуть всё» (кнопки в шапке панели) — и вопросы, и исходы решения
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no", collapsed: false }];
  state.decision = { enabled: true, outcomes: [{ id: "o1", label: "A", color: "green", collapsed: false, rules: [] }] };
  document.getElementById("btn-collapse-all-single").fire("click");
  assert(state.questions[0].collapsed && state.decision.outcomes[0].collapsed, "свёрнуты и вопросы, и исходы");
  document.getElementById("btn-expand-all-batch").fire("click");
  assert(!state.questions[0].collapsed && !state.decision.outcomes[0].collapsed, "развёрнуты и вопросы, и исходы (кнопка батча — то же состояние)");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(dd.classList.contains("hidden"), "Escape закрыл меню");
  assert(document.getElementById("tb-menu-export-sub").classList.contains("hidden"), "сабменю закрыто");
  await sleep(10); // дождаться полла — иначе он долетит до installDom следующего теста
});

test("toolbar: пресеты в сабменю — группы «Один материал»/«Пакет», клик применяет", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([]),
    "GET /api/presets": [
      { name: "Обычный пресет", description: "d1", input: "x", questions: [] },
      { name: "Скрининг резюме", page: "batch", questions: [], files: [] },
    ],
  });
  let applied = null;
  toolbar.initToolbar({ applyPreset: (p) => { applied = p; } });
  document.getElementById("tb-menu-btn").fire("click");
  document.getElementById("tb-menu-presets").fire("click");
  await sleep(10);
  const sub = document.getElementById("tb-menu-presets-sub");
  const children = [...sub.children];
  eq(children.length, 4, "два заголовка + два пресета");
  const heads = children.filter(c => c.classList.contains("menu-group-head"));
  eq(heads.length, 2, "два заголовка групп");
  eq(heads[0].textContent, "Один материал", "первая группа — один материал");
  eq(heads[1].textContent, "Пакет", "вторая группа — пакет");
  const items = children.filter(c => !c.classList.contains("menu-group-head"));
  eq(items.length, 2, "два пресета");
  items.forEach(i => notIncludes(i.textContent, "батч", "бейджа «батч» больше нет"));
  eq(children.indexOf(items[0]) > children.indexOf(heads[0]), true, "одиночный под своим заголовком");
  eq(children.indexOf(items[0]) < children.indexOf(heads[1]), true, "одиночный до группы «Пакет»");
  eq(children.indexOf(items[1]) > children.indexOf(heads[1]), true, "пакетный пресет под заголовком «Пакет»");
  items[0].fire("click");
  assert(applied && applied.name === "Обычный пресет", "пресет применён");
  await sleep(10); // дождаться полла
});

test("toolbar: setPageMode переключает страницы", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  toolbar.initToolbar({});
  toolbar.setPageMode("batch");
  assert(document.getElementById("page-single").classList.contains("hidden"), "single скрыт");
  assert(!document.getElementById("page-batch").classList.contains("hidden"), "batch виден");
  toolbar.setPageMode("models");
  assert(!document.getElementById("page-models").classList.contains("hidden"), "models видна");
  assert(document.getElementById("page-batch").classList.contains("hidden"), "batch скрыт");
  assert(document.getElementById("tb-run").disabled, "Run недоступен на странице моделей");
  toolbar.setPageMode("single");
  assert(!document.getElementById("page-single").classList.contains("hidden"), "single виден");
  await sleep(10); // дождаться полла
});

test("toolbar: чипы показывают только запиненные модели", async () => {
  installDom(); await resetState(); domToolbar();
  localStorage.setItem("pinnedModels", JSON.stringify(["mB"]));
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A 27B", status: "running" },
      { key: "mB", label: "Qwen B 35B", status: "running" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const chips = document.getElementById("tb-models").children;
  eq(chips.length, 1, "только запиненная модель в баре");
  includes(chips[0].textContent, "35B", "это запиненная mB");
});

test("toolbar: chat-only модель не попадает в чипы и не авто-выбирается", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A 27B", status: "running", roles: ["decision", "chat"] },
      { key: "mC", label: "Chatty", status: "running", roles: ["chat"] },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const chips = document.getElementById("tb-models").children;
  eq(chips.length, 1, "в баре только decision-модель");
  assert(state.selectedModels.has("mA"), "mA авто-выбрана");
  assert(!state.selectedModels.has("mC"), "chat-only mC не авто-выбрана");
  document.getElementById("tb-models-menu").fire("click");
  const rows = document.getElementById("tb-models-dropdown-list").children;
  eq(rows.length, 1, "и в дропдауне только decision-модель");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  await sleep(10); // дождаться полла
});

test("toolbar: пин в дропдауне меняет чипы и пишется в localStorage", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A 27B", status: "running" },
      { key: "mB", label: "Qwen B 35B", status: "running" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  // бесшовная миграция: первый запуск пинит все enabled
  eq(document.getElementById("tb-models").children.length, 2, "миграция: все enabled запинены");
  eq(JSON.parse(localStorage.getItem("pinnedModels")).join(","), "mA,mB", "миграция записана в localStorage");
  const dd = document.getElementById("tb-models-dropdown");
  document.getElementById("tb-models-menu").fire("click");
  assert(!dd.classList.contains("hidden"), "дропдаун открыт");
  const rows = document.getElementById("tb-models-dropdown-list").children;
  eq(rows.length, 2, "две строки моделей");
  const pinB = rows[1].querySelector(".pin-check");
  assert(pinB.checked, "mB запинена");
  pinB.checked = false;
  pinB.fire("change");
  eq(document.getElementById("tb-models").children.length, 1, "чип mB убран из бара");
  eq(JSON.parse(localStorage.getItem("pinnedModels")).join(","), "mA", "localStorage обновлён");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(dd.classList.contains("hidden"), "Esc закрыл дропдаун");
  document.getElementById("tb-models-menu").fire("click");
  assert(!dd.classList.contains("hidden"), "дропдаун снова открыт");
  document.dispatchEvent({ type: "click" });
  assert(dd.classList.contains("hidden"), "клик вне закрыл дропдаун");
});

test("toolbar: запиненная stopped-модель видна, её чекбокс прогона disabled", async () => {
  installDom(); await resetState(); domToolbar();
  localStorage.setItem("pinnedModels", JSON.stringify(["mA", "mB"]));
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A 27B", status: "running" },
      { key: "mB", label: "Qwen B 35B", status: "stopped" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const chips = document.getElementById("tb-models").children;
  eq(chips.length, 2, "stopped запиненная видна");
  const cbB = chips[1].querySelector(".chip-check");
  eq(cbB.disabled, true, "чекбокс stopped-модели disabled");
  assert(chips[1].querySelector(".dot-stopped"), "статус-точка stopped");
});

test("toolbar: чип облачной модели без ключа — чекбокс disabled с title про API-ключ", async () => {
  installDom(); await resetState(); domToolbar();
  localStorage.setItem("pinnedModels", JSON.stringify(["rJev"]));
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "rJev", label: "Jev (облако) · latest", short_label: "Jev", type: "remote",
        api: "systemone", managed: false, status: "no_credentials", enabled: true,
        base_url: "https://api.typesafe.ai", has_credentials: false },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const chips = document.getElementById("tb-models").children;
  eq(chips.length, 1, "чип облачной модели в баре");
  includes(chips[0].textContent, "Jev", "short_label в чипе");
  const cb = chips[0].querySelector(".chip-check");
  eq(cb.disabled, true, "чекбокс прогона disabled");
  eq(cb.checked, false, "и не выбран");
  includes(cb.title, "API-ключ", "title объясняет, что делать");
  assert(chips[0].querySelector(".dot-no_credentials"), "статус-точка no_credentials");
});

test("toolbar: без пинов — кнопка «Выбрать модели…» открывает дропдаун; «Настройки моделей…» → страница models", async () => {
  installDom(); await resetState(); domToolbar();
  localStorage.setItem("pinnedModels", JSON.stringify([]));
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running" }]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const pick = document.getElementById("tb-models-pick");
  assert(pick, "вместо чипов — кнопка выбора моделей");
  pick.fire("click");
  assert(!document.getElementById("tb-models-dropdown").classList.contains("hidden"), "дропдаун открыт");
  // «Настройки моделей…» из дропдауна открывает страницу models
  document.getElementById("tb-models-settings").fire("click");
  eq(state.pageMode, "models", "переход на страницу models");
  assert(!document.getElementById("page-models").classList.contains("hidden"), "page-models видна");
  assert(document.getElementById("tb-models-dropdown").classList.contains("hidden"), "дропдаун закрыт");
});

test("toolbar: только SystemOne-модели — быстрый режим и температура заблокированы", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([{ key: "cA", label: "Clef A", status: "running", api: "systemone" }]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const fast = document.querySelector('#tb-runmode button[data-runmode="fast_batch"]');
  const both = document.querySelector('#tb-runmode button[data-runmode="both"]');
  assert(fast.disabled && both.disabled, "«Быстрый» и «Оба» disabled");
  includes(fast.title, "SGLang", "title объясняет причину");
  assert(document.getElementById("temperature").disabled, "температура disabled");
  const note = document.getElementById("temp-lock-note");
  assert(!note.classList.contains("hidden"), "пояснение блокировки видно");
  includes(note.textContent, "Clef детерминирована", "причина — детерминированная Clef");
});

test("toolbar: кнопка настроек запуска (▾) видна только при выбранной sglang-модели", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "cA", label: "Clef A", status: "running", type: "clef", api: "systemone", vision: true },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const opt = () => document.getElementById("tb-run-options");
  const runGroup = () => document.querySelector(".tb-run-group");
  eq(opt().style.display, "none", "кнопка скрыта без sglang-моделей");
  assert(runGroup().classList.contains("no-options"), "группа помечена no-options без ▾");
  // добавляем sglang-модель — она авто-выбирается, кнопка появляется
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "cA", label: "Clef A", status: "running", type: "clef", api: "systemone", vision: true },
      { key: "mB", label: "Qwen B", status: "running", type: "sglang", api: "decisions" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.refreshModels();
  await sleep(10);
  eq(opt().style.display, "", "кнопка видна с выбранной sglang-моделью");
  assert(!runGroup().classList.contains("no-options"), "no-options снят при видимой ▾");
  // открытый поповер закрывается, когда sglang-модель перестала быть выбрана
  opt().fire("click");
  assert(!document.getElementById("run-popover").classList.contains("hidden"), "поповер открыт");
  state.selectedModels.delete("mB");
  toolbar.refreshRunButton();
  eq(opt().style.display, "none", "кнопка снова скрыта");
  assert(document.getElementById("run-popover").classList.contains("hidden"), "поповер закрыт");
  await sleep(10); // дождаться полла
});
test("toolbar: шеврон открывает поповер запуска, режим «Быстрый» блокирует температуру", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running", api: "decisions", type: "sglang" }]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  includes(document.getElementById("tb-run").textContent, "(обычный)", "суффикс режима на кнопке");
  const pop = document.getElementById("run-popover");
  document.getElementById("tb-run-options").fire("click");
  assert(!pop.classList.contains("hidden"), "поповер открыт");
  document.querySelector('#run-popover [data-temp="0.5"]').fire("click");
  eq(state.temperature, 0.5, "пресет температуры применён");
  const fast = document.querySelector('#tb-runmode button[data-runmode="fast_batch"]');
  assert(!fast.disabled, "быстрый доступен для SGLang-модели");
  // DOM-мок не имеет bubbling — клик по кнопке сегмента диспатчим на сегмент
  document.getElementById("tb-runmode").fire("click", { target: fast });
  eq(state.runMode, "fast_batch", "режим переключён");
  assert(document.getElementById("temperature").disabled, "температура disabled в быстром режиме");
  includes(document.getElementById("temp-lock-note").textContent, "в быстром режиме всегда 0", "причина — быстрый режим");
  includes(document.getElementById("tb-run").textContent, "(быстрый)", "суффикс обновлён");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(pop.classList.contains("hidden"), "Esc закрыл поповер");
});

test("toolbar: быстрый режим автоматически сбрасывается без SGLang-моделей (+ баннер)", async () => {
  installDom(); await resetState(); domToolbar();
  const fmtBanner = el("div", { id: "format-banner", className: "hidden" });
  el("span", { id: "format-banner-text", parent: fmtBanner });
  el("button", { id: "btn-reset-pin", parent: fmtBanner });
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A", status: "running", api: "decisions" },
      { key: "cB", label: "Clef B", status: "running", api: "systemone" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const fastBtn = document.querySelector('#tb-runmode button[data-runmode="fast_batch"]');
  document.getElementById("tb-runmode").fire("click", { target: fastBtn });
  eq(state.runMode, "fast_batch", "быстрый режим включён");
  // SGLang-модель остановилась — быстрый режим некому исполнять
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A", status: "stopped", api: "decisions" },
      { key: "cB", label: "Clef B", status: "running", api: "systemone" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.refreshModels();
  await sleep(10);
  eq(state.runMode, "decisions", "режим автоматически возвращён в «Обычный»");
  assert(document.querySelector('#tb-runmode button[data-runmode="decisions"]').classList.contains("active"), "сегмент показывает «Обычный»");
  assert(!document.getElementById("format-banner").classList.contains("hidden"), "баннер показан");
  includes(document.getElementById("format-banner-text").textContent, "не поддерживают быстрый прогон", "текст баннера");
});

test("toolbar: vision-бейджи — 🖼 у vision в дропдауне и чипе, 🚫🖼 на выбранном non-vision при картинках", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A", status: "running", vision: false },
      { key: "cB", label: "Clef B", status: "running", vision: true },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  document.getElementById("tb-models-menu").fire("click");
  const rows = document.getElementById("tb-models-dropdown-list").children;
  eq(rows.length, 2, "две строки");
  assert(!rows[0].querySelector(".vision-badge"), "у текстовой модели бейджа нет");
  includes(rows[0].querySelector(".models-menu-name").title, "без картинок", "title у non-vision");
  const badge = rows[1].querySelector(".vision-badge");
  assert(badge, "у vision-модели бейдж");
  eq(badge.textContent, "🖼", "бейдж 🖼");
  // чип тоже с бейджем
  const chips = document.getElementById("tb-models").children;
  assert(!chips[0].querySelector(".vision-badge"), "чип non-vision без бейджа");
  assert(chips[1].querySelector(".vision-badge"), "чип vision с бейджем");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  // 🚫🖼 на выбранном non-vision чипе при прикреплённых картинках
  const chipAt = () => document.getElementById("tb-models").children[0];
  assert(!chipAt().querySelector(".novision-badge"), "без картинок бейджа нет");
  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }];
  emit("images");
  const nv = chipAt().querySelector(".novision-badge");
  assert(nv, "бейдж появился");
  eq(nv.textContent, "🚫🖼", "бейдж 🚫🖼");
  includes(nv.title, "будет пропущена", "title объясняет пропуск при прогоне");
  assert(!chipAt().classList.contains("chip-no-vision"), "outline-класса нет");
  state.contextImages = [];
  emit("images");
  assert(!chipAt().querySelector(".novision-badge"), "бейдж исчез после снятия картинки");
  // в CSS не должно быть обводки chip-no-vision
  const css = readFileSync(new NodeURL("../static/style.css", import.meta.url), "utf8");
  notIncludes(css, "chip-no-vision", "класс обводки удалён из style.css");
  await sleep(10); // дождаться полла
});

test("toolbar: hover на чипе — тултип с именем/статусом/памятью/vision, скрытие", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A 27B", status: "running", type: "sglang", vision: true,
        peak_gb: 17, download_gb: 15, port: 30001 },
      { key: "rB", label: "Cloud B", status: "stopped", type: "remote", vision: false,
        base_url: "http://x" },
    ]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const chips = document.getElementById("tb-models").children;
  const tip = () => document.body.querySelector(".dist-tip");
  chips[0].fire("mouseenter");
  assert(tip() && !tip().classList.contains("hidden"), "тултип виден");
  includes(tip().textContent, "Qwen A 27B", "полное имя");
  includes(tip().textContent, "работает", "человеческий статус");
  includes(tip().textContent, "локально", "размещение локальное");
  includes(tip().textContent, "17 ГБ", "пик памяти");
  includes(tip().textContent, "15 ГБ", "размер скачивания");
  includes(tip().textContent, "🖼", "vision-метка");
  includes(tip().textContent, "30001", "порт");
  chips[0].fire("mouseleave");
  assert(tip().classList.contains("hidden"), "тултип скрыт на mouseleave");
  // облачная модель: облако, без картинок, base_url
  chips[1].fire("mouseenter");
  includes(tip().textContent, "облако", "размещение облачное");
  includes(tip().textContent, "без поддержки изображений", "non-vision");
  includes(tip().textContent, "http://x", "base_url");
  notIncludes(tip().textContent, "Скачивание", "у облака нет размера скачивания");
  // клик (поповер) прячет тултип
  chips[1].fire("click");
  assert(tip().classList.contains("hidden"), "тултип скрыт при открытии поповера");
  assert(!document.getElementById("model-popover").classList.contains("hidden"), "поповер открыт");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  await sleep(10); // дождаться полла
});

test("toolbar: изображения — «Быстрый»/«Оба» disabled, включённый быстрый сбрасывается (+ баннер)", async () => {
  installDom(); await resetState(); domToolbar();
  const fmtBanner = el("div", { id: "format-banner", className: "hidden" });
  el("span", { id: "format-banner-text", parent: fmtBanner });
  el("button", { id: "btn-reset-pin", parent: fmtBanner });
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running", api: "decisions", vision: false }]),
    "GET /api/presets": [],
  });
  toolbar.initToolbar({});
  await sleep(10);
  const fast = document.querySelector('#tb-runmode button[data-runmode="fast_batch"]');
  const both = document.querySelector('#tb-runmode button[data-runmode="both"]');
  assert(!fast.disabled, "без картинок быстрый доступен");
  // включённый быстрый режим сбрасывается при прикреплении изображения
  document.getElementById("tb-runmode").fire("click", { target: fast });
  eq(state.runMode, "fast_batch", "быстрый включён");
  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }];
  toolbar.refreshRunButton();
  eq(state.runMode, "decisions", "режим возвращён в «Обычный»");
  assert(!document.getElementById("format-banner").classList.contains("hidden"), "баннер показан");
  includes(document.getElementById("format-banner-text").textContent, "изображения", "текст про изображения");
  // и режимы заблокированы, пока картинка прикреплена
  assert(fast.disabled && both.disabled, "с картинкой «Быстрый» и «Оба» disabled");
  includes(fast.title, "не поддерживает изображения", "title объясняет причину");
  state.contextImages = [];
  toolbar.refreshRunButton();
  assert(!fast.disabled && !both.disabled, "после снятия картинки режимы снова доступны");
});
