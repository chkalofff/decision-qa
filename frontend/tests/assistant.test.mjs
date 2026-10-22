// Доменные тесты: assistant. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, notIncludes, installDom, el, resetState, mockFetch, sleep, domApp, ansYesNo, runRes, state, emit, results, questions, context, presetsMod, assistant, preview,
} from "./harness.mjs";
import { readFileSync, existsSync } from "node:fs";
import { URL as NodeURL } from "node:url";  // глобальный URL подменён DOM-моком
import * as decision from "../static/decision.js";
import * as api from "../static/api.js";

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
// chatBody — ручное SSE-тело (stagedSseBody) для поэтапной подачи событий.
function mockAssistantFetch({ chatModels = [], chatEvents = [], chatError = null, validateError = null, chatBody = null } = {}) {
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    const method = options.method || "GET";
    calls.push({ key: `${method} ${path}`, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/assistant/models") {
      return { ok: true, status: 200, json: async () => ({ models: chatModels }) };
    }
    if (path === "/api/assistant/propose/validate") {
      if (validateError) {
        return { ok: false, status: 422, json: async () => ({ detail: validateError }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (path === "/api/assistant/trial/abort") {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (path === "/api/assistant/chat") {
      if (chatError) {
        return { ok: false, status: chatError.status, json: async () => ({ detail: chatError.detail }) };
      }
      return { ok: true, status: 200, json: async () => ({}),
               body: chatBody || sseBody(chatEvents) };
    }
    return { ok: false, status: 404, json: async () => ({ detail: "no mock" }) };
  };
  return calls;
}

// SSE-тело с поэтапной подачей: push(events) отдаёт следующий чанк читающему
// стриму (живой прогресс 4.2 — ассерты между чанками), close() завершает.
function stagedSseBody() {
  const chunks = [];
  const waiters = [];
  const deliver = (r) => (waiters.length ? waiters.shift()(r) : chunks.push(r));
  return {
    push(events) {
      const text = events.map(e => "data: " + JSON.stringify(e) + "\n\n").join("");
      deliver({ done: false, value: new TextEncoder().encode(text) });
    },
    close() { deliver({ done: true }); },
    getReader: () => ({
      read: () => chunks.length
        ? Promise.resolve(chunks.shift())
        : new Promise(res => waiters.push(res)),
      cancel: async () => {},
    }),
  };
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
  includes(note.textContent, "✓ Просмотр состояния", "строка обновлена по done");
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
  eq(chat1[0].body.snapshot.selectedModels.map(m => m.key).join(","), "mA");
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

test("assistant: страж стирает доретрайный черновик из ленты", async () => {
  // инцидент 17.10: фантомные цифры уходят стримом до срабатывания стража —
  // по событию phantom_guard/degrade_guard черновик очищается, в ленте
  // остаётся только исправленный ответ
  installDom(); await resetState(); domApp();
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [
      { type: "token", text: "Прогнал — стало 98% → 60%. " },
      { type: "tool", name: "phantom_guard", status: "done",
        message: "Заявленное действие не было выполнено — повторяю шаг" },
      { type: "token", text: "Честно: прогона не было." },
      { type: "done" },
    ],
  });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("прогони");
  const answer = feed().querySelector(".assistant-msg.ai .assistant-md");
  includes(answer.innerHTML, "Честно", "пост-ретрай ответ на месте");
  notIncludes(answer.innerHTML, "98%", "доретрайный фантом стёрт");
});

test("assistant: история аннотируется фактами показа карточек (анти-фантом v0.9)", async () => {
  // persist-история — обучающий сигнал модели: без факта показа карточек на
  // длинной истории модель нарративит карточки текстом вместо tool call
  installDom(); await resetState(); domApp();
  const calls = mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [
      { type: "proposal", proposal: { id: "p1", kind: "propose_questions",
        title: "Правка вопросов",
        payload: { mode: "replace", questions: [
          { id: "q1", question: "Новый?", type: "yes_no" }] } } },
      { type: "trial", trial: { title: "Гипотеза X", questions: [],
        models: ["mA"], rows: [] } },
      { type: "token", text: "Готово." },
      { type: "done" },
    ],
  });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("предложи правку и прогон");
  await assistantSay("следующий шаг");  // история уезжает вторым запросом
  const ai = assistantChatCalls(calls)[1].body.history
    .find(m => m.role === "assistant");
  includes(ai.content, "Готово.", "текст ответа в истории");
  includes(ai.content, "[в этом ответе предложена карточка «Правка вопросов»");
  includes(ai.content, "НЕ применена");
  includes(ai.content, "[в этом ответе показан результат пробного прогона «Гипотеза X»]");
  // в ленте аннотации нет — там сами карточки (markdown-ответы проверяем по
  // innerHTML: dom-mock не парсит html)
  const html = feedAnswerHtml();
  includes(html, "Готово.", "текст ответа в ленте");
  assert(!html.includes("в этом ответе"), "аннотаций в ленте нет");
});

test("assistant: бэкфилл аннотаций persist-истории при восстановлении (анти-фантом v0.9)", async () => {
  // Старый persist (без annV): история без аннотаций дописывается по ленте —
  // иначе на ней модель имитирует «реплику без tool call» (фантомы).
  installDom(); await resetState(); domApp();
  localStorage.setItem("dq-assistant-chat", JSON.stringify({
    version: 1,
    convos: {
      single: {
        history: [
          { role: "user", content: "предложи вопросы" },
          { role: "assistant", content: "Готово." },
          { role: "user", content: "и прогон" },
          { role: "assistant",
            content: "Прогнал.\n[в этом ответе показан результат пробного прогона «Старый»]" },
        ],
        feed: [
          { t: "user", text: "предложи вопросы" },
          { t: "proposal", status: "applied",
            proposal: { id: "p1", kind: "propose_questions", title: "Новые вопросы",
              payload: { mode: "replace",
                questions: [{ question: "Новый?", type: "yes_no" }] } } },
          { t: "assistant", text: "Готово." },
          { t: "user", text: "и прогон" },
          { t: "trial", trial: { title: "Старый", questions: [], models: ["mA"], rows: [] } },
          { t: "assistant", text: "Прогнал." },
        ],
      },
      batch: { history: [], feed: [] },
    },
  }));
  const calls = mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("что дальше?");
  const hist = assistantChatCalls(calls)[0].body.history;
  includes(hist[1].content, "Готово.", "текст ответа сохранён");
  includes(hist[1].content,
           "[в этом ответе предложена карточка «Новые вопросы»", "карточка дописана");
  includes(hist[1].content, "НЕ применена");
  // уже аннотированная запись не дублируется
  eq(hist[3].content.match(/в этом ответе/g).length, 1, "без дубля аннотации");
  // persist переписан с флагом — бэкфилл одноразовый
  const saved = JSON.parse(localStorage.getItem("dq-assistant-chat"));
  eq(saved.convos.single.annV, 1, "флаг annV выставлен");
  includes(saved.convos.single.history[1].content, "в этом ответе",
           "бэкфилл сохранён в persist");
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
  // ошибка инструмента — причина видна в строке ленты (message из SSE);
  // generic tool-строка — на примере analyze_run (у run_trial — живая карточка)
  installDom(); await resetState(); domApp();
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [
      { type: "tool", name: "analyze_run", status: "start" },
      { type: "tool", name: "analyze_run", status: "error",
        message: "Пробный прогон не уложился в 120 с." },
      { type: "token", text: "Не вышло." },
      { type: "done" },
    ],
  });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("разбери прогон");
  const errNote = feed().querySelector(".assistant-note-error");
  assert(errNote, "строка ошибки инструмента подсвечена");
  includes(errNote.textContent, "✗ Разбор прогона", "имя и статус");
  includes(errNote.textContent, "не уложился", "причина видна пользователю");
  // ошибка выполнения run_trial — живая карточка переходит в «Ошибка» (макет 4.x)
  installDom(); await resetState(); domApp();
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [
      { type: "tool", name: "run_trial", status: "start" },
      { type: "tool", name: "run_trial", status: "error",
        message: "Пробный прогон не уложился в 300 с." },
      { type: "token", text: "Не вышло." },
      { type: "done" },
    ],
  });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("прогони пробно");
  const errCard = feed().querySelector(".assistant-trial-progress");
  assert(errCard, "карточка прогресса осталась");
  assert(errCard.classList.contains("assistant-proposal-invalid"), "красная кромка ошибки");
  includes(errCard.querySelector(".assistant-proposal-status").textContent, "Ошибка");
  includes(errCard.textContent, "не уложился", "причина видна пользователю");
  assert(!errCard.querySelector(".assistant-trial-stop"), "кнопки «Прервать» нет на финале");
  assert(!feed().querySelector(".assistant-note-error"), "tool-строки run_trial больше нет");
  // internal-предпроверка (валидация, лимиты — ничего не запускалось):
  // карточка убирается из ленты, модель чинит сама (инцидент: «✗ Вопросов
  // больше 5» пугало пользователя при успешном исходе)
  installDom(); await resetState(); domApp();
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [
      { type: "tool", name: "run_trial", status: "start" },
      { type: "tool", name: "run_trial", status: "error", internal: true,
        message: "Вопросов больше 5 — выбери до 5 самых важных." },
      { type: "tool", name: "run_trial", status: "start" },
      { type: "tool", name: "run_trial", status: "done" },
      { type: "token", text: "Повторил с пятью." },
      { type: "done" },
    ],
  });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("прогони пробно");
  const cards = [...feed().querySelectorAll(".assistant-trial-progress")];
  eq(cards.length, 1, "карточка internal-предпроверки убрана, финальная — одна");
  assert(!cards[0].classList.contains("assistant-proposal-invalid"), "без ошибки");
  includes(cards[0].textContent, "Выполнен", "успешный повтор — терминал «Выполнен»");
  assert(!feedText().includes("Вопросов больше 5"), "причины предпроверки нет");
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

test("assistant: квитанции A4 — бикон несёт event_id/post-state/ревизию; двойной клик и undo — одна квитанция на исход", async () => {
  installDom(); await resetState(); domApp();
  const calls = mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([
    { id: "q1", question: "Есть товар?", type: "yes_no" },
    { id: "q2", question: "Спам?", type: "yes_no" },
  ]);
  const beacons = () => calls.filter(c => c.key === "POST /api/assistant/event")
    .map(c => c.body);

  // accept: applied с event_id (idempotency-key), post-state сводкой и ревизией
  await assistant.handleProposal({ id: "pA", kind: "propose_questions", title: "Правка", payload: {
    mode: "append", questions: [{ id: "q3", question: "Новый?", type: "yes_no" }] } });
  const card = [...document.querySelectorAll(".assistant-proposal")].pop();
  const accept = card.querySelector(".assistant-accept");
  accept.fire("click");
  accept.fire("click");  // двойной клик — no-op (гард _applied)
  await sleep(10);
  eq(state.questions.length, 3, "применено один раз");
  eq(beacons().length, 1, "одна квитанция на двойной клик");
  const b = beacons()[0];
  eq(b.event_id, "pA:applied", "idempotency-key = proposal:outcome");
  eq(b.outcome, "applied");
  eq(b.title, "Правка", "заголовок карточки в квитанции");
  eq(b.post_state, "вопросов: 3", "post-state сводка считается в момент применения");
  assert(typeof b.revision === "string" && b.revision.length > 0, "ревизия состояния");
  assert(b.session_id, "session-id на месте");

  // undo: отдельный исход с ревизией ПОСЛЕ отката
  card.querySelector(".assistant-undo").fire("click");
  await sleep(10);
  eq(state.questions.length, 2, "откат применился");
  eq(beacons().length, 2, "квитанция undo — отдельным событием");
  eq(beacons()[1].event_id, "pA:undone");
  eq(beacons()[1].post_state, "вопросов: 2", "post-state после отката");
  assert(beacons()[1].revision !== b.revision, "ревизия отката отличается");

  // decline: без post-state (состояние не менялось), ревизия текущая
  await assistant.handleProposal({ id: "pB", kind: "propose_decision", title: "Правила", payload: {
    outcomes: [{ label: "X", rules: [] }, { label: "Y", isDefault: true }] } });
  const card2 = [...document.querySelectorAll(".assistant-proposal")].pop();
  card2.querySelector(".assistant-decline").fire("click");
  await sleep(10);
  const d = beacons().pop();
  eq(d.event_id, "pB:declined");
  assert(!("post_state" in d), "у declined нет post-state");
  assert(d.revision, "ревизия есть и у declined");
});

test("assistant: флаги хода A4 — prev_aborted после СТОП и external_change после storage-event", async () => {
  installDom(); await resetState(); domApp();
  state.models = [{ key: "mA", status: "running" }];
  // storage-слушатель: dom-mock window.addEventListener — noop, перехватываем
  let storageHandler = null;
  globalThis.window.addEventListener = (ev, fn) => {
    if (ev === "storage") storageHandler = fn;
  };
  const bodies = [];
  let hanging = true;  // первый ответ — висячий стрим (под СТОП)
  globalThis.fetch = async (path, options = {}) => {
    if (path === "/api/assistant/models") {
      return { ok: true, status: 200, json: async () => ({ models: [{ key: "mA", label: "Model A" }] }) };
    }
    if (path === "/api/assistant/chat") {
      bodies.push(JSON.parse(options.body));
      if (hanging) {
        return { ok: true, status: 200, json: async () => ({}), body: {
          getReader: () => ({
            read: () => new Promise((_, rej) => {
              options.signal.addEventListener("abort", () => {
                const e = new Error("aborted"); e.name = "AbortError"; rej(e);
              });
            }),
            cancel: async () => {},
          }),
        } };
      }
      return { ok: true, status: 200, json: async () => ({}),
               body: sseBody([{ type: "token", text: "ок" }, { type: "done" }]) };
    }
    return { ok: false, status: 404, json: async () => ({ detail: "no mock" }) };
  };
  assistant.initAssistant();
  await sleep(10);
  // флаш-ход: флаги модульные, могли остаться от прошлого теста — сбрасываем
  // отправкой (их перенос между ходами и есть предмет теста)
  hanging = false;
  await assistantSay("сброс");
  await sleep(20);
  // ход под СТОП: сам флагов не несёт (после флаша)
  hanging = true;
  await assistantSay("привет");
  await sleep(5);
  document.getElementById("assistant-send").fire("click");  // СТОП
  await sleep(20);
  eq(bodies[1].prev_aborted, false, "прерванный ход сам флага не несёт");
  eq(bodies[1].external_change, false);
  // следующий ход: несёт prev_aborted; storage-event (правка в другой
  // вкладке) — external_change
  hanging = false;
  storageHandler({ key: "dq-workspace" });
  storageHandler({ key: "dq-assistant-chat" });  // чужой ключ — не флаг
  await assistantSay("продолжим");
  await sleep(20);
  eq(bodies[2].prev_aborted, true, "флаг «прошлый ответ прерван» доехал");
  eq(bodies[2].external_change, true, "флаг «менялось в другой вкладке» доехал");
  // ход 4: флаги сброшены отправкой
  await assistantSay("ещё");
  await sleep(20);
  eq(bodies[3].prev_aborted, false, "флаг не повторяется");
  eq(bodies[3].external_change, false);
});

test("assistant: stateRevision — вектор соответствия бэкенду (receipts.py)", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  // то же состояние, что SNAP в backend/tests/test_receipts.py
  questions.setQuestions([
    { id: "q1", question: "Ок?", type: "yes_no" },
    { id: "q2", question: "Балл?", type: "score", levels: ["п", "о"] },
  ]);
  decision.setDecision({ outcomes: [
    { label: "Брак", rules: [{ conditions: [
      { question: "q1", op: "gte", answer: "yes", threshold: 0.8 } ] }] },
    { label: "Ок", isDefault: true, rules: [] },
  ] });
  context.setContent("материал", "text");
  state.batch.files = [{ id: "f1", name: "a.txt", size: 3, text: "abc",
                         status: "ok", images: [] }];
  eq(assistant.stateRevision(assistant.buildSnapshot()), "n97pje",
     "ревизия сходится с revision_of_snapshot (канонизация единая)");
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
  includes(feedText(), "🔧 Просмотр состояния…", "tool-строка появилась");
  assert(btn.classList.contains("is-stop"), "СТОП виден в фазе инструмента");
  btn.fire("click");
  await sleep(20);
  eq(seenSignal.aborted, true, "запрос абортнут в фазе инструмента");
  includes(feedText(), "остановлено пользователем", "пометка ручной отмены");
});

test("assistant: proposal propose_questions — pending: diff-превью, «Принять» применяет, undo; «Отклонить» не трогает", async () => {
  installDom(); await resetState(); domApp();
  state.models = [{ key: "mA", status: "running" }];
  questions.setQuestions([{ question: "Старый?", type: "yes_no" }]);
  const calls = mockAssistantFetch({
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
  // pending: вопросы НЕ изменены, карточка ждёт подтверждения
  eq(state.questions.length, 1, "до «Принять» вопросы не тронуты");
  const card = document.getElementById("assistant-chat").querySelector(".assistant-proposal");
  assert(card, "карточка в ленте чата");
  includes(card.textContent, "Новые вопросы", "заголовок карточки");
  includes(card.textContent, "Ждёт решения", "статус pending");
  const accept = card.querySelector(".assistant-accept");
  const decline = card.querySelector(".assistant-decline");
  assert(accept && decline, "кнопки «Принять»/«Отклонить»");
  // diff-превью: выравнивание по содержимому (LCS) — «Старый?» не совпал ни с
  // одним новым: строка удаления + три добавления, без ложного «изменения»
  const del = card.querySelector(".diff-del");
  assert(del, "строка удаления в превью");
  includes(del.textContent, "Старый?", "в ней старый текст");
  const adds = card.querySelectorAll(".diff-add");
  eq(adds.length, 3, "три строки добавления (все новые вопросы)");
  includes(adds[0].textContent, "Есть опыт?", "первый добавлен");
  includes(adds[1].textContent, "Стек?", "второй добавлен");
  includes(adds[2].textContent, "Оценка?", "третий добавлен");
  // «Принять» → применение
  accept.fire("click");
  await sleep(10);
  eq(state.questions.length, 3, "вопросы заменены после «Принять»");
  eq(state.questions[0].yes, "опыт есть", "description_yes → yes");
  eq(state.questions[0].no, "опыта нет", "description_no → no");
  eq(state.questions[1].options.map(o => o.name).join(","), "Python,Go", "options-строки → объекты");
  eq(state.questions[2].direction, "up", "direction сохранён");
  eq(document.getElementById("questions-list").children.length, 3, "редактор вопросов перерендерен");
  includes(card.textContent, "Применена", "статус «Применена»");
  assert(!card.querySelector(".assistant-accept"), "кнопки подтверждения убраны");
  // бикон исходов карточек (v0.8): applied → undone → declined
  const beacons = () => calls.filter(c => c.key === "POST /api/assistant/event").map(c => c.body);
  eq(beacons().length, 1, "бикон applied ушёл");
  eq(beacons()[0].outcome, "applied", "исход applied");
  eq(beacons()[0].kind, "propose_questions", "kind карточки");
  eq(beacons()[0].proposal_id, "p1", "id предложения");
  const undoBtn = card.querySelector(".assistant-undo");
  assert(undoBtn, "кнопка «Отменить» есть");
  undoBtn.fire("click");
  eq(state.questions.length, 1, "undo вернул прежние вопросы");
  eq(state.questions[0].question, "Старый?", "прежний вопрос на месте");
  includes(card.textContent, "Отменено", "статус «Отменено»");
  assert(!card.querySelector(".assistant-undo"), "кнопка undo скрыта после отката");
  eq(beacons().length, 2, "бикон undone ушёл");
  eq(beacons()[1].outcome, "undone", "исход undone");
  // «Отклонить» — состояние не меняется
  await assistant.handleProposal({ kind: "propose_questions", payload: {
    mode: "replace", questions: [{ question: "Другой?", type: "yes_no" }] } });
  const card2 = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  card2.querySelector(".assistant-decline").fire("click");
  eq(state.questions.length, 1, "после «Отклонить» вопросы не тронуты");
  includes(card2.textContent, "Отклонена", "статус «Отклонена»");
  assert(!card2.querySelector(".assistant-accept"), "кнопки убраны после отказа");
  eq(beacons().length, 3, "бикон declined ушёл");
  eq(beacons()[2].outcome, "declined", "исход declined");
});

test("assistant: session_id вкладки (v1.2) — стабилен, уходит в chat-body и event-payload", async () => {
  installDom(); await resetState(); domApp();
  state.models = [{ key: "mA", status: "running" }];
  // фаза 1: getAssistantSessionId — генерация и стабильность в рамках вкладки
  const id1 = api.getAssistantSessionId();
  assert(typeof id1 === "string" && id1.length > 0, "id сгенерирован");
  eq(api.getAssistantSessionId(), id1, "стабилен при повторных вызовах");
  eq(sessionStorage.getItem("assistant_session_id"), id1, "хранится в sessionStorage вкладки");
  // фаза 2: session_id в body чата и в payload бикона карточки
  const calls = mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [{ type: "token", text: "Ответ" }, { type: "done" }],
  });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("привет");
  eq(assistantChatCalls(calls)[0].body.session_id, id1, "session_id в chat-body");
  await api.assistantEvent({ kind: "propose_decision", outcome: "applied" });
  const ev = calls.find(c => c.key === "POST /api/assistant/event");
  eq(ev.body.session_id, id1, "session_id в event-payload");
  eq(ev.body.kind, "propose_decision", "исходные поля payload сохранены");
});

test("assistant: persist чата (v0.8) — лента и история переживают перезагрузку, терминальные карточки схлопнуты", async () => {
  installDom(); await resetState(); domApp();
  const calls = mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [
      { type: "proposal", proposal: { id: "pp1", kind: "propose_questions", title: "Новые вопросы",
        payload: { mode: "replace", questions: [{ question: "Новый?", type: "yes_no" }] } } },
      { type: "token", text: "Готово" },
      { type: "done" },
    ],
  });
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ question: "Старый?", type: "yes_no" }]);
  await assistantSay("предложи вопросы");
  await sleep(10);
  const card = document.getElementById("assistant-chat").querySelector(".assistant-proposal");
  card.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  const saved = localStorage.getItem("dq-assistant-chat");
  assert(saved, "persist записан");
  const parsed = JSON.parse(saved);
  eq(parsed.version, 1, "версия persist");
  eq(parsed.convos.single.feed.map(i => i.t).join(","), "user,proposal,assistant",
     "порядок записей ленты");
  eq(parsed.convos.single.feed[1].status, "applied", "статус карточки в persist");
  assert(parsed.convos.single.history.length >= 2, "история в persist");

  // перезагрузка: новый DOM, persist на месте → лента восстанавливается
  installDom(); await resetState(); domApp();
  localStorage.setItem("dq-assistant-chat", saved);
  const calls2 = mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  assistant.initAssistant();
  await sleep(10);
  const msgs = feed();
  includes(msgs.querySelector(".assistant-msg.user .assistant-bubble").textContent,
           "предложи вопросы", "сообщение пользователя восстановлено");
  includes(msgs.querySelector(".assistant-msg.ai .assistant-md").innerHTML,
           "Готово", "ответ ассистента восстановлен");
  const restored = msgs.querySelector(".assistant-proposal");
  assert(restored, "карточка восстановлена");
  const termRow = restored.querySelector(".assistant-term-row");
  assert(termRow, "терминальная карточка схлопнута строкой-итогом");
  includes(termRow.textContent, "Применена", "пилла «Применена» в строке-итоге");
  assert(termRow.querySelector(".assistant-proposal-status.applied"),
    "пилла applied в терминальной строке");
  assert(!restored.querySelector(".assistant-undo"), "undo после перезагрузки не предлагаем");
  assert(!restored.querySelector(".assistant-accept"), "кнопок подтверждения нет");
  // штамп восстановления (макет 1.9, .rst): время из ts записи ленты (pushFeed)
  assert(parsed.convos.single.feed[1].ts > 0, "ts записи в persist");
  const rst = termRow.querySelector(".assistant-rst");
  assert(rst, "штамп «↩ восстановлена» у терминала из persist");
  includes(rst.textContent, "↩ восстановлена · от", "текст штампа");
  // история уходит в следующий запрос
  await assistantSay("а что дальше?");
  await sleep(20);
  const hist = assistantChatCalls(calls2)[0].body.history;
  eq(hist.map(m => m.role).join(","), "user,assistant", "история восстановлена");
  includes(hist[0].content, "предложи вопросы", "в истории реплика пользователя");
  // «Сброс» чистит и persist
  assistant.resetHistory();
  eq(JSON.parse(localStorage.getItem("dq-assistant-chat")).convos.single.feed.length, 0,
     "persist очищен сбросом");
});

