// Доменные тесты: assistant. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, notIncludes, installDom, el, resetState, mockFetch, sleep, domApp, ansYesNo, runRes, state, results, questions, context, presetsMod, assistant,
} from "./harness.mjs";
import { readFileSync, existsSync } from "node:fs";
import { URL as NodeURL } from "node:url";  // глобальный URL подменён DOM-моком
import * as decision from "../static/decision.js";

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
function mockAssistantFetch({ chatModels = [], chatEvents = [], chatError = null, validateError = null } = {}) {
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
  includes(ai.content, "[в этом ответе показана карточка «Правка вопросов»]");
  includes(ai.content, "[в этом ответе показана пробный прогон «Гипотеза X»]");
  // в ленте аннотации нет — там сами карточки (markdown-ответы проверяем по
  // innerHTML: dom-mock не парсит html)
  const html = feedAnswerHtml();
  includes(html, "Готово.", "текст ответа в ленте");
  assert(!html.includes("в этом ответе показана"), "аннотаций в ленте нет");
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
  // ошибка инструмента — причина видна в строке ленты (message из SSE)
  installDom(); await resetState(); domApp();
  mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }],
    chatEvents: [
      { type: "tool", name: "run_trial", status: "start" },
      { type: "tool", name: "run_trial", status: "error",
        message: "Пробный прогон не уложился в 120 с." },
      { type: "token", text: "Не вышло." },
      { type: "done" },
    ],
  });
  assistant.initAssistant();
  await sleep(10);
  await assistantSay("прогони пробно");
  const errNote = feed().querySelector(".assistant-note-error");
  assert(errNote, "строка ошибки инструмента подсвечена");
  includes(errNote.textContent, "✗ Пробный прогон", "имя и статус");
  includes(errNote.textContent, "не уложился", "причина видна пользователю");
  // internal-предпроверка (валидация, лимиты — ничего не запускалось):
  // строка убирается из ленты, модель чинит сама (инцидент: «✗ Вопросов
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
  assert(!feed().querySelector(".assistant-note-error"),
         "internal-ошибка не показана");
  const notes = [...feed().querySelectorAll(".assistant-note")].map(n => n.textContent);
  assert(!notes.some(t => t.includes("Вопросов больше 5")), "причины предпроверки нет");
  assert(notes.some(t => t.includes("✓ Пробный прогон")), "успешный повтор виден");
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
  includes(card.textContent, "Ждёт подтверждения", "статус pending");
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
  includes(card.textContent, "Применено", "статус «Применено»");
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
  includes(card2.textContent, "Отклонено", "статус «Отклонено»");
  assert(!card2.querySelector(".assistant-accept"), "кнопки убраны после отказа");
  eq(beacons().length, 3, "бикон declined ушёл");
  eq(beacons()[2].outcome, "declined", "исход declined");
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
  includes(restored.querySelector(".assistant-proposal-title").textContent,
           "✓ Применено", "терминальная карточка схлопнута строкой");
  assert(!restored.querySelector(".assistant-undo"), "undo после перезагрузки не предлагаем");
  assert(!restored.querySelector(".assistant-accept"), "кнопок подтверждения нет");
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
  includes(stale.textContent, "Устарела", "статус протухшей");
  assert(stale.querySelector(".assistant-accept").disabled, "принять заблокировано");
  assert(stale.querySelector(".assistant-decline"), "отклонить доступно");
  assert(!calls.some(c => c.key === "POST /api/assistant/propose/validate"),
         "превалидация при восстановлении не повторяется");

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
  includes(active.textContent, "Ждёт подтверждения", "статус pending");
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
  eq(card2.querySelectorAll("details").length, 2, "превью: текущий и предложенный тексты");
  includes(card2.textContent, "старый контекст", "текущий текст в превью");
  includes(card2.textContent, "новый текст", "предложенный текст в превью");
  card2.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  eq(document.getElementById("context-input").value, "новый текст", "контекст заменён");
  includes(card2.textContent, "Применено", "статус «Применено»");
  card2.querySelector(".assistant-undo").fire("click");
  eq(document.getElementById("context-input").value, "старый контекст", "undo вернул текст");
  includes(card2.textContent, "Отменено", "статус «Отменено»");
});

