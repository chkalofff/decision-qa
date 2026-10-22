// AI-ассистент: правая выдвижная панель с собственным чат-UI (обычный DOM,
// без shadow DOM и сторонних чат-компонентов). Ответы ассистента рендерятся
// markdown'ом (вендоренный remarkable, vendor/remarkable.js). Наш SSE
// /api/assistant/chat: token → стриминг в пузырь ответа, thinking →
// сворачиваемый details-блок, tool → служебная строка в ленте (кроме
// run_trial — у него живая карточка прогресса по макету 4.2: пилла «шаг k/n»,
// полоса, disclosure шагов, «Прервать» → /api/assistant/trial/abort; финал —
// терминал «Выполнен», а по trial с aborted:true — «Прервано» 4.12 с
// «частичный результат»/«досчитать»), trial_progress → обновление этой
// карточки на месте, trial/proposal → карточки в ленте, error → красная
// строка, done → конец.
// Кнопка отправки превращается в СТОП на всё время запроса (включая фазы
// инструментов и thinking): клик → AbortController, частичный ответ остаётся,
// в ленте строка «остановлено пользователем». Proposal-события НЕ применяются
// автоматически: карточка в ленте ждёт «Принять»/«Отклонить»; после «Принять» —
// пилла «Применена» и ссылка «Отменить» в терминальной строке (undo по снимку
// прежнего состояния; для run/preset undo нет). Карточки оформлены по концепции
// «Рамс» (docs/assistant-v2-concept-design.md §12): пилла точка+слово, кромки
// состояний слева, два яруса кнопок.
// Индикация на кнопке «✨ Ассистент» при закрытой панели: is-working (три
// мигающие точки) на всё время активного запроса, has-unread (акцентная
// точка) по завершении (done/error) — снимается при открытии панели. Ручная
// остановка (СТОП) уведомления не ставит.

import { Remarkable } from "./vendor/remarkable.js";
import { state, subscribe, getChatModel, setChatModel, fillChatModelSelect } from "./state.js";
import { setPageMode } from "./toolbar.js";
import { setQuestions, normalizeQuestion, renderQuestions } from "./questions.js";
import { setDecision, validateDecision, evaluateDecision, explainDecision,
         answerLabel, describeDecision, conditionText,
         OUTCOME_COLORS, COLOR_NAMES } from "./decision.js";
import { decisionFromProposal, ruleDelta, deltaStats, answersOfMode } from "./delta.js";
import { hashString } from "./fingerprint.js";
import { setContent, contextSnapshot } from "./context.js";
import { openSaveDialog } from "./presets.js";
import { getPresets, validateProposal, assistantEvent, getAssistantSessionId,
         assistantTrialAbort } from "./api.js";
import { saveNow } from "./persist.js";
import { renderBatchList } from "./batch.js";
import { shortAnswer, modelShortLabel, answerConfidence, MODE_LABELS } from "./results.js";
import * as reviewMod from "./review.js";
import { analysisCardEl, queueCardEl, analysisBrief, queueBrief,
         countReviewQueueCandidates } from "./analysis.js";
import { fileLinkEl } from "./flink.js";

const HISTORY_LIMIT = 20;     // последние N сообщений уходят в запросе
const CONTEXT_LIMIT = 4000;   // обрезка текста контекста в снапшоте
const RESULTS_LIMIT = 3000;   // обрезка сводки результатов
const CONTEXT_PREVIEW = 500;  // предпросмотр текста в карточке propose_context
const DIFF_PREVIEW_LINES = 5; // строк diff-превью до сворачивания в <details>
const BATCH_FILE_TEXT_LIMIT = 1500; // обрезка текста файла батча в снапшоте
const BATCH_TEXT_TOTAL = 6000;      // суммарный бюджет текстов файлов батча
const BATCH_RESULT_FILES = 30;      // файлов с пофайловыми результатами в снапшоте
const INPUT_MAX_HEIGHT = 160; // авто-рост textarea до этой высоты

const WIDTH_KEY = "dq-assistant-width";
const WIDTH_MIN = 320;
const WIDTH_MAX = 1200;
const WIDTH_DEFAULT = 380;

const TYPE_LABELS = { yes_no: "Да/Нет", choice: "Выбор", score: "Шкала" };

const md = new Remarkable({ html: false, breaks: true });

const PLANE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15">' +
  '<path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>';
const STOP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">' +
  '<rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

// Два раздельных разговора ассистента: «single» (одиночная страница, а также
// «Модели»/«Пресеты») и «batch». У каждого своя история запросов и свои узлы
// ленты: при переключении страницы узлы активного разговора отсоединяются и
// сохраняются, узлы целевого — восстанавливаются (у нового разговора —
// welcome-подсказка). «Сброс» очищает только активный разговор.
// feed — сериализуемая модель ленты для persist (v0.8): сообщения и карточки
// в порядке показа; nodes — DOM-кэш (не сериализуется).
const convos = {
  single: { history: [], nodes: null, openTools: [], feed: [] },
  batch: { history: [], nodes: null, openTools: [], feed: [] },
};
let activeConvo = "single";
let introHtml = "";  // шаблон welcome-подсказки для нового разговора
let chatModels = [];       // [{key, label}] из GET /api/assistant/models
let selectedModel = null;  // key выбранной chat-модели
let streaming = false;
let activeController = null;  // AbortController активного запроса (кнопка СТОП)
let unread = false;           // завершившийся запрос, который пользователь не видел
// Виртуальное состояние хода (зеркало backend `virtual`): набор вопросов из
// карточки propose_questions этого хода — карточка правил тем же ходом
// превалидируется уже против новой нумерации (инцидент 17.10).
let turnVirtualQuestions = null;

const panel = () => document.getElementById("assistant-panel");
const messagesEl = () => document.getElementById("assistant-messages");
const inputEl = () => document.getElementById("assistant-input");
const sendEl = () => document.getElementById("assistant-send");

// ---------------------------------------------------------------- панель

export function openPanel() {
  unread = false;
  panel().classList.remove("hidden");
  updateToolbarButton();
  renderModelOptions();
  loadModels();
}

export function closePanel() {
  panel().classList.add("hidden");
  updateToolbarButton();
}

export function togglePanel() {
  if (panel().classList.contains("hidden")) openPanel();
  else closePanel();
}

// ---------------------------------------------------------------- ресайз

function clampWidth(w) {
  // Верхняя граница — не шире окна минус зазор (в тестовом DOM innerWidth может
  // отсутствовать — тогда просто WIDTH_MAX).
  const iw = typeof window !== "undefined" ? window.innerWidth : 0;
  const cap = (typeof iw === "number" && iw >= 400) ? Math.min(WIDTH_MAX, iw - 80) : WIDTH_MAX;
  return Math.max(WIDTH_MIN, Math.min(cap, Math.round(w)));
}

export function applyPanelWidth(width) {
  panel().style.width = clampWidth(width) + "px";
}

export function initResize() {
  const saved = Number(localStorage.getItem(WIDTH_KEY));
  if (saved) applyPanelWidth(saved);
  const handle = document.getElementById("assistant-resize");
  if (!handle) return;
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = parseFloat(panel().style.width) || WIDTH_DEFAULT;
    let last = startW;
    const onMove = (ev) => {
      // ручка на левом краю: движение влево увеличивает ширину
      last = clampWidth(startW + (startX - ev.clientX));
      panel().style.width = last + "px";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      localStorage.setItem(WIDTH_KEY, String(last));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ---------------------------------------------------------------- модели

async function loadModels() {
  try {
    const resp = await fetch("/api/assistant/models");
    if (!resp.ok) return;
    const data = await resp.json();
    chatModels = data.models || [];
  } catch {
    return;  // сеть/сервер недоступен — селектор остаётся как есть
  }
  renderModelOptions();
}

// Статусы и пометки опций — общий fillChatModelSelect из state.js; выбор
// персистится в dq-chat-model и разделяется с диалогами «✨ Сгенерировать».
function renderModelOptions() {
  const sel = document.getElementById("assistant-model");
  if (!sel) return;
  if (!chatModels.length) {
    fillChatModelSelect(sel, [], null);
    selectedModel = null;
    return;
  }
  selectedModel = fillChatModelSelect(sel, chatModels, selectedModel || getChatModel());
}

// ---------------------------------------------------------------- лента сообщений

function introEl() {
  const m = messagesEl();
  return m ? m.querySelector(".assistant-intro") : null;
}

function hideIntro() {
  const intro = introEl();
  if (intro) intro.classList.add("hidden");
}

function showIntro() {
  const intro = introEl();
  if (intro) intro.classList.remove("hidden");
}

// Welcome-подсказка для разговора, в котором ещё не было сообщений.
function createIntro() {
  const intro = document.createElement("div");
  intro.className = "assistant-intro";
  if (introHtml) intro.innerHTML = introHtml;
  return intro;
}

function convoKeyForPage(page) {
  return page === "batch" ? "batch" : "single";
}

// Узлы активного разговора → в сохранённое состояние (отсоединяются из ленты).
function stashConvo(key) {
  const m = messagesEl();
  if (!m) return;
  const c = convos[key];
  c.nodes = [...m.children];
  for (const n of c.nodes) n.remove();
}

// Сохранённые узлы разговора → обратно в ленту; у нового разговора — подсказка.
function restoreConvo(key) {
  const m = messagesEl();
  if (!m) return;
  const c = convos[key];
  if (c.nodes) for (const n of c.nodes) m.appendChild(n);
  else m.appendChild(createIntro());
}

function switchConversation(key) {
  if (key === activeConvo) return;
  stashConvo(activeConvo);
  activeConvo = key;
  restoreConvo(key);
  refreshProposalQueue(key); // нумерация/чип — под показанный разговор
  scrollDown();
}

function scrollDown(force = false) {
  const m = messagesEl();
  if (!m || typeof m.scrollHeight !== "number") return;
  // не дёргаем ленту, если пользователь проскроллил вверх читать историю
  // (порог 40px); force — когда пользователь сам отправил сообщение
  if (!force && typeof m.scrollTop === "number" && typeof m.clientHeight === "number"
      && m.scrollTop + m.clientHeight < m.scrollHeight - 40) return;
  m.scrollTop = m.scrollHeight;
}

// Добавить узел в ленту разговора key (по умолчанию — активный). Неактивному
// разговору узел копится в сохранённых и попадёт в ленту при переключении —
// так ответ на запрос, начатый до смены страницы, не попадает в чужой чат.
// Первое сообщение прячет welcome-подсказку; в живой ленте узел встаёт перед
// индикатором «печатает», если тот висит, и лента подскролливается вниз.
function appendMsg(node, key = activeConvo) {
  const m = messagesEl();
  if (key !== activeConvo || !m) {
    const c = convos[key];
    if (!c.nodes) c.nodes = [];
    for (const n of c.nodes) {
      if (n.classList && n.classList.contains("assistant-intro")) n.classList.add("hidden");
    }
    c.nodes.push(node);
    return node;
  }
  hideIntro();
  const typing = m.querySelector(".assistant-typing");
  if (typing) m.insertBefore(node, typing);
  else m.appendChild(node);
  scrollDown();
  return node;
}

function userMsgEl(text, system) {
  const wrap = document.createElement("div");
  wrap.className = "assistant-msg user" + (system ? " system" : "");
  const bubble = document.createElement("div");
  bubble.className = "assistant-bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  return wrap;
}

function addUserMessage(text, key = activeConvo, opts = {}) {
  appendMsg(userMsgEl(text, opts.system), key);
  pushFeed(key, { t: "user", text, system: opts.system || undefined });
}

// Пузырь ответа ассистента; markdown тела обновляется по мере стрима.
function createAnswerMessage(key = activeConvo) {
  const wrap = document.createElement("div");
  wrap.className = "assistant-msg ai";
  const body = document.createElement("div");
  body.className = "assistant-md";
  wrap.appendChild(body);
  appendMsg(wrap, key);
  return body;
}

function renderMarkdown(body, text) {
  body.innerHTML = md.render(text);
}

// Маленькая ненавязчивая строка в ленте (tool-события, обрыв, отмена).
function addNote(text, key = activeConvo) {
  const note = document.createElement("div");
  note.className = "assistant-note";
  note.textContent = text;
  appendMsg(note, key);
  return note;
}

// Системная строка «прогон завершился» (v1.1): ассистент сам видит финал
// прогона — пользователю не нужно сообщать об этом (запрос из сессии 19.10).
function runDoneNode(item) {
  const wrap = document.createElement("div");
  wrap.className = "assistant-msg ai assistant-run-done";
  const line = document.createElement("span");
  line.className = "assistant-run-done-text";
  line.textContent = item.text;
  const act = document.createElement("button");
  act.type = "button";
  act.className = "assistant-run-done-action";
  act.textContent = "🔍 Разобрать прогон";
  act.addEventListener("click", () => {
    if (streaming) return;
    sendMessage("Разбери последний прогон: найди проблемы и расхождения моделей.");
  });
  wrap.appendChild(line);
  wrap.appendChild(act);
  return wrap;
}

// Пишем только в существующий разговор — пустой чат не засоряем.
function notifyRunFinished() {
  const p = panel();
  if (!p) return; // ассистент не инициализирован (тесты, чужие страницы)
  const batch = state.pageMode === "batch";
  const key = convoKeyForPage(state.pageMode);
  const c = convos[key];
  if (!c || (!c.feed.length && !c.history.length)) return;
  let text;
  if (batch) {
    const files = state.batch.files || [];
    const ok = files.filter(f => f.status === "ok").length;
    text = `✔ Прогон пакета завершился: ${ok} из ${files.length} файлов.`;
  } else {
    const order = (state.results && state.results.order) || [];
    const qs = (state.results && state.results.questions) || [];
    text = `✔ Прогон завершился: ${order.length} мод. × ${qs.length} вопр.`;
  }
  const item = { t: "run-done", text };
  pushFeed(key, item);
  if (key === activeConvo) appendMsg(runDoneNode(item), key);
  if (panel().classList.contains("hidden")) {
    unread = true;
    updateSendButton();
  }
}

function addErrorMessage(msg, key = activeConvo) {
  const err = document.createElement("div");
  err.className = "assistant-msg ai assistant-error";
  err.textContent = "⚠ " + msg;
  appendMsg(err, key);
}

// Индикатор «печатает» в теле ленты (три точки), пока запрос активен и ответ
// ещё не начался.
function showTyping(key = activeConvo) {
  const el = document.createElement("div");
  el.className = "assistant-typing";
  for (let i = 0; i < 3; i += 1) el.appendChild(document.createElement("span"));
  appendMsg(el, key);
  return el;
}

// thinking → сворачиваемый details-блок в ленте (до пузыря ответа).
function thinkingEl(text) {
  const details = document.createElement("details");
  details.className = "assistant-thinking";
  const summary = document.createElement("summary");
  summary.textContent = "Рассуждение";
  const body = document.createElement("div");
  body.className = "assistant-thinking-body";
  body.textContent = text;
  details.appendChild(summary);
  details.appendChild(body);
  return details;
}

// tool start → строка в ленте; done/error — мутация её текста (элемент
// храним напрямую, shadow DOM больше нет). Незавершённые вызовы — стек
// openTools своего разговора (стрим продолжается в своём чате даже после
// переключения страницы).

// Русские подписи инструментов для ленты (технические имена пользователю ни о
// чём не говорят).
const TOOL_LABELS = {
  get_state: "Просмотр состояния",
  list_models: "Список моделей",
  list_presets: "Список пресетов",
  get_file_result: "Результат файла",
  get_result: "Детали прогона",
  run_trial: "Пробный прогон",
  analyze_run: "Разбор прогона",
  review_queue: "Очередь разметки",
  propose_questions: "Предложение: вопросы",
  propose_context: "Предложение: материал",
  propose_decision: "Предложение: правила решения",
  propose_run: "Предложение: запуск прогона",
  propose_save_preset: "Предложение: сохранить пресет",
};

function toolLabel(name) {
  return TOOL_LABELS[name] || name;
}

function showToolEvent(name, status, message, key = activeConvo, internal = false) {
  const openTools = convos[key].openTools;
  if (status === "start") {
    if (name === "run_trial") {
      // живая карточка прогресса (макет 4.2) вместо tool-строки
      const progress = trialProgressCard(key);
      openTools.push({ el: progress.card, name, progress });
      return;
    }
    const el = addNote(`🔧 ${toolLabel(name)}…`, key);
    openTools.push({ el, name });
    return;
  }
  const open = openTools.pop();
  if (!open) return;
  if (open.progress) {  // финал живой карточки run_trial (done/error)
    open.progress.finalize(status, message, internal);
    return;
  }
  // internal — ошибка предпроверки (валидация, лимиты): ничего не запускалось,
  // модель починит сама; красная строка в ленте — ложная тревога пользователю
  if (status === "error" && internal) {
    open.el.remove();
    return;
  }
  let text = status === "error"
    ? `✗ ${toolLabel(open.name)}`
    : `✓ ${toolLabel(open.name)}`;
  if (message) text += ` — ${truncate(String(message), 300)}`;
  open.el.textContent = text;
  if (status === "error") open.el.classList.add("assistant-note-error");
}

// ---------------------------------------------------------------- история

// «Сброс» очищает только активный разговор (у каждого режима своя история).
export function resetHistory() {
  const c = convos[activeConvo];
  c.history = [];
  // таймеры живых карточек прогресса гасим — узлы сейчас снимем с ленты
  for (const t of c.openTools) { if (t.progress) t.progress.stopTimer(); }
  c.openTools.length = 0;
  c.feed = [];
  turnVirtualQuestions = null;
  const m = messagesEl();
  if (m) {
    for (const ch of [...m.children]) {
      if (!ch.classList.contains("assistant-intro")) ch.remove();
    }
  }
  showIntro();
  updatePendingChip();
  persistChat();
}

// ---------------------------------------------------------------- persist (v0.8)

// Лента и история разговоров переживают перезагрузку: localStorage
// dq-assistant-chat, {version, convos: {single, batch: {history, feed}}}.
// Записи feed: {t:"user"|"assistant", text, system?}, {t:"proposal", proposal,
// status, invalidReason?, fingerprint?}, {t:"trial", trial, collapsed?},
// {t:"analysis", analysis, collapsed?} и {t:"queue", queue, collapsed?}
// (информационные карточки разбора/очереди разметки, v1.1),
// {t:"run-done", text} (системная строка о завершении прогона, v1.1).
// Бюджет ~1.5 МБ: при превышении сначала срезаем fullAnswers пробных прогонов
// (самое тяжёлое), затем старейшие записи ленты. Статусы карточек обновляются
// по ссылке card._feedItem. Tool-строки и мелкие заметки не сохраняем (шум).
const CHAT_KEY = "dq-assistant-chat";
const CHAT_PERSIST_VERSION = 1;
const CHAT_PERSIST_BUDGET = 1_500_000;
const FEED_KEEP_MIN = 20;  // последних записей разговора не трогаем усечением

function pushFeed(key, item) {
  convos[key].feed.push(item);
  persistChat();
}

export function persistChat() {
  try {
    const pack = () => ({
      version: CHAT_PERSIST_VERSION,
      convos: {
        single: { history: convos.single.history.slice(-HISTORY_LIMIT),
                  feed: convos.single.feed, annV: 1 },
        batch: { history: convos.batch.history.slice(-HISTORY_LIMIT),
                 feed: convos.batch.feed, annV: 1 },
      },
    });
    let data = pack();
    let text = JSON.stringify(data);
    if (text.length > CHAT_PERSIST_BUDGET) {
      // 1) fullAnswers пробных прогонов — самое тяжёлое, срезаем первым
      data = pack();
      for (const key of ["single", "batch"]) {
        data.convos[key].feed = data.convos[key].feed.map(item =>
          item.t === "trial" && item.trial
            ? { ...item, trial: { ...item.trial,
                rows: (item.trial.rows || []).map(r => {
                  const { fullAnswers, ...rest } = r;
                  return rest;
                }) } }
            : item);
      }
      text = JSON.stringify(data);
      // 2) старейшие записи — за борт
      while (text.length > CHAT_PERSIST_BUDGET) {
        const s = data.convos.single.feed;
        const b = data.convos.batch.feed;
        if (s.length <= FEED_KEEP_MIN && b.length <= FEED_KEEP_MIN) return;
        (s.length >= b.length ? s : b).shift();
        text = JSON.stringify(data);
      }
    }
    localStorage.setItem(CHAT_KEY, text);
  } catch { /* quota / приватный режим — живём без persist */ }
}

// Fingerprint состояния, на которое нацелено предложение (для протухания
// карточек при восстановлении и при «Принять» в живой сессии): правки
// вопросов/правил — хеш от вопросов и решения; правки контекста — от текста
// контекста/файла; run/save_preset не протухают (null).
// questionsOverride — виртуальный набор хода (правила построены под новую
// нумерацию ещё не принятой карточки вопросов, v0.9): карточка правил
// хранит fingerprint и по текущему, и по виртуальному набору — принятие
// валидно, если совпал любой (приняли вопросы → совпадёт виртуальный;
// отклонили — совпадёт текущий, а apply-time проверка откажет по № вопроса).
// id вопросов в хеш не входит: у виртуального набора id ещё нет (они
// рождаются при применении), значимы содержимое и порядок.
function questionsFpList(list) {
  return (list || []).map(q => {
    // общая нормализация (дефолты direction/yes/no/options) — виртуальный
    // набор хода и фактический после применения обязаны совпадать по хешу
    let n;
    try { n = normalizeQuestion(convertProposalQuestion(q)); }
    catch { n = convertProposalQuestion(q); }
    return {
      question: n.question, type: n.type, yes: n.yes, no: n.no,
      options: (n.options || []).map(o => ({ name: o.name, description: o.description })),
      levels: n.levels, direction: n.direction,
    };
  });
}

function proposalFingerprint(proposal, questionsOverride) {
  const p = (proposal && proposal.payload) || {};
  if (proposal.kind === "propose_questions" || proposal.kind === "propose_decision") {
    const d = state.decision
      ? JSON.parse(JSON.stringify(state.decision),
                   (k, v) => (k === "collapsed" ? undefined : v))
      : null;
    return hashString(JSON.stringify({
      q: questionsFpList(questionsOverride || state.questions),
      d,
    }));
  }
  if (proposal.kind === "propose_context") {
    if (p.file) {
      const f = state.batch.files.find(x => x.name === p.file);
      return hashString("file:" + (f && f.text ? f.text : ""));
    }
    let text = "";
    try { text = contextSnapshot().text || ""; } catch { text = ""; }
    return hashString("ctx:" + text);
  }
  return null;
}

// Узел ленты по записи persist (восстановление после перезагрузки).
function feedItemNode(key, item) {
  if (item.t === "user") return userMsgEl(item.text, item.system);
  if (item.t === "assistant") {
    const wrap = document.createElement("div");
    wrap.className = "assistant-msg ai";
    const body = document.createElement("div");
    body.className = "assistant-md";
    wrap.appendChild(body);
    renderMarkdown(body, item.text || "");
    return wrap;
  }
  if (item.t === "proposal") return restoredProposalCard(item);
  if (item.t === "run-done") return runDoneNode(item);
  if (item.t === "trial" && item.trial) {
    // прерванный прогон (4.12) восстанавливается терминалом «Прервано» —
    // действия «частичный результат»/«досчитать» остаются полноценными
    if (item.trialStatus === "aborted") {
      const card = document.createElement("div");
      card.className = "assistant-proposal assistant-trial-progress";
      fillTrialAborted(card, item.trial, key);
      card._trial = item.trial;
      card._feedItem = item;
      return card;
    }
    const card = trialCardEl(item.trial, key);
    card._trial = item.trial;
    card._feedItem = item;
    // решение по what-if (макет 4.3) переживает перезагрузку терминалом
    if (item.trialStatus === "applied" || item.trialStatus === "declined") {
      trialTerminalEl(card, item.trial, item.trialStatus,
                      item.trialStatus === "applied" ? "Применено" : "Отклонено");
    } else if (item.collapsed) collapseTrialCard(card);
    return card;
  }
  if (item.t === "analysis" && item.analysis) {
    const card = analysisCardEl(item.analysis, infoCardDeps);
    card._feedItem = item;
    if (item.collapsed) collapseInfoCard(card, analysisBrief(item.analysis));
    return card;
  }
  if (item.t === "queue" && item.queue) {
    const card = queueCardEl(item.queue, infoCardDeps);
    card._feedItem = item;
    if (item.collapsed) collapseInfoCard(card, queueBrief(item.queue));
    return card;
  }
  return null;
}

// Пилла статуса карточки (концепция «Рамс», v1.2): цветная точка + слово, без
// фона. Точка — у живых статусов pending (ожидание решения) и live (идущий
// пробный прогон, макет 4.2), пульс гасится prefers-reduced-motion;
// терминальные пиллы — словом, его достаточно.
// Текст обновляется только через setStatusText: textContent снёс бы точку.
function statusPillEl(statusCls, text) {
  const pill = document.createElement("span");
  pill.className = "assistant-proposal-status " + statusCls;
  if (statusCls === "pending" || statusCls === "live") {
    const dot = document.createElement("i");
    dot.className = "assistant-proposal-status-dot";
    pill.appendChild(dot);
  }
  const txt = document.createElement("span");
  txt.className = "assistant-proposal-status-text";
  txt.textContent = text;
  pill.appendChild(txt);
  return pill;
}

function setStatusText(pill, statusCls, text) {
  if (!pill) return;
  pill.className = "assistant-proposal-status " + statusCls;
  // точка — только у живых pending/live (терминальные пиллы — словом)
  let dot = pill.querySelector(".assistant-proposal-status-dot");
  if (statusCls === "pending" || statusCls === "live") {
    if (!dot) {
      dot = document.createElement("i");
      dot.className = "assistant-proposal-status-dot";
      pill.insertBefore(dot, pill.firstChild);
    }
  } else if (dot) {
    dot.remove();
  }
  const txt = pill.querySelector(".assistant-proposal-status-text");
  if (txt) txt.textContent = text;
  else pill.textContent = text;
}

// eyebrow верхнего ряда карточки — вид сущности (макет option-c, c-eye)
const PROPOSAL_EYE = {
  propose_questions: "Предложение · набор вопросов",
  propose_context: "Предложение · контекст",
  propose_decision: "Предложение · правила решения",
  propose_run: "Предложение · пробный прогон",
  propose_save_preset: "Предложение · пресет",
};

// Янтарная кромка слева — только у развёрнутой pending (у stale/invalid —
// свои кромки, у компактной строки и терминальной — кромки нет). Гейт прогона
// (.assistant-proposal-gate) перекрашивает её в синюю 3px правилом CSS.
function syncPendingEdge(card) {
  const open = !!(card._statusEl && card._statusEl.classList.contains("pending"))
    && !card.classList.contains("assistant-proposal-compact")
    && !card.classList.contains("assistant-proposal-stale")
    && !card.classList.contains("assistant-proposal-invalid")
    && !card.classList.contains("assistant-proposal-terminal");
  card.classList.toggle("assistant-proposal-pending-open", open);
}

// Карточка предложения из persist: pending — активной (с проверкой протухания
// по fingerprint, превалидация не повторяется — была при первом показе);
// терминальные — строкой-итогом (undo после перезагрузки не предлагаем:
// captureUndo снял бы состояние уже ПОСЛЕ применения).
const RESTORED_STATUS_TEXT = { applied: "Применена", declined: "Отклонена",
                               undone: "Отменено", invalid: "Ошибка",
                               stale: "Устарела" };

// Макет 1.10 «Прервано»: apply append-карточки вопросов прерван перезагрузкой
// между операциями (журнал applyProgress в persist после каждой — kill
// вкладки ловится). Терминальная строка «Прервано · применены k из n правок»
// + действие «применить оставшиеся» (квитанция applied идемпотентна по
// event_id — дубль после обрыва поглотится). Хвост state сверяется с
// применёнными операциями — расхождение = состояние менялось вне карточки →
// «Устарела». Replace-путь (включая развёрнутые бэком edits) атомарен —
// частичного применения нет, «Прервано» только у append. Undo после
// досчитывания не предлагаем (как и у всех восстановленных карточек).
function restoredAbortedApply(item, card, proposal, status) {
  const p = proposal.payload || {};
  const total = (item.applyProgress && item.applyProgress.total) || 0;
  const done = (item.applyProgress && item.applyProgress.done) || 0;
  const converted = (p.questions || []).map(convertProposalQuestion);
  const appliedOk = done > 0 && done <= converted.length
    && state.questions.length >= done
    && converted.slice(0, done).every((q, i) =>
      normQuestionText(q)
      === normQuestionText(state.questions[state.questions.length - done + i] || {}));
  item.status = "aborted";  // из очереди pending выбывает, терминалом
  if (!converted.length || done >= total || done >= converted.length) {
    // всё успело примениться до обрыва — домечаем применённой
    setStatusText(status, "applied", "Применена");
    receiptBeacon(proposal, "applied");
    collapseProposalCard(card, proposal, "Применена");
    persistChat();
    return card;
  }
  if (!appliedOk) {
    item.status = "stale";
    markProposalStale(card, proposal,
      "Состояние изменилось с момента прерванного применения — применять её нельзя.",
      { beacon: false });
    return card;
  }
  // терминальная строка (как 4.12 у прогона): пилла · суть · действие
  for (const ch of [...card.children]) ch.remove();
  card.classList.add("assistant-proposal-terminal");
  const row = document.createElement("div");
  row.className = "assistant-term-row";
  row.setAttribute("tabindex", "0");
  const sum = document.createElement("span");
  sum.className = "assistant-term-sum";
  sum.textContent = `применение остановлено: применены ${done} из ${total} правок, набор консистентен`;
  const acts = document.createElement("span");
  acts.className = "assistant-term-acts";
  const resume = document.createElement("button");
  resume.type = "button";
  resume.className = "assistant-link";
  resume.textContent = "применить оставшиеся";
  resume.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (card._applied) return;
    card._applied = true;
    resume.disabled = true;
    try {
      await applyProposal(proposal, item);  // продолжит с applyProgress.done
    } catch (err) {
      card._applied = false;
      resume.disabled = false;
      showProposalError(card, err);
      return;
    }
    item.status = "applied";
    delete item.applyProgress;
    receiptBeacon(proposal, "applied");
    setStatusText(status, "applied", "Применена");
    resume.remove();
    sum.textContent = `применены все ${total} правок`;
    persistChat();
    revalidatePendingCards();
  });
  acts.appendChild(resume);
  row.append(status, sum, acts);
  setStatusText(status, "aborted", "Прервано");
  card.appendChild(row);
  persistChat();
  return card;
}

