// Доменные тесты: assistant. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, notIncludes, installDom, resetState, mockFetch, sleep, domApp, ansYesNo, runRes, state, results, questions, context, presetsMod, assistant,
} from "./harness.mjs";
import { readFileSync, existsSync } from "node:fs";
import { URL as NodeURL } from "node:url";  // глобальный URL подменён DOM-моком

// ================================================================ assistant

test("assistant: селектор chat-моделей — ☁ у облачной, stopped disabled, выбрана первая running", async () => {
  installDom(); await resetState(); domApp();
  state.models = [
    { key: "mA", status: "running" },
    { key: "mB", status: "stopped" },
    { key: "rG", status: "running", type: "remote" },
  ];
  mockAssistantFetch({
    chatModels: [
      { key: "mA", label: "Model A" },
      { key: "mB", label: "Model B" },
      { key: "rG", label: "GPT cloud", remote: true },
    ],
  });
  assistant.initAssistant();
  await sleep(10);
  const sel = document.getElementById("assistant-model");
  eq(sel.children.length, 3, "три опции");
  assert(!sel.children[0].disabled, "running доступна");
  assert(sel.children[1].disabled, "stopped disabled");
  includes(sel.children[1].textContent, "не запущена", "пометка у stopped");
  eq(sel.value, "mA", "выбрана первая запущенная");
  includes(sel.children[2].textContent, "☁", "пометка облака");
  assert(!sel.children[2].disabled, "облачная running доступна");
  // запрос уходит с выбранной облачной моделью, ответ — в ленту
  sel.value = "rG";
  sel.fire("change");
  const calls = mockAssistantFetch({
    chatModels: [{ key: "rG", label: "GPT cloud", remote: true }],
    chatEvents: [{ type: "token", text: "Ответ облака" }, { type: "done" }],
  });
  await assistantSay("привет");
  const body = assistantChatCalls(calls)[0].body;
  eq(body.model_key, "rG", "запрос ушёл с облачной моделью");
  includes(feedAnswerHtml(), "Ответ облака", "ответ отрисован в ленте");
});

// SSE-тело одним чанком (mockFetch умеет только json).
function sseBody(events) {
  const text = events.map(e => "data: " + JSON.stringify(e) + "\n\n").join("");
  const encoded = new TextEncoder().encode(text);
  let sent = false;
  return {
    getReader: () => ({
      read: async () => sent
        ? { done: true }
        : (sent = true, { done: false, value: encoded }),
    }),
  };
}

// Мок fetch для ассистента: GET /api/assistant/models + SSE POST /api/assistant/chat.
function mockAssistantFetch({ chatModels = [], chatEvents = [], chatError = null } = {}) {
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    const method = options.method || "GET";
    calls.push({ key: `${method} ${path}`, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/assistant/models") {
      return { ok: true, status: 200, json: async () => ({ models: chatModels }) };
    }
    if (path === "/api/assistant/chat") {
      if (chatError) {
        return { ok: false, status: chatError.status, json: async () => ({ detail: chatError.detail }) };
      }
      return { ok: true, status: 200, json: async () => ({}), body: sseBody(chatEvents) };
    }
    return { ok: false, status: 404, json: async () => ({ detail: "no mock" }) };
  };
  return calls;
}

function assistantChatCalls(calls) {
  return calls.filter(c => c.key === "POST /api/assistant/chat");
}

// Сообщение от пользователя через UI: текст в textarea, клик по кнопке
// отправки (собственный чат-UI, обычный DOM).
async function assistantSay(text) {
  const ta = document.getElementById("assistant-input");
  ta.value = text;
  ta.fire("input");
  document.getElementById("assistant-send").fire("click");
  await sleep(30);
}

// Лента сообщений и её содержимое. Текст markdown-ответов живёт в innerHTML
// (.assistant-md) — мок не парсит html, поэтому ответы проверяем по innerHTML.
function feed() {
  return document.getElementById("assistant-messages");
}
function feedText() {
  return feed().textContent;
}
function feedAnswerHtml() {
  return [...feed().querySelectorAll(".assistant-md")].map(n => n.innerHTML).join("\n");
}

