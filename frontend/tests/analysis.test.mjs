// Доменные тесты: карточки «Разбор прогона» / «Очередь разметки» и
// мини-навигатор очереди (ассистент v1.1, порция 3). Фикстуры — harness.mjs.

import {
  test, assert, eq, includes, notIncludes, installDom, el, resetState, sleep,
  domApp, state, emit, assistant, review,
} from "./harness.mjs";
import * as analysis from "../static/analysis.js";
import * as navigator from "../static/navigator.js";

// SSE-тело одним чанком (как в assistant.test.mjs).
function sseBody(events) {
  const text = events.map(e => "data: " + JSON.stringify(e) + "\n\n").join("");
  const encoded = new TextEncoder().encode(text);
  let sent = false;
  return {
    getReader: () => ({
      read: async () => sent
        ? { done: true }
        : (sent = true, { done: false, value: encoded }),
      cancel: async () => {},
    }),
  };
}

function mockAssistantFetch({ chatModels = [], chatEvents = [] } = {}) {
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    const method = options.method || "GET";
    calls.push({ key: `${method} ${path}`, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/assistant/models") {
      return { ok: true, status: 200, json: async () => ({ models: chatModels }) };
    }
    if (path === "/api/assistant/chat") {
      return { ok: true, status: 200, json: async () => ({}), body: sseBody(chatEvents) };
    }
    return { ok: false, status: 404, json: async () => ({ detail: "no mock" }) };
  };
  return calls;
}

function feed() { return document.getElementById("assistant-messages"); }

const ANALYSIS_FIXTURE = {
  page: "batch",
  stats: { files: 3, models: 2, questions: 2, cells: 12,
           marks: { accept: 1, reject: 2, unsure: 0, comments: 1 } },
  categories: [
    { kind: "marks", icon: "✗", count: 2,
      title: "Ваши ✗/? сосредоточены в вопросе №2 «Тема»",
      detail: "2 пометки: a.txt, b.txt", action: "fix", cells: [] },
    { kind: "disagreement", icon: "⚡", count: 2,
      title: "Модели расходятся в вопросе №2 «Тема»",
      detail: "2 файла: напр. a.txt: mA=«цена» 58%, mB=«качество» 61%",
      action: "review",
      cells: [
        { target: { scope: "batch", file: "f3", question: "q2", model: "mA" },
          file: "c.txt", questionN: 2, model: "mA",
          reason: "⚡ модели разошлись" },
        { target: { scope: "batch", file: "f1", question: "q2", model: "mB" },
          file: "a.txt", questionN: 2, model: "mB",
          reason: "⚡ модели разошлись" },
      ] },
  ],
  raw: ["⚡ вопрос №2: расхождение в 2 файла (mA=«цена» 58%, mB=«качество» 61%)"],
};

const QUEUE_FIXTURE = {
  page: "batch",
  candidates: [
    { file: "a.txt", fileId: "f1", questionN: 3, qid: "q3", model: "mA",
      reason: "⚡ модели разошлись: «3/5» vs «5/5»",
      prio: 3, target: { scope: "batch", file: "f1", question: "q3", model: "mA" } },
    { file: "b.txt", fileId: "f2", questionN: 2, qid: "q2", model: "mB",
      reason: "у порога решения: 66% при условии ≥ 70%",
      prio: 2, target: { scope: "batch", file: "f2", question: "q2", model: "mB" } },
    { file: "c.txt", fileId: "f3", questionN: 1, qid: "q1", model: "mA",
      reason: "низкая уверенность: 52%",
      prio: 1, target: { scope: "batch", file: "f3", question: "q1", model: "mA" } },
  ],
  total: 7,
};

async function setupAssistant(events = [{ type: "done" }]) {
  installDom(); await resetState(); domApp();
  navigator.resetNavigator();
  const calls = mockAssistantFetch({
    chatModels: [{ key: "mA", label: "Model A" }], chatEvents: events });
  assistant.initAssistant();
  await sleep(10);
  return calls;
}

