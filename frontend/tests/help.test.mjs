// Онбординг/help: первый запуск, навигация «Назад»/«Далее», подсветка целей,
// дрилдаун «Подробнее», оглавление тем, «Готово», кнопка «?», Esc.

import { readFileSync } from "node:fs";
import {
  test, assert, eq, includes, el,
} from "./harness.mjs";
import {
  HELP_STEPS, initHelp, openHelp, closeHelp, isHelpOpen,
} from "../static/help.js";

function domHelp() {
  el("button", { id: "tb-help" });
  el("div", { id: "tb-pagemode" });
  el("div", { id: "tb-models" });
  el("section", { id: "context-card" });
  el("section", { id: "questions-card" });
  el("section", { id: "decision-card" });
  el("button", { id: "tb-run" });
  el("button", { id: "tb-assistant" });
}

function tip() { return document.querySelector(".help-tip"); }
function tipBtn(cls) { return tip().querySelector(cls); }

test("help: первый запуск открывает тур, закрытие ставит флаг dq-help-seen", () => {
  closeHelp();
  localStorage.clear();
  domHelp();
  initHelp();
  assert(isHelpOpen(), "тур не открылся при первом запуске");
  includes(tip().textContent, "Вердикт");
  closeHelp();
  eq(localStorage.getItem("dq-help-seen"), "1", "флаг не записан");
});

test("help: повторный initHelp не открывает тур, кнопка «?» открывает и закрывает", () => {
  localStorage.clear();
  closeHelp();
  domHelp();
  localStorage.setItem("dq-help-seen", "1");
  initHelp();
  assert(!isHelpOpen(), "тур открылся при выставленном флаге");
  document.getElementById("tb-help").click();
  assert(isHelpOpen(), "кнопка «?» не открыла тур");
  document.getElementById("tb-help").click();
  assert(!isHelpOpen(), "повторный клик по «?» не закрыл тур");
});

test("help: «Далее»/«Назад» листают шаги и подсвечивают целевой элемент", () => {
  localStorage.clear();
  closeHelp();
  domHelp();
  openHelp(0);
  includes(tipBtn(".help-tip-counter").textContent, `1 / ${HELP_STEPS.length}`);
  assert(tipBtn(".help-prev").disabled, "«Назад» активен на первом шаге");

  tipBtn(".help-next").click();
  includes(tipBtn(".help-tip-counter").textContent, `2 / ${HELP_STEPS.length}`);
  // до первого шага с target листаем дальше
  const stepIdx = HELP_STEPS.findIndex(s => s.target);
  for (let i = 1; i < stepIdx; i++) tipBtn(".help-next").click();
  includes(tipBtn(".help-tip-counter").textContent, `${stepIdx + 1} / ${HELP_STEPS.length}`);
  const step = HELP_STEPS[stepIdx];
  const target = document.getElementById(step.target);
  assert(target.classList.contains("help-highlight"), "цель шага не подсвечена");
  includes(tip().textContent, step.title);

  tipBtn(".help-prev").click();
  includes(tipBtn(".help-tip-counter").textContent, `${stepIdx} / ${HELP_STEPS.length}`);
  assert(!target.classList.contains("help-highlight"), "подсветка не снята при возврате");
  closeHelp();
});

test("help: «Подробнее» раскрывает детали шага", () => {
  localStorage.clear();
  closeHelp();
  domHelp();
  openHelp(0);
  const det = tip().querySelector(".help-tip-details");
  assert(det, "дрилдаун «Подробнее» не отрисован");
  includes(det.querySelector("summary").textContent, "Подробнее");
  eq(det.querySelectorAll("li").length, HELP_STEPS[0].details.length, "число пунктов деталей");
  closeHelp();
});

test("help: оглавление тем на первом шаге прыгает в раздел", () => {
  localStorage.clear();
  closeHelp();
  domHelp();
  openHelp(0);
  const topics = tip().querySelectorAll(".help-topic");
  assert(topics.length >= 6, "тем в оглавлении меньше ожидаемого");
  const decisionStep = HELP_STEPS.findIndex((s) => s.section === "Решение");
  const topic = topics.find((b) => b.textContent === "Решение");
  assert(topic, "тема «Решение» не найдена");
  topic.click();
  includes(tipBtn(".help-tip-counter").textContent, `${decisionStep + 1} / ${HELP_STEPS.length}`);
  assert(document.getElementById("decision-card").classList.contains("help-highlight"),
    "прыжок в тему не подсветил блок решения");
  closeHelp();
});

