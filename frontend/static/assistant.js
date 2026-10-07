// AI-ассистент: правая выдвижная панель с чатом на Deep Chat (web component,
// vendor/deep-chat). Наш SSE /api/assistant/chat маппится на handler-сигналы
// компонента: token → стриминг ответа, thinking → сворачиваемый html-блок,
// tool → служебная строка статуса, error → error-пузырь компонента (после
// токенов) или красный html (до первого токена), done → конец. Во время
// стрима deep-chat рисует stop-кнопку: signals.stopClicked → AbortController
// (частичный ответ остаётся, статус «остановлено пользователем»).
// Proposal-события АВТО-ПРИМЕНЯЮТСЯ сразу по получении, а в ЛЕНТЕ чата
// (addMessage html) появляется карточка-запись с кнопкой «Отменить» (undo по
// снимку прежнего состояния; для run/preset undo нет). Клик по кнопке внутри
// shadow DOM ловится через htmlClassUtilities + реестр undoRegistry.

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

const WIDTH_KEY = "dq-assistant-width";
const WIDTH_MIN = 320;
const WIDTH_MAX = 720;
const WIDTH_DEFAULT = 380;

const TYPE_LABELS = { yes_no: "Yes/No", choice: "Choice", score: "Score" };

let history = [];          // [{role: "user"|"assistant", content}] — только финальный текст
let chatModels = [];       // [{key, label}] из GET /api/assistant/models
let selectedModel = null;  // key выбранной chat-модели
let streaming = false;

const panel = () => document.getElementById("assistant-panel");
const chatEl = () => document.getElementById("assistant-chat");

// Реестр undo-замыканий для карточек в ленте чата: html внутри shadow DOM не
// может держать JS-ссылки, поэтому кнопка «Отменить» несёт data-undo-key, а
// клик (htmlClassUtilities) достаёт замыкание отсюда.
const undoRegistry = new Map();
let undoSeq = 0;

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

// ---------------------------------------------------------------- служебные строки в ленте

// Маленькая ненавязчивая строка в ленте чата (tool-события, обрыв, отмена) —
// вместо удалённой статус-строки. shadow DOM → инлайн-стили.
const NOTE_STYLE = "font-size:11px;color:#98a2b3;font-style:italic;margin:2px 0";

function noteHtml(text, key) {
  const attr = key != null ? ` data-note-key="${key}"` : "";
  return `<div class="assistant-note"${attr} style="${NOTE_STYLE}">${escapeHtml(text)}</div>`;
}

function addNote(text) {
  const chat = chatEl();
  if (chat && typeof chat.addMessage === "function") {
    chat.addMessage({ role: "ai", html: noteHtml(text) });
  }
}

// tool start → строка в ленте с уникальным ключом; done/error — мутация её
// текста (как undo: элемент ищется в shadowRoot компонента, в тестах — в моке).
let noteSeq = 0;
const openToolNotes = [];  // [{key, name}] — стек незавершённых вызовов

function showToolEvent(name, status) {
  const chat = chatEl();
  if (!chat || typeof chat.addMessage !== "function") return;
  if (status === "start") {
    const key = String(++noteSeq);
    openToolNotes.push({ key, name });
    chat.addMessage({ role: "ai", html: noteHtml(`вызывает инструмент: ${name}…`, key) });
    return;
  }
  const open = openToolNotes.pop();
  if (!open) return;
  const root = chat.shadowRoot || chat;
  const el = root.querySelector(`[data-note-key="${open.key}"]`);
  if (el) {
    el.textContent = status === "error"
      ? `инструмент ${open.name}: ошибка`
      : `инструмент ${open.name}: готово`;
  }
}

// ---------------------------------------------------------------- история