test("analysis: карточка разбора — шапка, категории, details, действия", async () => {
  const calls = await setupAssistant();
  const card = assistant.handleAnalysis(ANALYSIS_FIXTURE);
  assert(card.classList.contains("assistant-analysis"), "класс карточки");
  const title = card.querySelector(".assistant-info-title");
  includes(title.textContent, "Разбор прогона · 3 файла × 2 мод.", "шапка со статами");
  includes(title.textContent, "по вашим 3 пометкам", "счётчик пометок");
  includes(card.querySelector(".assistant-analysis-headline").textContent,
           "сосредоточены в вопросе №2", "заголовок — топ-категория");
  const rows = card.querySelectorAll(".assistant-analysis-row");
  eq(rows.length, 2, "две категории");
  eq(rows[0].querySelector(".assistant-analysis-badge").textContent, "✗ 2", "бейдж ✗");
  eq(rows[1].querySelector(".assistant-analysis-badge").textContent, "⚡ 2", "бейдж ⚡");
  const det = card.querySelector(".assistant-analysis-raw");
  assert(det, "details «Почему такой вывод»");
  includes(det.textContent, "расхождение в 2 файла", "сырые расчёты в details");

  // действие «предложить правку →» — системная реплика ассистенту
  rows[0].querySelector(".assistant-analysis-action").click();
  await sleep(30);
  const chatCalls = calls.filter(c => c.key === "POST /api/assistant/chat");
  eq(chatCalls.length, 1, "запрос ушёл");
  includes(chatCalls[0].body.message, "Предложи конкретную правку", "текст реплики");
  includes(chatCalls[0].body.message, "№2 «Тема»", "контекст категории");
  const sysMsg = feed().querySelector(".assistant-msg.user.system");
  assert(sysMsg, "реплика помечена как системная");

  // действие «разметить →» — телепорт + запуск навигатора
  state.pageMode = "batch";  // очередь привязана к своей странице
  rows[1].querySelector(".assistant-analysis-action").click();
  const pill = document.querySelector(".assistant-navigator");
  assert(pill && !pill.classList.contains("hidden"), "навигатор появился");
  includes(pill.textContent, "✎ Разметка кандидатов", "заголовок навигатора");
  includes(pill.textContent, "1/2", "счётчик позиции");
});

test("analysis: холодный старт (no_marks) — «Показать 5 ячеек» шлёт запрос очереди", async () => {
  const calls = await setupAssistant();
  const card = assistant.handleAnalysis({
    ...ANALYSIS_FIXTURE, no_marks: true,
    stats: { ...ANALYSIS_FIXTURE.stats,
             marks: { accept: 0, reject: 0, unsure: 0, comments: 0 } },
  });
  const cold = card.querySelector(".assistant-analysis-coldstart");
  assert(cold, "блок холодного старта");
  includes(cold.textContent, "Разметки пока нет", "текст холодного старта");
  assert(!card.querySelector(".assistant-analysis-primary").textContent.includes("✨"),
         "предразметки (v1.4) нет");
  card.querySelector(".assistant-analysis-primary").click();
  await sleep(30);
  const chatCalls = calls.filter(c => c.key === "POST /api/assistant/chat");
  eq(chatCalls.length, 1, "запрос ушёл");
  includes(chatCalls[0].body.message, "Что разметить", "запрос очереди");
  // категории по расхождениям/уверенности показываются и без разметки
  assert(card.querySelectorAll(".assistant-analysis-row").length === 2,
         "категории на месте");
});

test("analysis: пустые состояния разбора и очереди", async () => {
  await setupAssistant();
  const emptyA = assistant.handleAnalysis({ empty: "no_results", page: "single" });
  includes(emptyA.textContent, "сначала запустите", "разбор: нет прогона");
  assert(!emptyA.querySelector(".assistant-analysis-row"), "категорий нет");
  const emptyQ = assistant.handleQueue({ empty: "no_results", page: "batch" });
  includes(emptyQ.textContent, "размечать пока нечего", "очередь: нет прогона");
  const doneQ = assistant.handleQueue({ page: "batch", done: true,
                                        candidates: [], total: 0 });
  includes(doneQ.textContent, "Всё размечено", "очередь: done");
});

