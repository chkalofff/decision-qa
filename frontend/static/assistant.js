// AI-ассистент: правая выдвижная панель с собственным чат-UI (обычный DOM,
// без shadow DOM и сторонних чат-компонентов). Ответы ассистента рендерятся
// markdown'ом (вендоренный remarkable, vendor/remarkable.js). Наш SSE
// /api/assistant/chat: token → стриминг в пузырь ответа, thinking →
// сворачиваемый details-блок, tool → служебная строка в ленте, trial/proposal
// → карточки в ленте, error → красная строка, done → конец.
// Кнопка отправки превращается в СТОП на всё время запроса (включая фазы
// инструментов и thinking): клик → AbortController, частичный ответ остаётся,
// в ленте строка «остановлено пользователем». Proposal-события
// АВТО-ПРИМЕНЯЮТСЯ сразу, в ленте — карточка-запись с кнопкой «Отменить»
// (undo по снимку прежнего состояния; для run/preset undo нет).

import { Remarkable } from "./vendor/remarkable.js";
import { state, selectedModelKeys, subscribe } from "./state.js";
import { setPageMode } from "./toolbar.js";
import { setQuestions, normalizeQuestion, renderQuestions } from "./questions.js";
import { setContent, contextSnapshot } from "./context.js";
import { openSaveDialog } from "./presets.js";
import { shortAnswer, modelShortLabel } from "./results.js";

const HISTORY_LIMIT = 20;     // последние N сообщений уходят в запросе
const CONTEXT_LIMIT = 4000;   // обрезка текста контекста в снапшоте
const RESULTS_LIMIT = 3000;   // обрезка сводки результатов
const CONTEXT_PREVIEW = 500;  // предпросмотр текста в карточке propose_context
const QUESTIONS_PREVIEW = 5;  // сколько вопросов показывать в предпросмотре
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

const panel = () => document.getElementById("assistant-panel");
const messagesEl = () => document.getElementById("assistant-messages");
const inputEl = () => document.getElementById("assistant-input");
const sendEl = () => document.getElementById("assistant-send");

// ---------------------------------------------------------------- панель

export function openPanel() {
  panel().classList.remove("hidden");
  renderModelOptions();
  loadModels();
}

export function closePanel() {
  panel().classList.add("hidden");
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
    const answers = answersOf(rs.results[key]);
    if (!answers) continue;
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
  return lines.length > 1 ? lines.join("\n") : "";
}