function restoredProposalCard(item) {
  const proposal = item.proposal || {};
  const card = proposalCardEl(proposal, { restored: true });
  card._feedItem = item;
  proposalCardByItem.set(item, card);
  const status = card._statusEl;
  if (item.status === "pending" && item.applyProgress
      && proposal.kind === "propose_questions"
      && (proposal.payload || {}).mode === "append") {
    // apply прерван перезагрузкой между операциями (макет 1.10 «Прервано»)
    return restoredAbortedApply(item, card, proposal, status);
  }
  if (item.status === "pending") {
    // Карточки из версий до A3 (позиционная адресация № вместо id) честно
    // инвалидируются: применять их нельзя — № сдвигаются, а payload не
    // конвертировать без потери смысла. Та же дорожка «Устарела» + кнопка
    // перевыпуска (модель пересоберёт карточку по актуальному снапшоту).
    const legacy = isLegacyPositionalProposal(proposal);
    if (legacy || !proposalFingerprintValid(item)) {
      // протухшая pending сразу выбывает из очереди (v1.1): чип и нумерация
      // считают только реально решаемые карточки. Квитанцию не шлём повторно —
      // бикон invalid уходил при первой пометке в живой сессии.
      item.status = "stale";
      markProposalStale(card, proposal, legacy
        ? "Карточка из прошлой версии (адресация по номерам вместо id) — применять её нельзя."
        : "Состояние изменилось с момента предложения — применять её нельзя.",
        { beacon: false });
      return card; // протухшая — развёрнутой: важно видеть причину
    }
    // живые pending восстанавливаются компактными (v1.1): развёрнутость —
    // эфемерное состояние, очередь развернёт старейшую в refreshProposalQueue
    compactifyProposalCard(card, proposal);
    return card;
  }
  if (item.status === "invalid") {
    markProposalInvalid(card, status,
                        item.invalidReason || "payload невалиден", proposal);
  } else {
    const cls = ["applied", "declined", "undone", "stale"].includes(item.status)
      ? item.status : "declined";
    setStatusText(status, cls, RESTORED_STATUS_TEXT[item.status] || "Завершено");
    const actions = card.querySelector(".assistant-proposal-actions");
    if (actions) actions.remove();
  }
  collapseProposalCard(card, proposal,
                       RESTORED_STATUS_TEXT[item.status] || "Завершено");
  return card;
}

// Позиционная адресация до A3: условия правил с question-числом или edits
// с n/after-числом. Такие карточки из persist неприменимы (№ сдвигаются) —
// при восстановлении инвалидируются (restoredProposalCard).
function isLegacyPositionalProposal(proposal) {
  const p = (proposal && proposal.payload) || {};
  if (proposal.kind === "propose_decision") {
    return (p.outcomes || []).some(o => (o.rules || []).some(r =>
      (r.conditions || []).some(c => typeof c.question === "number")));
  }
  if (proposal.kind === "propose_questions") {
    return (p.edits || []).some(e =>
      typeof e.n === "number" || typeof e.after === "number");
  }
  return false;
}

// Восстановление ленты из persist при загрузке. Узлы активного разговора —
// сразу в ленту, неактивного — в кэш узлов (встанут при переключении).
function restoreChat() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(CHAT_KEY) || "null"); }
  catch { data = null; }
  if (!data || data.version !== CHAT_PERSIST_VERSION || !data.convos) return;
  let backfilled = false;
  for (const key of ["single", "batch"]) {
    const saved = data.convos[key];
    if (!saved) continue;
    const c = convos[key];
    c.feed = Array.isArray(saved.feed) ? saved.feed : [];
    c.history = (Array.isArray(saved.history) ? saved.history : [])
      .filter(m => m && (m.role === "user" || m.role === "assistant")
              && typeof m.content === "string");
    if (saved.annV !== 1) {  // бэкфилл аннотаций — один раз на конво
      backfillAnnotations(c);
      backfilled = true;
    }
    const nodes = c.feed.map(item => feedItemNode(key, item)).filter(Boolean);
    if (!nodes.length) continue;
    if (key === activeConvo) {
      const m = messagesEl();
      if (m) {
        hideIntro();
        for (const n of nodes) m.appendChild(n);
      }
    } else {
      c.nodes = nodes;
    }
  }
  if (backfilled) persistChat();
  // очередь pending после восстановления: старейшая разворачивается
  refreshProposalQueue("single");
  refreshProposalQueue("batch");
  updatePendingChip();
}

// Бэкфилл аннотаций истории (v0.9): истории, сохранённые до появления
// аннотаций, не несут факта показа карточек — на них модель имитирует
// паттерн «реплика без tool call» и нарративит карточки текстом (фантомы).
// Дописываем по ленте те же аннотации, что пишет sendMessage: карточки
// между user-итемом и следующим user-итемом принадлежат этому ходу.
// Выравнивание — с конца (история усечена сильнее ленты, user-реплики
// совпадают 1:1); уже аннотированные записи не трогаем.
function backfillAnnotations(c) {
  const feed = c.feed, history = c.history;
  let fi = feed.length - 1;
  for (let hi = history.length - 1; hi >= 0 && fi >= 0; hi -= 1) {
    const h = history[hi];
    if (h.role !== "user") continue;
    while (fi >= 0 && !(feed[fi].t === "user" && feed[fi].text === h.content)) {
      fi -= 1;
    }
    if (fi < 0) break;
    const cards = [];
    for (let i = fi + 1; i < feed.length && feed[i].t !== "user"; i += 1) {
      const it = feed[i];
      if (it.t === "proposal" && it.proposal) {
        cards.push(`предложена карточка «${it.proposal.title
          || it.proposal.kind}» (НЕ применена — применяет только пользователь кнопкой)`);
      } else if (it.t === "trial" && it.trial) {
        cards.push(`показан результат пробного прогона${it.trial.title
          ? ` «${it.trial.title}»` : ""}`);
      } else if (it.t === "analysis") {
        cards.push("показана карточка разбора прогона");
      } else if (it.t === "queue") {
        cards.push("показана очередь разметки (кандидаты)");
      }
    }
    const ans = history[hi + 1];
    if (cards.length && ans && ans.role === "assistant"
        && !ans.content.includes("[в этом ответе")) {
      ans.content += (ans.content ? "\n" : "")
        + cards.map(x => `[в этом ответе ${x}]`).join("\n");
    }
    fi -= 1;
  }
}

// ---------------------------------------------------------------- снапшот

function truncate(text, limit) {
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

// Ответы конкретного прогона: результат может быть вложенным ({decisions, fast_batch}).
function answersOf(res) {
  if (!res) return null;
  const r = res.decisions || res.fast_batch || res;
  return r.ok && r.answers ? r.answers : null;
}

function summarizeSingleResults() {
  const rs = state.results;
  if (!rs || !rs.results) return "";
  const lines = [];
  const keys = rs.order || Object.keys(rs.results);
  for (const key of keys) {
    const res = rs.results[key];
    const answers = answersOf(res);
    if (!answers) {
      // ошибки прогона — тоже факты для ассистента
      const r = res && (res.decisions || res.fast_batch || res);
      if (r && r.error) lines.push(`${modelShortLabel(key)}: ОШИБКА — ${r.error}`);
      continue;
    }
    const parts = [];
    for (const q of rs.questions || []) {
      const ans = answers[q.id];
      if (ans) parts.push(`${(q.question || q.id).slice(0, 60)} → ${shortAnswer(ans)}`);
    }
    if (parts.length) lines.push(`${modelShortLabel(key)}: ${parts.join("; ")}`);
  }
  // Расхождения между моделями по вопросам (главное в мультимодельном сравнении)
  if (keys.length > 1) {
    for (const q of rs.questions || []) {
      const per = [];
      for (const key of keys) {
        const ans = (answersOf(rs.results[key]) || {})[q.id];
        if (ans) per.push([key, shortAnswer(ans)]);
      }
      // сравниваем сам ответ (до « · уверенность»)
      const distinct = new Set(per.map(([, a]) => a.split(" · ")[0]));
      if (distinct.size > 1) {
        lines.push(`⚡ расходятся: ${(q.question || q.id).slice(0, 50)} — ` +
          per.map(([k, a]) => `${modelShortLabel(k)}=${a}`).join(", "));
      }
    }
  }
  if (rs.decision && rs.decision.enabled !== false && (rs.decision.outcomes || []).length) {
    const parts = [];
    for (const key of keys) {
      const answers = answersOf(rs.results[key]);
      if (!answers) continue;
      const dec = evaluateDecision(rs.decision, answers);
      parts.push(`${modelShortLabel(key)}=«${dec ? dec.label : "не определено"}»`);
    }
    if (parts.length) lines.push("решение: " + parts.join(", "));
  }
  return lines.join("\n");
}

function summarizeBatchResults() {
  const results = state.batch.results || {};
  const fileIds = Object.keys(results);
  if (!fileIds.length) return "";
  const modelKeys = new Set();
  for (const fid of fileIds) for (const k of Object.keys(results[fid] || {})) modelKeys.add(k);
  const lines = [`пакет: файлов с результатами ${fileIds.length}`];
  for (const q of state.questions) {
    for (const mk of modelKeys) {
      const counts = {};
      let n = 0;
      for (const fid of fileIds) {
        const ans = (answersOf(results[fid]?.[mk]) || {})[q.id];
        if (!ans) continue;
        n += 1;
        const a = shortAnswer(ans);
        counts[a] = (counts[a] || 0) + 1;
      }
      if (!n) continue;
      const agg = Object.entries(counts).sort((a, b) => b[1] - a[1])
        .map(([a, c]) => `${a}×${c}`).join(", ");
      lines.push(`${(q.question || q.id).slice(0, 60)} | ${modelShortLabel(mk)}: ${agg}`);
    }
  }
  const bd = state.batch.decision;
  if (bd && bd.enabled !== false && (bd.outcomes || []).length) {
    for (const mk of modelKeys) {
      const counts = {};
      let n = 0;
      for (const fid of fileIds) {
        const answers = answersOf(results[fid]?.[mk]);
        if (!answers) continue;
        n += 1;
        const dec = evaluateDecision(bd, answers);
        const label = dec ? dec.label : "не определено";
        counts[label] = (counts[label] || 0) + 1;
      }
      if (n) {
        lines.push(`решение | ${modelShortLabel(mk)}: ` +
          Object.entries(counts).map(([l, c]) => `${l}×${c}`).join(", "));
      }
    }
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

// Текущие правила решения для снапшота: ссылки на вопросы — по id (контракт
// A3, как в схеме propose_decision), threshold — в процентах 0–100.
function decisionSnapshot() {
  const d = state.decision;
  if (!d || !(d.outcomes || []).length) return null;
  return {
    outcomes: d.outcomes.map(o => ({
      label: o.label,
      isDefault: o.isDefault || undefined,
      rules: (o.rules || []).map(r => ({
        anyOf: r.anyOf || undefined,
        conditions: (r.conditions || []).map(c => {
          const out = { question: c.question, op: c.op };
          if (c.answer != null) {
            out.answer = c.answer;
            out.threshold = Math.round((c.threshold ?? 0.5) * 100);
          } else if (c.score != null) {
            out.score = c.score;
          }
          return out;
        }),
      })),
    })),
  };
}

// Выбранные в баре модели со статусом — включая выбранные, но остановленные
// (ассистент должен видеть, что их прогон не выполнится).
function selectedModelsSnapshot() {
  return state.models
    .filter(m => state.selectedModels.has(m.key))
    .map(m => ({ key: m.key, status: m.status || "unknown" }));
}

// Файлы батча: метаданные + урезанный текст (по файлу и по суммарному
// бюджету); dataUrl картинок — только если картинки кому-то нужны (vision
// chat-модель ассистента или vision-модели прогона — см. buildSnapshot).
function batchFilesSnapshot(withImages) {
  const files = state.batch.files;
  const perFile = Math.min(BATCH_FILE_TEXT_LIMIT,
    Math.max(300, Math.floor(BATCH_TEXT_TOTAL / Math.max(files.length, 1))));
  return files.map((f, idx) => {
    const imagesCount = f.isImage ? 1 : (f.images || []).length;
    const out = { num: idx + 1, id: f.id, name: f.name, size: f.size ?? null, imagesCount };
    if (!f.isImage && typeof f.text === "string" && f.text) {
      out.text = truncate(f.text, perFile);
    }
    if (withImages) {
      const urls = (f.isImage ? [f.dataUrl]
        : (f.images || []).slice(0, 2).map(img => img.dataUrl)).filter(Boolean);
      if (urls.length) out.images = urls;
    }
    return out;
  });
}

// Пофайловые результаты батча, компактно: {имя: {модель: {answers: {№: ответ},
// decision?, error?}}}. Вопросы — по № (как в questions снапшота). Детали
// сверх этого снапшота ассистент добирает тулом get_file_result.
function batchResultsSnapshot() {
  const results = state.batch.results || {};
  const fileIds = Object.keys(results).slice(0, BATCH_RESULT_FILES);
  if (!fileIds.length) return null;
  const qnum = {};
  state.questions.forEach((q, i) => { qnum[q.id] = i + 1; });
  const bd = state.batch.decision;
  const withDecision = bd && bd.enabled !== false && (bd.outcomes || []).length;
  const out = {};
  for (const fid of fileIds) {
    const f = state.batch.files.find(x => x.id === fid);
    const name = f ? f.name : fid;
    const perModel = {};
    for (const [mk, res] of Object.entries(results[fid] || {})) {
      const answers = answersOf(res);
      if (!answers) {
        const r = res && (res.decisions || res.fast_batch || res);
        perModel[mk] = { error: (r && r.error) || "ошибка прогона" };
        continue;
      }
      const cell = {};
      for (const q of state.questions) {
        const ans = answers[q.id];
        if (ans) cell[qnum[q.id]] = shortAnswer(ans);
      }
      const entry = { answers: cell };
      if (withDecision) {
        const dec = evaluateDecision(bd, answers);
        entry.decision = dec ? dec.label : "не определено";
      }
      perModel[mk] = entry;
    }
    out[name] = perModel;
  }
  return out;
}

// ---------------------------------------------------------------- разметка (reviewMarks)

const REVIEW_MARKS_LIMIT = 30;   // максимум пунктов в снапшоте
const REVIEW_MARKS_CHARS = 2200; // суммарный бюджет текста пунктов (+распределения)

// Компактное распределение вероятностей ответа: «да 87% / нет 13%»,
// choice/score — до 3 вариантов по убыванию. Нужно ассистенту для анализа
// размеченных ✗/? ячеек (там точность важнее top-ответа).
function distText(ans) {
  const p = ans && ans.probabilities;
  if (!p) return "";
  const entries = Object.entries(p).filter(([, v]) => v != null)
    .sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (!entries.length) return "";
  let s = entries.map(([k, v]) => `${answerLabel(k)} ${Math.round(v * 100)}%`).join(" / ");
  if (ans.label_mass != null) s += ` · масса на вариантах ${Math.round(ans.label_mass * 100)}%`;
  return s;
}

const RM_ICON = { accept: "✓", reject: "✗", unsure: "?" };

// Приоритет пунктов 4 уровня (v0.8, по ценности для анализа; хвост списка
// режется первым при нехватке бюджета): ✗/? с комментарием (ошибка + причина)
// → голые ✗/? → ✓ с комментарием → голые ✓ → заметки без вердикта.
function markPriority(m) {
  const bad = m.verdict === "reject" || m.verdict === "unsure";
  if (bad) return m.comment ? 0 : 1;
  if (m.verdict === "accept") return m.comment ? 2 : 3;
  return 4; // заметка без вердикта
}

// Разметка результатов (review.js): пометки аналитика, компактно. Резолюция
// ссылок — по снапшотам прогона (state.results.questions / state.batch.questions),
// не по живому редактору; сироты (цель не резолвится) исключены из items и totals.
function reviewMarksSnapshot() {
  const items = []; // {prio, text}
  // targets — структурные координаты пометок (v1.1): их читают инструменты
  // analyze_run/review_queue (analysis.py) — частоты/концентрации и исключение
  // размеченных ячеек из очереди; модель видит текстовые items.
  const targets = [];
  const totals = { accept: 0, reject: 0, unsure: 0, comments: 0 };
  let resolved = false;
  const push = (m, text, tinfo) => {
    resolved = true;
    items.push({ prio: markPriority(m), text });
    if (m.verdict) totals[m.verdict] += 1;
    if (m.comment) totals.comments += 1;
    if (tinfo && targets.length < REVIEW_MARKS_LIMIT) {
      const t = { ...tinfo, v: m.verdict || null };
      if (m.comment) t.c = m.comment.slice(0, 200);
      targets.push(t);
    }
  };
  const icon = (m) => (m.verdict ? RM_ICON[m.verdict] : "💬");
  const comment = (m) => (m.comment ? ` «${m.comment}»` : "");

  // одиночный режим
  const rs = state.results;
  if (rs && Array.isArray(rs.marks) && rs.marks.length) {
    const qs = rs.questions || [];
    const qnum = {};
    qs.forEach((q, i) => { qnum[q.id] = i + 1; });
    const models = new Set(Object.keys(rs.results || {}));
    const both = rs.runMode === "both";
    const msuffix = (t) => both && t.mode ? ` (${MODE_LABELS[t.mode] || t.mode})` : "";
    for (const m of rs.marks) {
      const t = m.target || {};
      const model = t.model ? modelShortLabel(t.model) : null;
      if (t.decision) {
        if (!models.has(t.model)) continue;
        push(m, `решение × ${model}${msuffix(t)}: ${icon(m)}${comment(m)}`,
             { sc: "single", dec: 1, m: t.model, ml: model, md: t.mode });
      } else if (t.question && t.model) {
        const n = qnum[t.question];
        if (!n || !models.has(t.model)) continue;
        // для ✗/? ячеек — полное распределение ответа (top-ответа мало)
        let dist = "";
        if (m.verdict === "reject" || m.verdict === "unsure") {
          const ans = (answersOf(rs.results[t.model]) || {})[t.question];
          const d = distText(ans);
          if (d) dist = ` · распределение: ${d}`;
        }
        push(m, `вопрос №${n} «${qs[n - 1].question}» × ${model}${msuffix(t)}: ${icon(m)}${comment(m)}${dist}`,
             { sc: "single", q: n, qid: t.question, m: t.model, ml: model, md: t.mode });
      } else if (t.question) {
        const n = qnum[t.question];
        if (!n) continue;
        push(m, `вопрос №${n} «${qs[n - 1].question}» (вопрос целиком): ${icon(m)}${comment(m)}`,
             { sc: "single", q: n, qid: t.question });
      } else if (t.model) {
        if (!models.has(t.model)) continue;
        push(m, `прогон ${model}${msuffix(t)}: ${icon(m)}${comment(m)}`,
             { sc: "single", m: t.model, ml: model, md: t.mode });
      }
    }
  }

  // пакет
  const bmarks = state.batch.marks || [];
  if (bmarks.length) {
    const bq = (state.batch.questions && state.batch.questions.length)
      ? state.batch.questions : state.questions;
    const qnum = {};
    bq.forEach((q, i) => { qnum[q.id] = i + 1; });
    const fnum = {};
    state.batch.files.forEach((f, i) => { fnum[f.id] = { n: i + 1, name: f.name }; });
    const models = new Set();
    for (const per of Object.values(state.batch.results || {})) {
      for (const k of Object.keys(per || {})) models.add(k);
    }
    for (const m of bmarks) {
      const t = m.target || {};
      const model = t.model ? modelShortLabel(t.model) : null;
      const f = t.file ? fnum[t.file] : null;
      if (t.decision) {
        if (!f || !models.has(t.model)) continue;
        push(m, `файл №${f.n} (${f.name}) × решение × ${model}: ${icon(m)}${comment(m)}`,
             { sc: "batch", dec: 1, f: f.name, fid: t.file, m: t.model, ml: model });
      } else if (t.question) {
        const n = qnum[t.question];
        if (!f || !n || !models.has(t.model)) continue;
        let dist = "";
        if (m.verdict === "reject" || m.verdict === "unsure") {
          const ans = (answersOf((state.batch.results || {})[t.file]?.[t.model]) || {})[t.question];
          const d = distText(ans);
          if (d) dist = ` · распределение: ${d}`;
        }
        push(m, `файл №${f.n} (${f.name}) × вопрос №${n} × ${model}: ${icon(m)}${comment(m)}${dist}`,
             { sc: "batch", f: f.name, fid: t.file, q: n, qid: t.question, m: t.model, ml: model });
      } else if (t.file) {
        if (!f) continue;
        push(m, `файл №${f.n} (${f.name}) целиком: ${icon(m)}${comment(m)}`,
             { sc: "batch", f: f.name, fid: t.file });
      } else if (t.model) {
        if (!models.has(t.model)) continue;
        push(m, `модель ${model} по пакету: ${icon(m)}${comment(m)}`,
             { sc: "batch", m: t.model, ml: model });
      }
    }
  }

  if (!resolved) return null;
  items.sort((a, b) => a.prio - b.prio);
  const out = [];
  let len = 0;
  for (const it of items) {
    if (out.length >= REVIEW_MARKS_LIMIT) break;
    if (out.length && len + it.text.length + 1 > REVIEW_MARKS_CHARS) break;
    out.push(it.text);
    len += it.text.length + 1;
  }
  const snap = { totals, items: out };
  if (targets.length) snap.targets = targets;
  // при stale номера вопросов/файлов — на момент прогона
  if ((state.resultsStale && rs && (rs.marks || []).length) ||
      (state.batch.resultsStale && bmarks.length)) {
    snap.stale = true;
  }
  return snap;
}

// Детальные результаты single-прогона для инструмента get_result (v0.7):
// по каждой модели — ответы на вопросы с полным распределением. Компактно
// (single = один контекст), в обрезке не участвует (мало данных).
function singleResultsSnapshot() {
  const rs = state.results;
  if (!rs || !rs.results) return null;
  const qs = rs.questions || [];
  const qnum = {};
  qs.forEach((q, i) => { qnum[q.id] = i + 1; });
  const out = {};
  for (const key of rs.order || Object.keys(rs.results)) {
    const answers = answersOf(rs.results[key]);
    if (!answers) continue;
    const rows = [];
    for (const q of qs) {
      const ans = answers[q.id];
      if (!ans) continue;
      const row = { n: qnum[q.id], answer: shortAnswer(ans) };
      const d = distText(ans);
      if (d) row.distribution = d;
      rows.push(row);
    }
    if (rows.length) out[modelShortLabel(key)] = rows;
  }
  return Object.keys(out).length ? out : null;
}

// Метрики прогонов — одна строка на модель (длительность, токены). Нужны
// ассистенту для оценки длительности будущих прогонов (планы-гейты) и
// заметности аномально медленных прогонов. Обрезкой жертвуем раньше разметки
// (prompts.py, шаг runs).
function runsSnapshot() {
  const lines = [];
  const fmt = (m) => {
    const parts = [];
    if (m.duration_s != null) parts.push(`${m.duration_s.toFixed(1)} с`);
    if (m.prompt_tokens != null) parts.push(`${m.prompt_tokens} ток промпта`);
    if (m.prefill_tok_s != null) parts.push(`${Math.round(m.prefill_tok_s)} ток/с`);
    return parts.join(", ");
  };
  const rs = state.results;
  if (rs && rs.results) {
    for (const key of rs.order || Object.keys(rs.results)) {
      const r = rs.results[key];
      const m = (r && (r.decisions || r.fast_batch || r).metrics) || {};
      const s = fmt(m);
      lines.push(`${modelShortLabel(key)}: ${s || "метрик нет"}`);
    }
  }
  const bres = state.batch.results || {};
  const perModel = {};
  for (const per of Object.values(bres)) {
    for (const [k, r] of Object.entries(per || {})) {
      const m = (r && (r.decisions || r.fast_batch || r).metrics) || {};
      const agg = perModel[k] || (perModel[k] = { n: 0, dur: 0 });
      agg.n += 1;
      if (m.duration_s != null) agg.dur += m.duration_s;
    }
  }
  for (const [k, agg] of Object.entries(perModel)) {
    lines.push(`${modelShortLabel(k)} (пакет): ${agg.n} файлов, суммарно ${agg.dur.toFixed(0)} с`);
  }
  return lines.length ? lines : null;
}

// Trace решений по последним результатам: почему сработал/не сработал исход
// (условия, значения, запас до порога). Сериализация тем же генератором, что
// hover-объяснения в UI (decision.js). Single — по каждой модели; batch —
// агрегат: счётчики исходов + самые частые провалы условий по файлам.
// В снапшоте не режется никогда (prompts.py) — ради него всё затеяно.
function decisionTraceSnapshot() {
  const lines = [];
  const rs = state.results;
  if (rs && rs.results && rs.decision && rs.decision.enabled !== false
      && (rs.decision.outcomes || []).length) {
    for (const key of rs.order || Object.keys(rs.results)) {
      const answers = answersOf(rs.results[key]);
      if (!answers) continue;
      const { res, trace } = explainDecision(rs.decision, answers);
      const desc = describeDecision(res, trace, rs.questions);
      lines.push(`${modelShortLabel(key)}: ${desc.title}`);
      for (const l of desc.lines.slice(0, 6)) lines.push(`  ${l}`);
    }
  }
  const bd = state.batch.decision;
  const bres = state.batch.results || {};
  const bq = (state.batch.questions && state.batch.questions.length)
    ? state.batch.questions : state.questions;
  if (bd && bd.enabled !== false && (bd.outcomes || []).length
      && Object.keys(bres).length) {
    const qnum = {};
    bq.forEach((q, i) => { qnum[q.id] = i + 1; });
    const perModel = {};
    for (const per of Object.values(bres)) {
      for (const [mk, r] of Object.entries(per || {})) {
        const answers = answersOf(r);
        if (!answers) continue;
        const { res, trace } = explainDecision(bd, answers);
        const agg = perModel[mk] || (perModel[mk] = { outcomes: {}, failed: {}, n: 0 });
        agg.n += 1;
        const lbl = res ? res.label : "не определено";
        agg.outcomes[lbl] = (agg.outcomes[lbl] || 0) + 1;
        for (const t of trace) {
          for (const det of (t.conditions || []).filter(d => !d.ok)) {
            const ct = conditionText(det, bq, qnum);
            agg.failed[ct] = (agg.failed[ct] || 0) + 1;
          }
        }
      }
    }
    for (const [mk, agg] of Object.entries(perModel)) {
      const oc = Object.entries(agg.outcomes).map(([l, c]) => `${l}×${c}`).join(", ");
      lines.push(`${modelShortLabel(mk)} (пакет, ${agg.n} файлов): ${oc}`);
      const top = Object.entries(agg.failed).sort((a, b) => b[1] - a[1]).slice(0, 3);
      for (const [ct, c] of top) lines.push(`  условие не прошло в ${c}/${agg.n}: ${ct}`);
    }
  }
  return lines.length ? lines.join("\n") : null;
}

export function buildSnapshot() {
  let ctxText = "";
  try {
    const snap = contextSnapshot();
    ctxText = typeof snap.input === "string" ? snap.input : JSON.stringify(snap.input);
  } catch { ctxText = ""; }
  // Картинки (dataUrl) включаем, если они кому-то нужны: vision chat-модели
  // ассистента (она их увидит) или vision decision-моделям среди выбранных —
  // пробные прогоны (run_trial useImages) берут картинки из снапшота.
  const chatVision = !!state.models.find(m => m.key === selectedModel)?.vision;
  const trialVision = state.models.some(m =>
    m.vision && m.status === "running" && state.selectedModels.has(m.key));
  const withImages = chatVision || trialVision;
  const context = {
    text: truncate(ctxText, CONTEXT_LIMIT),
    imagesCount: state.contextImages.length,
  };
  if (withImages && state.contextImages.length) {
    context.images = state.contextImages.map(img => img.dataUrl);
    if (!chatVision) {
      context.imagesNote = "картинки приложены для пробных прогонов vision-моделями (run_trial useImages); ты их не видишь";
    }
  } else if (state.contextImages.length) {
    context.imagesNote = "картинки есть, но их не видит ни ассистент, ни выбранные модели прогона (нет vision)";
  }
  const snapshot = {
    page: state.pageMode,
    context,
    questions: state.questions.map((q, idx) => {
      // n — номер карточки в UI (отображение и ссылки в тексте ответа), id —
      // стабильный адрес для аргументов инструментов (контракт A3)
      const out = { n: idx + 1, id: q.id, question: q.question, type: q.type };
      if (q.type === "yes_no") {
        if (q.yes) out.yes = q.yes;
        if (q.no) out.no = q.no;
        out.direction = q.direction || "neutral";
      } else if (q.type === "choice") {
        out.options = (q.options || []).map(o => o.name);
      } else if (q.type === "score") {
        out.levels = (q.levels || []).slice();
        out.direction = q.direction || "neutral";
      }
      return out;
    }),
    selectedModels: selectedModelsSnapshot(),
    decision: decisionSnapshot(),
  };
  if (state.batch.files.length) {
    snapshot.batchFiles = batchFilesSnapshot(withImages);
  }
  const batchResults = batchResultsSnapshot();
  if (batchResults) snapshot.batchResults = batchResults;
  // Сводка неактивной страницы: вопросы/правила у страниц общие, различаются
  // контекст (single) и файлы (batch).
  snapshot.otherPage = state.pageMode === "batch"
    ? { page: "single", hasContext: !!ctxText.trim() || state.contextImages.length > 0 }
    : { page: "batch", files: state.batch.files.length, hasResults: !!batchResults };
  const parts = [summarizeSingleResults(), summarizeBatchResults()].filter(Boolean);
  // reviewMarks ДО resultsSummary: крайняя хвостовая обрезка serialize_snapshot
  // (prompts.py) режет конец JSON — поле после сводки съедалось бы первым.
  const reviewMarks = reviewMarksSnapshot();
  if (reviewMarks) snapshot.reviewMarks = reviewMarks;
  const trace = decisionTraceSnapshot();
  if (trace) snapshot.decisionTrace = trace;
  const singleResults = singleResultsSnapshot();
  if (singleResults) snapshot.singleResults = singleResults;
  const runs = runsSnapshot();
  if (runs) snapshot.runs = runs;
  snapshot.resultsSummary = parts.length ? truncate(parts.join("\n"), RESULTS_LIMIT) : null;
  return snapshot;
}

// ---------------------------------------------------------------- квитанции (A4)

// Каноническая форма состояния для ревизии квитанций (контракт A4 — зеркалится
// бэкендом, receipts.py canonical_state): q — вопросы [id, тип, текст] (порядок
// значим), d — исходы [label, isDefault, правила [anyOf, условия [question(id),
// op, answer, threshold, score]]] (пороги в %, как в снапшоте), c — текст
// материала (урезанный, как в снапшоте), b — имена файлов пакета.
// Вход — выход buildSnapshot() (та же урезка контекста, что уходит на бэк).
export function canonicalState(snap) {
  const q = (snap.questions || []).map(q => [q.id || "", q.type || "", q.question || ""]);
  const outs = ((snap.decision || {}).outcomes) || null;
  const d = outs && outs.length ? outs.map(o => [
    o.label || "", !!o.isDefault,
    (o.rules || []).map(r => [
      !!r.anyOf,
      (r.conditions || []).map(c => [
        c.question || "", c.op || "",
        c.answer ?? null, c.threshold ?? null, c.score ?? null,
      ]),
    ]),
  ]) : null;
  return {
    q, d,
    c: (snap.context || {}).text || "",
    b: (snap.batchFiles || []).map(f => f.name || ""),
  };
}

// Ревизия состояния = hashString (djb2/base36) от канонической JSON — тот же
// алгоритм на бэке (_djb2_base36 в receipts.py), значения сходятся.
export function stateRevision(snap) {
  return hashString(JSON.stringify(canonicalState(snap)));
}

// Post-state сводка для квитанции (считается в момент применения карточки).
function postStateSummary(proposal) {
  const p = proposal.payload || {};
  if (proposal.kind === "propose_questions") {
    return `вопросов: ${state.questions.length}`;
  }
  if (proposal.kind === "propose_decision") {
    return `исходов: ${(((state.decision || {}).outcomes) || []).length}`;
  }
  if (proposal.kind === "propose_context") {
    if (p.file) {
      const f = state.batch.files.find(x => x.name === p.file);
      return `файл «${p.file}»: ${String((f && f.text) || "").length} симв.`;
    }
    return `текст материала: ${currentContextText().length} симв.`;
  }
  return null;  // run/preset — без post-state
}

// Бикон исхода карточки → квитанция на бэке (очередь сессии → контекст
// следующего хода). event_id = proposal.id:outcome — idempotency-key против
// двойной доставки (двойной клик, два таба, ретрай): бэкенд дубль не ставит.
function receiptBeacon(proposal, outcome, detail) {
  const body = { kind: proposal.kind, proposal_id: proposal.id, outcome,
                 title: proposal.title || null };
  if (proposal.id) body.event_id = `${proposal.id}:${outcome}`;
  if (detail) body.detail = detail;
  if (outcome === "applied" || outcome === "undone") {
    const s = postStateSummary(proposal);
    if (s) body.post_state = s;
  }
  try { body.revision = stateRevision(buildSnapshot()); } catch { /* без ревизии */ }
  assistantEvent(body);
}

// ---------------------------------------------------------------- SSE-маппинг (чистая часть)

// Разбор одного SSE-блока (data: {...}\n\n) в события. Чистая функция —
// тестируется без DOM.
export function parseSseChunk(chunk) {
  const events = [];
  for (const line of chunk.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* пропуск */ }
  }
  return events;
}

// ---------------------------------------------------------------- отправка

// Кнопка отправки: обычное состояние — paper-plane (disabled при пустом
// вводе), на всё время активного запроса (стрим токенов, инструменты,
// thinking) — красный СТОП.
// Индикация на кнопке «✨ Ассистент» в тулбаре: is-working — запрос активен
// (тот же флаг streaming, что у стоп-кнопки), has-unread — запрос завершился
// непросмотренным. Оба состояния показываются только при закрытой панели.
function updateToolbarButton() {
  const btn = document.getElementById("tb-assistant");
  if (!btn) return;
  const closed = panel().classList.contains("hidden");
  btn.classList.toggle("is-working", streaming && closed);
  btn.classList.toggle("has-unread", unread && closed);
}

export function updateSendButton() {
  const btn = sendEl();
  if (!btn) return;
  updateToolbarButton();
  if (streaming) {
    btn.classList.add("is-stop");
    btn.innerHTML = STOP_SVG;
    btn.disabled = false;
    btn.title = "Остановить ответ";
  } else {
    btn.classList.remove("is-stop");
    btn.innerHTML = PLANE_SVG;
    const ta = inputEl();
    btn.disabled = !ta || !ta.value.trim();
    btn.title = "Отправить (Enter)";
  }
}

function stopRequest() {
  if (activeController) activeController.abort();
}

// Флаги событий для следующего хода (A4): prevAborted — прошлый ответ прерван
// пользователем (СТОП); externalChange — состояние менялось в другой вкладке
// (storage-event на ключ воркспейса; storage события приходят только в ЧУЖИЕ
// вкладки, не в пишущую). Уходят с телом следующего запроса и сбрасываются.
let prevAborted = false;
let externalChange = false;
let storageWiredWindow = null;

function wireStorageListener() {
  if (storageWiredWindow === window) return;  // одно окно — один слушатель
  storageWiredWindow = window;
  window.addEventListener("storage", (e) => {
    if (e.key === "dq-workspace") externalChange = true;
  });
}

export async function sendMessage(text, opts = {}) {
  if (streaming) return;
  text = (text || "").trim();
  if (!text) return;
  if (!selectedModel) {
    addErrorMessage("Выберите chat-модель внизу панели (локальная sglang/llamacpp или облачная ☁).");
    return;
  }
  // Разговор фиксируется на старте: если пользователь переключит страницу
  // посреди ответа, стрим продолжит писаться в свой чат (в сохранённые узлы).
  const convoKey = activeConvo;
  const convo = convos[convoKey];
  streaming = true;
  updateSendButton();
  addUserMessage(text, convoKey, opts);
  scrollDown(true); // своя отправка — всегда вниз
  convo.history.push({ role: "user", content: text });
  const typing = showTyping(convoKey);

  let answerText = "";
  let thinkingText = "";
  let thinkingShown = false;
  let answerBody = null;
  let finished = false;
  let aborted = false;
  const shownCards = [];  // факты показа карточек — аннотация истории (v0.9)
  turnVirtualQuestions = null;  // новый ход — виртуальный набор прежнего не действует

  const controller = new AbortController();
  activeController = controller;

  const showThinking = () => {
    if (!thinkingText || thinkingShown) return;
    thinkingShown = true;
    appendMsg(thinkingEl(thinkingText), convoKey);
  };

  let reader = null;
  // флаги событий (A4) — в тело запроса и сразу сброс: ушедшее не повторяется
  const flags = { prev_aborted: prevAborted, external_change: externalChange };
  prevAborted = false;
  externalChange = false;
  try {
    const resp = await fetch("/api/assistant/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model_key: selectedModel,
        message: text,
        history: convo.history.slice(0, -1).slice(-HISTORY_LIMIT),
        snapshot: buildSnapshot(),
        thinking: !!document.getElementById("assistant-thinking").checked,
        session_id: getAssistantSessionId(),
        ...flags,
      }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      addErrorMessage(data.detail || `Ошибка ${resp.status}`, convoKey);
      finished = true;
    } else {
      reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const ev of parseSseChunk(chunk)) {
            if (ev.type === "token") {
              if (!answerBody) {
                typing.remove();
                showThinking();
                answerBody = createAnswerMessage(convoKey);
              }
              answerText += ev.text || "";
              renderMarkdown(answerBody, answerText);
              scrollDown();
            } else if (ev.type === "thinking") {
              thinkingText += ev.text || "";
            } else if (ev.type === "tool") {
              if ((ev.name === "phantom_guard" || ev.name === "degrade_guard")
                  && answerBody) {
                // доретрайный черновик (фантомные цифры / мусор) уже ушёл
                // стримом — стираем его, чтобы в ленте остался только
                // исправленный ответ (инцидент 17.10: выдуманная таблица
                // прогона дошла до пользователя и отравила следующие ходы)
                answerText = "";
                renderMarkdown(answerBody, "");
              }
              showToolEvent(ev.name, ev.status, ev.message, convoKey, ev.internal);  // строка в ленте, обновится по done
            } else if (ev.type === "trial_progress") {
              // живой прогресс пробного прогона (макет 4.2) — на месте карточки
              const open = [...convos[convoKey].openTools].reverse()
                .find(t => t.progress && !t.progress.settled);
              if (open) open.progress.onProgress(ev);
            } else if (ev.type === "trial") {
              const abortedTrial = !!(ev.trial && ev.trial.aborted);
              shownCards.push(abortedTrial
                ? "пробный прогон прерван пользователем — показан частичный результат"
                : `показан результат пробного прогона${ev.trial && ev.trial.title
                  ? ` «${ev.trial.title}»` : ""}`);
              handleTrial(ev.trial, convoKey);  // карточка-таблица в ленте, UI не мутируется
            } else if (ev.type === "analysis") {
              shownCards.push("показана карточка разбора прогона");
              handleAnalysis(ev.analysis, convoKey);  // информационная карточка, UI не мутируется
            } else if (ev.type === "review_queue") {
              shownCards.push("показана очередь разметки (кандидаты)");
              handleQueue(ev.queue, convoKey);
            } else if (ev.type === "proposal") {
              shownCards.push(`предложена карточка «${(ev.proposal && ev.proposal.title)
                || ev.proposal.kind}» (НЕ применена — применяет только пользователь кнопкой)`);
              handleProposal(ev.proposal, convoKey);  // карточка «Принять»/«Отклонить» в ленте
            } else if (ev.type === "done") {
              finished = true;
            } else if (ev.type === "error") {
              showThinking();
              addErrorMessage(ev.message || "Ошибка ассистента", convoKey);
              finished = true;
            }
          }
        }
      }
      if (!finished && !aborted) addNote("⚠ соединение прервано", convoKey);
    }
  } catch (e) {
    if (aborted || (e && e.name === "AbortError")) {
      aborted = true;  // ручная отмена — не ошибка
    } else {
      addErrorMessage(e.message || String(e), convoKey);
      finished = true;
    }
  }
  if (aborted && reader) { try { await reader.cancel(); } catch { /* уже закрыт */ } }
  typing.remove();
  showThinking();
  if (aborted) {
    addNote("остановлено пользователем", convoKey);
    prevAborted = true;  // квитанция-флаг следующего хода (A4): «прошлый ответ прерван»
    // живая карточка пробного прогона — в терминал «Прервано» (4.12): поток
    // закрыт, trial-событие с частичными ответами уже не доедет — остаётся
    // только «досчитать»
    const remaining = [];
    for (const t of convo.openTools) {
      if (t.progress) {
        if (!t.progress.settled) {
          t.progress.settleAborted(null);
          const item = { t: "trial", trial: t.progress.trial,
                         trialStatus: "aborted" };
          t.progress.card._feedItem = item;
          pushFeed(convoKey, item);
        }
        continue;  // запись прогресса из стека вызовов убираем — финал показан
      }
      remaining.push(t);
    }
    convo.openTools.length = 0;
    convo.openTools.push(...remaining);
  }
  // Аннотация истории (v0.9): persist-история — единственный «обучающий
  // сигнал» модели о прошлых ходах; без факта показа карточек на длинной
  // истории модель имитирует паттерн «реплика без tool call» и нарративит
  // карточки текстом (фантомы). Аннотируем только history — в ленте карточки
  // и так видны.
  let historyText = answerText.trim();
  if (shownCards.length) {
    historyText += (historyText ? "\n" : "")
      + shownCards.map(c => `[в этом ответе ${c}]`).join("\n");
  }
  if (historyText) {
    convo.history.push({ role: "assistant", content: historyText });
    if (answerText.trim()) pushFeed(convoKey, { t: "assistant", text: answerText });
  }
  // завершение при закрытой панели → бейдж на кнопке; ручная остановка — без бейджа
  if (finished && panel().classList.contains("hidden")) unread = true;
  activeController = null;
  streaming = false;
  updateSendButton();
}