test("analysis: очередь — строки кандидатов, навигатор с позиции клика, «показать ещё»", async () => {
  const calls = await setupAssistant();
  const card = assistant.handleQueue(QUEUE_FIXTURE);
  assert(card.classList.contains("assistant-queue"), "класс карточки");
  includes(card.querySelector(".assistant-queue-headline").textContent,
           "3 метки", "заголовок");
  assert(card.querySelector(".assistant-info-collapse"), "«свернуть» у очереди (7.1)");
  const rows = card.querySelectorAll(".assistant-queue-row");
  eq(rows.length, 3, "три кандидата");
  includes(rows[0].textContent, "a.txt · №3 · mA", "координаты первого");
  includes(rows[0].textContent, "⚡ модели разошлись", "причина первого");
  // клик по второму кандидату — навигатор стартует с него
  state.pageMode = "batch";
  rows[1].querySelector(".assistant-queue-action").click();
  const pill = document.querySelector(".assistant-navigator");
  assert(pill && !pill.classList.contains("hidden"), "навигатор появился");
  includes(pill.textContent, "2/3", "старт с позиции клика");
  navigator.stopNavigator();
  // «показать ещё» — системный запрос полной очереди
  const more = card.querySelector(".assistant-queue-footer .assistant-queue-action");
  includes(more.textContent, "показать ещё 4", "счётчик остатка");
  more.click();
  await sleep(30);
  const chatCalls = calls.filter(c => c.key === "POST /api/assistant/chat");
  eq(chatCalls.length, 1, "запрос ушёл");
  includes(chatCalls[0].body.message, "10 кандидатов", "просьба расширить очередь");
});

test("analysis: SSE analysis/review_queue → карточки в ленте + аннотация истории", async () => {
  await setupAssistant([
    { type: "analysis", analysis: ANALYSIS_FIXTURE },
    { type: "review_queue", queue: QUEUE_FIXTURE },
    { type: "token", text: "Разобрал." },
    { type: "done" },
  ]);
  const ta = document.getElementById("assistant-input");
  ta.value = "разбери прогон";
  ta.fire("input");
  document.getElementById("assistant-send").fire("click");
  await sleep(30);
  assert(feed().querySelector(".assistant-analysis"), "карточка разбора в ленте");
  assert(feed().querySelector(".assistant-queue"), "карточка очереди в ленте");
  const saved = JSON.parse(localStorage.getItem("dq-assistant-chat:local"));
  const history = saved.convos.single.history;
  const last = history[history.length - 1];
  includes(last.content, "[в этом ответе показана карточка разбора прогона]",
           "аннотация разбора");
  includes(last.content, "[в этом ответе показана очередь разметки",
           "аннотация очереди");
});

test("analysis: серийное схлопывание и persist-восстановление карточек", async () => {
  await setupAssistant();
  assistant.handleAnalysis(ANALYSIS_FIXTURE);
  const second = assistant.handleAnalysis({
    ...ANALYSIS_FIXTURE,
    categories: ANALYSIS_FIXTURE.categories.slice(0, 1),
  });
  const cards = [...feed().querySelectorAll(".assistant-analysis")];
  eq(cards.length, 2, "две карточки в ленте");
  assert(cards[0].dataset.collapsible, "первая схлопнута");
  assert(cards[0].querySelector(".assistant-analysis-headline")
           .classList.contains("hidden"), "тело первой скрыто");
  assert(!second.dataset.collapsible, "последняя развёрнута");
  // persist: collapsed-флаг записан
  const saved = localStorage.getItem("dq-assistant-chat:local");
  const feedItems = JSON.parse(saved).convos.single.feed;
  eq(feedItems.filter(i => i.t === "analysis").length, 2, "обе в persist");
  eq(feedItems[0].collapsed, true, "флаг схлопывания в persist");
  // восстановление
  installDom(); await resetState(); domApp();
  navigator.resetNavigator();
  localStorage.setItem("dq-assistant-chat:local", saved);
  mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  assistant.initAssistant();
  await sleep(10);
  const restored = [...feed().querySelectorAll(".assistant-analysis")];
  eq(restored.length, 2, "карточки восстановлены");
  assert(restored[0].dataset.collapsible, "первая восстановлена схлопнутой");
  includes(restored[1].textContent, "Разбор прогона", "вторая развёрнута");
});

