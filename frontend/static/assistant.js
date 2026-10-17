// AI-ассистент: правая выдвижная панель с собственным чат-UI (обычный DOM,
// без shadow DOM и сторонних чат-компонентов). Ответы ассистента рендерятся
// markdown'ом (вендоренный remarkable, vendor/remarkable.js). Наш SSE
// /api/assistant/chat: token → стриминг в пузырь ответа, thinking →
// сворачиваемый details-блок, tool → служебная строка в ленте, trial/proposal
// → карточки в ленте, error → красная строка, done → конец.
// Кнопка отправки превращается в СТОП на всё время запроса (включая фазы
// инструментов и thinking): клик → AbortController, частичный ответ остаётся,
// в ленте строка «остановлено пользователем». Proposal-события НЕ применяются
// автоматически: карточка в ленте ждёт «Принять»/«Отклонить»; после «Принять» —
// статус «Применено ✓» и кнопка «Отменить» (undo по снимку прежнего состояния;
// для run/preset undo нет).
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
import { decisionFromProposal, ruleDelta } from "./delta.js";
import { hashString } from "./fingerprint.js";
import { setContent, contextSnapshot } from "./context.js";
import { openSaveDialog } from "./presets.js";
import { getPresets, validateProposal, assistantEvent } from "./api.js";
import { renderBatchList } from "./batch.js";
import { shortAnswer, modelShortLabel, answerConfidence, MODE_LABELS } from "./results.js";
import * as reviewMod from "./review.js";

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
    const el = addNote(`🔧 ${toolLabel(name)}…`, key);
    openTools.push({ el, name });
    return;
  }
  const open = openTools.pop();
  if (!open) return;
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
  c.openTools.length = 0;
  c.feed = [];
  const m = messagesEl();
  if (m) {
    for (const ch of [...m.children]) {
      if (!ch.classList.contains("assistant-intro")) ch.remove();
    }
  }
  showIntro();
  persistChat();
}

// ---------------------------------------------------------------- persist (v0.8)