// ---------------------------------------------------------------- пробный прогон

// Правила решения из аргументов run_trial (вопросы по id, контракт A3; пороги
// в %) → формат движка evaluateDecision (id вопроса, 0..1). Числовой question
// — legacy persist (карточки до A3): позиционный фолбэк по списку прогона.
function trialDecisionEngine(trial) {
  const d = trial.decision;
  if (!d || !(d.outcomes || []).length) return null;
  const qs = trial.questions || [];
  const engine = {
    outcomes: d.outcomes.map((o, i) => ({
      id: "to" + (i + 1),
      label: o.label,
      color: o.color,
      isDefault: !!o.isDefault,
      rules: (o.rules || []).map(r => ({
        anyOf: !!r.anyOf,
        conditions: (r.conditions || []).map(c => {
          const qid = typeof c.question === "string" ? c.question
            : (qs[Math.round(Number(c.question)) - 1] || {}).id;
          const cond = { question: qid || String(c.question),
                         op: c.op === "lt" ? "lt" : "gte" };
          if (c.answer != null) {
            cond.answer = c.answer;
            let thr = Number(c.threshold);
            if (!Number.isFinite(thr)) thr = 50;
            if (thr > 1) thr /= 100;
            cond.threshold = thr;
          } else {
            cond.score = Number(c.score);
          }
          return cond;
        }),
      })),
    })),
  };
  // Правила пришли от модели и до движка раньше не валидировались — невалидное
  // условие (напр. answer «да» вместо yes) тихо давало false и неверные
  // исходы. Валидируем как validateDecision в редакторе; в событии trial нет
  // полного списка опций choice-вопросов — восстанавливаем их из ключей
  // probabilities ответов прогона.
  const optsById = {};
  for (const row of trial.rows || []) {
    for (const [qid, ans] of Object.entries(row.fullAnswers || {})) {
      if (!optsById[qid] && ans && ans.probabilities) {
        optsById[qid] = Object.keys(ans.probabilities);
      }
    }
  }
  const vqs = qs.map(q => ({ ...q,
    options: (optsById[q.id] || []).map(name => ({ name })) }));
  try {
    validateDecision(engine, vqs);
  } catch (e) {
    return { invalid: String((e && e.message) || e) };
  }
  return engine;
}

function decisionBadgeEl(dec) {
  const span = document.createElement("span");
  span.className = "assistant-trial-decision";
  if (!dec) {
    span.textContent = "не определено";
    return span;
  }
  const colors = OUTCOME_COLORS[dec.color] || OUTCOME_COLORS.gray;
  span.textContent = dec.label;
  span.style.background = colors.bg;
  span.style.color = colors.fg;
  span.style.borderColor = colors.border;
  return span;
}

// Ответы прогона пользователя {modelKey: {текст вопроса: answer}} — для
// маркеров отличий (вопросы прогона и пробы сопоставляем по тексту).
function userRunAnswersByText() {
  const rs = state.results;
  if (!rs || !rs.results) return null;
  const out = {};
  for (const key of rs.order || Object.keys(rs.results)) {
    const answers = answersOf(rs.results[key]);
    if (!answers) continue;
    const byText = {};
    for (const q of rs.questions || []) {
      if (answers[q.id]) byText[q.question] = answers[q.id];
    }
    out[key] = byText;
  }
  return Object.keys(out).length ? out : null;
}

// Дельта what-if прогона на размеченных исходах (макет 7): те же пометки
// decision-ячеек и семантика, что у ruleDelta (✗ сменился → исправлено и т.д.),
// но «после» — исход по правилам trial на ответах пробного прогона. Покрытие:
// single — пометки моделей, участвующих в trial; batch — пометки файла
// trial.batchFile × моделей trial. engine — валидированный движок правил
// trial (trialDecisionEngine).
// Ячейки дельты what-if: {verdict, before, after, scope, model, mode, file?}.
// before — исход по правилам прогона пользователя на его ответах, after —
// исход по правилам trial на ответах пробного прогона.
function trialDeltaCells(trial, engine) {
  const rowsByModel = {};
  for (const r of trial.rows || []) {
    if (!r.error && r.model) rowsByModel[r.model] = r;
  }
  const cells = [];
  let stale = false;
  const outcome = (decision, answers) => {
    const res = evaluateDecision(decision, answers);
    return res ? res.label : null;
  };
  const rs = state.results;
  if (rs && rs.results && (rs.marks || []).length) {
    const beforeDecision = rs.decision || state.decision;
    if (beforeDecision) {
      for (const m of rs.marks) {
        const t = m.target || {};
        if (!t.decision || !rowsByModel[t.model]) continue;
        const before = answersOfMode(rs.results[t.model], t.mode);
        const row = rowsByModel[t.model];
        if (!before || !row || !Object.keys(row.fullAnswers || {}).length) continue;
        cells.push({ verdict: m.verdict,
                     before: outcome(beforeDecision, before),
                     after: outcome(engine, row.fullAnswers),
                     scope: "single", model: t.model, mode: t.mode });
      }
      if (state.resultsStale) stale = true;
    }
  }
  if (trial.batchFile) {
    const f = state.batch.files.find(x => x.name === trial.batchFile);
    const bmarks = state.batch.marks || [];
    const beforeDecision = state.batch.decision || state.decision;
    if (f && bmarks.length && beforeDecision) {
      for (const m of bmarks) {
        const t = m.target || {};
        if (!t.decision || t.file !== f.id || !rowsByModel[t.model]) continue;
        const before = answersOfMode((state.batch.results || {})[t.file]?.[t.model],
                                     t.mode);
        const row = rowsByModel[t.model];
        if (!before || !row || !Object.keys(row.fullAnswers || {}).length) continue;
        cells.push({ verdict: m.verdict,
                     before: outcome(beforeDecision, before),
                     after: outcome(engine, row.fullAnswers),
                     scope: "batch", model: t.model, mode: t.mode, file: f.name });
      }
      if (state.batch.resultsStale) stale = true;
    }
  }
  return { cells, stale };
}

// Размеченные ячейки вопросов (пометки ✓/✗/? у ОТВЕТОВ, не у решений) для
// таблицы ответов what-if (макет 4.3а): «было» — ответ прогона пользователя,
// «стало» — ответ пробного прогона (вопрос сопоставлен по тексту). Если
// вопроса нет в trial или ответа нет в прогоне пользователя — ячейку не
// показываем: сдвиг недоступен детерминированно. В статистику дельты эти
// ячейки не входят (там только исходы решений).
// → [{verdict, qnum, file?, model, mode, before, after}]
function trialMarkedQuestionCells(trial) {
  const rowsByModel = {};
  for (const r of trial.rows || []) {
    if (!r.error && r.model) rowsByModel[r.model] = r;
  }
  const trialQByText = {};
  for (const q of trial.questions || []) trialQByText[q.question] = q;
  const cells = [];
  const collect = (marks, runQuestions, answersFor, fileName) => {
    const qnum = {};
    runQuestions.forEach((q, i) => { qnum[q.id] = i + 1; });
    for (const m of marks) {
      const t = m.target || {};
      if (!t.question || t.decision || !t.model || !rowsByModel[t.model]) continue;
      const uq = runQuestions.find(q => q.id === t.question);
      const tq = uq && trialQByText[uq.question];
      if (!tq) continue; // вопроса в пробном прогоне нет — сдвиг не считаем
      const beforeAns = (answersFor(t) || {})[t.question];
      const afterAns = (rowsByModel[t.model].fullAnswers || {})[tq.id];
      if (!beforeAns || !afterAns) continue;
      cells.push({ verdict: m.verdict, qnum: qnum[t.question] ?? null,
                   file: fileName, model: t.model, mode: t.mode,
                   before: shortAnswer(beforeAns), after: shortAnswer(afterAns) });
    }
  };
  const rs = state.results;
  if (rs && rs.results && (rs.marks || []).length) {
    collect(rs.marks, rs.questions || [],
            t => answersOfMode(rs.results[t.model], t.mode), null);
  }
  if (trial.batchFile) {
    const f = state.batch.files.find(x => x.name === trial.batchFile);
    const bq = (state.batch.questions && state.batch.questions.length)
      ? state.batch.questions : state.questions;
    if (f) {
      collect(state.batch.marks || [], bq,
              t => answersOfMode((state.batch.results || {})[t.file]?.[t.model],
                                 t.mode),
              f.name);
    }
  }
  return cells;
}

// Расхождения моделей по вопросам what-if (макет 4.3а, delta-sub): число
// различающихся пар top-ответов среди моделей прогона — в прогоне
// пользователя (было) и в пробном (стало). Только по вопросам trial,
// совпадающим по тексту с вопросами прогона пользователя; базы нет
// (прогон пользователя не по этим моделям) — не показываем.
function trialDisagreements(trial) {
  const rows = (trial.rows || []).filter(r => !r.error && r.model);
  if (rows.length < 2) return [];
  const userRun = userRunAnswersByText();
  if (!userRun) return [];
  const diffPairs = (arr) => {
    let d = 0;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) if (arr[i] !== arr[j]) d++;
    }
    return d;
  };
  const rsQs = (state.results && state.results.questions) || [];
  const out = [];
  // сравнение по top-ответу без уверенности («да 90%» и «да 85%» — согласие)
  const top = (a) => shortAnswer(a).split(" · ")[0];
  for (const q of trial.questions || []) {
    const after = diffPairs(rows.map(r => (r.fullAnswers || {})[q.id])
      .filter(Boolean).map(top));
    const beforeArr = rows
      .map(r => userRun[r.model] && userRun[r.model][q.question])
      .filter(Boolean).map(top);
    if (beforeArr.length < 2) continue; // «было» недоступно — не выдумываем
    const before = diffPairs(beforeArr);
    if (before === after) continue;
    const idx = rsQs.findIndex(x => x.question === q.question);
    out.push({ n: idx >= 0 ? idx + 1 : null, before, after });
  }
  return out;
}

// Таблица ответов what-if (макет 4.3а): строки — размеченные ячейки с
// изменением (или оставшейся ошибкой), колонки «было/стало» — исходы до/после
// (ячейки решений) и ответы (ячейки вопросов — подпись «файл · №N × модель»),
// метка ✗→✓ формой знака (цвет — второй канал); «ещё N без изменений» —
// приглушённый итог. Имя файла — flink (превью по hover).
function trialAnswersTableEl(cells, qcells = []) {
  const all = cells.concat(qcells);
  const rows = all.filter(c => c.before !== c.after || c.verdict === "reject");
  if (!rows.length) return null;
  const table = document.createElement("table");
  table.className = "assistant-trial-answers";
  const headRow = document.createElement("tr");
  for (const h of ["ячейка", "было", "стало", "метка"]) {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  }
  table.appendChild(headRow);
  const glyph = (ok) => {
    const s = document.createElement("span");
    s.style.color = ok ? "var(--ok)" : "var(--bad)";
    s.style.fontWeight = "600";
    s.textContent = ok ? "✓" : "✗";
    return s;
  };
  const cellLabel = (c) => {
    const td = document.createElement("td");
    td.className = "ta-cell";
    const model = modelShortLabel(c.model)
      + (c.mode && state.results && state.results.runMode === "both"
        ? ` · ${MODE_LABELS[c.mode] || c.mode}` : "");
    if (c.qnum != null) {
      // размеченная ячейка вопроса (макет 4.3а): «файл · №N × модель»
      if (c.file) {
        td.appendChild(fileLinkEl(c.file));
        td.appendChild(document.createTextNode(` · №${c.qnum} × ${model}`));
      } else {
        td.textContent = `№${c.qnum} × ${model}`;
      }
    } else if (c.scope === "batch" && c.file) {
      td.appendChild(fileLinkEl(c.file));
      td.appendChild(document.createTextNode(` × ${model}`));
    } else {
      td.textContent = model;
    }
    return td;
  };
  for (const c of rows) {
    const tr = document.createElement("tr");
    tr.appendChild(cellLabel(c));
    const tdOld = document.createElement("td");
    tdOld.className = "ta-old";
    tdOld.textContent = `«${c.before ?? "не определено"}»`;
    const tdNew = document.createElement("td");
    tdNew.className = "ta-new";
    tdNew.textContent = `«${c.after ?? "не определено"}»`;
    const tdMark = document.createElement("td");
    tdMark.className = "ta-mark";
    if (c.before !== c.after) {
      // ✗ → ✓ (исправлено) / ✓ → ✗ (сломано) / ? → ~ (затронуто)
      tdMark.appendChild(glyph(c.verdict === "accept"));
      tdMark.appendChild(document.createTextNode(" → "));
      tdMark.appendChild(glyph(c.verdict === "reject"));
    } else {
      tdMark.appendChild(glyph(false));
      const dim = document.createElement("span");
      dim.className = "dim";
      dim.textContent = " осталась";
      tdMark.appendChild(dim);
    }
    tr.append(tdOld, tdNew, tdMark);
    table.appendChild(tr);
  }
  const same = all.length - rows.length;
  if (same > 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "ta-same";
    td.colSpan = 4;
    td.textContent = `ещё ${same} ${plural(same, "ячейка", "ячейки", "ячеек")} без изменений — исходы совпали`;
    tr.appendChild(td);
    table.appendChild(tr);
  }
  return detailsDomEl("таблица ответов", [table]);
}

function trialDeltaEl(trial, engine) {
  const box = document.createElement("div");
  box.className = "assistant-delta";
  const { cells, stale } = trialDeltaCells(trial, engine);
  if (!cells.length) {
    box.classList.add("assistant-delta-dim");
    box.textContent = "Эффект не измерен: по ячейкам этого прогона нет вашей "
      + "разметки исходов (✓/✗ у решений) — разметьте исходы, и следующие "
      + "прогоны будут проверяться на них.";
    return box;
  }
  if (stale) {
    box.classList.add("assistant-delta-stale");
    box.textContent = "Дельту посчитать нельзя: разметка относится к старой "
      + "редакции (вопросы или правила менялись после прогона). "
      + "Сначала перепрогоните.";
    return box;
  }
  const d = deltaStats(cells);
  const head = document.createElement("div");
  head.className = "assistant-delta-head";
  head.textContent = `На размеченных исходах: ${d.total} — ошибок `
    + `${d.errorsBefore} → ${d.errorsAfter}`;
  box.appendChild(head);
  const parts = [];
  if (d.fixed) parts.push(`исправлено ${d.fixed}`);
  parts.push(`новых ошибок ${d.broken}`);
  if (d.touched) parts.push(`затронуто (?) ${d.touched}`);
  // расхождения моделей по затронутым вопросам (макет 4.3а): «по №3: 4 → 0»
  for (const g of trialDisagreements(trial)) {
    parts.push(g.n != null
      ? `расхождения моделей по №${g.n}: ${g.before} → ${g.after}`
      : `расхождения моделей: ${g.before} → ${g.after}`);
  }
  const sub = document.createElement("div");
  sub.className = "assistant-delta-sub";
  sub.textContent = parts.join(" · ");
  box.appendChild(sub);
  // таблица ответов по размеченным ячейкам — disclosure ▸/▾ (макет 4.3а)
  const answersTable = trialAnswersTableEl(cells, trialMarkedQuestionCells(trial));
  if (answersTable) box.appendChild(answersTable);
  if (d.total < 5) {
    const warn = document.createElement("div");
    warn.className = "assistant-delta-warn";
    warn.textContent = `⚠ выборка маленькая (${d.total}), погрешность ≈1 ошибка`;
    box.appendChild(warn);
  }
  return box;
}

// Терминал trial-карточки what-if (макет 4.3, общий паттерн терминальной
// строки): пилла + гипотеза, разворот по клику на строку. Применение/отказ
// касаются правки вопросов — сам прогон-результат остаётся в карточке.
// Длительность шага/прогона человеком: «12 с» / «2 мин 05 с» (макет 4.2).
function fmtDurationRu(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  return `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, "0")} с`;
}

