// Карточки «Разбор прогона» и «Очередь разметки» (ассистент v1.1, порция 3).
// Частоты, группировку и отбор кандидатов считает бэк (analysis.py) — карточки
// только показывают payload SSE-событий analysis/review_queue и дают действия:
// «предложить правку →» — системная реплика ассистенту (sendMessage),
// «разметить →» — телепорт к ячейке + запуск мини-навигатора очереди
// (navigator.js; revealTarget из review.js умеет flash+scrollIntoView+
// panel-aware досcroll). Это информационные карточки — без «Принять»/
// «Отклонить» (pending-очередь порции 2 их не касается).
// Находки с полями mechanism/example раскрываются на месте (details, макет
// 6.1а: механика + пример-flink; оба null — плоская строка), протокол steps —
// disclosure «Шаги (n)» в футере. Справочные карточки сворачиваются вручную
// («свернуть» у eyebrow → t-row «▸ … · развернуть», макеты 6.3/7.1); исчерпанная
// очередь — t-row «Готово» + «вернуться к разбору →» (макет 7.2).
// deps: { sendMessage(text, opts), openPanel(), persistCollapsed(card, on),
// backToAnalysis() } — передаёт assistant.js (прямой импорт замкнул бы цикл
// модулей).

import { state } from "./state.js";
import { modelShortLabel, flattenRuns, resultQuestions, shortAnswer,
         answerConfidence } from "./results.js";
import { explainDecision } from "./decision.js";
import { fileLinkEl } from "./flink.js";
import * as reviewMod from "./review.js";
import * as navigatorMod from "./navigator.js";

function _plural(n, one, few, many) {
  if (n % 10 === 1 && n % 100 !== 11) return `${n} ${one}`;
  if (2 <= n % 10 && n % 10 <= 4 && !(12 <= n % 100 && n % 100 <= 14)) {
    return `${n} ${few}`;
  }
  return `${n} ${many}`;
}

// ---------------------------------------------------------------- счётчик кандидатов (quick-chips)

const LOW_CONF = 0.6;        // как LOW_CONFIDENCE в backend/assistant/analysis.py
const NEAR_PROB = 0.10;      // близость к порогу вероятности (0..1 = 10 п.п.)
const NEAR_SCORE = 0.5;      // близость к порогу среднего балла

// Число неразмеченных ячеек-кандидатов на разметку активной страницы — для
// чипа «Что разметить (N)». Лёгкая фронтова реплика compute_review_queue
// (analysis.py): те же данные из state, та же логика (⚡ расхождение — 1 на
// единицу; у порога; низкая уверенность; только неразмеченные, дедупликация
// по ячейке). Ответы берутся из сырых результатов (probabilities), а не из
// shortAnswer-строк — точность выше, чем у бэкенда.
export function countReviewQueueCandidates() {
  const batch = state.pageMode === "batch";
  const candidates = new Set();
  const units = []; // {cells: [{key, qid, ans}], answersByQid, decision, nearKey(unit, det)}

  const answersOfRes = (res) => {
    const r = res && (res.decisions || res.fast_batch || res);
    return r && r.ok && r.answers ? r.answers : null;
  };

  if (batch) {
    const results = state.batch.results || {};
    const qs = (state.batch.questions && state.batch.questions.length)
      ? state.batch.questions : state.questions;
    for (const [fid, per] of Object.entries(results)) {
      for (const [mk, res] of Object.entries(per || {})) {
        const answers = answersOfRes(res);
        if (!answers) continue;
        const cells = [];
        for (const q of qs) {
          const ans = answers[q.id];
          if (!ans) continue;
          cells.push({ key: `${fid}|${q.id}|${mk}`, qid: q.id, ans,
                       target: { scope: "batch", file: fid, question: q.id,
                                 model: mk } });
        }
        units.push({ cells, decision: state.batch.decision, answers });
      }
    }
  } else {
    const rs = state.results;
    if (!rs || !rs.results) return 0;
    const qs = resultQuestions(rs);
    for (const run of flattenRuns(rs)) {
      const answers = answersOfRes(run.res);
      if (!answers) continue;
      const cells = [];
      for (const q of qs) {
        const ans = answers[q.id];
        if (!ans) continue;
        cells.push({ key: `${q.id}|${run.key}`, qid: q.id, ans,
                     target: { scope: "single", model: run.key, mode: run.mode,
                               question: q.id } });
      }
      units.push({ cells, decision: rs.decision, answers });
    }
  }
  if (!units.length) return 0;

  const marked = (target) => {
    try { return !!reviewMod.findMark(target.scope, target); }
    catch { return false; }
  };

  // ⚡ расхождение моделей: единица (файл/вопрос или single-вопрос) → 1
  // кандидат (по ячейке с наименьшей уверенностью, как на бэке)
  const groups = new Map(); // gkey → cells[]
  for (const u of units) {
    for (const c of u.cells) {
      const gkey = batch ? `${c.target.file}|${c.qid}` : c.qid;
      if (!groups.has(gkey)) groups.set(gkey, []);
      groups.get(gkey).push(c);
    }
  }
  for (const cells of groups.values()) {
    if (cells.length < 2) continue;
    const labels = new Set(cells.map(c => shortAnswer(c.ans)));
    if (labels.size < 2) continue;
    const sorted = [...cells].sort((a, b) => answerConfidence(a.ans)
      - answerConfidence(b.ans));
    const cell = sorted.find(c => !marked(c.target));
    if (cell) candidates.add(cell.key);
  }

  for (const u of units) {
    // у порога решения: условия из trace (value/threshold уже в шкале движка)
    const d = u.decision;
    if (d && d.enabled !== false && (d.outcomes || []).length) {
      let trace = [];
      try { trace = explainDecision(d, u.answers).trace; } catch { trace = []; }
      for (const t of trace) {
        for (const det of t.conditions || []) {
          if (det.value == null) continue;
          const margin = Math.abs(det.value - det.threshold);
          const near = det.kind === "prob" ? margin <= NEAR_PROB
            : margin <= NEAR_SCORE;
          if (!near) continue;
          const cell = u.cells.find(c => c.qid === det.question);
          if (cell && !marked(cell.target)) candidates.add(cell.key);
        }
      }
    }
    // низкая уверенность top-ответа (score-ответы без conf пропускаем)
    for (const c of u.cells) {
      if ((c.ans.probabilities || null) && answerConfidence(c.ans) < LOW_CONF
          && !marked(c.target)) {
        candidates.add(c.key);
      }
    }
  }
  return candidates.size;
}

