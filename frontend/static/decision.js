// Решение: логические правила поверх ответов моделей (вычисляется НЕ моделью).
// Движок (чистые функции) + редактор блока «Решение» в обеих страницах.

import { state } from "./state.js";

export const OUTCOME_COLORS = {
  green:  { bg: "#e8f7ee", fg: "#1a7f37", border: "#b7e4c7" },
  red:    { bg: "#fdecec", fg: "#c0392b", border: "#f5b7b1" },
  yellow: { bg: "#fef7e0", fg: "#9a6d00", border: "#f0d68a" },
  blue:   { bg: "#e8f0fe", fg: "#1a56db", border: "#b3ccf5" },
  purple: { bg: "#f3e8fd", fg: "#7d3ac1", border: "#d9b8f5" },
  gray:   { bg: "#f1f3f5", fg: "#5a6472", border: "#d4d9e0" },
};
export const COLOR_NAMES = Object.keys(OUTCOME_COLORS);

function genOutcomeId() {
  return "o_" + Math.random().toString(36).slice(2, 10);
}

function emptyDecision() {
  return { outcomes: [] };
}

// Нормализация из пресета/импорта/генерации: дефолты, id исходов.
export function normalizeDecision(data) {
  if (!data || !Array.isArray(data.outcomes)) return emptyDecision();
  return {
    outcomes: data.outcomes.map(o => ({
      id: o.id || genOutcomeId(),
      label: String(o.label || ""),
      color: OUTCOME_COLORS[o.color] ? o.color : "gray",
      isDefault: !!o.isDefault,
      rules: (Array.isArray(o.rules) ? o.rules : []).map(r => ({
        anyOf: !!r.anyOf,
        conditions: (Array.isArray(r.conditions) ? r.conditions : []).map(c => {
          const out = { question: String(c.question || ""), op: c.op === "lt" ? "lt" : "gte" };
          if (c.answer != null) out.answer = String(c.answer);
          if (c.threshold != null) out.threshold = Number(c.threshold);
          if (c.score != null) out.score = Number(c.score);
          return out;
        }),
      })),
    })),
  };
}

export function setDecision(data) {
  state.decision = normalizeDecision(data);
  renderDecision();
}

// ---------------------------------------------------------------- движок

// Одно условие против answers {questionId → {type, probabilities, choice?, score?}}.
// Висячая ссылка / нет ответа / нет такого варианта → условие не выполнено.
function conditionMatches(cond, answers) {
  const ans = answers[cond.question];
  if (!ans) return false;
  let value;
  if (cond.answer != null) {            // yes_no/choice: вероятность конкретного ответа
    value = (ans.probabilities || {})[cond.answer];
    if (value == null) return false;
    const thr = cond.threshold != null ? cond.threshold : 0.5;
    return cond.op === "lt" ? value < thr : value >= thr;
  }
  // score: средний балл по шкале
  value = ans.score;
  if (value == null) return false;
  const target = cond.score != null ? cond.score : 0;
  return cond.op === "lt" ? value < target : value >= target;
}

// → {outcomeId, label, color, ruleIdx, isDefault} | null (ничего не сработало и нет default).
export function evaluateDecision(decision, answers) {
  if (!decision || !Array.isArray(decision.outcomes) || !answers) return null;
  let fallback = null;
  for (const o of decision.outcomes) {
    if (o.isDefault && !fallback) fallback = o;
    for (let ri = 0; ri < (o.rules || []).length; ri++) {
      const rule = o.rules[ri];
      const conds = rule.conditions || [];
      if (!conds.length) continue;
      const hit = rule.anyOf
        ? conds.some(c => conditionMatches(c, answers))
        : conds.every(c => conditionMatches(c, answers));
      if (hit) return { outcomeId: o.id, label: o.label, color: o.color, ruleIdx: ri, isDefault: false };
    }
  }
  if (fallback) return { outcomeId: fallback.id, label: fallback.label, color: fallback.color, ruleIdx: -1, isDefault: true };
  return null;
}

// ---------------------------------------------------------------- подсказки и валидация

function questionById(questions, id) {
  return (questions || []).find(q => q.id === id) || null;
}

// Варианты ответа вопроса = ключи probabilities (для селекторов и проверки answer).
function answerOptions(q) {
  if (!q) return [];
  if (q.type === "yes_no") return ["yes", "no"];
  if (q.type === "choice") return (q.options || []).map(o => o.name);
  return []; // score — условие по среднему баллу, вариантов нет
}

// Отображаемое имя варианта (yes/no → да/нет; choice — как есть).
function answerLabel(key) {
  return key === "yes" ? "да" : key === "no" ? "нет" : String(key);
}