test("assistant: панель — открытие/закрытие, welcome виден до сообщения и после сброса", async () => {
  installDom(); await resetState(); domApp();
  state.models = [{ key: "mA", status: "running" }];
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [{ type: "token", text: "Ответ" }, { type: "done" }],
  });
  assistant.initAssistant();
  await sleep(10);
  const panel = document.getElementById("assistant-panel");
  assert(panel.classList.contains("hidden"), "изначально скрыта");
  document.getElementById("tb-assistant").fire("click");
  assert(!panel.classList.contains("hidden"), "открыта кнопкой");
  document.getElementById("tb-assistant").fire("click");
  assert(panel.classList.contains("hidden"), "закрыта повторным кликом");
  document.getElementById("tb-assistant").fire("click");
  document.getElementById("assistant-close").fire("click");
  assert(panel.classList.contains("hidden"), "закрыта крестиком");
  // welcome-подсказка
  const intro = feed().querySelector(".assistant-intro");
  assert(intro, "welcome в разметке ленты");
  assert(!intro.classList.contains("hidden"), "welcome виден при пустом чате");
  await assistantSay("привет");
  assert(intro.classList.contains("hidden"), "welcome скрыт после первого сообщения");
  document.getElementById("assistant-reset").fire("click");
  assert(!intro.classList.contains("hidden"), "welcome возвращается после «Сброс»");
});

test("assistant: чат — SSE-стрим в ленту (token/thinking/tool/done), тело запроса, история, сброс", async () => {
  installDom(); await resetState(); domApp();
  context.initContext({});
  context.setContent("текст контекста", "text");
  state.models = [{ key: "mA", status: "running", label: "Model A" }];
  state.selectedModels = new Set(["mA"]);
  const calls = mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [
      { type: "thinking", text: "думаю" },
      { type: "tool", name: "get_state", status: "start" },
      { type: "tool", name: "get_state", status: "done" },
      { type: "token", text: "Привет" },
      { type: "token", text: "!" },
      { type: "done" },
    ],
  });
  assistant.initAssistant();
  await sleep(10);
  document.getElementById("assistant-thinking").checked = true;
  await assistantSay("первый вопрос");
  // пузырь пользователя и ответ ассистента — узлы в ленте
  const userBubble = feed().querySelector(".assistant-msg.user .assistant-bubble");
  assert(userBubble, "пузырь пользователя в ленте");
  eq(userBubble.textContent, "первый вопрос");
  const answer = feed().querySelector(".assistant-msg.ai .assistant-md");
  assert(answer, "ответ ассистента в ленте");
  includes(answer.innerHTML, "Привет!", "токены собраны в ответ");
  // tool-строка и сворачиваемое рассуждение — тоже узлы ленты
  const note = feed().querySelector(".assistant-note");
  assert(note, "tool-строка в ленте");
  includes(note.textContent, "инструмент get_state: готово", "строка обновлена по done");
  const thinking = feed().querySelector(".assistant-thinking");
  assert(thinking, "блок рассуждения в ленте");
  includes(thinking.textContent, "думаю", "текст рассуждения");
  eq(thinking.tagName, "DETAILS", "сворачиваемый блок");
  // индикатор «печатает» снят после ответа
  assert(!feed().querySelector(".assistant-typing"), "typing-индикатор убран");
  const chat1 = assistantChatCalls(calls);
  eq(chat1.length, 1, "один запрос chat");
  eq(chat1[0].body.model_key, "mA");
  eq(chat1[0].body.message, "первый вопрос");
  eq(chat1[0].body.thinking, true, "thinking из чекбокса");
  eq(chat1[0].body.history.length, 0, "история пуста");
  eq(chat1[0].body.snapshot.page, "single");
  eq(chat1[0].body.snapshot.context.text, "текст контекста");
  eq(chat1[0].body.snapshot.selectedModels.join(","), "mA");
  // второе сообщение — история накапливается
  await assistantSay("второй");
  const body2 = assistantChatCalls(calls)[1].body;
  eq(JSON.stringify(body2.history), JSON.stringify([
    { role: "user", content: "первый вопрос" },
    { role: "assistant", content: "Привет!" },
  ]), "история из первого раунда");
  // сброс истории: чистит ленту (кроме welcome-подсказки) и history
  document.getElementById("assistant-reset").fire("click");
  assert(!feed().querySelector(".assistant-msg"), "лента очищена");
  await assistantSay("третий");
  eq(assistantChatCalls(calls)[2].body.history.length, 0, "история сброшена");
});