// ---------------------------------------------------------------- подписи

export function analysisBrief(data) {
  const s = (data && data.stats) || {};
  const parts = [];
  if (data && data.page === "batch" && s.files) {
    parts.push(_plural(s.files, "файл", "файла", "файлов"));
  }
  if (s.models) parts.push(`${s.models} мод.`);
  if (s.questions) parts.push(`${s.questions} вопр.`);
  let text = "Разбор прогона";
  if (parts.length) text += " · " + parts.join(" × ");
  const marks = s.marks || {};
  const total = (marks.accept || 0) + (marks.reject || 0) + (marks.unsure || 0);
  if (total) text += ` · по вашим ${_plural(total, "пометке", "пометкам", "пометкам")}`;
  return text;
}

export function queueBrief(data) {
  const n = (data && (data.candidates || []).length) || 0;
  return `Очередь разметки · ${_plural(n, "кандидат", "кандидата", "кандидатов")}`;
}

// Подпись кандидата: batch — «файл · №вопрос · модель»; single (макет 4) —
// «вопрос №3 · Qwen». model у single-кандидатов — короткий лейбл (бэк знает
// только его), у batch — ключ модели (лейбл выводим через modelShortLabel).
function candidateLabel(cand) {
  const model = cand.model ? modelShortLabel(cand.model) : null;
  if ((cand.target || {}).scope === "batch" || cand.file) {
    return [cand.file, cand.questionN ? `№${cand.questionN}` : null, model]
      .filter(Boolean).join(" · ");
  }
  return [`вопрос №${cand.questionN}`, model].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------- цели

// Цель кандидата → координаты revealTarget/findMark (конвенция review.js).
// batch: бэк отдаёт id файла (batchFiles[].id); на старых снапшотах — имя,
// резолвим по пакету. single: modelLabel → ключ+режим прогона (flattenRuns);
// без совпадения — цель уровня вопроса (строка).
export function resolveCandidateTarget(cand) {
  const t = (cand && cand.target) || {};
  if (t.scope === "batch") {
    let file = t.file;
    if (file && !state.batch.files.some(f => f.id === file)) {
      const byName = state.batch.files.find(f => f.name === (cand.file || file));
      if (byName) file = byName.id;
    }
    return { scope: "batch", file, question: t.question, model: t.model };
  }
  if (t.modelLabel) {
    const runs = flattenRuns(state.results);
    const run = runs.find(r => modelShortLabel(r.key) === t.modelLabel);
    if (run) {
      return { scope: "single", model: run.key, mode: run.mode,
               question: t.question };
    }
  }
  return { scope: "single", question: t.question };
}

// Элемент навигатора из кандидата; null — цель неполная (устаревший снапшот).
function navItemOf(cand) {
  const target = resolveCandidateTarget(cand);
  if (!target || !target.question) return null;
  if (target.scope === "batch" && (!target.file || !target.model)) return null;
  return { scope: target.scope, target, label: candidateLabel(cand),
           reason: cand.reason || "" };
}

function startQueue(candidates, card, deps, startAt = 0) {
  const items = [];
  candidates.forEach((c, i) => {
    const it = navItemOf(c);
    if (it) items.push({ ...it, _i: i });
  });
  if (!items.length) return;
  const at = Math.max(0, items.findIndex(x => x._i === startAt));
  navigatorMod.startNavigator(
    items.map(({ _i, ...rest }) => rest),
    { origin: card, deps, startAt: at < 0 ? 0 : at });
}

// ---------------------------------------------------------------- общее

function actionEl(cls, text, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function rawDetailsEl(summaryText, lines) {
  const det = document.createElement("details");
  det.className = "assistant-analysis-raw assistant-exp";
  const sum = document.createElement("summary");
  sum.textContent = summaryText;
  det.appendChild(sum);
  const body = document.createElement("div");
  body.className = "assistant-details-body";
  body.textContent = lines.join("\n");
  det.appendChild(body);
  return det;
}

// Длительность шага протокола: «12 с» / «2 мин 05 с» (как fmtDurationRu
// живого прогона в assistant.js; сюда не импортируется — цикл модулей).
function fmtStepMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  return `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, "0")} с`;
}

// Протокол разбора (макет 6.1а, «Шаги (n)»): номер · label — длительность/note.
// ms=0 — без длительности (по макету шаги 3–4 показаны без времени: честнее
// скрыть ноль, чем показывать «0 с»); note выводится всегда, когда есть.
function stepsDetailsEl(steps) {
  const det = document.createElement("details");
  det.className = "assistant-exp assistant-steps";
  const sum = document.createElement("summary");
  sum.textContent = `Шаги (${steps.length})`;
  det.appendChild(sum);
  const body = document.createElement("div");
  body.className = "assistant-exp-body";
  steps.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "assistant-step";
    const mk = document.createElement("span");
    mk.className = "assistant-step-mk";
    mk.textContent = String(i + 1);
    const tx = document.createElement("span");
    const parts = [];
    if (s.ms) parts.push(fmtStepMs(s.ms));
    if (s.note) parts.push(s.note);
    tx.textContent = s.label + (parts.length ? " — " + parts.join(" · ") : "");
    row.append(mk, tx);
    body.appendChild(row);
  });
  det.appendChild(body);
  return det;
}

