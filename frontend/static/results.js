// Результаты: sticky-шапка (сводка + чипы прогонов), режим A (один прогон),
// режим B (сравнение ≥2 прогонов), дрилдауны, ховер-тултип распределения.

import { state } from "./state.js";
import { typeIcon } from "./questions.js";
import { openLightbox } from "./lightbox.js";
import { explainDecision, describeDecision, describeDecisionFull, OUTCOME_COLORS } from "./decision.js";

const MODE_LABELS = { decisions: "обычный", fast_batch: "быстрый режим", clef: "clef", systemone: "systemone" };
const MASS_WARN_TEXT = "модель скорее ответила бы чем-то другим";

function pct(p, digits = 1) { return (p * 100).toFixed(digits) + "%"; }

function plural(n, one, few, many) {
  const m = Math.abs(n) % 100, d = m % 10;
  if (m > 10 && m < 20) return many;
  if (d > 1 && d < 5) return few;
  if (d === 1) return one;
  return many;
}

// ---------------------------------------------------------------- общие хелперы

export function modelLabel(key) {
  const m = state.models.find(m => m.key === key);
  return (m && m.label) || key;
}

// Короткое имя модели для чипов/тегов: short_label из конфига, иначе первое
// число из label («27B», «35B-A3B»).
export function modelShortLabel(key) {
  const m = state.models.find(m => m.key === key);
  if (m && m.short_label) return m.short_label;
  const label = modelLabel(key);
  const match = label.match(/\d+B(?:-A\d+B)?/i);
  return match ? match[0] : key;
}

// Краткое представление ответа: "да · 96.5%" / "alpha · 88.0%" / "3.71".
export function shortAnswer(ans) {
  if (!ans) return "—";
  const p = ans.probabilities || {};
  if (ans.type === "yes_no") {
    const yes = p.yes ?? 0, no = p.no ?? 0;
    return yes >= no ? `да · ${pct(yes, 0)}` : `нет · ${pct(no, 0)}`;
  }
  if (ans.type === "choice") {
    const entries = Object.entries(p).sort((a, b) => b[1] - a[1]);
    const top = entries[0];
    const label = ans.choice ?? (top ? top[0] : "—");
    return `${label} · ${pct(top ? top[1] : 0, 0)}`;
  }
  if (ans.type === "score") {
    return (ans.score ?? 0).toFixed(2);
  }
  return "—";
}

// Уверенность ответа — вероятность топ-варианта.
export function answerConfidence(ans) {
  if (!ans) return 0;
  const vals = Object.values(ans.probabilities || {});
  return vals.length ? Math.max(...vals) : 0;
}

// Нейтральная шкала уверенности: conf-0 (минимум) … conf-4 (максимум).
export function confClass(conf) {
  if (conf >= 0.8) return "conf-4";
  if (conf >= 0.6) return "conf-3";
  if (conf >= 0.4) return "conf-2";
  if (conf >= 0.2) return "conf-1";
  return "conf-0";
}

// Маркировка значения score по направлению шкалы: value на шкале 1..levels.
// neutral / не score / нет значения → null (остаётся нейтральная conf-шкала).
export function scoreDirClass(question, value) {
  if (!question || question.type !== "score") return null;
  const direction = question.direction || "neutral";
  if (direction !== "up" && direction !== "down") return null;
  const levels = (question.levels && question.levels.length) || 0;
  if (levels < 2 || value == null || isNaN(value)) return null;
  let p = (value - 1) / (levels - 1);
  p = Math.min(Math.max(p, 0), 1);
  if (direction === "down") p = 1 - p;
  if (p >= 0.67) return "dir-good";
  if (p <= 0.33) return "dir-bad";
  return "dir-mid";
}

// Маркировка ответа да/нет по направлению вопроса: совпадает с «лучшим»
// ответом → dir-good, противоположный → dir-bad, neutral/не yes_no → null.
export function yesNoDirClass(question, ans) {
  if (!question || question.type !== "yes_no" || !ans) return null;
  const direction = question.direction || "neutral";
  if (direction !== "yes" && direction !== "no") return null;
  const p = ans.probabilities || {};
  const isYes = (p.yes ?? 0) >= (p.no ?? 0);
  const good = (direction === "yes") === isYes;
  return good ? "dir-good" : "dir-bad";
}

// Разворачивает state.results в плоский список прогонов {key, mode, res}.
export function flattenRuns(rs) {
  rs = rs || state.results;
  if (!rs) return [];
  const results = rs.results || {};
  const order = rs.order || [];
  const runMode = rs.runMode || "decisions";
  const keys = order.filter(k => k in results)
    .concat(Object.keys(results).filter(k => !order.includes(k)));
  const runs = [];
  for (const key of keys) {
    const r = results[key];
    if (runMode === "both") {
      if (r && r.clef) runs.push({ key, mode: "clef", res: r.clef });
      if (r && r.decisions) runs.push({ key, mode: "decisions", res: r.decisions });
      if (r && r.fast_batch) runs.push({ key, mode: "fast_batch", res: r.fast_batch });
    } else if (r) {
      runs.push({ key, mode: (r.metrics && r.metrics.mode) || runMode, res: r });
    }
  }
  return runs;
}

