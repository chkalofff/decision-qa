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
import { setDecision, validateDecision, evaluateDecision, answerLabel,
         OUTCOME_COLORS, COLOR_NAMES } from "./decision.js";
import { setContent, contextSnapshot } from "./context.js";
import { openSaveDialog } from "./presets.js";
import { getPresets } from "./api.js";
import { renderBatchList } from "./batch.js";
import { shortAnswer, modelShortLabel, answerConfidence } from "./results.js";

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

const TYPE_LABELS = { yes_no: "Yes/No", choice: "Choice", score: "Score" };

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
const convos = {
  single: { history: [], nodes: null, openTools: [] },
  batch: { history: [], nodes: null, openTools: [] },
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

function scrollDown() {
  const m = messagesEl();
  if (m && typeof m.scrollHeight === "number") m.scrollTop = m.scrollHeight;
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

function addUserMessage(text, key = activeConvo) {
  const wrap = document.createElement("div");
  wrap.className = "assistant-msg user";
  const bubble = document.createElement("div");
  bubble.className = "assistant-bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  appendMsg(wrap, key);
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

function showToolEvent(name, status, message, key = activeConvo) {
  const openTools = convos[key].openTools;
  if (status === "start") {
    const el = addNote(`🔧 ${toolLabel(name)}…`, key);
    openTools.push({ el, name });
    return;
  }
  const open = openTools.pop();
  if (!open) return;
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
  const m = messagesEl();
  if (m) {
    for (const ch of [...m.children]) {
      if (!ch.classList.contains("assistant-intro")) ch.remove();
    }
  }
  showIntro();
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
      // id модели не показываем: ссылки на вопросы — по n (номер карточки в UI)
      const out = { n: idx + 1, question: q.question, type: q.type };
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

export async function sendMessage(text) {
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
  addUserMessage(text, convoKey);
  convo.history.push({ role: "user", content: text });
  const typing = showTyping(convoKey);

  let answerText = "";
  let thinkingText = "";
  let thinkingShown = false;
  let answerBody = null;
  let finished = false;
  let aborted = false;

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
              showToolEvent(ev.name, ev.status, ev.message, convoKey);  // строка в ленте, обновится по done
            } else if (ev.type === "trial") {
              handleTrial(ev.trial, convoKey);  // карточка-таблица в ленте, UI не мутируется
            } else if (ev.type === "proposal") {
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
  if (answerText.trim()) convo.history.push({ role: "assistant", content: answerText });
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
  return {
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
  const decision = trialDecisionEngine(trial);
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

export function handleTrial(trial, key = activeConvo) {
  if (!trial) return null;
  const card = trialCardEl(trial);
  appendMsg(card, key);
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

function questionsPreviewEl(box, p) {
  const incoming = (p.questions || []).map(convertProposalQuestion);
  const head = document.createElement("div");
  box.appendChild(head);
  if (p.mode === "append") {
    head.textContent = `Добавить вопросы (${incoming.length}) к текущим ${state.questions.length}:`;
    addPreviewLines(box, incoming.map(q => ({ cls: "diff-add", text: "+ " + fmtQuestionBrief(q) })));
    return;
  }
  head.textContent = `Заменить вопросы: было ${state.questions.length} → станет ${incoming.length}`;
  const lines = [];
  const n = Math.max(state.questions.length, incoming.length);
  for (let i = 0; i < n; i++) {
    const a = state.questions[i];
    const b = incoming[i];
    if (a && !b) {
      lines.push({ cls: "diff-del", text: `− №${i + 1} ${fmtQuestionBrief(a)}` });
      continue;
    }
    if (!a && b) {
      lines.push({ cls: "diff-add", text: `+ №${i + 1} ${fmtQuestionBrief(b)}` });
      continue;
    }
    const changes = questionFieldChanges(a, b);
    if (!changes.length) {
      lines.push({ cls: "", text: `№${i + 1} без изменений: ${truncate(a.question || "", 50)}`,
                   full: a.question || "" });
    } else {
      for (const c of changes) lines.push({ cls: "diff-chg", text: `№${i + 1} ${c.text}`, full: c.full });
    }
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

function currentContextText() {
  try {
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
function proposalCardEl(proposal) {
  const card = document.createElement("div");
  card.className = "assistant-proposal";
  if (proposal.id) card.dataset.proposalId = proposal.id;
  const title = document.createElement("div");
  title.className = "assistant-proposal-title";
  title.textContent = proposal.title || proposal.kind;
  card.appendChild(title);
  card.appendChild(proposalPreviewEl(proposal));
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
  const decline = document.createElement("button");
  decline.type = "button";
  decline.className = "assistant-decline";
  decline.textContent = "Отклонить";
  actions.append(accept, decline);
  card.appendChild(actions);

  decline.addEventListener("click", () => {
    status.textContent = "Отклонено";
    status.className = "assistant-proposal-status declined";
    actions.remove();
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
    if (!undo) return;
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
      } catch (e) {
        showProposalError(card, e);
      }
    });
    undoWrap.appendChild(btn);
    card.appendChild(undoWrap);
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

// Условие из аргументов propose_decision → формат decision.js: вопрос по № из
// снапшота (n → state.questions[n-1]), threshold из процентов в 0..1.
function convertDecisionCondition(c) {
  const n = Math.round(Number(c.question));
  const q = state.questions[n - 1];
  if (!q) throw new Error(`Условие ссылается на несуществующий вопрос №${c.question}.`);
  const cond = { question: q.id, op: c.op === "lt" ? "lt" : "gte" };
  if (c.answer != null && String(c.answer).trim() !== "") {
    cond.answer = String(c.answer).trim();
    let thr = Number(c.threshold);
    if (!Number.isFinite(thr)) thr = 50;
    if (thr > 1) thr = thr / 100;
    cond.threshold = Math.min(Math.max(thr, 0), 1);
  } else {
    const s = Number(c.score);
    if (!Number.isFinite(s)) throw new Error("В условии нет ни answer, ни score.");
    cond.score = s;
  }
  return cond;
}

function applyDecisionProposal(payload) {
  const outs = payload.outcomes || [];
  if (!outs.length) throw new Error("В предложении нет исходов.");
  const decision = {
    outcomes: outs.map((o, i) => ({
      id: "o" + (i + 1),
      label: String(o.label || "").trim(),
      color: COLOR_NAMES.includes(o.color) ? o.color : "gray",
      isDefault: !!o.isDefault,
      rules: (o.rules || []).map(r => ({
        anyOf: !!r.anyOf,
        conditions: (r.conditions || []).map(convertDecisionCondition),
      })),
    })),
  };
  validateDecision(decision, state.questions); // бросает Error с текстом
  setDecision(decision);
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
  convos.single = { history: [], nodes: null, openTools: [] };
  convos.batch = { history: [], nodes: null, openTools: [] };
  activeConvo = convoKeyForPage(state.pageMode);
  introHtml = (introEl() || {}).innerHTML || "";
  chatModels = [];
  selectedModel = null;
  streaming = false;
  activeController = null;
  unread = false;

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
  // свежие статусы моделей от поллинга toolbar — обновляем пометки «не запущена»
  subscribe((event) => { if (event === "models") renderModelOptions(); });
  loadModels();
}

// Чип активного режима в шапке панели + переключение разговора: у «Одиночного»
// и «Батча» свои история и лента (страницы «Модели»/«Пресеты» относятся к
// одиночному разговору). Ассистент действует на активной странице, пока
// пользователь явно не попросил про другую.
export function updateModeChip() {
  switchConversation(convoKeyForPage(state.pageMode));
  const chip = document.getElementById("assistant-mode");
  if (!chip) return;
  chip.textContent = state.pageMode === "batch" ? "Пакет"
    : state.pageMode === "single" ? "Один материал"
    : "";
  chip.classList.toggle("hidden", !chip.textContent);
}
