// Разметка результатов прогонов (review marks): вердикт ✓ верно / ✗ ошибка /
// ? спорно + комментарий на строках и ячейках результатов, чипах прогонов и
// решений, строках файлов и ячейках пакета. Хранение: state.results.marks
// (одиночный) и state.batch.marks (пакет) — пометки едут вместе с результатами
// в файл сессии и сбрасываются вместе с ними. UI: hover-триада (строки, ячейки,
// чипы, заголовки файлов), постоянные бейджи, поповер комментария (z-index 405
// — доступен на демо-шагах тура), ревью-тулбар в шапке результатов (счётчики,
// фильтр, глобальный тоггл 👁 «показать/скрыть разметку», localStorage
// dq-review-visible), одноклавишные хоткеи по e.code (раскладконезависимы),
// undo — U и Ctrl/Cmd+Z, undo-стек на 10 операций. Обновление DOM — точечное
// по data-review-key, без полного перерендера результатов (иначе слетают hover
// и дрилдауны).

import { state, emit, subscribe } from "./state.js";
import { isHelpOpen } from "./help.js";
import { isLightboxOpen } from "./lightbox.js";
import { isPreviewOpen } from "./preview.js";
import { flattenRuns, resultQuestions } from "./results.js";

export const MARKS_VERSION = 1;
const UNDO_LIMIT = 10;
const VISIBLE_KEY = "dq-review-visible"; // тоггл «показывать разметку» (дефолт — показана)
const HINT_KEY = "dq-review-hint-seen";  // одноразовая подсказка

const VERDICTS = ["accept", "reject", "unsure"];
const VERDICT_ICON = { accept: "✓", reject: "✗", unsure: "?" };
const VERDICT_LABEL = { accept: "Верно", reject: "Ошибка", unsure: "Спорно" };
const VERDICT_HOTKEY = { accept: "1", reject: "2", unsure: "3" };

const FILTERS = [
  { id: "all", label: "Все" },
  { id: "reject", label: "✗ Ошибки" },
  { id: "unsure", label: "? Спорные" },
  { id: "comment", label: "💬 С комментариями" },
  { id: "unmarked", label: "⚪ Без отметок" },
  { id: "disagree", label: "⚡ Расхождения" },
];

function genMarkId() { return "m_" + Math.random().toString(36).slice(2, 8); }
function nowIso() { return new Date().toISOString(); }

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

// ---------------------------------------------------------------- ключи целей

// Ключ цели — фиксированный формат с явным сегментом уровня (уровни не
// коллидируют: пометка «прогон» и «решение этого прогона» — разные ключи).
export function targetKey(t) {
  if (t.scope === "single") {
    if (t.decision) return `single|dec|${t.model}|${t.mode}`;
    if (t.question) {
      return t.model != null
        ? `single|cell|${t.model}|${t.mode}|${t.question}`
        : `single|q|${t.question}`;
    }
    return `single|run|${t.model}|${t.mode}`;
  }
  if (t.decision) return `batch|dec|${t.file}|${t.model}`;
  if (t.question) return `batch|cell|${t.file}|${t.question}|${t.model}`;
  if (t.file) return `batch|file|${t.file}`;
  return `batch|model|${t.model}`;
}

// ---------------------------------------------------------------- хранилище

function marksOf(scope) {
  if (scope === "single") return (state.results && state.results.marks) || [];
  return state.batch.marks || [];
}

// Мутабельная ссылка на массив пометок (создаётся при первом использовании);
// null — разметке не к чему привязаться (нет результатов).
function marksStore(scope) {
  if (scope === "single") {
    if (!state.results) return null;
    if (!Array.isArray(state.results.marks)) state.results.marks = [];
    return state.results.marks;
  }
  if (!Array.isArray(state.batch.marks)) state.batch.marks = [];
  return state.batch.marks;
}

export function findMark(scope, target) {
  const key = targetKey(target);
  return marksOf(scope).find(m => m.target && targetKey(m.target) === key) || null;
}

// Число пометок/комментариев — для confirm перед перепрогоном.
export function marksCount(scope) {
  const marks = marksOf(scope);
  return { marks: marks.length, comments: marks.filter(m => m.comment).length };
}

// Валидация пометок из импорта: известный verdict, объект target нужного scope.
// Битые записи пропускаются с console.warn (защитная обработка импорта — без модалок).
export function sanitizeMarks(list, scope) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== "object" || !m.target || typeof m.target !== "object" ||
        m.target.scope !== scope ||
        (m.verdict != null && !VERDICTS.includes(m.verdict))) {
      console.warn("review: пропущена битая пометка импорта", m);
      continue;
    }
    out.push({
      id: typeof m.id === "string" ? m.id : genMarkId(),
      target: { ...m.target },
      verdict: m.verdict ?? null,
      comment: typeof m.comment === "string" ? m.comment : "",
      criterion: m.criterion || "correctness",
      author: m.author || "local",
      created_at: m.created_at || nowIso(),
      updated_at: m.updated_at || nowIso(),
    });
  }
  return out;
}

