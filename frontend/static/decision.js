// Решение: логические правила поверх ответов моделей (вычисляется НЕ моделью).
// Движок (чистые функции) + редактор блока «Решение» в обеих страницах.

import { state } from "./state.js";
import { updateBlockCounters } from "./blockcollapse.js";

export const OUTCOME_COLORS = {
  green:  { bg: "#e8f7ee", fg: "#1a7f37", border: "#b7e4c7" },
  red:    { bg: "#fdecec", fg: "#c0392b", border: "#f5b7b1" },
  yellow: { bg: "#fef7e0", fg: "#9a6d00", border: "#f0d68a" },
  blue:   { bg: "#e8f0fe", fg: "#1a56db", border: "#b3ccf5" },
  purple: { bg: "#f3e8fd", fg: "#7d3ac1", border: "#d9b8f5" },
  gray:   { bg: "#f1f3f5", fg: "#5a6472", border: "#d4d9e0" },
};
export const COLOR_NAMES = Object.keys(OUTCOME_COLORS);
export const COLOR_LABELS = {
  green: "зелёный", red: "красный", yellow: "жёлтый",
  blue: "синий", purple: "фиолетовый", gray: "серый",
};

function genOutcomeId() {
  return "o_" + Math.random().toString(36).slice(2, 10);
}

function emptyDecision() {
  return { enabled: true, outcomes: [] };
}