test("assistant: ошибки стрима — 409 до стрима, ошибка после токенов, обрыв без done", async () => {
  // 409 до стрима — красная строка в ленте
  installDom(); await resetState(); domApp();
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatError: { status: 409, detail: "Модель не запущена" },
  });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("привет");
  const err1 = feed().querySelector(".assistant-error");
  assert(err1, "error-строка в ленте");
  includes(err1.textContent, "Модель не запущена", "detail из 409");
  // ошибка после токенов — частичный ответ остаётся + красная строка
  installDom(); await resetState(); domApp();
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [
      { type: "token", text: "Начало ответа" },
      { type: "error", message: "модель упала" },
    ],
  });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("привет");
  const answer = feed().querySelector(".assistant-msg.ai .assistant-md");
  assert(answer, "частичный ответ в ленте");
  includes(answer.innerHTML, "Начало ответа");
  const err2 = feed().querySelector(".assistant-error");
  assert(err2, "error-строка в ленте");
  includes(err2.textContent, "модель упала");
  // обрыв стрима без done — пометка «соединение прервано»
  installDom(); await resetState(); domApp();
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [{ type: "token", text: "часть ответа" }],
  });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("привет");
  includes(feedAnswerHtml(), "часть ответа", "токены до обрыва в ленте");
  const note = feed().querySelector(".assistant-note");
  assert(note, "строка-заметка в ленте");
  includes(note.textContent, "соединение прервано", "пометка об обрыве");
});

test("assistant: без выбранной модели — error в ленте, запрос не уходит", async () => {
  installDom(); await resetState(); domApp();
  const calls = mockAssistantFetch({ chatModels: [] });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("привет");
  const err = feed().querySelector(".assistant-error");
  assert(err, "error-строка в ленте");
  includes(err.textContent, "Выберите chat-модель", "причина в тексте");
  eq(assistantChatCalls(calls).length, 0, "POST /chat не вызывался");
});

test("assistant: СТОП во время стрима — кнопка-стоп абортит fetch, «остановлено пользователем»", async () => {
  installDom(); await resetState(); domApp();
  state.models = [{ key: "mA", status: "running" }];
  let seenSignal = null;
  globalThis.fetch = async (path, options = {}) => {
    if (path === "/api/assistant/models") {
      return { ok: true, status: 200, json: async () => ({ models: [{ key: "mA", label: "Model A" }] }) };
    }
    if (path === "/api/assistant/chat") {
      seenSignal = options.signal;
      // стрим «висит»: read резолвится только абортом — как реальный fetch
      return { ok: true, status: 200, json: async () => ({}), body: {
        getReader: () => ({
          read: () => new Promise((_, rej) => {
            options.signal.addEventListener("abort", () => {
              const e = new Error("The operation was aborted");
              e.name = "AbortError";
              rej(e);
            });
          }),
          cancel: async () => {},
        }),
      } };
    }
    return { ok: false, status: 404, json: async () => ({ detail: "no mock" }) };
  };
  assistant.initAssistant();
  await sleep(10);
  const btn = document.getElementById("assistant-send");
  const ta = document.getElementById("assistant-input");
  ta.value = "привет";
  ta.fire("input");
  btn.fire("click");  // sendMessage не возвращает управление до конца стрима
  await sleep(10);
  assert(seenSignal, "fetch ушёл с AbortSignal");
  assert(btn.classList.contains("is-stop"), "кнопка в режиме СТОП на всё время запроса");
  assert(!btn.disabled, "стоп доступен");
  assert(feed().querySelector(".assistant-typing"), "индикатор «печатает» в ленте");
  btn.fire("click");  // клик по СТОП
  await sleep(20);
  eq(seenSignal.aborted, true, "запрос абортнут");
  assert(!btn.classList.contains("is-stop"), "кнопка вернулась в режим отправки");
  assert(!feed().querySelector(".assistant-error"), "ручная отмена — не ошибка");
  assert(!feed().querySelector(".assistant-typing"), "typing-индикатор снят");
  const note = feed().querySelector(".assistant-note");
  assert(note, "строка-заметка в ленте");
  includes(note.textContent, "остановлено пользователем", "пометка ручной отмены");
  notIncludes(note.textContent, "соединение прервано", "пометка обрыва только для нештатного разрыва");
});