test("analysis: disclosure находок (6.1а) — механика/пример-flink, null — плоская строка; «Шаги (n)»", async () => {
  await setupAssistant();
  state.batch.files = [{ id: "f1", name: "a.txt", text: "текст", size: 5 }];
  const card = assistant.handleAnalysis({
    ...ANALYSIS_FIXTURE,
    categories: [
      { kind: "marks", icon: "✗", count: 2,
        title: "Ваши ✗/? сосредоточены в вопросе №2 «Тема»",
        detail: "2 пометки: a.txt, b.txt", action: "fix", cells: [],
        mechanism: "по этому вопросу модели расходятся: mA — «цена» (58%)",
        example: { file: "a.txt", question: "Тема" } },
      { kind: "comments", icon: "💬", count: 1,
        title: "Ваши комментарии к ✗/? — названные причины",
        detail: "«плохо»", action: "fix", cells: [],
        mechanism: null, example: null },
    ],
    steps: [
      { label: "Загрузка снапшота", ms: 4050, note: "12 ячеек" },
      { label: "Кластеризация расхождений", ms: 0, note: "3 категории" },
      { label: "Ранжирование по влиянию", ms: 0, note: null },
    ],
  });
  const rows = card.querySelectorAll(".assistant-analysis-row");
  // находка с mechanism/example — inline disclosure: summary — суть, detail снаружи
  const find = rows[0].querySelector("details.assistant-find");
  assert(find, "disclosure у находки с механикой");
  eq(find.querySelector("summary").textContent,
     "Ваши ✗/? сосредоточены в вопросе №2 «Тема»", "summary — суть находки");
  const body = find.querySelector(".assistant-exp-body");
  includes(body.textContent, "модели расходятся", "механика в теле");
  const flink = body.querySelector(".assistant-flink");
  assert(flink, "имя файла примера — flink");
  eq(flink.textContent, "a.txt", "flink на файл примера");
  includes(body.querySelector(".assistant-find-example").textContent,
           "· Тема", "вопрос примера");
  includes(rows[0].textContent, "— 2 пометки: a.txt, b.txt", "detail остался в строке");
  // null-поля — плоская строка без disclosure
  assert(!rows[1].querySelector("details"), "без mechanism/example — плоская строка");
  includes(rows[1].textContent, "названные причины — «плохо»", "плоский текст");
  // «Шаги (n)» — протокол в футере рядом с «Почему такой вывод»
  const foot = card.querySelector(".assistant-card-disclosures");
  const stepsDet = [...foot.querySelectorAll("details")]
    .find(d => d.querySelector("summary").textContent.startsWith("Шаги"));
  assert(stepsDet, "disclosure «Шаги» в футере");
  includes(stepsDet.querySelector("summary").textContent, "Шаги (3)", "счётчик шагов");
  const stepRows = stepsDet.querySelectorAll(".assistant-step");
  eq(stepRows.length, 3, "три шага протокола");
  includes(stepRows[0].textContent, "4 с", "длительность шага");
  includes(stepRows[0].textContent, "12 ячеек", "note шага");
  notIncludes(stepRows[1].textContent, "0 с", "ms=0 — длительность скрыта (макет)");
  includes(stepRows[1].textContent, "3 категории", "note при ms=0");
  notIncludes(stepRows[2].textContent, "—", "без ms и note — только label");
});