// Живая карточка пробного прогона (макет 4.2/4.2а «Рамс») — вместо tool-строки
// для run_trial: пилла live «шаг k/n» (пульс), полоса прогресса, disclosure
// «шаги» (длительность и счётчики каждого шага, шаг с ошибкой — красным,
// имена файлов в причине — flink'ами), кнопка «Прервать». Обновляется на
// месте событиями trial_progress; по tool done сворачивается в терминальную
// строку (место старой «✓ Пробный прогон»), по trial с aborted:true — в
// терминал «Прервано» (4.12). В persist не пишется (как и tool-строки).
function trialProgressCard(key = activeConvo) {
  const card = document.createElement("div");
  card.className = "assistant-proposal assistant-trial-progress";
  const top = document.createElement("div");
  top.className = "assistant-proposal-top";
  const eye = document.createElement("span");
  eye.className = "assistant-proposal-eye";
  eye.textContent = "Пробный прогон · выполняется";
  const pill = statusPillEl("live", "запуск…");
  top.append(eye, pill);
  const title = document.createElement("div");
  title.className = "assistant-proposal-title";
  title.textContent = "прошло 0 с";
  const pbar = document.createElement("div");
  pbar.className = "assistant-pbar";
  const pfill = document.createElement("div");
  pbar.appendChild(pfill);
  const det = document.createElement("details");
  det.className = "assistant-exp";
  const sum = document.createElement("summary");
  sum.textContent = "шаги: запуск…";
  const stepsBody = document.createElement("div");
  stepsBody.className = "assistant-exp-body";
  det.append(sum, stepsBody);
  const foot = document.createElement("div");
  foot.className = "assistant-proposal-foot";
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "assistant-trial-stop";
  stop.textContent = "Прервать";
  stop.title = "Остановить пробный прогон — частичные результаты сохранятся";
  const sub = document.createElement("span");
  sub.className = "assistant-proposal-stats";
  sub.textContent = "частичные результаты сохранятся";
  foot.append(stop, sub);
  card.append(top, title, pbar, det, foot);
  appendMsg(card, key);

  const t0 = Date.now();
  const timer = setInterval(() => {
    title.textContent = "прошло " + fmtDurationRu(Date.now() - t0);
  }, 1000);
  const prog = { card, settled: false, steps: [], total: 0, pill, stop,
                 trial: null };
  prog.stopTimer = () => clearInterval(timer);
  stop.addEventListener("click", () => {
    if (prog.settled || stop.disabled) return;
    stop.disabled = true;
    stop.textContent = "Прерываю…";
    assistantTrialAbort();  // финал придёт SSE: trial с aborted:true
  });
  prog.onProgress = (ev) => {
    prog.total = ev.total || prog.total;
    prog.steps.push(ev);
    setStatusText(pill, "live", `шаг ${ev.step}/${ev.total}`);
    pfill.style.width = `${Math.round(ev.step / ev.total * 100)}%`;
    const parts = prog.steps.map(s => (s.ok ? "✓ " : "✗ ") + s.label);
    const rest = prog.total - prog.steps.length;
    if (rest > 0) parts.push(`☐ ещё ${rest}`);
    sum.textContent = "шаги: " + parts.join(" · ");
    const row = document.createElement("div");
    row.className = "assistant-step" + (ev.ok ? "" : " assistant-step-error");
    const mk = document.createElement("span");
    mk.className = "assistant-step-mk";
    mk.textContent = ev.ok ? "✓" : "✗";
    const text = document.createElement("span");
    if (ev.ok) {
      text.textContent = `Прогон ${ev.label} — ${ev.answered}/${ev.of} ответов · ${fmtDurationRu(ev.ms)}`;
    } else {
      text.appendChild(document.createTextNode(`Прогон ${ev.label} — `));
      appendReasonWithFlinks(text, ev.error || "ошибка шага");
    }
    row.append(mk, text);
    stepsBody.appendChild(row);
  };
  prog.finalize = (status, message, internal) => {
    prog.stopTimer();
    if (prog.settled) return;  // уже терминал «Прервано» (trial aborted раньше)
    prog.settled = true;
    if (internal) { card.remove(); return; }  // предпроверка — шума не было
    if (status === "error") {
      card.classList.add("assistant-proposal-invalid");
      setStatusText(pill, "invalid", "Ошибка");
      title.textContent = message || "Пробный прогон не удался";
      foot.remove();
      pbar.remove();
      return;
    }
    const errs = prog.steps.filter(s => !s.ok).length;
    fillTrialDone(card,
      `пробный прогон · ${prog.steps.length}/${prog.total || prog.steps.length} шагов · ${fmtDurationRu(Date.now() - t0)}`
      + (errs ? ` · с ошибками: ${errs}` : ""));
  };
  prog.settleAborted = (trial) => {
    prog.stopTimer();
    if (prog.settled) return;
    prog.settled = true;
    // СТОП всего ответа гасит поток до trial-события — частичных ответов нет
    prog.trial = trial || { aborted: true, step: prog.steps.length,
                            total: prog.total, questions: [], models: [],
                            rows: [] };
    fillTrialAborted(card, prog.trial, key);
  };
  return prog;
}

// Терминальная строка завершённого прогона (преемник tool-строки
// «✓ Пробный прогон»): пилла «Выполнен» + сводка шагов и длительности.
function fillTrialDone(card, text) {
  for (const ch of [...card.children]) ch.remove();
  card.classList.add("assistant-proposal-terminal");
  const row = document.createElement("div");
  row.className = "assistant-term-row";
  row.setAttribute("tabindex", "0");
  const sum = document.createElement("span");
  sum.className = "assistant-term-sum";
  sum.textContent = text;
  row.append(statusPillEl("done", "Выполнен"), sum);
  card.appendChild(row);
}

// Терминал «Прервано» (макет 4.12): пилла + суть («на шаге k/n · ответы …
// сохранены») + действия: «частичный результат» (раскрывает trial-карточку
// по собранным строкам — без строк действия нет) и «досчитать» (честный
// ПОЛНЫЙ перезапуск сообщением ассистенту — подстановка не возобновляет
// прогон с места обрыва, о чём честно говорит title).
function fillTrialAborted(card, trial, key) {
  for (const ch of [...card.children]) ch.remove();
  card.classList.add("assistant-proposal-terminal");
  const step = trial.step ?? 0;
  const total = trial.total ?? 0;
  const okLabels = (trial.rows || []).filter(r => !r.error)
    .map(r => r.label || r.model);
  const row = document.createElement("div");
  row.className = "assistant-term-row";
  row.setAttribute("tabindex", "0");
  const sum = document.createElement("span");
  sum.className = "assistant-term-sum";
  sum.textContent = `на шаге ${step}/${total || "?"}`
    + (okLabels.length ? ` · ответы ${okLabels.join(", ")} сохранены`
       : " · ответы не собраны");
  const acts = document.createElement("span");
  acts.className = "assistant-term-acts";
  if ((trial.rows || []).length) {
    const partial = document.createElement("button");
    partial.type = "button";
    partial.className = "assistant-link";
    partial.textContent = "частичный результат";
    let partialCard = null;
    partial.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!partialCard) {
        partialCard = trialCardEl(trial, key);
        partialCard._trial = trial;
        partialCard.classList.add("hidden");
        card.after(partialCard);
      }
      const hidden = partialCard.classList.toggle("hidden");
      partial.textContent = hidden ? "частичный результат" : "скрыть результат";
    });
    acts.appendChild(partial);
  }
  const redo = document.createElement("button");
  redo.type = "button";
  redo.className = "assistant-link";
  redo.textContent = "досчитать";
  redo.title = "Полный перезапуск прогона — ассистент прогонит всё заново";
  redo.addEventListener("click", (e) => {
    e.stopPropagation();
    if (streaming) {
      addNote("Дождитесь завершения текущего ответа ассистента", key);
      return;
    }
    redo.disabled = true;
    sendMessage(`Перезапусти последний пробный прогон полностью — я прервал его на шаге ${step} из ${total || "?"}. Частичные ответы уже есть в чате выше, но нужен полный результат.`);
  });
  acts.appendChild(redo);
  row.append(statusPillEl("aborted", "Прервано"), sum, acts);
  card.appendChild(row);
}

function trialTerminalEl(card, trial, statusCls, statusText) {
  // пиллы могло не быть (восстановление из persist: решений на карточке
  // не было) — создаём терминальную
  if (!card._statusEl) card._statusEl = statusPillEl(statusCls, statusText);
  const status = card._statusEl;
  if (!card._termRow) {
    const row = document.createElement("div");
    row.className = "assistant-term-row hidden";
    row.setAttribute("tabindex", "0");
    const sum = document.createElement("span");
    sum.className = "assistant-term-sum";
    sum.textContent = trial.title || "пробный прогон";
    row.appendChild(sum);
    row.title = "Развернуть";
    card.appendChild(row);
    card._termRow = row;
    row.addEventListener("click", () => applyTerm(false));
  }
  const top = card.querySelector(".assistant-proposal-top");
  const applyTerm = (collapsed) => {
    card.classList.toggle("assistant-proposal-terminal", collapsed);
    card._termRow.classList.toggle("hidden", !collapsed);
    for (const ch of [...card.children]) {
      if (ch === card._termRow) continue;
      ch.classList.toggle("hidden", collapsed);
    }
    if (collapsed) card._termRow.insertBefore(status, card._termRow.firstChild);
    else if (top) top.appendChild(status);
    syncPendingEdge(card);
  };
  setStatusText(status, statusCls, statusText);
  applyTerm(true);
}

// Действия на trial-карточке what-if (макет 4.3): «Принять формулировку»
// (solid) + «Отклонить» (ghost); видны, только когда в ленте есть pending-
// карточка правки вопросов — «Принять» принимает её (программный клик по
// «Принять» старейшей pending propose_questions), «Отклонить» сворачивает
// карточку в терминал «Отклонено · гипотеза» БЕЗ применения (карточка
// правки при этом остаётся pending — решение о ней отдельное).
// Деструктивную карточку так не принимаем — её гейт «Развернуть и проверить».
function trialAcceptActionEl(key, card, trial) {
  const oldestPendingQuestions = () => {
    const it = pendingProposalItems(key)
      .find(x => x.proposal.kind === "propose_questions");
    const target = it && proposalCardByItem.get(it);
    return target && !target._destructive ? target : null;
  };
  if (!oldestPendingQuestions()) return null;
  const row = document.createElement("div");
  row.className = "assistant-trial-actions";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "assistant-accept";
  btn.textContent = "Принять формулировку";
  btn.title = "Принять предложенную правку вопросов (карточка выше в ленте)";
  btn.addEventListener("click", () => {
    const target = oldestPendingQuestions();
    const accept = target && target.querySelector(".assistant-accept");
    if (!accept || accept.disabled) { row.remove(); return; }
    accept.click();
    trialTerminalEl(card, trial, "applied", "Применено");
    if (card._feedItem) { card._feedItem.trialStatus = "applied"; persistChat(); }
  });
  const dec = document.createElement("button");
  dec.type = "button";
  dec.className = "assistant-decline";
  dec.textContent = "Отклонить";
  dec.title = "Не применять правку по этому прогону — карточка свернётся, "
    + "предложение правки останется в ленте";
  dec.addEventListener("click", () => {
    trialTerminalEl(card, trial, "declined", "Отклонено");
    if (card._feedItem) { card._feedItem.trialStatus = "declined"; persistChat(); }
  });
  row.append(btn, dec);
  return row;
}

// Карточка «Пробный прогон» (событие trial от run_trial): саммари — гипотеза
// (title), что изменено (changes), исходы по моделям; полная таблица
// модель × вопрос — за «Подробнее ▸» с кнопкой ⛶ (на весь экран). Для
// совпадающих пар вопрос×модель из прогона пользователя — маркеры отличий
// (↑/↓ уверенность, ≠ ответ изменился) и подсветка ячеек.
// Только показ — состояние приложения не меняется.
function trialCardEl(trial, key = activeConvo) {
  const qs = trial.questions || [];
  let decision = trialDecisionEngine(trial);
  let decisionInvalid = null;
  if (decision && decision.invalid) {
    decisionInvalid = decision.invalid;
    decision = null;
  }
  const userRun = userRunAnswersByText();
  const card = document.createElement("div");
  card.className = "assistant-proposal assistant-trial";
  // действия what-if (макет 4.3) — считаем заранее: пилла «Ждёт решения» и
  // янтарная кромка в top-ряду имеют смысл, только когда есть что решать
  const acceptRow = trialAcceptActionEl(key, card, trial);
  // верхний ряд как у proposal-карточек: eyebrow с параметрами прогона
  // (файлы/длительности в событии trial нет — модели × вопросы [× файл])
  const top = document.createElement("div");
  top.className = "assistant-proposal-top";
  const eye = document.createElement("span");
  eye.className = "assistant-proposal-eye";
  const mCount = (trial.models || []).length;
  eye.textContent = "Пробный прогон"
    + (mCount ? ` · ${mCount} ${plural(mCount, "модель", "модели", "моделей")}` : "")
    + (qs.length ? ` × ${qs.length} ${plural(qs.length, "вопрос", "вопроса", "вопросов")}` : "")
    + (trial.batchFile ? ` · ${trial.batchFile}` : "");
  top.appendChild(eye);
  if (acceptRow) {
    const status = statusPillEl("pending", "Ждёт решения");
    top.appendChild(status);
    card._statusEl = status;
  }
  card.appendChild(top);
  const title = document.createElement("div");
  title.className = "assistant-proposal-title";
  title.textContent = "Пробный прогон" + (trial.title ? `: ${trial.title}` : "");
  card.appendChild(title);
  if (trial.changes) {
    const ch = document.createElement("div");
    ch.className = "assistant-trial-changes";
    ch.textContent = "Изменения: " + trial.changes;
    card.appendChild(ch);
  }
  // Сводка исходов по моделям (правила переданы) — видна без раскрытия таблицы.
  if (decisionInvalid) {
    const warn = document.createElement("div");
    warn.className = "assistant-trial-invalid";
    warn.textContent = "⚠ Правила решения не применимы: " + decisionInvalid;
    card.appendChild(warn);
  }
  if (decision) {
    const outcomesRow = document.createElement("div");
    outcomesRow.className = "assistant-trial-outcomes";
    for (const row of trial.rows || []) {
      if (row.error) continue;
      const item = document.createElement("span");
      item.className = "assistant-trial-outcome";
      item.appendChild(document.createTextNode((row.label || row.model) + ": "));
      const full = row.fullAnswers || {};
      item.appendChild(decisionBadgeEl(Object.keys(full).length
        ? evaluateDecision(decision, full) : null));
      outcomesRow.appendChild(item);
    }
    card.appendChild(outcomesRow);
  }

  // Полная таблица — за дрилдауном; ⛶ раскрывает карточку на весь экран.
  const det = document.createElement("details");
  det.className = "assistant-trial-details assistant-exp";
  const sum = document.createElement("summary");
  sum.textContent = "Подробнее — таблица по вопросам";
  det.appendChild(sum);
  const fsBtn = document.createElement("button");
  fsBtn.type = "button";
  fsBtn.className = "icon-btn assistant-trial-fs";
  fsBtn.textContent = "⛶";
  fsBtn.title = "Таблицу на весь экран (повторный клик — вернуть)";
  fsBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const on = !card.classList.contains("trial-fullscreen");
    card.classList.toggle("trial-fullscreen", on);
    if (on) det.open = true;
    fsBtn.textContent = on ? "✕" : "⛶";
  });
  sum.appendChild(fsBtn);
  const table = document.createElement("table");
  table.className = "assistant-trial-table";
  const headRow = document.createElement("tr");
  const modelTh = document.createElement("th");
  modelTh.textContent = "модель";
  headRow.appendChild(modelTh);
  for (const q of qs) {
    const th = document.createElement("th");
    th.textContent = truncate(q.question || q.id, 40);
    th.title = q.question || q.id;
    headRow.appendChild(th);
  }
  if (decision) {
    const th = document.createElement("th");
    th.textContent = "Решение";
    headRow.appendChild(th);
  }
  table.appendChild(headRow);
  const diffs = [];
  let marked = false;
  for (const row of trial.rows || []) {
    const tr = document.createElement("tr");
    const tdModel = document.createElement("td");
    tdModel.textContent = row.label || row.model;
    tr.appendChild(tdModel);
    if (row.error) {
      const td = document.createElement("td");
      td.className = "assistant-trial-error";
      td.colSpan = Math.max(qs.length, 1) + (decision ? 1 : 0);
      td.textContent = "⚠ " + row.error;
      tr.appendChild(td);
    } else {
      for (const q of qs) {
        const td = document.createElement("td");
        let text = (row.answers || {})[q.id] || "—";
        const full = (row.fullAnswers || {})[q.id];
        const prev = userRun && userRun[row.model]
          && userRun[row.model][q.question];
        if (full && prev) {
          const prevShort = shortAnswer(prev);
          const curShort = shortAnswer(full);
          if (prevShort !== curShort) {
            text += " ≠";
            marked = true;
            td.classList.add("assistant-trial-diff");
            diffs.push(`${row.label || row.model} × «${truncate(q.question || q.id, 30)}»: ${prevShort} → ${curShort}`);
          } else {
            const dc = answerConfidence(full) - answerConfidence(prev);
            if (Math.abs(dc) >= 0.05) {
              text += dc > 0 ? " ↑" : " ↓";
              marked = true;
              td.classList.add("assistant-trial-diff");
            }
          }
        }
        td.textContent = text;
        tr.appendChild(td);
      }
      if (decision) {
        const td = document.createElement("td");
        const full = row.fullAnswers || {};
        td.appendChild(decisionBadgeEl(Object.keys(full).length
          ? evaluateDecision(decision, full) : null));
        tr.appendChild(td);
      }
    }
    table.appendChild(tr);
  }
  det.appendChild(table);
  if (marked) {
    const legend = document.createElement("div");
    legend.className = "assistant-trial-legend";
    legend.textContent = "Отличия от вашего прогона (↑/↓ — уверенность, ≠ — ответ изменился)"
      + (diffs.length ? ":\n" + diffs.slice(0, 3).join("\n")
        + (diffs.length > 3 ? `\n… и ещё ${diffs.length - 3}` : "") : ".");
    det.appendChild(legend);
  }
  card.appendChild(det);
  // макет 7 (v1.1): дельта на размеченных исходах + «Принять формулировку»
  // (при висящей pending-карточке правки вопросов) — после таблицы, перед note
  if (decision) {
    const d = trialDeltaEl(trial, decision);
    if (d) card.appendChild(d);
  }
  if (acceptRow) card.appendChild(acceptRow);
  if (acceptRow) syncPendingEdge(card); // янтарная кромка развёрнутой pending
  if (trial.note) {
    const note = document.createElement("div");
    note.className = "assistant-proposal-preview";
    note.textContent = trial.note;
    card.appendChild(note);
  }
  return card;
}

// Антиспам (v0.7): серия пробных прогонов подряд — предыдущие карточки
// схлопываются в строку-заголовок (разворот по клику), лента не захламляется.
function collapseTrialCard(card) {
  const title = card.querySelector(".assistant-proposal-title");
  if (!title || card.dataset.collapsible) return;
  // терминальную what-if (решение по правке принято/отклонено) серийное
  // схлопывание не трогает — она уже строкой
  if (card.classList.contains("assistant-proposal-terminal")) return;
  card.dataset.collapsible = "1";
  const body = [...card.children].filter(c => c !== title);
  // сводка в схлопнутом заголовке (v1.1): «… · 2 мод. × 5 вопр.»
  const fullTitle = title.textContent;
  const m = (card._trial && card._trial.models || []).length;
  const q = (card._trial && card._trial.questions || []).length;
  const brief = m || q ? `${fullTitle} · ${m} мод. × ${q} вопр.` : fullTitle;
  const apply = (collapsed) => {
    for (const c of body) c.classList.toggle("hidden", collapsed);
    title.textContent = collapsed ? brief : fullTitle;
    title.classList.toggle("assistant-expander", collapsed);
    // янтарная кромка — только у развёрнутой pending (концепция «Рамс»)
    if (collapsed) card.classList.remove("assistant-proposal-pending-open");
    else syncPendingEdge(card);
  };
  title.addEventListener("click", () => {
    apply(!title.classList.contains("assistant-expander"));
  });
  title.title = "Развернуть";
  apply(true);
}

export function handleTrial(trial, key = activeConvo) {
  if (!trial) return null;
  if (trial.aborted) {
    // прерванный прогон (макет 4.12): живая карточка превращается в терминал
    // на месте; без неё (страховка) — отдельной строкой
    const open = [...convos[key].openTools].reverse()
      .find(t => t.progress && !t.progress.settled);
    let card;
    if (open) {
      open.progress.settleAborted(trial);
      card = open.progress.card;
    } else {
      card = document.createElement("div");
      card.className = "assistant-proposal assistant-trial-progress";
      fillTrialAborted(card, trial, key);
      appendMsg(card, key);
    }
    card._trial = trial;
    card._feedItem = { t: "trial", trial, trialStatus: "aborted" };
    pushFeed(key, card._feedItem);
    return card;
  }
  const card = trialCardEl(trial, key);
  card._trial = trial;
  card._feedItem = { t: "trial", trial };
  pushFeed(key, card._feedItem);
  appendMsg(card, key);
  // серия trial-карточек подряд (между ними нет текста/сообщений) — предыдущую
  // схлопываем: актуальной обычно является последняя
  const feed = card.parentNode;
  if (feed) {
    const kids = [...feed.children].filter(n => !n.classList?.contains("assistant-intro"));
    const idx = kids.indexOf(card);
    const prev = kids[idx - 1];
    if (prev && prev.classList && prev.classList.contains("assistant-trial")) {
      collapseTrialCard(prev);
      if (prev._feedItem) { prev._feedItem.collapsed = true; persistChat(); }
    }
  }
  return card;
}

// ---------------------------------------------------------------- карточки анализа (v1.1)

// Действия карточек разбора/очереди — через публичные функции этого модуля;
// analysis.js их не импортирует (иначе цикл модулей).
const infoCardDeps = { sendMessage, openPanel };

// Антиспам (как у trial): серия одинаковых информационных карточек подряд —
// предыдущая схлопывается в заголовок (разворот по клику).
function collapseInfoCard(card, brief) {
  const title = card.querySelector(".assistant-info-title");
  if (!title || card.dataset.collapsible) return;
  card.dataset.collapsible = "1";
  const body = [...card.children].filter(c => c !== title);
  const fullTitle = title.textContent;
  const apply = (collapsed) => {
    for (const c of body) c.classList.toggle("hidden", collapsed);
    title.textContent = collapsed ? brief : fullTitle;
    title.classList.toggle("assistant-expander", collapsed);
  };
  title.addEventListener("click", () => {
    apply(!title.classList.contains("assistant-expander"));
  });
  title.title = "Развернуть";
  apply(true);
}

// Серийное схлопывание: если предыдущий узел ленты — карточка того же типа,
// она схлопывается (актуальная — последняя).
function collapsePrevInfoCard(card, cls, brief) {
  const feed = card.parentNode;
  if (!feed) return;
  const kids = [...feed.children].filter(n => !n.classList?.contains("assistant-intro"));
  const prev = kids[kids.indexOf(card) - 1];
  if (prev && prev.classList && prev.classList.contains(cls)) {
    collapseInfoCard(prev, brief);
    if (prev._feedItem) { prev._feedItem.collapsed = true; persistChat(); }
  }
}

export function handleAnalysis(data, key = activeConvo) {
  if (!data) return null;
  const card = analysisCardEl(data, infoCardDeps);
  card._feedItem = { t: "analysis", analysis: data };
  pushFeed(key, card._feedItem);
  appendMsg(card, key);
  collapsePrevInfoCard(card, "assistant-analysis", analysisBrief(data));
  return card;
}

export function handleQueue(data, key = activeConvo) {
  if (!data) return null;
  const card = queueCardEl(data, infoCardDeps);
  card._feedItem = { t: "queue", queue: data };
  pushFeed(key, card._feedItem);
  appendMsg(card, key);
  collapsePrevInfoCard(card, "assistant-queue", queueBrief(data));
  return card;
}

// ---------------------------------------------------------------- proposal-карточки

// details ▸/▾ с DOM-телом (единый disclosure-паттерн, макет option-c).
function detailsDomEl(summaryText, nodes) {
  const det = document.createElement("details");
  det.className = "assistant-exp";
  const sum = document.createElement("summary");
  sum.textContent = summaryText;
  det.appendChild(sum);
  const body = document.createElement("div");
  body.className = "assistant-exp-body";
  for (const n of nodes) body.appendChild(n);
  det.appendChild(body);
  return det;
}

// Тихая строка-легенда чтения diff'а внутри карточки (без рамки).
function diffLegendEl() {
  const div = document.createElement("div");
  div.className = "diff-legend";
  div.textContent = "Как читать: красное зачёркнутое — уйдёт, зелёное — "
    + "появится; короткие правки — прямо в строке, длинные формулировки — "
    + "двумя строками «было/станет», списки — маркерами ~ + −.";
  return div;
}

// lines: [{cls?: "diff-add"|"diff-del"|"diff-chg", text}] — плоские строки
// превью (контекст, пресет, правила; полные формулировки видны сразу —
// hover-подсказок со «вторым текстом» в системе больше нет, макет option-c).
function addPreviewLines(box, lines) {
  for (const l of lines) {
    const div = document.createElement("div");
    if (l.cls) div.className = l.cls;
    div.textContent = l.text;
    box.appendChild(div);
  }
}

function fmtQuestionBrief(q) {
  return `[${TYPE_LABELS[q.type] || q.type}] ${q.question || "(без текста)"}`;
}

// ---------------------------------------------------------------- diff-фактология вопросов (v1.2, V-2)
// Фактология по backend/schemas.py: у да/нет — текст, формулировки ответов
// «да»/«нет» и направление; у выбора — опции {имя, описание}; у шкалы —
// уровни с описаниями и направление. Понятия «вес» в системе НЕТ — в карточках
// оно не отображается. Визуальный язык (макет option-c): короткая правка —
// пословный inline (красный зачёркнутый / зелёный полужирный, без плашек),
// длинная формулировка — двумя строками БЫЛО/СТАНЕТ, списки — маркерами ~ + −,
// неизменное приглушено.

const DIRECTION_BRIEF = {
  yes: "лучше: да", no: "лучше: нет",
  up: "выше лучше", down: "ниже лучше", neutral: "нейтрально",
};

function directionBrief(value) {
  return DIRECTION_BRIEF[value] || DIRECTION_BRIEF.neutral;
}