// Вопросы, по которым рендерятся результаты (снимок на момент прогона).
export function resultQuestions(rs) {
  rs = rs || state.results;
  if (rs && rs.questions && rs.questions.length) return rs.questions;
  return state.questions;
}

function massClass(m) {
  if (m == null) return "";
  if (m >= 0.9) return "mass-good";
  if (m < 0.5) return "mass-bad";
  return "mass-mid";
}

// ---------------------------------------------------------------- распределения

function barRow(label, p, best) {
  const row = document.createElement("div");
  row.className = "bar-row";
  const lab = document.createElement("span");
  lab.textContent = label;
  if (best) lab.className = "bar-label best";
  const track = document.createElement("div");
  track.className = "bar-track";
  const fill = document.createElement("div");
  fill.className = "bar-fill" + (best ? " best" : "");
  fill.style.width = (p * 100).toFixed(1) + "%";
  track.appendChild(fill);
  const pc = document.createElement("span");
  pc.className = "bar-pct";
  pc.textContent = pct(p);
  row.append(lab, track, pc);
  return row;
}

export function distributionBars(ans, question) {
  const wrap = document.createElement("div");
  const p = ans.probabilities || {};
  if (ans.type === "yes_no") {
    wrap.appendChild(barRow("Да", p.yes ?? 0, (p.yes ?? 0) >= (p.no ?? 0)));
    wrap.appendChild(barRow("Нет", p.no ?? 0, (p.no ?? 0) > (p.yes ?? 0)));
  } else if (ans.type === "choice") {
    const entries = Object.entries(p).sort((a, b) => b[1] - a[1]);
    for (const [name, prob] of entries) {
      wrap.appendChild(barRow(name, prob, name === ans.choice));
    }
  } else if (ans.type === "score") {
    const entries = Object.entries(p).sort((a, b) => Number(a[0]) - Number(b[0]));
    const maxP = Math.max(...entries.map(e => e[1]), 0);
    for (const [lvl, prob] of entries) {
      const label = (question && question.levels && question.levels[Number(lvl)])
        ? `${lvl}: ${question.levels[Number(lvl)]}` : lvl;
      wrap.appendChild(barRow(label, prob, prob === maxP && maxP > 0));
    }
  }
  return wrap;
}

// ---------------------------------------------------------------- шкала score с направлением

// direction: "up" (выше=лучше) — зелень справа, "down" — слева, "neutral" — серая.
function scoreScaleEl(ans, question, compact) {
  const p = ans.probabilities || {};
  const n = Math.max(Object.keys(p).length, 2);
  const maxIdx = n - 1;
  const score = ans.score ?? 0;
  const pos = Math.min(Math.max(score / maxIdx, 0), 1) * 100;
  const conf = answerConfidence(ans);
  const direction = (question && question.direction) || "neutral";

  const wrap = document.createElement("div");
  wrap.className = "score-scale" + (compact ? " compact" : "");

  const track = document.createElement("div");
  track.className = "score-track" + (direction === "up" ? " up" : direction === "down" ? " down" : "");
  // Маркер: neutral — синий (как раньше), up/down — цвет по dir-классу значения.
  const dirCls = scoreDirClass(question, score + 1);
  const marker = document.createElement("div");
  marker.className = "score-marker" + (dirCls ? " " + dirCls : "");
  marker.style.left = pos.toFixed(1) + "%";
  const alpha = Math.min(Math.max(conf, 0.35), 1).toFixed(2);
  if (dirCls) {
    marker.style.opacity = alpha; // цвет из CSS-класса, прозрачность — уверенность
  } else {
    marker.style.background = `rgba(74, 125, 255, ${alpha})`;
  }
  marker.title = `${score.toFixed(2)} из ${maxIdx}`;
  track.appendChild(marker);
  wrap.appendChild(track);

  if (!compact) {
    const edges = document.createElement("div");
    edges.className = "score-edges";
    const lvl = (question && question.levels) || [];
    const lo = document.createElement("span");
    lo.textContent = `0${lvl[0] ? " · " + lvl[0] : ""}`;
    const hi = document.createElement("span");
    hi.textContent = `${maxIdx}${lvl[maxIdx] ? " · " + lvl[maxIdx] : ""}`;
    const mid = document.createElement("span");
    mid.className = "score-mean";
    mid.textContent = `среднее: ${score.toFixed(2)}`;
    edges.append(lo, mid, hi);
    wrap.appendChild(edges);

    const entries = Object.entries(p).sort((a, b) => Number(a[0]) - Number(b[0]));
    const maxP = Math.max(...entries.map(e => e[1]), 0);
    const cols = document.createElement("div");
    cols.className = "score-cols";
    for (const [, prob] of entries) {
      const col = document.createElement("div");
      col.className = "score-col";
      col.style.height = (maxP > 0 ? (prob / maxP) * 100 : 0).toFixed(1) + "%";
      col.title = pct(prob);
      cols.appendChild(col);
    }
    wrap.appendChild(cols);
  }
  return wrap;
}