// ---------------------------------------------------------------- CRUD + undo

const undoStack = []; // {scope, key, prev: mark|null}
const filters = { single: "all", batch: "all" };
let parked = null;  // последняя hover-цель {el, scope, target, label} — «паркуется»

function pushUndo(scope, key, prev) {
  undoStack.push({ scope, key, prev: prev ? { ...prev, target: { ...prev.target } } : null });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

export function undo() {
  const op = undoStack.pop();
  if (!op) return false;
  const store = marksStore(op.scope);
  if (!store) return false;
  const idx = store.findIndex(m => m.target && targetKey(m.target) === op.key);
  if (op.prev === null) {
    if (idx >= 0) store.splice(idx, 1);
  } else if (idx >= 0) {
    store[idx] = op.prev;
  } else {
    store.push(op.prev);
  }
  emit("review");
  return true;
}

// Вердикт на цель: новый — создаёт пометку; другой — перезаписывает (бампит
// updated_at); повторный клик по активному — снимает (пометка с комментарием
// остаётся заметкой verdict:null, без комментария — удаляется).
export function setVerdict(scope, target, verdict) {
  const store = marksStore(scope);
  if (!store) return null;
  const key = targetKey(target);
  const idx = store.findIndex(m => m.target && targetKey(m.target) === key);
  pushUndo(scope, key, idx >= 0 ? store[idx] : null);
  const existing = idx >= 0 ? store[idx] : null;
  if (existing && existing.verdict === verdict) {
    if (existing.comment) {
      existing.verdict = null;
      existing.updated_at = nowIso();
    } else {
      store.splice(idx, 1);
    }
  } else if (existing) {
    existing.verdict = verdict;
    existing.updated_at = nowIso();
  } else {
    store.push({
      id: genMarkId(), target: { ...target }, verdict, comment: "",
      criterion: "correctness", author: "local",
      created_at: nowIso(), updated_at: nowIso(),
    });
  }
  emit("review");
  return findMark(scope, target);
}

// Комментарий без вердикта допустим («заметка»); пустой текст у пометки без
// вердикта удаляет её.
export function setComment(scope, target, comment) {
  const store = marksStore(scope);
  if (!store) return null;
  comment = String(comment ?? "").trim();
  const key = targetKey(target);
  const idx = store.findIndex(m => m.target && targetKey(m.target) === key);
  const existing = idx >= 0 ? store[idx] : null;
  if (existing && (existing.comment || "") === comment) return existing; // без изменений
  pushUndo(scope, key, existing);
  if (existing && !comment && !existing.verdict) {
    store.splice(idx, 1);
  } else if (existing) {
    existing.comment = comment;
    existing.updated_at = nowIso();
  } else {
    store.push({
      id: genMarkId(), target: { ...target }, verdict: null, comment,
      criterion: "correctness", author: "local",
      created_at: nowIso(), updated_at: nowIso(),
    });
  }
  emit("review");
  return findMark(scope, target);
}

export function removeMark(scope, target) {
  const store = marksStore(scope);
  if (!store) return;
  const key = targetKey(target);
  const idx = store.findIndex(m => m.target && targetKey(m.target) === key);
  if (idx < 0) return;
  pushUndo(scope, key, store[idx]);
  store.splice(idx, 1);
  emit("review");
}

// ---------------------------------------------------------------- цели и счётчики

// Все размечаемые цели страницы (по результатам целиком — не зависит от
// чипс-фильтра видимости моделей). Пометки вне этого набора — сироты: не
// считаются и не рендерятся, но остаются в данных и попадают в экспорт.
function targetKeys(scope) {
  const keys = new Set();
  if (scope === "single") {
    const rs = state.results;
    if (!rs) return keys;
    const runs = flattenRuns(rs);
    const okRuns = runs.filter(r => r.res && r.res.ok);
    const questions = resultQuestions(rs);
    for (const run of runs) keys.add(targetKey({ scope: "single", model: run.key, mode: run.mode }));
    for (const q of questions) {
      const perRun = okRuns.filter(r => r.res.answers && r.res.answers[q.id]);
      for (const run of perRun) {
        keys.add(targetKey({ scope: "single", model: run.key, mode: run.mode, question: q.id }));
      }
      if (okRuns.length > 1 && perRun.length) keys.add(targetKey({ scope: "single", question: q.id }));
    }
    const d = rs.decision;
    if (d && d.enabled !== false && (d.outcomes || []).length) {
      for (const run of okRuns) keys.add(targetKey({ scope: "single", model: run.key, mode: run.mode, decision: true }));
    }
    return keys;
  }
  const results = state.batch.results || {};
  const questions = (state.batch.questions && state.batch.questions.length)
    ? state.batch.questions : state.questions;
  const bd = state.batch.decision;
  const withDecision = !!(bd && bd.enabled !== false && (bd.outcomes || []).length);
  const modelKeys = new Set();
  for (const f of state.batch.files) {
    const per = results[f.id];
    if (!per) continue;
    let anyOk = false;
    for (const [mk, res] of Object.entries(per)) {
      if (!res || !res.ok) continue;
      anyOk = true;
      modelKeys.add(mk);
      for (const q of questions) {
        if (res.answers && res.answers[q.id]) {
          keys.add(targetKey({ scope: "batch", file: f.id, question: q.id, model: mk }));
        }
      }
      if (withDecision) keys.add(targetKey({ scope: "batch", file: f.id, model: mk, decision: true }));
    }
    if (anyOk) keys.add(targetKey({ scope: "batch", file: f.id }));
  }
  for (const mk of modelKeys) keys.add(targetKey({ scope: "batch", model: mk }));
  return keys;
}

// Счётчики шапки: ✓/✗/? по вердиктам, 💬 — с комментарием, X — цели с пометкой
// любого вида, Y — размечаемых целей на странице. Сироты не входят.
export function counts(scope) {
  const valid = targetKeys(scope);
  const c = { accept: 0, reject: 0, unsure: 0, comments: 0, marked: 0, total: valid.size };
  for (const m of marksOf(scope)) {
    if (!m.target || !valid.has(targetKey(m.target))) continue;
    if (m.verdict === "accept") c.accept += 1;
    else if (m.verdict === "reject") c.reject += 1;
    else if (m.verdict === "unsure") c.unsure += 1;
    if (m.comment) c.comments += 1;
    if (m.verdict || m.comment) c.marked += 1;
  }
  return c;
}

// ---------------------------------------------------------------- разметка доступна?

export function marksEnabled(scope) {
  if (scope === "single") return !!state.results && !state.running;
  return !state.batch.running && Object.keys(state.batch.results || {}).length > 0;
}

// ---------------------------------------------------------------- фильтры

export function setFilter(scope, f) {
  filters[scope] = f;
  refresh(scope);
}

// Сброс без перерисовки (перерендерит вызывающий) — смена страницы/прогон.
export function resetFilter(scope) { filters[scope] = "all"; }

function markPasses(mark, f) {
  if (f === "reject") return !!mark && mark.verdict === "reject";
  if (f === "unsure") return !!mark && mark.verdict === "unsure";
  if (f === "comment") return !!mark && !!mark.comment;
  if (f === "unmarked") return !mark;
  return true; // all / disagree — решается атрибутами строк
}

// Фильтр «⚡ Расхождения» доступен, только когда расхождение определено:
// режим B (≥2 ячеек в строке) или ≥2 видимые модели пакета.
function disagreeAvailable(scope) {
  if (scope === "single") {
    const list = document.getElementById("results-list");
    return !!list && [...list.children].some(r =>
      r.classList && r.classList.contains("res-row") &&
      r.querySelectorAll(".res-cell").length >= 2);
  }
  const chips = document.querySelectorAll("#batch-results .batch-model-chip");
  return [...chips].filter(c => !c.classList.contains("off")).length >= 2;
}

// ---------------------------------------------------------------- триада и бейджи

// Парковка hover-цели для хоткеев (уход курсора цель не сбрасывает).
export function park(el) {
  if (el && el._reviewTarget) {
    parked = { el, scope: el._reviewScope, target: el._reviewTarget, label: el._reviewLabel };
  }
}

function buildTriad(anchor, scope, target, label) {
  const tri = document.createElement("span");
  tri.className = "review-triad";
  for (const v of VERDICTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "review-btn review-" + v;
    b.dataset.verdict = v;
    b.textContent = VERDICT_ICON[v];
    b.title = `${VERDICT_LABEL[v]} (${VERDICT_HOTKEY[v]})`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      setVerdict(scope, target, v);
      flash(anchor);
    });
    tri.appendChild(b);
  }
  const c = document.createElement("button");
  c.type = "button";
  c.className = "review-btn review-comment-btn";
  c.textContent = "💬";
  c.title = "Комментарий (4/C)";
  c.addEventListener("click", (e) => {
    e.stopPropagation();
    openCommentPopover(anchor, scope, target, label);
  });
  tri.appendChild(c);
  return tri;
}