test("assistant: СТОП доступен в фазе инструментов (до первого токена)", async () => {
  installDom(); await resetState(); domApp();
  state.models = [{ key: "mA", status: "running" }];
  let seenSignal = null;
  globalThis.fetch = async (path, options = {}) => {
    if (path === "/api/assistant/models") {
      return { ok: true, status: 200, json: async () => ({ models: [{ key: "mA", label: "Model A" }] }) };
    }
    if (path === "/api/assistant/chat") {
      seenSignal = options.signal;
      // прислали tool start и «зависли» — фаза исполнения инструмента
      const first = new TextEncoder().encode(
        'data: {"type":"tool","name":"get_state","status":"start"}\n\n');
      let sent = false;
      return { ok: true, status: 200, json: async () => ({}), body: {
        getReader: () => ({
          read: async () => {
            if (!sent) { sent = true; return { done: false, value: first }; }
            return new Promise((_, rej) => {
              options.signal.addEventListener("abort", () => {
                const e = new Error("The operation was aborted");
                e.name = "AbortError";
                rej(e);
              });
            });
          },
          cancel: async () => {},
        }),
      } };
    }
    return { ok: false, status: 404, json: async () => ({ detail: "no mock" }) };
  };
  assistant.initAssistant();
  await sleep(10);
  const btn = document.getElementById("assistant-send");
  const ta = document.getElementById("assistant-input");
  ta.value = "привет";
  ta.fire("input");
  btn.fire("click");
  await sleep(10);
  includes(feedText(), "вызывает инструмент: get_state", "tool-строка появилась");
  assert(btn.classList.contains("is-stop"), "СТОП виден в фазе инструмента");
  btn.fire("click");
  await sleep(20);
  eq(seenSignal.aborted, true, "запрос абортнут в фазе инструмента");
  includes(feedText(), "остановлено пользователем", "пометка ручной отмены");
});

test("assistant: proposal propose_questions — авто-применение сразу, undo по «Отменить»", async () => {
  installDom(); await resetState(); domApp();
  state.models = [{ key: "mA", status: "running" }];
  questions.setQuestions([{ question: "Старый?", type: "yes_no" }]);
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [
      { type: "proposal", proposal: { id: "p1", kind: "propose_questions", title: "Новые вопросы",
        payload: { mode: "replace", questions: [
          { question: "Есть опыт?", type: "yes_no", description_yes: "опыт есть", description_no: "опыта нет" },
          { question: "Стек?", type: "choice", options: ["Python", "Go"] },
          { question: "Оценка?", type: "score", levels: ["плохо", "хорошо"], direction: "up" },
        ] } } },
      { type: "token", text: "Вот вопросы" },
      { type: "done" },
    ],
  });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("предложи вопросы");
  await sleep(10);
  // авто-применение: вопросы уже заменены без нажатия кнопок
  eq(state.questions.length, 3, "вопросы заменены автоматически");
  eq(state.questions[0].yes, "опыт есть", "description_yes → yes");
  eq(state.questions[0].no, "опыта нет", "description_no → no");
  eq(state.questions[1].options.map(o => o.name).join(","), "Python,Go", "options-строки → объекты");
  eq(state.questions[2].direction, "up", "direction сохранён");
  eq(document.getElementById("questions-list").children.length, 3, "редактор вопросов перерендерен");
  // карточка-запись со статусом и кнопкой «Отменить» — в ленте чата
  const card = document.getElementById("assistant-chat").querySelector(".assistant-proposal");
  assert(card, "карточка в ленте чата");
  includes(card.textContent, "Новые вопросы", "заголовок карточки");
  includes(card.textContent, "Есть опыт?", "предпросмотр вопроса");
  includes(card.textContent, "Применено", "статус «Применено»");
  const undoBtn = card.querySelector(".assistant-undo");
  assert(undoBtn, "кнопка «Отменить» есть");
  assert(!card.querySelector(".assistant-apply"), "режима «Применить» больше нет");
  undoBtn.fire("click");
  eq(state.questions.length, 1, "undo вернул прежние вопросы");
  eq(state.questions[0].question, "Старый?", "прежний вопрос на месте");
  includes(card.textContent, "Отменено", "статус «Отменено»");
  assert(!card.querySelector(".assistant-undo"), "кнопка undo скрыта после отката");
});