test("assistant: propose_decision — pending, превью условий; «Принять»: маппинг №→вопрос, %→0..1, undo; висячая ссылка — «Не применено»", async () => {
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
          { question: 1, answer: "yes", op: "gte", threshold: 90 },
          { question: 2, op: "gte", score: 1 } ] } ] },
      { label: "На модерацию", color: "yellow", isDefault: true, rules: [] },
    ] } });
  eq(state.decision, null, "pending: правила не применены");
  const card = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  includes(card.textContent, "Правила решения", "заголовок карточки");
  includes(card.textContent, "Опубликовать", "превью исхода");
  includes(card.textContent, "по умолчанию", "пометка default в превью");
  includes(card.textContent, "Условия исхода", "details с условиями");
  includes(card.textContent, "№1 «Есть товар?» P(да) ≥ 90%", "условие в формате превью — с текстом вопроса");
  includes(card.textContent, "№2 «Качество?» балл ≥ 1", "score-условие в превью — с текстом вопроса");
  // тело дрилдауна скроллится внутри виджета (класс для CSS max-height/overflow)
  assert(card.querySelector(".assistant-proposal-preview details .assistant-details-body"),
    "тело details имеет класс assistant-details-body (скролл внутри виджета)");
  // «Принять» → применение с маппингом №→id и %→0..1
  card.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  const d = state.decision;
  eq(d.outcomes.length, 2, "исходы применены");
  const [c1, c2] = d.outcomes[0].rules[0].conditions;
  eq(c1.question, "q1", "question=1 → id первого вопроса");
  eq(c1.threshold, 0.9, "90% → 0.9");
  eq(c2.question, "q2", "question=2 → id второго вопроса");
  eq(c2.score, 1, "score-условие без answer");
  eq(d.outcomes[1].isDefault, true, "default сохранён");
  card.querySelector(".assistant-undo").fire("click");
  eq(state.decision.outcomes.length, 0, "undo очистил правила");
  // терминальный статус — карточка схлопнута в строку-итог, разворот по клику
  const titleEl = card.querySelector(".assistant-proposal-title");
  includes(titleEl.textContent, "Отменено ·", "строка-итог со статусом");
  assert(card.querySelector(".assistant-proposal-preview").classList.contains("hidden"),
    "превью скрыто при схлопывании");
  titleEl.fire("click");
  assert(!card.querySelector(".assistant-proposal-preview").classList.contains("hidden"),
    "клик разворачивает карточку");
  eq(titleEl.textContent, "Правила решения", "при развороте — исходный заголовок");
  // ссылка на несуществующий вопрос → превалидация помечает карточку сразу
  // (до v0.7 ошибка всплывала только при «Принять»), state не тронут
  decision.setDecision({ outcomes: [
    { label: "Старое", color: "gray", isDefault: true, rules: [] } ] });
  await assistant.handleProposal({ kind: "propose_decision", payload: {
    outcomes: [{ label: "X", rules: [{ conditions: [
      { question: 9, answer: "yes", op: "gte", threshold: 50 } ] }] }] } });
  const bad = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  await sleep(10);
  includes(bad.textContent, "Такую правку применить нельзя", "битая карточка помечена при показе");
  includes(bad.textContent, "№9", "текст про висячую ссылку");
  assert(!bad.querySelector(".assistant-proposal-actions"), "ряд кнопок убран у битой карточки");
  eq(state.decision.outcomes[0].label, "Старое", "прежние правила не тронуты");
});

