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
import { state, subscribe } from "./state.js";
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
const WIDTH_MAX = 720;
const WIDTH_DEFAULT = 380;

const TYPE_LABELS = { yes_no: "Yes/No", choice: "Choice", score: "Score" };

const md = new Remarkable({ html: false, breaks: true });

const PLANE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15">' +
  '<path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>';
const STOP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">' +
  '<rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

let history = [];          // [{role: "user"|"assistant", content}] — только финальный текст
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
  return Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, Math.round(w)));
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

// Статусы берём из state.models (его поддерживает поллинг toolbar.js из
// /api/models). Если state.models ещё пуст (первый поллинг не завершён),
// никого не блокируем.
function renderModelOptions() {
  const sel = document.getElementById("assistant-model");
  if (!sel) return;
  sel.innerHTML = "";
  if (!chatModels.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Нет chat-моделей";
    sel.appendChild(opt);
    selectedModel = null;
    return;
  }
  const statusesKnown = state.models.length > 0;
  let firstEnabled = null;
  for (const m of chatModels) {
    // У облачных chat-моделей "running" означает "доступен API" — та же логика
    const status = state.models.find(x => x.key === m.key)?.status;
    const running = !statusesKnown || status === "running";
    const opt = document.createElement("option");
    opt.value = m.key;
    const suffix = m.remote ? " ☁" : "";
    const note = m.remote ? "недоступна" : "не запущена";
    opt.textContent = (running ? m.label : `${m.label} (${note})`) + suffix;
    opt.disabled = !running;
    sel.appendChild(opt);
    if (running && firstEnabled === null) firstEnabled = m.key;
  }
  const current = chatModels.find(m => m.key === selectedModel);
  const currentRunning = current &&
    (!statusesKnown || state.models.find(x => x.key === selectedModel)?.status === "running");
  selectedModel = currentRunning ? selectedModel : firstEnabled;
  if (selectedModel) sel.value = selectedModel;
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

function scrollDown() {
  const m = messagesEl();
  if (m && typeof m.scrollHeight === "number") m.scrollTop = m.scrollHeight;
}

// Добавить узел в ленту (перед индикатором «печатает», если он висит) и
// подскроллить вниз. Первое сообщение прячет welcome-подсказку.
function appendMsg(node) {
  const m = messagesEl();
  if (!m) return node;
  hideIntro();
  const typing = m.querySelector(".assistant-typing");
  if (typing) m.insertBefore(node, typing);
  else m.appendChild(node);
  scrollDown();
  return node;
}

function addUserMessage(text) {
  const wrap = document.createElement("div");
  wrap.className = "assistant-msg user";
  const bubble = document.createElement("div");
  bubble.className = "assistant-bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  appendMsg(wrap);
}

// Пузырь ответа ассистента; markdown тела обновляется по мере стрима.
function createAnswerMessage() {
  const wrap = document.createElement("div");
  wrap.className = "assistant-msg ai";
  const body = document.createElement("div");
  body.className = "assistant-md";
  wrap.appendChild(body);
  appendMsg(wrap);
  return body;
}

function renderMarkdown(body, text) {
  body.innerHTML = md.render(text);
}

// Маленькая ненавязчивая строка в ленте (tool-события, обрыв, отмена).
function addNote(text) {
  const note = document.createElement("div");
  note.className = "assistant-note";
  note.textContent = text;
  appendMsg(note);
  return note;
}

function addErrorMessage(msg) {
  const err = document.createElement("div");
  err.className = "assistant-msg ai assistant-error";
  err.textContent = "⚠ " + msg;
  appendMsg(err);
}

// Индикатор «печатает» в теле ленты (три точки), пока запрос активен и ответ
// ещё не начался.
function showTyping() {
  const el = document.createElement("div");
  el.className = "assistant-typing";
  for (let i = 0; i < 3; i += 1) el.appendChild(document.createElement("span"));
  appendMsg(el);
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
// храним напрямую, shadow DOM больше нет).
const openToolNotes = [];  // [{el, name}] — стек незавершённых вызовов

function showToolEvent(name, status) {
  if (status === "start") {
    const el = addNote(`вызывает инструмент: ${name}…`);
    openToolNotes.push({ el, name });
    return;
  }
  const open = openToolNotes.pop();
  if (!open) return;
  open.el.textContent = status === "error"
    ? `инструмент ${open.name}: ошибка`
    : `инструмент ${open.name}: готово`;
}

// ---------------------------------------------------------------- история

export function resetHistory() {
  history = [];
  openToolNotes.length = 0;
  const m = messagesEl();
  if (m) {
    for (const c of [...m.children]) {
      if (!c.classList.contains("assistant-intro")) c.remove();
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
  const lines = [`батч: файлов с результатами ${fileIds.length}`];
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
// бюджету); dataUrl картинок — только vision-модели ассистента (1-2 на файл).
function batchFilesSnapshot(vision) {
  const files = state.batch.files;
  const perFile = Math.min(BATCH_FILE_TEXT_LIMIT,
    Math.max(300, Math.floor(BATCH_TEXT_TOTAL / Math.max(files.length, 1))));
  return files.map(f => {
    const imagesCount = f.isImage ? 1 : (f.images || []).length;
    const out = { name: f.name, size: f.size ?? null, imagesCount };
    if (!f.isImage && typeof f.text === "string" && f.text) {
      out.text = truncate(f.text, perFile);
    }
    if (vision) {
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
  // Картинки (dataUrl) включаем, только если выбранная chat-модель ассистента
  // vision — иначе они не дойдут до модели и лишь раздуют запрос.
  const vision = !!state.models.find(m => m.key === selectedModel)?.vision;
  const context = {
    text: truncate(ctxText, CONTEXT_LIMIT),
    imagesCount: state.contextImages.length,
  };
  if (vision && state.contextImages.length) {
    context.images = state.contextImages.map(img => img.dataUrl);
  } else if (state.contextImages.length) {
    context.imagesNote = "картинки есть, но выбранная модель ассистента их не видит (нет vision)";
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
    snapshot.batchFiles = batchFilesSnapshot(vision);
  }
  const batchResults = batchResultsSnapshot();
  if (batchResults) snapshot.batchResults = batchResults;
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
  streaming = true;
  updateSendButton();
  addUserMessage(text);
  history.push({ role: "user", content: text });
  const typing = showTyping();

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
    appendMsg(thinkingEl(thinkingText));
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
        history: history.slice(0, -1).slice(-HISTORY_LIMIT),
        snapshot: buildSnapshot(),
        thinking: !!document.getElementById("assistant-thinking").checked,
      }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      addErrorMessage(data.detail || `Ошибка ${resp.status}`);
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
                answerBody = createAnswerMessage();
              }
              answerText += ev.text || "";
              renderMarkdown(answerBody, answerText);
              scrollDown();
            } else if (ev.type === "thinking") {
              thinkingText += ev.text || "";
            } else if (ev.type === "tool") {
              showToolEvent(ev.name, ev.status);  // строка в ленте, обновится по done
            } else if (ev.type === "trial") {
              handleTrial(ev.trial);  // карточка-таблица в ленте, UI не мутируется
            } else if (ev.type === "proposal") {
              handleProposal(ev.proposal);  // карточка «Принять»/«Отклонить» в ленте
            } else if (ev.type === "done") {
              finished = true;
            } else if (ev.type === "error") {
              showThinking();
              addErrorMessage(ev.message || "Ошибка ассистента");
              finished = true;
            }
          }
        }
      }
      if (!finished && !aborted) addNote("⚠ соединение прервано");
    }
  } catch (e) {
    if (aborted || (e && e.name === "AbortError")) {
      aborted = true;  // ручная отмена — не ошибка
    } else {
      addErrorMessage(e.message || String(e));
      finished = true;
    }
  }
  if (aborted && reader) { try { await reader.cancel(); } catch { /* уже закрыт */ } }
  typing.remove();
  showThinking();
  if (aborted) addNote("остановлено пользователем");
  if (answerText.trim()) history.push({ role: "assistant", content: answerText });
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

// Карточка-таблица «Пробный прогон» (событие trial от run_trial): модель ×
// вопрос → ответ с уверенностью; с переданными правилами — колонка «Решение»
// (исход считает движок на фронте); для совпадающих пар вопрос×модель из
// прогона пользователя — маркеры отличий (↑/↓ уверенность, ≠ ответ изменился).
// Только показ — состояние приложения не меняется.
function trialCardEl(trial) {
  const qs = trial.questions || [];
  const decision = trialDecisionEngine(trial);
  const userRun = userRunAnswersByText();
  const card = document.createElement("div");
  card.className = "assistant-proposal assistant-trial";
  const title = document.createElement("div");
  title.className = "assistant-proposal-title";
  title.textContent = "Пробный прогон";
  card.appendChild(title);
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
            diffs.push(`${row.label || row.model} × «${truncate(q.question || q.id, 30)}»: ${prevShort} → ${curShort}`);
          } else {
            const dc = answerConfidence(full) - answerConfidence(prev);
            if (Math.abs(dc) >= 0.05) {
              text += dc > 0 ? " ↑" : " ↓";
              marked = true;
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
  card.appendChild(table);
  if (marked) {
    const legend = document.createElement("div");
    legend.className = "assistant-trial-legend";
    legend.textContent = "Отличия от вашего прогона (↑/↓ — уверенность, ≠ — ответ изменился)"
      + (diffs.length ? ":\n" + diffs.slice(0, 3).join("\n")
        + (diffs.length > 3 ? `\n… и ещё ${diffs.length - 3}` : "") : ".");
    card.appendChild(legend);
  }
  if (trial.note) {
    const note = document.createElement("div");
    note.className = "assistant-proposal-preview";
    note.textContent = trial.note;
    card.appendChild(note);
  }
  return card;
}

export function handleTrial(trial) {
  if (!trial) return null;
  const card = trialCardEl(trial);
  appendMsg(card);
  return card;
}

// ---------------------------------------------------------------- proposal-карточки

function detailsEl(summaryText, lines) {
  const det = document.createElement("details");
  const sum = document.createElement("summary");
  sum.textContent = summaryText;
  det.appendChild(sum);
  const body = document.createElement("div");
  body.textContent = lines.join("\n");
  det.appendChild(body);
  return det;
}

// lines: [{cls?: "diff-add"|"diff-del"|"diff-chg", text}]
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

function fmtFieldVal(v) {
  return truncate(String(v ?? "—"), 40);
}

// Изменённые поля вопроса (replace-предложение сопоставляем позиционно);
// поля, которых нет в предложении, считаем нетронутыми.
function questionFieldChanges(oldQ, newQ) {
  const out = [];
  const cmp = (label, a, b) => {
    if (b == null) return;
    if (String(a ?? "") !== String(b)) out.push(`${label}: ${fmtFieldVal(a)} → ${fmtFieldVal(b)}`);
  };
  cmp("текст", oldQ.question, newQ.question);
  if (newQ.type && newQ.type !== oldQ.type) {
    out.push(`тип: ${TYPE_LABELS[oldQ.type] || oldQ.type} → ${TYPE_LABELS[newQ.type]}`);
  }
  cmp("«да»", oldQ.yes, newQ.yes);
  cmp("«нет»", oldQ.no, newQ.no);
  if (newQ.options != null) {
    const a = (oldQ.options || []).map(o => o.name).join(", ");
    const b = newQ.options.map(o => o.name).join(", ");
    if (a !== b) out.push(`опции: ${fmtFieldVal(a)} → ${fmtFieldVal(b)}`);
  }
  if (newQ.levels != null) {
    const a = (oldQ.levels || []).join(", ");
    const b = newQ.levels.join(", ");
    if (a !== b) out.push(`уровни: ${fmtFieldVal(a)} → ${fmtFieldVal(b)}`);
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
      lines.push({ cls: "", text: `№${i + 1} без изменений: ${truncate(a.question || "", 50)}` });
    } else {
      for (const c of changes) lines.push({ cls: "diff-chg", text: `№${i + 1} ${c}` });
    }
  }
  addPreviewLines(box, lines.slice(0, DIFF_PREVIEW_LINES));
  if (lines.length > DIFF_PREVIEW_LINES) {
    box.appendChild(detailsEl(
      `Показать ещё ${lines.length - DIFF_PREVIEW_LINES} из ${lines.length}`,
      lines.slice(DIFF_PREVIEW_LINES).map(l => l.text)));
  }
}

function decisionRuleLines(o) {
  return (o.rules || []).map((r, ri) => {
    const conds = (r.conditions || []).map(c => {
      const op = c.op === "lt" ? "<" : "≥";
      return c.answer != null
        ? `№${c.question} P(${answerLabel(c.answer)}) ${op} ${c.threshold ?? 50}%`
        : `№${c.question} балл ${op} ${c.score}`;
    });
    return `правило ${ri + 1}${r.anyOf ? " (ИЛИ)" : ""}: ${conds.join(" И ") || "без условий"}`;
  });
}

function decisionPreviewEl(box, p) {
  const outs = p.outcomes || [];
  const head = document.createElement("div");
  head.textContent = `Правила решения: исходов ${outs.length}`;
  box.appendChild(head);
  for (const o of outs) {
    const div = document.createElement("div");
    div.textContent = `• ${o.label || "(без названия)"}`
      + (o.isDefault ? " (по умолчанию)" : "")
      + ` — правил: ${(o.rules || []).length}`;
    box.appendChild(div);
    const ruleLines = decisionRuleLines(o);
    if (ruleLines.length) {
      box.appendChild(detailsEl(`Условия исхода «${o.label}»`, ruleLines));
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
    current = f && !f.isImage ? String(f.text || "") : "(файл не найден в батче)";
  } else {
    head.textContent = p.mode === "append" ? "Добавить к контексту:" : "Заменить контекст:";
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
  const mode = state.pageMode === "batch" ? "батч" : "одиночный";
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
  const scope = p.scope === "batch" ? "Батч" : "Одиночный";
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
export async function handleProposal(proposal) {
  const card = proposalCardEl(proposal);
  appendMsg(card);
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
    if (!f) throw new Error(`Файл «${payload.file}» не найден в батче.`);
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
    throw new Error("Запуск недоступен (нет контекста/моделей).");
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
  history = [];
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
  // свежие статусы моделей от поллинга toolbar — обновляем пометки «не запущена»
  subscribe((event) => { if (event === "models") renderModelOptions(); });
  loadModels();
}