test("assistant: persist — pending карточка: протухание при смене состояния, без повторной превалидации", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Старый?", type: "yes_no" }]);
  await assistant.handleProposal({ id: "px", kind: "propose_questions", title: "Правка вопросов",
    payload: { mode: "replace", questions: [{ question: "Новый?", type: "yes_no" }] } });
  const saved = localStorage.getItem("dq-assistant-chat");

  // Фаза 1: состояние при восстановлении другое → карточка «Устарела»
  installDom(); await resetState(); domApp();
  localStorage.setItem("dq-assistant-chat", saved);
  const calls = mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  questions.setQuestions([{ id: "q1", question: "Другой набор?", type: "yes_no" }]);
  assistant.initAssistant();
  await sleep(10);
  const stale = feed().querySelector(".assistant-proposal");
  assert(stale.classList.contains("assistant-proposal-stale"), "класс протухшей");
  includes(stale.textContent, "Устарела", "пилла протухшей");
  // кнопок выбора у протухшей нет вообще (концепция «Рамс») — только петля
  // восстановления
  assert(!stale.querySelector(".assistant-accept"), "принять отсутствует");
  assert(!stale.querySelector(".assistant-decline"), "отклонить отсутствует");
  assert(!calls.some(c => c.key === "POST /api/assistant/propose/validate"),
         "превалидация при восстановлении не повторяется");
  // «Попросить перевыпустить» — warn-ghost действие на протухшей карточке
  // (v1.2, концепция «Рамс»): та же дорожка, что у markProposalStale в живой
  // сессии
  const reissue = stale.querySelector(".assistant-reissue");
  assert(reissue, "кнопка перевыпуска на карточке из persist");
  includes(reissue.textContent, "Попросить перевыпустить", "текст кнопки");
  // штамп восстановления рядом с пиллой (макет 1.9, .rst)
  const rst1 = stale.querySelector(".assistant-rst");
  assert(rst1, "штамп у протухшей из persist");
  includes(rst1.textContent, "↩ восстановлена · от", "текст штампа");
  reissue.fire("click");
  await sleep(30);
  const reissueCalls = calls.filter(c => c.key === "POST /api/assistant/chat");
  eq(reissueCalls.length, 1, "запрос перевыпуска ушёл");
  includes(reissueCalls[0].body.message, "устарела", "текст системной реплики");

  // Фаза 2: состояние то же → карточка активна
  installDom(); await resetState(); domApp();
  localStorage.setItem("dq-assistant-chat", saved);
  mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  questions.setQuestions([{ id: "q1", question: "Старый?", type: "yes_no" }]);
  assistant.initAssistant();
  await sleep(10);
  const active = feed().querySelector(".assistant-proposal");
  assert(!active.classList.contains("assistant-proposal-stale"), "не протухла");
  assert(!active.querySelector(".assistant-accept").disabled, "принять доступно");
  includes(active.textContent, "Ждёт решения", "статус pending");
  // штамп следует за пиллой: единственная pending развёрнута — штамп в верхнем ряду
  const rst2 = active.querySelector(".assistant-proposal-top .assistant-rst");
  assert(rst2, "штамп у активной восстановленной (за пиллой в верхнем ряду)");
});

test("assistant: persist — pending карточка из прошлой версии (позиционная адресация) инвалидируется", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Ок?", type: "yes_no" }]);
  // в persist — карточка до A3: условие правила по № вместо id; применять её
  // нельзя (№ сдвигаются) — честная инвалидация с кнопкой перевыпуска
  localStorage.setItem("dq-assistant-chat", JSON.stringify({
    version: 1,
    convos: {
      single: { annV: 1, history: [], feed: [
        { t: "proposal", status: "pending", proposal: { id: "old1",
          kind: "propose_decision", title: "Правила решения",
          payload: { outcomes: [
            { label: "X", rules: [{ conditions: [
              { question: 1, answer: "yes", op: "gte", threshold: 80 } ] }] },
            { label: "Y", isDefault: true, rules: [] } ] } } } ] },
      batch: { history: [], feed: [] },
    },
  }));
  assistant.initAssistant();  // restoreChat перечитывает persist
  await sleep(10);
  const card = feed().querySelector(".assistant-proposal");
  assert(card.classList.contains("assistant-proposal-stale"), "legacy-карточка протухла");
  includes(card.textContent, "прошлой версии", "причина — формат до A3");
  assert(!card.querySelector(".assistant-accept"), "кнопок выбора у протухшей нет");
  assert(card.querySelector(".assistant-reissue"), "кнопка перевыпуска");
  assert(!card.querySelector(".assistant-rst"), "у записей без ts (старый persist) штампа нет");
});

test("assistant: persist — бюджет: fullAnswers срезаются, старейшие записи вытесняются", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  // тяжёлые fullAnswers — срезаются первыми
  assistant.handleTrial({ title: "тяжёлый", questions: [{ id: "q1", question: "Ок?" }],
    rows: [{ model: "mA", label: "A",
             fullAnswers: { q1: { label: "да", text: "x".repeat(2_000_000) } } }] });
  let raw = localStorage.getItem("dq-assistant-chat");
  assert(raw, "persist записан");
  assert(raw.length <= 1_600_000, "после срезки fullAnswers — в бюджете");
  assert(!raw.includes("fullAnswers"), "fullAnswers срезаны");
  // серия объёмных записей без fullAnswers — старейшие вытесняются
  for (let i = 0; i < 40; i++) {
    assistant.handleTrial({ title: "t" + i, note: "n".repeat(60_000), rows: [] });
  }
  raw = localStorage.getItem("dq-assistant-chat");
  assert(raw.length <= 1_600_000, "после вытеснения — в бюджете");
  const feedItems = JSON.parse(raw).convos.single.feed;
  assert(feedItems.length >= 20, "минимум последних записей сохранён");
  assert(feedItems.length < 41, "старейшие вытеснены");
  eq(feedItems[feedItems.length - 1].trial.title, "t39", "последняя запись на месте");
});

test("assistant: proposal append вопросов и replace контекста — pending, «Принять» применяет, undo", async () => {
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
  eq(state.questions.map(q => q.question).join("|"), "Старый?", "pending: вопрос не добавлен");
  const card = document.getElementById("assistant-chat").querySelector(".assistant-proposal");
  assert(card, "карточка в ленте чата");
  includes(card.textContent, "Добавить вопросы (1)", "заголовок превью append");
  includes(card.querySelector(".diff-add").textContent, "Новый?", "строка добавления");
  card.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  eq(state.questions.map(q => q.question).join("|"), "Старый?|Новый?", "вопрос добавлен");
  card.querySelector(".assistant-undo").fire("click");
  eq(state.questions.map(q => q.question).join("|"), "Старый?", "append откачен");
  includes(card.textContent, "Отменено", "статус «Отменено» на карточке");
  // replace контекста
  context.initContext({});
  context.setContent("старый контекст", "text");
  await assistant.handleProposal({ kind: "propose_context",
    title: "Новый контекст", payload: { mode: "replace", text: "новый текст" } });
  eq(document.getElementById("context-input").value, "старый контекст", "pending: контекст не тронут");
  const card2 = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  // построчный diff (v1.1, п. 7.5) вместо двух <details> с обрезками
  includes(card2.querySelector(".diff-del").textContent, "старый контекст", "diff: удалённая строка");
  includes(card2.querySelector(".diff-add").textContent, "новый текст", "diff: добавленная строка");
  card2.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  eq(document.getElementById("context-input").value, "новый текст", "контекст заменён");
  includes(card2.textContent, "Применена", "статус «Применена»");
  card2.querySelector(".assistant-undo").fire("click");
  eq(document.getElementById("context-input").value, "старый контекст", "undo вернул текст");
  includes(card2.textContent, "Отменено", "статус «Отменено»");
});

test("assistant: propose_context — построчный diff: неизменные свёрнуты в счётчик, append — только хвост (v1.1)", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  context.initContext({});
  context.setContent("строка 1\nстрока 2\nстрока 3", "text");
  await assistant.handleProposal({ kind: "propose_context", title: "Правка",
    payload: { mode: "replace",
               text: "строка 1\nстрока 2 изменена\nстрока 3\nстрока 4" } });
  const card = [...document.querySelectorAll(".assistant-proposal")].pop();
  const same = card.querySelectorAll(".diff-same");
  eq(same.length, 2, "две серии неизменных строк свёрнуты в счётчики");
  includes(same[0].textContent, "без изменений: 1 строка", "счётчик серии");
  includes(card.querySelector(".diff-del").textContent, "строка 2", "удалённая строка");
  const adds = [...card.querySelectorAll(".diff-add")].map(n => n.textContent);
  eq(adds.length, 2, "две добавленные строки");
  includes(adds[0], "строка 2 изменена", "изменённая строка — как add");
  includes(adds[1], "строка 4", "новая строка в конце");
  // структура макета 3.1: строки .dl с маркерами .mk и моно-шрифтом
  const rows = [...card.querySelectorAll(".assistant-proposal-preview .dl")];
  assert(rows.length >= 5, "diff — строками .dl");
  assert(rows.every(r => r.classList.contains("dl-mono")), "моно-шрифт у строк diff'а");
  assert(rows.every(r => r.querySelector(".mk")), "маркер .mk у каждой строки");
  eq(card.querySelector(".diff-del .mk").textContent, "−", "маркер удаления");
  eq([...card.querySelectorAll(".diff-add .mk")][0].textContent, "+", "маркер добавления");
  // у парной замены зачёркнут только изменённый фрагмент (.bd), не вся строка:
  // «строка 2» → «строка 2 изменена» — удалённых слов нет, добавленное — w-add
  const delRow = card.querySelector(".diff-del");
  assert(!delRow.querySelector(".bd"), "общие слова парной замены не зачёркнуты");
  assert(!delRow.querySelector(".w-add"),
    "добавленные слова в del-строке не дублируются (они в парной add-строке)");
  const addRow = [...card.querySelectorAll(".diff-add")][0];
  eq(addRow.querySelector(".w-add").textContent, "изменена", "добавленное слово выделено");
  // stats-строка развёрнутой карточки (макет 3.1): «+1 строка · замена · … симв.»
  const stats = card.querySelector(".assistant-context-stats");
  assert(stats, "stats-строка в развёрнутой карточке");
  includes(stats.textContent, "+1 строка", "чистое изменение числа строк");
  includes(stats.textContent, "замена", "режим в stats");
  includes(stats.textContent, " симв.", "размеры в символах в stats");
  // «показать в редакторе» — link-quiet в подвале развёрнутой карточки (3.1)
  const showin = card.querySelector(".assistant-showin-foot");
  assert(showin, "ссылка в подвале развёрнутой карточки");
  showin.fire("click");
  assert(document.getElementById("context-input").classList.contains("assistant-flash-target")
    || document.getElementById("context-card").classList.contains("assistant-flash-target"),
    "flash редактора контекста по клику");

  // чистое удаление строки (без пары) — вся строка зачёркнута приглушённо (.bd)
  await assistant.handleProposal({ kind: "propose_context", title: "Срезка",
    payload: { mode: "replace", text: "строка 1\nстрока 3" } });
  const cardPure = [...document.querySelectorAll(".assistant-proposal")].pop();
  const pureDel = [...cardPure.querySelectorAll(".diff-del")]
    .find(r => r.textContent.includes("строка 2"));
  eq(pureDel.querySelector(".bd").textContent, "строка 2",
    "чистое удаление — вся строка в .bd");

  // append — только добавляемый хвост, текущий текст не показывается
  await assistant.handleProposal({ kind: "propose_context", title: "Добавка",
    payload: { mode: "append", text: "хвост 1\nхвост 2" } });
  const card2 = [...document.querySelectorAll(".assistant-proposal")].pop();
  includes(card2.textContent, "Добавить к материалу:", "заголовок append");
  eq(card2.querySelectorAll(".diff-add").length, 2, "две строки хвоста");
  eq(card2.querySelectorAll(".diff-del").length, 0, "удалений в append нет");
  eq(card2.querySelectorAll(".diff-same").length, 0, "счётчиков в append нет");
  notIncludes(card2.textContent, "строка 1", "текущий текст не дублируется");
  includes(card2.querySelector(".assistant-context-stats").textContent,
    "+2 строки · дописка", "stats append: число строк и режим");
});

test("assistant: propose_decision — pending, превью условий; «Принять»: id насквозь, %→0..1, undo; висячая ссылка — серверная 422", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([
    { id: "q1", question: "Есть товар?", type: "yes_no" },
    { id: "q2", question: "Качество?", type: "score", levels: ["плохо", "ок", "хорошо"] },
  ]);
  await assistant.handleProposal({ kind: "propose_decision", title: "Правила решения", payload: {
    outcomes: [
      { label: "Опубликовать", color: "green", rules: [
        { anyOf: false, conditions: [
          { question: "q1", answer: "yes", op: "gte", threshold: 90 },
          { question: "q2", op: "gte", score: 1 } ] } ] },
      { label: "На модерацию", color: "yellow", isDefault: true, rules: [] },
    ] } });
  eq(state.decision, null, "pending: правила не применены");
  const card = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  includes(card.textContent, "Правила решения", "заголовок карточки");
  // превью — таблица условий «исход · условие | было | станет» (макет 2.1)
  const rt = card.querySelector("table.rt");
  assert(rt, "таблица условий rt");
  includes(rt.querySelector("th").textContent, "исход · условие", "шапка таблицы");
  includes(card.textContent, "Опубликовать", "превью исхода");
  includes(card.textContent, "новый исход", "пометка нового исхода (действующих правил нет)");
  includes(card.textContent, "по умолчанию", "пометка default в превью");
  includes(card.textContent, "№1 «Есть товар?» P(да) ≥ 90%", "условие в формате превью — id → № и текст вопроса");
  includes(card.textContent, "№2 «Качество?» балл ≥ 1", "score-условие в превью — с текстом вопроса");
  const newCells = card.querySelectorAll(".rt-new");
  eq(newCells.length, 2, "оба условия нового исхода — в колонке «станет»");
  eq(newCells[0].textContent, "№1 «Есть товар?» P(да) ≥ 90%", "текст ячейки «станет»");
  // «Принять» → применение: id проходят насквозь (без трансляции), % → 0..1
  card.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  const d = state.decision;
  eq(d.outcomes.length, 2, "исходы применены");
  const [c1, c2] = d.outcomes[0].rules[0].conditions;
  eq(c1.question, "q1", "id первого вопроса — как в payload");
  eq(c1.threshold, 0.9, "90% → 0.9");
  eq(c2.question, "q2", "id второго вопроса — как в payload");
  eq(c2.score, 1, "score-условие без answer");
  eq(d.outcomes[1].isDefault, true, "default сохранён");
  card.querySelector(".assistant-undo").fire("click");
  eq(state.decision.outcomes.length, 0, "undo очистил правила");
  // терминальный статус — карточка схлопнута в строку-итог, разворот по клику
  const termRow = card.querySelector(".assistant-term-row");
  assert(termRow, "строка-итог есть");
  includes(termRow.textContent, "Отменено", "пилла «Отменено» в строке-итоге");
  assert(card.classList.contains("assistant-proposal-terminal"), "класс терминальной строки");
  assert(card.querySelector(".assistant-proposal-preview").classList.contains("hidden"),
    "превью скрыто при схлопывании");
  termRow.fire("click");
  assert(!card.querySelector(".assistant-proposal-preview").classList.contains("hidden"),
    "клик разворачивает карточку");
  eq(card.querySelector(".assistant-proposal-title").textContent, "Правила решения",
    "заголовок карточки не тронут схлопыванием");
  // ссылка на несуществующий id → серверная превалидация (единый базис A3)
  // помечает карточку сразу (до клика «Принять»), state не тронут
  decision.setDecision({ outcomes: [
    { label: "Старое", color: "gray", isDefault: true, rules: [] } ] });
  mockAssistantFetch({ validateError:
    "propose_decision: исход «X», правило 1, условие 1 (вопрос «q9»): "
    + "вопроса «q9» нет (удалён или никогда не существовал) — актуальные id: q1, q2" });
  await assistant.handleProposal({ kind: "propose_decision", payload: {
    outcomes: [{ label: "X", rules: [{ conditions: [
      { question: "q9", answer: "yes", op: "gte", threshold: 50 } ] }] }] } });
  const bad = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  await sleep(10);
  includes(bad.textContent, "Такую правку применить нельзя", "битая карточка помечена при показе");
  includes(bad.textContent, "вопроса «q9» нет", "текст про висячий id с сервера");
  assert(!bad.querySelector(".assistant-proposal-actions"), "ряд кнопок убран у битой карточки");
  eq(state.decision.outcomes[0].label, "Старое", "прежние правила не тронуты");
});

test("assistant: правила тем же ходом после карточки вопросов — превалидация против виртуального набора по id (P0)", async () => {
  // инцидент 17.10: модель предлагает вопросы (замена набора) и правила под
  // новый набор одним ходом; карточка правил не должна помечаться невалидной
  // из-за ссылки на id, которого нет в СТАРОМ наборе
  const questionsCard = () => assistant.handleProposal({
    kind: "propose_questions", title: "Набор вопросов", payload: {
      mode: "replace", questions: [
        { id: "a1", question: "Первый?", type: "yes_no" },
        { id: "a2", question: "Второй?", type: "yes_no" } ] } });
  const decisionCard = () => assistant.handleProposal({
    kind: "propose_decision", title: "Правила решения", payload: {
      outcomes: [
        { label: "Плохо", color: "red", rules: [
          { conditions: [ { question: "a2", answer: "no", op: "gte", threshold: 60 } ] } ] },
        { label: "Ок", color: "green", isDefault: true, rules: [] } ] } });
  const twoCards = () => [...document.getElementById("assistant-chat")
    .querySelectorAll(".assistant-proposal")];

  // фаза 1: превалидация против виртуального набора; применение по порядку
  installDom(); await resetState(); domApp();
  const calls = mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Дубль?", type: "yes_no" }]);
  await questionsCard();
  await decisionCard();
  await sleep(10);
  const [qCard, dCard] = twoCards();
  assert(!dCard.classList.contains("assistant-proposal-invalid"),
    "карточка правил не помечена невалидной — база превалидации новый набор");
  // серверная превалидация получила виртуальный набор (a1/a2), а не state (A3)
  const vcall = calls.filter(c => c.key === "POST /api/assistant/propose/validate").pop();
  eq(vcall.body.snapshot.questions.map(q => q.id).join(","), "a1,a2",
     "превалидация правил — против виртуального набора хода");
  qCard.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  dCard.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  eq(state.decision.outcomes[0].label, "Плохо", "правила применены после вопросов");
  eq(state.decision.outcomes[0].rules[0].conditions[0].question, "a2",
     "id нового вопроса — насквозь, без трансляции");

  // фаза 2: вопросы отклонены → правила под новый набор не применяются
  // (apply-time проверка против фактического состояния)
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Дубль?", type: "yes_no" }]);
  await questionsCard();
  await decisionCard();
  await sleep(10);
  const [q2Card, d2Card] = twoCards();
  assert(!d2Card.classList.contains("assistant-proposal-invalid"),
    "и здесь карточка правил валидна при показе");
  q2Card.querySelector(".assistant-decline").fire("click");
  await sleep(10);
  d2Card.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  includes(d2Card.textContent, "Не применено",
           "после отклонения вопросов правила не применяются");
  eq(state.decision, null, "правила не применены");
});

test("assistant: propose_decision — дельта на размеченных: измерена / нет разметки / stale", async () => {
  installDom(); await resetState(); domApp();
  const calls = mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Есть жалоба?", type: "yes_no" }]);
  decision.setDecision({ outcomes: [
    { label: "Эскалация", color: "red", rules: [{ anyOf: false, conditions: [
      { question: "q1", answer: "yes", op: "gte", threshold: 0.5 } ] }] },
    { label: "В архив", color: "gray", isDefault: true, rules: [] },
  ] });
  const proposal = () => assistant.handleProposal({ kind: "propose_decision",
    title: "Понизить порог", payload: { outcomes: [
      { label: "Эскалация", color: "red", rules: [{ conditions: [
        { question: "q1", answer: "yes", op: "gte", threshold: 30 } ] }] },
      { label: "В архив", isDefault: true } ] } });
  const lastCard = () => [...document.getElementById("assistant-chat")
    .querySelectorAll(".assistant-proposal")].pop();

  // Фаза 1: нет разметки — честное «эффект не измерен», eyebrow без суффикса
  await proposal();
  let card = lastCard();
  includes(card.textContent, "Эффект не измерен", "нет разметки — без ложной точности");
  eq(card.querySelector(".assistant-proposal-eye").textContent,
    "Предложение · правила решения", "без дельты eyebrow без суффикса");
  assert(!card.querySelector(".assistant-accept").disabled, "принять доступно");

  // «другой порог…» (макет 2.1): карточка отклоняется, заготовка подставляется
  // в поле ввода и НЕ отправляется
  const alt = card.querySelector(".assistant-alt-threshold");
  assert(alt, "третье действие «другой порог…» в подвале");
  alt.fire("click");
  await sleep(10);
  eq(document.getElementById("assistant-input").value,
    "Предложи другой порог для правил решения: ", "заготовка в поле ввода");
  eq(assistantChatCalls(calls).length, 0, "ничего не отправлено автоматически");
  includes(card.textContent, "Отклонена", "карточка отклонена тем же действием");

  // Фаза 2: есть прогон и ✗-пометка исхода — дельта посчитана (порог 30%
  // переключит 40%-ячейку «В архив»→«Эскалация» = исправлено); вторая пометка
  // (✓ на верном исходе, исход не сдвинулся) — в итоге «без изменений»
  state.models = [{ key: "mA", label: "Qwen A", short_label: "QA", status: "running" },
                  { key: "mB", label: "Qwen B", short_label: "QB", status: "running" }];
  state.results = {
    results: { mA: runRes({}, { q1: ansYesNo(0.4, 0.6) }),
               mB: runRes({}, { q1: ansYesNo(0.8, 0.2) }) },
    order: ["mA", "mB"], runMode: "decisions",
    questions: state.questions, decision: state.decision,
    marks: [{ id: "m1", target: { scope: "single", model: "mA", mode: "decisions", decision: true },
      verdict: "reject", comment: "" },
      { id: "m2", target: { scope: "single", model: "mB", mode: "decisions", decision: true },
      verdict: "accept", comment: "" }],
  };
  await proposal();
  card = lastCard();
  includes(card.textContent, "Размеченных исходов: 2 — ошибок 1 → 0", "дельта в карточке");
  includes(card.textContent, "исправлено 1", "исправлено");
  includes(card.textContent, "новых ошибок 0", "новых ошибок");
  includes(card.textContent, "погрешность", "предупреждение о малой выборке");
  // eyebrow с суффиксом — дельта измерена на свежей разметке (макет 2.1)
  eq(card.querySelector(".assistant-proposal-eye").textContent,
    "Предложение · правила решения · проверено на разметке", "суффикс eyebrow при дельте");
  // disclosure «какие ячейки» (макет 2.1а): ✓ у исправленной, телепорт к ячейке,
  // итог по совпавшим ячейкам
  const row = card.querySelector(".assistant-delta-cells .assistant-delta-row");
  assert(row, "строка изменённой ячейки");
  eq(row.querySelector(".mk").textContent, "✓", "маркер исправленной ячейки");
  assert(row.querySelector(".mk").classList.contains("mk-ok"), "маркер цветом ok");
  const link = row.querySelector(".assistant-delta-cell");
  includes(link.textContent, "«В архив» → «Эскалация»", "строка изменённой ячейки");
  includes(link.textContent, "прогон QA", "модель в строке-телепорте");
  const same = card.querySelector(".assistant-delta-cells .dl-same");
  assert(same, "итог по совпавшим ячейкам");
  includes(same.textContent, "ещё 1 ячейка без изменений — метки совпадают", "текст итога");

  // Фаза 3: stale-разметка — дельта запрещена, «Принять» заблокирован,
  // eyebrow без суффикса; ссылка «что разметить →» (макет 2.7)
  state.resultsStale = true;
  await proposal();
  card = lastCard();
  includes(card.textContent, "старой редакции", "stale-объяснение");
  assert(card.querySelector(".assistant-accept").disabled, "принять заблокирован при stale");
  eq(card.querySelector(".assistant-proposal-eye").textContent,
    "Предложение · правила решения", "stale — eyebrow без суффикса");
  const markLink = card.querySelector(".assistant-delta-mark");
  assert(markLink, "ссылка «что разметить →» при stale");
  eq(markLink.textContent, "что разметить →", "текст ссылки");
  state.resultsStale = false;

  // Фаза 4: batch-ячейка дельты — target.file несёт id файла (конвенция
  // review.js), flink обязан показать ИМЯ и работать как ссылка (баг v1.3:
  // в «какие ячейки» пакета показывался сырой id)
  state.results = null;
  state.batch.files = [{ id: "f_abc123", name: "interview_01.txt", size: 10,
    text: "текст файла", status: "ok" }];
  state.batch.decision = state.decision;
  state.batch.results = { f_abc123: { mA: runRes({}, { q1: ansYesNo(0.4, 0.6) }) } };
  state.batch.marks = [{ id: "bm1", verdict: "reject", comment: "",
    target: { scope: "batch", file: "f_abc123", model: "mA", decision: true } }];
  await proposal();
  card = lastCard();
  const bcell = card.querySelector(".assistant-delta-cells .assistant-delta-row");
  const flink = bcell && bcell.querySelector(".assistant-flink");
  assert(flink, "flink в batch-ячейке дельты");
  eq(flink.textContent, "interview_01.txt", "flink показывает имя файла, не id");
  includes(bcell.textContent, "× QA", "модель в строке ячейки");
});