// Краткая вспышка фона цели — подтверждение действия (тостовой системы нет).
function flash(anchor) {
  if (!anchor || !anchor.classList) return;
  anchor.classList.add("review-flash");
  setTimeout(() => anchor.classList.remove("review-flash"), 450);
}

// Точка разметки на элементе результатов. kind: "row" (строка A/B: триада
// hover справа, бейдж в потоке, строка комментария), "cell" (ячейка B/пакета:
// триада и бейдж — absolute-оверлеи, геометрия не меняется), "th" (заголовок
// файла), "chip" (чип прогона/решения/модели: hover-триада над чипом,
// бейдж-суффикс),
// "inline" (статичная триада в дрилдаунах/оверлеях/поповерах).
export function attachTarget(el, scope, target, opts = {}) {
  if (!el || !marksEnabled(scope)) return el;
  const kind = opts.kind || "row";
  const label = opts.label || "";
  el.dataset.reviewKey = targetKey(target);
  el._reviewScope = scope;
  el._reviewKind = kind;
  el._reviewTarget = { ...target };
  el._reviewLabel = label;
  el._reviewCommentLine = kind === "row";
  el.addEventListener("mouseenter", () => {
    parked = { el, scope, target: el._reviewTarget, label };
  });
  if (opts.triad !== false) {
    const tri = buildTriad(el, scope, el._reviewTarget, label);
    tri.classList.add(opts.inline ? "review-triad-inline" : "review-hover-triad");
    el.appendChild(tri);
  }
  if (opts.badge !== false) {
    const badge = document.createElement("span");
    badge.className = "review-badge review-badge-" + kind + " hidden";
    badge.title = "Пометка — клик: комментарий";
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      openCommentPopover(el, scope, el._reviewTarget, label);
    });
    (opts.badgeParent || el).appendChild(badge);
    el._reviewBadge = badge;
  }
  return el;
}