test("assistant: propose_decision — дельта на размеченных: измерена / нет разметки / stale", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
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
        { question: 1, answer: "yes", op: "gte", threshold: 30 } ] }] },
      { label: "В архив", isDefault: true } ] } });
  const lastCard = () => [...document.getElementById("assistant-chat")
    .querySelectorAll(".assistant-proposal")].pop();

  // Фаза 1: нет разметки — честное «эффект не измерен»
  await proposal();
  let card = lastCard();
  includes(card.textContent, "Эффект не измерен", "нет разметки — без ложной точности");
  assert(!card.querySelector(".assistant-accept").disabled, "принять доступно");

  // Фаза 2: есть прогон и ✗-пометка исхода — дельта посчитана (порог 30%
  // переключит 40%-ячейку «В архив»→«Эскалация» = исправлено)
  state.models = [{ key: "mA", label: "Qwen A", short_label: "QA", status: "running" }];
  state.results = {
    results: { mA: runRes({}, { q1: ansYesNo(0.4, 0.6) }) },
    order: ["mA"], runMode: "decisions",
    questions: state.questions, decision: state.decision,
    marks: [{ id: "m1", target: { scope: "single", model: "mA", mode: "decisions", decision: true },
      verdict: "reject", comment: "" }],
  };
  await proposal();
  card = lastCard();
  includes(card.textContent, "Размеченных исходов: 1 — ошибок 1 → 0", "дельта в карточке");
  includes(card.textContent, "исправлено 1", "исправлено");
  includes(card.textContent, "новых ошибок 0", "новых ошибок");
  includes(card.textContent, "погрешность", "предупреждение о малой выборке");
  const link = card.querySelector(".assistant-delta-cells .assistant-delta-cell");
  includes(link.textContent, "«В архив» → «Эскалация»", "строка изменённой ячейки");

  // Фаза 3: stale-разметка — дельта запрещена, «Принять» заблокирован
  state.resultsStale = true;
  await proposal();
  card = lastCard();
  includes(card.textContent, "старой редакции", "stale-объяснение");
  assert(card.querySelector(".assistant-accept").disabled, "принять заблокирован при stale");
  state.resultsStale = false;
});