// Человекочитаемые подсказки редактора (полнота покрытия, висячие ссылки).
export function decisionHints(decision, questions) {
  const hints = [];
  if (!decision || !decision.outcomes.length) return hints;
  if (!decision.outcomes.some(o => o.isDefault)) {
    hints.push("Нет исхода по умолчанию — непокрытые правилами случаи дадут «не определено».");
  }
  decision.outcomes.forEach((o, i) => {
    if (!o.isDefault && !(o.rules || []).some(r => (r.conditions || []).length)) {
      hints.push(`Исход «${o.label || "№" + (i + 1)}» не содержит правил и никогда не сработает.`);
    }
    for (const r of o.rules || []) {
      for (const c of r.conditions || []) {
        const q = questionById(questions, c.question);
        if (!q) {
          hints.push(`Исход «${o.label}»: условие ссылается на удалённый вопрос.`);
        } else if (c.answer != null && !answerOptions(q).includes(c.answer)) {
          hints.push(`Исход «${o.label}»: у вопроса «${(q.question || "").slice(0, 40)}» нет ответа «${answerLabel(c.answer)}».`);
        }
      }
    }
  });
  const used = new Set();
  for (const o of decision.outcomes)
    for (const r of o.rules || [])
      for (const c of r.conditions || []) used.add(c.question);
  const unused = (questions || []).filter(q => q.id && !used.has(q.id) && (q.question || "").trim());
  if (unused.length) {
    hints.push("Не используются в правилах: " +
      unused.map(q => `«${(q.question || "").slice(0, 40)}»`).join(", ") + " — это допустимо.");
  }
  return hints;
}

// Ошибки (для запуска прогона и сохранения пресета). Бросает Error.
export function validateDecision(decision, questions) {
  if (!decision || !decision.outcomes || !decision.outcomes.length) return; // не задано — ок
  const labels = new Set();
  let defaults = 0;
  decision.outcomes.forEach((o, i) => {
    const where = `исход «${o.label || "№" + (i + 1)}»`;
    if (!(o.label || "").trim()) throw new Error(`Решение: пустое название исхода №${i + 1}`);
    if (labels.has(o.label)) throw new Error(`Решение: дублируется название исхода «${o.label}»`);
    labels.add(o.label);
    if (o.isDefault) defaults += 1;
    (o.rules || []).forEach((r, ri) => {
      (r.conditions || []).forEach((c, ci) => {
        const at = `${where}, правило ${ri + 1}, условие ${ci + 1}`;
        const q = questionById(questions, c.question);
        if (!q) throw new Error(`Решение: ${at} — вопрос не найден`);
        if (c.answer != null) {
          if (q.type === "score") throw new Error(`Решение: ${at} — у score-вопроса условие по среднему баллу, без ответа`);
          if (!answerOptions(q).includes(c.answer))
            throw new Error(`Решение: ${at} — у вопроса нет ответа «${c.answer}»`);
          const thr = c.threshold;
          if (thr == null || isNaN(thr) || thr < 0 || thr > 1)
            throw new Error(`Решение: ${at} — порог вероятности 0–100%`);
        } else {
          if (q.type !== "score")
            throw new Error(`Решение: ${at} — для не-score вопроса нужен ответ и порог`);
          const s = c.score;
          const maxIdx = (q.levels || []).length - 1;  // средний балл 0-based (как в результатах)
          if (s == null || isNaN(s) || s < 0 || (maxIdx >= 0 && s > maxIdx))
            throw new Error(`Решение: ${at} — средний балл в диапазоне 0..${maxIdx}`);
        }
      });
    });
  });
  if (defaults > 1) throw new Error("Решение: исход по умолчанию может быть только один");
}

// ---------------------------------------------------------------- редактор (UI)

const mounts = [];

export function mountDecision(opts = {}) {
  const m = {
    listId: opts.listId || "decision-list",
    emptyId: opts.emptyId || "decision-empty",
    hintsId: opts.hintsId || "decision-hints",
  };
  if (!mounts.some(x => x.listId === m.listId)) mounts.push(m);
  renderDecision();
}

export function addOutcome() {
  if (!state.decision) state.decision = emptyDecision();
  const palette = COLOR_NAMES;
  state.decision.outcomes.push({
    id: genOutcomeId(), label: "",
    color: palette[state.decision.outcomes.length % palette.length],
    isDefault: false,
    rules: [{ anyOf: false, conditions: [{ question: "", answer: "yes", op: "gte", threshold: 0.9 }] }],
  });
  renderDecision();
}

function questionSelectValue(c) {
  return c.question || "";
}