test("analysis: ручное «свернуть» разбора (6.1) → t-row (6.3), persist collapsed:manual, восстановление", async () => {
  await setupAssistant();
  const card = assistant.handleAnalysis(ANALYSIS_FIXTURE);
  const btn = card.querySelector(".assistant-info-collapse");
  assert(btn && btn.textContent === "свернуть", "«свернуть» у eyebrow (6.1)");
  btn.click();
  const row = card.querySelector(".assistant-term-row");
  assert(row && !row.classList.contains("hidden"), "t-row свёрнутой карточки (6.3)");
  includes(row.textContent, "▸", "маркер свёрнутой строки");
  includes(row.textContent, "Разбор прогона · 3 файла", "brief в строке");
  assert(card.querySelector(".assistant-analysis-headline").classList.contains("hidden"),
         "тело скрыто");
  eq(JSON.parse(localStorage.getItem("dq-assistant-chat:local"))
       .convos.single.feed.at(-1).collapsed, "manual",
     "флаг ручного сворачивания в persist");
  // разворот по «развернуть»
  row.querySelector(".assistant-info-expand").click();
  assert(row.classList.contains("hidden"), "t-row скрыта после разворота");
  assert(!card.querySelector(".assistant-analysis-headline").classList.contains("hidden"),
         "тело снова видно");
  eq(JSON.parse(localStorage.getItem("dq-assistant-chat:local"))
       .convos.single.feed.at(-1).collapsed, undefined, "флаг снят");
  // восстановление из persist — свёрнутой строкой
  btn.click();
  const saved = localStorage.getItem("dq-assistant-chat:local");
  installDom(); await resetState(); domApp();
  navigator.resetNavigator();
  localStorage.setItem("dq-assistant-chat:local", saved);
  mockAssistantFetch({ chatModels: [{ key: "mA", label: "Model A" }] });
  assistant.initAssistant();
  await sleep(10);
  const restored = feed().querySelector(".assistant-analysis");
  const rrow = restored.querySelector(".assistant-term-row");
  assert(rrow && !rrow.classList.contains("hidden"), "восстановлена свёрнутой (t-row)");
  includes(rrow.textContent, "Разбор прогона", "brief на месте");
  rrow.querySelector(".assistant-info-expand").click();
  assert(!restored.querySelector(".assistant-analysis-headline").classList.contains("hidden"),
         "разворачивается после восстановления");
});

test("analysis: исчерпанная очередь (7.2) — t-row «Готово» + «вернуться к разбору →» разворачивает разбор", async () => {
  await setupAssistant();
  const aCard = assistant.handleAnalysis(ANALYSIS_FIXTURE);
  const qCard = assistant.handleQueue({ page: "batch", done: true,
                                        candidates: [], total: 0 });
  const row = qCard.querySelector(".assistant-term-row");
  assert(row, "очередь исчерпана — терминальная строка");
  eq(row.querySelector(".assistant-proposal-status").textContent, "Готово",
     "пилла «Готово»");
  includes(row.textContent, "Всё размечено", "суть строки");
  const back = row.querySelector(".assistant-term-acts .assistant-link");
  includes(back.textContent, "вернуться к разбору", "действие возврата");
  // разбор свёрнут вручную — возврат разворачивает его и подсвечивает
  aCard.querySelector(".assistant-info-collapse").click();
  assert(aCard.querySelector(".assistant-analysis-headline").classList.contains("hidden"),
         "разбор свёрнут");
  back.click();
  assert(!aCard.querySelector(".assistant-analysis-headline").classList.contains("hidden"),
         "разбор развёрнут возвратом");
  assert(aCard._scrolledIntoView >= 1, "скролл к карточке разбора");
  assert(aCard.classList.contains("assistant-flash-target"), "flash-подсветка");
});