// Пословный inline-diff: LCS по непробельным токенам. Короткие формулировки —
// его область; длинные уходят в БЫЛО/СТАНЕТ (см. textChangeInto).
// newOnly — только сторона «станет» (колонка rt-new таблицы условий, макет
// 2.1): общие слова обычным текстом, добавленные — w-add; удалённые слова не
// выводятся — они уже видны зачёркнутыми в колонке «было».
// delCls — класс зачёркнутых слов стороны «было»: «bd» в построчном diff'е
// контекста (макет 3.1, приглушённое зачёркивание), иначе «w-del».
function wordDiffInto(el, a, b, newOnly = false, delCls = "w-del") {
  const ta = String(a ?? "").split(/\s+/).filter(Boolean);
  const tb = String(b ?? "").split(/\s+/).filter(Boolean);
  const m = ta.length, k = tb.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(k + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = k - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0, j = 0, first = true;
  const push = (text, cls) => {
    if (!first) el.appendChild(document.createTextNode(" "));
    first = false;
    if (!cls) { el.appendChild(document.createTextNode(text)); return; }
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    el.appendChild(s);
  };
  while (i < m && j < k) {
    if (ta[i] === tb[j]) { push(ta[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { if (!newOnly) push(ta[i], delCls); i++; }
    else { push(tb[j], "w-add"); j++; }
  }
  while (i < m) { if (!newOnly) push(ta[i], delCls); i++; }
  while (j < k) { push(tb[j++], "w-add"); }
}

const WORD_DIFF_MAX = 90;  // суммарная длина строк для пословного inline

// Значение целиком: «было → станет» (маркерные строки списков, ответы да/нет,
// направление) — в отличие от пословного inline для свободного текста.
function arrowDiff(bd, a, b) {
  const d = document.createElement("span");
  d.className = "w-del";
  d.textContent = String(a ?? "—");
  const w = document.createElement("span");
  w.className = "w-add";
  w.textContent = String(b ?? "—");
  bd.append(d, document.createTextNode(" → "), w);
}

// Изменение текста: короткое — пословно в одну строку, длинное — БЫЛО/СТАНЕТ.
function textChangeInto(box, a, b) {
  const A = String(a ?? "—"), B = String(b ?? "—");
  if (A.length + B.length <= WORD_DIFF_MAX) {
    const row = document.createElement("div");
    row.className = "df-row";
    const lab = document.createElement("span");
    lab.className = "df-lab";
    const text = document.createElement("span");
    text.className = "df-text";
    wordDiffInto(text, A, B);
    row.append(lab, text);
    box.appendChild(row);
    return;
  }
  for (const [cls, labText, value] of [["was", "было", A], ["will", "станет", B]]) {
    const row = document.createElement("div");
    row.className = "df-row";
    const lab = document.createElement("span");
    lab.className = "df-lab " + cls;
    lab.textContent = labText;
    const text = document.createElement("span");
    text.className = "df-text";
    text.textContent = value;
    row.append(lab, text);
    box.appendChild(row);
  }
}

// Строка спискового diff'а с маркером ~ + − (cls — diff-add/del/chg/same).
function markerRow(cls, mk, bodyFn) {
  const row = document.createElement("div");
  row.className = "dl" + (cls ? " " + cls : "");
  const m = document.createElement("span");
  m.className = "mk";
  m.textContent = mk;
  row.appendChild(m);
  const bd = document.createElement("span");
  if (cls === "diff-del") bd.className = "bd";
  bodyFn(bd);
  row.appendChild(bd);
  return row;
}

function lvNum(n) {
  const s = document.createElement("span");
  s.className = "lv-n";
  s.textContent = String(n);
  return s;
}

function optOf(o) {
  return typeof o === "string" ? { name: o, description: "" } : o;
}

// Изменились ли опции: состав/порядок имён — всегда; описание — только когда
// предложение его несёт (в tool-схеме ассистента options — массив строк,
// поэтому отсутствие описания в предложении ≠ удаление описания).
function optionsChanged(oldOpts, newOpts) {
  if (newOpts == null) return false;
  const A = (oldOpts || []).map(optOf), B = (newOpts || []).map(optOf);
  if (A.length !== B.length) return true;
  if (A.map(o => o.name).join("\n") !== B.map(o => o.name).join("\n")) return true;
  return B.some(b => b.description
    && String(((A.find(a => a.name === b.name)) || {}).description || "")
       !== String(b.description));
}

// Опции вопроса-выбора: переименование и описание — маркером ~, добавление +,
// удаление −, неизменные — приглушённым счётчиком. Равная длина списков —
// сравнение позиционное (rename читается как «было → станет»), иначе — по
// именам (множества).
function optionsDiffInto(box, oldOpts, newOpts) {
  const A = (oldOpts || []).map(optOf), B = (newOpts || []).map(optOf);
  let same = 0;
  const descDiffers = (a, b) => !!b.description
    && String(a.description || "") !== String(b.description);
  const changedRow = (a, b, n) => {
    if (a.name !== b.name) {
      box.appendChild(markerRow("diff-chg", "~", (bd) => {
        bd.appendChild(lvNum(n));
        bd.appendChild(document.createTextNode(" "));
        arrowDiff(bd, a.name, b.name);
      }));
    }
    if (descDiffers(a, b)) {
      box.appendChild(markerRow("diff-chg", "~", (bd) => {
        bd.appendChild(lvNum(n));
        bd.appendChild(document.createTextNode(" "));
        const dim = document.createElement("span");
        dim.className = "dim";
        dim.textContent = "описание: ";
        bd.appendChild(dim);
        arrowDiff(bd, `«${a.description || "—"}»`, `«${b.description || "—"}»`);
      }));
    }
  };
  if (A.length === B.length) {
    B.forEach((b, j) => {
      const a = A[j];
      if (a.name === b.name && !descDiffers(a, b)) {
        same += 1;
      } else {
        changedRow(a, b, j + 1);
      }
    });
  } else {
    const namesA = new Set(A.map(o => o.name));
    const namesB = new Set(B.map(o => o.name));
    B.forEach((b, j) => {
      if (!namesA.has(b.name)) {
        box.appendChild(markerRow("diff-add", "+", (bd) => {
          bd.appendChild(lvNum(j + 1));
          bd.appendChild(document.createTextNode(" " + b.name));
          if (b.description) {
            const dim = document.createElement("span");
            dim.className = "dim";
            dim.textContent = ` — «${b.description}»`;
            bd.appendChild(dim);
          }
        }));
      } else {
        const a = A.find(x => x.name === b.name);
        if (descDiffers(a, b)) {
          changedRow(a, b, j + 1);
        } else {
          same += 1;
        }
      }
    });
    A.forEach((a, i) => {
      if (!namesB.has(a.name)) {
        box.appendChild(markerRow("diff-del", "−", (bd) => {
          bd.appendChild(lvNum(i + 1));
          bd.appendChild(document.createTextNode(" " + a.name));
        }));
      }
    });
  }
  if (same) {
    box.appendChild(markerRow("diff-same", "", (bd) => {
      bd.textContent = `без изменений: ${same} ${plural(same, "опция", "опции", "опций")}`;
    }));
  }
}

// Уровни шкалы — позиционно (уровень = описание значения на месте i).
function levelsDiffInto(box, oldLv, newLv) {
  const A = oldLv || [], B = newLv || [];
  let same = 0;
  B.forEach((b, j) => {
    const a = A[j];
    if (a === undefined) {
      box.appendChild(markerRow("diff-add", "+", (bd) => {
        bd.appendChild(lvNum(j + 1));
        bd.appendChild(document.createTextNode(" «" + b + "»"));
      }));
    } else if (a === b) {
      same += 1;
    } else {
      box.appendChild(markerRow("diff-chg", "~", (bd) => {
        bd.appendChild(lvNum(j + 1));
        bd.appendChild(document.createTextNode(" "));
        arrowDiff(bd, `«${a}»`, `«${b}»`);
      }));
    }
  });
  for (let i = B.length; i < A.length; i++) {
    box.appendChild(markerRow("diff-del", "−", (bd) => {
      bd.appendChild(lvNum(i + 1));
      bd.appendChild(document.createTextNode(" «" + A[i] + "»"));
    }));
  }
  if (same) {
    box.appendChild(markerRow("diff-same", "", (bd) => {
      bd.textContent = `без изменений: ${same} ${plural(same, "уровень", "уровня", "уровней")}`;
    }));
  }
}

// Смена направления — всегда с пометкой «смысл меняется» (спека §12).
function directionDiffInto(box, type, a, b) {
  box.appendChild(markerRow("diff-chg", "~", (bd) => {
    bd.appendChild(document.createTextNode("направление: "));
    const del = document.createElement("span");
    del.className = "w-del";
    del.textContent = directionBrief(a);
    const arrow = document.createTextNode(" → ");
    const add = document.createElement("span");
    add.className = "w-add";
    add.textContent = directionBrief(b);
    const dim = document.createElement("span");
    dim.className = "dim";
    dim.textContent = type === "score" ? " — смысл шкалы меняется" : " — смысл ответа меняется";
    bd.append(del, arrow, add, dim);
  }));
}

// Блок изменённого вопроса (макет 1.1): заголовок № + тип + аспекты, тело —
// все реальные параметры типа. oldQ — из state (редактор), newQ — из payload
// (сырой, convertProposalQuestion внутри). ref — «№N» для отображения.
function questionDiffEl(oldQ, newQ, ref) {
  const q = convertProposalQuestion(newQ);
  const type = q.type || (oldQ && oldQ.type) || "yes_no";
  const block = document.createElement("div");
  block.className = "qb";
  const optsEq = () => !optionsChanged((oldQ || {}).options, q.options);
  const aspects = [];
  if (q.question != null && String(((oldQ || {}).question) ?? "") !== String(q.question)) {
    aspects.push("текст");
  }
  if (q.type && oldQ && q.type !== oldQ.type) aspects.push("тип");
  if (q.yes != null && String(((oldQ || {}).yes) ?? "") !== String(q.yes)) aspects.push("«да»");
  if (q.no != null && String(((oldQ || {}).no) ?? "") !== String(q.no)) aspects.push("«нет»");
  if (q.options != null && !optsEq()) aspects.push("опции");
  if (q.levels != null
      && JSON.stringify((oldQ || {}).levels || []) !== JSON.stringify(q.levels)) {
    aspects.push("уровни");
  }
  if (q.direction != null && (((oldQ || {}).direction) || "neutral") !== q.direction) {
    aspects.push("направление");
  }
  const head = document.createElement("div");
  head.className = "q-head";
  const badge = document.createElement("span");
  badge.className = "q-badge";
  badge.textContent = ref || "№?";
  const typeEl = document.createElement("span");
  typeEl.className = "q-type";
  typeEl.textContent = TYPE_LABELS[type] || type;
  const op = document.createElement("span");
  op.className = "q-op q-op-chg";
  op.textContent = "изменён" + (aspects.length ? " · " + aspects.join(", ") : "");
  head.append(badge, typeEl, op);
  block.appendChild(head);

  const old = oldQ || {};
  if (q.question != null && String(old.question ?? "") !== String(q.question)) {
    textChangeInto(block, old.question, q.question);
  } else if (old.question) {
    const sect = document.createElement("div");
    sect.className = "df-sect";
    sect.textContent = `Текст без изменений · «${truncate(old.question, 60)}»`;
    block.appendChild(sect);
  }
  if (q.type && old.type && q.type !== old.type) {
    block.appendChild(markerRow("diff-chg", "~", (bd) => {
      bd.textContent = `тип: ${TYPE_LABELS[old.type] || old.type} → ${TYPE_LABELS[q.type]}`;
    }));
  }
  if (type === "yes_no") {
    for (const [field, tag] of [["yes", "«да»"], ["no", "«нет»"]]) {
      if (q[field] != null && String(old[field] ?? "") !== String(q[field])) {
        const row = document.createElement("div");
        row.className = "yr";
        const t = document.createElement("span");
        t.className = "yr-tag";
        t.textContent = tag;
        const v = document.createElement("span");
        arrowDiff(v, old[field] ?? "—", q[field]);
        row.append(t, v);
        block.appendChild(row);
      }
    }
  }
  if (q.options != null && !optsEq()) optionsDiffInto(block, old.options, q.options);
  if (q.levels != null
      && JSON.stringify(old.levels || []) !== JSON.stringify(q.levels)) {
    levelsDiffInto(block, old.levels, q.levels);
  }
  if (q.direction != null && (old.direction || "neutral") !== q.direction
      && (type === "yes_no" || type === "score")) {
    directionDiffInto(block, type, old.direction || "neutral", q.direction);
  }
  return block;
}

// Блок нового вопроса: текст + тихая мета с параметрами типа (макет 1.1, №5).
function questionAddEl(newQ, ref, whereNote) {
  const q = convertProposalQuestion(newQ);
  const block = document.createElement("div");
  block.className = "qb";
  const head = document.createElement("div");
  head.className = "q-head";
  const badge = document.createElement("span");
  badge.className = "q-badge";
  badge.textContent = ref || "новый";
  const typeEl = document.createElement("span");
  typeEl.className = "q-type";
  typeEl.textContent = TYPE_LABELS[q.type] || q.type;
  const op = document.createElement("span");
  op.className = "q-op q-op-add";
  op.textContent = "новый";
  head.append(badge, typeEl, op);
  block.appendChild(head);
  const row = document.createElement("div");
  row.className = "df-row diff-add";
  const lab = document.createElement("span");
  lab.className = "df-lab";
  const text = document.createElement("span");
  text.className = "df-text";
  text.textContent = `«${q.question || "(без текста)"}»`;
  row.append(lab, text);
  block.appendChild(row);
  const meta = [];
  if (q.type === "yes_no") {
    meta.push(`ответы: ${q.yes || "да"} / ${q.no || "нет"}`,
              `направление: ${directionBrief(q.direction)}`);
  } else if (q.type === "choice" && (q.options || []).length) {
    meta.push("опции: " + q.options.map(o => optOf(o).name).join(", "));
  } else if (q.type === "score" && (q.levels || []).length) {
    meta.push(`уровни 1–${q.levels.length}`,
              `направление: ${directionBrief(q.direction)}`);
  }
  if (whereNote) meta.push(whereNote);
  if (meta.length) {
    const dim = document.createElement("span");
    dim.className = "dim";
    dim.textContent = " — " + meta.join(" · ");
    text.appendChild(dim);
  }
  return block;
}

// Строка удалённого вопроса: «− №N [Тип] «текст»» зачёркнутым; marked > 0 —
// пометка цены «· размечено N ячеек» (макет 1.2/1.4).
function questionDelRow(oldQ, ref, marked = 0) {
  return markerRow("diff-del", "−", (bd) => {
    const type = (oldQ && oldQ.type) || "?";
    bd.textContent = `${ref} [${TYPE_LABELS[type] || type}] «${(oldQ && oldQ.question) || "—"}»`;
    if (marked > 0) {
      bd.appendChild(document.createTextNode(
        ` · размечено ${marked} ${plural(marked, "ячейка", "ячейки", "ячеек")}`));
    }
  });
}

// Единая нормализация текста вопроса — для превью-diff и дубль-проверки
// (иначе «Есть товар?» и «Есть товар» — дубль для превью, но не для проверки)
function normQuestionText(q) {
  return String(q.question || "").trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

// Красная пометка удалений в stats-строке карточки вопросов (макет 1.2/1.4):
// «⚠ удаляется №2 из 5» (единичное — с ref) / «⚠ удаляется 7 из 9».
function delStatsSpan(subj) {
  const s = document.createElement("span");
  s.className = "s-del";
  s.textContent = `⚠ удаляется ${subj} из ${state.questions.length}`;
  return s;
}

// Метки разметки, ссылающиеся на вопрос (по id): ячейки прогонов (вопрос ×
// модель/файл) и пометки вопроса целиком, одиночный и пакетный режимы.
// Считаем только вердиктные пометки (✓/✗/?) — комментарии без вердикта ценой
// удаления не являются. → { total, accept, reject, unsure }.
function questionMarkStats(qid) {
  const st = { total: 0, accept: 0, reject: 0, unsure: 0 };
  if (qid == null) return st;
  const scan = (marks) => {
    for (const m of marks || []) {
      const t = m.target || {};
      if (t.question !== qid || !m.verdict) continue;
      st.total += 1;
      if (st[m.verdict] != null) st[m.verdict] += 1;
    }
  };
  scan(state.results && state.results.marks);
  scan(state.batch.marks);
  return st;
}

// Удаляемые предложением вопросы: [{id, q, ref}] — q из state (может быть
// null при remove по неизвестному id), ref — «№N» по текущей позиции.
// edits-путь — remove-операции по id (контракт A3); replace — текущие
// вопросы, отсутствующие в предложенном наборе (по нормализованному тексту,
// как в destructiveQuestionsInfo до v1.3).
function deletedQuestionsOf(p) {
  const out = [];
  if (Array.isArray(p.edits) && p.edits.length) {
    for (const e of p.edits) {
      if (e.op !== "remove") continue;
      const i = state.questions.findIndex(q => q.id === e.target);
      out.push({ id: e.target, q: i >= 0 ? state.questions[i] : null,
                 ref: i >= 0 ? `№${i + 1}` : `«${e.target}»` });
    }
    return out;
  }
  if (p.mode === "append") return out;
  const inc = new Set((p.questions || [])
    .map(q => normQuestionText(convertProposalQuestion(q))));
  state.questions.forEach((q, i) => {
    if (!inc.has(normQuestionText(q))) out.push({ id: q.id, q, ref: `№${i + 1}` });
  });
  return out;
}

// Условия действующих правил, ссылающиеся на удаляемые вопросы (по id):
// → [{ label, refs: [«№N»…] }] — исход останется без опоры (макет 1.4).
function decisionOrphans(deletedIds) {
  const ids = new Set(deletedIds.filter(id => id != null));
  if (!ids.size) return [];
  const outcomes = (state.decision && state.decision.outcomes) || [];
  const hits = [];
  for (const o of outcomes) {
    const refs = [];
    for (const r of o.rules || []) {
      for (const c of r.conditions || []) {
        if (!ids.has(c.question)) continue;
        const i = state.questions.findIndex(q => q.id === c.question);
        const ref = i >= 0 ? `№${i + 1}` : `«${c.question}»`;
        if (!refs.includes(ref)) refs.push(ref);
      }
    }
    if (refs.length) hits.push({ label: o.label, refs });
  }
  return hits;
}

// Превью точечных правок (payload.edits из разворота на бэке): операции
// адресуют вопросы по id (контракт A3); № — только для отображения (id →
// текущая позиция). update — полный diff по типу вопроса (questionDiffEl).
function questionEditsPreviewEl(box, p) {
  const byId = id => {
    const i = state.questions.findIndex(q => q.id === id);
    return i >= 0 ? { q: state.questions[i], n: i + 1 } : { q: null, n: null };
  };
  const refOf = id => {
    const { n } = byId(id);
    return n != null ? `№${n}` : `«${id}»`;
  };
  const head = document.createElement("div");
  head.className = "assistant-proposal-stats";
  head.textContent = `Точечные правки вопросов (операций: ${p.edits.length})`;
  // красная пометка удалений в stats (макет 1.2/1.4) — на edits-пути та же,
  // что на replace (там — в questionsPreviewEl)
  const rems = p.edits.filter(e => e.op === "remove");
  if (rems.length) {
    head.appendChild(document.createTextNode(" · "));
    head.appendChild(delStatsSpan(
      rems.length === 1 ? refOf(rems[0].target) : String(rems.length)));
  }
  box.appendChild(head);
  // легенда чтения diff'а — на edits-пути та же, что на replace (макет 1.1)
  box.appendChild(diffLegendEl());
  for (const e of p.edits) {
    const { q: old } = byId(e.target);
    if (e.op === "update") {
      if (old) box.appendChild(questionDiffEl(old, e.question, refOf(e.target)));
      else box.appendChild(questionAddEl(e.question, refOf(e.target)));
      continue;
    }
    if (e.op === "remove") {
      box.appendChild(questionDelRow(old, refOf(e.target),
        questionMarkStats(e.target).total));
      continue;
    }
    if (e.op === "split") {
      const into = (e.into || []).filter(q => q.question);
      const block = document.createElement("div");
      block.className = "qb";
      const head2 = document.createElement("div");
      head2.className = "q-head";
      const badge = document.createElement("span");
      badge.className = "q-badge";
      badge.textContent = refOf(e.target);
      const op = document.createElement("span");
      op.className = "q-op q-op-chg";
      op.textContent = `разбит → ${into.length} ${plural(into.length, "вопрос", "вопроса", "вопросов")}`;
      head2.append(badge, op);
      block.appendChild(head2);
      for (const q of into) {
        block.appendChild(markerRow("diff-add", "+", (bd) => {
          bd.textContent = q.question;
        }));
      }
      box.appendChild(block);
      continue;
    }
    // add
    const where = e.after != null ? `после ${refOf(e.after)}` : "в конец";
    box.appendChild(questionAddEl(e.question, null, where));
  }
}

// Есть ли реальные изменения полей между текущим вопросом и предложенным
// (replace-путь): поля, отсутствующие в предложении, считаем нетронутыми.
function questionChanged(oldQ, newQ) {
  const q = convertProposalQuestion(newQ);
  const o = oldQ || {};
  if (q.question != null && String(o.question ?? "") !== String(q.question)) return true;
  if (q.type && o.type && q.type !== o.type) return true;
  if (q.yes != null && String(o.yes ?? "") !== String(q.yes)) return true;
  if (q.no != null && String(o.no ?? "") !== String(q.no)) return true;
  if (q.options != null && optionsChanged(o.options, q.options)) return true;
  if (q.levels != null
      && JSON.stringify(o.levels || []) !== JSON.stringify(q.levels)) return true;
  if (q.direction != null && (o.direction || "neutral") !== q.direction) return true;
  return false;
}

function questionsPreviewEl(box, p) {
  if (p.warn) {
    addPreviewLines(box, [{ cls: "diff-warn", text: `⚠ ${p.warn}` }]);
  }
  if (Array.isArray(p.edits) && p.edits.length) {
    questionEditsPreviewEl(box, p);
    return;
  }
  const incoming = (p.questions || []).map(convertProposalQuestion);
  const head = document.createElement("div");
  head.className = "assistant-proposal-stats";
  box.appendChild(head);
  if (p.mode === "append") {
    head.textContent = `Добавить вопросы (${incoming.length}) к текущим ${state.questions.length}:`;
    addPreviewLines(box, incoming.map(q => ({ cls: "diff-add", text: "+ " + fmtQuestionBrief(q) })));
    return;
  }
  head.textContent = `Заменить вопросы: было ${state.questions.length} → станет ${incoming.length}`;
  // Выравнивание по содержимому (LCS на нормализованном тексте вопроса), а не
  // по позициям: вставка/удаление в середине не сдвигает хвост — иначе diff
  // раздувается в «мусор» из десятков ложных изменений (инцидент: вставка 2
  // вопросов в середину 10 → 23 строки шума).
  const norm = normQuestionText;
  const A = state.questions, B = incoming;
  const m = A.length, k = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(k + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = k - 1; j >= 0; j--) {
      dp[i][j] = norm(A[i]) === norm(B[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const nodes = [];
  const dels = [], adds = [];
  let same = 0, i = 0, j = 0;
  const pushChg = (a, b, ai, bj) => {
    if (!questionChanged(a, b)) { same += 1; return; }
    const num = ai + 1 === bj + 1 ? `№${ai + 1}` : `№${ai + 1}→№${bj + 1}`;
    nodes.push(questionDiffEl(a, b, num));
  };
  while (i < m && j < k) {
    if (norm(A[i]) === norm(B[j])) { pushChg(A[i], B[j], i, j); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { dels.push({ q: A[i], n: i }); i++; }
    else { adds.push({ q: B[j], n: j }); j++; }
  }
  while (i < m) { dels.push({ q: A[i], n: i }); i++; }
  while (j < k) { adds.push({ q: B[j], n: j }); j++; }
  // Фаза 2: переформулированные вопросы — пары del+add с похожим текстом
  // (Jaccard по словам ≥ 0.5) показываем как «изменён», а не «−/+» (иначе
  // правка формулировки выглядит как удаление + новый вопрос).
  const sim = (a, b) => {
    const wa = new Set(norm(a).split(" ").filter(Boolean));
    const wb = new Set(norm(b).split(" ").filter(Boolean));
    if (!wa.size || !wb.size) return 0;
    let inter = 0;
    for (const w of wa) if (wb.has(w)) inter += 1;
    return inter / Math.max(wa.size, wb.size);
  };
  const usedAdd = new Set();
  const pairs = [];
  for (const d of dels) {
    let best = -1, bestSim = 0.5;
    for (let a = 0; a < adds.length; a++) {
      if (usedAdd.has(a)) continue;
      const s = sim(d.q, adds[a].q);
      if (s > bestSim) { bestSim = s; best = a; }
    }
    if (best >= 0) { usedAdd.add(best); pairs.push([d, adds[best]]); }
  }
  const pairedDel = new Set(pairs.map(([d]) => d));
  const pairedAdd = new Set(pairs.map(([, a]) => a));
  for (const [d, a] of pairs) pushChg(d.q, a.q, d.n, a.n);
  for (const d of dels) {
    if (!pairedDel.has(d)) {
      nodes.push(questionDelRow(d.q, `№${d.n + 1}`, questionMarkStats(d.q.id).total));
    }
  }
  for (const a of adds) {
    if (!pairedAdd.has(a)) nodes.push(questionAddEl(a.q, `№${a.n + 1}`));
  }
  if (same) {
    nodes.unshift(markerRow("diff-same", "", (bd) => {
      bd.textContent = `без изменений: ${same}`;
    }));
  }
  // Громкий детектор цены замены: чистые удаления — красной пометкой в
  // stats-строке (макет 1.4; инцидент 16.10: «было 8 → станет 2» читалось как
  // «добавили 2»). Вторая линия HITL — постоянная: replace остаётся для
  // полной пересборки.
  const pureDels = dels.filter(d => !pairedDel.has(d));
  if (pureDels.length) {
    head.appendChild(document.createTextNode(" · "));
    head.appendChild(delStatsSpan(
      pureDels.length === 1 ? `№${pureDels[0].n + 1}` : String(pureDels.length)));
  }
  box.appendChild(diffLegendEl());
  for (const n of nodes.slice(0, DIFF_PREVIEW_LINES)) box.appendChild(n);
  if (nodes.length > DIFF_PREVIEW_LINES) {
    box.appendChild(detailsDomEl(
      `… и ещё ${nodes.length - DIFF_PREVIEW_LINES} из ${nodes.length}`,
      nodes.slice(DIFF_PREVIEW_LINES)));
  }
}

// Условие предложения (вопрос по id, контракт A3) — читаемо:
// «№1 «Дефект на фото?» P(да) ≥ 70%» (№ — только отображение).
function condTextProposal(c) {
  const idx = state.questions.findIndex(q => q.id === c.question);
  const q = idx >= 0 ? state.questions[idx] : null;
  const ref = q && q.question ? `№${idx + 1} «${truncate(q.question, 40)}»`
    : `⚠ удалённый вопрос`;
  const op = c.op === "lt" ? "<" : "≥";
  return c.answer != null
    ? `${ref} P(${answerLabel(c.answer)}) ${op} ${c.threshold ?? 50}%`
    : `${ref} балл ${op} ${c.score}`;
}

// Условие из действующих правил (вопрос по id) — тем же видом.
function condTextCurrent(c) {
  const idx = state.questions.findIndex(q => q.id === c.question);
  const q = idx >= 0 ? state.questions[idx] : null;
  const ref = q && q.question ? `№${idx + 1} «${truncate(q.question, 40)}»` : "⚠ удалённый вопрос";
  const op = c.op === "lt" ? "<" : "≥";
  return c.answer != null
    ? `${ref} P(${answerLabel(c.answer)}) ${op} ${Math.round((c.threshold ?? 0.5) * 100)}%`
    : `${ref} балл ${op} ${c.score}`;
}

// Таблица условий «исход · условие | было | станет» (макет 2.1, option-c).
// Сопоставление позиционное внутри правила (правило i, условие j старое ↔
// новое); сравнение — по отформатированному тексту (condTextCurrent считает %
// из 0..1, condTextProposal берёт % payload — совпадение текста = совпадение
// смысла). Изменённое условие — строка «было» (зачёркнуто) / «станет» (жирным,
// изменённый фрагмент — w-add); добавленное — только «станет»; удалённое —
// только «было» (rt-del); неизменные — приглушёнными строками colspan=2
// (rt-same); новый исход целиком — пометка «новый исход».
function decisionPreviewEl(box, p) {
  const outs = p.outcomes || [];
  if (!outs.length) return; // битое предложение пометит превалидация
  const current = (state.decision && state.decision.outcomes) || [];
  const curByLabel = {};
  for (const o of current) curByLabel[o.label] = o;
  const table = document.createElement("table");
  table.className = "rt";
  const hr = document.createElement("tr");
  for (const t of ["исход · условие", "было", "станет"]) {
    const th = document.createElement("th");
    th.textContent = t;
    hr.appendChild(th);
  }
  table.appendChild(hr);
  const addRow = (label, tds) => {
    const tr = document.createElement("tr");
    const tdL = document.createElement("td");
    tdL.textContent = label;
    tr.appendChild(tdL);
    for (const td of tds) tr.appendChild(td);
    table.appendChild(tr);
  };
  const tdDash = () => {
    const td = document.createElement("td");
    td.className = "rt-same";
    td.textContent = "—";
    return td;
  };
  const tdOld = (text, cls = "rt-old") => {
    const td = document.createElement("td");
    td.className = cls;
    const s = document.createElement("s");
    s.textContent = text;
    td.appendChild(s);
    return td;
  };
  const tdNew = (text, diffFrom = null) => {
    const td = document.createElement("td");
    td.className = "rt-new";
    if (diffFrom != null && diffFrom !== text) wordDiffInto(td, diffFrom, text, true);
    else td.textContent = text;
    return td;
  };
  const tdSame = (text) => {
    const td = document.createElement("td");
    td.className = "rt-same";
    td.colSpan = 2;
    td.textContent = text;
    return td;
  };
  for (const o of outs) {
    const cur = curByLabel[o.label];
    const label = o.label || "(без названия)";
    const rules = o.rules || [];
    const curRules = (cur && cur.rules) || [];
    const multi = Math.max(rules.length, curRules.length) > 1;
    const ref = (ri, ci) => `${label}${multi ? ` · правило ${ri + 1}` : ""} · условие ${ci + 1}`;
    // пометка «новый исход» — на первой строке исхода (у исхода без условий —
    // в тексте rt-same)
    const tag = cur ? "" : " · новый исход";
    let tagged = false;
    const lbl = (base) => {
      if (!tagged && tag) { tagged = true; return base + tag; }
      return base;
    };
    const unchanged = []; // {ref, text} — рисуются после строк изменений
    let changed = false;
    const nR = Math.max(rules.length, curRules.length);
    for (let ri = 0; ri < nR; ri++) {
      const conds = (rules[ri] && rules[ri].conditions) || [];
      const curConds = (curRules[ri] && curRules[ri].conditions) || [];
      const nC = Math.max(conds.length, curConds.length);
      for (let ci = 0; ci < nC; ci++) {
        const nc = conds[ci], cc = curConds[ci];
        if (nc && cc) {
          const oldT = condTextCurrent(cc), newT = condTextProposal(nc);
          if (oldT === newT) unchanged.push({ ref: ref(ri, ci), text: oldT });
          else { addRow(lbl(ref(ri, ci)), [tdOld(oldT), tdNew(newT, oldT)]); changed = true; }
        } else if (nc) {
          addRow(lbl(ref(ri, ci)), [tdDash(), tdNew(condTextProposal(nc))]);
          changed = true;
        } else {
          addRow(lbl(ref(ri, ci)), [tdOld(condTextCurrent(cc), "rt-del"), tdDash()]);
          changed = true;
        }
      }
    }
    // смена статуса «по умолчанию» — отдельной строкой
    if (cur && !!cur.isDefault !== !!o.isDefault) {
      addRow(lbl(label), [tdOld(cur.isDefault ? "по умолчанию" : "обычный исход"),
                          tdNew(o.isDefault ? "по умолчанию" : "обычный исход")]);
      changed = true;
    }
    for (const u of unchanged) {
      addRow(lbl(u.ref), [tdSame(`${u.text} · без изменений`)]);
    }
    if (!changed && !unchanged.length) {
      // исход без условий: по умолчанию или пустое правило
      addRow(label, [tdSame((o.isDefault ? "по умолчанию" : "без условий")
        + (cur ? " · без изменений" : " · новый исход"))]);
      tagged = true;
    }
  }
  // исходы, которых нет в предложении, — удалятся
  for (const o of current) {
    if (!outs.some(n => n.label === o.label)) {
      const td = document.createElement("td");
      td.className = "rt-del";
      td.colSpan = 2;
      const s = document.createElement("s");
      s.textContent = "исход удаляется целиком";
      td.appendChild(s);
      addRow(o.label, [td]);
    }
  }
  box.appendChild(table);
}

// ---------------------------------------------------------------- дельта (v0.7)

// Блок измеренного эффекта правки правил на размеченных исходах (макет 6
// дизайн-документа). → { el, stale, measured }: stale=true — карточка
// блокирует «Принять» (разметка от старой редакции, дельта лжёт);
// measured=true — дельта посчитана на свежей разметке (eyebrow карточки
// получает суффикс «· проверено на разметке», макет 2.1).
function deltaBlockEl(proposal) {
  const box = document.createElement("div");
  box.className = "assistant-delta";
  let delta = null;
  try {
    delta = ruleDelta(decisionFromProposal(proposal.payload || {}, state.questions));
  } catch {
    box.remove(); // невалидное предложение покажет превалидация
    return { el: null, stale: false, measured: false };
  }
  if (!delta) {
    box.classList.add("assistant-delta-dim");
    box.textContent = "Эффект не измерен: разметки исходов нет. Разметьте несколько исходов (✓/✗ у решений) — и правки будут проверяться на них до применения.";
    return { el: box, stale: false, measured: false };
  }
  const revealCell = (c) => {
    const r = reviewMod.revealTarget(c.scope, {
      scope: c.scope, model: c.model, mode: c.mode, file: c.file, decision: true,
    });
    if (r.filterReset) {
      const note = document.createElement("div");
      note.className = "assistant-delta-note";
      note.textContent = "фильтр разметки сброшен — он скрывал цель";
      box.appendChild(note);
    }
  };
  if (delta.stale) {
    box.classList.add("assistant-delta-stale");
    box.textContent = "Дельту посчитать нельзя: разметка относится к старой редакции (вопросы или правила менялись после прогона). Сначала перепрогоните.";
    // петля восстановления (макет 2.7): телепорт к разметке исходов
    if (delta.cells[0]) {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "assistant-link assistant-link-quiet assistant-delta-mark";
      link.textContent = "что разметить →";
      link.addEventListener("click", () => revealCell(delta.cells[0]));
      box.appendChild(document.createTextNode(" "));
      box.appendChild(link);
    }
    return { el: box, stale: true, measured: false };
  }
  const head = document.createElement("div");
  head.className = "assistant-delta-head";
  head.textContent = `Размеченных исходов: ${delta.total} — ошибок ${delta.errorsBefore} → ${delta.errorsAfter}`;
  box.appendChild(head);
  const parts = [];
  if (delta.fixed) parts.push(`исправлено ${delta.fixed}`);
  parts.push(`новых ошибок ${delta.broken}`);
  if (delta.touched) parts.push(`затронуто (?) ${delta.touched}`);
  const sub = document.createElement("div");
  sub.className = "assistant-delta-sub";
  sub.textContent = parts.join(" · ");
  box.appendChild(sub);
  // «какие ячейки» — единый disclosure ▸/▾ (макет 2.1/2.1а): строка на
  // ячейку с маркером результата (✓ исправлено — ok; ✗ ошибка осталась или
  // сломали верную — bad; ? нейтральная затронута — warn). Имя файла —
  // flink (hover-поповер), остальная часть строки — телепорт к ячейке
  // разметки. Номер вопроса и сдвиг ответа в ячейках дельты не хранятся
  // (ruleDelta работает на уровне исходов) — не выдумываем.
  // В конце — приглушённый итог по совпавшим ячейкам (dl-same); ✗-ячейки
  // с несдвинутым исходом в него НЕ входят — они показаны своей строкой.
  const rows = [];
  let sameCount = 0;
  for (const c of delta.cells) {
    if (c.before === c.after && c.verdict !== "reject") sameCount++;
    else rows.push(c);
  }
  if (rows.length || sameCount) {
    const list = document.createElement("div");
    list.className = "assistant-delta-cells";
    for (const c of rows) {
      const fixed = c.verdict === "reject" && c.before !== c.after;
      const row = document.createElement("div");
      row.className = "dl assistant-delta-row";
      const mk = document.createElement("span");
      mk.className = "mk " + (fixed ? "mk-ok" : c.verdict === "unsure" ? "mk-warn" : "mk-bad");
      mk.textContent = fixed ? "✓" : c.verdict === "unsure" ? "?" : "✗";
      row.appendChild(mk);
      const body = document.createElement("span");
      if (c.scope === "batch" && c.file) {
        body.appendChild(fileLinkEl(c.file)); // имя файла — flink (превью-поповер)
      }
      // остальная часть строки — телепорт к ячейке
      const go = document.createElement("button");
      go.type = "button";
      go.className = "assistant-link assistant-delta-cell";
      const where = c.scope === "batch"
        ? ` × ${modelShortLabel(c.model)}`
        : `прогон ${modelShortLabel(c.model)}`;
      go.textContent = `${where}: «${c.before ?? "не определено"}» → «${c.after ?? "не определено"}»`
        + (c.verdict === "reject" && c.before === c.after ? " — ошибка осталась" : "");
      go.addEventListener("click", () => revealCell(c));
      body.appendChild(go);
      row.appendChild(body);
      list.appendChild(row);
    }
    if (sameCount) {
      const row = document.createElement("div");
      row.className = "dl dl-same";
      const mk = document.createElement("span");
      mk.className = "mk";
      const tx = document.createElement("span");
      tx.textContent = `ещё ${sameCount} ${plural(sameCount, "ячейка", "ячейки", "ячеек")} без изменений — метки совпадают`;
      row.append(mk, tx);
      list.appendChild(row);
    }
    box.appendChild(detailsDomEl("какие ячейки", [list]));
  }
  if (delta.total < 5) {
    const warn = document.createElement("div");
    warn.className = "assistant-delta-warn";
    warn.textContent = `⚠ выборка маленькая (${delta.total}), погрешность ≈1 ошибка`;
    box.appendChild(warn);
  }
  return { el: box, stale: false, measured: true };
}

function currentContextText() {  try {
    const snap = contextSnapshot();
    return typeof snap.input === "string" ? snap.input : JSON.stringify(snap.input, null, 2);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- построчный diff текста (v1.1, п. 7.5)

const TEXT_DIFF_MAX_ROWS = 200; // потолок строк diff'а в карточке

// LCS по строкам (как diff вопросов выше): → строки {cls, text, pair}:
// diff-del / diff-add, неизменные хвосты схлопываются в счётчик
// «без изменений: N строк». Пустая сторона — весь текст другой добавлен/
// удалён. В непрерывном блоке del/add i-я del связывается с i-й add (замена
// строки): pair — текст другой стороны, для пословного выделения фрагмента
// при рендере (contextDiffRowEl).
export function textDiffLines(current, proposed) {
  const A = String(current ?? "").split("\n");
  const B = String(proposed ?? "").split("\n");
  const m = A.length, k = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(k + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = k - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = []; // {t: "same"|"del"|"add", text, pair?}
  let i = 0, j = 0;
  while (i < m && j < k) {
    if (A[i] === B[j]) { ops.push({ t: "same", text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "del", text: A[i] }); i++; }
    else { ops.push({ t: "add", text: B[j] }); j++; }
  }
  while (i < m) { ops.push({ t: "del", text: A[i] }); i++; }
  while (j < k) { ops.push({ t: "add", text: B[j] }); j++; }
  // пары «замена строки»: в блоке del+add сопоставляем по позиции в блоке
  for (let b = 0; b < ops.length;) {
    if (ops[b].t === "same") { b++; continue; }
    const dels = [], adds = [];
    while (b < ops.length && ops[b].t !== "same") {
      (ops[b].t === "del" ? dels : adds).push(ops[b]); b++;
    }
    for (let x = 0; x < Math.min(dels.length, adds.length); x++) {
      dels[x].pair = adds[x].text;
      adds[x].pair = dels[x].text;
    }
  }
  const lines = [];
  let run = 0; // длина текущей серии неизменных строк
  const flushRun = () => {
    if (run) {
      lines.push({ cls: "diff-same", text: `без изменений: ${run} ${plural(run, "строка", "строки", "строк")}` });
      run = 0;
    }
  };
  for (const op of ops) {
    if (op.t === "same") { run++; continue; }
    flushRun();
    lines.push({ cls: op.t === "del" ? "diff-del" : "diff-add",
                 text: op.text, pair: op.pair ?? null });
  }
  flushRun();
  if (!lines.length) lines.push({ cls: "", text: "без изменений" });
  return lines;
}

// Числа с разрядностью пробелом, как в макете («2 040 симв.»).
function fmtNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// Пословное выделение фрагмента в паре «замена строки» — только когда LCS по
// словам не раздувается (длинные однострочники зачёркиваем целиком).
function wordPairOk(a, b) {
  const wa = String(a).split(/\s+/).filter(Boolean).length;
  const wb = String(b).split(/\s+/).filter(Boolean).length;
  return wa * wb <= 2500;
}

// Строка построчного diff'а контекста (макет 3.1): .dl с маркером .mk и
// моно-текстом (dl-mono). У парной замены зачёркнут только изменённый
// фрагмент (.bd, пословно), у чистого удаления — вся строка приглушённым
// зачёркиванием; у парной add-строки добавленные слова — w-add.
function contextDiffRowEl(line) {
  const row = document.createElement("div");
  row.className = "dl dl-mono" + (line.cls ? " " + line.cls : "");
  const mk = document.createElement("span");
  mk.className = "mk";
  mk.textContent = line.cls === "diff-del" ? "−" : line.cls === "diff-add" ? "+" : "";
  row.appendChild(mk);
  const body = document.createElement("span");
  if (line.cls === "diff-del") {
    if (line.pair != null && wordPairOk(line.text, line.pair)) {
      wordDiffInto(body, line.text, line.pair, false, "bd");
    } else {
      const s = document.createElement("span");
      s.className = "bd";
      s.textContent = line.text;
      body.appendChild(s);
    }
  } else if (line.cls === "diff-add" && line.pair != null
             && wordPairOk(line.pair, line.text)) {
    wordDiffInto(body, line.pair, line.text, true);
  } else {
    body.textContent = line.text;
  }
  row.appendChild(body);
  return row;
}

function contextPreviewEl(box, p) {
  const head = document.createElement("div");
  head.className = "assistant-proposal-stats";
  const proposed = String(p.text ?? "");
  let current = "";
  let fileMissing = false;
  if (p.file) {
    // имя файла — flink (моно + пунктирная underline): hover → превью, клик →
    // на весь экран; несуществующий файл — обычный текст
    head.appendChild(document.createTextNode(
      p.mode === "append" ? "Дописать в файл " : "Заменить текст файла "));
    head.appendChild(fileLinkEl(p.file));
    head.appendChild(document.createTextNode(":"));
    const f = state.batch.files.find(x => x.name === p.file);
    fileMissing = !(f && !f.isImage);
    current = fileMissing ? "(файл не найден в пакете)" : String(f.text || "");
  } else {
    head.textContent = p.mode === "append" ? "Добавить к материалу:" : "Заменить материал:";
    current = currentContextText();
  }
  box.appendChild(head);
  // stats-строка макета 3.1: «+1 строка · замена · 212 → 248 симв.»
  const stats = document.createElement("div");
  stats.className = "assistant-proposal-stats assistant-context-stats";
  const oldLen = fileMissing ? 0 : current.length;
  const newLen = proposed.length;
  if (p.mode === "append") {
    const tail = proposed.split("\n");
    stats.textContent = `+${tail.length} ${plural(tail.length, "строка", "строки", "строк")}`
      + ` · дописка · ${fmtNum(oldLen)} → ${fmtNum(oldLen + newLen)} симв.`;
    box.appendChild(stats);
    // append — только добавляемый хвост, diff с текущим не нужен
    for (const t of tail) {
      box.appendChild(contextDiffRowEl({ cls: "diff-add", text: t, pair: null }));
    }
    return;
  }
  const lines = textDiffLines(current, proposed);
  const net = proposed.split("\n").length - current.split("\n").length;
  const netPart = net > 0 ? `+${net} ${plural(net, "строка", "строки", "строк")}`
    : net < 0 ? `−${-net} ${plural(-net, "строка", "строки", "строк")}`
    : "строк столько же";
  stats.textContent = `${netPart} · замена · ${fmtNum(oldLen)} → ${fmtNum(newLen)} симв.`;
  box.appendChild(stats);
  for (const l of lines.slice(0, TEXT_DIFF_MAX_ROWS)) {
    box.appendChild(contextDiffRowEl(l));
  }
  if (lines.length > TEXT_DIFF_MAX_ROWS) {
    const more = document.createElement("div");
    more.textContent = `… и ещё ${lines.length - TEXT_DIFF_MAX_ROWS} строк diff'а`;
    box.appendChild(more);
  }
}

function presetPreviewEl(box, p) {
  const head = document.createElement("div");
  head.className = "assistant-proposal-stats";
  head.textContent = (p.slug ? "Обновить пресет «" : "Сохранить пресет «")
    + (p.name || "") + "»";
  box.appendChild(head);
  const mode = state.pageMode === "batch" ? "пакет материалов" : "один материал";
  const n = state.questions.length;
  const outcomes = (state.decision && state.decision.outcomes) || [];
  // kv-структура макета 5.1: label muted + значение; перезапись (slug)
  // покрыта деструктивным блоком гейта 5.4 — плоской строкой не дублируем
  const kvRow = (key, value, dim = false) => {
    const row = document.createElement("div");
    row.className = "kv";
    const kk = document.createElement("span");
    kk.className = "kv-k";
    kk.textContent = key;
    const vv = document.createElement("span");
    if (dim) vv.className = "dim";
    vv.textContent = value;
    row.append(kk, vv);
    box.appendChild(row);
  };
  kvRow("состав",
    `${n} ${plural(n, "вопрос", "вопроса", "вопросов")}`
    + (outcomes.length
      ? ` · правила (${outcomes.length} ${plural(outcomes.length, "исход", "исхода", "исходов")})`
      : " · без правил решения")
    + ` · режим «${mode}»`);
  if (p.description) kvRow("описание", `«${p.description}»`, true);
}

// kv-структура гейта прогона (макет 4.1): модели — чипы со статусом,
// вопросы — №-диапазон, scope, delta-note при висящей правке вопросов.
// scope-выбора в v0.9 нет (спека §12: «в v0.9 — только "весь пакет",
// scope-чипы появятся в v1.0») — показываем выбранный «весь пакет»,
// прогон всегда идёт по всему пакету (applyRunProposal → tb-run).
function runPreviewEl(box, p) {
  const kvRow = (key) => {
    const row = document.createElement("div");
    row.className = "kv";
    const kk = document.createElement("span");
    kk.className = "kv-k";
    kk.textContent = key;
    const vv = document.createElement("span");
    row.append(kk, vv);
    box.appendChild(row);
    return vv;
  };
  // модели: чипы выбранных в баре + статус (остановленная — warn)
  const sel = state.models.filter(m => state.selectedModels.has(m.key));
  const vModels = kvRow("модели");
  if (sel.length) {
    const stopped = sel.filter(m => m.status && m.status !== "running");
    for (const m of sel) {
      const chip = document.createElement("span");
      chip.className = "assistant-mchip";
      chip.textContent = modelShortLabel(m.key);
      vModels.appendChild(chip);
    }
    const note = document.createElement("span");
    if (stopped.length) {
      note.className = "assistant-kv-warn";
      note.textContent = "— " + stopped
        .map(m => `${modelShortLabel(m.key)} остановлена`).join(", ");
    } else {
      note.className = "dim";
      note.textContent = sel.length === 2 ? "— обе запущены" : "— все запущены";
    }
    vModels.appendChild(note);
  } else {
    vModels.textContent = "не выбраны";
    vModels.classList.add("dim");
  }
  // вопросы: №-диапазон; при висящей правке вопросов — пометка о новой редакции
  const pendingQuestions = pendingProposalItems(activeConvo)
    .some(it => it.proposal.kind === "propose_questions");
  const n = state.questions.length;
  const vQ = kvRow("вопросы");
  vQ.textContent = n
    ? `№1–№${n} · ${n} ${plural(n, "вопрос", "вопроса", "вопросов")}`
    : "нет вопросов";
  if (n && pendingQuestions) {
    const d = document.createElement("span");
    d.className = "dim";
    d.textContent = ", новая редакция (после принятия карточки выше)";
    vQ.appendChild(d);
  }
  // scope: для пакета — чип выбранного «весь пакет» (v0.9, без выбора)
  const vScope = kvRow("scope");
  if (p.scope === "batch") {
    const wrap = document.createElement("span");
    wrap.className = "assistant-scope";
    const chip = document.createElement("span");
    chip.className = "assistant-scope-chip on";
    chip.textContent = "весь пакет";
    wrap.appendChild(chip);
    vScope.appendChild(wrap);
  } else {
    vScope.textContent = "один материал";
  }
  // delta-note (макет 4.1): прогон для проверки правки вопросов (what-if)
  // при наличии разметки — сверка посчитается по завершении
  const marks = ((state.results && state.results.marks) || []).length
    + (state.batch.marks || []).length;
  if (pendingQuestions && marks) {
    const d = document.createElement("div");
    d.className = "assistant-delta";
    const sub = document.createElement("div");
    sub.className = "assistant-delta-sub";
    sub.textContent = `Дельта на ${marks} `
      + plural(marks, "размеченной ячейке", "размеченных ячейках",
               "размеченных ячейках")
      + " посчитается автоматически по завершении — интерфейс сверит "
      + "ответы с вашей разметкой.";
    d.appendChild(sub);
    box.appendChild(d);
  }
  if (p.note) {
    const div = document.createElement("div");
    div.className = "dim";
    div.textContent = p.note;
    box.appendChild(div);
  }
}

// Превью карточки — DOM: diff-строки и <details> для длинных мест.
function proposalPreviewEl(proposal) {
  const box = document.createElement("div");
  box.className = "assistant-proposal-preview";
  const p = proposal.payload || {};
  if (proposal.kind === "propose_questions") questionsPreviewEl(box, p);
  else if (proposal.kind === "propose_context") contextPreviewEl(box, p);
  else if (proposal.kind === "propose_decision") decisionPreviewEl(box, p);
  else if (proposal.kind === "propose_save_preset") presetPreviewEl(box, p);
  else if (proposal.kind === "propose_run") runPreviewEl(box, p);
  else {
    const div = document.createElement("div");
    div.textContent = truncate(JSON.stringify(p, null, 2), CONTEXT_PREVIEW);
    box.appendChild(div);
  }
  return box;
}

function showProposalError(card, e) {
  const err = document.createElement("div");
  err.className = "assistant-proposal-error";
  err.textContent = e.message || String(e);
  card.appendChild(err);
}

// Карточка предложения: pending (пилла «Ждёт решения» + кнопки
// «Принять»/«Отклонить») — до нажатия состояние приложения не меняется.
// «Принять» → применение, пилла «Применена» и ссылка «Отменить» в терминальной
// строке (если для этого вида есть undo). «Отклонить» → «Отклонена»,
// состояние не тронуто.
// Превалидация карточки при показе (v0.7): битое предложение помечается до
// клика «Принять», а не ошибкой после. Единый базис валидации (A3): серверный
// /propose/validate прогоняет ту же пару проверок (схема + state-зависимые по
// id), что и агентный цикл; локальной двойной валидации нет — фронт шлёт
// облегчённый снапшот (для правил под ещё не принятую карточку вопросов —
// виртуальный набор хода). Сетевая ошибка — fail-open (карточка остаётся
// рабочей, валидация случится при применении).
function proposalValidationSnapshot(proposal) {
  // propose_decision, построенный под висячую карточку вопросов, валидируется
  // против её набора (по id); остальным видам достаточно текущих вопросов
  const questions = (proposal.kind === "propose_decision" && turnVirtualQuestions)
    ? turnVirtualQuestions : state.questions;
  return {
    questions: questions.map(q => ({
      id: q.id, question: q.question, type: q.type,
      options: (q.options || []).map(o => (typeof o === "string" ? o : o.name)),
      levels: q.levels,
    })),
    batchFiles: state.batch.files.map(f => ({ name: f.name })),
    // propose_run: остановленная выбранная модель — invalid гейта (макет 4.11)
    selectedModels: selectedModelsSnapshot(),
  };
}

// Имена файлов в причине invalid (макет 3.8): бэкенд-валидация propose_context
// шлёт их verbatim («файла «x.txt» нет в пакете — доступные: a.txt, …») —
// рендерим flink'ами (hover-превью); несуществующий файл fileLinkEl сам
// отобразит обычным моно-текстом. Токены «слово.расширение» (ext — 2–5 букв,
// чтобы не цеплять «0.95») с обрамляющей пунктуацией текстом.
function appendReasonWithFlinks(el, reason) {
  const re = /^([«"'\(]*)([\wА-Яа-яЁё][\wА-Яа-яЁё.\-]*\.[A-Za-z]{2,5})([.,;:»"'\)]*)$/u;
  for (const tok of String(reason).split(/(\s+)/)) {
    const m = tok.match(re);
    if (!m) { el.appendChild(document.createTextNode(tok)); continue; }
    if (m[1]) el.appendChild(document.createTextNode(m[1]));
    el.appendChild(fileLinkEl(m[2]));
    if (m[3]) el.appendChild(document.createTextNode(m[3]));
  }
}

function markProposalInvalid(card, status, reason, proposal) {
  card.classList.add("assistant-proposal-invalid");
  card.classList.remove("assistant-proposal-compact"); // причину надо видеть
  if (card._expandLink) card._expandLink.remove();
  // пилла «Ошибка» возвращается в верхний ряд (в компактной она в essence)
  const top = card.querySelector(".assistant-proposal-top");
  if (top && status && status.parentNode !== top) top.appendChild(status);
  setStatusText(status, "invalid", "Ошибка");
  // Ряд «Принять»/«Отклонить» убираем целиком: на отвергнутой проверкой
  // карточке это ложные affordance'ы — выбора у пользователя нет, остаются
  // только «Сообщить ассистенту об ошибке» и «Скрыть»
  const actions = card.querySelector(".assistant-proposal-actions");
  if (actions) actions.remove();
  // причина — в заголовке (ink), полный текст — muted-строкой под ним
  // (макет 1.8); исходный заголовок не теряется: суть кэширована в
  // card._essenceText при создании
  const title = card.querySelector(".assistant-proposal-title");
  if (title) {
    title.textContent = "Такую правку применить нельзя: " + truncate(reason, 90);
    title.title = reason;
  }
  const det = document.createElement("div");
  det.className = "assistant-proposal-reason";
  // у propose_context имена файлов в причине — flink'ами (макет 3.8)
  if (proposal && proposal.kind === "propose_context") {
    appendReasonWithFlinks(det, reason);
  } else {
    det.textContent = reason;
  }
  if (title) title.after(det);
  else card.appendChild(det);
  // muted-подстрока пояснения для битых правил (макет 2.8): модель не видит
  // судьбу карточки — репорт уходит ей системной репликой
  if (proposal && proposal.kind === "propose_decision") {
    const sub = document.createElement("div");
    sub.className = "assistant-proposal-reason assistant-invalid-sub";
    sub.textContent = "Модель не видит судьбу карточки — репорт об ошибке уходит ей системной репликой, и она предложит исправленный вариант.";
    det.after(sub);
  }
  // muted-подстрока навигации (макет 4.11): причина — остановленная модель →
  // ссылка-переход на страницу «Модели» (переключение вкладки приложения)
  if (proposal && proposal.kind === "propose_run"
      && /остановлен|не запущен|не отвечает/i.test(reason)) {
    const sub = document.createElement("div");
    sub.className = "assistant-proposal-reason assistant-invalid-sub";
    sub.appendChild(document.createTextNode("Запустите её "));
    const go = document.createElement("button");
    go.type = "button";
    go.className = "assistant-link assistant-link-quiet assistant-goto-models";
    go.textContent = "на странице «Модели»";
    go.addEventListener("click", () => setPageMode("models"));
    sub.appendChild(go);
    sub.appendChild(document.createTextNode(" — дальше прогон можно запросить заново."));
    det.after(sub);
  }
  card._invalidReason = reason;
  if (card._feedItem) {
    card._feedItem.status = "invalid";
    card._feedItem.invalidReason = reason;
    persistChat();
  }
  // выбыла из очереди — номер больше не показываем
  for (const num of card.querySelectorAll(".assistant-proposal-queuenum")) {
    num.textContent = "";
  }
  syncPendingEdge(card);
  refreshProposalQueue(); // карточка выбыла из pending — развернуть следующую
  // Модель не видит, что её карточка помечена невалидной (v0.8): кнопка шлёт
  // причину в чат системной репликой — модель исправляет и предлагает заново.
  if (proposal) {
    const foot = document.createElement("div");
    foot.className = "assistant-proposal-foot";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "assistant-report-invalid";
    btn.textContent = "Сообщить ассистенту об ошибке";
    btn.addEventListener("click", () => {
      btn.disabled = true;
      sendMessage(`Предложение ${proposal.kind} невалидно: ${reason}. `
        + "Исправь аргументы и предложи заново.", { system: true });
    });
    foot.appendChild(btn);
    foot.appendChild(hideCardBtnEl(card, proposal, "Ошибка"));
    card.appendChild(foot);
  }
}

// «Скрыть» на невалидной/протухшей карточке — схлопнуть в строку-итог
// (текстовая кнопка, навигационный ярус).
function hideCardBtnEl(card, proposal, statusText) {
  const hide = document.createElement("button");
  hide.type = "button";
  hide.className = "assistant-card-hide";
  hide.textContent = "Скрыть";
  hide.addEventListener("click", () => {
    collapseProposalCard(card, proposal, statusText);
  });
  return hide;
}

async function prevalidateProposal(proposal, card, status) {
  try {
    await validateProposal(proposal.kind, proposal.payload,
                           proposalValidationSnapshot(proposal));
  } catch (e) {
    if (e.message.startsWith("Ошибка 422")) {
      const reason = e.message.replace(/^Ошибка 422: /, "");
      markProposalInvalid(card, status, reason, proposal);
      receiptBeacon(proposal, "invalid", reason);
    }
    // сетевая/прочая ошибка — fail-open: карточка остаётся рабочей
  }
}

// Схлопывание карточки в терминальную строку-итог (концепция «Рамс», v1.2):
// «пилла · суть · действия», разворот по клику на строку; действия вторым
// рядом на узкой панели (flex-wrap), переносы без ellipsis. undoBtn (если
// есть) — текстовая ссылка «Отменить» в ряду действий. Активные карточки не
// трогаем; терминальные восстанавливаются из persist уже схлопнутыми
// (см. restoredProposalCard).
function collapseProposalCard(card, proposal, statusText, undoBtn) {
  const status = card._statusEl || card.querySelector(".assistant-proposal-status");
  const top = card.querySelector(".assistant-proposal-top");
  // карточка может проходить несколько терминальных статусов (применено →
  // отменено) — строка строится один раз, дальше обновляем контекст
  const ctx = card._collapseCtx || { statusText, undoBtn };
  ctx.statusText = statusText;
  ctx.undoBtn = undoBtn || ctx.undoBtn;
  card._collapseCtx = ctx;
  if (!card._termRow) {
    const row = document.createElement("div");
    row.className = "assistant-term-row hidden";
    row.setAttribute("tabindex", "0");
    const sum = document.createElement("span");
    sum.className = "assistant-term-sum";
    const acts = document.createElement("span");
    acts.className = "assistant-term-acts";
    const exp = document.createElement("button");
    exp.type = "button";
    exp.className = "assistant-link assistant-link-quiet";
    exp.textContent = "развернуть";
    acts.appendChild(exp);
    row.append(sum, acts);
    row.title = "Развернуть";
    card.appendChild(row);
    card._termRow = row;
    card._termSum = sum;
    card._termActs = acts;
    card._termExpand = exp;
  }
  const apply = (collapsed) => {
    card.classList.toggle("assistant-proposal-terminal", collapsed);
    card._termRow.classList.toggle("hidden", !collapsed);
    for (const ch of [...card.children]) {
      if (ch === card._termRow) continue;
      ch.classList.toggle("hidden", collapsed);
    }
    if (collapsed) {
      // пилла — первой в строке; undo — перед «развернуть»
      card._termRow.insertBefore(status, card._termSum);
      card._termSum.textContent = card._essenceText || proposal.title || proposal.kind;
      if (ctx.undoBtn) {
        ctx.undoBtn.classList.remove("hidden");
        card._termActs.insertBefore(ctx.undoBtn, card._termExpand);
      }
    } else if (top) {
      top.appendChild(status);
      if (ctx.undoBtn) card.appendChild(ctx.undoBtn);
    }
    syncPendingEdge(card);
  };
  if (!ctx.listener) {
    ctx.listener = () => apply(!card.classList.contains("assistant-proposal-terminal"));
    card._termRow.addEventListener("click", ctx.listener);
    // «развернуть» — та же реакция, но без всплытия (строка сама кликабельна)
    card._termExpand.addEventListener("click", (e) => {
      e.stopPropagation();
      apply(false);
    });
  }
  apply(true);
}

// ---------------------------------------------------------------- очередь pending (v1.1)
// Концепция «в ленте одна большая карточка — та, о которой речь»: развёрнута
// старейшая нерешённая, остальные pending — компактные строки-последствия
// (суть + Принять/Отклонить + разворот). Ручной разворот пользователя не
// трогаем. Нумерация «i/N» при N≥2. Чип в шапке — счётчик ожидающих.
// Карточки по feed-записям — в Map (не в item, чтобы не замкнуть JSON.persist).

const proposalCardByItem = new Map();

function pendingProposalItems(key) {
  const c = convos[key];
  if (!c) return [];
  return c.feed.filter(it => it.t === "proposal" && it.status === "pending");
}

// Русская плюрализация: plural(2, "условие", "условия", "условий").
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// Строка-последствие по виду карточки: не заголовок («Набор вопросов»), а
// суть решения («+2, изменён №4, ⚠ удаляется 1 из 8») — принятие вслепую по
// заголовку подрывало safety-принцип (разбор 19.10).
function proposalEssence(proposal) {
  const p = proposal.payload || {};
  if (proposal.kind === "propose_questions") {
    let add = 0, upd = 0, del = 0;
    const splits = [];
    if (Array.isArray(p.edits) && p.edits.length) {
      const numOf = id => {
        const i = state.questions.findIndex(q => q.id === id);
        return i >= 0 ? `№${i + 1}` : `«${id}»`;
      };
      for (const e of p.edits) {
        if (e.op === "add") add += 1;
        else if (e.op === "remove") del += 1;
        else if (e.op === "update") upd += 1;
        else if (e.op === "split") splits.push(`${numOf(e.target)} → ${(e.into || []).length}`);
      }
    } else {
      const incoming = (p.questions || []).map(convertProposalQuestion);
      if (p.mode === "append") add = incoming.length;
      else {
        const cur = new Set(state.questions.map(normQuestionText));
        const inc = new Set(incoming.map(normQuestionText));
        add = [...inc].filter(t => !cur.has(t)).length;
        del = [...cur].filter(t => !inc.has(t)).length;
      }
    }
    const parts = [];
    if (add) parts.push(`+${add}`);
    if (upd) parts.push(`изменено ${upd}`);
    if (splits.length) parts.push(`разбиты ${splits.join(", ")}`);
    if (del) parts.push(`⚠ удаляется ${del} из ${state.questions.length}`);
    return "Вопросы: " + (parts.join(", ") || "формулировки без изменения состава");
  }
  if (proposal.kind === "propose_decision") {
    const outcomes = p.outcomes || [];
    const conds = outcomes.reduce((s, o) => s + (o.rules || [])
      .reduce((s2, r) => s2 + (r.conditions || []).length, 0), 0);
    const red = outcomes.find(o => o.color === "red" && (o.rules || [])[0]
      && (o.rules[0].conditions || [])[0]);
    let flag = "";
    if (red) {
      const c = red.rules[0].conditions[0];
      const val = c.answer != null ? `«${c.answer}»` : `оценка ${c.score}`;
      const qi = state.questions.findIndex(q => q.id === c.question);
      const qref = qi >= 0 ? `№${qi + 1}` : "вопрос";
      flag = `, красный флаг — ${qref} ${val} ≥ ${c.threshold}%`;
    }
    return `Правила: ${outcomes.length} ${plural(outcomes.length, "исход", "исхода", "исходов")} · ${conds} ${plural(conds, "условие", "условия", "условий")}${flag}`;
  }
  if (proposal.kind === "propose_context") {
    const newLen = String(p.text ?? "").length;
    if (p.file) {
      const f = state.batch.files.find(x => x.name === p.file);
      const oldLen = f && !f.isImage ? String(f.text || "").length : 0;
      const eff = p.mode === "append" ? oldLen + newLen : newLen;
      return `Контекст файла: ${p.file} — ${p.mode === "append" ? "дописать" : "замена"}, ${fmtNum(oldLen)} → ${fmtNum(eff)} симв.`;
    }
    let oldLen = 0;
    try { oldLen = currentContextText().length; } catch { /* пусто */ }
    const eff = p.mode === "append" ? oldLen + newLen : newLen;
    return `Контекст: ${p.mode === "append" ? "дописать" : "замена текста"}, ${fmtNum(oldLen)} → ${fmtNum(eff)} симв.`;
  }
  if (proposal.kind === "propose_run") {
    const scopeT = p.scope === "batch" ? "пакет материалов" : "один материал";
    const m = state.selectedModels ? state.selectedModels.size : 0;
    const cnt = m ? `${m} ${plural(m, "модель", "модели", "моделей")}` : "";
    if (p.scope === "batch") {
      const f = state.batch.files.length;
      const ft = f ? `${f} ${plural(f, "файл", "файла", "файлов")}` : "";
      return `Запуск: ${scopeT}`
        + (ft && cnt ? ` · ${ft} × ${cnt}` : (ft || cnt ? ` · ${ft}${cnt}` : ""));
    }
    return `Запуск: ${scopeT}` + (cnt ? ` · ${cnt}` : "");
  }
  if (proposal.kind === "propose_save_preset") {
    const n = state.questions.length;
    return `Пресет: ${p.slug ? "обновить" : "сохранить"} «${p.name || ""}» — ${n} ${plural(n, "вопрос", "вопроса", "вопросов")}`
      + (state.decision && (state.decision.outcomes || []).length ? " + правила" : "");
  }
  return proposal.title || proposal.kind;
}

// Деструктивная правка вопросов (макеты 1.2/1.4): гейт срабатывает при
// удалении вопроса с разметкой (ЛЮБАЯ доля набора — потеря меток
// невосстановима), при удалении >половины набора и при warn от бэка
// (затронуты условия правил). → { del, total, dels, marks, orphans, warn } |
// null; dels — [{id, q, ref, marks}], marks — сумма по удаляемым, orphans —
// условия правил, теряющие опору.
// Принятие — только из развёрнутого вида (защита от слепого accept, критик
// 19.10); при del > 0 кнопка — solid-красная с ценой в тексте.
function destructiveQuestionsInfo(proposal) {
  if (proposal.kind !== "propose_questions") return null;
  const p = proposal.payload || {};
  const dels = deletedQuestionsOf(p);
  const total = state.questions.length;
  const marks = { total: 0, accept: 0, reject: 0, unsure: 0 };
  for (const d of dels) {
    d.marks = questionMarkStats(d.id);
    for (const k of ["total", "accept", "reject", "unsure"]) marks[k] += d.marks[k];
  }
  const orphans = decisionOrphans(dels.map(d => d.id));
  const info = { del: dels.length, total, dels, marks, orphans, warn: p.warn || null };
  if (p.warn) return info;
  const gated = dels.length > 0 && (marks.total > 0 || dels.length > total / 2);
  return gated ? info : null;
}

// Красная пометка гейта в компактной essence-строке (макет 1.2/1.4):
// «⚠ удаляется №2 из 5 — с ним 8 меток разметки» / «⚠ удаляется 7 из 9 —
// с ними уйдёт разметка 34 ячеек»; warn-only гейт — текст warn от бэка.
function questionsGateCore(g) {
  if (g.del > 0) {
    const subj = g.del === 1 && g.dels[0] ? g.dels[0].ref : String(g.del);
    let s = `⚠ удаляется ${subj} из ${g.total}`;
    if (g.marks.total > 0) {
      const n = g.marks.total;
      s += g.del === 1
        ? ` — с ним ${n} ${plural(n, "метка", "метки", "меток")} разметки`
        : ` — с ними уйдёт разметка ${n} ${plural(n, "ячейки", "ячеек", "ячеек")}`;
    }
    return s;
  }
  return `⚠ ${g.warn || "деструктивная правка набора"}`;
}

// Блок цены удаления в развёрнутой карточке (макет .destruct): что удаляется,
// сколько разметки сгорит, какие условия правил останутся без опоры; хвост —
// «принятие только из развёрнутого вида».
function questionsDestructEl(g) {
  const d = document.createElement("div");
  d.className = "assistant-destruct";
  const ico = document.createElement("span");
  ico.className = "d-ico";
  ico.textContent = "⚠";
  const tx = document.createElement("span");
  const b = document.createElement("b");
  if (g.del === 1 && g.dels[0]) {
    const q = g.dels[0].q;
    b.textContent = `Удаляется ${g.dels[0].ref}`
      + (q && q.question ? ` «${truncate(q.question, 40)}»` : "") + ".";
  } else if (g.del > 0) {
    b.textContent = `Удаляются ${g.del} из ${g.total} вопросов.`;
  } else {
    b.textContent = `⚠ ${g.warn}`;
  }
  tx.appendChild(b);
  const clauses = [];
  if (g.marks.total > 0) {
    const n = g.marks.total;
    const br = [];
    if (g.marks.accept) br.push(`${g.marks.accept} ✓`);
    if (g.marks.reject) br.push(`${g.marks.reject} ✗`);
    if (g.marks.unsure) br.push(`${g.marks.unsure} ?`);
    clauses.push(g.del === 1
      ? `с ним уйдут ${n} ${plural(n, "метка", "метки", "меток")} разметки (${br.join(", ")}) — восстановить их после применения нельзя`
      : `вместе с ними будет потеряна разметка ${n} ${plural(n, "ячейки", "ячеек", "ячеек")} (${br.join(", ")})`);
  }
  if (g.orphans.length) {
    const names = g.orphans.map(h => `«${h.label}»`).join(", ");
    const refs = [...new Set(g.orphans.flatMap(h => h.refs))].join(", ");
    clauses.push((clauses.length ? "а " : "")
      + (g.orphans.length === 1
        ? `условие исхода ${names} останется без опоры — оно ссылается на ${refs}`
        : `условия исходов ${names} останутся без опоры — они ссылаются на ${refs}`));
  }
  let rest = "";
  if (clauses.length) {
    const joined = clauses.join(", ");
    rest = " " + joined.charAt(0).toUpperCase() + joined.slice(1) + ".";
  }
  rest += " Принятие доступно только из этого развёрнутого вида.";
  tx.appendChild(document.createTextNode(rest));
  d.append(ico, tx);
  return d;
}

// Строка следствия правки вопросов для правил решения (макет 1.1, .c-conseq).
// Детерминированно из state.decision: условия ссылаются на вопросы по id.
// Удаление связанного вопроса — warn с конкретикой (какой исход без опоры);
// правила есть, но удалений связанных нет — успех. Без правил/условий блок
// не показываем: утверждать нечего.
function decisionConseqEl(p) {
  const outcomes = (state.decision && state.decision.outcomes) || [];
  const refs = [];  // refs вопросов, на которые ссылаются условия
  const seen = new Set();
  for (const o of outcomes) {
    for (const r of o.rules || []) {
      for (const c of r.conditions || []) {
        if (c.question == null || seen.has(c.question)) continue;
        seen.add(c.question);
        const i = state.questions.findIndex(q => q.id === c.question);
        refs.push(i >= 0 ? `№${i + 1}` : `«${c.question}»`);
      }
    }
  }
  if (!refs.length) return null;
  const dels = deletedQuestionsOf(p);
  const orphans = decisionOrphans(dels.map(d => d.id));
  const div = document.createElement("div");
  div.className = "assistant-conseq" + (orphans.length ? " assistant-conseq-warn" : "");
  const ico = document.createElement("span");
  ico.className = "assistant-conseq-ico";
  ico.textContent = orphans.length ? "⚠" : "✓";
  const tx = document.createElement("span");
  const b = document.createElement("b");
  if (orphans.length) {
    b.textContent = "Правила решения затронуты: ";
    const parts = orphans.map(h =>
      `условие исхода «${h.label}» ссылается на удаляемый ${h.refs.join(", ")}`);
    tx.append(b, document.createTextNode(
      parts.join("; ") + " — после применения останется без опоры, пересчёт правил понадобится."));
  } else {
    b.textContent = "Правила решения не затронуты: ";
    tx.append(b, document.createTextNode(`условия ссылаются на ${refs.join(", ")}`
      + (dels.length ? "" : ", их номера не сдвинутся")
      + " — пересчёт правил не понадобится."));
  }
  div.append(ico, tx);
  return div;
}

// Деструктивный гейт правил (макет 2.4): предложение удаляет исход, у
// которого есть метки аналитика (✓/✗/? у решений) — они потеряют смысл.
// Метки исхода считаются по ячейкам ruleDelta (before — исход по ДЕЙСТВУЮЩИМ
// правилам): разметки/результатов нет (delta null) — гейт не срабатывает.
// → { hits: [{label, marks}], total } | null.
function destructiveDecisionInfo(proposal) {
  if (proposal.kind !== "propose_decision") return null;
  const current = (state.decision && state.decision.outcomes) || [];
  if (!current.length) return null;
  const p = proposal.payload || {};
  const proposed = new Set((p.outcomes || []).map(o => String(o.label || "").trim()));
  const deleted = current.filter(o => !proposed.has(String(o.label)));
  if (!deleted.length) return null;
  let delta = null;
  try {
    delta = ruleDelta(decisionFromProposal(p, state.questions));
  } catch {
    return null; // битое предложение — дорожка превалидации, не гейта
  }
  if (!delta) return null;
  const hits = [];
  for (const o of deleted) {
    const marks = delta.cells.filter(c => c.before === o.label).length;
    if (marks > 0) hits.push({ label: o.label, marks });
  }
  return hits.length ? { hits, total: hits.reduce((s, h) => s + h.marks, 0) } : null;
}

// Текст цены гейта 2.4 без значка: «удаляется исход «X» — N ваших меток
// исходов потеряют смысл».
function decisionGateCore(g) {
  const names = g.hits.map(h => `«${h.label}»`).join(", ");
  const word = g.hits.length > 1 ? "удаляются исходы" : "удаляется исход";
  return `${word} ${names} — ${g.total} `
    + plural(g.total, "ваша метка", "ваши метки", "ваших меток")
    + " исходов потеряют смысл";
}

// Деструктивная замена контекста (макет 3.4): mode=replace и новый текст
// существенно короче старого. Порог зафиксирован по макету («2 040 → 180
// симв.»): гейт, когда старый текст > 500 символов, а новый < 50% старого —
// замена короткого текста коротким гейтом не считается. Старый размер — из
// текущего контекста или из state.batch.files (файл батча). Файл не найден —
// гейт не срабатывает (это дорожка превалидации/«Не применено»).
// → { oldLen, newLen, file } | null.
function destructiveContextInfo(proposal) {
  if (proposal.kind !== "propose_context") return null;
  const p = proposal.payload || {};
  if (p.mode !== "replace") return null;
  const newLen = String(p.text ?? "").length;
  let oldLen = 0;
  if (p.file) {
    const f = state.batch.files.find(x => x.name === p.file);
    if (!f || f.isImage) return null;
    oldLen = String(f.text || "").length;
  } else {
    try { oldLen = currentContextText().length; } catch { return null; }
  }
  if (oldLen > 500 && newLen < oldLen / 2) {
    return { oldLen, newLen, file: p.file || null };
  }
  return null;
}

// Перезапись существующего пресета (макет 5.4): предложение со slug всегда
// перезаписывает существующий. Списка пресетов в state нет (presets.js
// запрашивает /api/presets по требованию) — имя берём из payload.
// → { slug, name } | null.
function destructivePresetInfo(proposal) {
  if (proposal.kind !== "propose_save_preset") return null;
  const p = proposal.payload || {};
  return p.slug ? { slug: p.slug, name: p.name || p.slug } : null;
}

// Блок цены (.assistant-destruct, макет .destruct): иконка + жирный зачин +
// пояснение; хвост — «принятие только из развёрнутого вида», как у гейта
// вопросов.
function destructBlockEl(headText, bodyText) {
  const d = document.createElement("div");
  d.className = "assistant-destruct";
  const ico = document.createElement("span");
  ico.className = "d-ico";
  ico.textContent = "⚠";
  const tx = document.createElement("span");
  const b = document.createElement("b");
  b.textContent = headText;
  tx.appendChild(b);
  tx.appendChild(document.createTextNode(" " + bodyText
    + " Принятие доступно только из этого развёрнутого вида."));
  d.append(ico, tx);
  return d;
}

// Цена гейта 3.4: «Заменяется почти весь текст. Было 2 040 симв., станет
// 180 — подробности старой редакции исчезнут.»
function contextDestructEl(g) {
  return destructBlockEl(
    (g.file ? `Текст файла будет заменён почти целиком.`
            : `Материал будет заменён почти целиком.`),
    `Было ${fmtNum(g.oldLen)} симв., станет ${fmtNum(g.newLen)} — `
    + `подробности старой редакции исчезнут (сразу после применения их ещё `
    + `можно вернуть кнопкой «Отменить», позже — нет).`);
}

// Цена гейта 5.4: «Перезапишет существующий пресет «X». Старое содержимое
// будет утеряно — откатить перезапись нельзя.»
function presetDestructEl(g) {
  return destructBlockEl(
    `Перезапишет существующий пресет «${g.name}».`,
    `Старое содержимое будет утеряно — откатить перезапись нельзя.`);
}

// Компактный вид pending-карточки: essence + пилла + действия + разворот
// (концепция «Рамс»: строка-последствие, как c-row в макете option-c).
// Разворот по клику — по строке целиком или по «развернуть»; ручной разворот
// запоминается (_manualExpand) и не сбрасывается очередью.
function compactifyProposalCard(card, proposal) {
  if (!card._essenceEl) {
    const ess = document.createElement("div");
    ess.className = "assistant-proposal-essence";
    const num = document.createElement("span");
    num.className = "assistant-proposal-queuenum";
    const txt = document.createElement("span");
    txt.className = "assistant-proposal-essence-text";
    let essText = card._essenceText || proposalEssence(proposal);
    // деструктивное удаление вопросов (макет 1.2/1.4): пометка «удаляется…»
    // переносится из плоского текста в красный span с ценой разметки
    const qg = card._questionsGate;
    if (qg && qg.del > 0) {
      const tail = `⚠ удаляется ${qg.del} из ${qg.total}`;
      if (essText.endsWith(tail)) {
        essText = essText.slice(0, -tail.length).replace(/[,\s]+$/, "");
      }
    }
    txt.textContent = essText;
    if (qg) {
      txt.appendChild(document.createTextNode(essText.endsWith(":") ? " " : " · "));
      const w = document.createElement("span");
      w.className = "ess-warn";
      w.textContent = questionsGateCore(qg);
      txt.appendChild(w);
    }
    // замена длинного текста коротким (макет 3.4): суть — «Контекст: ⚠ замена
    // 2 040 → 180 симв.», плоский хвост с размерами из essence убираем
    const cg = card._contextGate;
    if (cg) {
      txt.textContent = cg.file ? `Контекст файла: ${cg.file}` : "Контекст:";
      txt.appendChild(document.createTextNode(cg.file ? " — " : " "));
      const w = document.createElement("span");
      w.className = "ess-warn";
      w.textContent = `⚠ замена ${fmtNum(cg.oldLen)} → ${fmtNum(cg.newLen)} симв.`;
      txt.appendChild(w);
    }
    // перезапись существующего пресета (макет 5.4): «Пресет: ⚠ перезапишет
    // «Имя» — 5 вопросов + правила»
    const pg = card._presetGate;
    if (pg) {
      const tail = (essText.match(/»\s*(—.*)$/) || [])[1] || "";
      txt.textContent = "Пресет: ";
      const w = document.createElement("span");
      w.className = "ess-warn";
      w.textContent = `⚠ перезапишет «${pg.name}»`;
      txt.appendChild(w);
      if (tail) txt.appendChild(document.createTextNode(" " + tail));
    }
    // деструктивное удаление исхода с метками (макет 2.4): красная пометка
    // в строке-последствии
    if (card._decisionGate) {
      txt.appendChild(document.createTextNode(" · "));
      const w = document.createElement("span");
      w.className = "ess-warn";
      w.textContent = "⚠ " + decisionGateCore(card._decisionGate);
      txt.appendChild(w);
    }
    ess.append(num, txt);
    const title = card.querySelector(".assistant-proposal-title");
    title.after(ess);
    card._essenceEl = ess;
    // «развернуть» — текстовая кнопка в ряду действий
    const exp = document.createElement("span");
    exp.className = "assistant-expander assistant-proposal-expandlink";
    exp.textContent = "развернуть";
    exp.addEventListener("click", (e) => {
      e.stopPropagation();
      card._manualExpand = true;
      expandProposalCard(card);
    });
    const actionsRow = card.querySelector(".assistant-proposal-actions");
    if (actionsRow) actionsRow.appendChild(exp);
    else card.appendChild(exp);
    card._expandLink = exp;
    // клик по самой строке тоже разворачивает (кроме кликов по кнопкам/ссылкам)
    card.addEventListener("click", (e) => {
      if (!card.classList.contains("assistant-proposal-compact")) return;
      const t = e.target;
      if (t && t.closest && (t.closest("button") || t.closest(".assistant-proposal-showin"))) return;
      card._manualExpand = true;
      expandProposalCard(card);
    });
    // «Показать в редакторе» — flash затронутого места в основном UI
    const revealer = proposalRevealTarget(proposal);
    if (revealer) {
      const show = document.createElement("span");
      show.className = "assistant-expander assistant-proposal-showin";
      show.textContent = "показать в редакторе";
      show.addEventListener("click", (e) => { e.stopPropagation(); revealer(); });
      txt.appendChild(document.createTextNode(" · "));
      txt.appendChild(show);
    }
    // зависимость от висящей правки вопросов (инцидент 18.10)
    const dep = document.createElement("div");
    dep.className = "assistant-proposal-dep hidden";
    dep.textContent = "⚠ Зависит от нерешённой правки вопросов выше — сначала решите её";
    ess.after(dep);
    card._depEl = dep;
  }
  card.classList.add("assistant-proposal-compact");
  // пилла статуса переезжает в essence-строку (верхний ряд скрыт)
  if (card._statusEl) card._essenceEl.appendChild(card._statusEl);
  syncPendingEdge(card);
  // деструктивная правка: «Принять» в компактном виде заменяется на разворот
  const accept = card.querySelector(".assistant-accept");
  if (accept && card._destructive) {
    if (!card._destructBtn) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "assistant-accept assistant-destruct-expand";
      b.textContent = "Развернуть и проверить";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        card._manualExpand = true;
        expandProposalCard(card);
      });
      accept.after(b);
      card._destructBtn = b;
    }
    accept.classList.add("hidden");
    card._destructBtn.classList.remove("hidden");
  }
}

function expandProposalCard(card) {
  card.classList.remove("assistant-proposal-compact");
  // пилла статуса обратно в верхний ряд
  const top = card.querySelector(".assistant-proposal-top");
  if (top && card._statusEl) top.appendChild(card._statusEl);
  const accept = card.querySelector(".assistant-accept");
  if (accept && card._destructive) {
    accept.classList.remove("hidden");
    if (card._destructBtn) card._destructBtn.classList.add("hidden");
  }
  syncPendingEdge(card);
}

// Пересчёт очереди: развёрнута старейшая нерешённая (если пользователь её
// сам не сворачивал/разворачивал), остальные — компактные по умолчанию;
// нумерация «i/N» при N≥2; строка зависимости у правил при висящей правке
// вопросов; чип-счётчик в шапке.
function refreshProposalQueue(key = activeConvo) {
  const pend = pendingProposalItems(key);
  const n = pend.length;
  const questionsPending = pend.some(it => it.proposal.kind === "propose_questions");
  pend.forEach((it, i) => {
    const card = proposalCardByItem.get(it);
    if (!card) return;
    if (card.classList.contains("assistant-proposal-invalid")) return;
    // нумерация и в заголовке (развёрнутая), и в essence (компактная)
    for (const num of card.querySelectorAll(".assistant-proposal-queuenum")) {
      num.textContent = n >= 2 ? `${i + 1}/${n}` : "";
    }
    // зависимая pending (макет 2.3): «Принять» заблокирован, пока жива правка
    // вопросов; снятие зависимости разблокирует — поэтому до раннего выхода
    // по ручному развороту. Stale-блокировка дельты (_acceptBlockedStale) —
    // отдельный флаг, разблокировке не подлежит.
    // run←questions (макет 4.5): прогон требует вопросы всегда — зависим,
    // если выше висит нерешённая правка вопросов (по старому набору прогон
    // бессмысленен); «Запустить» disabled до её решения.
    const olderQuestions = pend.slice(0, i)
      .some(x => x.proposal.kind === "propose_questions");
    const isRun = it.proposal.kind === "propose_run";
    const depActive = it.proposal.kind === "propose_decision"
      ? questionsPending : isRun && olderQuestions;
    if (card._depEl) card._depEl.classList.toggle("hidden", !depActive);
    if (it.proposal.kind === "propose_decision" || isRun) {
      const acc = card.querySelector(".assistant-accept");
      if (acc) {
        acc.disabled = depActive || !!card._acceptBlockedStale;
        if (!card._acceptBlockedStale) {
          acc.title = depActive
            ? (isRun
              ? "Сначала решите правку вопросов выше — прогон по старому набору бессмысленен"
              : "Сначала решите правку вопросов выше — правила построены под её набор")
            : "";
        }
      }
    }
    if (card._manualExpand || card._manualCompact) return; // выбор пользователя
    if (i === 0) expandProposalCard(card);
    else compactifyProposalCard(card, it.proposal);
    // depEl рождается в compactify — при первом проходе тумблер выше его не застал
    if (card._depEl) card._depEl.classList.toggle("hidden", !depActive);
  });
  if (key === activeConvo) updatePendingChip();
}

// Чип «N ждут решения» в шапке: клик — скролл и flash к старейшей.
function updatePendingChip() {
  const chip = document.getElementById("assistant-pending");
  if (!chip) return;
  const pend = pendingProposalItems(activeConvo);
  if (!pend.length) {
    chip.classList.add("hidden");
    return;
  }
  chip.classList.remove("hidden");
  chip.textContent = pend.length === 1 ? "⏳ 1 ждёт решения"
    : `⏳ ${pend.length} ждут решения`;
}

function flashEl(el) {
  if (!el) return;
  if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("assistant-flash-target");
  setTimeout(() => el.classList.remove("assistant-flash-target"), 1600);
}

// Цель «показать в редакторе» по виду карточки (flash секции основного UI).
function proposalRevealTarget(proposal) {
  const byId = id => document.getElementById(id);
  if (proposal.kind === "propose_questions") {
    return () => {
      ensureQuestionsVisible();
      flashEl(byId(state.pageMode === "batch" ? "batch-questions-list" : "questions-list"));
    };
  }
  if (proposal.kind === "propose_decision") {
    return () => {
      ensureQuestionsVisible();
      flashEl(byId(state.pageMode === "batch" ? "batch-decision-list" : "decision-list"));
    };
  }
  if (proposal.kind === "propose_context" && !(proposal.payload || {}).file) {
    return () => {
      if (state.pageMode !== "single") setPageMode("single");
      flashEl(byId("context-input") || byId("context-card"));
    };
  }
  return null;
}

// Fingerprint карточки ещё валиден? Двойная проверка: текущий набор ИЛИ
// виртуальный (карточка правил под ещё не принятую правку вопросов).
function proposalFingerprintValid(item) {
  const fpNow = proposalFingerprint(item.proposal);
  if (!fpNow) return true; // run/preset — не протухают
  if (item.fingerprint && item.fingerprint === fpNow) return true;
  if (item.vfingerprint && item.vfingerprint === fpNow) return true;
  return !(item.fingerprint || item.vfingerprint);
}

// Протухание в живой сессии (root fix инцидента 18.10): fingerprint считается
// при создании карточки и перепроверяется при «Принять» и после применения
// любой карточки. Расхождение → «Устарела» + кнопка «попросить перевыпустить».
// Кнопка «Попросить перевыпустить» на устаревшей карточке (живая сессия —
// markProposalStale, восстановленная из persist — restoredProposalCard):
// системная реплика модели с просьбой предложить заново. Warn-ghost —
// единственное действие протухшей карточки (концепция «Рамс»).
function reissueBtnEl(proposal) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "assistant-reissue";
  btn.textContent = "Попросить перевыпустить";
  btn.addEventListener("click", () => {
    btn.disabled = true;
    sendMessage(`Карточка ${proposal.kind} устарела: состояние изменилось с момента предложения. `
      + "Предложи заново под актуальное состояние.", { system: true });
  });
  return btn;
}

// Протухшая карточка: пилла «Устарела» + причина строкой; кнопок выбора нет
// вообще — только warn-ghost «Попросить перевыпустить» и текстовая «Скрыть».
// opts.beacon === false — восстановление из persist (квитанция уже уходила).
function markProposalStale(card, proposal, reason, opts = {}) {
  const status = card._statusEl || card.querySelector(".assistant-proposal-status");
  const actions = card.querySelector(".assistant-proposal-actions");
  card.classList.add("assistant-proposal-stale");
  card.classList.remove("assistant-proposal-compact");
  // пилла возвращается в верхний ряд (в компактной она в essence-строке)
  const top = card.querySelector(".assistant-proposal-top");
  if (top && status && status.parentNode !== top) top.appendChild(status);
  if (status) status.classList.remove("hidden");
  setStatusText(status, "stale", "Устарела");
  if (!card._reasonEl) {
    const r = document.createElement("div");
    r.className = "assistant-proposal-reason";
    const title = card.querySelector(".assistant-proposal-title");
    if (title) title.after(r);
    else card.appendChild(r);
    card._reasonEl = r;
  }
  card._reasonEl.classList.remove("hidden");
  card._reasonEl.textContent = reason
    || "Состояние изменилось с момента предложения — применять её нельзя.";
  if (actions) actions.remove();
  if (card._expandLink) card._expandLink.remove();
  if (card._destructBtn) card._destructBtn.remove();
  if (card._feedItem) { card._feedItem.status = "stale"; persistChat(); }
  // выбыла из очереди — номер больше не показываем
  for (const num of card.querySelectorAll(".assistant-proposal-queuenum")) {
    num.textContent = "";
  }
  if (opts.beacon !== false) {
    receiptBeacon(proposal, "invalid",
                  "stale: состояние изменилось к моменту принятия");
  }
  if (proposal && proposal.kind && !card._staleFoot) {
    const foot = document.createElement("div");
    foot.className = "assistant-proposal-foot";
    foot.appendChild(reissueBtnEl(proposal));
    foot.appendChild(hideCardBtnEl(card, proposal, "Устарела"));
    card.appendChild(foot);
    card._staleFoot = foot;
  }
  syncPendingEdge(card);
}

function revalidatePendingCards(key = activeConvo) {
  for (const it of pendingProposalItems(key)) {
    const card = proposalCardByItem.get(it);
    if (!card || !(it.fingerprint || it.vfingerprint)) continue;
    if (!proposalFingerprintValid(it)) markProposalStale(card, it.proposal);
  }
  refreshProposalQueue(key);
}


function proposalCardEl(proposal, opts = {}) {
  const card = document.createElement("div");
  card.className = "assistant-proposal";
  if (proposal.id) card.dataset.proposalId = proposal.id;
  if (proposal.kind === "propose_run") card.classList.add("assistant-proposal-gate");
  // верхний ряд: eyebrow (вид сущности) · номер в очереди · пилла статуса
  const top = document.createElement("div");
  top.className = "assistant-proposal-top";
  const eye = document.createElement("span");
  eye.className = "assistant-proposal-eye";
  eye.textContent = PROPOSAL_EYE[proposal.kind] || "Предложение";
  const titleNum = document.createElement("span");
  titleNum.className = "assistant-proposal-queuenum";
  const status = statusPillEl("pending", "Ждёт решения");
  top.append(eye, titleNum, status);
  card.appendChild(top);
  card._statusEl = status;
  const title = document.createElement("div");
  title.className = "assistant-proposal-title";
  // propose_run: гипотеза прогона от модели живёт только в payload.title
  // (бэкенд ставит общий «Запуск прогона») — она информативнее заголовка вида
  const payloadTitle = proposal.kind === "propose_run"
    && String((proposal.payload || {}).title || "").trim();
  title.textContent = payloadTitle || proposal.title
    || (proposal.payload || {}).title || proposal.kind;
  card.appendChild(title);
  // суть решения — кэш при создании: после применения proposalEssence считалась
  // бы уже против НОВОГО состояния и врала в терминальной строке
  card._essenceText = proposalEssence(proposal);
  // деструктивная правка вопросов: принятие — solid-красным с ценой в тексте
  // (концепция «Рамс»: единственный красный solid на систему)
  const destr = destructiveQuestionsInfo(proposal);
  // деструктивное удаление исхода с метками (макет 2.4): тот же гейт, что у
  // вопросов — в компактном виде стоп «Развернуть и проверить»
  const destrDecision = destructiveDecisionInfo(proposal);
  // замена длинного текста коротким (макет 3.4) и перезапись пресета (5.4) —
  // тот же паттерн гейта
  const destrCtx = destructiveContextInfo(proposal);
  const destrPreset = destructivePresetInfo(proposal);
  card._destructive = !!(destr || destrDecision || destrCtx || destrPreset);
  card._decisionGate = destrDecision || null;
  card._questionsGate = destr || null;
  card._contextGate = destrCtx || null;
  card._presetGate = destrPreset || null;
  const preview = proposalPreviewEl(proposal);
  card.appendChild(preview);
  if (destrCtx || destrPreset) {
    // блок цены (макет 3.4/5.4, .destruct) — сразу под stats-строкой превью
    const d = destrCtx ? contextDestructEl(destrCtx) : presetDestructEl(destrPreset);
    const statsHead = preview.querySelector(".assistant-proposal-stats");
    if (statsHead && statsHead.parentNode === preview) statsHead.after(d);
    else preview.prepend(d);
  }
  if (destr) {
    // блок цены удаления (макет 1.2/1.4, .destruct) — сразу под stats-строкой
    const d = questionsDestructEl(destr);
    const statsHead = preview.querySelector(".assistant-proposal-stats");
    if (statsHead && statsHead.parentNode === preview) statsHead.after(d);
    else preview.prepend(d);
  }
  if (proposal.kind === "propose_questions") {
    // следствие для правил решения (макет 1.1, .c-conseq) — под телом карточки
    const conseq = decisionConseqEl(proposal.payload || {});
    if (conseq) card.appendChild(conseq);
  }
  if (destrDecision) {
    // блок с ценой в развёрнутом теле карточки (макет .destruct)
    const d = document.createElement("div");
    d.className = "assistant-destruct";
    const ico = document.createElement("span");
    ico.className = "d-ico";
    ico.textContent = "⚠";
    const tx = document.createElement("span");
    tx.textContent = decisionGateCore(destrDecision)
      + ". Проверьте таблицу условий и дельту выше перед принятием.";
    d.append(ico, tx);
    card.appendChild(d);
  }
  // Дельта на размеченных — только для правок правил (мгновенно, без прогона)
  let deltaStale = false;
  if (proposal.kind === "propose_decision") {
    const d = deltaBlockEl(proposal);
    if (d.el) card.appendChild(d.el);
    deltaStale = d.stale;
    // дельта измерена на свежей разметке — суффикс eyebrow (макет 2.1)
    if (d.measured) eye.textContent += " · проверено на разметке";
  }
  const actions = document.createElement("div");
  actions.className = "assistant-proposal-actions";
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "assistant-accept";
  accept.textContent = "Принять";
  if (proposal.kind === "propose_save_preset") accept.textContent = "Сохранить";
  if (destr && destr.del > 0) {
    accept.classList.add("assistant-accept-danger");
    // макет 1.2: единичное удаление с разметкой — «… №2 с разметкой»
    if (destr.del === 1 && destr.marks.total > 0 && destr.dels[0]) {
      accept.textContent = `Принять и удалить ${destr.dels[0].ref} с разметкой`;
    } else {
      accept.textContent = `Принять и удалить ${destr.del} `
        + plural(destr.del, "вопрос", "вопроса", "вопросов");
    }
  } else if (destrDecision) {
    // гейт 2.4: solid-красный с ценой в тексте кнопки
    accept.classList.add("assistant-accept-danger");
    const names = destrDecision.hits.map(h => `«${h.label}»`).join(", ");
    accept.textContent = `Принять и удалить ${names} (${destrDecision.total} `
      + plural(destrDecision.total, "метка", "метки", "меток") + ")";
  } else if (destrCtx) {
    // гейт 3.4: замена длинного текста коротким — solid-красный
    accept.classList.add("assistant-accept-danger");
    accept.textContent = destrCtx.file ? "Заменить текст файла" : "Заменить текст";
  } else if (destrPreset) {
    // гейт 5.4: перезапись существующего пресета — solid-красный
    accept.classList.add("assistant-accept-danger");
    accept.textContent = "Перезаписать пресет";
  }
  if (deltaStale) {
    // флаг — для очереди pending: снятие зависимости от правки вопросов
    // (макет 2.3) не должно разблокировать stale-блокировку дельты
    card._acceptBlockedStale = true;
    accept.disabled = true;
    accept.title = "Разметка от старой редакции — сначала перепрогоните, дельта будет посчитана на свежих данных";
  }
  const decline = document.createElement("button");
  decline.type = "button";
  decline.className = "assistant-decline";
  decline.textContent = "Отклонить";
  // гейт прогона (макет 4.1): «Запустить»/«Не сейчас» вместо общих
  // «Принять»/«Отклонить» — и в развёрнутом, и в компактном виде (4.4/4.5)
  if (proposal.kind === "propose_run") {
    accept.textContent = "Запустить";
    decline.textContent = "Не сейчас";
  }
  actions.append(accept, decline);
  if (proposal.kind === "propose_questions" || proposal.kind === "propose_context") {
    // «показать в редакторе» в подвале развёрнутой карточки (макет 1.1/1.4,
    // 3.1, link-quiet) — то же действие, что у ссылки в компактной essence
    const revealer = proposalRevealTarget(proposal);
    if (revealer) {
      const spacer = document.createElement("span");
      spacer.className = "assistant-spacer";
      const show = document.createElement("button");
      show.type = "button";
      show.className = "assistant-link assistant-link-quiet assistant-showin-foot";
      show.textContent = "показать в редакторе";
      show.addEventListener("click", (e) => { e.stopPropagation(); revealer(); });
      actions.append(spacer, show);
    }
  }
  if (proposal.kind === "propose_save_preset") {
    // третье действие подвала (макет 5.1, link-quiet): отклонить карточку и
    // подставить заготовку в поле ввода — НЕ отправляя
    const spacer = document.createElement("span");
    spacer.className = "assistant-spacer";
    const alt = document.createElement("button");
    alt.type = "button";
    alt.className = "assistant-link assistant-link-quiet assistant-alt-name";
    alt.textContent = "другое имя…";
    alt.title = "Отклонить и сохранить под другим именем — текст подставится в поле ввода";
    alt.addEventListener("click", () => {
      const ta = inputEl();
      if (ta) {
        ta.value = "Сохрани пресет под другим именем: ";
        autogrowInput();
        updateSendButton();
        ta.focus();
      }
      decline.click(); // та же дорожка «Отклонить»: карточка → «Отклонена»
    });
    actions.append(spacer, alt);
  }
  if (proposal.kind === "propose_decision") {
    // третье действие подвала (макет 2.1, link-quiet): отклонить карточку и
    // подставить заготовку в поле ввода — НЕ отправляя (пользователь
    // редактирует порог и шлёт сам)
    const spacer = document.createElement("span");
    spacer.className = "assistant-spacer";
    const alt = document.createElement("button");
    alt.type = "button";
    alt.className = "assistant-link assistant-link-quiet assistant-alt-threshold";
    alt.textContent = "другой порог…";
    alt.title = "Отклонить и попросить другой порог — текст подставится в поле ввода";
    alt.addEventListener("click", () => {
      const ta = inputEl();
      if (ta) {
        ta.value = "Предложи другой порог для правил решения: ";
        autogrowInput();
        updateSendButton();
        ta.focus();
      }
      decline.click(); // та же дорожка «Отклонить»: карточка → «Отклонена»
    });
    actions.append(spacer, alt);
  }
  card.appendChild(actions);
  syncPendingEdge(card);
  // при восстановлении из persist превалидация не повторяется (была при
  // первом показе) — иначе дубли биконов invalid в журнале
  if (!opts.restored) prevalidateProposal(proposal, card, status); // async, fail-open

  decline.addEventListener("click", () => {
    setStatusText(status, "declined", "Отклонена");
    actions.remove();
    collapseProposalCard(card, proposal, "Отклонена");
    receiptBeacon(proposal, "declined");
    if (card._feedItem) { card._feedItem.status = "declined"; persistChat(); }
    refreshProposalQueue();
  });
  accept.addEventListener("click", async () => {
    // Идемпотентность применения (A4): повторный клик/вход — no-op, вторая
    // квитанция не уходит (на бэке её и поглотил бы event_id).
    if (card._applied) return;
    // Протухание в живой сессии (v1.1, инцидент 18.10): состояние могло
    // измениться после выпуска карточки — сверяем fingerprint до применения.
    if (card._feedItem && !proposalFingerprintValid(card._feedItem)) {
      markProposalStale(card, proposal);
      refreshProposalQueue();
      return;
    }
    accept.disabled = true;
    decline.disabled = true;
    card._applied = true;  // до await: повторный вход (двойной клик) — no-op
    let undo = null;
    try {
      undo = captureUndo(proposal);
      await applyProposal(proposal, card._feedItem);
    } catch (e) {
      setStatusText(status, "invalid", "Не применено");
      showProposalError(card, e);
      actions.remove();
      syncPendingEdge(card);
      return;
    }
    setStatusText(status, "applied", "Применена");
    actions.remove();
    receiptBeacon(proposal, "applied");
    if (card._feedItem) { card._feedItem.status = "applied"; persistChat(); }
    // терминальная строка прогона (макет 4.7): «Применена · Запущено: …» —
    // essence вида «Запуск: …» меняем на факт запуска. Ссылку «разбор» сюда
    // не дублируем: прогон только стартовал, разбор осмыслен после финала —
    // он живёт на системной строке run-done (notifyRunFinished).
    if (proposal.kind === "propose_run" && card._essenceText) {
      card._essenceText = card._essenceText.replace(/^Запуск:/, "Запущено:");
    }
    // применение изменило состояние — перевалидируем остальные висящие
    // карточки (могли протухнуть) и разворачиваем следующую в очереди
    revalidatePendingCards();
    if (!undo) {
      collapseProposalCard(card, proposal, "Применена");
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "assistant-undo";
    btn.textContent = "Отменить";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      try {
        undo();
        setStatusText(status, "undone", "Отменено");
        btn.remove();
        if (card._collapseCtx) card._collapseCtx.undoBtn = null;
        collapseProposalCard(card, proposal, "Отменено");
        receiptBeacon(proposal, "undone");
        if (card._feedItem) { card._feedItem.status = "undone"; persistChat(); }
        revalidatePendingCards(); // откат вернул состояние — перепроверить висящие
      } catch (e2) {
        showProposalError(card, e2);
      }
    });
    collapseProposalCard(card, proposal, "Применена", btn);
  });
  return card;
}

// Снимок состояния для undo (где undo имеет смысл). Возвращает функцию
// отката или null (propose_run / propose_save_preset неотменяемы).
export function captureUndo(proposal) {
  if (proposal.kind === "propose_questions") {
    const prev = JSON.parse(JSON.stringify(state.questions));
    return () => {
      state.questions = JSON.parse(JSON.stringify(prev));
      renderQuestions();
    };
  }
  if (proposal.kind === "propose_context") {
    const file = (proposal.payload || {}).file;
    if (file) {
      const f = state.batch.files.find(x => x.name === file);
      if (!f || f.isImage) return null;  // применение упадёт с понятной ошибкой
      const prevText = f.text;
      const prevSize = f.size;
      return () => {
        f.text = prevText;
        f.size = prevSize;
        rerenderBatchList();
      };
    }
    let prevText = "";
    let prevMode = "text";
    try {
      const snap = contextSnapshot();
      prevText = typeof snap.input === "string" ? snap.input : JSON.stringify(snap.input, null, 2);
      prevMode = snap.input_format === "json" ? "json" : "text";
    } catch { /* пустой контекст */ }
    return () => setContent(prevText, prevMode);
  }
  if (proposal.kind === "propose_decision") {
    const prev = state.decision ? JSON.parse(JSON.stringify(state.decision)) : null;
    return () => setDecision(prev);
  }
  return null;
}

// Предложение НЕ применяется автоматически: карточка с «Принять»/«Отклонить»
// добавляется в ленту чата и ждёт пользователя.
export async function handleProposal(proposal, key = activeConvo) {
  if (proposal.kind === "propose_questions") {
    const p = proposal.payload || {};
    turnVirtualQuestions = p.mode === "append"
      ? state.questions.concat(p.questions || [])
      : (p.questions || []);
  }
  const card = proposalCardEl(proposal);
  card._feedItem = { t: "proposal", proposal, status: "pending",
                     fingerprint: proposalFingerprint(proposal) };
  // Правила, построенные под виртуальный набор хода (ещё не принятая карточка
  // вопросов), хранят и виртуальный fingerprint: после принятия правки
  // вопросов карточка остаётся валидной (инцидент 18.10 — иначе протухала бы).
  if (proposal.kind === "propose_decision" && turnVirtualQuestions) {
    card._feedItem.vfingerprint = proposalFingerprint(proposal, turnVirtualQuestions);
  }
  pushFeed(key, card._feedItem);
  proposalCardByItem.set(card._feedItem, card);
  // скролл к началу карточки, а не к низу ленты (v1.1) — и только если
  // пользователь у нижней кромки; проверку делаем ДО appendMsg (он сам
  // доскролливает вниз)
  const m = messagesEl();
  const atBottom = key === activeConvo && m && typeof m.scrollTop === "number"
    && m.scrollTop + m.clientHeight >= m.scrollHeight - 40;
  appendMsg(card, key);
  refreshProposalQueue(key);
  if (atBottom && typeof card.scrollIntoView === "function") {
    card.scrollIntoView({ block: "start" });
  }
  return card;
}

// ---------------------------------------------------------------- применение (только клиент)

// payload модели → формат normalizeQuestion: description_yes/no → yes/no,
// options-строки → {name, description}.
function convertProposalQuestion(q) {
  const out = { ...q };
  if (out.description_yes != null && out.yes == null) out.yes = out.description_yes;
  if (out.description_no != null && out.no == null) out.no = out.description_no;
  delete out.description_yes;
  delete out.description_no;
  if (Array.isArray(out.options)) {
    out.options = out.options.map(o => typeof o === "string" ? { name: o, description: "" } : o);
  }
  return out;
}

// Редактор вопросов живёт на страницах single/batch; с models/presets
// переключаемся на single, чтобы результат применения был виден.
function ensureQuestionsVisible() {
  if (state.pageMode === "models" || state.pageMode === "presets") setPageMode("single");
}

// append — поэлементно, с журналом прогресса в feedItem (persist после КАЖДОЙ
// операции + синхронный сброс воркспейса): kill вкладки посередине ловится
// при восстановлении — карточка «Прервано · применены k из n» (макет 1.10).
// replace (в т.ч. развёрнутые бэком edits) — атомарная замена набора,
// частичного применения у него нет, «Прервано» для него не возникает.
async function applyQuestionsProposal(payload, feedItem) {
  const converted = (payload.questions || []).map(convertProposalQuestion);
  if (!converted.length) throw new Error("В предложении нет вопросов.");
  if (payload.mode === "append") {
    const from = (feedItem && feedItem.applyProgress
                  && feedItem.applyProgress.done) || 0;
    for (let i = from; i < converted.length; i += 1) {
      state.questions.push(normalizeQuestion(converted[i]));
      if (feedItem) {
        feedItem.applyProgress = { done: i + 1, total: converted.length };
        persistChat();  // журнал применения — после каждой операции
      }
      saveNow();  // воркспейс — синхронно: дебаунс kill вкладки не переживёт
      if (i + 1 < converted.length) {
        // окно прерывания между операциями (макрозадача) — без него
        // синхронный цикл kill'ом вкладки не поймать в persist
        await new Promise(r => setTimeout(r, 0));
      }
    }
    if (feedItem) delete feedItem.applyProgress;
    renderQuestions();
  } else {
    setQuestions(converted);
  }
  ensureQuestionsVisible();
}

function rerenderBatchList() {
  if (document.getElementById("batch-list")) renderBatchList();
}

function applyContextProposal(payload) {
  const text = String(payload.text ?? "");
  if (payload.file) {
    const f = state.batch.files.find(x => x.name === payload.file);
    if (!f) throw new Error(`Файл «${payload.file}» не найден в пакете.`);
    if (f.isImage) throw new Error(`У файла-картинки «${payload.file}» нет текста.`);
    f.text = payload.mode === "append" && f.text ? f.text + "\n\n" + text : text;
    f.size = f.text.length;
    rerenderBatchList();
    if (state.pageMode !== "batch") setPageMode("batch");
    return;
  }
  if (payload.mode === "append") {
    let current = "";
    try {
      const snap = contextSnapshot();
      current = typeof snap.input === "string" ? snap.input : JSON.stringify(snap.input, null, 2);
    } catch { current = ""; }
    setContent(current ? current + "\n\n" + text : text,
      state.inputMode === "json" ? "json" : "text");
  } else {
    setContent(text, "text");
  }
  if (state.pageMode !== "single") setPageMode("single");
}

function applyRunProposal(payload) {
  const scope = payload.scope === "batch" ? "batch" : "single";
  if (state.pageMode !== scope) setPageMode(scope);
  const runBtn = document.getElementById("tb-run");
  if (!runBtn || runBtn.disabled) {
    throw new Error("Запуск недоступен (нет материала/моделей).");
  }
  runBtn.click();
}

async function applyPresetProposal(payload) {
  let name = String(payload.name || "").trim();
  if (payload.slug) {
    // Обновление существующего: createPreset перезаписывает по совпадению
    // имени, поэтому предзаполняем диалог именем пресета с этим slug.
    const presets = await getPresets();
    const existing = presets.find(p => p.slug === payload.slug);
    if (!existing) throw new Error(`Пресет со slug «${payload.slug}» не найден.`);
    name = existing.name;
  }
  if (!name) throw new Error("В предложении нет имени пресета.");
  openSaveDialog(undefined, { name, description: String(payload.description || "") });
}

// Условия propose_decision → внутренний формат + валидация — в delta.js
// (тот же конвертер питает движок дельты до применения).
function applyDecisionProposal(payload) {
  setDecision(decisionFromProposal(payload, state.questions));
  ensureQuestionsVisible();
}

export async function applyProposal(proposal, feedItem = null) {
  const payload = proposal.payload || {};
  // feedItem — для журнала прогресса apply (append вопросов, макет 1.10)
  if (proposal.kind === "propose_questions") return applyQuestionsProposal(payload, feedItem);
  if (proposal.kind === "propose_context") return applyContextProposal(payload);
  if (proposal.kind === "propose_run") return applyRunProposal(payload);
  if (proposal.kind === "propose_save_preset") return applyPresetProposal(payload);
  if (proposal.kind === "propose_decision") return applyDecisionProposal(payload);
  throw new Error("Неизвестный тип предложения: " + proposal.kind);
}

// ---------------------------------------------------------------- ввод

function autogrowInput() {
  const ta = inputEl();
  if (!ta) return;
  ta.style.height = "auto";
  if (typeof ta.scrollHeight === "number") {
    ta.style.height = Math.min(ta.scrollHeight, INPUT_MAX_HEIGHT) + "px";
  }
}

function submitInput() {
  const ta = inputEl();
  if (!ta) return;
  const text = ta.value;
  ta.value = "";
  autogrowInput();
  sendMessage(text);
  updateSendButton();
}

// ---------------------------------------------------------------- init

export function initAssistant() {
  convos.single = { history: [], nodes: null, openTools: [], feed: [] };
  convos.batch = { history: [], nodes: null, openTools: [], feed: [] };
  activeConvo = convoKeyForPage(state.pageMode);
  introHtml = (introEl() || {}).innerHTML || "";
  chatModels = [];
  selectedModel = null;
  streaming = false;
  activeController = null;
  unread = false;
  turnVirtualQuestions = null;
  restoreChat();  // лента и история из persist (v0.8)
  wireStorageListener();  // мультитаб (A4): чужие правки воркспейса → флаг

  document.getElementById("tb-assistant").addEventListener("click", () => togglePanel());
  document.getElementById("assistant-close").addEventListener("click", () => closePanel());
  document.getElementById("assistant-reset").addEventListener("click", () => resetHistory());
  document.getElementById("assistant-pending").addEventListener("click", () => {
    const first = pendingProposalItems(activeConvo)[0];
    const card = first && proposalCardByItem.get(first);
    if (card) flashEl(card);
  });
  document.getElementById("assistant-model").addEventListener("change", (e) => {
    selectedModel = e.target.value;
    setChatModel(selectedModel);  // общий выбор с диалогами «✨ Сгенерировать»
  });

  const ta = inputEl();
  const btn = sendEl();
  if (ta) {
    ta.addEventListener("input", () => { autogrowInput(); updateSendButton(); });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!streaming) submitInput();
      }
    });
  }
  if (btn) {
    btn.addEventListener("click", () => {
      if (streaming) stopRequest();
      else submitInput();
    });
  }
  updateSendButton();
  initResize();
  updateModeChip();
  renderChips();
  // свежие статусы моделей от поллинга toolbar — обновляем пометки «не запущена»;
  // чип контекста и quick-chips — при смене состояния (результаты, разметка, страница)
  subscribe((event) => {
    if (event === "models") renderModelOptions();
    if (event === "runFinished") notifyRunFinished();
    if (["models", "results", "review", "pagemode", "questions", "decision",
         "context", "batch"].includes(event)) {
      updateModeChip();
      renderChips();
    }
  });
  loadModels();
}

// Чип активного режима в шапке панели + переключение разговора: у «Одиночного»
// и «Батча» свои история и лента (страницы «Модели»/«Пресеты» относятся к
// одиночному разговору). Ассистент действует на активной странице, пока
// пользователь явно не попросил про другую.
// Чип — page-awareness на виду (v0.7): что ассистент видит (страница, файлы,
// модели, метки) и точка свежести результатов (зелёная/янтарная).
export function updateModeChip() {
  switchConversation(convoKeyForPage(state.pageMode));
  const chip = document.getElementById("assistant-mode");
  if (!chip) return;
  const batch = state.pageMode === "batch";
  const single = state.pageMode === "single";
  if (!batch && !single) {
    chip.classList.add("hidden");
    return;
  }
  const parts = [batch ? "Пакет" : "Один материал"];
  if (batch && state.batch.files.length) parts.push(`${state.batch.files.length} файлов`);
  const stale = batch ? state.batch.resultsStale : state.resultsStale;
  const hasResults = batch ? Object.keys(state.batch.results || {}).length > 0
    : !!(state.results && state.results.results);
  // Счётчик моделей — из состава прогона, когда результаты есть (галочки бара
  // после прогона могли поменяться); без прогона — выбранные галочки.
  let modelsCount = 0;
  if (hasResults) {
    const keys = new Set();
    if (batch) {
      for (const per of Object.values(state.batch.results || {})) {
        for (const mk of Object.keys(per || {})) keys.add(mk);
      }
    } else {
      for (const mk of Object.keys(state.results.results || {})) keys.add(mk);
    }
    modelsCount = keys.size;
  } else if (state.selectedModels && state.selectedModels.size) {
    modelsCount = state.selectedModels.size;
  }
  if (modelsCount) parts.push(`${modelsCount} мод.`);
  const marksCount = batch ? (state.batch.marks || []).length
    : ((state.results && state.results.marks) || []).length;
  if (marksCount) parts.push(`${marksCount} меток`);
  chip.textContent = "";
  if (hasResults) {
    const dot = document.createElement("span");
    dot.className = "assistant-mode-dot " + (stale ? "stale" : "fresh");
    chip.appendChild(dot);
  }
  chip.appendChild(document.createTextNode(parts.join(" · ")));
  chip.title = "Что ассистент видит сейчас" +
    (hasResults ? (stale ? " — результаты старше текущих вопросов/правил"
                         : " — результаты свежие") : " — прогонов ещё нет");
  chip.classList.remove("hidden");
}

// ---------------------------------------------------------------- quick-chips

// Контекстные кликабельные подсказки над полем ввода (v0.7): только наборы на
// существующие инструменты (чип не обещает карточку, которой нет в релизе).
// Клик — отправляет готовый запрос. Три контекстных набора (v1.1, макет 11 —
// формулировки зафиксированы в дизайн-доке): пустой проект / есть результаты
// без разметки / есть разметка. Чип — {label, text}: label может нести счётчик
// («Что разметить (N)» — countReviewQueueCandidates, analysis.js), в запрос
// уходит чистый text.
function chipsForState() {
  const batch = state.pageMode === "batch";
  const hasContent = batch ? state.batch.files.length > 0
    : !!(currentContextText().trim() || state.contextImages.length);
  const hasResults = batch ? Object.keys(state.batch.results || {}).length > 0
    : !!(state.results && state.results.results);
  if (!hasContent && !hasResults) {
    return [
      { label: "Сгенерируй вопросы по материалу",
        text: "Сгенерируй вопросы по материалу" },
      { label: "Помоги с правилами решения", text: "Помоги с правилами решения" },
      { label: "Что умеешь?", text: "Что умеешь?" },
    ];
  }
  if (!hasResults) {
    // материал есть, прогона ещё нет — стартовый набор
    return [
      { label: "Предложи вопросы по материалу",
        text: "Предложи вопросы по материалу" },
      { label: "Помоги с правилами решения", text: "Помоги с правилами решения" },
    ];
  }
  const marks = batch ? (state.batch.marks || []).length
    : ((state.results && state.results.marks) || []).length;
  let n = 0;
  try { n = countReviewQueueCandidates(); } catch { n = 0; }
  if (!marks) {
    return [
      { label: `Что разметить (${n})`,
        text: "Что разметить дальше? Покажи очередь самых информативных ячеек." },
      { label: "Сравни модели", text: "Сравни модели между собой" },
    ];
  }
  return [
    { label: "🔍 Разобрать прогон",
      text: "Разбери последний прогон: найди проблемы и расхождения моделей." },
    { label: `Что разметить дальше (${n})`,
      text: "Что разметить дальше? Покажи очередь самых информативных ячеек." },
    { label: "Сравнить модели", text: "Сравни модели между собой" },
    { label: "Подобрать пороги",
      text: "Предложи правку порогов по результатам и моей разметке." },
  ];
}

export function renderChips() {
  const box = document.getElementById("assistant-chips");
  if (!box) return;
  box.textContent = "";
  for (const chip of chipsForState()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "assistant-chip";
    b.textContent = chip.label;
    b.addEventListener("click", () => sendMessage(chip.text));
    box.appendChild(b);
  }
}