// ---------------------------------------------------------------- микро-визуализации строк

function microYn(ans) {
  const p = ans.probabilities || {};
  const yes = p.yes ?? 0, no = p.no ?? 0;
  const bar = document.createElement("div");
  bar.className = "micro-yn";
  const yesSeg = document.createElement("span");
  yesSeg.className = "m-yes";
  yesSeg.style.width = (yes * 100).toFixed(1) + "%";
  yesSeg.title = `да ${pct(yes)}`;
  const noSeg = document.createElement("span");
  noSeg.className = "m-no";
  noSeg.style.width = (no * 100).toFixed(1) + "%";
  noSeg.title = `нет ${pct(no)}`;
  bar.append(yesSeg, noSeg);
  return bar;
}

function microChoice(ans) {
  const p = ans.probabilities || {};
  const top = Object.entries(p).sort((a, b) => b[1] - a[1])[0];
  const bar = document.createElement("div");
  bar.className = "micro-bar";
  const fill = document.createElement("span");
  fill.style.width = ((top ? top[1] : 0) * 100).toFixed(1) + "%";
  bar.appendChild(fill);
  return bar;
}

function rowViz(ans, question) {
  if (ans.type === "yes_no") return microYn(ans);
  if (ans.type === "choice") return microChoice(ans);
  if (ans.type === "score") return scoreScaleEl(ans, question, true);
  const d = document.createElement("div");
  d.className = "hint";
  d.textContent = shortAnswer(ans);
  return d;
}

// Полная визуализация для дрилдауна.
function fullViz(ans, question) {
  if (ans.type === "score") return scoreScaleEl(ans, question, false);
  return distributionBars(ans, question);
}

// ---------------------------------------------------------------- ховер-тултип

let tipEl = null;

export function showTip(anchor, build) {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "dist-tip hidden";
  }
  if (tipEl.parentNode !== document.body) document.body.appendChild(tipEl);
  tipEl.innerHTML = "";
  build(tipEl);
  tipEl.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  const tw = tipEl.offsetWidth || 280;
  const th = tipEl.offsetHeight || 120;
  let left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - tw - 8));
  let top = r.bottom + 6;
  if (top + th > window.innerHeight - 8) top = Math.max(8, r.top - th - 6);
  tipEl.style.left = left + "px";
  tipEl.style.top = top + "px";
}

export function hideTip() {
  if (tipEl) tipEl.classList.add("hidden");
}

// Список условий с цветными маркерами ✓/✗/• — общий для тултипа и оверлея.
function decisionItemsEl(items) {
  const ul = document.createElement("ul");
  ul.className = "chip-tip-list";
  for (const it of items || []) {
    const li = document.createElement("li");
    if (it.ok === true) li.classList.add("ok");
    else if (it.ok === false) li.classList.add("bad");
    const mark = document.createElement("span");
    mark.className = "chip-tip-mark";
    mark.textContent = it.ok === true ? "✓" : it.ok === false ? "✗" : "•";
    li.appendChild(mark);
    li.appendChild(document.createTextNode(" " + it.text));
    ul.appendChild(li);
  }
  return ul;
}

// -------------------------------------------------- оверлей «почему такое решение»

let decOverlay = null;
let decEscDoc = null;  // document, на котором уже висит Esc-обработчик

function buildDecisionOverlay() {
  decOverlay = document.createElement("div");
  decOverlay.className = "decision-overlay hidden";
  const box = document.createElement("div");
  box.className = "decision-overlay-box";
  box.addEventListener("click", (e) => e.stopPropagation());
  const bar = document.createElement("div");
  bar.className = "preview-bar";
  const cap = document.createElement("span");
  cap.className = "preview-caption";
  bar.appendChild(cap);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn-small decision-overlay-close";
  closeBtn.textContent = "✕";
  closeBtn.title = "Закрыть (Esc)";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeDecisionOverlay();
  });
  bar.appendChild(closeBtn);
  box.appendChild(bar);
  const body = document.createElement("div");
  body.className = "decision-overlay-body";
  box.appendChild(body);
  decOverlay.appendChild(box);
  decOverlay.addEventListener("click", () => closeDecisionOverlay());
  document.body.appendChild(decOverlay);
  decOverlay._caption = cap;
  decOverlay._body = body;
}

