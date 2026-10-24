// Сворачивание целых блоков «Материалы»/«Вопросы»/«Решение» (поверх
// сворачивания отдельных карточек внутри них). Кнопка ▾/▸ в заголовке карточки,
// в свёрнутом виде — краткая сводка. Состояние в localStorage. Вопросы и правила
// общие для обеих страниц (single/batch), сворачивание — per-card.

import { state } from "./state.js";

const BLOCKS = [
  { cardId: "context-card", key: "dq-collapse-materials-single", kind: "materials-single" },
  { cardId: "questions-card", key: "dq-collapse-questions-single", kind: "questions" },
  { cardId: "decision-card", key: "dq-collapse-decision-single", kind: "decision" },
  { cardId: "batch-files-card", key: "dq-collapse-materials-batch", kind: "materials-batch" },
  { cardId: "batch-questions-card", key: "dq-collapse-questions-batch", kind: "questions" },
  { cardId: "batch-decision-card", key: "dq-collapse-decision-batch", kind: "decision" },
];

function plural(n, one, few, many) {
  const m = Math.abs(n) % 100;
  const d = m % 10;
  if (m > 10 && m < 20) return many;
  if (d > 1 && d < 5) return few;
  if (d === 1) return one;
  return many;
}

function countOf(kind) {
  if (kind === "questions") return state.questions.length;
  if (kind === "materials-batch") return state.batch.files.length;
  return (state.decision && state.decision.outcomes ? state.decision.outcomes : []).length;
}

function labelOf(kind) {
  if (kind === "materials-single") return state.inputMode === "json" ? "JSON" : "Текст";
  const n = countOf(kind);
  if (kind === "questions") return `${n} ${plural(n, "вопрос", "вопроса", "вопросов")}`;
  if (kind === "materials-batch") return `${n} ${plural(n, "файл", "файла", "файлов")}`;
  return `${n} ${plural(n, "исход", "исхода", "исходов")}`;
}

function apply(card, btn, countEl, block, collapsed) {
  card.classList.toggle("card-collapsed", collapsed);
  btn.textContent = collapsed ? "▸" : "▾";
  btn.title = collapsed ? "Развернуть блок" : "Свернуть блок";
  countEl.textContent = collapsed ? "· " + labelOf(block.kind) : "";
}

// Пересчёт сводок свёрнутых блоков — вызывается после перерисовок и смены
// режима материала.
export function updateBlockCounters() {
  for (const b of BLOCKS) {
    const card = document.getElementById(b.cardId);
    if (!card || !card.classList.contains("card-collapsed")) continue;
    const countEl = card.querySelector(".block-count");
    if (countEl) countEl.textContent = "· " + labelOf(b.kind);
  }
}

// Свернуть/развернуть целые блоки — из кнопок «свернуть/развернуть всё» в
// шапках панелей. cardIds ограничивает страницу; без него — все блоки.
export function setBlocksCollapsed(collapsed, cardIds) {
  for (const b of BLOCKS) {
    if (cardIds && !cardIds.includes(b.cardId)) continue;
    const card = document.getElementById(b.cardId);
    if (!card) continue;
    const btn = card.querySelector(".block-collapse-btn");
    const countEl = card.querySelector(".block-count");
    if (!btn || !countEl) continue;
    apply(card, btn, countEl, b, collapsed);
    localStorage.setItem(b.key, collapsed ? "1" : "0");
  }
}

export function initBlockCollapse() {
  for (const b of BLOCKS) {
    const card = document.getElementById(b.cardId);
    if (!card) continue;
    const head = card.querySelector(".section-head");
    if (!head || head.querySelector(".block-collapse-btn")) continue;

    const side = document.createElement("span");
    side.className = "block-collapse-side";
    const countEl = document.createElement("span");
    countEl.className = "block-count";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn block-collapse-btn";
    side.append(countEl, btn);
    head.appendChild(side);

    btn.addEventListener("click", () => {
      const collapsed = !card.classList.contains("card-collapsed");
      apply(card, btn, countEl, b, collapsed);
      localStorage.setItem(b.key, collapsed ? "1" : "0");
    });
    apply(card, btn, countEl, b, localStorage.getItem(b.key) === "1");
  }
}
