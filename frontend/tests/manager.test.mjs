// Доменные тесты: manager. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, installDom, el, resetState, mockFetch, sleep, domToolbar, modelsResp, state, context,
} from "./harness.mjs";

// ================================================================ manager

test("manager: карточки, шапка устройства, форма облачной модели", async () => {
  installDom(); await resetState(); domToolbar();
  const manager = await import("../static/manager.js");
  state.models = [
    { key: "mA", label: "Qwen A", short_label: "A", type: "sglang", api: "decisions",
      managed: true, status: "running", enabled: true, port: 30001, hf_id: "o/a",
      peak_gb: 17, download_gb: 15, fit: "ok" },
    { key: "rB", label: "Cloud B", short_label: "B", type: "remote", api: "systemone",
      managed: false, status: "no_credentials", enabled: true, base_url: "http://x",
      has_credentials: false },
    { key: "rC", label: "Cloud C", short_label: "C", type: "remote", api: "systemone",
      managed: false, status: "running", enabled: true, base_url: "http://y",
      has_credentials: true },
  ];
  state.device = { ram_gb: 64, budget_gb: 41.6 };
  state.pageMode = "models";
  manager.initManager({});
  const page = document.getElementById("page-models");
  includes(page.textContent, "RAM 64", "шапка устройства");
  includes(page.textContent, "SGLang", "бейдж типа локальной");
  includes(page.textContent, "облако", "бейдж облачной");
  includes(page.textContent, "нет API-ключа", "статус no_credentials");
  includes(page.textContent, "работает", "статус running");
  includes(page.textContent, "Добавить облачную модель", "форма добавления");
  // карточка облачной модели: поле base_url, поле ключа — и НЕТ кнопок процесса
  const cards = [...page.querySelectorAll(".mgr-card")];
  const remote = cards.find(c =>
    [...c.querySelectorAll("button")].some(b => b.textContent === "Сохранить ключ"));
  assert(remote, "карточка облачной модели есть");
  const remoteBtns = [...remote.querySelectorAll("button")].map(b => b.textContent);
  assert(remoteBtns.includes("Сохранить ключ"), "есть «Сохранить ключ»");
  for (const forbidden of ["Запустить", "Остановить", "Скачать", "Удалить файлы"]) {
    assert(!remoteBtns.some(t => t.includes(forbidden)), `у remote нет кнопки «${forbidden}»`);
  }
  const keyInput = [...remote.querySelectorAll("input")].find(i => i.type === "password");
  assert(keyInput, "поле API-ключа (password) есть");
  eq(keyInput.placeholder, "API-ключ", "placeholder без сохранённого ключа");
  const urlInput = [...remote.querySelectorAll("input")].find(i => i.value === "http://x");
  assert(urlInput, "поле base_url заполнено из конфига");
  // карточка remote с сохранённым ключом — «Удалить ключ», placeholder меняется
  const remoteC = cards.find(c => [...c.querySelectorAll("input")].some(i => i.value === "http://y"));
  assert(remoteC, "карточка Cloud C есть");
  includes(remoteC.textContent, "Удалить ключ", "кнопка удаления ключа при has_credentials");
  const keyInputC = [...remoteC.querySelectorAll("input")].find(i => i.type === "password");
  includes(keyInputC.placeholder, "сохранён", "placeholder сигналит, что ключ задан");
});