test("assistant: превалидация карточек — серверная 422 помечает до «Принять», fail-open при сети", async () => {
  installDom(); await resetState(); domApp();
  const calls = mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }],
    validateError: "propose_questions: вопрос №1 в предложении — Дубль существующего вопроса №1 «есть товар»" });
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Есть товар?", type: "yes_no" }]);
  const lastCard = () => [...document.getElementById("assistant-chat")
    .querySelectorAll(".assistant-proposal")].pop();

  // дубль существующего вопроса — единый базис валидации на сервере (A3):
  // фронт шлёт payload + облегчённый снапшот, локальной двойной проверки нет
  await assistant.handleProposal({ kind: "propose_questions", payload: {
    mode: "append", questions: [{ question: "Есть товар?", type: "yes_no" }] } });
  let card = lastCard();
  await sleep(10);
  const vcall = calls.filter(c => c.key === "POST /api/assistant/propose/validate").pop();
  eq(vcall.body.snapshot.questions.map(q => q.id).join(","), "q1",
     "превалидация шлёт облегчённый снапшот с id вопросов");
  assert(card.classList.contains("assistant-proposal-invalid"), "карточка невалидна");
  assert(card.querySelector(".assistant-proposal-status.invalid"), "пилла «Ошибка»");
  includes(card.textContent, "Такую правку применить нельзя", "статус невалидной");
  includes(card.textContent, "Дубль существующего вопроса", "причина с сервера");
  // причина — в заголовке (ink), полный текст — muted-строкой (макет 1.8, V-2)
  includes(card.querySelector(".assistant-proposal-title").textContent,
    "Такую правку применить нельзя", "причина в заголовке карточки");
  const reasonEl = card.querySelector(".assistant-proposal-reason");
  assert(reasonEl, "полная причина — muted-строкой под заголовком");
  includes(reasonEl.textContent, "Дубль существующего вопроса", "полный текст причины");
  // одна дорожка: ряд «Принять»/«Отклонить» убран — выбора у пользователя нет
  assert(!card.querySelector(".assistant-proposal-actions"), "ряд кнопок убран");
  assert(!card.querySelector(".assistant-accept"), "принять отсутствует");
  // бикон invalid (v0.8): причина уходит в журнал
  const invalidBeacon = calls.filter(c => c.key === "POST /api/assistant/event")
    .map(c => c.body).find(b => b.outcome === "invalid");
  assert(invalidBeacon, "бикон invalid ушёл");
  includes(invalidBeacon.detail, "Дубль", "в биконе причина");
  // «Сообщить ассистенту об ошибке» (v0.8): причина уходит модели системной репликой
  const reportBtn = card.querySelector(".assistant-report-invalid");
  assert(reportBtn, "кнопка на невалидной карточке");
  reportBtn.fire("click");
  await sleep(20);
  const report = assistantChatCalls(calls).pop();
  assert(report, "сообщение модели ушло");
  includes(report.body.message, "Дубль существующего вопроса", "причина в сообщении");
  includes(report.body.message, "propose_questions", "kind в сообщении");
  const sysBubble = [...document.querySelectorAll(".assistant-msg.user")].pop();
  assert(sysBubble.classList.contains("system"), "реплика помечена системной");
  assert(reportBtn.disabled, "кнопка одноразовая");
  // persist: статус invalid должен попасть в ленту, иначе после перезагрузки
  // карточка восстановится активной «ждёт подтверждения»
  const feedItem = JSON.parse(localStorage.getItem("dq-assistant-chat"))
    .convos.single.feed.find(i => i.t === "proposal");
  eq(feedItem.status, "invalid", "статус invalid в persist");
  includes(feedItem.invalidReason, "Дубль", "причина в persist");
  // «Скрыть» — схлопнуть в строку-итог с пиллой «Ошибка»
  const hideBtn = card.querySelector(".assistant-card-hide");
  assert(hideBtn, "кнопка скрыть на невалидной карточке");
  hideBtn.fire("click");
  assert(card.classList.contains("assistant-proposal-terminal"), "карточка схлопнута");
  includes(card.querySelector(".assistant-term-row").textContent, "Ошибка", "строка-итог");
  // действие «Сообщить об ошибке» не пропадает со «Скрыть» — живёт в t-row
  // (макеты 3.7/4.9); кнопка та же (уже нажата выше — disabled)
  const termActs = card.querySelector(".assistant-term-row .assistant-term-acts");
  assert(termActs.querySelector(".assistant-report-invalid"),
    "репорт-действие осталось в терминальной строке");
  // восстановление из persist: терминальная строка тоже с действием
  const savedInvalid = localStorage.getItem("dq-assistant-chat");
  installDom(); await resetState(); domApp();
  localStorage.setItem("dq-assistant-chat", savedInvalid);
  mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  assistant.initAssistant();
  await sleep(10);
  const restoredInv = [...document.getElementById("assistant-chat")
    .querySelectorAll(".assistant-proposal")].pop();
  assert(restoredInv.classList.contains("assistant-proposal-terminal"),
    "invalid восстановлена строкой-итогом");
  assert(restoredInv.querySelector(".assistant-term-row .assistant-report-invalid"),
    "действие репорта в восстановленной строке");
  // разворот восстановленной: репорт-действие возвращается в футер НА ПРЕЖНЕЕ
  // место — перед «Скрыть» (баг v1.3: appendChild сдвигал его в конец)
  restoredInv.querySelector(".assistant-term-row").fire("click");
  const invFoot = restoredInv.querySelector(".assistant-proposal-foot");
  const footBtns = [...invFoot.children].map(c => c.textContent);
  assert(footBtns.indexOf("Сообщить ассистенту об ошибке")
    < footBtns.indexOf("Скрыть"), "в развёрнутой invalid репорт раньше «Скрыть»");

  // серверная схема: 422 от /propose/validate
  installDom(); await resetState(); domApp();
  mockAssistantFetch({ validateError: "propose_decision: пустые исходы" });
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Ок?", type: "yes_no" }]);
  await assistant.handleProposal({ kind: "propose_decision", payload: {
    outcomes: [{ label: "X", rules: [] }, { label: "Y", isDefault: true }] } });
  card = lastCard();
  await sleep(10);
  assert(card.classList.contains("assistant-proposal-invalid"), "422 — невалидна");
  includes(card.textContent, "пустые исходы", "текст причины с сервера");

  // сеть недоступна на валидации — fail-open: карточка рабочая
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (path, options) => {
    if (path === "/api/assistant/propose/validate") throw new Error("network down");
    return baseFetch(path, options);
  };
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Ок?", type: "yes_no" }]);
  await assistant.handleProposal({ kind: "propose_decision", payload: {
    outcomes: [{ label: "X", rules: [] }, { label: "Y", isDefault: true }] } });
  card = lastCard();
  await sleep(10);
  assert(!card.classList.contains("assistant-proposal-invalid"), "fail-open: карточка не помечена");
  assert(!card.querySelector(".assistant-accept").disabled, "принять доступно");
});


test("assistant: buildSnapshot — decision со ссылками по id и порогами в %, решение в сводке", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([
    { id: "q1", question: "Есть товар?", type: "yes_no" },
    { id: "q2", question: "Спам?", type: "yes_no" },
  ]);
  decision.setDecision({ outcomes: [
    { label: "Опубликовать", color: "green", rules: [
      { anyOf: false, conditions: [
        { question: "q1", answer: "yes", op: "gte", threshold: 0.9 },
        { question: "q2", answer: "yes", op: "lt", threshold: 0.05 } ] } ] },
    { label: "Забанить", color: "red", isDefault: true, rules: [] } ] });
  state.models = [{ key: "mA", status: "running" }];
  state.results = {
    results: { mA: runRes({ duration_s: 1 }, {
      q1: ansYesNo(0.95, 0.05), q2: ansYesNo(0.02, 0.98) }) },
    order: ["mA"],
    questions: state.questions,
    decision: state.decision,
    images: [],
  };
  const snap = assistant.buildSnapshot();
  const outs = snap.decision.outcomes;
  eq(outs[0].label, "Опубликовать", "исход в снапшоте");
  eq(outs[0].rules[0].conditions[0].question, "q1", "ссылка по id (A3)");
  eq(outs[0].rules[0].conditions[0].threshold, 90, "порог в процентах");
  eq(outs[0].rules[0].conditions[1].op, "lt", "op сохранён");
  eq(outs[1].isDefault, true, "default в снапшоте");
  includes(snap.resultsSummary, "решение:", "строка решения в сводке");
  includes(snap.resultsSummary, "«Опубликовать»", "исход вычислен движком по ответам");
});

test("assistant: propose_run — гейт 4.1 (kv: модели/вопросы/scope, «Запустить»/«Не сейчас», заголовок из payload.title); «Запустить» кликает tb-run, терминал «Запущено», undo нет; при недоступном Run — «Не применено»", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  context.initContext({});
  context.setContent("не трогаем", "text");
  state.models = [
    { key: "mA", label: "Qwen3.5-27B", status: "running" },
    { key: "mB", label: "Bonsai2-9B", status: "stopped" },
  ];
  state.selectedModels = new Set(["mA", "mB"]);
  questions.setQuestions([
    { id: "q1", question: "Первый?", type: "yes_no" },
    { id: "q2", question: "Второй?", type: "yes_no" },
    { id: "q3", question: "Третий?", type: "yes_no" },
  ]);
  const runBtn = document.getElementById("tb-run");
  // Run недоступен — pending; после «Запустить» карточка «Не применено», состояние не тронуто
  runBtn.disabled = true;
  await assistant.handleProposal({ kind: "propose_run",
    payload: { scope: "single", title: "Гипотеза о пороге", note: "проверяем порог" } });
  const cardErr = document.getElementById("assistant-chat").querySelector(".assistant-proposal");
  assert(cardErr, "карточка в ленте чата");
  includes(cardErr.textContent, "Ждёт решения", "до подтверждения прогон не запускается");
  // заголовок — гипотеза из payload.title, а не общий «Запуск прогона»
  eq(cardErr.querySelector(".assistant-proposal-title").textContent,
     "Гипотеза о пороге", "заголовок из payload.title");
  // kv-структура макета 4.1: модели чипами со статусом, вопросы №-диапазоном, scope
  const kvs = [...cardErr.querySelectorAll(".kv")];
  eq(kvs.map(k => k.querySelector(".kv-k").textContent).join(","),
     "модели,вопросы,scope", "kv-строки гейта");
  eq([...kvs[0].querySelectorAll(".assistant-mchip")].map(c => c.textContent).join(","),
     "27B,9B", "чипы выбранных моделей");
  includes(kvs[0].querySelector(".assistant-kv-warn").textContent,
    "9B остановлена", "остановленная модель — warn-пометка");
  includes(kvs[1].textContent, "№1–№3", "диапазон вопросов");
  includes(kvs[2].textContent, "один материал", "scope одиночного — текстом");
  includes(cardErr.textContent, "проверяем порог", "note сохранён");
  // кнопки по виду карточки (макет 4.1): «Запустить»/«Не сейчас»
  eq(cardErr.querySelector(".assistant-accept").textContent, "Запустить", "solid «Запустить»");
  eq(cardErr.querySelector(".assistant-decline").textContent, "Не сейчас", "ghost «Не сейчас»");
  cardErr.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  includes(cardErr.textContent, "Не применено", "статус ошибки");
  includes(cardErr.textContent, "недоступен", "текст ошибки в карточке");
  assert(!cardErr.querySelector(".assistant-undo"), "у ошибки нет undo");
  // Run доступен — «Запустить» кликает tb-run, терминал «Применена · Запущено: …» без undo
  runBtn.disabled = false;
  globalThis.__clicks = [];
  const card = await assistant.handleProposal({ kind: "propose_run", payload: { scope: "single" } });
  assert(!globalThis.__clicks.includes(runBtn), "до «Запустить» клика не было");
  card.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  assert(globalThis.__clicks.includes(runBtn), "клик по tb-run");
  includes(card.textContent, "Применена", "прогон запущен");
  includes(card.querySelector(".assistant-term-sum").textContent,
    "Запущено: один материал · 2 модели", "терминал 4.7: факт запуска + счётчики");
  assert(!card.querySelector(".assistant-undo"), "undo для запуска не предлагается");
  // batch-scope: чип выбранного «весь пакет» (v0.9 — без выбора, спека §12)
  state.batch.files = [
    { id: "f1", name: "a.txt", size: 3, status: "ok", isImage: false, images: [], text: "а" },
    { id: "f2", name: "b.txt", size: 3, status: "ok", isImage: false, images: [], text: "б" },
  ];
  const cardB = await assistant.handleProposal({ kind: "propose_run", payload: { scope: "batch" } });
  const chip = cardB.querySelector(".assistant-scope-chip.on");
  assert(chip, "scope-чип пакета");
  eq(chip.textContent, "весь пакет", "выбран «весь пакет» (scope-выбор — v1.0)");
  eq(cardB._essenceText, "Запуск: пакет материалов · 2 файла × 2 модели",
     "essence со счётчиками (компактная строка 4.4)");
});

test("assistant: dep run←questions (макет 4.5) — «Запустить» disabled до решения правки выше; delta-note гейта при разметке", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Ок?", type: "yes_no" }]);
  const c1 = await assistant.handleProposal({ kind: "propose_questions",
    title: "Правка вопросов", payload: { mode: "append",
      questions: [{ question: "Новый?", type: "yes_no" }] } });
  const c2 = await assistant.handleProposal({ kind: "propose_run",
    payload: { scope: "single" } });
  await sleep(10);
  // вторая в очереди — компактная, dep-строка видна, «Запустить» заблокирован
  assert(c2.classList.contains("assistant-proposal-compact"), "прогон за правкой — компактный");
  assert(!c2.querySelector(".assistant-proposal-dep").classList.contains("hidden"),
    "dep-строка «сначала решите правку вопросов» видна");
  const acc = c2.querySelector(".assistant-accept");
  eq(acc.textContent, "Запустить", "текст кнопки и в компактном виде (4.4)");
  assert(acc.disabled, "«Запустить» заблокирован dep'ом");
  assert(!c2.querySelector(".assistant-delta-sub"), "без разметки delta-note нет");
  // delta-note (макет 4.1): висящая правка + разметка → заметка о сверке
  state.results = {
    results: { mA: runRes({}, { q1: ansYesNo(0.9, 0.1) }) },
    order: ["mA"], runMode: "decisions", questions: state.questions,
    marks: [{ id: "mk1", verdict: "reject", comment: "",
              target: { scope: "single", model: "mA", mode: "decisions",
                        question: "q1" } }],
  };
  const c3 = await assistant.handleProposal({ kind: "propose_run",
    payload: { scope: "single" } });
  await sleep(10);
  const note = c3.querySelector(".assistant-delta .assistant-delta-sub");
  assert(note, "delta-note при разметке и висящей правке");
  includes(note.textContent, "Дельта на 1 размеченной ячейке", "счётчик разметки");
  includes(note.textContent, "сверит", "сверка с разметкой");
  includes(c3.querySelectorAll(".kv")[1].textContent, "новая редакция",
    "пометка «новая редакция» у вопросов");
  // принятие правки снимает зависимость: «Запустить» разблокирован
  c1.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  assert(!c2.querySelector(".assistant-accept").disabled, "разблокирован после решения правки");
  assert(c2.querySelector(".assistant-proposal-dep").classList.contains("hidden"),
    "dep-строка скрыта");
});

test("assistant: dep preset←questions и context←context — «Принять» disabled до решения старшей правки", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Ок?", type: "yes_no" }]);
  // preset←questions: пресет включает набор вопросов — зависит от его правки
  const cQ = await assistant.handleProposal({ kind: "propose_questions",
    title: "Правка вопросов", payload: { mode: "append",
      questions: [{ question: "Новый?", type: "yes_no" }] } });
  const cP = await assistant.handleProposal({ kind: "propose_save_preset",
    title: "Сохранить пресет", payload: { name: "Пресет 1" } });
  await sleep(10);
  const depP = cP.querySelector(".assistant-proposal-dep");
  assert(depP && !depP.classList.contains("hidden"), "dep-строка у пресета");
  includes(depP.textContent, "Пресет сохранит набор вопросов", "текст dep пресета");
  assert(cP.querySelector(".assistant-accept").disabled,
    "«Сохранить» заблокирован dep'ом");
  // решение правки вопросов снимает зависимость пресета
  cQ.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  assert(!cP.querySelector(".assistant-accept").disabled,
    "пресет разблокирован после решения правки");
  assert(cP.querySelector(".assistant-proposal-dep").classList.contains("hidden"),
    "dep-строка пресета скрыта");
  // context←context: младшая правка того же (общего) контекста зависит от старшей
  const cC1 = await assistant.handleProposal({ kind: "propose_context",
    title: "Правка контекста", payload: { text: "v1", mode: "replace" } });
  const cC2 = await assistant.handleProposal({ kind: "propose_context",
    title: "Правка контекста 2", payload: { text: "v2", mode: "replace" } });
  await sleep(10);
  const depC = cC2.querySelector(".assistant-proposal-dep");
  assert(depC && !depC.classList.contains("hidden"),
    "dep-строка у младшей правки контекста");
  includes(depC.textContent, "того же контекста", "текст dep context←context");
  assert(cC2.querySelector(".assistant-accept").disabled,
    "«Принять» младшей правки заблокирован");
  assert(!cC1.querySelector(".assistant-accept").disabled,
    "старшая правка контекста не зависит");
});

test("assistant: invalid propose_run по остановленной модели (макет 4.11) — c-sub с переходом на странице «Модели»", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({ validateError:
    "propose_run: модели не запущены: mB (статус: stopped). Запустить их может "
    + "только пользователь на странице «Модели» — сообщи ему об этом." });
  // переход на «Модели» дёргает refreshModels → poll — отдаём живой /api/models
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (path, opts) =>
    path === "/api/models"
      ? { ok: true, status: 200, json: async () => ({ models: [] }) }
      : baseFetch(path, opts);
  assistant.initAssistant();
  await sleep(10);
  context.initContext({});
  context.setContent("материал", "text");
  const card = await assistant.handleProposal({ kind: "propose_run",
    payload: { scope: "single" } });
  await sleep(10);
  assert(card.classList.contains("assistant-proposal-invalid"), "карточка невалидна");
  includes(card.textContent, "не запущены", "причина в карточке");
  // muted-подстрока навигации: клик переключает приложение на страницу «Модели»
  const sub = card.querySelector(".assistant-invalid-sub");
  assert(sub, "c-sub навигации");
  const go = sub.querySelector(".assistant-goto-models");
  assert(go, "ссылка «на странице «Модели»»");
  eq(state.pageMode, "single", "до клика — одиночный режим");
  go.fire("click");
  eq(state.pageMode, "models", "клик переключил на страницу «Модели»");
  // прочие причины invalid прогона (не про модель) — без навигационной подстроки
  // domApp до await resetState: без баннера ошибок в DOM фоновый poll
  // моделей (живёт с app-тестов) не должен падать в showError
  installDom(); domApp(); await resetState();
  mockAssistantFetch({ validateError:
    "propose_run: scope=batch, но в пакете нет файлов — запустить нечего" });
  assistant.initAssistant();
  await sleep(10);
  const card2 = await assistant.handleProposal({ kind: "propose_run",
    payload: { scope: "batch" } });
  await sleep(10);
  assert(card2.classList.contains("assistant-proposal-invalid"), "вторая невалидна");
  assert(!card2.querySelector(".assistant-goto-models"), "без причины про модель — без ссылки");
});