// Статичный редактор пометки (триада всегда видна) — для дрилдауна чипа
// прогона, оверлея решения, поповера статистики модели, подписи дрилдауна.
export function inlineEditorEl(scope, target, label) {
  const el = document.createElement("span");
  el.className = "review-inline";
  attachTarget(el, scope, target, { kind: "inline", inline: true, label, commentLine: false });
  return el;
}

// ---------------------------------------------------------------- точечное обновление

function badgeText(mark) {
  let t = mark.verdict ? VERDICT_ICON[mark.verdict] : "";
  if (mark.comment) t += (t ? " " : "") + "💬1";
  return t || "💬1";
}

function updateMarkEl(el) {
  const scope = el._reviewScope;
  const mark = findMark(scope, el._reviewTarget);
  const badge = el._reviewBadge;
  if (badge) {
    badge.classList.toggle("hidden", !mark);
    badge.textContent = mark ? badgeText(mark) : "";
    for (const v of VERDICTS) badge.classList.remove("review-" + v);
    if (mark && mark.verdict) badge.classList.add("review-" + mark.verdict);
    badge.title = mark && mark.comment ? mark.comment : "Пометка — клик: комментарий";
  }
  for (const v of VERDICTS) el.classList.remove("review-mk-" + v);
  if (mark && mark.verdict) el.classList.add("review-mk-" + mark.verdict);
  // активная кнопка триады
  for (const tri of el.querySelectorAll(".review-triad")) {
    for (const b of tri.querySelectorAll(".review-btn[data-verdict]")) {
      b.classList.toggle("active", !!mark && mark.verdict === b.dataset.verdict);
    }
  }
  // строка комментария (управляется общим тогглом 👁 разметки; полный текст —
  // в поповере)
  if (el._reviewCommentLine) {
    let line = el._reviewLine;
    const parts = [];
    if (marksShown()) {
      if (mark && mark.comment) parts.push(mark.comment);
      for (const cell of el.querySelectorAll("[data-review-key]")) {
        const m = cell._reviewTarget && findMark(scope, cell._reviewTarget);
        if (m && m.comment) parts.push(m.comment);
      }
    }
    if (parts.length) {
      if (!line) {
        line = document.createElement("div");
        line.className = "review-comment-line";
        el.appendChild(line);
        el._reviewLine = line;
      }
      line.textContent = "💬 " + parts.join(" · ");
      line.classList.remove("hidden");
    } else if (line) {
      line.classList.add("hidden");
    }
  }
}

// Разметка показана? Глобальный тоггл 👁 (оба scope): скрывает бейджи,
// триады, строки комментариев и все подсветки review-mk-*.
export function marksShown() {
  return localStorage.getItem(VISIBLE_KEY) !== "0";
}