test("manager: бейджи ролей и чекбоксы ролей шлют PATCH, последняя роль не снимается", async () => {
  installDom(); await resetState(); domToolbar();
  const manager = await import("../static/manager.js");
  state.models = [
    { key: "mA", label: "Qwen A", short_label: "A", type: "sglang", api: "decisions",
      managed: true, status: "running", enabled: true, port: 30001, hf_id: "o/a",
      peak_gb: 17, download_gb: 15, fit: "ok", roles: ["decision", "chat"] },
  ];
  state.device = { ram_gb: 64, budget_gb: 41.6 };
  state.pageMode = "models";
  // PATCH «применяется» к state.models — перерендер показывает новые роли
  const calls = mockFetch({
    "PATCH /api/models/mA": (call) => {
      Object.assign(state.models[0], call.body);
      return { key: "mA" };
    },
    "GET /api/models": () => modelsResp(state.models),
  });
  manager.initManager({});
  const card = [...document.querySelectorAll("#page-models .mgr-card")]
    .find(c => c.querySelector('input[data-role="chat"]'));
  assert(card, "карточка модели с чекбоксами ролей");
  includes(card.textContent, "Прогоны", "бейдж роли decision");
  includes(card.textContent, "Ассистент", "бейдж роли chat");
  const cbChat = card.querySelector('input[data-role="chat"]');
  assert(cbChat && cbChat.checked, "чекбокс chat включён");
  cbChat.checked = false;
  cbChat.fire("change");
  await sleep(10);
  const patch = calls.find(c => c.key === "PATCH /api/models/mA");
  assert(patch, "PATCH отправлен");
  eq(patch.body.roles.join(","), "decision", "chat-роль снята");
  // карточка перерендерилась после PATCH — перечитываем; последнюю роль снять нельзя
  const cbDec = document.querySelector('#page-models input[data-role="decision"]');
  cbDec.checked = false;
  cbDec.fire("change");
  await sleep(10);
  eq(calls.filter(c => c.key === "PATCH /api/models/mA").length, 1, "пустые роли не уходят");
  eq(cbDec.checked, true, "чекбокс decision возвращён");
  await sleep(10); // дождаться полла
});

test("manager: поле контекста у sglang — рендер, предупреждение >32768, PATCH", async () => {
  installDom(); await resetState(); domToolbar();
  const manager = await import("../static/manager.js");
  state.models = [
    { key: "mA", label: "Qwen A", short_label: "A", type: "sglang", api: "decisions",
      managed: true, status: "stopped", enabled: true, port: 30001, hf_id: "o/a",
      peak_gb: 17, download_gb: 15, fit: "ok", roles: ["decision"], context_length: null },
    { key: "mC", label: "Clef", short_label: "C", type: "clef", api: "systemone",
      managed: true, status: "stopped", enabled: true, port: 30003, hf_id: "o/c",
      peak_gb: 9, download_gb: 6, fit: "ok", roles: ["decision"] },
  ];
  state.device = { ram_gb: 64, budget_gb: 41.6 };
  state.pageMode = "models";
  // PATCH «применяется» к state.models — перерендер показывает новое значение
  const calls = mockFetch({
    "PATCH /api/models/mA": (call) => {
      Object.assign(state.models[0], call.body);
      return { key: "mA" };
    },
    "GET /api/models": () => modelsResp(state.models),
  });
  manager.initManager({});
  const cards = [...document.querySelectorAll("#page-models .mgr-card")];
  const sglangCard = cards.find(c => c.querySelector(".mgr-context-input"));
  assert(sglangCard, "карточка sglang-модели с полем контекста");
  const input = sglangCard.querySelector(".mgr-context-input");
  eq(input.placeholder, "32768", "дефолт в placeholder");
  eq(input.value, "", "пусто = дефолт");
  includes(sglangCard.textContent, "Контекст (токенов)", "подпись поля");
  const warn = sglangCard.querySelector(".mgr-context-warn");
  assert(warn.classList.contains("hidden"), "предупреждение скрыто по умолчанию");
  input.value = "65536";
  input.fire("input");
  assert(!warn.classList.contains("hidden"), "предупреждение при >32768");
  input.fire("change");
  await sleep(10);
  const patch = calls.find(c => c.key === "PATCH /api/models/mA");
  assert(patch, "PATCH контекста отправлен");
  eq(patch.body.context_length, 65536, "значение из поля");
  // очистка поля → null (дефолт раннера); карточка перерендерена — перечитываем
  const input2 = document.querySelector("#page-models .mgr-context-input");
  input2.value = "";
  input2.fire("change");
  await sleep(10);
  const patch2 = calls.filter(c => c.key === "PATCH /api/models/mA").pop();
  assert(patch2.body && "context_length" in patch2.body && patch2.body.context_length === null,
    "очистка шлёт null");
  // у clef-модели поля контекста нет
  const clefCard = [...document.querySelectorAll("#page-models .mgr-card")]
    .find(c => c.textContent.includes("Clef"));
  assert(!clefCard.querySelector(".mgr-context-input"), "у clef поля контекста нет");
  await sleep(10); // дождаться полла
});

// ---------------------------------------------------------------- remote chat API