// Нормализация из пресета/импорта/генерации: дефолты, id исходов.
export function normalizeDecision(data) {
  if (!data || !Array.isArray(data.outcomes)) return emptyDecision();
  return {
    enabled: data.enabled !== false,
    outcomes: data.outcomes.map(o => ({
      id: o.id || genOutcomeId(),
      label: String(o.label || ""),
      color: OUTCOME_COLORS[o.color] ? o.color : "gray",
      isDefault: !!o.isDefault,
      // после загрузки пресета все заполненные исходы свёрнуты
      collapsed: !!(String(o.label || "") || (Array.isArray(o.rules) ? o.rules : []).length),
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
// → деталь проверки {ok, kind: "prob"|"score", question, answer?, value, threshold, op};
// висячая ссылка / нет ответа / нет такого варианта → ok:false, value:null.
function conditionDetail(cond, answers) {
  const op = cond.op === "lt" ? "lt" : "gte";
  const ans = answers[cond.question];
  if (cond.answer != null) {            // yes_no/choice: вероятность конкретного ответа
    const threshold = cond.threshold != null ? cond.threshold : 0.5;
    const value = ans ? (ans.probabilities || {})[cond.answer] ?? null : null;
    return {
      ok: value != null && (op === "lt" ? value < threshold : value >= threshold),
      kind: "prob", question: cond.question, answer: cond.answer, value, threshold, op,
    };
  }
  // score: средний балл по шкале
  const threshold = cond.score != null ? cond.score : 0;
  const value = ans ? ans.score ?? null : null;
  return {
    ok: value != null && (op === "lt" ? value < threshold : value >= threshold),
    kind: "score", question: cond.question, value, threshold, op,
  };
}

// Проверка всех правил по порядку: trace — каждое проверенное правило
// {outcomeId, label, color, ruleIdx, anyOf, hit, conditions: [деталь]}.
// Останавливаемся на первом сработавшем (он последний в trace).
function evalRules(decision, answers) {
  let fallback = null;
  const trace = [];
  let hitEntry = null;
  for (const o of decision.outcomes) {
    if (o.isDefault && !fallback) fallback = o;
    for (let ri = 0; ri < (o.rules || []).length; ri++) {
      const rule = o.rules[ri];
      const conds = rule.conditions || [];
      if (!conds.length) continue;
      const conditions = conds.map(c => conditionDetail(c, answers));
      const hit = rule.anyOf ? conditions.some(d => d.ok) : conditions.every(d => d.ok);
      const entry = { outcomeId: o.id, label: o.label, color: o.color, ruleIdx: ri, anyOf: !!rule.anyOf, hit, conditions };
      trace.push(entry);
      if (hit) { hitEntry = { o, entry }; return { trace, hitEntry, fallback }; }
    }
  }
  return { trace, hitEntry, fallback };
}

// → {outcomeId, label, color, ruleIdx, isDefault, trace} | null (ничего не сработало и нет default).
export function evaluateDecision(decision, answers) {
  if (!decision || !Array.isArray(decision.outcomes) || !answers) return null;
  const { trace, hitEntry, fallback } = evalRules(decision, answers);
  if (hitEntry) {
    const o = hitEntry.o;
    return { outcomeId: o.id, label: o.label, color: o.color, ruleIdx: hitEntry.entry.ruleIdx, isDefault: false, trace };
  }
  if (fallback) return { outcomeId: fallback.id, label: fallback.label, color: fallback.color, ruleIdx: -1, isDefault: true, trace };
  return null;
}

// Для hover-объяснений: результат + trace (при «не определено» — все правила с hit:false).
export function explainDecision(decision, answers) {
  const res = evaluateDecision(decision, answers);
  if (res) return { res, trace: res.trace || [] };
  if (!decision || !Array.isArray(decision.outcomes) || !answers) return { res: null, trace: [] };
  return { res: null, trace: evalRules(decision, answers).trace };
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
export function answerLabel(key) {
  return key === "yes" ? "да" : key === "no" ? "нет" : String(key);
}

// ---------------------------------------------------------------- hover-объяснение

function fmtPct(v) { return Math.round(v * 100) + "%"; }
function fmtScore(v) { return String(Math.round(v * 100) / 100); }

function truncateText(s, n) {
  s = String(s || "").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// «№3 «Есть ли спам?»» — номер + краткий текст, чтобы не бегать в правила.
function qrefOf(det, questions, qnum) {
  const num = qnum[det.question];
  const q = questionById(questions, det.question);
  if (num == null || !q) return "⚠ удалённый вопрос";
  const text = truncateText(q.question, 50);
  return text ? `№${num} «${text}»` : `№${num}`;
}

// Текст условия без маркера: «№3 «Есть ли спам?» → «да» 96% при пороге ≥ 90%» /
// «№5 «Качество?» → балл 2.1 при пороге < 3».
function conditionText(det, questions, qnum) {
  const op = det.op === "lt" ? "<" : "≥";
  const ref = qrefOf(det, questions, qnum);
  if (det.kind === "prob") {
    const need = `P(${answerLabel(det.answer)}) ${op} ${fmtPct(det.threshold)}`;
    if (det.value == null) return `${ref} → нет ответа (нужно ${need})`;
    return `${ref} → «${answerLabel(det.answer)}» ${fmtPct(det.value)} при пороге ${op} ${fmtPct(det.threshold)}`;
  }
  if (det.value == null) return `${ref} → нет ответа (нужен балл ${op} ${fmtScore(det.threshold)})`;
  return `${ref} → балл ${fmtScore(det.value)} при пороге ${op} ${fmtScore(det.threshold)}`;
}

// Элемент списка объяснения: ok — true/false у условий, null у вводных строк.
function conditionItem(det, questions, qnum) {
  return { ok: det.ok, text: conditionText(det, questions, qnum) };
}

function itemMark(ok) { return ok === true ? "✓ " : ok === false ? "✗ " : ""; }
function itemsToLines(items) { return items.map(it => itemMark(it.ok) + it.text); }

// Насколько условие близко к порогу (для выбора ключевых провалившихся).
function marginOf(det) {
  if (det.value == null) return Infinity;
  return Math.abs(det.value - det.threshold);
}

const MAX_TIP_LINES = 8;

// Текст hover-объяснения решения: {title, lines, items}. questions — снапшот
// прогона (для № и текстов вопросов). res/trace — из explainDecision.
// items — те же строки в структурированном виде [{ok, text}] для вёрстки
// (маркеры ✓/✗/• рисуются по ok); lines — плоский текст с маркерами.
export function describeDecision(res, trace, questions) {
  const qnum = {};
  (questions || []).forEach((q, i) => { qnum[q.id] = i + 1; });
  const items = [];
  if (res && !res.isDefault) {
    const entry = (trace || []).find(t => t.hit);
    if (entry) {
      items.push({ ok: null, text: `Сработало правило №${entry.ruleIdx + 1}${entry.anyOf ? " (хотя бы одно условие)" : ""}:` });
      for (const det of entry.conditions.slice(0, MAX_TIP_LINES - 1)) {
        items.push(conditionItem(det, questions, qnum));
      }
      if (entry.conditions.length > MAX_TIP_LINES - 1) items.push({ ok: null, text: "…" });
    }
    return { title: `Исход: ${res.label}`, lines: itemsToLines(items), items };
  }
  const title = res ? `Исход: ${res.label} (по умолчанию)` : "Решение не определено";
  items.push({ ok: null, text: res
    ? "Ни одно правило не сработало — применён исход по умолчанию."
    : "Ни одно правило не сработало, исход по умолчанию не задан." });
  if (!(trace || []).length) {
    items.push({ ok: null, text: "Правил с условиями нет." });
    return { title, lines: itemsToLines(items), items };
  }
  // Провалившиеся условия: ближайшие к порогу первыми, лимит строк.
  const failed = [];
  for (const t of trace || []) {
    const bad = (t.conditions || []).filter(d => !d.ok);
    bad.sort((a, b) => marginOf(a) - marginOf(b));
    for (const det of bad) failed.push({ label: t.label, det });
  }
  for (const f of failed.slice(0, MAX_TIP_LINES - 2)) {
    items.push({ ok: f.det.ok, text: `${conditionText(f.det, questions, qnum)} — «${f.label || "исход"}»` });
  }
  if (failed.length > MAX_TIP_LINES - 2) items.push({ ok: null, text: "…" });
  return { title, lines: itemsToLines(items), items };
}

// Полная сводка для оверлея по клику на чип решения: все проверенные правила
// (trace идёт в порядке проверки и обрывается на сработавшем) без лимита строк.
// → {title, note, groups: [{hit, heading, items: [{ok, text}]}]}.
export function describeDecisionFull(res, trace, questions) {
  const qnum = {};
  (questions || []).forEach((q, i) => { qnum[q.id] = i + 1; });
  const groups = (trace || []).map(t => ({
    hit: t.hit,
    heading: `${t.hit ? "Сработало" : "Не сработало"} — исход «${t.label || "—"}», правило №${t.ruleIdx + 1}` +
      (t.anyOf ? " (хотя бы одно условие)" : (t.conditions || []).length > 1 ? " (все условия)" : ""),
    items: (t.conditions || []).map(det => conditionItem(det, questions, qnum)),
  }));
  let title, note;
  if (res && !res.isDefault) {
    title = `Исход: ${res.label}`;
    note = null;
  } else if (res) {
    title = `Исход: ${res.label} (по умолчанию)`;
    note = "Ни одно правило не сработало — применён исход по умолчанию.";
  } else {
    title = "Решение не определено";
    note = "Ни одно правило не сработало, исход по умолчанию не задан.";
  }
  if (!groups.length) note = (note ? note + " " : "") + "Правил с условиями нет.";
  return { title, note, groups };
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
const wiredToggles = new WeakSet();

// Чекбокс «Учитывать в прогоне» в шапке карточки «Решение» (по одному на страницу).
function wireEnabledToggle(cb) {
  if (wiredToggles.has(cb)) return;
  wiredToggles.add(cb);
  cb.addEventListener("change", () => {
    if (!state.decision) state.decision = emptyDecision();
    state.decision.enabled = cb.checked;
    renderDecision();  // синхронизируем второй чекбокс (обе страницы)
  });
}

export function mountDecision(opts = {}) {
  const m = {
    listId: opts.listId || "decision-list",
    emptyId: opts.emptyId || "decision-empty",
    hintsId: opts.hintsId || "decision-hints",
    enabledId: opts.enabledId || null,
  };
  const existing = mounts.find(x => x.listId === m.listId);
  if (existing) {
    if (m.enabledId) existing.enabledId = m.enabledId;
  } else {
    mounts.push(m);
  }
  renderDecision();
}

export function addOutcome() {
  if (!state.decision) state.decision = emptyDecision();
  const palette = COLOR_NAMES;
  state.decision.outcomes.push({
    id: genOutcomeId(), label: "",
    color: palette[state.decision.outcomes.length % palette.length],
    isDefault: false,
    collapsed: false,  // новый исход развёрнут
    rules: [{ anyOf: false, conditions: [{ question: "", answer: "yes", op: "gte", threshold: 0.9 }] }],
  });
  renderDecision();
}

export function setAllOutcomesCollapsed(collapsed) {
  if (state.decision && state.decision.outcomes) {
    for (const o of state.decision.outcomes) o.collapsed = collapsed;
  }
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

function collapseBtnEl(o) {
  const btn = document.createElement("button");
  btn.className = "collapse-btn";
  btn.textContent = o.collapsed ? "▾" : "▴";
  btn.title = o.collapsed ? "Развернуть" : "Свернуть";
  btn.onclick = () => { o.collapsed = !o.collapsed; renderDecision(); };
  return btn;
}

// Свотчи цвета вместо <select>: у <option> на macOS цвета не видны.
function colorSwatchesEl(o) {
  const wrap = document.createElement("span");
  wrap.className = "outcome-colors";
  wrap.title = "Цвет исхода";
  for (const name of COLOR_NAMES) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "color-swatch" + (o.color === name ? " active" : "");
    sw.style.background = OUTCOME_COLORS[name].fg;
    sw.setAttribute("aria-label", COLOR_LABELS[name] || name);
    sw.title = COLOR_LABELS[name] || name;
    sw.onclick = () => { o.color = name; renderDecision(); };
    wrap.appendChild(sw);
  }
  return wrap;
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

  if (o.collapsed) {
    // Свёрнутый вид: точка цвета, название, «правил: N», chevron.
    const dot = document.createElement("span");
    dot.className = "outcome-dot";
    dot.style.background = colors.fg;
    dot.title = COLOR_LABELS[o.color] || o.color;
    head.appendChild(dot);
    const summary = document.createElement("span");
    summary.className = "question-summary";
    summary.textContent = o.label || "(без названия)";
    summary.title = o.label || "";
    head.appendChild(summary);
    const meta = document.createElement("span");
    meta.className = "outcome-meta";
    const parts = [`правил: ${(o.rules || []).length}`];
    if (o.isDefault) parts.push("иначе");
    meta.textContent = parts.join(" · ");
    head.appendChild(meta);
    head.appendChild(collapseBtnEl(o));
    card.appendChild(head);
    return card;
  }

  head.appendChild(colorSwatchesEl(o));

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
  head.appendChild(collapseBtnEl(o));
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
  for (const { listId, emptyId, hintsId, enabledId } of targets) {
    const list = document.getElementById(listId);
    if (!list) continue;
    list.innerHTML = "";
    d.outcomes.forEach((o, oi) => list.appendChild(outcomeCardEl(o, oi)));
    const empty = document.getElementById(emptyId);
    if (empty) empty.classList.toggle("hidden", d.outcomes.length > 0);
    if (enabledId) {
      const cb = document.getElementById(enabledId);
      if (cb) {
        wireEnabledToggle(cb);
        cb.checked = state.decision ? state.decision.enabled !== false : true;
      }
    }
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
  updateBlockCounters();
}