test("assistant: propose_save_preset — kv-превью (макет 5.1), «Сохранить» открывает диалог, «другое имя…», undo нет", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  await assistant.handleProposal({ kind: "propose_save_preset",
    payload: { name: "Мой пресет", description: "от ассистента" } });
  assert(!document.getElementById("preset-dlg-name"), "pending: диалог не открыт");
  const card = document.getElementById("assistant-chat").querySelector(".assistant-proposal");
  assert(card, "карточка в ленте чата");
  includes(card.textContent, "Мой пресет", "имя в превью");
  // kv-структура макета 5.1: label muted + значение
  const kvs = [...card.querySelectorAll(".kv")];
  eq(kvs.length, 2, "две kv-строки: состав и описание");
  eq(kvs[0].querySelector(".kv-k").textContent, "состав", "label состава");
  includes(kvs[0].textContent, "режим «один материал»", "режим в составе");
  includes(kvs[0].textContent, "без правил", "нет правил — честно в составе");
  eq(kvs[1].querySelector(".kv-k").textContent, "описание", "label описания");
  includes(kvs[1].textContent, "«от ассистента»", "описание в кавычках");
  // главное действие карточки пресета — «Сохранить» (макет 5.1)
  const accept = card.querySelector(".assistant-accept");
  eq(accept.textContent, "Сохранить", "кнопка «Сохранить»");
  accept.fire("click");
  await sleep(10);
  eq(document.getElementById("preset-dlg-name").value, "Мой пресет", "имя предзаполнено");
  eq(document.getElementById("preset-dlg-desc").value, "от ассистента", "описание предзаполнено");
  includes(card.textContent, "Применена", "статус «Применена»");
  assert(!card.querySelector(".assistant-undo"), "undo для пресета нет");
  presetsMod.closeDialog();

  // «другое имя…» (link-quiet): отклоняет карточку и подставляет заготовку в
  // поле ввода, НЕ отправляя (макет 5.1)
  await assistant.handleProposal({ kind: "propose_save_preset",
    payload: { name: "Ещё пресет" } });
  const card2 = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  const alt = card2.querySelector(".assistant-alt-name");
  assert(alt, "ссылка «другое имя…»");
  eq(alt.textContent, "другое имя…", "текст ссылки");
  alt.fire("click");
  await sleep(10);
  eq(document.getElementById("assistant-input").value,
    "Сохрани пресет под другим именем: ", "заготовка подставлена в поле ввода");
  includes(card2.textContent, "Отклонена", "карточка отклонена по той же дорожке");
  assert(!card2.querySelector(".assistant-proposal-actions"), "ряд действий убран");
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

test("assistant: ресайз — drag меняет ширину с clamp 320–1200 и сохраняет в localStorage", async () => {
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
  eq(panel.style.width, "1200px", "максимум 1200");
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
  state.batch.files = [{ name: "doc.txt", size: 12, isImage: false, images: [], text: "текст файла" }];
  state.results = {
    results: { mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }) },
    order: ["mA"], runMode: "decisions",
    questions: [{ id: "q1", question: "Ок?", type: "yes_no" }],
  };
  const snap = assistant.buildSnapshot();
  eq(snap.page, "single");
  eq(snap.context.text, "контекст для снапшота");
  eq(snap.context.imagesCount, 1);
  assert(!snap.context.images, "не-vision модель: dataUrl не включаем");
  includes(snap.context.imagesNote, "не видит", "маркер невидимости картинок");
  eq(snap.questions.length, 3, "три вопроса");
  eq(snap.questions[0].n, 1, "порядковый номер вопроса");
  eq(snap.questions[2].n, 3, "нумерация сквозная");
  eq(snap.questions[0].id, "q1", "id вопроса в снапшоте (служебный, v0.7 — сопоставление разметки)");
  eq(snap.questions[0].yes, "да-опис", "yes_no описания");
  eq(snap.questions[1].options.join(","), "А,Б", "choice — имена опций");
  eq(snap.questions[2].direction, "down", "score direction");
  eq(snap.questions[2].levels.join(","), "1,2,3", "score levels");
  eq(snap.selectedModels.length, 1, "выбранные модели");
  eq(snap.selectedModels[0].key, "mA", "ключ выбранной модели");
  eq(snap.selectedModels[0].status, "running", "статус выбранной модели");
  eq(snap.batchFiles[0].name, "doc.txt", "файлы батча");
  eq(snap.batchFiles[0].text, "текст файла", "урезанный текст файла в снапшоте");
  includes(snap.resultsSummary, "Ок?", "сводка содержит вопрос");
  includes(snap.resultsSummary, "да · 90%", "сводка содержит ответ");
});

test("assistant: buildSnapshot — картинки (dataUrl) только для vision-модели ассистента", async () => {
  installDom(); await resetState(); domApp();
  context.initContext({});
  context.setContent("текст", "text");
  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }];
  state.models = [{ key: "mA", label: "Model A", status: "running", vision: true }];
  state.batch.files = [{ id: "f1", name: "doc.txt", size: 5, isImage: false, text: "текст файла",
    images: [{ name: "p.png", dataUrl: "data:image/png;base64,WFla" }] }];
  mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  assistant.initAssistant();
  await sleep(10);
  const snap = assistant.buildSnapshot();
  eq(snap.context.images.join(","), "data:image/png;base64,QUJD", "dataUrl контекста дошёл");
  assert(!snap.context.imagesNote, "vision — без маркера");
  eq(snap.batchFiles[0].images.join(","), "data:image/png;base64,WFla", "картинка файла дошла");
  // не-vision модель — маркер вместо dataUrl
  state.models = [{ key: "mA", label: "Model A", status: "running" }];
  const snap2 = assistant.buildSnapshot();
  assert(!snap2.context.images, "images не включены");
  includes(snap2.context.imagesNote, "не видит", "маркер невидимости картинок");
  assert(!snap2.batchFiles[0].images, "картинки файлов не включены");
});

test("assistant: buildSnapshot — выбранная-остановленная модель со статусом, ошибка прогона в сводке, batchResults", async () => {
  installDom(); await resetState(); domApp();
  state.questions = [{ id: "q1", question: "Ок?", type: "yes_no" }];
  state.models = [
    { key: "mA", label: "Model A", status: "running" },
    { key: "mB", label: "Model B", status: "stopped" },
  ];
  state.selectedModels = new Set(["mA", "mB"]);
  state.results = {
    results: {
      mA: runRes({}, { q1: ansYesNo(0.9, 0.1) }),
      mB: { ok: false, error: "модель упала" },
    },
    order: ["mA", "mB"],
    questions: state.questions,
  };
  const snap = assistant.buildSnapshot();
  const stopped = snap.selectedModels.find(m => m.key === "mB");
  eq(stopped.status, "stopped", "выбранная-остановленная в снапшоте со статусом");
  includes(snap.resultsSummary, "ОШИБКА — модель упала", "ошибка прогона в сводке");
  // batchResults — пофайловая матрица ответов (вопросы по №) + decision-лейбл
  state.batch.files = [{ id: "f1", name: "doc.txt", size: 5, isImage: false, text: "текст", images: [] }];
  state.batch.decision = { enabled: true, outcomes: [
    { id: "o1", label: "Да-исход", color: "green", rules: [{ anyOf: false, conditions: [
      { question: "q1", answer: "yes", op: "gte", threshold: 0.5 } ] }] },
  ] };
  state.batch.results = { f1: {
    mA: runRes({}, { q1: ansYesNo(0.8, 0.2) }),
    mB: { ok: false, error: "таймаут" },
  } };
  const snap2 = assistant.buildSnapshot();
  const cell = snap2.batchResults["doc.txt"].mA;
  eq(cell.answers[1], "да · 80%", "ответ по № вопроса");
  eq(cell.decision, "Да-исход", "decision-лейбл по включённому решению");
  eq(snap2.batchResults["doc.txt"].mB.error, "таймаут", "ошибка модели в матрице");
});

test("assistant: trial с decision — колонка «Решение» (движок на фронте), маркер ≠ к прогону пользователя", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  state.models = [{ key: "mA", label: "Model A", status: "running" }];
  // прогон пользователя с тем же текстом вопроса — база для маркеров отличий
  state.results = {
    results: { mA: runRes({}, { uq1: ansYesNo(0.9, 0.1) }) },
    order: ["mA"],
    questions: [{ id: "uq1", question: "Есть опыт?", type: "yes_no" }],
  };
  const card = assistant.handleTrial({
    questions: [{ id: "q1", question: "Есть опыт?", type: "yes_no" }],
    models: ["mA"],
    rows: [
      { model: "mA", label: "Model A", answers: { q1: "нет 60%" },
        fullAnswers: { q1: ansYesNo(0.4, 0.6) } },
    ],
    decision: { outcomes: [
      { label: "Нанять", color: "green", rules: [{ conditions: [
        { question: "q1", answer: "yes", op: "gte", threshold: 70 } ] }] },
      { label: "Отказ", color: "red", isDefault: true, rules: [] },
    ] },
  });
  const table = card.querySelector(".assistant-trial-table");
  includes(table.querySelector("tr").textContent, "Решение", "колонка решения");
  const badge = card.querySelector(".assistant-trial-decision");
  assert(badge, "бейдж решения");
  eq(badge.textContent, "Отказ", "исход посчитан движком (да 40% < 70%)");
  const cell = table.querySelectorAll("td")[1];
  includes(cell.textContent, "≠", "маркер изменившегося ответа");
  const legend = card.querySelector(".assistant-trial-legend");
  assert(legend, "легенда отличий");
  includes(legend.textContent, "Отличия от вашего прогона", "заголовок легенды");
  includes(legend.textContent, "да · 90% → нет · 60%", "деталь отличия");

  // фаза: невалидные правила (answer «да» вместо yes — типовой брак модели) —
  // плашка вместо бейджей, исходы не считаются (раньше условие тихо давало
  // false и карточка показывала неверные исходы без единого сигнала)
  const badCard = assistant.handleTrial({
    questions: [{ id: "q1", question: "Есть опыт?", type: "yes_no" }],
    models: ["mA"],
    rows: [{ model: "mA", label: "Model A", answers: { q1: "да 90%" },
             fullAnswers: { q1: ansYesNo(0.9, 0.1) } }],
    decision: { outcomes: [
      { label: "Нанять", color: "green", rules: [{ conditions: [
        { question: "q1", answer: "да", op: "gte", threshold: 70 } ] }] },
      { label: "Отказ", color: "red", isDefault: true, rules: [] },
    ] },
  });
  const warn = badCard.querySelector(".assistant-trial-invalid");
  assert(warn, "плашка невалидных правил");
  includes(warn.textContent, "не применимы");
  includes(warn.textContent, "нет ответа «да»", "причина из validateDecision");
  assert(!badCard.querySelector(".assistant-trial-decision"),
         "бейджи исходов не посчитаны");

  // фаза: legacy persist (карточка до A3, question — число) — позиционный
  // фолбэк по списку вопросов прогона, карточка не ломается
  const legacyCard = assistant.handleTrial({
    questions: [{ id: "q1", question: "Есть опыт?", type: "yes_no" }],
    models: ["mA"],
    rows: [{ model: "mA", label: "Model A", answers: { q1: "да 90%" },
             fullAnswers: { q1: ansYesNo(0.9, 0.1) } }],
    decision: { outcomes: [
      { label: "Нанять", color: "green", rules: [{ conditions: [
        { question: 1, answer: "yes", op: "gte", threshold: 70 } ] }] },
      { label: "Отказ", color: "red", isDefault: true, rules: [] },
    ] },
  });
  eq(legacyCard.querySelector(".assistant-trial-decision").textContent, "Нанять",
     "legacy-карточка: №1 → первый вопрос прогона (фолбэк)");
});

test("assistant: propose_context с file — правка текста файла батча, undo; несуществующий файл — «Не применено»", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  state.batch.files = [{ id: "f1", name: "doc.txt", size: 6, text: "старый",
    status: "pending", isImage: false, images: [] }];
  await assistant.handleProposal({ kind: "propose_context",
    payload: { mode: "replace", text: "новый текст", file: "doc.txt" } });
  eq(state.batch.files[0].text, "старый", "pending: файл не тронут");
  const card = document.getElementById("assistant-chat").querySelector(".assistant-proposal");
  // заголовок превью: имя файла — flink-ссылка (моно, превью по hover)
  const flink = card.querySelector(".assistant-flink");
  assert(flink, "flink на имя файла в превью");
  eq(flink.textContent, "doc.txt", "flink несёт имя файла");
  includes(card.textContent, "Заменить текст файла", "заголовок превью файла");
  includes(card.textContent, "старый", "текущий текст в превью");
  includes(card.textContent, "новый текст", "предложенный текст в превью");
  card.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  eq(state.batch.files[0].text, "новый текст", "текст файла заменён");
  eq(state.batch.files[0].size, "новый текст".length, "size обновлён");
  includes(card.textContent, "Применена", "статус «Применена»");
  card.querySelector(".assistant-undo").fire("click");
  eq(state.batch.files[0].text, "старый", "undo вернул текст файла");
  // несуществующий файл → «Не применено», состояние не тронуто
  await assistant.handleProposal({ kind: "propose_context",
    payload: { mode: "replace", text: "x", file: "no.txt" } });
  const bad = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  bad.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  includes(bad.textContent, "Не применено", "ошибка на карточке");
  includes(bad.textContent, "не найден", "текст ошибки");
  eq(state.batch.files[0].text, "старый", "файл не тронут");
});

test("assistant: гейт 3.4 — замена длинного текста коротким: compact-стоп с ценой, блок .destruct, danger-кнопка; сопоставимая длина — без гейта", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  context.initContext({});
  context.setContent("длинный текст ".repeat(50), "text");  // 700 симв.

  // фаза 1: гейт по порогу (старый > 500, новый < 50%) — карточка компактная
  // за нейтральной pending: стоп «Развернуть и проверить» вместо «Принять»
  await assistant.handleProposal({ kind: "propose_run", title: "Запуск",
    payload: { scope: "single" } });
  const cCtx = await assistant.handleProposal({ kind: "propose_context",
    title: "Сжатие", payload: { mode: "replace", text: "короткий" } });
  await sleep(10);
  assert(cCtx.classList.contains("assistant-proposal-compact"), "вторая в очереди — компактная");
  const ess = cCtx.querySelector(".assistant-proposal-essence-text");
  const warn = ess.querySelector(".ess-warn");
  assert(warn, "ess-warn в компактной строке (макет 3.4)");
  includes(warn.textContent, "⚠ замена 700 → 8 симв.", "цена замены в пометке");
  assert(ess.textContent.startsWith("Контекст: ⚠"), "пометка сразу после «Контекст:»");
  notIncludes(ess.textContent, "замена текста,", "плоского хвоста с размерами нет");
  const stop = cCtx.querySelector(".assistant-destruct-expand");
  assert(stop && !stop.classList.contains("hidden"), "стоп «Развернуть и проверить»");
  assert(cCtx.querySelector(".assistant-accept").classList.contains("hidden"),
    "принятие скрыто в компактной");
  stop.fire("click");
  // развёрнутая: блок цены + solid-красная «Заменить текст»
  const destr = cCtx.querySelector(".assistant-destruct");
  assert(destr, "блок цены замены");
  includes(destr.textContent, "заменён почти целиком", "зачин блока цены");
  includes(destr.textContent, "Было 700 симв., станет 8", "цена в блоке");
  includes(destr.textContent, "только из этого развёрнутого вида", "хвост гейта");
  const accept = cCtx.querySelector(".assistant-accept");
  eq(accept.textContent, "Заменить текст", "danger-кнопка замены");
  assert(accept.classList.contains("assistant-accept-danger"), "solid-красная");
  accept.fire("click");
  await sleep(10);
  eq(document.getElementById("context-input").value, "короткий", "замена применена из развёрнутого вида");

  // фаза 2: сопоставимая длина — гейта нет (порог не срабатывает)
  const cOk = await assistant.handleProposal({ kind: "propose_context",
    title: "Правка", payload: { mode: "replace", text: "x".repeat(400) } });
  await sleep(10);
  assert(!cOk.querySelector(".assistant-destruct"), "нет блока цены");
  assert(!cOk.querySelector(".assistant-destruct-expand"), "нет стоп-кнопки");
  assert(!cOk.querySelector(".ess-warn"), "нет красной пометки");
  const accOk = cOk.querySelector(".assistant-accept");
  eq(accOk.textContent, "Принять", "обычная кнопка без гейта");
  assert(!accOk.classList.contains("assistant-accept-danger"), "не красная");

  // фаза 3: файл батча — старый размер из state.batch.files, кнопка «…файла»
  state.batch.files = [{ id: "f1", name: "big.txt", size: 1200, status: "ok",
    isImage: false, images: [], text: "текст ".repeat(200) }];  // 1200 симв.
  const cFile = await assistant.handleProposal({ kind: "propose_context",
    title: "Сжатие файла", payload: { mode: "replace", text: "мало", file: "big.txt" } });
  await sleep(10);
  includes(cFile.querySelector(".assistant-destruct").textContent,
    "Было 1 200 симв., станет 4", "цена по файлу батча");
  eq(cFile.querySelector(".assistant-accept").textContent, "Заменить текст файла",
    "danger-кнопка для файла");
  includes(cFile.querySelector(".assistant-proposal-essence .ess-warn").textContent,
    "⚠ замена 1 200 → 4 симв.", "компактная пометка файла (карточка компактна за фазой 2)");
});

test("assistant: invalid propose_context — имена файлов в причине рендерятся flink'ами (макет 3.8)", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({ validateError:
    "propose_context: файла «interview_09.txt» нет в пакете — доступные: interview_01.txt, interview_02.txt" });
  assistant.initAssistant();
  await sleep(10);
  state.batch.files = [
    { id: "f1", name: "interview_01.txt", size: 10, status: "ok", isImage: false, images: [], text: "первый" },
    { id: "f2", name: "interview_02.txt", size: 10, status: "ok", isImage: false, images: [], text: "второй" },
  ];
  await assistant.handleProposal({ kind: "propose_context",
    payload: { mode: "replace", text: "x", file: "interview_09.txt" } });
  const card = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  await sleep(10);
  assert(card.classList.contains("assistant-proposal-invalid"), "карточка невалидна");
  const reason = card.querySelector(".assistant-proposal-reason");
  // существующие файлы из «доступные: …» — flink-ссылки с превью
  const links = [...reason.querySelectorAll(".assistant-flink")].map(x => x.textContent);
  eq(links.join(","), "interview_01.txt,interview_02.txt", "flink'и на существующие файлы");
  // упомянутый, но несуществующий файл — не ссылка, обычный моно-текст
  const plain = reason.querySelector(".assistant-flink-plain");
  assert(plain && plain.textContent === "interview_09.txt", "несуществующий — моно-текст");
  includes(reason.textContent, "нет в пакете", "текст причины сохранён");
});

test("assistant: propose_save_preset со slug — гейт перезаписи (макет 5.4): compact-стоп, блок цены, «Перезаписать пресет»; применение — диалог именем существующего", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  globalThis.fetch = async (path) => {
    if (path === "/api/presets") {
      return { ok: true, status: 200, json: async () => ([{ slug: "my-preset", name: "Мой пресет" }]) };
    }
    return { ok: false, status: 404, json: async () => ({ detail: "no mock" }) };
  };
  questions.setQuestions([{ question: "Ок?", type: "yes_no" }]);
  // первая pending-карточка, чтобы карточка перезаписи была компактной строкой
  await assistant.handleProposal({ kind: "propose_run", title: "Запуск",
    payload: { scope: "single" } });
  const cardC = await assistant.handleProposal({ kind: "propose_save_preset",
    payload: { name: "Новое имя", slug: "my-preset" } });
  await sleep(10);
  // compact (макет 5.4): красная пометка с именем + стоп «Развернуть и проверить»
  assert(cardC.classList.contains("assistant-proposal-compact"), "вторая в очереди — компактная");
  const warn = cardC.querySelector(".assistant-proposal-essence .ess-warn");
  assert(warn, "ess-warn в компактной строке");
  includes(warn.textContent, "⚠ перезапишет «Новое имя»", "имя перезаписываемого в пометке");
  includes(cardC.querySelector(".assistant-proposal-essence").textContent,
    "1 вопрос", "состав остался в строке-последствии");
  const stop = cardC.querySelector(".assistant-destruct-expand");
  assert(stop && !stop.classList.contains("hidden"), "стоп «Развернуть и проверить»");
  assert(cardC.querySelector(".assistant-accept").classList.contains("hidden"),
    "«Сохранить» скрыта в компактной");
  stop.fire("click");
  assert(!cardC.classList.contains("assistant-proposal-compact"), "развернулась по стопу");
  // развёрнутая: блок цены + solid-красная «Перезаписать пресет»
  const destr = cardC.querySelector(".assistant-destruct");
  assert(destr, "блок цены перезаписи");
  includes(destr.textContent, "Перезапишет существующий пресет «Новое имя»", "зачин блока цены");
  includes(destr.textContent, "откатить перезапись нельзя", "цена в блоке");
  includes(destr.textContent, "только из этого развёрнутого вида", "хвост гейта");
  const acceptBtn = cardC.querySelector(".assistant-accept");
  eq(acceptBtn.textContent, "Перезаписать пресет", "danger-кнопка перезаписи");
  assert(acceptBtn.classList.contains("assistant-accept-danger"), "solid-красная");
  acceptBtn.fire("click");
  await sleep(20);
  eq(document.getElementById("preset-dlg-name").value, "Мой пресет", "имя существующего пресета по slug");
  includes(cardC.textContent, "Применена", "статус «Применена»");
  presetsMod.closeDialog();
  // slug не найден → «Не применено»
  await assistant.handleProposal({ kind: "propose_save_preset",
    payload: { name: "X", slug: "missing" } });
  const bad = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  bad.querySelector(".assistant-accept").fire("click");
  await sleep(20);
  includes(bad.textContent, "Не применено", "ошибка на карточке");
  includes(bad.textContent, "не найден", "текст ошибки");
});

test("assistant: is-working на кнопке — активный запрос и закрытая панель; СТОП — без бейджа", async () => {
  installDom(); await resetState(); domApp();
  state.models = [{ key: "mA", status: "running" }];
  // стрим «висит», как в тесте СТОП: read резолвится только абортом
  globalThis.fetch = async (path, options = {}) => {
    if (path === "/api/assistant/models") {
      return { ok: true, status: 200, json: async () => ({ models: [{ key: "mA", label: "Model A" }] }) };
    }
    if (path === "/api/assistant/chat") {
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
  const tbBtn = document.getElementById("tb-assistant");
  assert(document.getElementById("assistant-panel").classList.contains("hidden"), "панель закрыта");
  const send = document.getElementById("assistant-send");
  const ta = document.getElementById("assistant-input");
  ta.value = "привет";
  ta.fire("input");
  send.fire("click");
  await sleep(10);
  assert(tbBtn.classList.contains("is-working"), "is-working при закрытой панели");
  // открыли панель — индикатор не нужен (лента видна)
  tbBtn.fire("click");
  assert(!tbBtn.classList.contains("is-working"), "при открытой панели индикатора нет");
  // закрыли во время работы — индикатор вернулся
  tbBtn.fire("click");
  assert(tbBtn.classList.contains("is-working"), "при повторном закрытии индикатор вернулся");
  // СТОП — ручная отмена: индикатор снят, бейджа нет
  send.fire("click");
  await sleep(20);
  assert(!tbBtn.classList.contains("is-working"), "is-working снят после остановки");
  assert(!tbBtn.classList.contains("has-unread"), "ручная остановка — без бейджа");
});

test("assistant: has-unread по done/error при закрытой панели; при открытой — нет; снятие при открытии", async () => {
  installDom(); await resetState(); domApp();
  state.models = [{ key: "mA", status: "running" }];
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [{ type: "token", text: "Готово" }, { type: "done" }],
  });
  assistant.initAssistant();
  await sleep(10);
  const tbBtn = document.getElementById("tb-assistant");
  // done при закрытой панели → бейдж
  await assistantSay("привет");
  assert(tbBtn.classList.contains("has-unread"), "бейдж по done при закрытой панели");
  assert(!tbBtn.classList.contains("is-working"), "работа завершена — is-working снят");
  // открытие панели снимает бейдж
  tbBtn.fire("click");
  assert(!tbBtn.classList.contains("has-unread"), "бейдж снят при открытии панели");
  // done при открытой панели — бейдж не ставится
  await assistantSay("ещё");
  assert(!tbBtn.classList.contains("has-unread"), "при открытой панели бейдж не ставится");
  // error при закрытой панели — тоже бейдж
  tbBtn.fire("click");
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatError: { status: 500, detail: "упало" },
  });
  await assistantSay("третий");
  assert(tbBtn.classList.contains("has-unread"), "бейдж по error при закрытой панели");
});