function applyVisibility() {
  const hidden = !marksShown();
  for (const id of ["results-list", "batch-results"]) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("review-hidden-all", hidden);
  }
}

// ---------------------------------------------------------------- фильтры в DOM

// Одиночный режим: строки скрываются; в режиме B неподходящие ячейки глушатся.
function rowVisibleSingle(row, f) {
  if (f === "all") return true;
  if (f === "disagree") return row.classList.contains("diff");
  const own = findMark("single", row._reviewTarget);
  const cells = row.querySelectorAll("[data-review-key]");
  if (f === "unmarked") {
    if (!own) return true;
    return [...cells].some(c => !findMark("single", c._reviewTarget));
  }
  if (markPasses(own, f)) return true;
  return [...cells].some(c => markPasses(findMark("single", c._reviewTarget), f));
}

// Пакет: ячейки глушатся (сетка сохраняет геометрию), строки файлов без
// попаданий скрываются целиком (вместе с дрилдауном), «Итого» остаётся.
function applyFilterBatch(wrap, f) {
  const tbody = wrap.querySelector("tbody");
  if (!tbody) return { shown: 0, total: 0 };
  let shown = 0, total = 0;
  let hideDetail = false;
  for (const tr of tbody.children) {
    if (tr.classList.contains("batch-agg-row")) continue;
    if (tr.classList.contains("batch-detail-row")) {
      tr.classList.toggle("review-hidden", hideDetail);
      continue;
    }
    const th = tr.querySelector("th.batch-file-th");
    if (!th || !th._reviewTarget) continue;
    total += 1;
    const cells = [...tr.querySelectorAll("[data-review-key]")].filter(c => c !== th);
    let visible;
    if (f === "all") visible = true;
    else if (f === "disagree") visible = cells.some(c => c.dataset.reviewDisagree === "1");
    else if (f === "unmarked") visible = cells.some(c => !findMark("batch", c._reviewTarget));
    else {
      visible = markPasses(findMark("batch", th._reviewTarget), f) ||
        cells.some(c => markPasses(findMark("batch", c._reviewTarget), f));
    }
    tr.classList.toggle("review-hidden", !visible);
    hideDetail = !visible;
    if (visible) shown += 1;
    for (const c of cells) {
      let dim = false;
      if (f === "disagree") dim = c.dataset.reviewDisagree !== "1";
      else if (f !== "all" && f !== "unmarked") dim = !markPasses(findMark("batch", c._reviewTarget), f);
      c.classList.toggle("review-dim", dim);
    }
  }
  const aggTh = tbody.querySelector(".batch-agg-row th");
  if (aggTh) aggTh.textContent = f === "all" ? "Итого" : "Итого · фильтр активен";
  return { shown, total };
}

function applyFilterUi(scope) {
  const f = filters[scope];
  if (scope === "single") {
    const list = document.getElementById("results-list");
    if (!list) return { shown: 0, total: 0 };
    let shown = 0, total = 0;
    let lastRowHidden = false;
    for (const child of list.children) {
      if (!child.classList) continue;
      // открытый дрилдаун следует за своей строкой
      if (child.classList.contains("res-detail")) {
        child.classList.toggle("review-hidden", lastRowHidden);
        continue;
      }
      if (!child.classList.contains("res-row")) continue;
      total += 1;
      const visible = rowVisibleSingle(child, f);
      child.classList.toggle("review-hidden", !visible);
      lastRowHidden = !visible;
      if (visible) shown += 1;
      for (const cell of child.querySelectorAll("[data-review-key]")) {
        const dim = f !== "all" && f !== "unmarked" && f !== "disagree" &&
          !markPasses(findMark("single", cell._reviewTarget), f);
        cell.classList.toggle("review-dim", dim);
      }
    }
    return { shown, total };
  }
  const wrap = document.getElementById("batch-results");
  if (!wrap) return { shown: 0, total: 0 };
  return applyFilterBatch(wrap, f);
}

// ---------------------------------------------------------------- ревью-тулбар

const TOOLBAR_ID = { single: "review-bar", batch: "review-bar-batch" };

// Монтирование тулбара разметки: одиночный — строка в #results-sticky (перед
// #both-hint), пакет — в #batch-results между сводкой и чипсами моделей.
export function mountToolbar(scope, parent, before) {
  let bar = document.getElementById(TOOLBAR_ID[scope]);
  if (!bar) {
    bar = document.createElement("div");
    bar.id = TOOLBAR_ID[scope];
    bar.className = "review-bar";
    parent.insertBefore(bar, before || null);
  }
  renderToolbar(scope);
  return bar;
}

