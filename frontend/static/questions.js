// Конструктор вопросов: карточки, drag&drop, схлопывание, direction для score,
// валидация, экспорт/импорт.

import { state } from "./state.js";

const TYPE_LABELS = { yes_no: "Yes/No", choice: "Choice", score: "Score" };
const DIRECTIONS = { up: "↑ выше = лучше", down: "↓ ниже = лучше", neutral: "○ нейтрально" };

const TYPE_ICONS = {
  yes_no:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none">' +
    '<rect x="1" y="4" width="14" height="8" rx="4" stroke="currentColor" stroke-width="1.6"/>' +
    '<circle cx="5" cy="8" r="2.3" fill="currentColor"/></svg>',
  choice:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none">' +
    '<circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.6"/>' +
    '<circle cx="8" cy="8" r="2.6" fill="currentColor"/></svg>',
  score:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none">' +
    '<path d="M2.2 11.5a6 6 0 0 1 11.6 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<path d="M8 11.5 L11.2 6.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<circle cx="8" cy="11.5" r="1.7" fill="currentColor"/></svg>',
};

export function typeIcon(type) {
  const span = document.createElement("span");
  span.className = "type-icon t-" + type;
  span.innerHTML = TYPE_ICONS[type] || "";
  span.title = TYPE_LABELS[type] || type;
  return span;
}

function genId() {
  return "q_" + Math.random().toString(36).slice(2, 10);
}

// Карточка от «+ Вопрос»: развёрнута до первого ввода (флаг _fresh).
export function addQuestion(data) {
  let q;
  if (data) {
    q = data.id ? data : normalizeQuestion(data);
    q.collapsed = true;
    q._fresh = false;
  } else {
    q = { id: genId(), question: "", type: "yes_no", collapsed: false, _fresh: true };
  }
  state.questions.push(q);
  renderQuestions();
}

export function removeQuestion(idx) {
  state.questions.splice(idx, 1);
  renderQuestions();
}

export function moveQuestion(from, to) {
  if (to < 0 || to >= state.questions.length) return;
  const [q] = state.questions.splice(from, 1);
  state.questions.splice(to, 0, q);
  renderQuestions();
}

// ---------------------------------------------------------------- rendering

// Зарегистрированные инстансы редактора (одиночный + батч): общий state.questions,
// каждый renderQuestions перерисовывает все инстансы.
const mounts = [];

export function mountQuestions({ listId = "questions-list", emptyId = "questions-empty" } = {}) {
  if (!mounts.some(m => m.listId === listId)) mounts.push({ listId, emptyId });
  renderQuestions();
}

export function renderQuestions() {
  const targets = mounts.length ? mounts : [{ listId: "questions-list", emptyId: "questions-empty" }];
  for (const { listId, emptyId } of targets) {
    const list = document.getElementById(listId);
    if (!list) continue;
    list.innerHTML = "";
    state.questions.forEach((q, idx) => list.appendChild(renderQuestionCard(q, idx)));
    const empty = document.getElementById(emptyId);
    if (empty) empty.classList.toggle("hidden", state.questions.length > 0);
  }
}

function hasContent(q) {
  if (q.question && q.question.trim()) return true;
  if (q.yes && q.yes.trim()) return true;
  if (q.no && q.no.trim()) return true;
  if ((q.options || []).some(o => (o.name || "").trim() || (o.description || "").trim())) return true;
  if ((q.levels || []).some(l => (l || "").trim())) return true;
  return false;
}