// ---------------------------------------------------------------- разбор

const BADGE_CLS = { marks: "reject", "marks-model": "reject",
                    disagreement: "warn", threshold: "warn",
                    lowconf: "neutral", comments: "neutral" };

// Inline disclosure находки (макет 6.1а, details.find): summary — суть
// (title), body — механика (mechanism) и пример (example {file, question}:
// имя файла — flink с hover-превью, question — текст вопроса от бэка).
// Оба поля null — disclosure нет, строка остаётся плоской.
function findingDetailsEl(cat) {
  const det = document.createElement("details");
  det.className = "assistant-exp assistant-find";
  const sum = document.createElement("summary");
  sum.textContent = cat.title;
  det.appendChild(sum);
  const body = document.createElement("div");
  body.className = "assistant-exp-body";
  if (cat.mechanism) {
    const mech = document.createElement("div");
    mech.className = "assistant-find-mechanism";
    mech.textContent = cat.mechanism;
    body.appendChild(mech);
  }
  const ex = cat.example;
  if (ex && ex.file) {
    const line = document.createElement("div");
    line.className = "assistant-find-example";
    line.appendChild(document.createTextNode("Пример: "));
    line.appendChild(fileLinkEl(ex.file));
    if (ex.question) {
      line.appendChild(document.createTextNode(` · ${ex.question}`));
    }
    body.appendChild(line);
  }
  det.appendChild(body);
  return det;
}