export function resetHistory() {
  history = [];
  undoRegistry.clear();
  openToolNotes.length = 0;
  const el = chatEl();
  if (el && typeof el.clearMessages === "function") el.clearMessages();
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
// тестируется без DOM и без deep-chat.
export function parseSseChunk(chunk) {
  const events = [];
  for (const line of chunk.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* пропуск */ }
  }
  return events;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Ошибка красным html-пузырём. В deep-chat onResponse({error}) до первого
// токена падает внутри компонента (finaliseStreamedMessage без контента),
// поэтому pre-stream ошибки отдаём html с инлайн-стилем (shadow DOM).
function errorHtml(msg) {
  return `<div style="color:#b42318">⚠ ${escapeHtml(msg)}</div>`;
}

// thinking → сворачиваемый html-блок. Вставляется отдельным сообщением ДО
// начала стриминга ответа (thinking-события всегда предшествуют токенам).
// Компонент рендерит html внутри shadow DOM — только инлайн-стили.
function thinkingHtml(text) {
  return `<details class="assistant-thinking" style="font-size:12px;color:#667085;margin-bottom:4px">` +
    `<summary style="cursor:pointer;font-style:italic;color:#98a2b3">Рассуждение</summary>` +
    `<div style="margin-top:4px;padding:6px 8px;background:#f4f6fa;border-left:2px solid #d3d9e4;` +
    `border-radius:4px;font-style:italic;white-space:pre-wrap;word-break:break-word">` +
    escapeHtml(text) + `</div></details>`;
}

// ---------------------------------------------------------------- отправка

// signals — deep-chat handler-сигналы {onOpen, onResponse, onClose}; в тестах
// подменяются моком. Без signals (нет компонента) — ответ просто копится.
export async function sendMessage(text, signals) {
  if (streaming) return;
  text = (text || "").trim();
  if (!text) return;
  const chat = chatEl();
  const sig = signals || null;
  if (!selectedModel) {
    const msg = "Выберите chat-модель внизу панели (локальная sglang/llamacpp или облачная ☁).";
    if (sig) {
      sig.onOpen();
      await sig.onResponse({ html: errorHtml(msg) });
      sig.onClose();
    } else if (chat && typeof chat.addMessage === "function") {
      chat.addMessage({ error: msg });
    }
    return;
  }
  streaming = true;
  history.push({ role: "user", content: text });

  let answerText = "";
  let thinkingText = "";
  let thinkingShown = false;
  let streamOpen = false;
  let finished = false;
  let aborted = false;
  let closed = false;

  const controller = new AbortController();
  const closeStream = () => {
    if (sig && streamOpen && !closed) { closed = true; sig.onClose(); }
  };
  // Во время стрима deep-chat показывает stop-кнопку; клик — отмена запроса.
  // Ручная отмена — штатный сценарий: частичный текст остаётся, без «соединение
  // прервано».
  if (sig && sig.stopClicked) {
    sig.stopClicked.listener = () => {
      aborted = true;
      controller.abort();
      closeStream();
    };
  }

  const openStream = () => {
    if (!sig || streamOpen) return;
    if (thinkingText && !thinkingShown) {
      thinkingShown = true;
      if (chat && typeof chat.addMessage === "function") {
        chat.addMessage({ role: "ai", html: thinkingHtml(thinkingText) });
      }
    }
    sig.onOpen();
    streamOpen = true;
  };
  // Ошибка: после токенов deep-chat рисует родной error-пузырь, до первого
  // токена onResponse({error}) внутри компонента падает — отдаём html.
  const emitError = async (msg) => {
    if (!sig) {
      if (chat && typeof chat.addMessage === "function") chat.addMessage({ error: msg });
      return;
    }
    if (streamOpen && answerText) {
      await sig.onResponse({ error: msg });
      return;
    }
    openStream();
    await sig.onResponse({ html: errorHtml(msg) });
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
      const msg = data.detail || `Ошибка ${resp.status}`;
      await emitError(msg);
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
              openStream();
              answerText += ev.text || "";
              if (sig) await sig.onResponse({ text: ev.text || "" });
            } else if (ev.type === "thinking") {
              thinkingText += ev.text || "";
            } else if (ev.type === "tool") {
              showToolEvent(ev.name, ev.status);  // строка в ленте, обновится по done
            } else if (ev.type === "trial") {
              handleTrial(ev.trial);  // карточка-таблица в панели, UI не мутируется
            } else if (ev.type === "proposal") {
              handleProposal(ev.proposal);  // авто-применение, карточка в панели
            } else if (ev.type === "done") {
              finished = true;
            } else if (ev.type === "error") {
              await emitError(ev.message || "Ошибка ассистента");
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
      await emitError(e.message || String(e));
      finished = true;
    }
  }
  if (aborted && reader) { try { await reader.cancel(); } catch { /* уже закрыт */ } }
  if (sig && sig.stopClicked) sig.stopClicked.listener = null;
  closeStream();
  if (aborted) addNote("остановлено пользователем");
  if (answerText.trim()) history.push({ role: "assistant", content: answerText });
  streaming = false;
}