test("contract: панель ассистента — собственный чат-UI, deep-chat удалён", () => {
  const html = readFileSync(new NodeURL("../static/index.html", import.meta.url), "utf8");
  for (const id of ["tb-assistant", "assistant-panel", "assistant-close", "assistant-model",
    "assistant-thinking", "assistant-reset", "assistant-resize", "assistant-chat",
    "assistant-messages", "assistant-input", "assistant-send", "assistant-pending"]) {
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
  includes(assistantSrc, 'from "./analysis.js"', "карточки разбора/очереди — analysis.js (v1.1)");
  includes(assistantSrc, 'from "./flink.js"', "ссылки на файлы (flink) — flink.js (v1.2)");
  notIncludes(assistantSrc, "deep-chat", "assistant.js не зависит от deep-chat");
  notIncludes(assistantSrc, "shadowRoot", "shadow DOM больше не используется");
  notIncludes(assistantSrc, "htmlClassUtilities", "биндинг через htmlClassUtilities удалён");
  const css = readFileSync(new NodeURL("../static/style.css", import.meta.url), "utf8");
  for (const cls of [".assistant-panel", ".assistant-resize", ".assistant-footer",
    ".assistant-messages", ".assistant-md", ".assistant-typing", ".assistant-send",
    ".assistant-proposal", ".assistant-note", ".tb-assistant-dots",
    ".assistant-accept", ".assistant-decline", ".assistant-proposal-actions",
    ".assistant-proposal-status", ".diff-add", ".diff-del", ".diff-chg",
    ".assistant-trial-decision", ".assistant-trial-legend",
    ".assistant-proposal-compact", ".assistant-proposal-essence",
    ".assistant-proposal-queuenum", ".assistant-proposal-dep",
    ".assistant-proposal-expandlink", ".assistant-pending-chip",
    ".assistant-destruct-expand", ".assistant-flash-target",
    ".assistant-run-done",
    ".assistant-analysis", ".assistant-queue", ".assistant-info-title",
    ".assistant-analysis-headline", ".assistant-analysis-badge",
    ".assistant-analysis-action", ".assistant-analysis-coldstart",
    ".assistant-analysis-primary", ".assistant-analysis-raw",
    ".assistant-queue-link", ".assistant-queue-reason",
    ".assistant-queue-action", ".assistant-navigator",
    ".assistant-navigator-count", ".assistant-navigator-exit",
    ".diff-same", ".assistant-trial-actions",
    // каркас «Рамс» (v1.2): пиллы, кромки, ярусы кнопок, терминальная строка
    ".assistant-proposal-top", ".assistant-proposal-eye",
    ".assistant-proposal-status-dot", ".assistant-proposal-reason",
    ".assistant-proposal-stats", ".assistant-proposal-foot",
    ".assistant-term-row", ".assistant-term-sum", ".assistant-term-acts",
    ".assistant-proposal-terminal", ".assistant-reissue", ".assistant-card-hide",
    ".assistant-accept-danger", ".assistant-proposal-pending-open",
    ".assistant-proposal-gate", ".assistant-link-quiet",
    // макет 1.x: красная пометка удалений в stats, строка следствия для правил
    ".s-del", ".assistant-conseq",
    // макеты 3.x/5.x: моно-строки diff'а контекста, kv-пресет, «другое имя…»
    ".dl-mono", ".kv", ".kv-k", ".assistant-alt-name",
    // макет 4.x: чипы моделей и scope гейта прогона, warn-пометка статуса
    ".assistant-mchip", ".assistant-scope-chip", ".assistant-kv-warn",
    // V-2: diff-фактология, disclosure, flink, таблица ответов what-if
    ".qb", ".q-head", ".q-badge", ".q-op", ".df-row", ".df-lab", ".df-sect",
    ".dl", ".mk", ".w-del", ".w-add", ".lv-n", ".yr", ".yr-tag",
    ".diff-legend", ".assistant-exp", ".assistant-exp-body",
    ".assistant-card-disclosures",
    ".assistant-flink", ".assistant-flink-plain", ".assistant-flink-popover",
    ".assistant-trial-answers", ".ta-old", ".ta-new", ".ta-mark", ".ta-same"]) {
    includes(css, cls, `${cls} в style.css`);
  }
  // disclosure ▸/▾ — маркеры через ::before, нативный marker скрыт
  includes(css, 'details.assistant-exp summary::before { content: "▸ "',
    "маркер ▸ у disclosure");
  includes(css, 'details.assistant-exp[open] summary::before { content: "▾ "',
    "маркер ▾ у раскрытого disclosure");
  // таблица ответов what-if: переносы запрещены только у колонки «метка» —
  // у «было/стало» длинный исход переносится, иначе таблица срезает «метку»
  includes(css, ".assistant-trial-answers .ta-mark { white-space: nowrap; }",
    "nowrap у колонки метки");
  assert(!css.includes(".assistant-trial-answers .ta-old, .assistant-trial-answers .ta-new { white-space: nowrap; }"),
    "«было/стало» без nowrap — длинный исход переносится, не ломая таблицу");
  // единственная тень системы — поповер превью файла
  includes(css, "box-shadow: 0 8px 24px rgba(29, 41, 57, .12)", "тень поповера flink");
  includes(css, "#tb-assistant.is-working", "is-working на кнопке тулбара в style.css");
  includes(css, "#tb-assistant.has-unread", "has-unread на кнопке тулбара в style.css");
  // миграция акцента и токены «Рамс» (спека §12)
  includes(css, "--accent: #2456c4", "акцент #2456c4");
  includes(css, "--ring: rgba(36, 86, 196, .30)", "единое focus-кольцо §12");
  for (const tok of ["--ink: #1d2939", "--line: #d8dce3", "--line-soft: #eceff3",
    "--ok: #067647", "--bad: #b42318", "--bad-line: #fecdca",
    "--warn: #8a5a00", "--warn-bg: #fef7e0", "--meta: #5a6472"]) {
    includes(css, tok, `токен ${tok} в style.css`);
  }
  notIncludes(css, "#4a7dff", "старый акцент удалён из style.css");
  notIncludes(css, "#155eef", "литералы старого синего удалены из style.css");
  // пульс только у pending-точки и гасится prefers-reduced-motion
  includes(css, ".assistant-proposal-status.pending .assistant-proposal-status-dot",
    "пульс у pending-точки пиллы");
  includes(css, "prefers-reduced-motion", "reduced-motion гасит пульс");
  // стоп-кнопка деструктивного гейта — danger-ghost (обводка #fecdca), не solid-red
  includes(css, ".assistant-destruct-expand.assistant-accept", "danger-ghost гейт");
  notIncludes(css, ".assistant-destruct-expand { background: #b42318",
    "solid-red у гейта удалён");
  const mdSrc = readFileSync(new NodeURL("../static/vendor/remarkable.js", import.meta.url), "utf8");
  includes(mdSrc, "export { Remarkable", "remarkable завендорен standalone");
  assert(!existsSync(new NodeURL("../static/vendor/deep-chat", import.meta.url)),
    "vendor/deep-chat удалён целиком");
});

test("assistant: ширина панели клампится до 1200 и к окну минус зазор", async () => {
  installDom(); await resetState(); domApp();
  assistant.applyPanelWidth(2000);
  eq(document.getElementById("assistant-panel").style.width, "1200px", "потолок 1200");
  window.innerWidth = 800;
  assistant.applyPanelWidth(2000);
  eq(document.getElementById("assistant-panel").style.width, "720px", "окно 800 − 80");
  assistant.applyPanelWidth(100);
  eq(document.getElementById("assistant-panel").style.width, "320px", "минимум 320");
  window.innerWidth = 0;  // некорректный innerWidth (тестовые окружения) — просто 1200
  assistant.applyPanelWidth(2000);
  eq(document.getElementById("assistant-panel").style.width, "1200px", "fallback 1200");
});

test("assistant: generate-диалог — «Модель:» внизу, статусы, общий dq-chat-model", async () => {
  installDom(); await resetState(); domApp();
  state.models = [
    { key: "mA", status: "running" },
    { key: "mB", status: "stopped" },
    { key: "rG", status: "running", type: "remote" },
  ];
  mockFetch({ "GET /api/assistant/models": { models: [
    { key: "mA", label: "Model A" },
    { key: "mB", label: "Model B" },
    { key: "rG", label: "GPT cloud", remote: true },
  ] } });
  const generate = await import("../static/generate.js");
  localStorage.setItem("dq-chat-model", "rG");
  await generate.openGenerateDialog({ title: "T", taskPlaceholder: "…", onGenerate: async () => {} });
  const sel = document.getElementById("generate-model");
  const row = sel.parentNode;
  includes(row.textContent, "Модель:", "лейбл «Модель:»");
  const boxKids = [...document.querySelector("#generate-dialog .preset-dialog-box").children];
  assert(boxKids.indexOf(row) > boxKids.indexOf(document.getElementById("generate-task")),
    "селект модели ниже поля задачи");
  eq(sel.value, "rG", "дефолт — общий выбор dq-chat-model");
  assert(sel.children[1].disabled, "stopped disabled");
  includes(sel.children[1].textContent, "не запущена", "пометка у stopped");
  includes(sel.children[2].textContent, "☁", "☁ у облачной");
  sel.value = "mA";
  sel.fire("change");
  eq(localStorage.getItem("dq-chat-model"), "mA", "выбор сохранён в общий ключ");
  generate.closeGenerateDialog();
});

test("assistant: trial-карточка — гипотеза/изменения в саммари, таблица за «Подробнее», ⛶, сводка исходов", async () => {
  installDom(); await resetState(); domApp();
  const card = assistant.handleTrial({
    title: "Порог 70% отсекает валидные кейсы",
    changes: "порог «Одобрить» 70% → 50%",
    questions: [{ id: "q1", question: "Есть дефект?", type: "yes_no" }],
    models: ["mA"],
    rows: [{ model: "mA", label: "Model A", answers: { q1: "да 89%" },
             fullAnswers: { q1: { type: "yes_no", probabilities: { yes: 0.89, no: 0.11 } } } }],
    decision: { outcomes: [
      { label: "Одобрить", color: "green", rules: [{ conditions: [
        { question: 1, answer: "yes", op: "gte", threshold: 50 }] }] },
      { label: "Отклонить", color: "red", isDefault: true, rules: [] },
    ] },
  });
  includes(card.querySelector(".assistant-proposal-title").textContent, "Порог 70%", "гипотеза в заголовке");
  includes(card.textContent, "Изменения: порог «Одобрить» 70% → 50%", "строка изменений");
  const det = card.querySelector(".assistant-trial-details");
  assert(det, "таблица за дрилдауном");
  assert(!det.open, "таблица свёрнута по умолчанию");
  assert(det.querySelector(".assistant-trial-table"), "таблица внутри details");
  const outcomes = card.querySelector(".assistant-trial-outcomes");
  includes(outcomes.textContent, "Model A", "модель в сводке исходов");
  includes(outcomes.textContent, "Одобрить", "исход в сводке (движок на фронте)");
  const fs = card.querySelector(".assistant-trial-fs");
  fs.fire("click");
  assert(card.classList.contains("trial-fullscreen"), "fullscreen включён");
  assert(det.open, "details раскрыт при fullscreen");
  fs.fire("click");
  assert(!card.classList.contains("trial-fullscreen"), "fullscreen выключен");
});

test("assistant: trial what-if (v1.1, макет 7) — дельта на размеченных исходах + «Принять формулировку»", async () => {
  // Фаза 1: trial с правилами + разметка исхода по модели прогона + висящая
  // карточка правки вопросов → дельта измерена, действие принимает её
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Ок?", type: "yes_no" }]);
  const setupResults = () => {
    state.results = {
      results: { mA: runRes({}, { q1: ansYesNo(0.9, 0.1) }) },
      order: ["mA"], runMode: "decisions", questions: state.questions,
      // «до»: default-исход «Хорошо»; пометка ✗ на исходе прогона mA
      decision: { outcomes: [{ id: "o1", label: "Хорошо", color: "green",
                               isDefault: true, rules: [] }] },
      marks: [{ id: "m1", verdict: "reject", comment: "",
                target: { scope: "single", model: "mA", mode: "decisions",
                          decision: true } }],
    };
  };
  setupResults();
  const trial = {
    title: "Строже формулировка",
    questions: [{ id: "q1", question: "Ок?", type: "yes_no" }],
    models: ["mA"],
    rows: [{ model: "mA", label: "Model A", answers: { q1: "да 90%" },
             fullAnswers: { q1: { type: "yes_no", probabilities: { yes: 0.9, no: 0.1 } } } }],
    // «после»: P(да) ≥ 50% → «Плохо» — исход сменился на размеченной ✗-ячейке
    decision: { outcomes: [
      { label: "Плохо", color: "red", rules: [{ conditions: [
        { question: 1, answer: "yes", op: "gte", threshold: 50 }] }] },
      { label: "Хорошо", color: "green", isDefault: true, rules: [] },
    ] },
  };
  await assistant.handleProposal({ id: "pq", kind: "propose_questions",
    title: "Правка вопросов", payload: { mode: "append",
      questions: [{ question: "Новый?", type: "yes_no" }] } });
  const card = assistant.handleTrial(trial);
  // top-ряд результата what-if (макет 4.3): eyebrow с параметрами прогона,
  // пилла «Ждёт решения», янтарная кромка pending
  const eye = card.querySelector(".assistant-proposal-top .assistant-proposal-eye");
  eq(eye.textContent, "Пробный прогон · 1 модель × 1 вопрос", "eyebrow 4.3");
  includes(card.querySelector(".assistant-proposal-status").textContent,
    "Ждёт решения", "пилла pending");
  assert(card.classList.contains("assistant-proposal-pending-open"),
    "кромка развёрнутой pending");
  const delta = card.querySelector(".assistant-delta");
  assert(delta, "блок дельты в trial-карточке");
  includes(delta.textContent, "ошибок 1 → 0", "дельта измерена");
  includes(delta.textContent, "исправлено 1", "✗-ячейка исправлена");
  includes(delta.textContent, "погрешность", "предупреждение о малой выборке");
  const act = card.querySelector(".assistant-trial-actions .assistant-accept");
  assert(act, "«Принять формулировку» при висящей правке вопросов");
  const dec = card.querySelector(".assistant-trial-actions .assistant-decline");
  assert(dec && dec.textContent === "Отклонить", "ghost «Отклонить» (макет 4.3)");
  act.fire("click");
  await sleep(10);
  eq(state.questions.length, 2, "pending-карточка применена (вопрос добавлен)");
  // терминал после принятия (макет 4.3 → 4.7-паттерн): «Применено · гипотеза»
  const actRow = card.querySelector(".assistant-trial-actions");
  assert(!actRow || actRow.classList.contains("hidden"), "действие скрыто после принятия");
  assert(card.classList.contains("assistant-proposal-terminal"), "терминальная строка");
  includes(card.querySelector(".assistant-proposal-status").textContent,
    "Применено", "пилла «Применено»");
  includes(card.querySelector(".assistant-term-sum").textContent,
    "Строже формулировка", "гипотеза в терминальной строке");
  eq(card._feedItem.trialStatus, "applied", "статус в persist-записи");
  assert(!card.classList.contains("assistant-proposal-pending-open"),
    "кромка pending снята");
  const propCard = [...document.querySelectorAll(".assistant-proposal")]
    .find(c => c !== card && c.textContent.includes("Правка вопросов"));
  includes(propCard.textContent, "Применена", "карточка вопросов — «Применена»");

  // Фаза 2: без разметки и без pending — честное «не измерен», действия нет
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Ок?", type: "yes_no" }]);
  setupResults();
  state.results.marks = [];
  const card2 = assistant.handleTrial(trial);
  const dim = card2.querySelector(".assistant-delta-dim");
  assert(dim, "dim-блок без разметки");
  includes(dim.textContent, "Эффект не измерен", "честное состояние");
  assert(!card2.querySelector(".assistant-trial-actions"),
         "нет pending — нет «Принять формулировку»");

  // Фаза 3: разметка от старой редакции (resultsStale) — отказ
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Ок?", type: "yes_no" }]);
  setupResults();
  state.resultsStale = true;
  const card3 = assistant.handleTrial(trial);
  const stale = card3.querySelector(".assistant-delta-stale");
  assert(stale, "stale-блок");
  includes(stale.textContent, "Дельту посчитать нельзя", "текст отказа");

  // Фаза 4: «Отклонить» — терминал «Отклонено · гипотеза» БЕЗ применения,
  // карточка правки вопросов остаётся pending
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Ок?", type: "yes_no" }]);
  await assistant.handleProposal({ id: "pq2", kind: "propose_questions",
    title: "Правка вопросов", payload: { mode: "append",
      questions: [{ question: "Новый?", type: "yes_no" }] } });
  const card4 = assistant.handleTrial(trial);
  card4.querySelector(".assistant-trial-actions .assistant-decline").fire("click");
  await sleep(10);
  eq(state.questions.length, 1, "правка НЕ применена");
  assert(card4.classList.contains("assistant-proposal-terminal"), "терминал 4.3");
  includes(card4.querySelector(".assistant-proposal-status").textContent,
    "Отклонено", "пилла «Отклонено»");
  includes(card4.querySelector(".assistant-term-sum").textContent,
    "Строже формулировка", "гипотеза в строке");
  eq(card4._feedItem.trialStatus, "declined", "статус в persist-записи");
  const pqCard = [...document.querySelectorAll(".assistant-proposal")]
    .find(c => c !== card4 && c.textContent.includes("Правка вопросов"));
  includes(pqCard.textContent, "Ждёт решения", "карточка правки осталась pending");
  // разворот терминала по клику на строку
  card4.querySelector(".assistant-term-row").fire("click");
  assert(!card4.classList.contains("assistant-proposal-terminal"), "развернулась");

  // Фаза 5: таблица ответов 4.3а — ячейка «№N × модель» со сдвигом ответа;
  // расхождения моделей в delta-sub (две модели: до — разные топ-ответы,
  // после — совпали)
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  state.models = [
    { key: "mA", label: "Model A 27B", status: "running" },
    { key: "mB", label: "Model B 13B", status: "running" },
  ];
  questions.setQuestions([
    { id: "q1", question: "Ок?", type: "yes_no" },
    { id: "q2", question: "Тон?", type: "yes_no" },
  ]);
  state.results = {
    results: {
      mA: runRes({}, { q1: ansYesNo(0.2, 0.8), q2: ansYesNo(0.8, 0.2) }),
      mB: runRes({}, { q1: ansYesNo(0.25, 0.75), q2: ansYesNo(0.2, 0.8) }),
    },
    order: ["mA", "mB"], runMode: "decisions", questions: state.questions,
    decision: { outcomes: [{ id: "o1", label: "Хорошо", color: "green",
                             isDefault: true, rules: [] }] },
    marks: [
      { id: "m1", verdict: "reject", comment: "",
        target: { scope: "single", model: "mA", mode: "decisions",
                  decision: true } },
      { id: "m2", verdict: "reject", comment: "",
        target: { scope: "single", model: "mA", mode: "decisions",
                  question: "q1" } },
    ],
  };
  const trial2 = {
    title: "Пара моделей",
    questions: [{ id: "q1", question: "Ок?", type: "yes_no" },
                { id: "q2", question: "Тон?", type: "yes_no" }],
    models: ["mA", "mB"],
    rows: [
      { model: "mA", label: "Model A", answers: { q1: "да 90%", q2: "да 75%" },
        fullAnswers: { q1: ansYesNo(0.9, 0.1), q2: ansYesNo(0.75, 0.25) } },
      { model: "mB", label: "Model B", answers: { q1: "да 85%", q2: "да 70%" },
        fullAnswers: { q1: ansYesNo(0.85, 0.15), q2: ansYesNo(0.7, 0.3) } },
    ],
    decision: { outcomes: [
      { label: "Плохо", color: "red", rules: [{ conditions: [
        { question: 1, answer: "yes", op: "gte", threshold: 50 }] }] },
      { label: "Хорошо", color: "green", isDefault: true, rules: [] },
    ] },
  };
  const card5 = assistant.handleTrial(trial2);
  const delta5 = card5.querySelector(".assistant-delta");
  includes(delta5.textContent, "ошибок 1 → 0", "дельта по исходу измерена");
  includes(delta5.querySelector(".assistant-delta-sub").textContent,
    "расхождения моделей по №2: 1 → 0", "расхождения в delta-sub (4.3а)");
  const table5 = card5.querySelector(".assistant-trial-answers");
  assert(table5, "таблица ответов");
  const qRow = [...table5.querySelectorAll("tr")]
    .find(tr => tr.querySelector(".ta-cell")?.textContent.includes("№1"));
  assert(qRow, "строка размеченной ячейки вопроса");
  eq(qRow.querySelector(".ta-cell").textContent, "№1 × 27B",
     "ячейка — «№ вопроса × модель»");
  eq(qRow.querySelector(".ta-old").textContent, "«нет · 80%»", "было — ответ прогона пользователя");
  eq(qRow.querySelector(".ta-new").textContent, "«да · 90%»", "стало — ответ пробного прогона");
  includes(qRow.querySelector(".ta-mark").textContent, "✗ → ✓", "метка формой знака");
});

test("assistant: propose_questions превью — длинная формулировка строками БЫЛО/СТАНЕТ (без hover-сокращений)", async () => {
  installDom(); await resetState(); domApp();
  const longA = "На фото виден дефект, " + "очень ".repeat(20) + "длинная формулировка А";
  const longB = "Дефект подтверждён фото, " + "очень ".repeat(20) + "длинная формулировка Б";
  state.questions = [{ id: "q1", question: longA, type: "yes_no", yes: longA, no: "нет" }];
  await assistant.handleProposal({ kind: "propose_questions", payload: { mode: "replace",
    questions: [{ question: longB, type: "yes_no", yes: longB, no: "нет" }] } });
  const card = document.querySelector("#assistant-messages .assistant-proposal");
  // макет option-c: длинные формулировки — двумя строками «было/станет»,
  // полный текст виден сразу (hover-tooltip'ов больше нет)
  const was = [...card.querySelectorAll(".df-lab.was")].map(x => x.parentNode.textContent);
  const will = [...card.querySelectorAll(".df-lab.will")].map(x => x.parentNode.textContent);
  assert(was.length >= 1 && will.length >= 1, "строки «было»/«станет» у длинного текста");
  includes(was.join("\n"), longA, "полный «было» виден целиком");
  includes(will.join("\n"), longB, "полный «станет» виден целиком");
  // «да» тоже изменилось — строка с пословной дельтой
  const yesRow = card.querySelector(".yr");
  assert(yesRow && yesRow.querySelector(".w-add"), "формулировка «да» — пословный diff");
  // короткие совпадающие правки строк не порождают
  eq(card.querySelectorAll(".yr").length, 1, "неизменная «нет» строки не порождает");
});

test("assistant: propose_questions с edits — превью операциями и warn; «Принять» применяет итог как replace, undo", async () => {
  installDom(); await resetState(); domApp();
  questions.setQuestions([
    { id: "q1", question: "Есть дефект?", type: "yes_no" },
    { id: "q2", question: "Качество?", type: "score", levels: ["плохо", "хорошо"] },
    { id: "q3", question: "Тип?", type: "choice", options: [{ name: "А" }, { name: "Б" }] },
  ]);
  // payload — как из разворота на бэке: итоговый набор (replace) + исходные edits + warn
  await assistant.handleProposal({ kind: "propose_questions", title: "Правка вопросов", payload: {
    mode: "replace",
    questions: [
      { id: "q1", question: "Есть скол?", type: "yes_no" },
      { id: "q2", question: "Качество?", type: "score", levels: ["плохо", "хорошо"] },
      { id: "q9", question: "Подпись есть?", type: "yes_no" },
    ],
    edits: [
      { op: "update", target: "q1", question: { question: "Есть скол?", type: "yes_no" } },
      { op: "split", target: "q2", into: [{ question: "Часть А?", type: "yes_no" }, { question: "Часть Б?", type: "yes_no" }] },
      { op: "remove", target: "q3" },
      { op: "add", question: { question: "Подпись есть?", type: "yes_no" } },
    ],
    warn: "правило исхода «Брак» ссылается на №1",
  } });
  const card = [...document.querySelectorAll(".assistant-proposal")].pop();
  // превью — diff по типам (update: полный блок вопроса; split: маркеры +;
  // remove: зачёркнутая строка; add: блок «новый»), а не LCS-дифф
  const updBlock = [...card.querySelectorAll(".qb")].find(b =>
    b.querySelector(".q-badge") && b.querySelector(".q-badge").textContent === "№1");
  assert(updBlock, "блок update по №1");
  includes(updBlock.querySelector(".w-add").textContent, "скол?",
    "новая формулировка — зелёным добавлением");
  includes(updBlock.querySelector(".w-del").textContent, "дефект?",
    "старая формулировка — красным зачёркнутым");
  includes(updBlock.textContent, "изменён · текст", "метка аспекта");
  includes(card.textContent, "разбит → 2 вопроса", "операция split");
  includes(card.textContent, "Часть А?", "часть split");
  const del = card.querySelector(".diff-del");
  assert(del, "строка удаления");
  includes(del.textContent, "№3", "операция remove по №3");
  includes(del.textContent, "Тип?", "текст удаляемого");
  notIncludes(del.textContent, "размечено", "без разметки — без пометки цены у строки");
  // легенда чтения diff'а — и на edits-пути (макет 1.1)
  includes(card.querySelector(".diff-legend").textContent, "Как читать",
    "легенда на edits-пути");
  // warn от бэка — тоже гейт: красная пометка удаления в stats, блок цены,
  // solid-красная кнопка
  const stats = card.querySelector(".assistant-proposal-stats");
  includes(stats.querySelector(".s-del").textContent, "⚠ удаляется №3 из 3",
    "пометка удаления в stats на edits-пути");
  const destr = card.querySelector(".assistant-destruct");
  assert(destr, "блок цены деструктива (warn-гейт)");
  includes(destr.textContent, "Удаляется №3", "что удаляется — в блоке цены");
  includes(destr.textContent, "только из этого развёрнутого вида", "хвост гейта");
  const acceptBtn = card.querySelector(".assistant-accept");
  assert(acceptBtn.classList.contains("assistant-accept-danger"),
    "warn + удаление — solid-красная кнопка");
  const addBlock = [...card.querySelectorAll(".qb")].find(b =>
    b.querySelector(".q-op-add"));
  assert(addBlock, "блок add");
  includes(addBlock.textContent, "Подпись есть?", "текст добавляемого вопроса");
  includes(addBlock.textContent, "в конец", "операция add без after");
  assert(!card.textContent.includes("Заменить вопросы: было"), "шапки LCS-диффа нет");
  const warn = card.querySelector(".diff-warn");
  assert(warn, "warn-строка в превью");
  includes(warn.textContent, "⚠", "маркер предупреждения");
  includes(warn.textContent, "ссылается на №1", "текст warn");
  // apply — существующий путь replace: итоговый массив целиком
  card.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  eq(state.questions.length, 3, "итоговый набор применён");
  eq(state.questions.map(q => q.id).join(","), "q1,q2,q9", "id из payload сохранены");
  eq(state.questions[0].question, "Есть скол?", "update применён");
  // undo возвращает прежний набор
  card.querySelector(".assistant-undo").fire("click");
  eq(state.questions.length, 3, "undo вернул вопросы");
  eq(state.questions.map(q => q.id).join(","), "q1,q2,q3", "прежние вопросы на месте");
});

test("assistant: снапшот — num у файлов батча, otherPage, картинки для vision-моделей прогона", async () => {
  installDom(); await resetState(); domApp();
  state.models = [
    { key: "chat1", status: "running" },                  // chat-модель без vision
    { key: "clef", status: "running", vision: true },     // выбранная decision-модель с vision
  ];
  state.selectedModels = new Set(["clef"]);
  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,AA" }];
  state.pageMode = "single";
  state.batch.files = [{ id: "f1", name: "a.txt", size: 10, text: "текст файла", status: "ok", images: [] }];
  const snap = assistant.buildSnapshot();
  assert(snap.context.images && snap.context.images.length === 1,
    "картинки включены: их заберут vision-модели пробного прогона");
  includes(snap.context.imagesNote, "не видишь", "пометка: ассистент картинки не видит");
  eq(snap.batchFiles[0].num, 1, "num у файла батча");
  eq(snap.otherPage.page, "batch", "otherPage — неактивный батч");
  eq(snap.otherPage.files, 1, "число файлов неактивной страницы");
  state.pageMode = "batch";
  const snap2 = assistant.buildSnapshot();
  eq(snap2.otherPage.page, "single", "otherPage — неактивный одиночный");
  eq(snap2.otherPage.hasContext, true, "там есть контекст (картинка)");
});

test("assistant: чип активного режима в шапке панели", async () => {
  installDom(); await resetState(); domApp();
  const chip = el("span", { id: "assistant-mode", className: "assistant-mode-chip hidden" });
  state.pageMode = "batch";
  assistant.updateModeChip();
  eq(chip.textContent, "Пакет", "чип пакета");
  assert(!chip.classList.contains("hidden"), "чип виден");
  state.pageMode = "single";
  assistant.updateModeChip();
  eq(chip.textContent, "Один материал", "чип одиночного");
  state.pageMode = "models";
  assistant.updateModeChip();
  assert(chip.classList.contains("hidden"), "вне страниц прогона чип скрыт");
});

test("assistant: раздельные чаты — лента и история per режим, переключение страницы, «Сброс»", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [{ type: "token", text: "Ответ одиночного" }, { type: "done" }],
  });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("вопрос одиночного");
  includes(feedText(), "вопрос одиночного", "сообщение в ленте single");
  includes(feedAnswerHtml(), "Ответ одиночного", "ответ в ленте single");
  // переключение на «Батч»: лента single скрыта, батч-чат — с welcome-подсказкой
  state.pageMode = "batch";
  assistant.updateModeChip();
  notIncludes(feedText(), "вопрос одиночного", "single-лента не видна в батче");
  const introB = feed().querySelector(".assistant-intro");
  assert(introB && !introB.classList.contains("hidden"), "батч-чат начинается с welcome");
  // сообщение в батче; история запроса — без сообщений одиночного чата
  const calls = mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [{ type: "token", text: "Ответ батча" }, { type: "done" }],
  });
  await assistantSay("вопрос батча");
  eq(assistantChatCalls(calls)[0].body.history.length, 0, "история батч-чата пуста — single не подмешан");
  includes(feedAnswerHtml(), "Ответ батча", "ответ в ленте батча");
  // обратно в single — его лента на месте, батч не подмешан
  state.pageMode = "single";
  assistant.updateModeChip();
  includes(feedText(), "вопрос одиночного", "single-лента восстановлена");
  notIncludes(feedText(), "вопрос батча", "батч-сообщения не видны в single");
  // «Сброс» очищает только активный разговор
  document.getElementById("assistant-reset").fire("click");
  notIncludes(feedText(), "вопрос одиночного", "single очищен");
  const introS = feed().querySelector(".assistant-intro");
  assert(introS && !introS.classList.contains("hidden"), "welcome вернулся после сброса");
  state.pageMode = "batch";
  assistant.updateModeChip();
  includes(feedText(), "вопрос батча", "батч-чат пережил сброс single");
});