test("help: последний шаг — «Готово» закрывает тур и ставит флаг", () => {
  localStorage.clear();
  closeHelp();
  domHelp();
  openHelp(HELP_STEPS.length - 1);
  eq(tipBtn(".help-next").textContent, "Готово");
  tipBtn(".help-next").click();
  assert(!isHelpOpen(), "тур не закрылся по «Готово»");
  eq(localStorage.getItem("dq-help-seen"), "1");
});

test("help: Esc закрывает тур", () => {
  localStorage.clear();
  closeHelp();
  domHelp();
  initHelp();
  assert(isHelpOpen());
  document.fire("keydown", { key: "Escape" });
  assert(!isHelpOpen(), "Esc не закрыл тур");
});

test("help: все target-элементы шагов существуют в index.html", () => {
  const html = readFileSync("frontend/static/index.html", "utf8");
  for (const s of HELP_STEPS) {
    if (!s.target) continue;
    assert(html.includes(`id="${s.target}"`), `в index.html нет id="${s.target}" (шаг «${s.title}»)`);
  }
});

test("help: welcome — hero-карточка с брендом «Вердикт»", () => {
  localStorage.clear();
  closeHelp();
  domHelp();
  openHelp(0);
  const t = tip();
  assert(t.classList.contains("hero"), "у welcome-карточки нет класса hero");
  const brand = t.querySelector(".help-brand");
  assert(brand, "бренд-блок не отрисован");
  includes(brand.textContent, "Вердикт", "имя бренда в hero");
  includes(brand.textContent, "⚖️", "иконка бренда в hero");
  assert(t.querySelector(".help-brand-name"), "имя бренда оформлено");
  closeHelp();
});

test("help: структурное тело — буллеты и нумерация рендерятся списками", () => {
  localStorage.clear();
  closeHelp();
  domHelp();
  // Шаг «Вопросы» — буллеты «• …»; шаг «Как это работает» — нумерация «1. …».
  const qIdx = HELP_STEPS.findIndex((s) => s.section === "Вопросы");
  const howIdx = HELP_STEPS.findIndex((s) => s.section === "Как это работает");
  openHelp(qIdx);
  const ul = tip().querySelector(".help-tip-body ul");
  assert(ul, "буллеты не стали <ul>");
  assert(ul.querySelectorAll("li").length >= 3, "в списке типов меньше трёх пунктов");
  assert(!tip().querySelector(".help-tip-body ol"), "у буллетов не должно быть <ol>");
  closeHelp();
  openHelp(howIdx);
  const ol = tip().querySelector(".help-tip-body ol");
  assert(ol, "нумерация не стала <ol>");
  eq(ol.querySelectorAll("li").length, 4, "четыре шага в нумерованном списке");
  closeHelp();
});

test("help: шаг «Пакетная проверка» переключает фон и дёргает демо-хуки", () => {
  localStorage.clear();
  closeHelp();
  domHelp();
  const calls = [];
  initHelp({
    onPageMode: (m) => calls.push("page:" + m),
    onDemoEnter: () => calls.push("enter"),
    onDemoBatch: () => calls.push("batch"),
    onDemoExit: () => calls.push("exit"),
  });
  includes(calls.join(","), "enter", "onDemoEnter при открытии");
  const clickTopic = (name) => {
    const b = tip().querySelectorAll(".help-topic").find((x) => x.textContent === name);
    assert(b, `тема «${name}» не найдена`);
    b.click();
  };
  clickTopic("Пакетная проверка");
  includes(calls.join(","), "page:batch", "onPageMode(batch) при входе на шаг пакета");
  includes(calls.join(","), "batch", "onDemoBatch при входе на шаг пакета");
  // ушли со шага и вернулись — хуки не должны сработать повторно (темы
  // есть только на первом шаге, поэтому возврат — через «Назад»/«Далее»)
  const n = calls.length;
  tipBtn(".help-prev").click();
  tipBtn(".help-next").click();
  eq(calls.length, n, "повторный вход на шаг дёргает хуки повторно");
  closeHelp();
  includes(calls.join(","), "exit", "onDemoExit при закрытии");
});