// ---------------------------------------------------------------- пробный прогон

// Карточка-таблица «Пробный прогон» (событие trial от run_trial): модель ×
// вопрос → ответ с уверенностью. Только показ — состояние приложения не меняется.
// Карточка — html-сообщение в ленте чата (shadow DOM → только инлайн-стили,
// классы оставлены как семантические хуки для тестов).
const TRIAL_CELL = "border:1px solid #e4e7ec;padding:3px 6px;text-align:left;word-break:break-word";
const TRIAL_HEAD = TRIAL_CELL + ";color:#667085;font-weight:600;background:#f7f8fa";

export function trialHtml(trial) {
  const qs = trial.questions || [];
  let head = `<th style="${TRIAL_HEAD}">модель</th>`;
  for (const q of qs) {
    head += `<th style="${TRIAL_HEAD}" title="${escapeHtml(q.question || q.id)}">` +
      escapeHtml(truncate(q.question || q.id, 40)) + `</th>`;
  }
  let rows = "";
  for (const row of trial.rows || []) {
    rows += `<tr><td style="${TRIAL_CELL}">${escapeHtml(row.label || row.model)}</td>`;
    if (row.error) {
      rows += `<td class="assistant-trial-error" colspan="${Math.max(qs.length, 1)}" ` +
        `style="${TRIAL_CELL};color:#b42318">⚠ ${escapeHtml(row.error)}</td>`;
    } else {
      for (const q of qs) {
        rows += `<td style="${TRIAL_CELL}">${escapeHtml((row.answers || {})[q.id] || "—")}</td>`;
      }
    }
    rows += "</tr>";
  }
  return `<div class="assistant-proposal assistant-trial" style="${CARD_STYLE}">` +
    `<div class="assistant-proposal-title" style="${CARD_TITLE_STYLE}">Пробный прогон</div>` +
    `<table class="assistant-trial-table" style="border-collapse:collapse;font-size:12px;width:100%">` +
    `<tr>${head}</tr>${rows}</table>` +
    (trial.note
      ? `<div class="assistant-proposal-preview" style="${CARD_PREVIEW_STYLE}">${escapeHtml(trial.note)}</div>`
      : "") +
    `</div>`;
}

export function handleTrial(trial) {
  if (!trial) return null;
  const html = trialHtml(trial);
  const chat = chatEl();
  if (chat && typeof chat.addMessage === "function") chat.addMessage({ role: "ai", html });
  return html;
}

// ---------------------------------------------------------------- proposal-карточки

// Карточки живут в ленте чата внутри shadow DOM — CSS из style.css туда не
// проникает, поэтому стили инлайн; классы — семантические хуки (тесты, биндинг
// кнопки «Отменить» через htmlClassUtilities).
const CARD_STYLE = "background:#fff;border:1px solid #d0d5dd;border-radius:10px;" +
  "padding:10px;display:flex;flex-direction:column;gap:8px;font-size:13px;color:#1d2939";
const CARD_TITLE_STYLE = "font-weight:600;font-size:13px";
const CARD_PREVIEW_STYLE = "font-size:12px;color:#667085;white-space:pre-wrap;word-break:break-word;" +
  "max-height:160px;overflow-y:auto;background:#f7f8fa;border-radius:6px;padding:6px 8px";
const CARD_STATUS_STYLE = "font-size:12px;font-weight:600";
const CARD_ERROR_STYLE = "font-size:12px;color:#b42318";
const UNDO_BTN_STYLE = "font-size:12px;padding:3px 10px;border:1px solid #d0d5dd;border-radius:6px;" +
  "background:#fff;color:#667085;cursor:pointer";

const STATUS_COLORS = { applied: "#12b76a", undone: "#98a2b3", declined: "#98a2b3" };

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