function categoryRowEl(cat, card, deps) {
  const row = document.createElement("div");
  row.className = "assistant-analysis-row";
  const badge = document.createElement("span");
  badge.className = "assistant-analysis-badge assistant-analysis-badge-"
    + (BADGE_CLS[cat.kind] || "neutral");
  badge.textContent = `${cat.icon} ${cat.count}`;
  const text = document.createElement("span");
  text.className = "assistant-analysis-text";
  if (cat.mechanism || (cat.example && cat.example.file)) {
    text.appendChild(findingDetailsEl(cat));
    if (cat.detail) {
      text.appendChild(document.createTextNode(` — ${cat.detail}`));
    }
  } else {
    text.textContent = `${cat.title} — ${cat.detail}`;
  }
  row.append(badge, text);
  if (cat.action === "fix") {
    row.appendChild(actionEl("assistant-analysis-action", "предложить правку →",
      () => {
        if (deps.sendMessage) {
          deps.sendMessage(`По разбору прогона: ${cat.title} (${cat.detail}). `
                           + "Предложи конкретную правку.", { system: true });
        }
      }));
  } else if (cat.action === "review" && (cat.cells || []).length) {
    row.appendChild(actionEl("assistant-analysis-action", "разметить →",
      () => startQueue(cat.cells, card, deps)));
  }
  return row;
}

// Холодный старт (no_marks): петля замыкается на разметку. Кнопку
// «✨ Предразметить автоматически» осознанно нет — это v1.4.
function coldstartEl(deps) {
  const box = document.createElement("div");
  box.className = "assistant-analysis-coldstart";
  const head = document.createElement("div");
  head.className = "assistant-analysis-coldstart-title";
  head.textContent = "Разметки пока нет — по ней я считаю эффект правок";
  const text = document.createElement("div");
  text.className = "assistant-analysis-coldstart-text";
  text.textContent = "Начните с 5 самых информативных ячеек — это займёт пару "
    + "минут и даст основу для анализа. Дальше подхватит разбор.";
  const btn = actionEl("assistant-analysis-primary", "Показать 5 ячеек", () => {
    if (deps.sendMessage) {
      deps.sendMessage("Что разметить дальше? Покажи 5 самых информативных ячеек.",
                       { system: true });
    }
  });
  box.append(head, text, btn);
  return box;
}

// Ручное сворачивание справочной карточки (макеты 6.1/7.1 «свернуть» →
// 6.3 t-row «▸ <brief> · развернуть»). Авто-схлопывание серии
// (collapseInfoCard в assistant.js) — отдельная форма: заголовок-экспандер.
// Persist — через deps.persistCollapsed (assistant.js), восстановление из
// persist — collapsed: "manual" (feedItemNode вызывает эту же функцию).
export function setInfoRowCollapsed(card, collapsed) {
  if (!card._infoRow) {
    const row = document.createElement("div");
    row.className = "assistant-term-row assistant-info-row";
    row.setAttribute("tabindex", "0");
    const marker = document.createElement("span");
    marker.className = "assistant-info-row-marker";
    marker.textContent = "▸";
    const sum = document.createElement("span");
    sum.className = "assistant-term-sum";
    sum.textContent = card._infoBrief || "";
    const acts = document.createElement("span");
    acts.className = "assistant-term-acts";
    acts.appendChild(actionEl("assistant-link-quiet assistant-info-expand",
                              "развернуть",
                              () => setInfoRowCollapsed(card, false)));
    row.append(marker, sum, acts);
    row.title = "Развернуть";
    row.addEventListener("click", () => setInfoRowCollapsed(card, false));
    card.appendChild(row);
    card._infoRow = row;
  }
  for (const ch of [...card.children]) {
    if (ch === card._infoRow) continue;
    ch.classList.toggle("hidden", collapsed);
  }
  card._infoRow.classList.toggle("hidden", !collapsed);
  if (card._infoDeps && card._infoDeps.persistCollapsed) {
    card._infoDeps.persistCollapsed(card, collapsed);
  }
}

// Верхний ряд справочной карточки (макет 6.1/7.1, c-top): eyebrow-заголовок +
// тихое «свернуть» справа.
function infoTopEl(card, title, deps) {
  card._infoBrief = title.textContent;
  card._infoDeps = deps;
  const top = document.createElement("div");
  top.className = "assistant-info-top";
  top.appendChild(title);
  top.appendChild(actionEl("assistant-link-quiet assistant-info-collapse",
                           "свернуть", () => setInfoRowCollapsed(card, true)));
  return top;
}