test("assistant: proposal append вопросов и replace контекста — авто-применение и undo", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  // append вопросов
  questions.setQuestions([{ question: "Старый?", type: "yes_no" }]);
  await assistant.handleProposal({ kind: "propose_questions", payload: {
    mode: "append",
    questions: [{ question: "Новый?", type: "yes_no" }],
  } });
  eq(state.questions.map(q => q.question).join("|"), "Старый?|Новый?", "вопрос добавлен");
  const card = document.getElementById("assistant-chat").querySelector(".assistant-proposal");
  assert(card, "карточка в ленте чата");
  card.querySelector(".assistant-undo").fire("click");
  eq(state.questions.map(q => q.question).join("|"), "Старый?", "append откачен");
  includes(card.textContent, "Отменено", "статус «Отменено» на карточке");
  // replace контекста
  context.initContext({});
  context.setContent("старый контекст", "text");
  await assistant.handleProposal({ kind: "propose_context",
    title: "Новый контекст", payload: { mode: "replace", text: "новый текст" } });
  eq(document.getElementById("context-input").value, "новый текст", "контекст заменён сразу");
  const card2 = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  includes(card2.textContent, "Применено", "статус «Применено»");
  card2.querySelector(".assistant-undo").fire("click");
  eq(document.getElementById("context-input").value, "старый контекст", "undo вернул текст");
  includes(card2.textContent, "Отменено", "статус «Отменено»");
});

test("assistant: propose_run — авто-клик по tb-run, карточка без undo; при недоступном Run — «Не применено»", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  context.initContext({});
  context.setContent("не трогаем", "text");
  const runBtn = document.getElementById("tb-run");
  // Run недоступен — карточка «Не применено», состояние не тронуто, undo нет
  runBtn.disabled = true;
  await assistant.handleProposal({ kind: "propose_run", payload: { scope: "single" } });
  const cardErr = document.getElementById("assistant-chat").querySelector(".assistant-proposal");
  assert(cardErr, "карточка в ленте чата");
  includes(cardErr.textContent, "Не применено", "статус ошибки");
  includes(cardErr.textContent, "недоступен", "текст ошибки в карточке");
  assert(!cardErr.querySelector(".assistant-undo"), "у ошибки нет undo");
  // Run доступен — авто-клик, карточка «Применено» без undo
  runBtn.disabled = false;
  globalThis.__clicks = [];
  await assistant.handleProposal({ kind: "propose_run", payload: { scope: "single" } });
  assert(globalThis.__clicks.includes(runBtn), "клик по tb-run");
  const card = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  includes(card.textContent, "Применено", "прогон запущен");
  assert(!card.querySelector(".assistant-undo"), "undo для запуска не предлагается");
});

test("assistant: propose_save_preset открывает диалог с предзаполненными полями", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  await assistant.handleProposal({ kind: "propose_save_preset",
    payload: { name: "Мой пресет", description: "от ассистента" } });
  eq(document.getElementById("preset-dlg-name").value, "Мой пресет", "имя предзаполнено");
  eq(document.getElementById("preset-dlg-desc").value, "от ассистента", "описание предзаполнено");
  const card = document.getElementById("assistant-chat").querySelector(".assistant-proposal");
  assert(card, "карточка в ленте чата");
  includes(card.textContent, "Применено", "статус «Применено»");
  presetsMod.closeDialog();
});

test("assistant: parseSseChunk — чистый разбор SSE-блока, мусор пропускается", async () => {
  const evs = assistant.parseSseChunk(
    'data: {"type":"token","text":"а"}\n' +
    'data: {битый json}\n' +
    ': комментарий\n' +
    'data: {"type":"done"}\n');
  eq(evs.length, 2, "два валидных события");
  eq(evs[0].text, "а");
  eq(evs[1].type, "done");
});

test("assistant: ресайз — drag меняет ширину с clamp 320–720 и сохраняет в localStorage", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  const panel = document.getElementById("assistant-panel");
  const handle = document.getElementById("assistant-resize");
  handle.fire("mousedown", { clientX: 1000 });
  document.dispatchEvent({ type: "mousemove", clientX: 900 });  // +100 к дефолтным 380
  eq(panel.style.width, "480px", "ширина по drag");
  document.dispatchEvent({ type: "mouseup" });
  eq(localStorage.getItem("dq-assistant-width"), "480", "ширина сохранена");
  // clamp сверху
  handle.fire("mousedown", { clientX: 900 });
  document.dispatchEvent({ type: "mousemove", clientX: -500 });
  eq(panel.style.width, "720px", "максимум 720");
  document.dispatchEvent({ type: "mouseup" });
  // clamp снизу
  handle.fire("mousedown", { clientX: 0 });
  document.dispatchEvent({ type: "mousemove", clientX: 5000 });
  eq(panel.style.width, "320px", "минимум 320");
  document.dispatchEvent({ type: "mouseup" });
  // сохранённая ширина восстанавливается при init
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  localStorage.setItem("dq-assistant-width", "500");
  assistant.initAssistant();
  await sleep(10);
  eq(document.getElementById("assistant-panel").style.width, "500px", "ширина из localStorage");
});