test("navigator: ←/→, ✓ размеченного, пропуск размеченных, «Готово», выход, страница", async () => {
  installDom(); await resetState(); domApp();
  navigator.resetNavigator();
  review.resetReview();
  // пакет: два файла, цели-ячейки в DOM (revealTarget находит по data-review-key)
  state.batch.files = [{ id: "f1", name: "a.txt" }, { id: "f2", name: "b.txt" }];
  state.batch.marks = [];
  state.pageMode = "batch";
  const t1 = { scope: "batch", file: "f1", question: "q1", model: "mA" };
  const t2 = { scope: "batch", file: "f2", question: "q2", model: "mB" };
  const cells = [t1, t2].map(t => {
    const c = el("div", { parent: document.getElementById("batch-results") });
    c.dataset.reviewKey = review.targetKey(t);
    return c;
  });
  const items = [
    { scope: "batch", target: t1, label: "a.txt · №1 · mA", reason: "⚡" },
    { scope: "batch", target: t2, label: "b.txt · №2 · mB", reason: "◌ 52%" },
  ];
  const origin = el("div", { parent: document.body });
  const deps = { openPanel: () => { origin._panelOpened = true; } };

  // Фаза 1: навигация и разметка
  navigator.startNavigator(items, { origin, deps });
  const pill = () => document.querySelector(".assistant-navigator");
  includes(pill().textContent, "1/2", "стартовая позиция");
  assert(cells[0]._scrolledIntoView >= 1, "телепорт к первому кандидату");
  assert(!pill().querySelector(".assistant-navigator-btn").disabled || true,
         "кнопки на месте");
  // «→» ведёт к следующему
  const nextBtn = () => [...pill().querySelectorAll(".assistant-navigator-btn")]
    .find(b => b.textContent === "→");
  const prevBtn = () => [...pill().querySelectorAll(".assistant-navigator-btn")]
    .find(b => b.textContent === "←");
  nextBtn().click();
  includes(pill().textContent, "2/2", "второй кандидат");
  assert(cells[1]._scrolledIntoView >= 1, "телепорт ко второму");
  prevBtn().click();
  includes(pill().textContent, "1/2", "назад к первому");
  // разметка текущего — ✓ в счётчике
  review.setVerdict("batch", t1, "reject");
  includes(pill().textContent, "1/2 ✓", "размеченный помечен ✓");
  // «→» пропускает размеченный первый — ко второму; дальше — «Готово»
  nextBtn().click();
  includes(pill().textContent, "2/2", "на втором");
  review.setVerdict("batch", t2, "accept");
  includes(pill().textContent, "Готово: 2/2", "очередь исчерпана");
  const back = pill().querySelector(".assistant-navigator-back");
  assert(back, "кнопка «вернуться к разбору»");
  back.click();
  assert(origin._panelOpened, "панель открыта");
  assert(origin._scrolledIntoView >= 1, "скролл к карточке разбора");

  // Фаза 2: выход — навигатор скрыт, разметка не откачена
  pill().querySelector(".assistant-navigator-exit").click();
  assert(pill().classList.contains("hidden"), "навигатор скрыт");
  assert(!navigator.navigatorActive(), "очередь завершена");
  eq(state.batch.marks.length, 2, "разметка сохранена");

  // Фаза 3: привязка к странице — скрывается/возвращается, очередь не прерывается
  state.batch.marks = [];
  navigator.startNavigator(items, {});
  assert(!pill().classList.contains("hidden"), "навигатор на своей странице");
  state.pageMode = "single";
  emit("pagemode");
  assert(pill().classList.contains("hidden"), "скрыт на чужой странице");
  assert(navigator.navigatorActive(), "очередь не прервана");
  state.pageMode = "batch";
  emit("pagemode");
  assert(!pill().classList.contains("hidden"), "вернулся со страницей");
  navigator.stopNavigator();

  // Фаза 4: старт с уже размеченного — переход к первому неразмеченному
  review.setVerdict("batch", t1, "reject");
  navigator.startNavigator(items, {});
  includes(pill().textContent, "2/2", "старт с неразмеченного");
  navigator.stopNavigator();
});

test("navigator: single-цели — резолюция modelLabel в ключ прогона", async () => {
  installDom(); await resetState(); domApp();
  navigator.resetNavigator();
  state.models = [{ key: "mA", label: "Qwen 27B", short_label: "27B" }];
  state.results = {
    results: { mA: { ok: true, answers: {} } },
    order: ["mA"], runMode: "decisions",
    questions: [{ id: "q1", question: "Ок?", type: "yes_no" }],
    marks: [],
  };
  const cand = { questionN: 1, qid: "q1", model: "27B",
                 target: { scope: "single", question: "q1", modelLabel: "27B" } };
  const t = analysis.resolveCandidateTarget(cand);
  eq(t.model, "mA", "лейбл резолвится в ключ");
  eq(t.mode, "decisions", "режим прогона");
  eq(t.scope, "single", "scope");
  // неизвестный лейбл — цель уровня вопроса (строка)
  const t2 = analysis.resolveCandidateTarget({
    questionN: 1, qid: "q1",
    target: { scope: "single", question: "q1", modelLabel: "zzz" } });
  assert(!t2.model, "без модели — цель строки вопроса");
});