export function closeDecisionOverlay() {
  if (decOverlay) decOverlay.classList.add("hidden");
}

// Полное объяснение решения: заголовок (модель/файл), исход, все проверенные
// правила группами с условиями. caption — контекст («Model A», «файл №2 · X»).
function openDecisionOverlay(res, trace, questions, caption) {
  if (!decOverlay) buildDecisionOverlay();
  if (decOverlay.parentNode !== document.body) document.body.appendChild(decOverlay);
  if (decEscDoc !== document) {
    decEscDoc = document;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDecisionOverlay();
    });
  }
  const full = describeDecisionFull(res, trace, questions);
  decOverlay._caption.textContent = caption ? `${caption} — как получилось решение` : "Как получилось решение";
  const body = decOverlay._body;
  body.innerHTML = "";
  const h = document.createElement("div");
  h.className = "decision-overlay-title";
  h.textContent = full.title;
  body.appendChild(h);
  if (full.note) {
    const n = document.createElement("div");
    n.className = "decision-overlay-note";
    n.textContent = full.note;
    body.appendChild(n);
  }
  for (const g of full.groups) {
    const grp = document.createElement("div");
    grp.className = "dec-group" + (g.hit ? " hit" : "");
    const head = document.createElement("div");
    head.className = "dec-group-head";
    head.textContent = (g.hit ? "✓ " : "✗ ") + g.heading;
    grp.appendChild(head);
    grp.appendChild(decisionItemsEl(g.items));
    body.appendChild(grp);
  }
  decOverlay.classList.remove("hidden");
}

// Hover-объяснение «почему сработал исход» на чипе решения (структурированный
// список ✓/✗); клик по чипу — полный оверлей со всеми проверенными правилами.
// res/trace — из explainDecision, questions — снапшот вопросов прогона,
// caption — контекст для заголовка оверлея (модель, файл).
export function attachDecisionTip(anchor, res, trace, questions, caption) {
  anchor.addEventListener("mouseenter", () => {
    showTip(anchor, (tip) => {
      const desc = describeDecision(res, trace, questions);
      const t = document.createElement("div");
      t.className = "dist-tip-title";
      t.textContent = desc.title;
      tip.appendChild(t);
      tip.appendChild(decisionItemsEl(desc.items));
      const more = document.createElement("div");
      more.className = "chip-tip-more";
      more.textContent = "Клик — подробное объяснение";
      tip.appendChild(more);
    });
  });
  anchor.addEventListener("mouseleave", hideTip);
  anchor.addEventListener("click", (e) => {
    e.stopPropagation();
    hideTip();
    openDecisionOverlay(res, trace, questions, caption);
  });
}

// ---------------------------------------------------------------- детали прогона (чипы)

function renderRunDetail(run, questions) {
  const detail = document.createElement("div");
  detail.className = "run-chip-detail";

  const m = run.res.metrics || {};
  const nQ = Math.max(questions.length, 1);

  const lines = document.createElement("div");
  const addLine = (name, value) => {
    const row = document.createElement("div");
    row.className = "run-detail-row";
    const k = document.createElement("span");
    k.className = "run-detail-key";
    k.textContent = name;
    const v = document.createElement("span");
    v.textContent = value;
    row.append(k, v);
    lines.appendChild(row);
  };
  addLine("Режим", MODE_LABELS[run.mode] || run.mode);
  if (m.prompt_tokens != null) addLine("Средний промпт на вопрос", `${Math.round(m.prompt_tokens / nQ)} ток`);
  addLine("Контекст префиллился", run.mode === "decisions" ? `${questions.length} ${plural(questions.length, "раз", "раза", "раз")}` : "1 раз");
  detail.appendChild(lines);

  const runImages = state.results && state.results.images;
  if (runImages && runImages.length) {
    const strip = document.createElement("div");
    strip.className = "run-images";
    strip.title = "Изображения, отправленные в этом прогоне — клик: увеличить";
    runImages.forEach((dataUrl, i) => {
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = "изображение материала";
      const name = `изображение ${i + 1}`;
      img.addEventListener("click", (e) => {
        e.stopPropagation();
        openLightbox({ src: dataUrl, name });
      });
      strip.appendChild(img);
    });
    detail.appendChild(strip);
  }

  const massTitle = document.createElement("div");
  massTitle.className = "run-detail-mass-title";
  massTitle.textContent = "Доля вероятности на вариантах по вопросам:";
  detail.appendChild(massTitle);
  const massList = document.createElement("div");
  for (const q of questions) {
    const ans = run.res.answers && run.res.answers[q.id];
    if (!ans) continue;
    const row = document.createElement("div");
    row.className = "mass-line";
    const qSpan = document.createElement("span");
    qSpan.className = "mass-q";
    qSpan.textContent = q.question;
    const vSpan = document.createElement("span");
    const lm = ans.label_mass;
    if (lm == null) {
      vSpan.textContent = "—";
      vSpan.className = "mass-val";
    } else {
      vSpan.textContent = pct(lm, 0) + (lm < 0.5 ? " ⚠ " + MASS_WARN_TEXT : "");
      vSpan.className = "mass-val " + massClass(lm);
    }
    row.append(qSpan, vSpan);
    massList.appendChild(row);
  }
  detail.appendChild(massList);

  const usage = document.createElement("pre");
  usage.className = "raw-json";
  usage.textContent = "usage: " + JSON.stringify(run.res.usage || {}, null, 2);
  detail.appendChild(usage);
  return detail;
}