test("manager: форма добавления — chat API: дефолтный base_url, обязательный api_model", async () => {
  installDom(); await resetState(); domToolbar();
  const manager = await import("../static/manager.js");
  setupManagerWithDevice({ ram_gb: 64, budget_gb: 41.6 });
  const calls = mockFetch({
    "POST /api/models": (call) => ({ key: "remote-gpt", ...call.body }),
    "GET /api/models": modelsResp([]),
  });
  manager.initManager({});
  const apiSel = document.getElementById("model-add-api");
  const urlIn = document.getElementById("model-add-base-url");
  const modelIn = document.getElementById("model-add-name-input");
  const values = [...apiSel.querySelectorAll("option")].map(o => o.value);
  for (const v of ["openrouter", "openai", "clef", "systemone", "laya", "decisions"]) {
    assert(values.includes(v), `в селекторе есть ${v}`);
  }
  // дефолт — openrouter: base_url необязателен, api_model обязателен
  eq(apiSel.value, "openrouter", "первый API — openrouter");
  includes(urlIn.placeholder, "openrouter.ai/api/v1", "дефолтный base_url в placeholder");
  includes(modelIn.placeholder, "обязательно", "api_model обязателен для chat API");
  includes(document.getElementById("model-add-hint").textContent, "chat API", "подсказка про chat API");
  // decisions: base_url обязателен
  apiSel.value = "decisions";
  apiSel.fire("change");
  eq(urlIn.placeholder, "base_url, https://host:port", "для decisions base_url нужен");
  includes(modelIn.placeholder, "необязательно", "api_model необязателен для decisions");
  // отправка chat-модели без base_url → дефолт на бэкенде
  apiSel.value = "openai";
  apiSel.fire("change");
  document.getElementById("model-add-label").value = "GPT-4o mini";
  modelIn.value = "gpt-4o-mini";
  keyInValue().value = "sk-x";
  [...document.querySelectorAll("#page-models button")].find(b => b.textContent === "Добавить").fire("click");
  await sleep(10);
  const post = calls.find(c => c.key === "POST /api/models");
  assert(post, "POST /api/models отправлен");
  eq(post.body.api, "openai", "api из селектора");
  eq(post.body.api_model, "gpt-4o-mini", "api_model из поля");
  assert(!("base_url" in post.body), "пустой base_url не отправляется (дефолт на бэкенде)");
  eq(post.body.api_key, "sk-x", "ключ отправлен");
  await sleep(10); // дождаться полла
});

function keyInValue() {
  return [...document.querySelectorAll("#page-models input")].find(i => i.type === "password");
}

test("manager: карточка chat-remote — бейдж chat:<api>, роли прогоны+ассистент", async () => {
  installDom(); await resetState(); domToolbar();
  const manager = await import("../static/manager.js");
  state.models = [
    { key: "rG", label: "GPT cloud", short_label: "G", type: "remote", api: "openai",
      managed: false, status: "running", enabled: true,
      base_url: "https://api.openai.com/v1", api_model: "gpt-4o", has_credentials: true,
      roles: ["decision", "chat"] },
    { key: "rJ", label: "Jev", short_label: "J", type: "remote", api: "systemone",
      managed: false, status: "running", enabled: true,
      base_url: "https://api.typesafe.ai", has_credentials: true, roles: ["decision"] },
  ];
  state.device = { ram_gb: 64, budget_gb: 41.6 };
  state.pageMode = "models";
  mockFetch({ "GET /api/models": modelsResp(state.models) });
  manager.initManager({});
  const page = document.getElementById("page-models");
  includes(page.textContent, "chat: openai", "бейдж chat API");
  includes(page.textContent, "/v1/systemone", "бейдж протокола у Jev");
  await sleep(10); // дождаться полла
});

// ---------------------------------------------------------------- карточка «Память»

function setupManagerWithDevice(device) {
  state.models = [];
  state.device = device;
  state.pageMode = "models";
}