export function analysisCardEl(data, deps = {}) {
  const card = document.createElement("div");
  card.className = "assistant-proposal assistant-analysis";
  const title = document.createElement("div");
  title.className = "assistant-info-title";
  if (!data || data.empty) {
    card.appendChild(title);
    title.textContent = "Разбор прогона";
    const p = document.createElement("div");
    p.className = "assistant-analysis-headline";
    p.textContent = "Прогона на активной странице ещё нет — сначала запустите его.";
    card.appendChild(p);
    return card;
  }
  title.textContent = analysisBrief(data);
  card.appendChild(infoTopEl(card, title, deps));
  const cats = data.categories || [];
  const headline = document.createElement("div");
  headline.className = "assistant-analysis-headline";
  headline.textContent = cats.length
    ? cats[0].title + (cats.length > 1
        ? ` Ещё ${cats.length - 1} ниже.` : "")
    : "Явных проблем не нашёл — расхождений и зон риска нет.";
  card.appendChild(headline);
  if (data.no_marks) card.appendChild(coldstartEl(deps));
  for (const cat of cats) card.appendChild(categoryRowEl(cat, card, deps));
  const hasRaw = (data.raw || []).length > 0;
  const hasSteps = (data.steps || []).length > 0;
  if (hasRaw || hasSteps) {
    // служебные disclosure — в один ряд свёрнутые; раскрытый — на всю ширину
    // (CSS :has(details[open]) перестраивает контейнер в столбец)
    const foot = document.createElement("div");
    foot.className = "assistant-card-disclosures";
    if (hasRaw) {
      foot.appendChild(rawDetailsEl("Почему такой вывод (расчёты по данным прогона)",
                                    data.raw));
    }
    if (hasSteps) foot.appendChild(stepsDetailsEl(data.steps));
    card.appendChild(foot);
  }
  return card;
}

// ---------------------------------------------------------------- очередь

function queueRowEl(cand, candidates, idx, card, deps) {
  const row = document.createElement("div");
  row.className = "assistant-queue-row";
  const start = () => startQueue(candidates, card, deps, idx);
  const link = actionEl("assistant-queue-link", candidateLabel(cand), start);
  link.title = "Показать в результатах";
  const reason = document.createElement("span");
  reason.className = "assistant-queue-reason";
  reason.textContent = cand.reason || "";
  row.append(link, reason,
             actionEl("assistant-queue-action", "разметить →", start));
  return row;
}

export function queueCardEl(data, deps = {}) {
  const card = document.createElement("div");
  card.className = "assistant-proposal assistant-queue";
  const title = document.createElement("div");
  title.className = "assistant-info-title";
  if (!data || data.empty) {
    card.appendChild(title);
    title.textContent = "Очередь разметки";
    const p = document.createElement("div");
    p.className = "assistant-queue-headline";
    p.textContent = "Прогона нет — размечать пока нечего.";
    card.appendChild(p);
    return card;
  }
  const cands = data.candidates || [];
  if (data.done || !cands.length) {
    // исчерпанная очередь (макет 7.2) — терминальная строка «Готово · суть ·
    // вернуться к разбору →»; счётчика размеченного в payload нет — не выдумываем
    card.classList.add("assistant-proposal-terminal");
    const row = document.createElement("div");
    row.className = "assistant-term-row assistant-queue-done";
    row.setAttribute("tabindex", "0");
    const pill = document.createElement("span");
    pill.className = "assistant-proposal-status applied";
    pill.textContent = "Готово";
    const sum = document.createElement("span");
    sum.className = "assistant-term-sum";
    sum.textContent = "Всё размечено — спорных ячеек без пометок не осталось. "
      + "Новые кандидаты появятся после следующего прогона.";
    const acts = document.createElement("span");
    acts.className = "assistant-term-acts";
    acts.appendChild(actionEl("assistant-link", "вернуться к разбору →", () => {
      if (deps.backToAnalysis) deps.backToAnalysis();
    }));
    row.append(pill, sum, acts);
    card.appendChild(row);
    return card;
  }
  title.textContent = queueBrief(data);
  card.appendChild(infoTopEl(card, title, deps));
  const headline = document.createElement("div");
  headline.className = "assistant-queue-headline";
  headline.textContent = `${_plural(cands.length, "метка", "метки", "меток")}, `
    + "которые изменят больше всего";
  card.appendChild(headline);
  cands.forEach((cand, i) => {
    card.appendChild(queueRowEl(cand, cands, i, card, deps));
  });
  if ((data.total || 0) > cands.length) {
    const foot = document.createElement("div");
    foot.className = "assistant-queue-footer";
    foot.appendChild(actionEl(
      "assistant-queue-action", `показать ещё ${data.total - cands.length}`,
      () => {
        if (deps.sendMessage) {
          deps.sendMessage("Покажи очередь разметки полнее — до 10 кандидатов.",
                           { system: true });
        }
      }));
    card.appendChild(foot);
  }
  return card;
}