test("assistant: событие trial — таблица «Пробный прогон» в панели, UI не мутируется", async () => {
  installDom(); await resetState(); domApp();
  state.models = [{ key: "mA", status: "running" }];
  questions.setQuestions([{ question: "Старый?", type: "yes_no" }]);
  const before = JSON.stringify(state.questions);
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [
      { type: "tool", name: "run_trial", status: "start" },
      { type: "trial", trial: {
        questions: [{ id: "q1", question: "Есть опыт?", type: "yes_no" }],
        models: ["mA", "mB"],
        rows: [
          { model: "mA", label: "Model A", answers: { q1: "да 80%" } },
          { model: "mB", label: "Model B", error: "сервер недоступен" },
        ],
        note: "Изображения контекста (1) не участвовали.",
      } },
      { type: "tool", name: "run_trial", status: "done" },
      { type: "token", text: "Прогнал." },
      { type: "done" },
    ],
  });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("проверь гипотезу");
  includes(feedAnswerHtml(), "Прогнал.", "ответ отрисован в ленте");
  const card = document.querySelector("#assistant-chat .assistant-trial");
  assert(card, "карточка пробного прогона появилась в ленте чата");
  includes(card.querySelector(".assistant-proposal-title").textContent, "Пробный прогон");
  const table = card.querySelector(".assistant-trial-table");
  assert(table, "таблица в карточке");
  includes(table.textContent, "Есть опыт?", "колонка вопроса");
  includes(table.textContent, "да 80%", "ответ модели A");
  includes(table.textContent, "сервер недоступен", "строка ошибки модели B");
  includes(card.textContent, "не участвовали", "note показан");
  eq(JSON.stringify(state.questions), before, "вопросы приложения не изменились");
});

test("assistant: resultsSummary — расхождения ответов между моделями", async () => {
  installDom(); await resetState(); domApp();
  context.initContext({});
  context.setContent("текст", "text");
  state.questions = [{ id: "q1", question: "Ок?", type: "yes_no" }];
  state.models = [
    { key: "mA", label: "Model A", status: "running" },
    { key: "mB", label: "Model B", status: "running" },
  ];
  state.results = {
    results: {
      mA: runRes({}, { q1: ansYesNo(0.9, 0.1) }),
      mB: runRes({}, { q1: ansYesNo(0.2, 0.8) }),
    },
    order: ["mA", "mB"], runMode: "decisions",
    questions: [{ id: "q1", question: "Ок?", type: "yes_no" }],
  };
  const snap = assistant.buildSnapshot();
  includes(snap.resultsSummary, "⚡ расходятся", "есть строка расхождения");
  includes(snap.resultsSummary, "да · 90%", "ответ A в расхождении");
  includes(snap.resultsSummary, "нет · 80%", "ответ B в расхождении");
  // согласные ответы — без расхождения
  state.results.results.mB = runRes({}, { q1: ansYesNo(0.7, 0.3) });
  const snap2 = assistant.buildSnapshot();
  notIncludes(snap2.resultsSummary, "⚡ расходятся", "согласие — без ⚡");
  // одна модель — сравнивать не с кем
  state.results.results = { mA: state.results.results.mA };
  state.results.order = ["mA"];
  const snap3 = assistant.buildSnapshot();
  notIncludes(snap3.resultsSummary, "⚡", "одна модель — без ⚡");
});

