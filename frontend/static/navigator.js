// Плавающий мини-навигатор очереди разметки (ассистент v1.1, макет 4а):
// «✎ Разметка кандидатов · 2/5 · ← → · выйти ✕». Появляется при переходе
// «разметить →» из карточек разбора/очереди (analysis.js) и живёт, пока
// очередь не исчерпана — панель ассистента можно закрыть, очередь не
// прервётся. Разметка ставится обычной hover-триадой в таблице; событие
// "review" (state.js) обновляет счётчик: размеченный кандидат помечается ✓,
// «→» ведёт к следующему неразмеченному. После последнего — «Готово: N/N ·
// вернуться к разбору →» (скролл к карточке-источнику, панель открывается).
// «Выйти» скрывает навигатор, разметка не откатывается.
// Привязка к странице: при переключении single/batch скрывается вместе со
// страницей (очередь не прерывается) и возвращается при возврате.
// Геометрия (зафиксирована в макете): нижний край области результатов,
// горизонтальный центр свободной от панели ассистента ширины, z-index 30
// (выше sticky-шапки результатов z=10, ниже панели z=60 и поповеров z=405).

import { state, subscribe } from "./state.js";
import { revealTarget, findMark } from "./review.js";

let nav = null;  // {items: [{scope, target, label, reason}], idx, page, origin, deps}
let pill = null;
let inited = false;

export function initNavigator() {
  if (inited) return;
  inited = true;
  subscribe((event) => {
    if (!nav) return;
    if (event === "review" || event === "pagemode") render();
  });
}

export function navigatorActive() { return !!nav; }

// items: [{scope, target, label, reason}] — цели в координатах review.js
// (resolveCandidateTarget в analysis.js). opts: {startAt, origin, deps}.
export function startNavigator(items, opts = {}) {
  initNavigator();
  if (!items || !items.length) return null;
  nav = {
    items,
    idx: Math.max(0, opts.startAt || 0),
    page: items[0].scope === "batch" ? "batch" : "single",
    origin: opts.origin || null,
    deps: opts.deps || {},
  };
  if (isMarked(nav.items[nav.idx])) move(1); // стартовая уже размечена — дальше
  else revealCurrent();
  render();
  return pill;
}

// «Выйти» — разметку не откатываем.
export function stopNavigator() {
  nav = null;
  if (pill) pill.classList.add("hidden");
}

// Сброс для тестов.
export function resetNavigator() { stopNavigator(); }

function isMarked(item) {
  try { return !!findMark(item.scope, item.target); } catch { return false; }
}

function markedCount() { return nav.items.filter(isMarked).length; }

// dir=1 — следующий НЕРАЗМЕЧЕННЫЙ (размеченные пропускаем; за последним —
// состояние «Готово»); dir=-1 — просто предыдущий.
function move(dir) {
  const n = nav.items.length;
  let i = nav.idx;
  for (let step = 0; step < n; step += 1) {
    i += dir;
    if (i < 0 || i >= n) break;
    if (dir === 1 && isMarked(nav.items[i])) continue;
    nav.idx = i;
    revealCurrent();
    return;
  }
  if (dir === 1) nav.idx = n;
}

function revealCurrent() {
  const item = nav.items[nav.idx];
  if (item) revealTarget(item.scope, item.target);
}

function navBtn(text, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "assistant-navigator-btn";
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function exitBtn() {
  const b = navBtn("выйти ✕", "Выйти из очереди (разметка сохраняется)",
                   () => stopNavigator());
  b.classList.add("assistant-navigator-exit");
  return b;
}

// Горизонтальный центр свободной от панели ассистента ширины.
function position() {
  if (!pill) return;
  const vw = (typeof window !== "undefined" && window.innerWidth) || 0;
  if (!vw) return;
  const panel = document.getElementById("assistant-panel");
  let pw = 0;
  if (panel && !panel.classList.contains("hidden") && panel.getBoundingClientRect) {
    pw = panel.getBoundingClientRect().width || 0;
  }
  pill.style.left = Math.round((vw - pw) / 2) + "px";
}

function render() {
  if (!nav) return;
  ensurePill();
  // привязка к странице: чужие результаты навигатор не заслоняет
  if (state.pageMode !== nav.page) {
    pill.classList.add("hidden");
    return;
  }
  pill.classList.remove("hidden");
  pill.textContent = "";
  const total = nav.items.length;
  const done = nav.idx >= total || (total > 0 && nav.items.every(isMarked));
  const title = document.createElement("span");
  title.className = "assistant-navigator-title";
  if (done) {
    title.textContent = `✓ Готово: ${markedCount()}/${total}`;
    pill.appendChild(title);
    if (nav.origin) {
      const back = navBtn("вернуться к разбору →", "Скролл к карточке разбора",
                          () => {
                            if (nav.deps && nav.deps.openPanel) nav.deps.openPanel();
                            if (nav.origin && nav.origin.scrollIntoView) {
                              nav.origin.scrollIntoView({ block: "center", behavior: "smooth" });
                            }
                          });
      back.classList.add("assistant-navigator-back");
      pill.appendChild(back);
    }
    pill.appendChild(exitBtn());
    position();
    return;
  }
  title.textContent = "✎ Разметка кандидатов";
  const count = document.createElement("span");
  count.className = "assistant-navigator-count";
  count.textContent = `${nav.idx + 1}/${total}`
    + (isMarked(nav.items[nav.idx]) ? " ✓" : "");
  const prev = navBtn("←", "Предыдущий кандидат", () => { move(-1); render(); });
  prev.disabled = nav.idx <= 0;
  const next = navBtn("→", "Следующий неразмеченный кандидат",
                      () => { move(1); render(); });
  pill.append(title, count, prev, next, exitBtn());
  const cur = nav.items[nav.idx];
  if (cur) pill.title = [cur.label, cur.reason].filter(Boolean).join(" — ");
  position();
}

function ensurePill() {
  if (!pill) {
    pill = document.createElement("div");
    pill.className = "assistant-navigator hidden";
  }
  if (pill.parentNode !== document.body) document.body.appendChild(pill);
  return pill;
}