test("assistant: стрим, начатый до переключения страницы, дописывается в свой чат", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [{ type: "token", text: "Ответ до переключения" }, { type: "done" }],
  });
  assistant.initAssistant();
  await sleep(10);
  const p = assistant.sendMessage("привет");
  // страница переключена до прихода токенов
  state.pageMode = "batch";
  assistant.updateModeChip();
  await p;
  notIncludes(feedText(), "привет", "в ленте батча чужих узлов нет");
  state.pageMode = "single";
  assistant.updateModeChip();
  includes(feedText(), "привет", "сообщение в своём чате");
  includes(feedAnswerHtml(), "Ответ до переключения", "ответ дописался в свой чат");
});

test("assistant: reviewMarks — разметка аналитика в снапшоте до resultsSummary, сироты исключены, stale", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  state.models = [{ key: "mA", label: "Qwen A 27B", short_label: "27B", status: "running" }];
  state.questions = [{ id: "q1", question: "Ок?", type: "yes_no" }];
  state.results = {
    results: { mA: runRes({}, { q1: ansYesNo(0.9, 0.1) }) },
    order: ["mA"], runMode: "decisions",
    questions: [{ id: "q1", question: "Ок?", type: "yes_no" }],
    marks: [
      { id: "m1", target: { scope: "single", model: "mA", mode: "decisions", question: "q1" },
        verdict: "reject", comment: "ложное срабатывание" },
      { id: "m2", target: { scope: "single", model: "mA", mode: "decisions" },
        verdict: "unsure", comment: "" },
      { id: "m3", target: { scope: "single", model: "gone", mode: "decisions", question: "q1" },
        verdict: "reject", comment: "сирота" },
    ],
  };
  const snap = assistant.buildSnapshot();
  assert(snap.reviewMarks, "reviewMarks в снапшоте");
  eq(snap.reviewMarks.totals.reject, 1, "сирота не в totals");
  eq(snap.reviewMarks.items.length, 2, "сирота не в items");
  includes(snap.reviewMarks.items[0], "вопрос №1 «Ок?» × 27B: ✗ «ложное срабатывание»", "пункт ячейки");
  includes(snap.reviewMarks.items[1], "прогон 27B: ?", "пункт прогона");
  // reviewMarks ДО resultsSummary в JSON: хвостовая обрезка режет конец
  const json = JSON.stringify(snap);
  assert(json.indexOf('"reviewMarks"') < json.indexOf('"resultsSummary"'),
    "reviewMarks раньше resultsSummary");
  // при stale — флаг (номера на момент прогона)
  state.resultsStale = true;
  eq(assistant.buildSnapshot().reviewMarks.stale, true, "stale-флаг");
  state.resultsStale = false;
  // приоритет 4 уровня (v0.8): ✗/? с комментарием → голые ✗/? → ✓ с комментарием
  // → голые ✓ → заметки без вердикта; хвост режется первым
  state.results.marks = [
    { id: "p5", target: { scope: "single", model: "mA", mode: "decisions" }, verdict: null, comment: "заметка" },
    { id: "p4", target: { scope: "single", model: "mA", mode: "decisions" }, verdict: "accept", comment: "" },
    { id: "p2", target: { scope: "single", model: "mA", mode: "decisions" }, verdict: "reject", comment: "" },
    { id: "p3", target: { scope: "single", model: "mA", mode: "decisions" }, verdict: "accept", comment: "плюс" },
    { id: "p1", target: { scope: "single", model: "mA", mode: "decisions" }, verdict: "reject", comment: "причина" },
  ];
  const order = assistant.buildSnapshot().reviewMarks.items;
  eq(order.length, 5, "все пять категорий в снапшоте");
  includes(order[0], "✗ «причина»", "1) ✗ с комментарием");
  includes(order[1], "прогон 27B: ✗", "2) голый ✗");
  assert(!order[1].includes("«"), "2) без комментария");
  includes(order[2], "✓ «плюс»", "3) ✓ с комментарием");
  includes(order[3], "прогон 27B: ✓", "4) голый ✓");
  assert(!order[3].includes("«"), "4) без комментария");
  includes(order[4], "💬 «заметка»", "5) заметка без вердикта");
  state.results.marks = [];
  // пакет: резолюция по снапшоту вопросов прогона и номерам файлов
  state.results.marks = [];
  state.batch.files = [{ id: "f1", name: "a.txt" }];
  state.batch.questions = [{ id: "q1", question: "Ок?", type: "yes_no" }];
  state.batch.results = { f1: { mA: runRes({}, { q1: ansYesNo(0.8, 0.2) }) } };
  state.batch.marks = [{ id: "m4", target: { scope: "batch", file: "f1", question: "q1", model: "mA" },
    verdict: "reject", comment: "не заметил" }];
  const snap2 = assistant.buildSnapshot();
  includes(snap2.reviewMarks.items.join("\n"), "файл №1 (a.txt) × вопрос №1 × 27B: ✗ «не заметил»",
    "пункт ячейки пакета");
  // без пометок поля нет
  state.batch.marks = [];
  assert(!assistant.buildSnapshot().reviewMarks, "без пометок reviewMarks нет");
});

test("assistant: buildSnapshot v0.7 — id вопросов, распределения у ✗-ячеек, trace решений, метрики прогонов", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  state.models = [{ key: "mA", label: "Qwen A 27B", short_label: "27B", status: "running" }];
  state.questions = [
    { id: "q1", question: "Есть ли жалоба?", type: "yes_no" },
    { id: "q2", question: "Оценка раздражения", type: "score", levels: ["1", "2", "3", "4", "5"], direction: "up" },
  ];
  // решение: «Эскалация», если q1=да (P≥50%); иначе default «В архив»
  state.decision = {
    enabled: true,
    outcomes: [
      { id: "o1", label: "Эскалация", color: "red",
        rules: [{ conditions: [{ question: "q1", answer: "yes", op: "gte", threshold: 0.5 }] }] },
      { id: "o2", label: "В архив", color: "gray", isDefault: true, rules: [] },
    ],
  };
  state.results = {
    results: { mA: runRes({ duration_s: 12.3, prompt_tokens: 900, prefill_tok_s: 73 },
      { q1: ansYesNo(0.4, 0.6), q2: { type: "score", probabilities: { 1: 0.1, 2: 0.6, 3: 0.3 }, label_mass: 0.95 } }) },
    order: ["mA"], runMode: "decisions",
    questions: state.questions,
    decision: state.decision,  // снапшот правил на момент прогона
    marks: [{ id: "m1", target: { scope: "single", model: "mA", mode: "decisions", question: "q1" },
      verdict: "reject", comment: "пропустил жалобу" }],
  };
  const snap = assistant.buildSnapshot();
  // стабильный id рядом с n (сопоставление разметки/what-if), ссылки — по n
  eq(snap.questions[0].id, "q1", "id вопроса в снапшоте");
  eq(snap.questions[0].n, 1, "номер остаётся");
  // у ✗-ячейки — полное распределение, не top-ответ
  const item = snap.reviewMarks.items.find(t => t.includes("№1"));
  includes(item, "распределение: нет 60% / да 40%", "распределение в пункте ✗-ячейки");
  // trace решения: q1=да 40% < 50% → правило не сработало, default «В архив»
  assert(snap.decisionTrace, "decisionTrace в снапшоте");
  includes(snap.decisionTrace, "27B: Исход: В архив (по умолчанию)", "исход по умолчанию");
  includes(snap.decisionTrace, "40% при пороге ≥ 50%", "провалившееся условие со значением и порогом");
  // метрики прогона
  assert(snap.runs, "runs в снапшоте");
  includes(snap.runs[0], "12.3 с", "длительность");
  includes(snap.runs[0], "900 ток", "токены промпта");
  // детальные результаты single для get_result: распределения у всех ответов
  assert(snap.singleResults, "singleResults в снапшоте");
  eq(snap.singleResults["27B"][0].n, 1, "строка ответа по № вопроса");
  includes(snap.singleResults["27B"][0].distribution, "нет 60%", "распределение ответа");
  // batch-агрегат trace: счётчики исходов + частые провалы условий
  state.results.marks = [];
  state.batch.files = [{ id: "f1", name: "a.txt" }, { id: "f2", name: "b.txt" }];
  state.batch.questions = state.questions;
  state.batch.decision = state.decision;
  state.batch.results = {
    f1: { mA: runRes({}, { q1: ansYesNo(0.3, 0.7) }) },
    f2: { mA: runRes({}, { q1: ansYesNo(0.9, 0.1) }) },
  };
  const snap2 = assistant.buildSnapshot();
  includes(snap2.decisionTrace, "27B (пакет, 2 файлов): В архив×1, Эскалация×1", "счётчики исходов");
  includes(snap2.decisionTrace, "условие не прошло в 1/2", "частота провала условия");
  includes(snap2.runs.find(l => l.includes("пакет")), "2 файлов", "метрики пакета агрегированы");
  // без прогонов полей нет
  state.results = null; state.batch.results = {};
  const snap3 = assistant.buildSnapshot();
  assert(!snap3.decisionTrace && !snap3.runs, "без прогонов trace/runs отсутствуют");
});

test("assistant: чип контекста, quick-chips и автоскролл (v0.7)", async () => {
  installDom(); await resetState(); domApp();
  const calls = mockAssistantFetch({ chatModels: [{ key: "chatA", label: "Chat A", remote: false }] });
  assistant.initAssistant();
  await sleep(10);
  const chip = document.getElementById("assistant-mode");
  const chipsBox = document.getElementById("assistant-chips");
  const msgs = document.getElementById("assistant-messages");

  // пустой проект: чип «Один материал», стартовый набор из 3 чипов (v1.1)
  assistant.updateModeChip();
  assistant.renderChips();
  includes(chip.textContent, "Один материал", "чип: страница");
  assert(!chip.querySelector(".assistant-mode-dot"), "без прогонов — без точки свежести");
  includes(chipsBox.textContent, "Сгенерируй вопросы по материалу", "пустой проект: чип генерации");
  includes(chipsBox.textContent, "Что умеешь?", "пустой проект: чип возможностей");
  assert(!chipsBox.textContent.includes("Сравни"), "нет прогонов — нет чипов анализа");

  // результаты без разметки: «Что разметить (N)» + «Сравни модели» (v1.1);
  // N — число неразмеченных кандидатов (низкая уверенность 55% → 1)
  state.models = [{ key: "mA", label: "Qwen A", status: "running" }];
  state.selectedModels = new Set(["mA"]);
  state.questions = [{ id: "q1", question: "Ок?", type: "yes_no" }];
  state.results = {
    results: { mA: runRes({}, { q1: ansYesNo(0.55, 0.45) }) },
    order: ["mA"], runMode: "decisions", questions: state.questions,
  };
  assistant.renderChips();
  includes(chipsBox.textContent, "Что разметить (1)", "чип очереди со счётчиком");
  includes(chipsBox.textContent, "Сравни модели", "чип сравнения");
  assert(!chipsBox.textContent.includes("Разобрать прогон"), "без разметки — нет разбора");

  // есть прогон и разметка: чип с счётчиками и зелёной точкой, полный набор
  state.results = {
    results: { mA: runRes({}, { q1: ansYesNo(0.9, 0.1) }) },
    order: ["mA"], runMode: "decisions", questions: state.questions,
    marks: [{ id: "m1", target: { scope: "single", model: "mA", mode: "decisions", decision: true }, verdict: "accept" }],
  };
  assistant.updateModeChip();
  assistant.renderChips();
  includes(chip.textContent, "1 мод.", "чип: модели");
  includes(chip.textContent, "1 меток", "чип: метки");
  eq(chip.querySelector(".assistant-mode-dot").className.includes("fresh"), true, "зелёная точка");
  includes(chipsBox.textContent, "🔍 Разобрать прогон", "чип разбора появился");
  includes(chipsBox.textContent, "Что разметить дальше (0)", "размеченных в очереди нет");
  includes(chipsBox.textContent, "Сравнить модели", "чип сравнения");
  includes(chipsBox.textContent, "Подобрать пороги", "чип порогов");
  // stale — янтарная точка
  state.resultsStale = true;
  assistant.updateModeChip();
  eq(chip.querySelector(".assistant-mode-dot").className.includes("stale"), true, "янтарная точка при stale");
  state.resultsStale = false;

  // счётчик моделей — из состава прогона, а не из галочек бара (v0.8):
  // прогон по одной модели + две галочки → «1 мод.»
  state.selectedModels = new Set(["mA", "mB"]);
  assistant.updateModeChip();
  includes(chip.textContent, "1 мод.", "чип: модели из прогона, не галочки");
  // без результатов — честно показываем выбранные галочки
  const savedResults = state.results;
  state.results = null;
  assistant.updateModeChip();
  includes(chip.textContent, "2 мод.", "без прогона — выбранные галочки");
  state.results = savedResults;
  state.selectedModels = new Set(["mA"]);

  // клик по чипу отправляет готовый запрос
  [...chipsBox.querySelectorAll(".assistant-chip")].find(b => b.textContent.includes("Сравнить модели")).fire("click");
  await sleep(30);
  const chatCalls = assistantChatCalls(calls);
  eq(chatCalls.length, 1, "запрос ушёл");
  includes(chatCalls[0].body.message, "Сравни модели", "текст чипа = сообщение");

  // автоскролл: своя отправка — всегда вниз; стрим при проскролле вверх — не дёргает
  msgs.scrollHeight = 1000; msgs.clientHeight = 200; msgs.scrollTop = 0;
  await assistantSay("ещё вопрос");
  eq(msgs.scrollTop, 1000, "своя отправка — принудительно вниз");
  msgs.scrollTop = 0; // пользователь проскроллил вверх читать
  await assistantSay("и ещё"); // addUserMessage внутри — guarded scroll
  // force случится на отправке; проверяем guarded путь отдельно: стрим токенов
  msgs.scrollHeight = 2000; msgs.scrollTop = 0;
  // имитируем приход токена: вызов appendMsg не должен скроллить
  const div = document.createElement("div");
  div.textContent = "токен";
  msgs.appendChild(div); // прямой DOM — scrollDown не вызывается
  eq(msgs.scrollTop, 0, "без force скролл не дёргается");
});

test("assistant: diff вопросов — LCS-выравнивание: вставка в середину не сдвигает хвост", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([
    { id: "q1", question: "А?", type: "yes_no" },
    { id: "q2", question: "Б?", type: "yes_no" },
    { id: "q3", question: "В?", type: "yes_no" },
  ]);
  // replace: вставка «Новый?» между А и Б + у Б изменено описание ветки
  await assistant.handleProposal({ kind: "propose_questions", title: "t", payload: {
    mode: "replace", questions: [
      { question: "А?", type: "yes_no" },
      { question: "Новый?", type: "yes_no" },
      { question: "Б?", type: "yes_no", description_yes: "да-описание" },
      { question: "В?", type: "yes_no" },
    ] } });
  const card = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  // без спама: «без изменений: 2» (А, В), одно добавление, одно изменение (Б)
  includes(card.textContent, "без изменений: 2", "неизменные свёрнуты в счётчик");
  const del = card.querySelectorAll(".diff-del");
  eq(del.length, 0, "ничего не удалено");
  const adds = [...card.querySelectorAll(".diff-add")].map(x => x.textContent);
  eq(adds.length, 1, "одно добавление");
  const addBlock = [...card.querySelectorAll(".qb")].find(b => b.querySelector(".diff-add"));
  includes(addBlock.textContent, "Новый?", "добавлен новый вопрос");
  eq(addBlock.querySelector(".q-badge").textContent, "№2", "на позиции 2");
  const chgBlock = [...card.querySelectorAll(".qb")].find(b => b.querySelector(".q-op-chg"));
  eq(chgBlock.querySelector(".q-badge").textContent, "№2→№3", "изменён Б (старый №2 → новый №3)");
  includes(chgBlock.textContent, "да-описание", "новая формулировка «да» в diff'е");
  assert(!chgBlock.textContent.includes("В?"), "хвост не сдвинут: В? — без изменений");
  assert(!card.querySelector(".diff-warn"), "нет удалений — нет предупреждения");

  // replace с чистыми удалениями → красная пометка в stats-строке
  // «⚠ удаляется N из M» (макет 1.4; инцидент 16.10: replace 8→2 читался
  // как «добавили 2»)
  await assistant.handleProposal({ kind: "propose_questions", title: "t2", payload: {
    mode: "replace", questions: [{ question: "В?", type: "yes_no" }] } });
  const wipe = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  const stats = wipe.querySelector(".assistant-proposal-stats");
  const sdel = stats && stats.querySelector(".s-del");
  assert(sdel, "красная пометка удалений в stats");
  includes(sdel.textContent, "⚠ удаляется 2 из 3", "счётчик удалений");
  assert(!wipe.querySelector(".diff-warn"), "отдельной warn-строки больше нет — пометка в stats");
});

