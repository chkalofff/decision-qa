// Карточки «Разбор прогона» и «Очередь разметки» (ассистент v1.1, порция 3).
// Частоты, группировку и отбор кандидатов считает бэк (analysis.py) — карточки
// только показывают payload SSE-событий analysis/review_queue и дают действия:
// «предложить правку →» — системная реплика ассистенту (sendMessage),
// «разметить →» — телепорт к ячейке + запуск мини-навигатора очереди
// (navigator.js; revealTarget из review.js умеет flash+scrollIntoView+
// panel-aware досcroll). Это информационные карточки — без «Принять»/
// «Отклонить» (pending-очередь порции 2 их не касается).
// deps: { sendMessage(text, opts), openPanel() } — передаёт assistant.js
// (прямой импорт замкнул бы цикл модулей).

import { state } from "./state.js";
import { modelShortLabel, flattenRuns } from "./results.js";
import * as reviewMod from "./review.js";
import * as navigatorMod from "./navigator.js";

function _plural(n, one, few, many) {
  if (n % 10 === 1 && n % 100 !== 11) return `${n} ${one}`;
  if (2 <= n % 10 && n % 10 <= 4 && !(12 <= n % 100 && n % 100 <= 14)) {
    return `${n} ${few}`;
  }
  return `${n} ${many}`;
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
  det.className = "assistant-analysis-raw";
  const sum = document.createElement("summary");
  sum.textContent = summaryText;
  det.appendChild(sum);
  const body = document.createElement("div");
  body.className = "assistant-details-body";
  body.textContent = lines.join("\n");
  det.appendChild(body);
  return det;
}

// ---------------------------------------------------------------- разбор

const BADGE_CLS = { marks: "reject", "marks-model": "reject",
                    disagreement: "warn", threshold: "warn",
                    lowconf: "neutral", comments: "neutral" };

function categoryRowEl(cat, card, deps) {
  const row = document.createElement("div");
  row.className = "assistant-analysis-row";
  const badge = document.createElement("span");
  badge.className = "assistant-analysis-badge assistant-analysis-badge-"
    + (BADGE_CLS[cat.kind] || "neutral");
  badge.textContent = `${cat.icon} ${cat.count}`;
  const text = document.createElement("span");
  text.className = "assistant-analysis-text";
  text.textContent = `${cat.title} — ${cat.detail}`;
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

export function analysisCardEl(data, deps = {}) {
  const card = document.createElement("div");
  card.className = "assistant-proposal assistant-analysis";
  const title = document.createElement("div");
  title.className = "assistant-info-title";
  card.appendChild(title);
  if (!data || data.empty) {
    title.textContent = "Разбор прогона";
    const p = document.createElement("div");
    p.className = "assistant-analysis-headline";
    p.textContent = "Прогона на активной странице ещё нет — сначала запустите его.";
    card.appendChild(p);
    return card;
  }
  title.textContent = analysisBrief(data);
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
  if ((data.raw || []).length) {
    card.appendChild(rawDetailsEl("Почему такой вывод (расчёты по данным прогона)",
                                  data.raw));
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
  card.appendChild(title);
  if (!data || data.empty) {
    title.textContent = "Очередь разметки";
    const p = document.createElement("div");
    p.className = "assistant-queue-headline";
    p.textContent = "Прогона нет — размечать пока нечего.";
    card.appendChild(p);
    return card;
  }
  const cands = data.candidates || [];
  if (data.done || !cands.length) {
    title.textContent = "Очередь разметки";
    const p = document.createElement("div");
    p.className = "assistant-queue-headline";
    p.textContent = "Всё размечено — спорных ячеек без пометок не осталось. "
      + "Новые кандидаты появятся после следующего прогона.";
    card.appendChild(p);
    return card;
  }
  title.textContent = queueBrief(data);
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