test("manager: карточка «Память» — текущие значения, слайдер, предупреждение", async () => {
  installDom(); await resetState(); domToolbar();
  const manager = await import("../static/manager.js");
  setupManagerWithDevice({ ram_gb: 64, budget_gb: 41.6 });
  manager.initManager({});
  const card = document.getElementById("memory-card");
  assert(card, "карточка «Память» отрисована на странице моделей");
  assert(card.classList.contains("card"), "карточка в общем стиле .card");
  includes(card.textContent, "Память", "заголовок карточки");
  includes(document.getElementById("memory-current").textContent,
    "Бюджет моделей: 42 ГБ из 64 ГБ RAM (65%)", "текущие значения бюджета");
  const slider = document.getElementById("budget-slider");
  eq(slider.min, "0.3", "минимум слайдера");
  eq(slider.max, "0.95", "максимум слайдера");
  eq(slider.step, "0.05", "шаг слайдера");
  eq(slider.value, "0.65", "слайдер на текущей доле");
  eq(document.getElementById("budget-value").textContent, "65%", "числовое отображение");
  includes(card.textContent, "страх и риск", "предупреждение о свопе");
  assert(document.getElementById("btn-budget-apply"), "кнопка «Применить»");
  assert(document.getElementById("btn-budget-reset"), "кнопка «Сбросить»");
});

test("manager: «Применить»/«Сбросить» бюджет — PUT с долей, device обновляется", async () => {
  installDom(); await resetState(); domToolbar();
  const manager = await import("../static/manager.js");
  setupManagerWithDevice({ ram_gb: 64, budget_gb: 41.6 });
  let appliedGb = 41.6;
  const calls = mockFetch({
    "PUT /api/settings/budget": (call) => {
      appliedGb = call.body.fraction === 0.65 ? 41.6 : 51.2;
      return { budget_fraction: call.body.fraction, budget_gb: appliedGb, total_ram_gb: 64 };
    },
    "GET /api/models": () => ({ models: [], device: { ram_gb: 64, budget_gb: appliedGb } }),
  });
  manager.initManager({});
  const slider = document.getElementById("budget-slider");
  slider.value = "0.8";
  slider.fire("input");
  eq(document.getElementById("budget-value").textContent, "80%", "значение следует за слайдером");
  document.getElementById("btn-budget-apply").fire("click");
  await sleep(10);
  const put = calls.find(c => c.key === "PUT /api/settings/budget");
  assert(put, "PUT /api/settings/budget отправлен");
  eq(put.body.fraction, 0.8, "тело PUT — доля из слайдера");
  eq(state.device.budget_gb, 51.2, "device обновлён после применения");
  includes(document.getElementById("memory-current").textContent,
    "Бюджет моделей: 51 ГБ из 64 ГБ RAM (80%)", "строка бюджета перерендерена");
  // «Сбросить» выставляет 0.65 и шлёт PUT
  document.getElementById("btn-budget-reset").fire("click");
  await sleep(10);
  const putR = calls.filter(c => c.key === "PUT /api/settings/budget").pop();
  eq(putR.body.fraction, 0.65, "тело PUT — дефолтная доля");
  eq(document.getElementById("budget-slider").value, "0.65", "слайдер на 65% после перерендера");
  includes(document.getElementById("memory-current").textContent, "(65%)", "строка обновлена на 65%");
  await sleep(10); // дождаться полла
});

test("manager: ошибка 422 при применении бюджета — баннер с текстом", async () => {
  installDom(); await resetState(); domToolbar();
  const errBanner = el("div", { id: "error-banner", className: "hidden" });
  el("span", { id: "error-banner-text", className: "banner-text", parent: errBanner });
  const manager = await import("../static/manager.js");
  setupManagerWithDevice({ ram_gb: 64, budget_gb: 41.6 });
  mockFetch({
    "PUT /api/settings/budget": { __status: 422, detail: "Доля бюджета моделей должна быть в диапазоне 0.3–0.95" },
    "GET /api/models": { models: [], device: { ram_gb: 64, budget_gb: 41.6 } },
  });
  manager.initManager({ showError: (m) => {
    document.getElementById("error-banner-text").textContent = m;
    document.getElementById("error-banner").classList.remove("hidden");
  } });
  document.getElementById("btn-budget-apply").fire("click");
  await sleep(10);
  assert(!errBanner.classList.contains("hidden"), "баннер ошибки показан");
  includes(document.getElementById("error-banner-text").textContent, "422", "статус в тексте");
  includes(document.getElementById("error-banner-text").textContent, "диапазоне", "текст 422 в баннере");
  await sleep(10); // дождаться полла
});