// Чипы решений: по одному на прогон (решение считается из ответов каждой модели
// по правилам-снапшоту прогона). Расхождение исходов между моделями → ⚡.
// Выключенный тумблер «Учитывать в прогоне» (enabled:false в снапшоте) — чипов нет.
function renderDecisionChips(rs, okRuns) {
  const wrap = document.getElementById("decision-chips");
  if (!wrap) return;
  wrap.innerHTML = "";
  const d = rs.decision;
  if (!d || d.enabled === false || !d.outcomes || !d.outcomes.length) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const labels = [];
  const questions = resultQuestions(rs);
  const title = document.createElement("span");
  title.className = "decision-chips-title";
  title.textContent = "Решение:";
  wrap.appendChild(title);
  for (const run of okRuns) {
    const { res, trace } = explainDecision(d, run.res.answers || {});
    const chip = document.createElement("span");
    chip.className = "decision-chip";
    const name = `${modelLabel(run.key)}${runs_mode_suffix(run)}`;
    if (res) {
      const colors = OUTCOME_COLORS[res.color] || OUTCOME_COLORS.gray;
      chip.style.background = colors.bg;
      chip.style.color = colors.fg;
      chip.style.borderColor = colors.border;
      chip.textContent = `${name}: ${res.label}`;
      labels.push(res.label);
    } else {
      chip.classList.add("decision-chip-none");
      chip.textContent = `${name}: не определено`;
      labels.push(null);
    }
    attachDecisionTip(chip, res, trace, questions, name);
    wrap.appendChild(chip);
  }
  const distinct = new Set(labels.filter(x => x != null));
  if (distinct.size > 1) {
    const warn = document.createElement("span");
    warn.className = "decision-chip decision-chip-diff";
    warn.textContent = "⚡ решения различаются";
    wrap.appendChild(warn);
  }
}

function runs_mode_suffix(run) {
  return run.mode && run.mode !== "decisions" ? ` (${MODE_LABELS[run.mode] || run.mode})` : "";
}

function renderRunChip(run, questions) {
  const chip = document.createElement("div");
  chip.className = "run-chip";
  if (!run.res.ok) chip.classList.add("run-chip-error");

  const head = document.createElement("div");
  head.className = "run-chip-head";

  const title = document.createElement("span");
  title.className = "run-chip-title";
  title.textContent = `${modelLabel(run.key)} · ${MODE_LABELS[run.mode] || run.mode}`;
  head.appendChild(title);

  const runImages = state.results && state.results.images;
  if (runImages && runImages.length) {
    const ib = document.createElement("span");
    ib.className = "run-chip-images";
    ib.textContent = `🖼 ${runImages.length}`;
    ib.title = `в прогоне ${runImages.length} изображений`;
    head.appendChild(ib);
  }

  if (!run.res.ok) {
    const err = document.createElement("span");
    err.className = "run-chip-error-text";
    err.textContent = run.res.error || "Неизвестная ошибка";
    head.appendChild(err);
    chip.appendChild(head);
    return chip;
  }

  const m = run.res.metrics || {};
  const parts = [];
  if (m.duration_s != null) parts.push(`${m.duration_s.toFixed(1)} с`);
  if (m.prefill_tok_s != null) parts.push(`${Math.round(m.prefill_tok_s)} ток/с`);
  else if (m.prompt_tokens != null) parts.push(`${m.prompt_tokens} ток`);
  if (parts.length) {
    const metrics = document.createElement("span");
    metrics.className = "run-chip-metrics";
    metrics.textContent = "— " + parts.join(" · ");
    head.appendChild(metrics);
  }

  let detail = null;
  head.addEventListener("click", (e) => {
    e.stopPropagation();
    if (detail) {
      detail.remove();
      detail = null;
    } else {
      hideTip();
      detail = renderRunDetail(run, questions);
      chip.appendChild(detail);
    }
  });

  chip.appendChild(head);
  return chip;
}

// ---------------------------------------------------------------- дрилдаун ответа