test("assistant: buildSnapshot — контекст, вопросы по типам, модели, файлы батча, сводка", async () => {
  installDom(); await resetState(); domApp();
  context.initContext({});
  context.setContent("контекст для снапшота", "text");
  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }];
  state.questions = [
    { id: "q1", question: "Ок?", type: "yes_no", yes: "да-опис", no: "нет-опис" },
    { id: "q2", question: "Выбор?", type: "choice", options: [{ name: "А", description: "" }, { name: "Б", description: "" }] },
    { id: "q3", question: "Оценка?", type: "score", levels: ["1", "2", "3"], direction: "down" },
  ];
  state.models = [{ key: "mA", label: "Model A", status: "running" }];
  state.selectedModels = new Set(["mA"]);
  state.batch.files = [{ name: "doc.txt", size: 12, isImage: false, images: [] }];
  state.results = {
    results: { mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }) },
    order: ["mA"], runMode: "decisions",
    questions: [{ id: "q1", question: "Ок?", type: "yes_no" }],
  };
  const snap = assistant.buildSnapshot();
  eq(snap.page, "single");
  eq(snap.context.text, "контекст для снапшота");
  eq(snap.context.imagesCount, 1);
  eq(snap.questions.length, 3, "три вопроса");
  eq(snap.questions[0].yes, "да-опис", "yes_no описания");
  eq(snap.questions[1].options.join(","), "А,Б", "choice — имена опций");
  eq(snap.questions[2].direction, "down", "score direction");
  eq(snap.questions[2].levels.join(","), "1,2,3", "score levels");
  eq(snap.selectedModels.join(","), "mA", "выбранные модели");
  eq(snap.batchFiles[0].name, "doc.txt", "файлы батча");
  includes(snap.resultsSummary, "Ок?", "сводка содержит вопрос");
  includes(snap.resultsSummary, "да · 90%", "сводка содержит ответ");
});

test("contract: панель ассистента — собственный чат-UI, deep-chat удалён", () => {
  const html = readFileSync(new NodeURL("../static/index.html", import.meta.url), "utf8");
  for (const id of ["tb-assistant", "assistant-panel", "assistant-close", "assistant-model",
    "assistant-thinking", "assistant-reset", "assistant-resize", "assistant-chat",
    "assistant-messages", "assistant-input", "assistant-send"]) {
    includes(html, `id="${id}"`, `${id} в index.html`);
  }
  includes(html, "assistant-intro", "welcome-подсказка в ленте");
  includes(html, "assistant-footer", "футерная строка контролов под полем ввода");
  notIncludes(html, "<deep-chat", "web component deep-chat удалён из разметки");
  notIncludes(html, "vendor/deep-chat", "ссылок на vendor/deep-chat нет");
  notIncludes(html, "assistant-proposals", "отдельной панели карточек нет");
  notIncludes(html, "assistant-status", "статус-строка удалена, заметки — в ленте");
  const appSrc = readFileSync(new NodeURL("../static/app.js", import.meta.url), "utf8");
  includes(appSrc, 'from "./assistant.js"', "app.js импортирует assistant.js");
  includes(appSrc, "initAssistant()", "app.js вызывает initAssistant");
  const assistantSrc = readFileSync(new NodeURL("../static/assistant.js", import.meta.url), "utf8");
  includes(assistantSrc, 'from "./vendor/remarkable.js"', "markdown — вендоренный remarkable");
  includes(assistantSrc, "AbortController", "отмена fetch по СТОП");
  includes(assistantSrc, "is-stop", "кнопка превращается в СТОП на время запроса");
  includes(assistantSrc, "assistant-note", "tool/обрыв/отмена — строки в ленте");
  includes(assistantSrc, "assistant-typing", "индикатор «печатает» в ленте");
  notIncludes(assistantSrc, "deep-chat", "assistant.js не зависит от deep-chat");
  notIncludes(assistantSrc, "shadowRoot", "shadow DOM больше не используется");
  notIncludes(assistantSrc, "htmlClassUtilities", "биндинг через htmlClassUtilities удалён");
  const css = readFileSync(new NodeURL("../static/style.css", import.meta.url), "utf8");
  for (const cls of [".assistant-panel", ".assistant-resize", ".assistant-footer",
    ".assistant-messages", ".assistant-md", ".assistant-typing", ".assistant-send",
    ".assistant-proposal", ".assistant-note"]) {
    includes(css, cls, `${cls} в style.css`);
  }
  const mdSrc = readFileSync(new NodeURL("../static/vendor/remarkable.js", import.meta.url), "utf8");
  includes(mdSrc, "export { Remarkable", "remarkable завендорен standalone");
  assert(!existsSync(new NodeURL("../static/vendor/deep-chat", import.meta.url)),
    "vendor/deep-chat удалён целиком");
});