function renderQuestionCard(q, idx) {
  const card = document.createElement("div");
  card.className = "question-card";
  card.dataset.idx = idx;

  const head = document.createElement("div");
  head.className = "question-head" + (q.collapsed ? "" : " expanded");

  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "⠿";
  handle.title = "Перетащите, чтобы изменить порядок";
  handle.draggable = true;
  handle.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", String(idx));
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  handle.addEventListener("dragend", () => card.classList.remove("dragging"));
  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    card.classList.add("drag-over");
  });
  card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    card.classList.remove("drag-over");
    const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
    if (!isNaN(from) && from !== idx) moveQuestion(from, idx);
  });
  head.appendChild(handle);
  head.appendChild(typeIcon(q.type));

  if (q.collapsed) {
    const summary = document.createElement("span");
    summary.className = "question-summary";
    summary.textContent = (q.question || "(без текста)").slice(0, 80);
    summary.title = q.question || "";
    head.appendChild(summary);
  } else {
    const typeSel = document.createElement("select");
    for (const t of ["yes_no", "choice", "score"]) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = TYPE_LABELS[t];
      typeSel.appendChild(opt);
    }
    typeSel.value = q.type;
    typeSel.onchange = () => {
      q.type = typeSel.value;
      q._fresh = false;
      if (q.type === "choice" && !q.options) q.options = [{ name: "", description: "" }, { name: "", description: "" }];
      if (q.type === "score" && !q.levels) q.levels = ["", ""];
      q.collapsed = true; // смена типа — схлопываем
      renderQuestions();
    };
    head.appendChild(typeSel);
  }

  const controls = document.createElement("span");
  controls.className = "question-controls";

  if (!q.collapsed) {
    const upBtn = document.createElement("button");
    upBtn.className = "btn btn-small";
    upBtn.textContent = "↑";
    upBtn.title = "Выше";
    upBtn.disabled = idx === 0;
    upBtn.onclick = () => moveQuestion(idx, idx - 1);

    const downBtn = document.createElement("button");
    downBtn.className = "btn btn-small";
    downBtn.textContent = "↓";
    downBtn.title = "Ниже";
    downBtn.disabled = idx === state.questions.length - 1;
    downBtn.onclick = () => moveQuestion(idx, idx + 1);

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger btn-small";
    delBtn.textContent = "Удалить";
    delBtn.onclick = () => removeQuestion(idx);

    controls.append(upBtn, downBtn, delBtn);
  }

  const collapseBtn = document.createElement("button");
  collapseBtn.className = "collapse-btn";
  collapseBtn.textContent = q.collapsed ? "▾" : "▴";
  collapseBtn.title = q.collapsed ? "Развернуть" : "Свернуть";
  collapseBtn.onclick = () => {
    q._fresh = false;
    q.collapsed = !q.collapsed;
    renderQuestions();
  };

  controls.appendChild(collapseBtn);

  head.appendChild(controls);
  card.appendChild(head);

  if (q.collapsed) return card;

  // Свежая карточка схлопывается после первого ввода (по уходу фокуса).
  if (q._fresh) {
    let touched = false;
    card.addEventListener("input", () => { touched = true; });
    card.addEventListener("focusout", () => {
      if (touched && hasContent(q)) {
        q._fresh = false;
        q.collapsed = true;
        renderQuestions();
      }
    });
  }

  const qRow = document.createElement("div");
  qRow.className = "field-row";
  const qLabel = document.createElement("span");
  qLabel.className = "field-label";
  qLabel.textContent = "Вопрос";
  const qInput = document.createElement("input");
  qInput.type = "text";
  qInput.value = q.question || "";
  qInput.placeholder = "Текст вопроса";
  qInput.oninput = () => { q.question = qInput.value; };
  qRow.append(qLabel, qInput);
  card.appendChild(qRow);

  if (q.type === "yes_no") {
    card.appendChild(textField("Описание «да»", q.yes || "", v => { q.yes = v; }));
    card.appendChild(textField("Описание «нет»", q.no || "", v => { q.no = v; }));
  } else if (q.type === "choice") {
    card.appendChild(renderOptions(q));
  } else if (q.type === "score") {
    card.appendChild(renderLevels(q));
    card.appendChild(renderDirection(q));
  }
  return card;
}

function textField(label, value, onChange) {
  const row = document.createElement("div");
  row.className = "field-row";
  const lab = document.createElement("span");
  lab.className = "field-label";
  lab.textContent = label;
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = value;
  inp.oninput = () => onChange(inp.value);
  row.append(lab, inp);
  return row;
}

function renderOptions(q) {
  const wrap = document.createElement("div");
  (q.options || []).forEach((opt, i) => {
    const row = document.createElement("div");
    row.className = "option-row";
    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = "Имя опции";
    name.value = opt.name || "";
    name.oninput = () => { opt.name = name.value; };
    const desc = document.createElement("input");
    desc.type = "text";
    desc.placeholder = "Описание (опционально)";
    desc.value = opt.description || "";
    desc.oninput = () => { opt.description = desc.value; };
    const del = document.createElement("button");
    del.className = "btn btn-danger btn-small";
    del.textContent = "×";
    del.onclick = () => { q.options.splice(i, 1); renderQuestions(); };
    row.append(name, desc, del);
    wrap.appendChild(row);
  });
  const add = document.createElement("button");
  add.className = "btn btn-small";
  add.textContent = "+ Опция";
  add.onclick = () => { q.options.push({ name: "", description: "" }); renderQuestions(); };
  wrap.appendChild(add);
  return wrap;
}

function renderLevels(q) {
  const wrap = document.createElement("div");
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Уровни от низшего к высшему (0 — первый):";
  wrap.appendChild(hint);
  (q.levels || []).forEach((lvl, i) => {
    const row = document.createElement("div");
    row.className = "level-row";
    const idx = document.createElement("span");
    idx.className = "qid-tag";
    idx.textContent = String(i);
    const inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = "Описание уровня " + i;
    inp.value = lvl;
    inp.oninput = () => { q.levels[i] = inp.value; };
    const del = document.createElement("button");
    del.className = "btn btn-danger btn-small";
    del.textContent = "×";
    del.onclick = () => { q.levels.splice(i, 1); renderQuestions(); };
    row.append(idx, inp, del);
    wrap.appendChild(row);
  });
  const add = document.createElement("button");
  add.className = "btn btn-small";
  add.textContent = "+ Уровень";
  add.onclick = () => { q.levels.push(""); renderQuestions(); };
  wrap.appendChild(add);
  return wrap;
}