test("assistant: серия пробных прогонов — предыдущие карточки схлопываются (антиспам)", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  const trial = (t) => ({ title: t, questions: [], models: [], rows: [] });
  const c1 = assistant.handleTrial(trial("Гипотеза 1"));
  const c2 = assistant.handleTrial(trial("Гипотеза 2"));
  // первая схлопнута (виден только заголовок), вторая развёрнута
  const body1 = [...c1.children].filter(c => !c.classList.contains("assistant-proposal-title"));
  assert(body1.every(c => c.classList.contains("hidden")), "первая карточка схлопнута");
  assert(c1.querySelector(".assistant-proposal-title").classList.contains("assistant-expander"),
    "заголовок — развернуть");
  const body2 = [...c2.children].filter(c => !c.classList.contains("assistant-proposal-title"));
  assert(!body2.every(c => c.classList.contains("hidden")), "последняя карточка развёрнута");
  // клик по заголовку разворачивает обратно
  c1.querySelector(".assistant-proposal-title").fire("click");
  assert(!body1[0].classList.contains("hidden"), "клик разворачивает");
  // карточка с текстом между ними — не схлопывается
  assistant.handleTrial(trial("Гипотеза 3"));
  assert(!body2.every(c => c.classList.contains("hidden")) === false, "вторая схлопнута третьей");
});

// Минимальный trial-payload: 2 модели × 1 вопрос, у mB — ошибка шага.
function trialFixture(over = {}) {
  return {
    questions: [{ id: "q1", question: "Ок?", type: "yes_no" }],
    models: ["mA", "mB"],
    rows: [
      { model: "mA", label: "Model A", answers: { q1: "да 80%" },
        fullAnswers: { q1: { type: "yes_no", probabilities: { yes: 0.8, no: 0.2 } } } },
      { model: "mB", label: "Model B", error: "таймаут 60 с" },
    ],
    ...over,
  };
}

test("assistant: живая карточка пробного прогона (макет 4.2) — пилла «шаг k/n», pbar, шаги с длительностью/ошибкой; финал — терминал «Выполнен»", async () => {
  installDom(); await resetState(); domApp();
  const body = stagedSseBody();
  mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }], chatBody: body });
  assistant.initAssistant();
  await sleep(10);
  assistantSay("прогони пробно");  // стрим в полёте — события подаём чанками
  await sleep(10);
  body.push([
    { type: "tool", name: "run_trial", status: "start" },
    { type: "trial_progress", step: 1, total: 2, key: "mA", label: "Model A",
      ms: 72000, ok: true, answered: 8, of: 8 },
  ]);
  await sleep(10);
  // живая карточка (4.2): пилла, полоса, disclosure шагов, «Прервать»
  const card = feed().querySelector(".assistant-trial-progress");
  assert(card, "живая карточка вместо tool-строки");
  assert(!feed().querySelector(".assistant-note"), "tool-строки нет");
  includes(card.querySelector(".assistant-proposal-eye").textContent,
           "Пробный прогон · выполняется", "eyebrow");
  const pill = card.querySelector(".assistant-proposal-status");
  assert(pill.classList.contains("live"), "пилла live");
  includes(pill.textContent, "шаг 1/2", "счётчик шагов");
  assert(pill.querySelector(".assistant-proposal-status-dot"), "пульсирующая точка");
  const pfill = card.querySelector(".assistant-pbar");
  eq(pfill && pfill.children[0].style.width, "50%", "полоса прогресса");
  includes(card.querySelector("summary").textContent,
           "✓ Model A · ☐ ещё 1", "summary шагов");
  const stepRow = card.querySelector(".assistant-step");
  includes(stepRow.textContent, "Прогон Model A — 8/8 ответов · 1 мин 12 с",
           "шаг со счётчиком и длительностью");
  const stop = card.querySelector(".assistant-trial-stop");
  assert(stop && !stop.disabled, "кнопка «Прервать» активна");
  includes(card.textContent, "частичные результаты сохранятся", "подпись у «Прервать»");
  // шаг 2 с ошибкой (4.2а) + финал: trial-карточка, терминал «Выполнен»
  body.push([
    { type: "trial_progress", step: 2, total: 2, key: "mB", label: "Model B",
      ms: 60000, ok: false, error: "таймаут 60 с" },
    { type: "trial", trial: trialFixture() },
    { type: "tool", name: "run_trial", status: "done" },
    { type: "token", text: "Готово." },
    { type: "done" },
  ]);
  body.close();
  await sleep(20);
  const doneCard = feed().querySelector(".assistant-trial-progress");
  assert(doneCard.classList.contains("assistant-proposal-terminal"), "терминальная строка");
  includes(doneCard.textContent, "Выполнен", "пилла «Выполнен»");
  includes(doneCard.textContent, "2/2 шагов", "сводка шагов");
  includes(doneCard.textContent, "с ошибками: 1", "счётчик ошибок шагов");
  assert(feed().querySelector(".assistant-trial .assistant-trial-table"),
         "trial-карточка результата следом");
  includes(feedAnswerHtml(), "Готово.", "ответ ассистента дописан");
});

test("assistant: «Прервать» пробный прогон (макет 4.12) — abort на бэк, терминал «Прервано» с «частичный результат»/«досчитать», persist-восстановление", async () => {
  installDom(); await resetState(); domApp();
  const body = stagedSseBody();
  const calls = mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }], chatBody: body });
  assistant.initAssistant();
  await sleep(10);
  assistantSay("прогони пробно");
  await sleep(10);
  body.push([
    { type: "tool", name: "run_trial", status: "start" },
    { type: "trial_progress", step: 1, total: 2, key: "mA", label: "Model A",
      ms: 72000, ok: true, answered: 8, of: 8 },
  ]);
  await sleep(10);
  // «Прервать» → POST /api/assistant/trial/abort с session_id вкладки
  feed().querySelector(".assistant-trial-stop").fire("click");
  await sleep(10);
  const aborts = calls.filter(c => c.key === "POST /api/assistant/trial/abort");
  eq(aborts.length, 1, "один abort-запрос");
  assert(aborts[0].body.session_id, "с session_id вкладки");
  const stop = feed().querySelector(".assistant-trial-stop");
  assert(stop.disabled, "кнопка заблокирована до финала");
  // бэк отвечает частичным результатом: trial aborted + финал ответа
  body.push([
    { type: "trial", trial: trialFixture({ aborted: true, step: 1, total: 2,
                                           rows: [trialFixture().rows[0]] }) },
    { type: "tool", name: "run_trial", status: "done" },
    { type: "token", text: "Прервали — вот что успело." },
    { type: "done" },
  ]);
  body.close();
  await sleep(20);
  const card = feed().querySelector(".assistant-trial-progress");
  assert(card.classList.contains("assistant-proposal-terminal"), "терминал 4.12");
  includes(card.querySelector(".assistant-proposal-status").textContent, "Прервано");
  includes(card.textContent, "на шаге 1/2 · ответы Model A сохранены", "суть");
  const links = [...card.querySelectorAll(".assistant-link")].map(b => b.textContent);
  assert(links.includes("частичный результат") && links.includes("досчитать"),
         "оба действия");
  // «частичный результат» раскрывает trial-карточку по собранным строкам
  card.querySelector(".assistant-link").fire("click");
  const partial = feed().querySelector(".assistant-trial");
  assert(partial && !partial.classList.contains("hidden"), "частичный показан");
  includes(partial.textContent, "да 80%", "собранные ответы на месте");
  card.querySelector(".assistant-link").fire("click");
  assert(partial.classList.contains("hidden"), "повторный клик скрывает");
  // «досчитать» — честный полный перезапуск сообщением ассистенту
  card.querySelectorAll(".assistant-link")[1].fire("click");
  await sleep(10);
  const chats = assistantChatCalls(calls);
  eq(chats.length, 2, "новый ход ассистенту");
  includes(chats[1].body.message, "Перезапусти последний пробный прогон",
           "просьба о полном перезапуске");
  body.push([{ type: "token", text: "Прогоняю заново." }, { type: "done" }]);
  body.close();
  await sleep(20);
  // persist: прерванный прогон — feed-запись trialStatus:"aborted"
  const saved = localStorage.getItem("dq-assistant-chat");
  const item = JSON.parse(saved).convos.single.feed.find(i => i.trialStatus === "aborted");
  assert(item && item.trial.aborted, "запись прерванного прогона в persist");
  // восстановление из persist: терминал «Прервано» с полноценными действиями
  installDom(); await resetState(); domApp();
  localStorage.setItem("dq-assistant-chat", saved);
  mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  assistant.initAssistant();
  await sleep(10);
  const restored = feed().querySelector(".assistant-trial-progress");
  assert(restored, "карточка восстановлена");
  includes(restored.textContent, "Прервано");
  includes(restored.textContent, "на шаге 1/2", "координаты обрыва");
  assert(restored.querySelectorAll(".assistant-link").length === 2,
         "действия восстановлены");
});

test("assistant: apply append-вопросов — журнал прогресса в persist после каждой операции; восстановление «Прервано · применены k из n» (макет 1.10) и «применить оставшиеся»", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  assistant.initAssistant();
  await sleep(10);
  state.questions = [questions.normalizeQuestion({ question: "База 1?", type: "yes_no" })];
  const extra = [1, 2, 3].map(i => ({ id: "x" + i, question: `Доп ${i}?`, type: "yes_no" }));
  await assistant.handleProposal({
    id: "app1", kind: "propose_questions", title: "Дополнение",
    payload: { mode: "append", questions: extra },
  });
  const card = feed().querySelector(".assistant-proposal");
  // «Принять»: первая операция применяется и журналируется синхронно
  card.querySelector(".assistant-accept").fire("click");
  let saved = JSON.parse(localStorage.getItem("dq-assistant-chat"));
  let fi = saved.convos.single.feed.find(i => i.proposal && i.proposal.id === "app1");
  eq(fi.applyProgress.done, 1, "журнал после первой операции");
  eq(fi.applyProgress.total, 3);
  eq(state.questions.length, 2, "первый вопрос добавлен");
  // воркспейс сброшен синхронно (дебаунс kill вкладки не переживёт)
  const ws = JSON.parse(localStorage.getItem("dq-workspace"));
  eq((ws.questions || []).length, 2, "воркспейс сохранён после первой операции");
  await sleep(20);
  eq(state.questions.length, 4, "все три применены");
  saved = JSON.parse(localStorage.getItem("dq-assistant-chat"));
  fi = saved.convos.single.feed.find(i => i.proposal && i.proposal.id === "app1");
  eq(fi.status, "applied", "статус applied после финала");
  assert(!fi.applyProgress, "журнал снят");

  // Фаза 2: kill после 2-й операции — persist с applyProgress, хвост state
  // совпадает → восстановление «Прервано · применены 2 из 3» + «применить
  // оставшиеся» домечивает карточку
  installDom(); await resetState(); domApp();
  state.questions = [
    questions.normalizeQuestion({ question: "База 1?", type: "yes_no" }),
    questions.normalizeQuestion({ question: "Доп 1?", type: "yes_no" }),
    questions.normalizeQuestion({ question: "Доп 2?", type: "yes_no" }),
  ];
  const feedItem = { t: "proposal", status: "pending",
                     applyProgress: { done: 2, total: 3 },
                     proposal: { id: "app2", kind: "propose_questions",
                                 title: "Дополнение",
                                 payload: { mode: "append", questions: extra } } };
  localStorage.setItem("dq-assistant-chat", JSON.stringify({
    version: 1,
    convos: { single: { history: [], feed: [feedItem], annV: 1 },
              batch: { history: [], feed: [], annV: 1 } },
  }));
  mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  assistant.initAssistant();
  await sleep(10);
  const row = feed().querySelector(".assistant-proposal-terminal");
  assert(row, "терминальная строка «Прервано»");
  includes(row.querySelector(".assistant-proposal-status").textContent, "Прервано");
  includes(row.textContent, "применены 2 из 3 правок", "суть как в макете 1.10");
  assert(!row.querySelector(".assistant-accept"), "кнопок выбора нет");
  const resume = [...row.querySelectorAll(".assistant-link")]
    .find(b => b.textContent === "применить оставшиеся");
  assert(resume, "действие «применить оставшиеся»");
  resume.fire("click");
  await sleep(20);
  eq(state.questions.length, 4, "оставшийся вопрос применён");
  includes(row.textContent, "Применена", "пилла applied");
  saved = JSON.parse(localStorage.getItem("dq-assistant-chat"));
  fi = saved.convos.single.feed.find(i => i.proposal && i.proposal.id === "app2");
  eq(fi.status, "applied");
  assert(!fi.applyProgress, "журнал снят после досчитывания");

  // Фаза 3: хвост state НЕ совпадает с применёнными операциями (состояние
  // менялось вне карточки) — честная «Устарела» вместо «Прервано»
  installDom(); await resetState(); domApp();
  state.questions = [questions.normalizeQuestion({ question: "Другое?", type: "yes_no" })];
  localStorage.setItem("dq-assistant-chat", JSON.stringify({
    version: 1,
    convos: { single: { history: [], feed: [feedItem], annV: 1 },
              batch: { history: [], feed: [], annV: 1 } },
  }));
  mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  assistant.initAssistant();
  await sleep(10);
  const stale = feed().querySelector(".assistant-proposal-stale");
  assert(stale, "дрейф состояния — «Устарела»");
  includes(stale.textContent, "Устарела");
});

test("assistant: push о завершении прогона — строка с действием в существующем разговоре, пустой чат не засоряется", async () => {
  installDom(); await resetState(); domApp();
  state.models = [{ key: "mA", status: "running" }];
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [{ type: "token", text: "Ответ" }, { type: "done" }],
  });
  assistant.initAssistant();
  await sleep(10);
  state.results = { results: { mA: {} }, order: ["mA"], questions: [{ id: "q1" }], runMode: "answers" };

  // Фаза 1: разговора не было — завершение прогона не шумит в пустой чат
  emit("runFinished");
  eq(feed().querySelectorAll(".assistant-run-done").length, 0, "пустой чат — без строки");

  // Фаза 2: разговор есть — системная строка со сводкой и действием
  await assistantSay("привет");
  emit("runFinished");
  const line = feed().querySelector(".assistant-run-done");
  assert(line, "строка о завершении в ленте");
  includes(line.textContent, "1 мод. × 1 вопр.", "сводка прогона");
  const btn = line.querySelector(".assistant-run-done-action");
  assert(btn, "кнопка «Разобрать прогон»");

  // Фаза 3: клик по действию отправляет запрос на разбор
  const calls = mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [{ type: "token", text: "Разбор" }, { type: "done" }],
  });
  btn.fire("click");
  await sleep(30);
  const chats = assistantChatCalls(calls);
  eq(chats.length, 1, "ушёл запрос к ассистенту");
  includes(chats[0].body.message, "Разбери последний прогон", "текст запроса");
});

test("assistant: очередь pending-карточек (v1.1) — развёрнута старейшая, строки-последствия, нумерация, чип, авторазворот", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([
    { id: "q1", question: "Первый?", type: "yes_no" },
    { id: "q2", question: "Второй?", type: "yes_no" },
    { id: "q3", question: "Третий?", type: "yes_no" },
  ]);
  const chip = document.getElementById("assistant-pending");
  assert(chip.classList.contains("hidden"), "чип скрыт без pending");

  const c1 = await assistant.handleProposal({ kind: "propose_questions", title: "Правка вопросов",
    payload: { mode: "replace", questions: [
      { id: "q1", question: "Первый?", type: "yes_no" },
      { id: "q2", question: "Второй?", type: "yes_no" },
      { id: "q3", question: "Третий итоговый?", type: "yes_no" } ] } });
  const c2 = await assistant.handleProposal({ kind: "propose_decision", title: "Правила",
    payload: { outcomes: [
      { label: "Плохо", color: "red", rules: [{ conditions: [{ question: "q1", answer: "no", op: "gte", threshold: 60 }] }] },
      { label: "Ок", color: "green", isDefault: true, rules: [] } ] } });
  await sleep(10);

  // фаза 1: старейшая развёрнута, вторая — компактная строка-последствие
  assert(!c1.classList.contains("assistant-proposal-compact"), "старейшая развёрнута");
  assert(c2.classList.contains("assistant-proposal-compact"), "вторая компактна");
  const ess2 = c2.querySelector(".assistant-proposal-essence").textContent;
  includes(ess2, "Правила: 2 исхода", "суть по виду карточки");
  includes(ess2, "красный флаг — №1 «нет» ≥ 60%", "красный флаг в сути");
  includes(c2.querySelector(".assistant-proposal-queuenum").textContent, "2/2", "нумерация второй");
  // номер и в essence-строке: span рождается в compactify — пересчёт очереди
  // обязан проставить его после компактизации (баг: пустой номер у только
  // что свёрнутой карточки до следующего refresh)
  const essNum = c2.querySelector(".assistant-proposal-essence .assistant-proposal-queuenum");
  includes(essNum ? essNum.textContent : "", "2/2", "нумерация в essence-строке");
  includes(c1.querySelector(".assistant-proposal-queuenum").textContent, "1/2", "нумерация первой");
  // строка зависимости: правила при висящей правке вопросов (инцидент 18.10)
  assert(!c2.querySelector(".assistant-proposal-dep").classList.contains("hidden"),
    "строка «сначала решите карточку выше» видна");
  // зависимая pending (макет 2.3): «Принять» заблокирован до решения верхней
  assert(c2.querySelector(".assistant-accept").disabled,
    "«Принять» зависимой карточки заблокирован");
  // чип-счётчик в шапке
  assert(!chip.classList.contains("hidden"), "чип виден");
  includes(chip.textContent, "2 ждут решения", "счётчик в чипе");
  // компактная строка сохраняет кнопки решения и разворот
  assert(c2.querySelector(".assistant-accept"), "«Принять» доступна в компактной");
  assert(c2.querySelector(".assistant-proposal-expandlink"), "ссылка «развернуть»");

  // фаза 2: принятие первой разворачивает вторую (FIFO по вниманию),
  // зависимость снята, чип обновлён; правила под виртуальную нумерацию
  // НЕ протухают после применения вопросов
  c1.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  eq(state.questions.length, 3, "правка вопросов применена");
  assert(!c2.classList.contains("assistant-proposal-compact"), "вторая развернулась сама");
  assert(c2.querySelector(".assistant-proposal-dep").classList.contains("hidden"),
    "строка зависимости снята");
  includes(chip.textContent, "1 ждёт решения", "чип: осталась одна");
  assert(!c2.classList.contains("assistant-proposal-stale"),
    "карточка правил не протухла — была выпущена под новую нумерацию");
  c2.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  eq(state.decision.outcomes[0].label, "Плохо", "правила применены");
  assert(chip.classList.contains("hidden"), "чип скрыт — очередь пуста");
});

test("assistant: протухание при «Принять» в живой сессии + деструктивный гейт + восстановленные pending компактны (v1.1)", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([
    { id: "q1", question: "Первый?", type: "yes_no" },
    { id: "q2", question: "Второй?", type: "yes_no" },
  ]);

  // фаза 1: состояние изменилось после выпуска — «Принять» даёт «Устарела»
  const c1 = await assistant.handleProposal({ kind: "propose_questions", title: "Правка",
    payload: { mode: "append", questions: [{ question: "Новый?", type: "yes_no" }] } });
  await sleep(10);
  questions.setQuestions([
    { id: "q1", question: "Первый?", type: "yes_no" },
    { id: "q2", question: "Второй изменён вручную?", type: "yes_no" },
  ]);
  c1.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  includes(c1.textContent, "Устарела", "карточка протухла при принятии");
  eq(state.questions.length, 2, "протухшая не применилась");
  eq(state.questions[1].question, "Второй изменён вручную?", "ручная правка не затёрта");
  assert(c1.querySelector(".assistant-reissue"), "кнопка «Попросить перевыпустить» (warn-ghost)");

  // фаза 2: деструктивная правка (удаление 3 из 4) в компактном виде —
  // вместо «Принять» красная «Развернуть и проверить»
  questions.setQuestions([
    { id: "q1", question: "Первый?", type: "yes_no" },
    { id: "q2", question: "Второй?", type: "yes_no" },
    { id: "q3", question: "Третий?", type: "yes_no" },
    { id: "q4", question: "Четвёртый?", type: "yes_no" },
  ]);
  const cKeep = await assistant.handleProposal({ kind: "propose_run", title: "Запуск",
    payload: { scope: "single" } });
  const cDestr = await assistant.handleProposal({ kind: "propose_questions", title: "Сокращение",
    payload: { mode: "replace", questions: [{ question: "Первый?", type: "yes_no" }] } });
  await sleep(10);
  assert(cDestr.classList.contains("assistant-proposal-compact"), "деструктивная компактна (вторая в очереди)");
  includes(cDestr.querySelector(".assistant-proposal-essence").textContent,
    "⚠ удаляется 3 из 4", "цена замены в строке");
  const acceptDestr = cDestr.querySelector(".assistant-accept");
  assert(acceptDestr.classList.contains("hidden"), "«Принять» скрыта в компактной деструктивной");
  const gate = cDestr.querySelector(".assistant-destruct-expand");
  assert(gate && !gate.classList.contains("hidden"), "есть «Развернуть и проверить»");
  gate.fire("click");
  assert(!cDestr.classList.contains("assistant-proposal-compact"), "развернулась по гейту");
  assert(!acceptDestr.classList.contains("hidden"), "в развёрнутой «Принять» доступна");

  // фаза 3: pending из persist восстанавливаются компактными
  const saved = localStorage.getItem("dq-assistant-chat");
  installDom(); await resetState(); domApp();
  localStorage.setItem("dq-assistant-chat", saved);
  questions.setQuestions([
    { id: "q1", question: "Первый?", type: "yes_no" },
    { id: "q2", question: "Второй?", type: "yes_no" },
    { id: "q3", question: "Третий?", type: "yes_no" },
    { id: "q4", question: "Четвёртый?", type: "yes_no" },
  ]);
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  const restored = [...feed().querySelectorAll(".assistant-proposal")]
    .filter(c => !c.querySelector(".assistant-proposal-status.applied, .assistant-proposal-status.declined"));
  const pendingCards = [...feed().querySelectorAll(".assistant-proposal")];
  assert(pendingCards.length >= 2, "карточки восстановлены");
  const pend = pendingCards.filter(c => c.textContent.includes("Ждёт решения")
    || c.classList.contains("assistant-proposal-compact"));
  // старейшая pending развёрнута, вторая — компактная
  const compactCount = pend.filter(c => c.classList.contains("assistant-proposal-compact")).length;
  eq(compactCount, pend.length - 1, "развёрнута ровно одна — старейшая");
});