function renderToolbar(scope) {
  const bar = document.getElementById(TOOLBAR_ID[scope]);
  if (!bar) return;
  bar.innerHTML = "";
  const c = counts(scope);
  const cnt = document.createElement("span");
  cnt.className = "review-counts";
  if (c.marked === 0) {
    cnt.textContent = `Разметка: 0 из ${c.total}`;
  } else {
    const parts = [];
    if (c.accept) parts.push(`✓${c.accept}`);
    if (c.reject) parts.push(`✗${c.reject}`);
    if (c.unsure) parts.push(`?${c.unsure}`);
    if (c.comments) parts.push(`💬${c.comments}`);
    cnt.textContent = `${parts.join(" ")} · размечено ${c.marked} из ${c.total}`;
  }
  bar.appendChild(cnt);

  const f = filters[scope];
  const vis = applyFilterUi._last ? applyFilterUi._last[scope] : null;
  if (f !== "all") {
    const chip = document.createElement("span");
    chip.className = "review-filter-chip";
    chip.textContent = (FILTERS.find(x => x.id === f) || {}).label || f;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "review-filter-clear";
    x.textContent = "✕";
    x.title = "Сбросить фильтр";
    x.addEventListener("click", (e) => { e.stopPropagation(); setFilter(scope, "all"); });
    chip.appendChild(x);
    bar.appendChild(chip);
    if (vis && f !== "all") {
      const shown = document.createElement("span");
      shown.className = "review-shown";
      shown.textContent = `показано ${vis.shown} из ${vis.total}`;
      bar.appendChild(shown);
    }
  }

  // фильтр — menu-dropdown (паттерн меню тулбара)
  const menuWrap = document.createElement("span");
  menuWrap.className = "menu-wrap review-filter-wrap";
  const fBtn = document.createElement("button");
  fBtn.type = "button";
  fBtn.className = "btn btn-small review-filter-btn";
  fBtn.textContent = `Фильтр: ${(FILTERS.find(x => x.id === f) || FILTERS[0]).label} ▾`;
  const dd = document.createElement("div");
  dd.className = "menu-dropdown hidden";
  const canDisagree = disagreeAvailable(scope);
  for (const fi of FILTERS) {
    const item = document.createElement("div");
    const disabled = fi.id === "disagree" && !canDisagree;
    item.className = "menu-item" + (disabled ? " menu-item-disabled" : "");
    item.textContent = (fi.id === f ? "✓ " : "") + fi.label;
    if (disabled) {
      item.title = "расхождение не определено: один прогон или одна видимая модель";
    } else {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        dd.classList.add("hidden");
        setFilter(scope, fi.id);
      });
    }
    dd.appendChild(item);
  }
  fBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dd.classList.toggle("hidden");
  });
  menuWrap.append(fBtn, dd);
  bar.appendChild(menuWrap);

  // тоггл показа разметки (персист в localStorage, дефолт — показана)
  const visBtn = document.createElement("button");
  visBtn.type = "button";
  visBtn.className = "icon-btn review-visibility-toggle" + (marksShown() ? " active" : "");
  visBtn.title = "Показать/скрыть разметку (бейджи, триады, подсветку, комментарии)";
  visBtn.innerHTML =
    '<svg class="type-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  visBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    localStorage.setItem(VISIBLE_KEY, marksShown() ? "0" : "1");
    applyVisibility();
    refresh("single");
    refresh("batch");
  });
  bar.appendChild(visBtn);
}

// Полное точечное обновление страницы результатов после изменения разметки:
// бейджи/кромки/триады по data-review-key, фильтры, тулбар. Без renderResults().
export function refresh(scope) {
  for (const el of document.querySelectorAll("[data-review-key]")) {
    if (el._reviewScope === scope) updateMarkEl(el);
  }
  applyFilterUi._last = applyFilterUi._last || {};
  applyFilterUi._last[scope] = applyFilterUi(scope);
  renderToolbar(scope);
  updatePopVerdict();
}

// ---------------------------------------------------------------- поповер комментария

let pop = null; // {el, ctx, ta, meta, verdictText, buttons, scope, target, label}