// html карточки-записи о применённом предложении. undoKey — ключ в
// undoRegistry; без него кнопки «Отменить» нет (run/preset неотменяемы).
function proposalCardHtml(proposal, { statusText, statusCls, errorText, undoKey }) {
  const color = STATUS_COLORS[statusCls] || STATUS_COLORS.declined;
  return `<div class="assistant-proposal" data-proposal-id="${escapeHtml(proposal.id || "")}" style="${CARD_STYLE}">` +
    `<div class="assistant-proposal-title" style="${CARD_TITLE_STYLE}">` +
    escapeHtml(proposal.title || proposal.kind) + `</div>` +
    `<div class="assistant-proposal-preview" style="${CARD_PREVIEW_STYLE}">` +
    escapeHtml(proposalPreview(proposal)) + `</div>` +
    `<div class="assistant-proposal-status ${statusCls}" style="${CARD_STATUS_STYLE};color:${color}">` +
    escapeHtml(statusText) + `</div>` +
    (errorText
      ? `<div class="assistant-proposal-error" style="${CARD_ERROR_STYLE}">${escapeHtml(errorText)}</div>`
      : "") +
    (undoKey != null
      ? `<div class="assistant-proposal-actions">` +
        `<button type="button" class="assistant-undo" data-undo-key="${undoKey}" ` +
        `style="${UNDO_BTN_STYLE}">Отменить</button></div>`
      : "") +
    `</div>`;
}