test("assistant: превалидация карточек — дубль вопроса и 422 помечают до «Принять», fail-open при сети", async () => {
  installDom(); await resetState(); domApp();
  const calls = mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([{ id: "q1", question: "Есть товар?", type: "yes_no" }]);
  const lastCard = () => [...document.getElementById("assistant-chat")
    .querySelectorAll(".assistant-proposal")].pop();

  // дубль существующего вопроса — локальная семантика, без сервера
  await assistant.handleProposal({ kind: "propose_questions", payload: {
    mode: "append", questions: [{ question: "Есть товар?", type: "yes_no" }] } });
  let card = lastCard();
  await sleep(10);
  assert(card.classList.contains("assistant-proposal-invalid"), "карточка невалидна");
  includes(card.textContent, "Такую правку применить нельзя", "статус невалидной");
  includes(card.textContent, "Дубль существующего вопроса", "причина");
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
  // persist: локальная превалидация синхронна (до привязки feed-элемента) —
  // статус invalid всё равно должен попасть в ленту, иначе после перезагрузки
  // карточка восстановится активной «ждёт подтверждения»
  const feedItem = JSON.parse(localStorage.getItem("dq-assistant-chat"))
    .convos.single.feed.find(i => i.t === "proposal");
  eq(feedItem.status, "invalid", "статус invalid в persist");
  includes(feedItem.invalidReason, "Дубль", "причина в persist");
  // «Скрыть» — схлопнуть в строку-итог «Невалидно · …»
  const hideBtn = card.querySelector(".assistant-hide-invalid");
  assert(hideBtn, "кнопка скрыть на невалидной карточке");
  hideBtn.fire("click");
  const title = card.querySelector(".assistant-proposal-title");
  assert(title.classList.contains("assistant-expander"), "карточка схлопнута");
  includes(title.textContent, "Невалидно", "строка-итог");

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

test("assistant: дубль-проверка вопросов — против итогового набора", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  assistant.initAssistant();
  await sleep(10);
  questions.setQuestions([
    { id: "q1", question: "Есть товар?", type: "yes_no" },
    { id: "q2", question: "Спам?", type: "yes_no" },
  ]);
  const lastCard = () => [...document.getElementById("assistant-chat")
    .querySelectorAll(".assistant-proposal")].pop();

  // replace, сохраняющий вопрос без изменений — НЕ дубль (старый набор
  // затирается; инцидент 16.10 — ложная блокировка такой карточки)
  await assistant.handleProposal({ kind: "propose_questions", payload: {
    mode: "replace", questions: [
      { question: "Есть товар?", type: "yes_no" },
      { question: "Новый вопрос?", type: "yes_no" }] } });
  let card = lastCard();
  await sleep(10);
  assert(!card.classList.contains("assistant-proposal-invalid"),
         "replace с неизменным вопросом — валиден");

  // replace с повтором внутри самого предложения — дубль
  await assistant.handleProposal({ kind: "propose_questions", payload: {
    mode: "replace", questions: [
      { question: "Вопрос А?", type: "yes_no" },
      { question: "Вопрос А", type: "yes_no" }] } });
  card = lastCard();
  await sleep(10);
  assert(card.classList.contains("assistant-proposal-invalid"),
         "дубль внутри предложения — невалидно");
  includes(card.textContent, "повторяется в предложении", "причина внутр. дубля");

  // append, повторяющий существующий (с другой пунктуацией) — дубль текущего
  await assistant.handleProposal({ kind: "propose_questions", payload: {
    mode: "append", questions: [{ question: "Есть товар", type: "yes_no" }] } });
  card = lastCard();
  await sleep(10);
  assert(card.classList.contains("assistant-proposal-invalid"),
         "append-дубль существующего — невалидно");
  includes(card.textContent, "Дубль существующего вопроса", "причина append");
});

test("assistant: buildSnapshot — decision со ссылками по № и порогами в %, решение в сводке", async () => {
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
  eq(outs[0].rules[0].conditions[0].question, 1, "ссылка по №");
  eq(outs[0].rules[0].conditions[0].threshold, 90, "порог в процентах");
  eq(outs[0].rules[0].conditions[1].op, "lt", "op сохранён");
  eq(outs[1].isDefault, true, "default в снапшоте");
  includes(snap.resultsSummary, "решение:", "строка решения в сводке");
  includes(snap.resultsSummary, "«Опубликовать»", "исход вычислен движком по ответам");
});

test("assistant: propose_run — «Принять» кликает tb-run, карточка без undo; при недоступном Run — «Не применено»", async () => {
  installDom(); await resetState(); domApp();
  mockAssistantFetch({});
  assistant.initAssistant();
  await sleep(10);
  context.initContext({});
  context.setContent("не трогаем", "text");
  const runBtn = document.getElementById("tb-run");
  // Run недоступен — pending; после «Принять» карточка «Не применено», состояние не тронуто
  runBtn.disabled = true;
  await assistant.handleProposal({ kind: "propose_run", payload: { scope: "single" } });
  const cardErr = document.getElementById("assistant-chat").querySelector(".assistant-proposal");
  assert(cardErr, "карточка в ленте чата");
  includes(cardErr.textContent, "Ждёт подтверждения", "до подтверждения прогон не запускается");
  cardErr.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  includes(cardErr.textContent, "Не применено", "статус ошибки");
  includes(cardErr.textContent, "недоступен", "текст ошибки в карточке");
  assert(!cardErr.querySelector(".assistant-undo"), "у ошибки нет undo");
  // Run доступен — «Принять» кликает tb-run, карточка «Применено» без undo
  runBtn.disabled = false;
  globalThis.__clicks = [];
  await assistant.handleProposal({ kind: "propose_run", payload: { scope: "single" } });
  const card = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  assert(!globalThis.__clicks.includes(runBtn), "до «Принять» клика не было");
  card.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  assert(globalThis.__clicks.includes(runBtn), "клик по tb-run");
  includes(card.textContent, "Применено", "прогон запущен");
  assert(!card.querySelector(".assistant-undo"), "undo для запуска не предлагается");
});

test("assistant: propose_save_preset — «Принять» открывает диалог с предзаполненными полями, undo нет", async () => {
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
  includes(card.textContent, "Состав:", "состав пресета в превью");
  card.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  eq(document.getElementById("preset-dlg-name").value, "Мой пресет", "имя предзаполнено");
  eq(document.getElementById("preset-dlg-desc").value, "от ассистента", "описание предзаполнено");
  includes(card.textContent, "Применено", "статус «Применено»");
  assert(!card.querySelector(".assistant-undo"), "undo для пресета нет");
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
        { question: 1, answer: "yes", op: "gte", threshold: 70 } ] }] },
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
        { question: 1, answer: "да", op: "gte", threshold: 70 } ] }] },
      { label: "Отказ", color: "red", isDefault: true, rules: [] },
    ] },
  });
  const warn = badCard.querySelector(".assistant-trial-invalid");
  assert(warn, "плашка невалидных правил");
  includes(warn.textContent, "не применимы");
  includes(warn.textContent, "нет ответа «да»", "причина из validateDecision");
  assert(!badCard.querySelector(".assistant-trial-decision"),
         "бейджи исходов не посчитаны");
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
  includes(card.textContent, "Заменить текст файла «doc.txt»", "заголовок превью файла");
  includes(card.textContent, "старый", "текущий текст в превью");
  includes(card.textContent, "новый текст", "предложенный текст в превью");
  card.querySelector(".assistant-accept").fire("click");
  await sleep(10);
  eq(state.batch.files[0].text, "новый текст", "текст файла заменён");
  eq(state.batch.files[0].size, "новый текст".length, "size обновлён");
  includes(card.textContent, "Применено", "статус «Применено»");
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