export function buildSnapshot() {
  let ctxText = "";
  try {
    const snap = contextSnapshot();
    ctxText = typeof snap.input === "string" ? snap.input : JSON.stringify(snap.input);
  } catch { ctxText = ""; }
  const snapshot = {
    page: state.pageMode,
    context: {
      text: truncate(ctxText, CONTEXT_LIMIT),
      imagesCount: state.contextImages.length,
    },
    questions: state.questions.map(q => {
      const out = { id: q.id, question: q.question, type: q.type };
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
    selectedModels: selectedModelKeys(),
  };
  if (state.batch.files.length) {
    snapshot.batchFiles = state.batch.files.map(f => ({
      name: f.name,
      size: f.size ?? null,
      imagesCount: f.isImage ? 1 : (f.images || []).length,
    }));
  }
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
export function updateSendButton() {
  const btn = sendEl();
  if (!btn) return;
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
              handleProposal(ev.proposal);  // авто-применение, карточка в ленте
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
  activeController = null;
  streaming = false;
  updateSendButton();
}

// ---------------------------------------------------------------- пробный прогон

// Карточка-таблица «Пробный прогон» (событие trial от run_trial): модель ×
// вопрос → ответ с уверенностью. Только показ — состояние приложения не меняется.
function trialCardEl(trial) {
  const qs = trial.questions || [];
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
  table.appendChild(headRow);
  for (const row of trial.rows || []) {
    const tr = document.createElement("tr");
    const tdModel = document.createElement("td");
    tdModel.textContent = row.label || row.model;
    tr.appendChild(tdModel);
    if (row.error) {
      const td = document.createElement("td");
      td.className = "assistant-trial-error";
      td.colSpan = Math.max(qs.length, 1);
      td.textContent = "⚠ " + row.error;
      tr.appendChild(td);
    } else {
      for (const q of qs) {
        const td = document.createElement("td");
        td.textContent = (row.answers || {})[q.id] || "—";
        tr.appendChild(td);
      }
    }
    table.appendChild(tr);
  }
  card.appendChild(table);
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

function proposalPreview(proposal) {
  const p = proposal.payload || {};
  if (proposal.kind === "propose_questions") {
    const qs = p.questions || [];
    const head = p.mode === "append" ? "Добавить вопросы:" : "Заменить вопросы:";
    const lines = qs.slice(0, QUESTIONS_PREVIEW)
      .map(q => `• [${TYPE_LABELS[q.type] || q.type}] ${q.question || "(без текста)"}`);
    if (qs.length > QUESTIONS_PREVIEW) lines.push(`… и ещё ${qs.length - QUESTIONS_PREVIEW}`);
    return [head, ...lines].join("\n");
  }
  if (proposal.kind === "propose_context") {
    const head = p.mode === "append" ? "Добавить к контексту:" : "Заменить контекст:";
    return head + "\n" + truncate(String(p.text ?? ""), CONTEXT_PREVIEW);
  }
  if (proposal.kind === "propose_run") {
    const scope = p.scope === "batch" ? "Батч" : "Одиночный";
    return `Запустить прогон: ${scope}` + (p.note ? `\n${p.note}` : "");
  }
  if (proposal.kind === "propose_save_preset") {
    return `Сохранить пресет «${p.name || ""}»` + (p.description ? `\n${p.description}` : "");
  }
  return truncate(JSON.stringify(p, null, 2), CONTEXT_PREVIEW);
}

// Карточка-запись о применённом предложении — обычный DOM-узел в ленте.
// undo — замыкание (снимок прежнего состояния); без него кнопки «Отменить»
// нет (run/preset неотменяемы).
function proposalCardEl(proposal, { statusText, statusCls, errorText, undo }) {
  const card = document.createElement("div");
  card.className = "assistant-proposal";
  if (proposal.id) card.dataset.proposalId = proposal.id;
  const title = document.createElement("div");
  title.className = "assistant-proposal-title";
  title.textContent = proposal.title || proposal.kind;
  card.appendChild(title);
  const preview = document.createElement("div");
  preview.className = "assistant-proposal-preview";
  preview.textContent = proposalPreview(proposal);
  card.appendChild(preview);
  const status = document.createElement("div");
  status.className = "assistant-proposal-status " + statusCls;
  status.textContent = statusText;
  card.appendChild(status);
  let errEl = null;
  if (errorText) {
    errEl = document.createElement("div");
    errEl.className = "assistant-proposal-error";
    errEl.textContent = errorText;
    card.appendChild(errEl);
  }
  if (undo) {
    const actions = document.createElement("div");
    actions.className = "assistant-proposal-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "assistant-undo";
    btn.textContent = "Отменить";
    let done = false;
    btn.addEventListener("click", () => {
      if (done) return;
      try {
        undo();
        done = true;
        status.textContent = "Отменено";
        status.className = "assistant-proposal-status undone";
        btn.remove();
      } catch (e) {
        if (!errEl) {
          errEl = document.createElement("div");
          errEl.className = "assistant-proposal-error";
          card.appendChild(errEl);
        }
        errEl.textContent = e.message || String(e);
      }
    });
    actions.appendChild(btn);
    card.appendChild(actions);
  }
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
    let prevText = "";
    let prevMode = "text";
    try {
      const snap = contextSnapshot();
      prevText = typeof snap.input === "string" ? snap.input : JSON.stringify(snap.input, null, 2);
      prevMode = snap.input_format === "json" ? "json" : "text";
    } catch { /* пустой контекст */ }
    return () => setContent(prevText, prevMode);
  }
  return null;
}

// Авто-применение: сразу применяем, карточка-запись добавляется в ленту чата.
// При ошибке применения карточка показывает текст ошибки (изменений нет).
export async function handleProposal(proposal) {
  let undo = null;
  let statusText = "Применено ✓";
  let statusCls = "applied";
  let errorText = null;
  try {
    undo = captureUndo(proposal);
    await applyProposal(proposal);
  } catch (e) {
    undo = null;
    statusText = "Не применено";
    statusCls = "declined";
    errorText = e.message || String(e);
  }
  const card = proposalCardEl(proposal, { statusText, statusCls, errorText, undo });
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

function applyContextProposal(payload) {
  const text = String(payload.text ?? "");
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

function applyPresetProposal(payload) {
  const name = String(payload.name || "").trim();
  if (!name) throw new Error("В предложении нет имени пресета.");
  openSaveDialog(undefined, { name, description: String(payload.description || "") });
}

export async function applyProposal(proposal) {
  const payload = proposal.payload || {};
  if (proposal.kind === "propose_questions") return applyQuestionsProposal(payload);
  if (proposal.kind === "propose_context") return applyContextProposal(payload);
  if (proposal.kind === "propose_run") return applyRunProposal(payload);
  if (proposal.kind === "propose_save_preset") return applyPresetProposal(payload);
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