export function renderAnswerDrilldown(ans, question, run) {
  const detail = document.createElement("div");
  detail.className = "res-detail";

  const caption = document.createElement("div");
  caption.className = "res-detail-caption";
  caption.textContent = run
    ? `${modelLabel(run.key)} · ${MODE_LABELS[run.mode] || run.mode}`
    : "ответ";
  detail.appendChild(caption);

  // Миниатюры изображений, отправленных в этом прогоне (одиночный режим).
  const drillImages = state.pageMode === "single" && state.results && state.results.images;
  if (drillImages && drillImages.length) {
    const strip = document.createElement("div");
    strip.className = "run-images";
    strip.title = "Изображения, отправленные в этом прогоне — клик: увеличить";
    drillImages.forEach((dataUrl, i) => {
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = "изображение материала";
      const name = `изображение ${i + 1}`;
      img.addEventListener("click", (e) => {
        e.stopPropagation();
        openLightbox({ src: dataUrl, name });
      });
      strip.appendChild(img);
    });
    detail.appendChild(strip);
  }

  detail.appendChild(fullViz(ans, question));

  if (run && run.res && run.res.usage) {
    const usage = document.createElement("pre");
    usage.className = "raw-json";
    usage.textContent = "usage: " + JSON.stringify(run.res.usage, null, 2);
    detail.appendChild(usage);
  }

  if (ans.label_mass != null) {
    const massLine = document.createElement("div");
    massLine.className = "answer-warn-line";
    massLine.style.color = ans.label_mass < 0.5 ? "var(--warn)" : "var(--muted)";
    massLine.style.fontWeight = ans.label_mass < 0.5 ? "700" : "400";
    massLine.textContent = ans.label_mass < 0.5
      ? `⚠ ${MASS_WARN_TEXT} (доля на вариантах ${pct(ans.label_mass, 0)})`
      : `доля на вариантах ${pct(ans.label_mass, 0)}`;
    detail.appendChild(massLine);
  }

  const rawBtn = document.createElement("button");
  rawBtn.className = "btn btn-small";
  rawBtn.textContent = "сырой JSON";
  rawBtn.style.marginTop = "8px";
  let raw = null;
  rawBtn.onclick = (e) => {
    e.stopPropagation();
    if (raw) {
      raw.remove();
      raw = null;
    } else {
      raw = document.createElement("pre");
      raw.className = "raw-json";
      raw.textContent = JSON.stringify(ans, null, 2);
      detail.appendChild(raw);
    }
  };
  detail.appendChild(rawBtn);
  return detail;
}

// ---------------------------------------------------------------- сравнение значений

function answerTopValue(ans) {
  const p = ans.probabilities || {};
  if (ans.type === "yes_no") return (p.yes ?? 0) >= (p.no ?? 0) ? "yes" : "no";
  if (ans.type === "choice") return ans.choice ?? null;
  if (ans.type === "score") return ans.score ?? null;
  return null;
}

export function pairsDisagree(pairs) {
  const vals = pairs.map(x => answerTopValue(x.ans)).filter(v => v != null);
  if (vals.length < 2) return false;
  if (pairs[0].ans.type === "score") {
    for (let i = 0; i < vals.length; i++)
      for (let j = i + 1; j < vals.length; j++)
        if (Math.abs(vals[i] - vals[j]) >= 0.5) return true;
    return false;
  }
  return vals.some(v => v !== vals[0]);
}

function disagreementText(q, pairs) {
  if (!pairsDisagree(pairs)) return null;
  const parts = pairs.map(x => `${modelLabel(x.run.key)} (${MODE_LABELS[x.run.mode] || x.run.mode}): ${shortAnswer(x.ans)}`);
  return "расхождение: " + parts.join("  |  ");
}

// Тег прогона: что различается между прогонами — модель или режим.
function runTag(run, allRuns) {
  const models = new Set(allRuns.map(r => r.key));
  const modes = new Set(allRuns.map(r => r.mode));
  const parts = [];
  if (models.size > 1) parts.push(modelShortLabel(run.key));
  if (modes.size > 1) parts.push(MODE_LABELS[run.mode] || run.mode);
  if (!parts.length) parts.push(modelLabel(run.key));
  return parts.join(" · ");
}

function confBlocks(conf) {
  const total = 8;
  const filled = Math.round(conf * total);
  const span = document.createElement("span");
  span.className = "conf-blocks cb-" + confClass(conf).replace("conf-", "");
  span.textContent = "▮".repeat(filled) + "▯".repeat(total - filled);
  span.title = `уверенность ${pct(conf, 0)}`;
  return span;
}

function massWarnIcon(ans) {
  const warn = document.createElement("span");
  warn.className = "answer-warn";
  warn.textContent = "⚠";
  warn.title = `⚠ ${MASS_WARN_TEXT} (доля на вариантах ${pct(ans.label_mass ?? 0, 0)})`;
  return warn;
}