// Лента и история разговоров переживают перезагрузку: localStorage
// dq-assistant-chat, {version, convos: {single, batch: {history, feed}}}.
// Записи feed: {t:"user"|"assistant", text, system?}, {t:"proposal", proposal,
// status, invalidReason?, fingerprint?}, {t:"trial", trial, collapsed?}.
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
// карточек при восстановлении): правки вопросов/правил — хеш от вопросов и
// решения; правки контекста — от текста контекста/файла; run/save_preset
// не протухают (null).
function proposalFingerprint(proposal) {
  const p = (proposal && proposal.payload) || {};
  if (proposal.kind === "propose_questions" || proposal.kind === "propose_decision") {
    const d = state.decision
      ? JSON.parse(JSON.stringify(state.decision),
                   (k, v) => (k === "collapsed" ? undefined : v))
      : null;
    return hashString(JSON.stringify({
      q: state.questions.map(q => ({
        id: q.id, question: q.question, type: q.type, yes: q.yes, no: q.no,
        options: (q.options || []).map(o => ({ name: o.name, description: o.description })),
        levels: q.levels, direction: q.direction,
      })),
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
  if (item.t === "trial" && item.trial) {
    const card = trialCardEl(item.trial);
    card._feedItem = item;
    if (item.collapsed) collapseTrialCard(card);
    return card;
  }
  return null;
}

// Карточка предложения из persist: pending — активной (с проверкой протухания
// по fingerprint, превалидация не повторяется — была при первом показе);
// терминальные — строкой-итогом (undo после перезагрузки не предлагаем:
// captureUndo снял бы состояние уже ПОСЛЕ применения).
const RESTORED_STATUS_TEXT = { applied: "✓ Применено", declined: "Отклонено",
                               undone: "Отменено", invalid: "Невалидно" };

function restoredProposalCard(item) {
  const proposal = item.proposal || {};
  const card = proposalCardEl(proposal, { restored: true });
  card._feedItem = item;
  const status = card.querySelector(".assistant-proposal-status");
  const accept = card.querySelector(".assistant-accept");
  const actions = card.querySelector(".assistant-proposal-actions");
  if (item.status === "pending") {
    const fp = proposalFingerprint(proposal);
    if (item.fingerprint && fp && item.fingerprint !== fp) {
      card.classList.add("assistant-proposal-stale");
      status.textContent = "Устарела: состояние изменилось с момента предложения";
      status.className = "assistant-proposal-status declined";
      if (accept) {
        accept.disabled = true;
        accept.title = "Вопросы/правила изменились — попросите ассистента предложить заново";
      }
    }
    return card;
  }
  if (item.status === "invalid") {
    markProposalInvalid(card, status,
                        item.invalidReason || "payload невалиден", proposal);
  } else {
    status.textContent = RESTORED_STATUS_TEXT[item.status] || "Завершено";
    status.className = "assistant-proposal-status "
      + (item.status === "applied" ? "applied" : "declined");
    if (actions) actions.remove();
  }
  collapseProposalCard(card, proposal,
                       RESTORED_STATUS_TEXT[item.status] || "Завершено");
  return card;
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

// Текущие правила решения для снапшота: ссылки на вопросы — по n (как в
// схеме propose_decision), threshold — в процентах 0–100.
function decisionSnapshot() {
  const d = state.decision;
  if (!d || !(d.outcomes || []).length) return null;
  const qnum = {};
  state.questions.forEach((q, i) => { qnum[q.id] = i + 1; });
  return {
    outcomes: d.outcomes.map(o => ({
      label: o.label,
      isDefault: o.isDefault || undefined,
      rules: (o.rules || []).map(r => ({
        anyOf: r.anyOf || undefined,
        conditions: (r.conditions || []).map(c => {
          const out = { question: qnum[c.question] || c.question, op: c.op };
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
    const out = { num: idx + 1, name: f.name, size: f.size ?? null, imagesCount };
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
  const totals = { accept: 0, reject: 0, unsure: 0, comments: 0 };
  let resolved = false;
  const push = (m, text) => {
    resolved = true;
    items.push({ prio: markPriority(m), text });
    if (m.verdict) totals[m.verdict] += 1;
    if (m.comment) totals.comments += 1;
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
        push(m, `решение × ${model}${msuffix(t)}: ${icon(m)}${comment(m)}`);
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
        push(m, `вопрос №${n} «${qs[n - 1].question}» × ${model}${msuffix(t)}: ${icon(m)}${comment(m)}${dist}`);
      } else if (t.question) {
        const n = qnum[t.question];
        if (!n) continue;
        push(m, `вопрос №${n} «${qs[n - 1].question}» (вопрос целиком): ${icon(m)}${comment(m)}`);
      } else if (t.model) {
        if (!models.has(t.model)) continue;
        push(m, `прогон ${model}${msuffix(t)}: ${icon(m)}${comment(m)}`);
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
        push(m, `файл №${f.n} (${f.name}) × решение × ${model}: ${icon(m)}${comment(m)}`);
      } else if (t.question) {
        const n = qnum[t.question];
        if (!f || !n || !models.has(t.model)) continue;
        let dist = "";
        if (m.verdict === "reject" || m.verdict === "unsure") {
          const ans = (answersOf((state.batch.results || {})[t.file]?.[t.model]) || {})[t.question];
          const d = distText(ans);
          if (d) dist = ` · распределение: ${d}`;
        }
        push(m, `файл №${f.n} (${f.name}) × вопрос №${n} × ${model}: ${icon(m)}${comment(m)}${dist}`);
      } else if (t.file) {
        if (!f) continue;
        push(m, `файл №${f.n} (${f.name}) целиком: ${icon(m)}${comment(m)}`);
      } else if (t.model) {
        if (!models.has(t.model)) continue;
        push(m, `модель ${model} по пакету: ${icon(m)}${comment(m)}`);
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
      // id — служебный (сопоставление разметки и what-if прогонов), в текстах
      // и ответах модель ссылается по n (номер карточки в UI)
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

  const controller = new AbortController();
  activeController = controller;

  const showThinking = () => {
    if (!thinkingText || thinkingShown) return;
    thinkingShown = true;
    appendMsg(thinkingEl(thinkingText), convoKey);
  };

  let reader = null;
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
              showToolEvent(ev.name, ev.status, ev.message, convoKey, ev.internal);  // строка в ленте, обновится по done
            } else if (ev.type === "trial") {
              shownCards.push(`показан результат пробного прогона${ev.trial && ev.trial.title
                ? ` «${ev.trial.title}»` : ""}`);
              handleTrial(ev.trial, convoKey);  // карточка-таблица в ленте, UI не мутируется
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
  if (aborted) addNote("остановлено пользователем", convoKey);
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

// Правила решения из аргументов run_trial (вопросы по № в списке вопросов
// прогона, пороги в %) → формат движка evaluateDecision (id вопроса, 0..1).
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
          const q = qs[Math.round(Number(c.question)) - 1];
          const cond = { question: q ? q.id : String(c.question),
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

// Карточка «Пробный прогон» (событие trial от run_trial): саммари — гипотеза
// (title), что изменено (changes), исходы по моделям; полная таблица
// модель × вопрос — за «Подробнее ▸» с кнопкой ⛶ (на весь экран). Для
// совпадающих пар вопрос×модель из прогона пользователя — маркеры отличий
// (↑/↓ уверенность, ≠ ответ изменился) и подсветка ячеек.
// Только показ — состояние приложения не меняется.
function trialCardEl(trial) {
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
  det.className = "assistant-trial-details";
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
  card.dataset.collapsible = "1";
  const body = [...card.children].filter(c => c !== title);
  const apply = (collapsed) => {
    for (const c of body) c.classList.toggle("hidden", collapsed);
    title.classList.toggle("assistant-expander", collapsed);
  };
  title.addEventListener("click", () => {
    apply(!title.classList.contains("assistant-expander"));
  });
  title.title = "Развернуть";
  apply(true);
}

export function handleTrial(trial, key = activeConvo) {
  if (!trial) return null;
  const card = trialCardEl(trial);
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

// ---------------------------------------------------------------- proposal-карточки

function detailsEl(summaryText, lines) {
  const det = document.createElement("details");
  const sum = document.createElement("summary");
  sum.textContent = summaryText;
  det.appendChild(sum);
  const body = document.createElement("div");
  body.className = "assistant-details-body";
  body.textContent = lines.join("\n");
  det.appendChild(body);
  return det;
}

// lines: [{cls?: "diff-add"|"diff-del"|"diff-chg", text, full?}] —
// full (если есть) уходит в hover-подсказку строки с полными формулировками.
function addPreviewLines(box, lines) {
  for (const l of lines) {
    const div = document.createElement("div");
    if (l.cls) div.className = l.cls;
    div.textContent = l.text;
    if (l.full) {
      div.title = l.full;
      div.classList.add("has-full");
    }
    box.appendChild(div);
  }
}

function fmtQuestionBrief(q) {
  return `[${TYPE_LABELS[q.type] || q.type}] ${q.question || "(без текста)"}`;
}

function fmtFieldVal(v) {
  return truncate(String(v ?? "—"), 40);
}

// Изменённые поля вопроса (replace-предложение сопоставляем позиционно);
// поля, которых нет в предложении, считаем нетронутыми. text — сокращённая
// строка для списка, full — полные формулировки (hover по строке).
function questionFieldChanges(oldQ, newQ) {
  const out = [];
  const cmp = (label, a, b) => {
    if (b == null) return;
    if (String(a ?? "") !== String(b)) {
      out.push({
        text: `${label}: ${fmtFieldVal(a)} → ${fmtFieldVal(b)}`,
        full: `${label}:\n— было: ${a ?? "—"}\n+ станет: ${b}`,
      });
    }
  };
  cmp("текст", oldQ.question, newQ.question);
  if (newQ.type && newQ.type !== oldQ.type) {
    out.push({
      text: `тип: ${TYPE_LABELS[oldQ.type] || oldQ.type} → ${TYPE_LABELS[newQ.type]}`,
      full: `тип: ${TYPE_LABELS[oldQ.type] || oldQ.type} → ${TYPE_LABELS[newQ.type]}`,
    });
  }
  cmp("«да»", oldQ.yes, newQ.yes);
  cmp("«нет»", oldQ.no, newQ.no);
  if (newQ.options != null) {
    const a = (oldQ.options || []).map(o => o.name).join(", ");
    const b = newQ.options.map(o => o.name).join(", ");
    if (a !== b) {
      out.push({ text: `опции: ${fmtFieldVal(a)} → ${fmtFieldVal(b)}`,
                 full: `опции:\n— было: ${a || "—"}\n+ станет: ${b}` });
    }
  }
  if (newQ.levels != null) {
    const a = (oldQ.levels || []).join(", ");
    const b = newQ.levels.join(", ");
    if (a !== b) {
      out.push({ text: `уровни: ${fmtFieldVal(a)} → ${fmtFieldVal(b)}`,
                 full: `уровни:\n— было: ${a || "—"}\n+ станет: ${b}` });
    }
  }
  cmp("direction", oldQ.direction, newQ.direction);
  return out;
}

// Единая нормализация текста вопроса — для превью-diff и дубль-проверки
// (иначе «Есть товар?» и «Есть товар» — дубль для превью, но не для проверки)
function normQuestionText(q) {
  return String(q.question || "").trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

// Превью точечных правок (payload.edits из разворота на бэке): компактный
// список операций вместо LCS-диффа — операции уже адресуют вопросы по №.
function questionEditsPreviewEl(box, p) {
  const head = document.createElement("div");
  head.textContent = `Точечные правки вопросов (операций: ${p.edits.length})`;
  box.appendChild(head);
  const brief = q => (q && q.question ? truncate(q.question, 40) : "—");
  const lines = p.edits.map(e => {
    const old = state.questions[(e.n || 0) - 1];
    if (e.op === "update") {
      return { cls: "diff-chg",
               text: `Изменить №${e.n}: «${brief(old)}» → «${brief(e.question)}»`,
               full: `было: ${(old && old.question) || "—"}\nстанет: ${(e.question && e.question.question) || "—"}` };
    }
    if (e.op === "remove") {
      return { cls: "diff-del", text: `Удалить №${e.n}: «${brief(old)}»` };
    }
    if (e.op === "split") {
      const into = (e.into || []).map(q => q.question || "").filter(Boolean);
      return { cls: "diff-chg",
               text: `Разбить №${e.n} → ${into.length} вопроса`,
               full: ["было: " + ((old && old.question) || "—"), "станет:", ...into].join("\n") };
    }
    // add
    const where = e.after != null ? `после №${e.after}` : "в конец";
    return { cls: "diff-add", text: `Добавить ${where}: «${brief(e.question)}»` };
  });
  addPreviewLines(box, lines);
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
  const lines = [];
  const dels = [], adds = [];
  let same = 0, i = 0, j = 0;
  const pushChg = (a, b, ai, bj) => {
    const changes = questionFieldChanges(a, b);
    if (!changes.length) { same += 1; return; }
    const num = ai + 1 === bj + 1 ? `№${ai + 1}` : `№${ai + 1}→№${bj + 1}`;
    for (const c of changes) lines.push({ cls: "diff-chg", text: `${num} ${c.text}`, full: c.full });
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
    if (!pairedDel.has(d)) lines.push({ cls: "diff-del", text: `− №${d.n + 1} ${fmtQuestionBrief(d.q)}` });
  }
  for (const a of adds) {
    if (!pairedAdd.has(a)) lines.push({ cls: "diff-add", text: `+ №${a.n + 1} ${fmtQuestionBrief(a.q)}` });
  }
  if (same) {
    lines.unshift({ cls: "", text: `без изменений: ${same}` });
  }
  // Громкий детектор цены замены: любые чистые удаления в replace — первой
  // строкой (инцидент 16.10: «было 8 → станет 2» читалось как «добавили 2»).
  // Вторая линия HITL — постоянная: replace остаётся для полной пересборки.
  const pureDels = dels.filter(d => !pairedDel.has(d)).length;
  if (pureDels) {
    lines.unshift({ cls: "diff-warn",
                    text: `⚠ Удаляются вопросы: ${pureDels} из ${m}` });
  }
  addPreviewLines(box, lines.slice(0, DIFF_PREVIEW_LINES));
  if (lines.length > DIFF_PREVIEW_LINES) {
    box.appendChild(detailsEl(
      `Показать ещё ${lines.length - DIFF_PREVIEW_LINES} из ${lines.length}`,
      lines.slice(DIFF_PREVIEW_LINES).map(l => l.full ? `${l.text}\n${l.full}` : l.text)));
  }
}

// Условие предложения (вопрос по № из текущего списка) — читаемо:
// «№1 «Дефект на фото?» P(да) ≥ 70%».
function condTextProposal(c) {
  const n = Math.round(Number(c.question));
  const q = state.questions[n - 1];
  const ref = q && q.question ? `№${n} «${truncate(q.question, 40)}»` : `№${c.question}`;
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

function decisionRuleLines(o, condText) {
  return (o.rules || []).map((r, ri) => {
    const conds = (r.conditions || []).map(condText);
    return `правило ${ri + 1}${r.anyOf ? " (ИЛИ)" : ""}: ${conds.join(" И ") || "без условий"}`;
  });
}

function decisionPreviewEl(box, p) {
  const outs = p.outcomes || [];
  const head = document.createElement("div");
  head.textContent = `Правила решения: исходов ${outs.length}`;
  box.appendChild(head);
  const current = (state.decision && state.decision.outcomes) || [];
  const curByLabel = {};
  for (const o of current) curByLabel[o.label] = o;
  for (const o of outs) {
    const cur = curByLabel[o.label];
    const newLines = decisionRuleLines(o, condTextProposal);
    const curLines = cur ? decisionRuleLines(cur, condTextCurrent) : null;
    const same = cur && JSON.stringify(curLines) === JSON.stringify(newLines)
      && !!cur.isDefault === !!o.isDefault;
    const div = document.createElement("div");
    div.textContent = `• ${o.label || "(без названия)"}`
      + (o.isDefault ? " (по умолчанию)" : "")
      + ` — правил: ${(o.rules || []).length}`
      + (cur ? (same ? " · без изменений" : " · изменено") : " · новый исход");
    if (!cur) div.className = "diff-add";
    else if (!same) div.className = "diff-chg";
    box.appendChild(div);
    if (cur && !same) {
      box.appendChild(detailsEl(`«${o.label}»: было → станет`,
        ["было:", ...(curLines.length ? curLines : ["(правил нет)"]), "",
         "станет:", ...(newLines.length ? newLines : ["(правил нет)"])]));
    } else if (newLines.length) {
      box.appendChild(detailsEl(`Условия исхода «${o.label}»`, newLines));
    }
  }
  // исходы, которых нет в предложении, — удалятся
  for (const o of current) {
    if (!outs.some(n => n.label === o.label)) {
      const div = document.createElement("div");
      div.className = "diff-del";
      div.textContent = `− ${o.label} — исход будет удалён`;
      box.appendChild(div);
    }
  }
}

// ---------------------------------------------------------------- дельта (v0.7)

// Блок измеренного эффекта правки правил на размеченных исходах (макет 6
// дизайн-документа). → { el, stale }: stale=true — карточка блокирует
// «Принять» (разметка от старой редакции, дельта лжёт).
function deltaBlockEl(proposal) {
  const box = document.createElement("div");
  box.className = "assistant-delta";
  let delta = null;
  try {
    delta = ruleDelta(decisionFromProposal(proposal.payload || {}, state.questions));
  } catch {
    box.remove(); // невалидное предложение покажет превалидация
    return { el: null, stale: false };
  }
  if (!delta) {
    box.classList.add("assistant-delta-dim");
    box.textContent = "Эффект не измерен: разметки исходов нет. Разметьте несколько исходов (✓/✗ у решений) — и правки будут проверяться на них до применения.";
    return { el: box, stale: false };
  }
  if (delta.stale) {
    box.classList.add("assistant-delta-stale");
    box.textContent = "Дельту посчитать нельзя: разметка относится к старой редакции (вопросы или правила менялись после прогона). Сначала перепрогоните.";
    return { el: box, stale: true };
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
  const span = document.createElement("span");
  span.textContent = parts.join(" · ") + " ";
  sub.appendChild(span);
  const changed = delta.cells.filter(c => c.before !== c.after);
  if (changed.length) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "assistant-link";
    link.textContent = "какие ячейки";
    const list = document.createElement("div");
    list.className = "assistant-delta-cells hidden";
    for (const c of changed) {
      const line = document.createElement("button");
      line.type = "button";
      line.className = "assistant-link assistant-delta-cell";
      const where = c.scope === "batch"
        ? `файл ${c.file} × ${modelShortLabel(c.model)}`
        : `прогон ${modelShortLabel(c.model)}`;
      line.textContent = `${where}: «${c.before ?? "не определено"}» → «${c.after ?? "не определено"}»`;
      line.addEventListener("click", () => {
        const r = reviewMod.revealTarget(c.scope, {
          scope: c.scope, model: c.model, mode: c.mode, file: c.file, decision: true,
        });
        if (r.filterReset) {
          const note = document.createElement("div");
          note.className = "assistant-delta-note";
          note.textContent = "фильтр разметки сброшен — он скрывал цель";
          box.appendChild(note);
        }
      });
      list.appendChild(line);
    }
    link.addEventListener("click", () => list.classList.toggle("hidden"));
    sub.appendChild(link);
    box.appendChild(sub);
    box.appendChild(list);
  } else {
    box.appendChild(sub);
  }
  if (delta.total < 5) {
    const warn = document.createElement("div");
    warn.className = "assistant-delta-warn";
    warn.textContent = `⚠ выборка маленькая (${delta.total}), погрешность ≈1 ошибка`;
    box.appendChild(warn);
  }
  return { el: box, stale: false };
}

function currentContextText() {  try {
    const snap = contextSnapshot();
    return typeof snap.input === "string" ? snap.input : JSON.stringify(snap.input, null, 2);
  } catch {
    return "";
  }
}

function contextPreviewEl(box, p) {
  const head = document.createElement("div");
  let current = "";
  if (p.file) {
    head.textContent = (p.mode === "append" ? "Дописать в файл «" : "Заменить текст файла «")
      + p.file + "»:";
    const f = state.batch.files.find(x => x.name === p.file);
    current = f && !f.isImage ? String(f.text || "") : "(файл не найден в пакете)";
  } else {
    head.textContent = p.mode === "append" ? "Добавить к материалу:" : "Заменить материал:";
    current = currentContextText();
  }
  box.appendChild(head);
  box.appendChild(detailsEl("Текущий текст", [truncate(current, CONTEXT_PREVIEW) || "(пусто)"]));
  box.appendChild(detailsEl("Предложенный текст", [truncate(String(p.text ?? ""), CONTEXT_PREVIEW)]));
}

function presetPreviewEl(box, p) {
  const head = document.createElement("div");
  head.textContent = (p.slug ? "Обновить пресет «" : "Сохранить пресет «")
    + (p.name || "") + "»";
  box.appendChild(head);
  const mode = state.pageMode === "batch" ? "пакет материалов" : "один материал";
  const lines = [];
  if (p.slug) lines.push(`Перезапишет существующий пресет (slug: ${p.slug})`);
  lines.push(`Состав: вопросов ${state.questions.length}, режим «${mode}», ` +
    (state.decision && (state.decision.outcomes || []).length
      ? `решение: исходов ${state.decision.outcomes.length}`
      : "без правил решения"));
  if (p.description) lines.push(String(p.description));
  addPreviewLines(box, lines.map(text => ({ text })));
}

function runPreviewEl(box, p) {
  const div = document.createElement("div");
  const scope = p.scope === "batch" ? "Пакет материалов" : "Один материал";
  div.textContent = `Запустить прогон: ${scope}` + (p.note ? `\n${p.note}` : "");
  box.appendChild(div);
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

// Карточка предложения: pending («Ждёт подтверждения» + кнопки
// «Принять»/«Отклонить») — до нажатия состояние приложения не меняется.
// «Принять» → применение, статус «Применено ✓» и кнопка «Отменить» (если для
// этого вида есть undo). «Отклонить» → «Отклонено», состояние не тронуто.
// Превалидация карточки при показе (v0.7): битое предложение помечается до
// клика «Принять», а не ошибкой после. Слои: семантика фронта (дубли вопросов,
// висячие № в правилах) → серверная схема /propose/validate. Сетевая ошибка —
// fail-open (карточка остаётся рабочей, валидация случится при применении).
function localProposalError(proposal) {
  const p = proposal.payload || {};
  if (proposal.kind === "propose_questions") {
    // Дубли — против итогового набора после применения: append добавляет к
    // текущим (нельзя повторять их и друг друга), replace затирает текущие
    // (совпадение со старым набором — не дубль, важны лишь повторы внутри).
    const incoming = p.questions || [];
    const seen = new Set(
      p.mode === "append" ? state.questions.map(normQuestionText) : []);
    for (const q of incoming) {
      const t = normQuestionText(q);
      if (!t) continue;
      if (seen.has(t)) {
        const where = p.mode === "append" &&
            state.questions.some(x => normQuestionText(x) === t)
          ? "Дубль существующего вопроса" : "Вопрос повторяется в предложении";
        return `${where}: «${truncate(t, 60)}»`;
      }
      seen.add(t);
    }
  }
  if (proposal.kind === "propose_decision") {
    try {
      decisionFromProposal(p, state.questions);
    } catch (e) {
      return e.message;
    }
  }
  return null;
}

function markProposalInvalid(card, status, reason, proposal) {
  card.classList.add("assistant-proposal-invalid");
  status.textContent = "Такую правку применить нельзя";
  status.className = "assistant-proposal-status declined";
  // Ряд «Принять»/«Отклонить» убираем целиком: на отвергнутой проверкой
  // карточке это ложные affordance'ы — выбора у пользователя нет, остаются
  // только «Сообщить ассистенту об ошибке» и «Скрыть»
  const actions = card.querySelector(".assistant-proposal-actions");
  if (actions) actions.remove();
  const det = document.createElement("div");
  det.className = "assistant-proposal-error";
  det.textContent = reason;
  status.appendChild(det);
  card._invalidReason = reason;
  if (card._feedItem) {
    card._feedItem.status = "invalid";
    card._feedItem.invalidReason = reason;
    persistChat();
  }
  // Модель не видит, что её карточка помечена невалидной (v0.8): кнопка шлёт
  // причину в чат системной репликой — модель исправляет и предлагает заново.
  if (proposal) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "assistant-report-invalid";
    btn.textContent = "Сообщить ассистенту об ошибке";
    btn.addEventListener("click", () => {
      btn.disabled = true;
      sendMessage(`Предложение ${proposal.kind} невалидно: ${reason}. `
        + "Исправь аргументы и предложи заново.", { system: true });
    });
    status.appendChild(btn);
    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "assistant-hide-invalid";
    hide.textContent = "Скрыть";
    hide.addEventListener("click", () => {
      collapseProposalCard(card, proposal, "Невалидно");
    });
    status.appendChild(hide);
  }
}

async function prevalidateProposal(proposal, card, status) {
  const localErr = localProposalError(proposal);
  if (localErr) {
    markProposalInvalid(card, status, localErr, proposal);
    assistantEvent({ kind: proposal.kind, proposal_id: proposal.id,
                     outcome: "invalid", detail: localErr });
    return;
  }
  try {
    await validateProposal(proposal.kind, proposal.payload);
  } catch (e) {
    if (e.message.startsWith("Ошибка 422")) {
      const reason = e.message.replace(/^Ошибка 422: /, "");
      markProposalInvalid(card, status, reason, proposal);
      assistantEvent({ kind: proposal.kind, proposal_id: proposal.id,
                       outcome: "invalid", detail: reason });
    }
    // сетевая/прочая ошибка — fail-open: карточка остаётся рабочей
  }
}

// Схлопывание карточки в строку-итог при терминальном статусе (v0.7, макет
// «applied-строка»): «✓ Применено · <суть> · [Отменить]», разворот по клику
// на заголовок. Активные карточки не трогаем; терминальные восстанавливаются
// из persist уже схлопнутыми (см. restoredProposalCard).
function collapseProposalCard(card, proposal, statusText, undoWrap) {
  const title = card.querySelector(".assistant-proposal-title");
  if (!title) return;
  // карточка может проходить несколько терминальных статусов (применено →
  // отменено) — listener вешается один раз, дальше обновляем контекст
  const ctx = card._collapseCtx || { statusText, undoWrap, listener: null };
  ctx.statusText = statusText;
  ctx.undoWrap = undoWrap || ctx.undoWrap;
  card._collapseCtx = ctx;
  const apply = (collapsed) => {
    for (const ch of [...card.children]) {
      if (ch === title || ch === ctx.undoWrap) continue;
      ch.classList.toggle("hidden", collapsed);
    }
    title.textContent = collapsed
      ? `${ctx.statusText} · ${proposal.title || proposal.kind}`
      : (proposal.title || proposal.kind);
    title.classList.toggle("assistant-expander", collapsed);
  };
  if (!ctx.listener) {
    ctx.listener = () => apply(!title.classList.contains("assistant-expander"));
    title.addEventListener("click", ctx.listener);
    title.title = "Развернуть";
  }
  apply(true);
}

function proposalCardEl(proposal, opts = {}) {
  const card = document.createElement("div");
  card.className = "assistant-proposal";
  if (proposal.id) card.dataset.proposalId = proposal.id;
  const title = document.createElement("div");
  title.className = "assistant-proposal-title";
  title.textContent = proposal.title || proposal.kind;
  card.appendChild(title);
  card.appendChild(proposalPreviewEl(proposal));
  // Дельта на размеченных — только для правок правил (мгновенно, без прогона)
  let deltaStale = false;
  if (proposal.kind === "propose_decision") {
    const d = deltaBlockEl(proposal);
    if (d.el) card.appendChild(d.el);
    deltaStale = d.stale;
  }
  const status = document.createElement("div");
  status.className = "assistant-proposal-status pending";
  status.textContent = "Ждёт подтверждения";
  card.appendChild(status);
  const actions = document.createElement("div");
  actions.className = "assistant-proposal-actions";
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "assistant-accept";
  accept.textContent = "Принять";
  if (deltaStale) {
    accept.disabled = true;
    accept.title = "Разметка от старой редакции — сначала перепрогоните, дельта будет посчитана на свежих данных";
  }
  const decline = document.createElement("button");
  decline.type = "button";
  decline.className = "assistant-decline";
  decline.textContent = "Отклонить";
  actions.append(accept, decline);
  card.appendChild(actions);
  // при восстановлении из persist превалидация не повторяется (была при
  // первом показе) — иначе дубли биконов invalid в журнале
  if (!opts.restored) prevalidateProposal(proposal, card, status); // async, fail-open

  decline.addEventListener("click", () => {
    status.textContent = "Отклонено";
    status.className = "assistant-proposal-status declined";
    actions.remove();
    collapseProposalCard(card, proposal, "Отклонено");
    assistantEvent({ kind: proposal.kind, proposal_id: proposal.id,
                     outcome: "declined" });
    if (card._feedItem) { card._feedItem.status = "declined"; persistChat(); }
  });
  accept.addEventListener("click", async () => {
    accept.disabled = true;
    decline.disabled = true;
    let undo = null;
    try {
      undo = captureUndo(proposal);
      await applyProposal(proposal);
    } catch (e) {
      status.textContent = "Не применено";
      status.className = "assistant-proposal-status declined";
      showProposalError(card, e);
      actions.remove();
      return;
    }
    status.textContent = "Применено ✓";
    status.className = "assistant-proposal-status applied";
    actions.remove();
    assistantEvent({ kind: proposal.kind, proposal_id: proposal.id,
                     outcome: "applied" });
    if (card._feedItem) { card._feedItem.status = "applied"; persistChat(); }
    if (!undo) {
      collapseProposalCard(card, proposal, "✓ Применено");
      return;
    }
    const undoWrap = document.createElement("div");
    undoWrap.className = "assistant-proposal-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "assistant-undo";
    btn.textContent = "Отменить";
    btn.addEventListener("click", () => {
      try {
        undo();
        status.textContent = "Отменено";
        status.className = "assistant-proposal-status undone";
        undoWrap.remove();
        collapseProposalCard(card, proposal, "Отменено");
        assistantEvent({ kind: proposal.kind, proposal_id: proposal.id,
                         outcome: "undone" });
        if (card._feedItem) { card._feedItem.status = "undone"; persistChat(); }
      } catch (e) {
        showProposalError(card, e);
      }
    });
    undoWrap.appendChild(btn);
    card.appendChild(undoWrap);
    collapseProposalCard(card, proposal, "✓ Применено", undoWrap);
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
  const card = proposalCardEl(proposal);
  card._feedItem = { t: "proposal", proposal, status: "pending",
                     fingerprint: proposalFingerprint(proposal) };
  // Локальная превалидация в proposalCardEl синхронна и отрабатывает ДО
  // привязки feed-элемента — переносим статус, иначе после перезагрузки
  // невалидная карточка восстановится активной «ждёт подтверждения».
  if (card.classList.contains("assistant-proposal-invalid")) {
    card._feedItem.status = "invalid";
    card._feedItem.invalidReason = card._invalidReason;
  }
  pushFeed(key, card._feedItem);
  appendMsg(card, key);
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

function applyQuestionsProposal(payload) {
  const converted = (payload.questions || []).map(convertProposalQuestion);
  if (!converted.length) throw new Error("В предложении нет вопросов.");
  if (payload.mode === "append") {
    for (const q of converted) state.questions.push(normalizeQuestion(q));
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

export async function applyProposal(proposal) {
  const payload = proposal.payload || {};
  if (proposal.kind === "propose_questions") return applyQuestionsProposal(payload);
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
  restoreChat();  // лента и история из persist (v0.8)

  document.getElementById("tb-assistant").addEventListener("click", () => togglePanel());
  document.getElementById("assistant-close").addEventListener("click", () => closePanel());
  document.getElementById("assistant-reset").addEventListener("click", () => resetHistory());
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
// Клик — отправляет готовый запрос.
function chipsForState() {
  const hasResults = !!(state.results && state.results.results)
    || Object.keys(state.batch.results || {}).length > 0;
  const chips = [];
  if (!hasResults) {
    chips.push("Предложи вопросы по материалу", "Помоги с правилами решения");
  } else {
    chips.push("Найди проблемы в последнем прогоне", "Предложи правку порогов",
               "Сравни модели между собой");
  }
  return chips;
}

export function renderChips() {
  const box = document.getElementById("assistant-chips");
  if (!box) return;
  box.textContent = "";
  for (const text of chipsForState()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "assistant-chip";
    b.textContent = text;
    b.addEventListener("click", () => sendMessage(text));
    box.appendChild(b);
  }
}