test("assistant: каркас «Рамс» (v1.2) — пилла точка+слово, кромки состояний, ярусы кнопок, терминальная строка", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([
    { id: "q1", question: "Первый?", type: "yes_no" },
    { id: "q2", question: "Второй?", type: "yes_no" },
    { id: "q3", question: "Третий?", type: "yes_no" },
  ]);

  // фаза 1: развёрнутая pending — eyebrow, пилла с точкой, янтарная кромка,
  // «Принять» — единственный solid, «Отклонить» — ghost
  const cQ = await assistant.handleProposal({ kind: "propose_questions", title: "Правка",
    payload: { mode: "append", questions: [{ question: "Новый?", type: "yes_no" }] } });
  const pill = cQ.querySelector(".assistant-proposal-status.pending");
  assert(pill, "пилла pending");
  assert(pill.querySelector(".assistant-proposal-status-dot"), "точка у пиллы pending");
  eq(pill.querySelector(".assistant-proposal-status-text").textContent,
    "Ждёт решения", "слово статуса");
  includes(cQ.querySelector(".assistant-proposal-eye").textContent,
    "набор вопросов", "eyebrow вида сущности");
  assert(cQ.classList.contains("assistant-proposal-pending-open"),
    "янтарная кромка развёрнутой pending");
  const acceptQ = cQ.querySelector(".assistant-accept");
  assert(acceptQ && !acceptQ.classList.contains("assistant-accept-danger"),
    "главное действие — обычный solid");
  assert(cQ.querySelector(".assistant-decline"), "отказ — ghost");

  // фаза 2: вторая pending (гейт прогона) — компактная строка: пилла в
  // essence, кромки нет; разворот кликом по строке → синяя кромка гейта
  const cRun = await assistant.handleProposal({ kind: "propose_run", title: "Запуск",
    payload: { scope: "single" } });
  await sleep(10);
  assert(cRun.classList.contains("assistant-proposal-compact"), "вторая в очереди — компактная");
  assert(!cRun.classList.contains("assistant-proposal-pending-open"),
    "у компактной строки кромки нет");
  eq(cRun._statusEl.parentNode, cRun.querySelector(".assistant-proposal-essence"),
    "пилла живёт в essence компактной строки");
  // клик по строке (DOM-мок без всплытия — клик прямо по карточке)
  cRun.fire("click");
  assert(!cRun.classList.contains("assistant-proposal-compact"),
    "развернулась по клику на строку");
  eq(cRun._statusEl.parentNode, cRun.querySelector(".assistant-proposal-top"),
    "пилла вернулась в верхний ряд");
  assert(cRun.classList.contains("assistant-proposal-gate"), "класс гейта прогона");
  assert(cRun.classList.contains("assistant-proposal-pending-open"),
    "у развёрнутого гейта кромка (CSS красит её синей 3px)");

  // фаза 3: деструктивная правка — стоп-кнопка danger-ghost в строке,
  // принятие только из развёрнутого вида, solid-красный с ценой в тексте
  questions.setQuestions([
    { id: "q1", question: "Первый?", type: "yes_no" },
    { id: "q2", question: "Второй?", type: "yes_no" },
    { id: "q3", question: "Третий?", type: "yes_no" },
    { id: "q4", question: "Четвёртый?", type: "yes_no" },
  ]);
  const cDestr = await assistant.handleProposal({ kind: "propose_questions",
    title: "Сокращение", payload: { mode: "replace", questions: [
      { question: "Первый?", type: "yes_no" } ] } });
  await sleep(10);
  const gate = cDestr.querySelector(".assistant-destruct-expand");
  assert(gate && !gate.classList.contains("hidden"), "стоп-кнопка гейта в строке");
  gate.fire("click");
  const acceptD = cDestr.querySelector(".assistant-accept");
  assert(acceptD.classList.contains("assistant-accept-danger"),
    "принятие деструктива — solid-красный");
  includes(acceptD.textContent, "удалить 3 вопроса", "цена в тексте кнопки");

  // фаза 4: stale в живой сессии — пилла «Устарела», кромка stale, без кнопок
  // выбора; warn-ghost перевыпуск + текстовая «Скрыть»
  cQ.querySelector(".assistant-accept").fire("click");  // fingerprint не сошёлся
  await sleep(10);
  assert(cQ.classList.contains("assistant-proposal-stale"), "stale-кромка");
  assert(!cQ.classList.contains("assistant-proposal-pending-open"),
    "pending-кромка снята");
  includes(cQ._statusEl.textContent, "Устарела", "пилла «Устарела»");
  eq(cQ._statusEl.parentNode, cQ.querySelector(".assistant-proposal-top"),
    "пилла stale в верхнем ряду");
  assert(!cQ.querySelector(".assistant-accept"), "у stale нет «Принять»");
  assert(!cQ.querySelector(".assistant-decline"), "у stale нет «Отклонить»");
  assert(cQ.querySelector(".assistant-reissue"), "warn-ghost перевыпуск");
  assert(cQ.querySelector(".assistant-card-hide"), "текстовая «Скрыть»");
  // конкретика причины (макет 1.8): вид изменившейся сущности + время
  // обнаружения (вопросы менялись в фазе 3)
  const reason = cQ.querySelector(".assistant-proposal-reason").textContent;
  includes(reason, "набор вопросов", "причина называет изменившуюся сущность");
  includes(reason, "обнаружено в", "время обнаружения");
  includes(reason, "применять её нельзя", "запрет применения");

  // фаза 4а: «Скрыть» — терминальная строка сохраняет действие перевыпуска
  // (макет 5.5), разворот возвращает его в футер
  cQ.querySelector(".assistant-card-hide").fire("click");
  const staleRow = cQ.querySelector(".assistant-term-row");
  assert(staleRow && !staleRow.classList.contains("hidden"), "строка-итог stale");
  eq(cQ._statusEl.parentNode, staleRow, "пилла «Устарела» в строке");
  const staleActs = staleRow.querySelector(".assistant-term-acts");
  assert(staleActs.querySelector(".assistant-reissue"),
    "«Попросить перевыпустить» осталось в строке после «Скрыть»");
  staleRow.fire("click");  // разворот
  assert(cQ.querySelector(".assistant-proposal-foot .assistant-reissue"),
    "при развороте действие вернулось в футер");

  // фаза 5: терминальная строка — пилла · суть · действия; разворот по клику
  cRun.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  const row = cRun.querySelector(".assistant-term-row");
  assert(row && !row.classList.contains("hidden"), "терминальная строка");
  assert(cRun.classList.contains("assistant-proposal-terminal"),
    "класс терминальной карточки");
  eq(cRun._statusEl.parentNode, row, "пилла переехала в терминальную строку");
  assert(row.querySelector(".assistant-term-sum"), "суть в строке");
  const acts = row.querySelector(".assistant-term-acts");
  assert(acts, "ряд действий");
  const expLink = acts.querySelector(".assistant-link-quiet");
  assert(expLink && expLink.textContent === "развернуть", "ссылка «развернуть» в действиях");
  row.fire("click");
  assert(!cRun.classList.contains("assistant-proposal-terminal"),
    "разворот по клику на строку");
  eq(cRun._statusEl.parentNode, cRun.querySelector(".assistant-proposal-top"),
    "пилла обратно в верхний ряд");
});

test("assistant: гейт удаления размеченных вопросов (макет 1.2/1.4) — при любой доле набора: compact-стоп с ценой, блок .destruct, пометки у строк, c-conseq", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  const mkQ = (id, text) => ({ id, question: text, type: "yes_no" });
  const cellMark = (id, qid, verdict) => ({ id, verdict, comment: "",
    target: { scope: "single", model: "mA", mode: "decisions", question: qid } });
  // правила ссылаются на №1 и №3 (по id)
  const rules13 = () => decision.setDecision({ outcomes: [
    { label: "Эскалация", color: "red", rules: [{ conditions: [
      { question: "q1", answer: "yes", op: "gte", threshold: 0.5 },
      { question: "q3", answer: "yes", op: "gte", threshold: 0.5 } ] }] },
    { label: "В архив", color: "gray", isDefault: true, rules: [] },
  ] });
  questions.setQuestions([mkQ("q1", "Первый?"),
    { id: "q2", question: "Тема?", type: "choice", options: [{ name: "А" }, { name: "Б" }] },
    mkQ("q3", "Третий?"), mkQ("q4", "Четвёртый?"), mkQ("q5", "Пятый?")]);
  rules13();
  state.models = [{ key: "mA", status: "running" }];
  // разметка по №2: 5 ✓, 3 ✗; метка другого вопроса и заметка без вердикта —
  // в цену удаления не идут
  state.results = { results: {}, order: [], runMode: "decisions",
    questions: state.questions,
    marks: [
      ...["m1", "m2", "m3", "m4", "m5"].map(id => cellMark(id, "q2", "accept")),
      ...["m6", "m7", "m8"].map(id => cellMark(id, "q2", "reject")),
      cellMark("m9", "q3", "accept"),
      { id: "m10", verdict: null, comment: "заметка",
        target: { scope: "single", model: "mA", mode: "decisions", question: "q2" } },
    ] };

  // фаза 1 (макет 1.2): удаление единственного размеченного вопроса (1 из 5) —
  // гейт при любой доле: compact-стоп, красная цена в essence
  await assistant.handleProposal({ kind: "propose_run", title: "Запуск",
    payload: { scope: "single" } });
  const cDel = await assistant.handleProposal({ kind: "propose_questions",
    title: "Чистка", payload: { mode: "replace",
      questions: [mkQ("q1", "Первый уточнённый?"), mkQ("q3", "Третий?"),
        mkQ("q4", "Четвёртый?"), mkQ("q5", "Пятый?")],
      edits: [
        { op: "update", target: "q1", question: { question: "Первый уточнённый?", type: "yes_no" } },
        { op: "remove", target: "q2" },
      ] } });
  await sleep(10);
  assert(cDel.classList.contains("assistant-proposal-compact"), "вторая в очереди — компактная");
  const essWarn = cDel.querySelector(".assistant-proposal-essence .ess-warn");
  assert(essWarn, "красная пометка цены в essence");
  includes(essWarn.textContent, "⚠ удаляется №2 из 5", "удаление с ref в essence");
  includes(essWarn.textContent, "8 меток разметки", "цена разметки в essence");
  const stop = cDel.querySelector(".assistant-destruct-expand");
  assert(stop && !stop.classList.contains("hidden"), "стоп «Развернуть и проверить»");
  assert(cDel.querySelector(".assistant-accept").classList.contains("hidden"),
    "прямого «Принять» в компактной нет");

  // развёрнутая: блок цены, пометка у строки удаления, conseq-успех,
  // solid-красная кнопка с ценой, «показать в редакторе» в подвале
  stop.fire("click");
  const destr = cDel.querySelector(".assistant-destruct");
  assert(destr, "блок цены в развёрнутой");
  includes(destr.textContent, "Удаляется №2 «Тема?»", "что удаляется");
  includes(destr.textContent, "уйдут 8 меток разметки (5 ✓, 3 ✗)", "цена по видам меток");
  includes(destr.textContent, "Принятие доступно только из этого развёрнутого вида",
    "хвост гейта");
  const delRow = [...cDel.querySelectorAll(".dl.diff-del")]
    .find(r => r.textContent.includes("№2"));
  includes(delRow.textContent, "размечено 8 ячеек", "пометка цены у строки удаления");
  const conseq = cDel.querySelector(".assistant-conseq");
  assert(conseq && !conseq.classList.contains("assistant-conseq-warn"),
    "следствие — успех (связанные вопросы не удаляются)");
  includes(conseq.textContent, "Правила решения не затронуты", "текст успеха");
  includes(conseq.textContent, "№1", "связанный вопрос перечислен");
  includes(conseq.textContent, "№3", "связанный вопрос перечислен");
  const acc = cDel.querySelector(".assistant-accept");
  assert(acc.classList.contains("assistant-accept-danger"), "solid-красный");
  eq(acc.textContent, "Принять и удалить №2 с разметкой", "цена в тексте кнопки (макет 1.2)");
  const showin = [...cDel.querySelectorAll(".assistant-proposal-actions .assistant-link-quiet")]
    .find(b => b.textContent === "показать в редакторе");
  assert(showin, "«показать в редакторе» в подвале развёрнутой (макет 1.1)");

  // фаза 2: удаление без разметки и не больше половины — гейта нет
  const cOk = await assistant.handleProposal({ kind: "propose_questions",
    title: "Без разметки", payload: { mode: "replace",
      questions: [mkQ("q1", "Первый?"), mkQ("q3", "Третий?"), mkQ("q5", "Пятый?")],
      edits: [{ op: "remove", target: "q4" }] } });
  await sleep(10);
  assert(!cOk.querySelector(".assistant-destruct"), "нет блока цены");
  assert(!cOk.querySelector(".assistant-destruct-expand"), "нет стоп-кнопки");
  assert(!cOk.querySelector(".ess-warn"), "без красной пометки в essence");
  const accOk = cOk.querySelector(".assistant-accept");
  eq(accOk.textContent, "Принять", "обычная кнопка принятия");
  assert(!accOk.classList.contains("assistant-accept-danger"), "не красная");
  const delRowOk = [...cOk.querySelectorAll(".dl.diff-del")]
    .find(r => r.textContent.includes("№4"));
  notIncludes(delRowOk.textContent, "размечено", "строка без пометки цены");

  // фаза 3 (макет 1.4): replace 9 → 2 — большинство + разметка + сирота в правилах
  questions.setQuestions([mkQ("q1", "Первый?"), mkQ("q2", "Второй?"),
    mkQ("q3", "Третий?"), mkQ("q4", "Четвёртый?"), mkQ("q5", "Пятый?"),
    mkQ("q6", "Шестой?"), mkQ("q7", "Седьмой?"), mkQ("q8", "Восьмой?"),
    mkQ("q9", "Девятый?")]);
  rules13();  // «Эскалация» ссылается на №1 и №3 — оба удаляются
  state.results.marks = [
    ...["n1", "n2", "n3"].map(id => cellMark(id, "q1", "accept")),
    ...["n4", "n5"].map(id => cellMark(id, "q1", "reject")),
    ...["n6", "n7"].map(id => cellMark(id, "q3", "reject")),
  ];
  const cWipe = await assistant.handleProposal({ kind: "propose_questions",
    title: "Пересборка", payload: { mode: "replace",
      questions: [mkQ("q2", "Второй?"), mkQ("q9", "Девятый?")] } });
  await sleep(10);
  const essWipe = cWipe.querySelector(".assistant-proposal-essence .ess-warn");
  includes(essWipe.textContent, "⚠ удаляется 7 из 9", "счётчик в compact-essence");
  includes(essWipe.textContent, "разметка 7 ячеек", "цена разметки в compact-essence");
  cWipe.querySelector(".assistant-destruct-expand").fire("click");
  const destrW = cWipe.querySelector(".assistant-destruct");
  includes(destrW.textContent, "Удаляются 7 из 9 вопросов", "заголовок цены");
  includes(destrW.textContent, "потеряна разметка 7 ячеек (3 ✓, 4 ✗)", "цена по видам меток");
  includes(destrW.textContent,
    "условие исхода «Эскалация» останется без опоры — оно ссылается на №1, №3",
    "сирота правил с конкретикой");
  eq(cWipe.querySelector(".assistant-accept").textContent,
    "Принять и удалить 7 вопросов", "кнопка массового удаления (макет 1.4)");
  includes(cWipe.querySelector(".assistant-proposal-stats .s-del").textContent,
    "⚠ удаляется 7 из 9", "красная пометка в stats развёрнутой");
  const rowQ1 = [...cWipe.querySelectorAll(".dl.diff-del")]
    .find(r => r.textContent.includes("№1"));
  includes(rowQ1.textContent, "размечено 5 ячеек", "пометка у размеченной строки");
  const rowQ4 = [...cWipe.querySelectorAll(".dl.diff-del")]
    .find(r => r.textContent.includes("№4"));
  notIncludes(rowQ4.textContent, "размечено", "неразмеченная строка — без пометки");
  const more = cWipe.querySelector("details.assistant-exp summary");
  assert(more && more.textContent.includes("… и ещё"), "длинный список свёрнут в details");
  const conseqW = cWipe.querySelector(".assistant-conseq");
  assert(conseqW.classList.contains("assistant-conseq-warn"), "следствие — warn");
  includes(conseqW.textContent, "Правила решения затронуты", "warn-текст следствия");
  includes(conseqW.textContent, "«Эскалация»", "исход с конкретикой");
  includes(conseqW.textContent, "№1", "удаляемая опора перечислена");
});

test("assistant: diff-фактология типов (v1.2, V-2) — формулировки «да»/«нет» и направление у да/нет, описания опций у выбора, уровни и направление у шкалы; «веса» нет", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([
    { id: "q1", question: "Рекомендует?", type: "yes_no", yes: "да", no: "нет" },
    { id: "q2", question: "Тема?", type: "choice", options: [
      { name: "цена", description: "тарифы" }, { name: "прочее", description: "" }] },
    { id: "q3", question: "Раздражён?", type: "score", levels: ["спокоен", "зол"], direction: "neutral" },
  ]);
  await assistant.handleProposal({ kind: "propose_questions", title: "Правки",
    payload: { mode: "replace", questions: [
      { id: "q1", question: "Рекомендует?", type: "yes_no", yes: "Да, готов", no: "нет", direction: "yes" },
      { id: "q2", question: "Тема?", type: "choice", options: [
        { name: "цена", description: "цены и тарифы" }, { name: "прочее", description: "" }] },
      { id: "q3", question: "Раздражён?", type: "score", levels: ["спокоен", "в ярости"], direction: "down" },
    ] } });
  const card = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  const blockOf = (badge) => [...card.querySelectorAll(".qb")]
    .find(b => b.querySelector(".q-badge").textContent === badge);

  // да/нет: формулировка «да» — пословно; направление — с пометкой о смысле
  const b1 = blockOf("№1");
  const yr = b1.querySelector(".yr");
  assert(yr, "строка формулировки ответа");
  includes(yr.querySelector(".yr-tag").textContent, "«да»", "тег формулировки");
  const added = [...yr.querySelectorAll(".w-add")].map(x => x.textContent).join(" ");
  includes(added, "Да,", "новая формулировка — добавленные слова");
  includes(added, "готов", "новая формулировка — добавленные слова");
  includes(b1.querySelector(".q-op").textContent, "«да», направление", "аспекты в метке");
  const dirRow = [...b1.querySelectorAll(".dl.diff-chg")]
    .find(r => r.textContent.includes("направление:"));
  assert(dirRow, "строка смены направления");
  eq(dirRow.querySelector(".w-del").textContent, "нейтрально", "старое направление");
  eq(dirRow.querySelector(".w-add").textContent, "лучше: да", "новое направление");
  includes(dirRow.textContent, "смысл ответа меняется", "пометка о смене смысла");

  // выбор: изменилось описание опции — строка «описание:» маркером ~,
  // имя без правки строки не порождает
  const b2 = blockOf("№2");
  const descRow = [...b2.querySelectorAll(".dl.diff-chg")]
    .find(r => r.textContent.includes("описание:"));
  assert(descRow, "строка изменения описания опции");
  includes(descRow.textContent, "цены и тарифы", "новое описание");
  includes(b2.textContent, "без изменений: 1 опция", "неизменная опция приглушена");

  // шкала: уровень маркером ~, направление — «смысл шкалы меняется»
  const b3 = blockOf("№3");
  const lvRow = [...b3.querySelectorAll(".dl.diff-chg")]
    .find(r => r.textContent.includes("в ярости"));
  assert(lvRow, "строка уровня шкалы");
  includes(b3.textContent, "ниже лучше", "новое направление шкалы");
  includes(b3.textContent, "смысл шкалы меняется", "пометка для шкалы");

  // легенда чтения — тихая строка в карточке; понятия «вес» в системе нет
  includes(card.querySelector(".diff-legend").textContent, "Как читать", "легенда diff'а");
  notIncludes(card.textContent, "вес", "понятие «вес» не отображается");
});

test("assistant: flink (v1.2, V-2) — hover → превью-поповер, клик и «на весь экран» → полный экран, несуществующий файл — текст", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  state.batch.files = [{ id: "f1", name: "doc.txt", size: 33, status: "ok",
    isImage: false, images: [], text: "Начало текста файла про доставку." }];
  await assistant.handleProposal({ kind: "propose_context", title: "Дописка",
    payload: { mode: "append", text: "дописка", file: "doc.txt" } });
  const card = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  const link = card.querySelector(".assistant-flink");
  assert(link, "flink на существующий файл");
  eq(link.textContent, "doc.txt", "имя файла в ссылке");

  // hover → поповер с началом текста и кнопкой полного экрана
  link.fire("mouseenter");
  const pop = document.querySelector(".assistant-flink-popover");
  assert(pop && !pop.classList.contains("hidden"), "поповер показан по hover");
  includes(pop.textContent, "Начало текста файла", "начало текста в превью");
  includes(pop.textContent, "симв.", "мета файла в превью");
  const openBtn = [...pop.querySelectorAll("button")]
    .find(b => b.textContent === "Открыть на весь экран");
  assert(openBtn, "кнопка «Открыть на весь экран» в поповере");
  openBtn.fire("click");
  const overlay = document.querySelector(".preview-overlay");
  assert(overlay && !overlay.classList.contains("hidden"), "полноэкранный просмотр открыт");
  includes(overlay.textContent, "Начало текста файла", "текст в полном экране");
  assert(pop.classList.contains("hidden"), "поповер закрыт при переходе");
  preview.closePreview();

  // клик по flink — сразу полный экран
  link.fire("click");
  assert(!overlay.classList.contains("hidden"), "клик по flink открывает полный экран");
  preview.closePreview();

  // несуществующий файл — не ссылка, обычный моно-текст
  await assistant.handleProposal({ kind: "propose_context", title: "Призрак",
    payload: { mode: "append", text: "x", file: "ghost.txt" } });
  const card2 = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  assert(!card2.querySelector(".assistant-flink"), "нет flink на несуществующий файл");
  const plain = card2.querySelector(".assistant-flink-plain");
  assert(plain && plain.textContent === "ghost.txt", "обычный моно-текст вместо ссылки");
});

test("assistant: what-if таблица ответов (макет 4.3а) — строки по размеченным ячейкам, метки ✗→✓, «ещё N», flink файла", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Ок?", type: "yes_no" }]);
  // пакет: один файл, две модели; разметка исходов: ✗ у mA (исход сменится),
  // ✓ у mB (исход совпадёт — попадёт в «ещё N без изменений»)
  state.batch.files = [{ id: "f1", name: "doc.txt", size: 10, status: "ok",
    isImage: false, images: [], text: "текст файла" }];
  state.batch.decision = { outcomes: [
    { id: "o1", label: "Хорошо", color: "green", isDefault: true, rules: [] }] };
  state.batch.results = { f1: {
    mA: runRes({}, { q1: ansYesNo(0.9, 0.1) }),
    mB: runRes({}, { q1: ansYesNo(0.2, 0.8) }),
  } };
  state.batch.marks = [
    { id: "m1", verdict: "reject", comment: "",
      target: { scope: "batch", file: "f1", model: "mA", decision: true } },
    { id: "m2", verdict: "accept", comment: "",
      target: { scope: "batch", file: "f1", model: "mB", decision: true } },
  ];
  const card = assistant.handleTrial({
    title: "Строже", batchFile: "doc.txt",
    questions: [{ id: "q1", question: "Ок?", type: "yes_no" }],
    models: ["mA", "mB"],
    rows: [
      { model: "mA", label: "Model A", answers: { q1: "да 90%" },
        fullAnswers: { q1: { type: "yes_no", probabilities: { yes: 0.9, no: 0.1 } } } },
      { model: "mB", label: "Model B", answers: { q1: "нет 80%" },
        fullAnswers: { q1: { type: "yes_no", probabilities: { yes: 0.2, no: 0.8 } } } },
    ],
    // «после»: P(да) ≥ 50% → «Плохо» — у mA исход сменился, у mB остался
    decision: { outcomes: [
      { label: "Плохо", color: "red", rules: [{ conditions: [
        { question: 1, answer: "yes", op: "gte", threshold: 50 } ] }] },
      { label: "Хорошо", color: "green", isDefault: true, rules: [] },
    ] },
  });
  const det = [...card.querySelectorAll("details.assistant-exp")]
    .find(d => d.querySelector("summary").textContent === "таблица ответов");
  assert(det, "disclosure «таблица ответов»");
  const table = det.querySelector(".assistant-trial-answers");
  assert(table, "таблица внутри");
  // строка изменённой ✗-ячейки: flink файла, было/стало, метка ✗ → ✓
  const row = table.querySelector(".ta-cell").parentNode;
  assert(row.querySelector(".assistant-flink"), "flink файла в ячейке");
  includes(row.querySelector(".ta-old").textContent, "Хорошо", "было");
  includes(row.querySelector(".ta-new").textContent, "Плохо", "стало");
  const mark = row.querySelector(".ta-mark").textContent;
  includes(mark, "✗", "была ошибка");
  includes(mark, "✓", "исправлена");
  // неизменная ✓-ячейка — приглушённым итогом
  const sameRow = table.querySelector(".ta-same");
  assert(sameRow, "итог без изменений");
  includes(sameRow.textContent, "ещё 1 ячейка без изменений", "счётчик итога");
});