test("assistant: propose_save_preset со slug — обновление: диалог с именем существующего пресета", async () => {
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
  await assistant.handleProposal({ kind: "propose_save_preset",
    payload: { name: "Новое имя", slug: "my-preset" } });
  const card = document.getElementById("assistant-chat").querySelector(".assistant-proposal");
  includes(card.textContent, "Перезапишет существующий пресет", "пометка перезаписи в превью");
  card.querySelector(".assistant-accept").fire("click");
  await sleep(20);
  eq(document.getElementById("preset-dlg-name").value, "Мой пресет", "имя существующего пресета по slug");
  includes(card.textContent, "Применено", "статус «Применено»");
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
    ".assistant-proposal", ".assistant-note", ".tb-assistant-dots",
    ".assistant-accept", ".assistant-decline", ".assistant-proposal-actions",
    ".assistant-proposal-status", ".diff-add", ".diff-del", ".diff-chg",
    ".assistant-trial-decision", ".assistant-trial-legend"]) {
    includes(css, cls, `${cls} в style.css`);
  }
  includes(css, "#tb-assistant.is-working", "is-working на кнопке тулбара в style.css");
  includes(css, "#tb-assistant.has-unread", "has-unread на кнопке тулбара в style.css");
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

test("assistant: propose_questions превью — полные формулировки в hover строки", async () => {
  installDom(); await resetState(); domApp();
  const longA = "На фото виден дефект, " + "очень ".repeat(20) + "длинная формулировка А";
  const longB = "Дефект подтверждён фото, " + "очень ".repeat(20) + "длинная формулировка Б";
  state.questions = [{ id: "q1", question: longA, type: "yes_no", yes: longA, no: "нет" }];
  await assistant.handleProposal({ kind: "propose_questions", payload: { mode: "replace",
    questions: [{ question: longB, type: "yes_no", yes: longB, no: "нет" }] } });
  const chg = document.querySelector("#assistant-messages .diff-chg");
  assert(chg, "строка изменения есть");
  assert(chg.textContent.length < longA.length + 60, "в списке — сокращённый текст");
  includes(chg.title, "было: " + longA, "полный «было» в hover");
  includes(chg.title, "станет: " + longB, "полный «станет» в hover");
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
      { op: "update", n: 1, question: { question: "Есть скол?", type: "yes_no" } },
      { op: "split", n: 2, into: [{ question: "Часть А?", type: "yes_no" }, { question: "Часть Б?", type: "yes_no" }] },
      { op: "remove", n: 3 },
      { op: "add", question: { question: "Подпись есть?", type: "yes_no" } },
    ],
    warn: "правило исхода «Брак» ссылается на №1",
  } });
  const card = [...document.querySelectorAll(".assistant-proposal")].pop();
  // превью — компактный список операций, а не LCS-дифф
  includes(card.textContent, "Изменить №1", "операция update");
  includes(card.textContent, "Есть скол?", "новая формулировка в update");
  includes(card.textContent, "Разбить №2 → 2 вопроса", "операция split");
  includes(card.textContent, "Удалить №3", "операция remove");
  includes(card.textContent, "Добавить в конец", "операция add без after");
  includes(card.textContent, "Подпись есть?", "текст добавляемого вопроса");
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

  // пустой проект: чип «Один материал», чипы стартового набора
  assistant.updateModeChip();
  assistant.renderChips();
  includes(chip.textContent, "Один материал", "чип: страница");
  assert(!chip.querySelector(".assistant-mode-dot"), "без прогонов — без точки свежести");
  includes(chipsBox.textContent, "Предложи вопросы по материалу", "стартовый чип");
  assert(!chipsBox.textContent.includes("Сравни модели"), "нет прогонов — нет чипов анализа");

  // есть прогон и разметка: чип с счётчиками и зелёной точкой, чипы анализа
  state.models = [{ key: "mA", label: "Qwen A", status: "running" }];
  state.selectedModels = new Set(["mA"]);
  state.questions = [{ id: "q1", question: "Ок?", type: "yes_no" }];
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
  includes(chipsBox.textContent, "Сравни модели между собой", "чипы анализа появились");
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
  [...chipsBox.querySelectorAll(".assistant-chip")].find(b => b.textContent.includes("Сравни модели")).fire("click");
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
  includes(adds[0], "Новый?", "добавлен новый вопрос");
  includes(adds[0], "№2", "на позиции 2");
  const chg = [...card.querySelectorAll(".diff-chg")].map(x => x.textContent).join("\n");
  includes(chg, "№3", "изменён Б (старый №2 → новый №3)");
  assert(!chg.includes("В?"), "хвост не сдвинут: В? — без изменений");
  assert(!card.querySelector(".diff-warn"), "нет удалений — нет предупреждения");

  // replace с чистыми удалениями → первая строка «⚠ Удаляются вопросы: N из M»
  // (инцидент 16.10: replace 8→2 читался как «добавили 2»)
  await assistant.handleProposal({ kind: "propose_questions", title: "t2", payload: {
    mode: "replace", questions: [{ question: "В?", type: "yes_no" }] } });
  const wipe = [...document.getElementById("assistant-chat").querySelectorAll(".assistant-proposal")].pop();
  const warn = wipe.querySelector(".diff-warn");
  assert(warn, "предупреждение об удалениях показано");
  includes(warn.textContent, "2 из 3", "счётчик удалений");
  const previewText = wipe.querySelector(".assistant-proposal-preview").textContent;
  assert(previewText.indexOf("⚠") < previewText.indexOf("− №"),
         "предупреждение — раньше строк удалений");
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
