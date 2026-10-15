// Движок мгновенной дельты правок правил решений (ассистент v0.7).
// Пересчёт исходов по УЖЕ полученным ответам прогонов (evaluateDecision по
// fullAnswers из state) — без сети и новых прогонов. Семантика дельты —
// по пометкам на исходах (decision-цели review.js): ✗ = исход был неверным
// (если исход сменился — считаем исправленным), ✓ = исход был верным (если
// сменился — сломали), ? — нейтральная (смена исхода = «затронуто»).
// Пометки на ответах (вопрос×модель) правила не затрагивают — ответы те же.
// Концепция: docs/assistant-v2-concept.md §5.2 (дешёвая дельта), §5.3.

import { state } from "./state.js";
import { evaluateDecision, validateDecision, normalizeDecision,
         COLOR_NAMES } from "./decision.js";

// ---------------------------------------------------------------- конвертация
// propose_decision payload → внутренний формат decision.js: вопросы по № из
// живого редактора (n → questions[n-1].id), threshold из процентов в 0..1.
// Бросает Error с понятным текстом (та же семантика, что applyProposal).

function convertCondition(c, questions) {
  const n = Math.round(Number(c.question));
  const q = questions[n - 1];
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

export function decisionFromProposal(payload, questions) {
  const outs = (payload && payload.outcomes) || [];
  if (!outs.length) throw new Error("В предложении нет исходов.");
  const decision = normalizeDecision({
    outcomes: outs.map((o) => ({
      label: String(o.label || "").trim(),
      color: COLOR_NAMES.includes(o.color) ? o.color : "gray",
      isDefault: !!o.isDefault,
      rules: (o.rules || []).map(r => ({
        anyOf: !!r.anyOf,
        conditions: (r.conditions || []).map(c => convertCondition(c, questions)),
      })),
    })),
  });
  validateDecision(decision, questions); // бросает Error с текстом
  return decision;
}

// ---------------------------------------------------------------- дельта

// Ответы результата с учётом режима прогона: при runMode "both" у цели
// пометки есть mode, и берём именно его подрезультат.
function answersOfMode(res, mode) {
  if (!res) return null;
  const sub = mode === "fast_batch" ? res.fast_batch
    : mode === "decisions" ? res.decisions : null;
  const r = sub || res.decisions || res.fast_batch || res;
  return r && r.ok && r.answers ? r.answers : null;
}

function outcomeIdOf(decision, answers) {
  const res = evaluateDecision(decision, answers);
  // Сравнение по label: id исходов у предложенных правил регенерируются
  // (normalizeDecision), пользовательская идентичность исхода — его имя.
  return res ? res.label : null; // null — «не определено»
}

// Дельта правок правил по размеченным исходам.
// → null, если разметки исходов нет; иначе {stale, total, errorsBefore,
//   errorsAfter, fixed, broken, touched, cells:[{scope, model, file?, mode?,
//   verdict, before, after}]}.
export function ruleDelta(proposedDecision) {
  const cells = [];
  let sawAnyResults = false;

  // одиночный режим: пометки решений — target {scope:"single", model, mode?, decision}
  const rs = state.results;
  if (rs && rs.results && (rs.marks || []).length) {
    sawAnyResults = true;
    const beforeDecision = rs.decision || state.decision;
    for (const m of rs.marks) {
      const t = m.target || {};
      if (!t.decision || !t.model || !(t.model in rs.results)) continue;
      const answers = answersOfMode(rs.results[t.model], t.mode);
      if (!answers) continue;
      const before = outcomeIdOf(beforeDecision, answers);
      const after = outcomeIdOf(proposedDecision, answers);
      cells.push({ scope: "single", model: t.model, mode: t.mode,
                   verdict: m.verdict, comment: m.comment, before, after });
    }
  }

  // пакет: пометки решений — target {scope:"batch", file, model, decision}
  const bres = state.batch.results || {};
  const bmarks = state.batch.marks || [];
  if (bmarks.length && Object.keys(bres).length) {
    sawAnyResults = true;
    const beforeDecision = state.batch.decision || state.decision;
    for (const m of bmarks) {
      const t = m.target || {};
      if (!t.decision || !t.file || !t.model) continue;
      const answers = answersOfMode((bres[t.file] || {})[t.model], t.mode);
      if (!answers) continue;
      const before = outcomeIdOf(beforeDecision, answers);
      const after = outcomeIdOf(proposedDecision, answers);
      cells.push({ scope: "batch", model: t.model, file: t.file, mode: t.mode,
                   verdict: m.verdict, comment: m.comment, before, after });
    }
  }

  if (!sawAnyResults || !cells.length) return null;

  let fixed = 0, broken = 0, touched = 0, errorsBefore = 0, errorsAfter = 0;
  for (const c of cells) {
    const changed = c.before !== c.after;
    if (c.verdict === "reject") {
      errorsBefore += 1;
      if (changed) fixed += 1; else errorsAfter += 1;
    } else if (c.verdict === "accept") {
      if (changed) { broken += 1; errorsAfter += 1; }
    } else if (c.verdict === "unsure" && changed) {
      touched += 1;
    }
  }

  const stale = !!((state.resultsStale && rs && (rs.marks || []).length) ||
                   (state.batch.resultsStale && bmarks.length));
  return { stale, total: cells.length, errorsBefore, errorsAfter,
           fixed, broken, touched, cells };
}