// ---------------------------------------------------------------- строки вопросов

function questionIcon(q) {
  return typeIcon(q.type);
}

// Режим A: один прогон — одна строка на вопрос.
function renderRowA(q, run) {
  const ans = run.res.answers && run.res.answers[q.id];
  if (!ans) return null;

  const row = document.createElement("div");
  row.className = "res-row";

  row.appendChild(questionIcon(q));
  const qText = document.createElement("span");
  qText.className = "res-q-text";
  qText.textContent = q.question;
  qText.title = q.question;
  row.appendChild(qText);

  row.appendChild(rowViz(ans, q));

  const answer = document.createElement("span");
  answer.className = "res-answer " + confClass(answerConfidence(ans));
  if (ans.type === "score") {
    const n = Math.max(Object.keys(ans.probabilities || {}).length, 2);
    answer.textContent = `${(ans.score ?? 0).toFixed(1)} из ${n - 1} · ${pct(answerConfidence(ans), 0)}`;
    const dirCls = scoreDirClass(q, (ans.score ?? 0) + 1);
    if (dirCls) answer.classList.add(dirCls);
  } else {
    answer.textContent = shortAnswer(ans);
    const dirCls = yesNoDirClass(q, ans);
    if (dirCls) answer.classList.add(dirCls);
  }
  row.appendChild(answer);

  if (ans.label_mass != null && ans.label_mass < 0.5) row.appendChild(massWarnIcon(ans));

  const chevron = document.createElement("span");
  chevron.className = "res-chevron";
  chevron.textContent = "▾";
  row.appendChild(chevron);

  row.addEventListener("mouseenter", () => {
    showTip(row, (tip) => tip.appendChild(distributionBars(ans, q)));
  });
  row.addEventListener("mouseleave", hideTip);

  let detail = null;
  const toggle = () => {
    if (detail) {
      detail.remove();
      detail = null;
      row.classList.remove("open");
    } else {
      hideTip();
      detail = renderAnswerDrilldown(ans, q, run);
      row.after(detail);
      row.classList.add("open");
    }
  };
  row.addEventListener("click", toggle);

  return { row, toggle };
}

// Режим B: сравнение — по ячейке на прогон, все прогоны видны (переносятся на новую строку).
function renderRowB(q, runs) {
  const pairs = runs
    .map(run => ({ run, ans: run.res.answers && run.res.answers[q.id] }))
    .filter(x => x.ans);
  if (pairs.length === 0) return null;

  const disagree = pairsDisagree(pairs);
  const sorted = pairs.slice().sort((a, b) => answerConfidence(b.ans) - answerConfidence(a.ans));

  const row = document.createElement("div");
  row.className = "res-row" + (disagree ? " diff" : "");

  row.appendChild(questionIcon(q));
  const qText = document.createElement("span");
  qText.className = "res-q-text";
  qText.textContent = q.question;
  qText.title = q.question;
  row.appendChild(qText);

  sorted.forEach(({ run, ans }, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "res-cell-sep";
      sep.textContent = "│";
      row.appendChild(sep);
    }
    const cell = document.createElement("div");
    cell.className = "res-cell";
    const tag = document.createElement("span");
    tag.className = "res-cell-tag";
    tag.textContent = runTag(run, runs);
    const val = document.createElement("span");
    val.className = "res-cell-val";
    val.textContent = shortAnswer(ans);
    val.title = shortAnswer(ans);
    if (ans.type === "score") {
      const dirCls = scoreDirClass(q, (ans.score ?? 0) + 1);
      if (dirCls) val.classList.add(dirCls);
    } else if (ans.type === "yes_no") {
      const dirCls = yesNoDirClass(q, ans);
      if (dirCls) val.classList.add(dirCls);
    }
    cell.append(tag, val, confBlocks(answerConfidence(ans)));
    if (ans.label_mass != null && ans.label_mass < 0.5) cell.appendChild(massWarnIcon(ans));
    // Ховер на ячейке — распределение только этого прогона.
    cell.addEventListener("mouseenter", () => {
      showTip(cell, (tip) => {
        const t = document.createElement("div");
        t.className = "dist-tip-title";
        t.textContent = `${modelLabel(run.key)} · ${MODE_LABELS[run.mode] || run.mode}`;
        tip.appendChild(t);
        tip.appendChild(distributionBars(ans, q));
      });
    });
    cell.addEventListener("mouseleave", hideTip);
    row.appendChild(cell);
  });

  if (disagree) {
    const mark = document.createElement("span");
    mark.className = "diff-mark";
    mark.textContent = "⚡";
    mark.title = "прогоны расходятся в ответе";
    row.appendChild(mark);
  }

  const chevron = document.createElement("span");
  chevron.className = "res-chevron";
  chevron.textContent = "▾";
  row.appendChild(chevron);

  // Ховер на тексте вопроса — распределения всех прогонов рядом.
  qText.addEventListener("mouseenter", () => {
    showTip(row, (tip) => {
      for (const { run, ans } of sorted) {
        const t = document.createElement("div");
        t.className = "dist-tip-title";
        t.textContent = `${modelLabel(run.key)} · ${MODE_LABELS[run.mode] || run.mode}`;
        tip.appendChild(t);
        tip.appendChild(distributionBars(ans, q));
      }
    });
  });
  qText.addEventListener("mouseleave", hideTip);

  let detail = null;
  row.addEventListener("click", () => {
    if (detail) {
      detail.remove();
      detail = null;
      row.classList.remove("open");
    } else {
      hideTip();
      detail = document.createElement("div");
      detail.className = "res-detail";
      const disText = disagreementText(q, pairs);
      if (disText) {
        const plate = document.createElement("div");
        plate.className = "disagree-plate";
        plate.textContent = disText;
        detail.appendChild(plate);
      }
      for (const { run, ans } of sorted) {
        const section = document.createElement("div");
        section.className = "res-detail-section";
        section.appendChild(renderAnswerDrilldown(ans, q, run));
        detail.appendChild(section);
      }
      row.after(detail);
      row.classList.add("open");
    }
  });

  return row;
}