// Селектор вопроса: «№n · текст». Значение — id (невидим пользователю).
function questionSelectEl(c, onChange) {
  const sel = document.createElement("select");
  sel.className = "cond-q";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "— вопрос —";
  sel.appendChild(empty);
  state.questions.forEach((q, i) => {
    const opt = document.createElement("option");
    opt.value = q.id;
    opt.textContent = `№${i + 1} · ${(q.question || "(без текста)").slice(0, 50)}`;
    sel.appendChild(opt);
  });
  // висячая ссылка (вопрос удалён) — показываем как есть
  if (c.question && !state.questions.some(q => q.id === c.question)) {
    const opt = document.createElement("option");
    opt.value = c.question;
    opt.textContent = "⚠ удалённый вопрос";
    sel.appendChild(opt);
  }
  sel.value = questionSelectValue(c);
  sel.onchange = () => onChange(sel.value);
  return sel;
}

function condRowEl(o, r, c, oi, ri, ci) {
  const row = document.createElement("div");
  row.className = "cond-row";
  row.appendChild(questionSelectEl(c, (v) => {
    c.question = v;
    const q = state.questions.find(x => x.id === v);
    // смена типа вопроса → сброс формы условия
    if (q && q.type === "score") { delete c.answer; delete c.threshold; c.score = 1; }
    else { delete c.score; c.answer = q && q.type === "choice" ? (q.options[0] || {}).name || "" : "yes"; c.threshold = 0.9; }
    renderDecision();
  }));
  const q = state.questions.find(x => x.id === c.question);
  const isScore = q && q.type === "score";
  if (!isScore) {
    const ansSel = document.createElement("select");
    ansSel.className = "cond-answer";
    for (const a of answerOptions(q)) {
      const opt = document.createElement("option");
      opt.value = a;
      opt.textContent = `P(${answerLabel(a)})`;
      ansSel.appendChild(opt);
    }
    if (c.answer != null && !answerOptions(q).includes(c.answer)) {
      const opt = document.createElement("option");
      opt.value = c.answer;
      opt.textContent = `⚠ P(${answerLabel(c.answer)})`;
      ansSel.appendChild(opt);
    }
    ansSel.value = c.answer != null ? c.answer : "yes";
    ansSel.onchange = () => { c.answer = ansSel.value; };
    row.appendChild(ansSel);
  } else {
    const lbl = document.createElement("span");
    lbl.className = "cond-score-label";
    lbl.textContent = "средний балл";
    row.appendChild(lbl);
  }
  const opSel = document.createElement("select");
  opSel.className = "cond-op";
  for (const [v, t] of [["gte", "≥"], ["lt", "<"]]) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = t;
    opSel.appendChild(opt);
  }
  opSel.value = c.op === "lt" ? "lt" : "gte";
  opSel.onchange = () => { c.op = opSel.value; };
  row.appendChild(opSel);
  const num = document.createElement("input");
  num.className = "cond-num";
  num.type = "number";
  if (isScore) {
    const maxIdx = q ? (q.levels || []).length - 1 : 4;
    num.min = 0; num.max = Math.max(maxIdx, 0); num.step = 0.1;
    num.value = c.score != null ? c.score : 1;
    num.onchange = () => { c.score = parseFloat(num.value); };
    row.appendChild(num);
  } else {
    num.min = 0; num.max = 100; num.step = 1;
    num.value = Math.round((c.threshold != null ? c.threshold : 0.9) * 100);
    num.onchange = () => { c.threshold = Math.min(Math.max(parseFloat(num.value) || 0, 0), 100) / 100; };
    row.appendChild(num);
    const pct = document.createElement("span");
    pct.className = "cond-pct";
    pct.textContent = "%";
    row.appendChild(pct);
  }
  row.appendChild(delBtn(() => { r.conditions.splice(ci, 1); renderDecision(); }));
  return row;
}

function delBtn(fn) {
  const b = document.createElement("button");
  b.className = "icon-btn cond-del";
  b.textContent = "×";
  b.title = "Удалить условие";
  b.onclick = fn;
  return b;
}

function ruleBoxEl(o, r, oi, ri) {
  const box = document.createElement("div");
  box.className = "rule-box";
  if ((r.conditions || []).length > 1) {
    const comb = document.createElement("select");
    comb.className = "rule-comb";
    for (const [v, t] of [[false, "все условия (И)"], [true, "любое условие (ИЛИ)"]]) {
      const opt = document.createElement("option");
      opt.value = String(v);
      opt.textContent = t;
      comb.appendChild(opt);
    }
    comb.value = String(!!r.anyOf);
    comb.onchange = () => { r.anyOf = comb.value === "true"; };
    box.appendChild(comb);
  }
  (r.conditions || []).forEach((c, ci) => box.appendChild(condRowEl(o, r, c, oi, ri, ci)));
  const actions = document.createElement("div");
  actions.className = "rule-actions";
  const addCond = document.createElement("button");
  addCond.className = "btn btn-small";
  addCond.textContent = "+ Условие";
  addCond.onclick = () => {
    r.conditions.push({ question: "", answer: "yes", op: "gte", threshold: 0.9 });
    renderDecision();
  };
  actions.appendChild(addCond);
  const delRule = document.createElement("button");
  delRule.className = "btn btn-small";
  delRule.textContent = "Удалить правило";
  delRule.onclick = () => { o.rules.splice(ri, 1); renderDecision(); };
  actions.appendChild(delRule);
  box.appendChild(actions);
  return box;
}