function buildPopover() {
  const el = document.createElement("div");
  el.className = "popover review-popover hidden";
  const ctx = document.createElement("div");
  ctx.className = "review-pop-context";
  el.appendChild(ctx);
  const triadRow = document.createElement("div");
  triadRow.className = "review-pop-triad";
  const buttons = {};
  for (const v of VERDICTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "review-btn review-" + v;
    b.dataset.verdict = v;
    b.textContent = VERDICT_ICON[v];
    b.title = `${VERDICT_LABEL[v]} (${VERDICT_HOTKEY[v]})`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (pop) setVerdict(pop.scope, pop.target, v);
    });
    buttons[v] = b;
    triadRow.appendChild(b);
  }
  const verdictText = document.createElement("span");
  verdictText.className = "review-pop-verdict";
  triadRow.appendChild(verdictText);
  el.appendChild(triadRow);
  const ta = document.createElement("textarea");
  ta.className = "review-pop-text";
  ta.placeholder = "Комментарий…";
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault && e.preventDefault();
      closePopover(true);
    }
  });
  el.appendChild(ta);
  const meta = document.createElement("div");
  meta.className = "review-pop-meta";
  el.appendChild(meta);
  const actions = document.createElement("div");
  actions.className = "review-pop-actions";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-small btn-danger";
  remove.textContent = "Снять пометку";
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!pop) return;
    const { scope, target } = pop;
    closePopover(false);
    removeMark(scope, target);
  });
  const done = document.createElement("button");
  done.type = "button";
  done.className = "btn btn-small btn-primary";
  done.textContent = "Готово ✓";
  done.addEventListener("click", (e) => {
    e.stopPropagation();
    closePopover(true);
  });
  actions.append(remove, done);
  el.appendChild(actions);
  document.body.appendChild(el);
  pop = { el, ctx, ta, meta, verdictText, buttons, scope: null, target: null, label: "" };
}

export function isPopoverOpen() {
  return !!(pop && !pop.el.classList.contains("hidden"));
}

export function openCommentPopover(anchor, scope, target, label) {
  if (!marksEnabled(scope)) return;
  if (isPopoverOpen()) closePopover(true); // прежний — сохранить текст
  if (!pop) buildPopover();
  if (pop.el.parentNode !== document.body) document.body.appendChild(pop.el);
  pop.scope = scope;
  pop.target = { ...target };
  pop.label = label || "";
  const mark = findMark(scope, target);
  pop.ctx.textContent = pop.label || "пометка";
  pop.ta.value = (mark && mark.comment) || "";
  updatePopMeta(mark);
  updatePopVerdict();
  pop.el.classList.remove("hidden");
  const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect()
    : { left: 40, bottom: 40, right: 100, top: 20 };
  const w = pop.el.offsetWidth || 320;
  const h = pop.el.offsetHeight || 200;
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  const left = Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8));
  let top = r.bottom + 6;
  if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
  pop.el.style.left = left + "px";
  pop.el.style.top = top + "px";
  parked = { el: anchor, scope, target: pop.target, label: pop.label };
  if (pop.ta.focus) pop.ta.focus();
}

// Закрытие: Esc, клик вне, «Готово», Ctrl/Cmd+Enter, скролл/ресайз — все
// сохраняют текст (нет режима «отменить ввод»: пустой текст = нет комментария).
export function closePopover(save) {
  if (!isPopoverOpen()) return;
  if (save) setComment(pop.scope, pop.target, pop.ta.value);
  pop.el.classList.add("hidden");
}

function updatePopVerdict() {
  if (!pop || !pop.scope) return;
  const mark = findMark(pop.scope, pop.target);
  for (const v of VERDICTS) {
    pop.buttons[v].classList.toggle("active", !!mark && mark.verdict === v);
  }
  pop.verdictText.textContent = mark && mark.verdict
    ? "вердикт: " + VERDICT_LABEL[mark.verdict]
    : mark && mark.comment ? "заметка без вердикта" : "";
  updatePopMeta(mark);
}

function updatePopMeta(mark) {
  if (!pop) return;
  pop.meta.textContent = mark
    ? `${mark.author || "local"} · создано ${fmtTime(mark.created_at)} · изменено ${fmtTime(mark.updated_at)}`
    : "";
}

// ---------------------------------------------------------------- одноразовая подсказка

// Показывается один раз при первом реальном (не тур, не демо — у демо нет
// fingerprint) появлении результатов; «Понятно» и клик вне ставят флаг.
export function maybeShowHint() {
  if (localStorage.getItem(HINT_KEY)) return;
  if (typeof isHelpOpen === "function" && isHelpOpen()) return;
  if (!state.results || !state.resultsMeta) return;
  const list = document.getElementById("results-list");
  if (!list || !list.querySelector(".res-row")) return;
  if (document.getElementById("review-hint")) return;
  const hint = document.createElement("div");
  hint.id = "review-hint";
  hint.className = "popover review-hint";
  const text = document.createElement("div");
  text.className = "review-hint-text";
  text.textContent = "Наведите курсор на строку результатов — там ✓/✗/? и 💬. Клавиши 1/2/3, отмена — U.";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "btn btn-small btn-primary";
  ok.textContent = "Понятно";
  ok.addEventListener("click", (e) => { e.stopPropagation(); dismissHint(); });
  hint.append(text, ok);
  document.body.appendChild(hint);
  const r = list.children[0].getBoundingClientRect();
  hint.style.left = Math.max(8, r.left) + "px";
  hint.style.top = (r.bottom + 6) + "px";
}