// ---------------------------------------------------------------- сводка

function meanConfidence(runs, questions) {
  let sum = 0, n = 0;
  for (const run of runs) {
    for (const q of questions) {
      const ans = run.res.answers && run.res.answers[q.id];
      if (!ans) continue;
      sum += answerConfidence(ans);
      n += 1;
    }
  }
  return n ? sum / n : null;
}

// Согласие по вопросам для режима B: «сошлись по 7 из 10».
function agreement(runs, questions) {
  let agree = 0, total = 0;
  for (const q of questions) {
    const pairs = runs
      .map(run => ({ run, ans: run.res.answers && run.res.answers[q.id] }))
      .filter(x => x.ans);
    if (pairs.length < 2) continue;
    total += 1;
    if (!pairsDisagree(pairs)) agree += 1;
  }
  return { agree, total };
}

// ---------------------------------------------------------------- render

export function renderResults() {
  hideTip(); // строки пересоздаются — висящий тултип со старыми данными недопустим
  const sticky = document.getElementById("results-sticky");
  const list = document.getElementById("results-list");
  const rs = state.results;

  if (!rs || state.pageMode !== "single") {
    sticky.classList.add("hidden");
    list.innerHTML = "";
    if (state.pageMode === "single") {
      const empty = document.createElement("div");
      empty.className = "results-empty";
      empty.textContent = "Запустите прогон — результаты появятся здесь.";
      list.appendChild(empty);
    }
    return;
  }

  sticky.classList.remove("hidden");
  list.innerHTML = "";

  const questions = resultQuestions();
  const runs = flattenRuns(rs);
  const okRuns = runs.filter(r => r.res.ok);

  // сводка
  const summary = document.getElementById("results-summary");
  const parts = [`${questions.length} ${plural(questions.length, "вопрос", "вопроса", "вопросов")}`];
  const conf = meanConfidence(okRuns, questions);
  if (conf != null) parts.push(`уверенность ${pct(conf, 0)}`);
  summary.textContent = parts.join(" · ");

  // чип согласия (режим B)
  const agreeChip = document.getElementById("results-agree");
  if (okRuns.length >= 2) {
    const { agree, total } = agreement(okRuns, questions);
    if (total > 0) {
      agreeChip.textContent = `сошлись по ${agree} из ${total}`;
      agreeChip.classList.toggle("disagree", agree < total);
      agreeChip.classList.remove("hidden");
    } else {
      agreeChip.classList.add("hidden");
    }
  } else {
    agreeChip.classList.add("hidden");
  }

  // чипы прогонов
  const chipsWrap = document.getElementById("run-chips");
  chipsWrap.innerHTML = "";
  for (const run of runs) chipsWrap.appendChild(renderRunChip(run, questions));

  // решения по правилам (снимок на момент прогона) — по чипу на прогон
  renderDecisionChips(rs, okRuns);

  // подсказка для режима «Оба»
  document.getElementById("both-hint").classList.toggle("hidden", rs.runMode !== "both");

  if (okRuns.length === 0) {
    const empty = document.createElement("div");
    empty.className = "results-empty";
    empty.textContent = "Все прогоны завершились ошибкой — детали в чипах выше.";
    list.appendChild(empty);
    return;
  }

  if (okRuns.length === 1) {
    for (const q of questions) {
      const rendered = renderRowA(q, okRuns[0]);
      if (rendered) list.appendChild(rendered.row);
    }
  } else {
    for (const q of questions) {
      const row = renderRowB(q, okRuns);
      if (row) list.appendChild(row);
    }
  }
}