// Клик по «Отменить» внутри shadow DOM (привязка — htmlClassUtilities в
// setupChat): откат по замыканию из undoRegistry, статус карточки меняем
// прямо в DOM сообщения.
function handleUndoEvent(event) {
  const btn = event.target;
  const key = btn && btn.dataset ? btn.dataset.undoKey : null;
  const entry = key != null ? undoRegistry.get(String(key)) : null;
  if (!btn || !entry || entry.done) return;
  const card = btn.closest(".assistant-proposal");
  try {
    entry.undo();
    entry.done = true;
    const status = card && card.querySelector(".assistant-proposal-status");
    if (status) {
      status.textContent = "Отменено";
      status.className = "assistant-proposal-status undone";
      status.style.color = STATUS_COLORS.undone;
    }
    btn.remove();
  } catch (e) {
    if (card) {
      let err = card.querySelector(".assistant-proposal-error");
      if (!err) {
        err = document.createElement("div");
        err.className = "assistant-proposal-error";
        err.style.cssText = CARD_ERROR_STYLE;
        card.appendChild(err);
      }
      err.textContent = e.message || String(e);
    }
  }
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

// Авто-применение: сразу применяем, карточка-запись — html-сообщением в ленте
// чата (поток событий). При ошибке применения карточка показывает текст ошибки
// (изменений нет). Возвращает html карточки.
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
  let undoKey = null;
  if (undo) {
    undoKey = String(++undoSeq);
    undoRegistry.set(undoKey, { undo, done: false });
  }
  const html = proposalCardHtml(proposal, { statusText, statusCls, errorText, undoKey });
  const chat = chatEl();
  if (chat && typeof chat.addMessage === "function") chat.addMessage({ role: "ai", html });
  return html;
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

// ---------------------------------------------------------------- deep-chat

// handler вызывается компонентом на каждое сообщение пользователя.
// body.messages — массив {role, text}; отвечаем через signals.
async function chatHandler(body, signals) {
  const msgs = (body && body.messages) || [];
  const last = msgs[msgs.length - 1] || {};
  await sendMessage(last.text || "", signals);
}

function setupChat() {
  const el = chatEl();
  if (!el) return;
  el.connect = { handler: (body, signals) => { chatHandler(body, signals); }, stream: true };
  // Реплики ассистента — без фона и на всю ширину, кегль на пункт меньше
  // дефолта бандла (14px → 13px). Реплики пользователя (синие плашки) и
  // error-пузыри (класс error-message-text со своим фоном) не трогаем.
  el.messageStyles = {
    default: {
      ai: {
        bubble: { backgroundColor: "transparent", maxWidth: "100%", width: "100%",
                  fontSize: "13px", lineHeight: "1.45", padding: "4px 2px" },
        outerContainer: { width: "100%" },
        innerContainer: { width: "100%" },
      },
    },
  };
  // loading-пузырь наследует ai-стили (прозрачный, 100%): точкам «печатает…»
  // возвращаем отступы бандла (контейнер точек имеет padding-inline-start 1.3em,
  // но наш bubble padding 2px его перекрывал → левая точка клипалась).
  el.auxiliaryStyle = `
    .deep-chat-loading-message-dots-container { padding: 8px 14px !important; }
    .loading-message-dots { margin-inline-start: .7em; margin-inline-end: .2em; }
    @keyframes dq-spin { to { transform: rotate(360deg); } }
    .loading-button svg { animation: dq-spin 1s linear infinite; }
  `;
  el.textInput = {
    placeholder: { text: "Сообщение ассистенту… (Enter — отправить)" },
    styles: {
      container: { borderRadius: "10px", border: "1px solid #d0d5dd",
                   backgroundColor: "#ffffff", padding: "4px 6px" },
      text: { fontSize: "13px" },
    },
  };
  // Зона ввода и футерная строка контролов (.assistant-footer) — один фон,
  // визуально единый блок внизу панели.
  el.inputAreaStyle = { backgroundColor: "#f7f8fa" };
  el.avatars = false;
  el.names = false;
  // Кнопка отправки: явный круг 32px. «Отправить» — белый paper-plane на
  // синем, «стоп» (во время стрима) — белый квадрат на красном. Иконки —
  // кастомный svg (styles заданы явно, чтобы не «плыли» внутри круга).
  const PLANE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white">' +
    '<path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>';
  const STOP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white">' +
    '<rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  const SPINNER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">' +
    '<circle cx="12" cy="12" r="9" stroke="white" stroke-opacity="0.35" stroke-width="3"/>' +
    '<path d="M21 12a9 9 0 0 0-9-9" stroke="white" stroke-width="3" stroke-linecap="round"/></svg>';
  const BTN_CONTAINER = {
    width: "32px", height: "32px", borderRadius: "50%",
    display: "flex", alignItems: "center", justifyContent: "center",
  };
  el.submitButtonStyles = {
    submit: {
      container: {
        default: { ...BTN_CONTAINER, backgroundColor: "#4a7dff" },
        hover: { backgroundColor: "#3b6be0" },
        click: { backgroundColor: "#2f5ac8" },
      },
      svg: { content: PLANE_SVG, styles: { default: { width: "15px", height: "15px" } } },
    },
    loading: {
      container: { default: { ...BTN_CONTAINER, backgroundColor: "#4a7dff" } },
      svg: { content: SPINNER_SVG, styles: { default: { width: "16px", height: "16px" } } },
    },
    stop: {
      container: {
        default: { ...BTN_CONTAINER, backgroundColor: "#d92d20" },
        hover: { backgroundColor: "#b42318" },
        click: { backgroundColor: "#912018" },
      },
      svg: { content: STOP_SVG, styles: { default: { width: "13px", height: "13px" } } },
    },
    disabled: {
      container: { default: { ...BTN_CONTAINER, backgroundColor: "#c3d0f5" } },
    },
  };
  // Клик по «Отменить» на proposal-карточке внутри shadow DOM.
  el.htmlClassUtilities = {
    "assistant-undo": { events: { click: (event) => handleUndoEvent(event) } },
  };
}

// ---------------------------------------------------------------- init

export function initAssistant() {
  history = [];
  chatModels = [];
  selectedModel = null;
  streaming = false;

  // web component регистрируется из вендоренного бандла; в тестовом
  // DOM-моке customElements нет — импорт падает, чат работает через мок signals.
  import("./vendor/deep-chat/deepChat.bundle.js").then(setupChat).catch(() => setupChat());

  document.getElementById("tb-assistant").addEventListener("click", () => togglePanel());
  document.getElementById("assistant-close").addEventListener("click", () => closePanel());
  document.getElementById("assistant-reset").addEventListener("click", () => resetHistory());
  document.getElementById("assistant-model").addEventListener("change", (e) => {
    selectedModel = e.target.value;
  });
  initResize();
  setupChat();
  // свежие статусы моделей от поллинга toolbar — обновляем пометки «не запущена»
  subscribe((event) => { if (event === "models") renderModelOptions(); });
  loadModels();
}