// Направление шкалы score: в state и экспорт, в /api/decide не уходит.
function renderDirection(q) {
  if (!DIRECTIONS[q.direction]) q.direction = "neutral";
  const row = document.createElement("div");
  const label = document.createElement("div");
  label.className = "direction-label";
  label.textContent = "Направление шкалы:";
  const seg = document.createElement("div");
  seg.className = "direction-seg";
  for (const [value, text] of Object.entries(DIRECTIONS)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.classList.toggle("active", q.direction === value);
    btn.onclick = () => { q.direction = value; renderQuestions(); };
    seg.appendChild(btn);
  }
  row.append(label, seg);
  return row;
}

// ---------------------------------------------------------------- валидация / payload

export function buildQuestionsPayload() {
  if (state.questions.length === 0) throw new Error("Добавьте хотя бы один вопрос.");
  for (const [i, q] of state.questions.entries()) {
    if (!q.question || !q.question.trim()) throw new Error(`Вопрос №${i + 1}: пустой текст вопроса.`);
    if (q.type === "choice") {
      if (!q.options || q.options.length < 2 || q.options.length > 26)
        throw new Error(`Вопрос «${q.question}»: choice требует от 2 до 26 опций.`);
      const names = new Set();
      for (const o of q.options) {
        if (!o.name || !o.name.trim()) throw new Error(`Вопрос «${q.question}»: пустое имя опции.`);
        if (/[\r\n]/.test(o.name)) throw new Error(`Вопрос «${q.question}»: имя опции не должно содержать переводов строк.`);
        const key = o.name.trim().toLowerCase();
        if (names.has(key)) throw new Error(`Вопрос «${q.question}»: дублирующееся имя опции «${o.name}».`);
        names.add(key);
      }
    } else if (q.type === "score") {
      if (!q.levels || q.levels.length < 2 || q.levels.length > 10)
        throw new Error(`Вопрос «${q.question}»: score требует от 2 до 10 уровней.`);
      for (const l of q.levels)
        if (!l || !l.trim()) throw new Error(`Вопрос «${q.question}»: пустое описание уровня.`);
    } else if (q.type !== "yes_no") {
      throw new Error(`Вопрос «${q.question}»: неизвестный тип «${q.type}».`);
    }
  }
  return state.questions.map(q => {
    const out = { id: q.id, question: q.question, type: q.type };
    if (q.type === "yes_no") {
      if (q.yes && q.yes.trim()) out.yes = q.yes;
      if (q.no && q.no.trim()) out.no = q.no;
    } else if (q.type === "choice") {
      out.options = q.options.map(o => {
        const oo = { name: o.name };
        if (o.description && o.description.trim()) oo.description = o.description;
        return oo;
      });
    } else if (q.type === "score") {
      out.levels = q.levels.slice();
    }
    return out;
  });
}

// ---------------------------------------------------------------- экспорт / импорт

export function exportQuestions() {
  let payload;
  try {
    payload = buildQuestionsPayload();
  } catch (e) {
    throw new Error("Экспорт невозможен: " + e.message);
  }
  // direction уходит в экспорт, но не в payload /api/decide.
  for (const out of payload) {
    const q = state.questions.find(x => x.id === out.id);
    if (q && q.type === "score") out.direction = DIRECTIONS[q.direction] ? q.direction : "neutral";
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "questions.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

export function normalizeQuestion(q) {
  if (!q || typeof q !== "object" || !q.type)
    throw new Error("Каждый вопрос должен содержать поле type.");
  if (!["yes_no", "choice", "score"].includes(q.type))
    throw new Error(`Неизвестный тип вопроса: ${q.type}`);
  const qq = { id: q.id || genId(), question: q.question || "", type: q.type, collapsed: true };
  if (q.type === "yes_no") { qq.yes = q.yes || ""; qq.no = q.no || ""; }
  if (q.type === "choice") qq.options = (q.options || []).map(o => ({ name: o.name || "", description: o.description || "" }));
  if (q.type === "score") {
    qq.levels = (q.levels || []).slice();
    qq.direction = DIRECTIONS[q.direction] ? q.direction : "neutral";
  }
  return qq;
}

export function setQuestions(list) {
  state.questions = list.map(normalizeQuestion);
  renderQuestions();
}

export function setAllCollapsed(collapsed) {
  for (const q of state.questions) {
    q.collapsed = collapsed;
    q._fresh = false;
  }
  renderQuestions();
}