function dismissHint() {
  localStorage.setItem(HINT_KEY, "1");
  const hint = document.getElementById("review-hint");
  if (hint) hint.remove();
}

// ---------------------------------------------------------------- хоткеи

function hotkeyBlocked(e) {
  const t = e.target;
  const tag = t && t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t && t.closest && t.closest(".cm-focused")) return true;
  if (state.running || state.batch.running) return true;
  if (isHelpOpen()) return true;
  if (isLightboxOpen() || isPreviewOpen()) return true;
  if (document.querySelector(".preset-dialog-overlay")) return true; // диалоги «Сохранить как…», пресеты, генерация
  return false;
}

// Цель хоткея: открытый поповер комментария (его цель), иначе припаркованная
// hover-цель. Пометка должна ссылаться на живую цель текущих результатов.
function hotkeyTarget() {
  if (isPopoverOpen() && pop.scope) return { scope: pop.scope, target: pop.target, el: pop.el, label: pop.label };
  if (!parked) return null;
  if (!marksEnabled(parked.scope)) return null;
  if (!targetKeys(parked.scope).has(targetKey(parked.target))) return null;
  return parked;
}

function onKeydown(e) {
  const code = e.code;
  if (!code) return;
  if (code === "KeyZ" && (e.ctrlKey || e.metaKey)) {
    if (!hotkeyBlocked(e) && undo()) e.preventDefault && e.preventDefault();
    return;
  }
  if (hotkeyBlocked(e)) return;
  if (code === "KeyU") {
    undo();
    return;
  }
  const t = hotkeyTarget();
  if (!t) return;
  if (code === "Digit1") setVerdict(t.scope, t.target, "accept");
  else if (code === "Digit2") setVerdict(t.scope, t.target, "reject");
  else if (code === "Digit3") setVerdict(t.scope, t.target, "unsure");
  else if (code === "Digit4" || code === "KeyC") openCommentPopover(t.el, t.scope, t.target, t.label);
  else return;
  e.preventDefault && e.preventDefault();
}

// Esc в capture-фазе: поповер потребляет Esc и закрывает только себя —
// оверлей решения и прочие document-level обработчики его не получают.
function onEscCapture(e) {
  if (e.key !== "Escape") return;
  if (isPopoverOpen()) {
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (e.stopPropagation) e.stopPropagation();
    closePopover(true);
    return;
  }
  const dd = document.querySelector(".review-filter-wrap .menu-dropdown:not(.hidden)");
  if (dd) dd.classList.add("hidden");
}

// Клик вне: закрывает поповер (с сохранением), дропдауны фильтра и подсказку.
function onDocClick(e) {
  const t = e.target;
  const inOf = (sel) => t && t.closest && t.closest(sel);
  if (isPopoverOpen() && !inOf(".review-popover") &&
      !inOf(".review-comment-btn") && !inOf(".review-badge")) {
    closePopover(true);
  }
  if (!inOf(".review-filter-wrap")) {
    for (const dd of document.querySelectorAll(".review-filter-wrap .menu-dropdown")) {
      dd.classList.add("hidden");
    }
  }
  const hint = document.getElementById("review-hint");
  if (hint && !inOf("#review-hint")) dismissHint();
}

function onDocScroll(e) {
  // position:fixed отрывает поповер от якоря при скролле — закрываем с
  // сохранением (прецедент — fold-меню в context.js); скролл внутри самого
  // поповера (textarea) его не закрывает.
  if (pop && pop.el.contains && e.target && pop.el.contains(e.target)) return;
  if (isPopoverOpen()) closePopover(true);
}

// ---------------------------------------------------------------- init / reset

export function initReview() {
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("keydown", onEscCapture, true);
  document.addEventListener("click", onDocClick, true);
  document.addEventListener("scroll", onDocScroll, true);
  applyVisibility();
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("resize", () => closePopover(true));
  }
  subscribe((event) => {
    if (event === "review") {
      refresh("single");
      refresh("batch");
    } else if (event === "pagemode") {
      // фильтр — рабочий инструмент триажа, не состояние анализа
      filters.single = "all";
      filters.batch = "all";
      refresh("single");
      refresh("batch");
    }
  });
}

// Сброс внутреннего состояния модуля (тесты; state пометок не трогает).
export function resetReview() {
  undoStack.length = 0;
  filters.single = "all";
  filters.batch = "all";
  parked = null;
  if (pop) closePopover(false);
  const hint = document.getElementById("review-hint");
  if (hint) hint.remove();
}