function outcomeCardEl(o, oi) {
  const card = document.createElement("div");
  card.className = "outcome-card";
  const colors = OUTCOME_COLORS[o.color] || OUTCOME_COLORS.gray;
  card.style.borderLeft = `4px solid ${colors.border}`;

  const head = document.createElement("div");
  head.className = "outcome-head";

  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "⠿";
  handle.title = "Перетащите, чтобы изменить приоритет исходов";
  handle.draggable = true;
  handle.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", String(oi));
    e.dataTransfer.effectAllowed = "move";
  });
  card.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
    if (!isNaN(from) && from !== oi) {
      const [moved] = state.decision.outcomes.splice(from, 1);
      state.decision.outcomes.splice(oi, 0, moved);
      renderDecision();
    }
  });
  head.appendChild(handle);

  const colorSel = document.createElement("select");
  colorSel.className = "outcome-color";
  colorSel.title = "Цвет исхода";
  colorSel.style.color = colors.fg;
  for (const name of COLOR_NAMES) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = "●";
    opt.style.color = OUTCOME_COLORS[name].fg;
    colorSel.appendChild(opt);
  }
  colorSel.value = o.color;
  colorSel.onchange = () => { o.color = colorSel.value; renderDecision(); };
  head.appendChild(colorSel);

  const label = document.createElement("input");
  label.className = "outcome-label";
  label.type = "text";
  label.placeholder = "Название исхода (например, «Опубликовать»)";
  label.value = o.label || "";
  label.oninput = () => { o.label = label.value; };
  head.appendChild(label);

  const defLbl = document.createElement("label");
  defLbl.className = "outcome-default";
  const defCb = document.createElement("input");
  defCb.type = "checkbox";
  defCb.checked = !!o.isDefault;
  defCb.onchange = () => {
    for (const x of state.decision.outcomes) x.isDefault = false;
    o.isDefault = defCb.checked;
    renderDecision();
  };
  defLbl.appendChild(defCb);
  defLbl.appendChild(document.createTextNode(" иначе"));
  defLbl.title = "Исход по умолчанию: применяется, когда не сработало ни одно правило";
  head.appendChild(defLbl);

  const del = document.createElement("button");
  del.className = "btn btn-small outcome-del";
  del.textContent = "Удалить";
  del.onclick = () => { state.decision.outcomes.splice(oi, 1); renderDecision(); };
  head.appendChild(del);
  card.appendChild(head);

  const rulesWrap = document.createElement("div");
  rulesWrap.className = "outcome-rules";
  (o.rules || []).forEach((r, ri) => {
    if (ri > 0) {
      const or = document.createElement("div");
      or.className = "rule-or";
      or.textContent = "— ИЛИ —";
      rulesWrap.appendChild(or);
    }
    rulesWrap.appendChild(ruleBoxEl(o, r, oi, ri));
  });
  const addRule = document.createElement("button");
  addRule.className = "btn btn-small";
  addRule.textContent = "+ Правило";
  addRule.title = "Ещё одно правило для этого исхода (между правилами — ИЛИ)";
  addRule.onclick = () => {
    o.rules.push({ anyOf: false, conditions: [{ question: "", answer: "yes", op: "gte", threshold: 0.9 }] });
    renderDecision();
  };
  rulesWrap.appendChild(addRule);
  card.appendChild(rulesWrap);
  return card;
}

export function renderDecision() {
  const targets = mounts.length ? mounts : [{ listId: "decision-list", emptyId: "decision-empty", hintsId: "decision-hints" }];
  const d = state.decision && state.decision.outcomes ? state.decision : emptyDecision();
  for (const { listId, emptyId, hintsId } of targets) {
    const list = document.getElementById(listId);
    if (!list) continue;
    list.innerHTML = "";
    d.outcomes.forEach((o, oi) => list.appendChild(outcomeCardEl(o, oi)));
    const empty = document.getElementById(emptyId);
    if (empty) empty.classList.toggle("hidden", d.outcomes.length > 0);
    const hintsEl = document.getElementById(hintsId);
    if (hintsEl) {
      const hints = decisionHints(d, state.questions);
      hintsEl.innerHTML = "";
      for (const h of hints) {
        const div = document.createElement("div");
        div.textContent = "⚠ " + h;
        hintsEl.appendChild(div);
      }
      hintsEl.classList.toggle("hidden", hints.length === 0);
    }
  }
}
