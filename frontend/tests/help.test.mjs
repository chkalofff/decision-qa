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
  // области результатов — подсвечиваются и кликабельны на демо-шагах
  el("div", { id: "results-card" });
  el("section", { id: "batch-results-card" });
}

function tip() { return document.querySelector(".help-tip"); }
function tipBtn(cls) { return tip().querySelector(cls); }

test("help: первый запуск открывает тур, закрытие ставит флаг dq-help-seen", () => {
  closeHelp();
  localStorage.clear();
  domHelp();
  // хуки тура — noop: app-хуки из app.test тянут демо-контент, которому здесь
  // не хватает DOM (асинхронный rejection кладёт раннер)
  initHelp({ onDemoEnter: () => {}, onDemoRun: () => {}, onDemoBatch: () => {}, onDemoExit: () => {} });
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

test("help: демо-шаги интерактивны — backdrop пропускает клики, область результатов подсвечена", () => {
  localStorage.clear();
  closeHelp();
  domHelp();
  initHelp({ onDemoEnter: () => {}, onDemoRun: () => {}, onDemoBatch: () => {}, onDemoExit: () => {} });
  const runIdx = HELP_STEPS.findIndex((s) => s.demoRun);
  const reviewIdx = HELP_STEPS.findIndex((s) => s.title === "Разметка результатов");
  const batchIdx = HELP_STEPS.findIndex((s) => s.demoBatch);
  eq(reviewIdx, runIdx + 1, "шаг разметки — сразу после demoRun");
  eq(batchIdx, runIdx + 2, "между demoRun и demoBatch — только шаг разметки");
  const backdrop = () => document.querySelector(".help-backdrop");
  const resCard = document.getElementById("results-card");
  const batchCard = document.getElementById("batch-results-card");

  // обычный шаг: backdrop глушит клики, области результатов не подсвечены
  assert(!backdrop().classList.contains("help-interactive"), "обычный шаг: backdrop не интерактивен");
  assert(!resCard.classList.contains("help-highlight"), "обычный шаг: без подсветки результатов");

  // шаг demoRun: клики проходят, одиночные результаты подсвечены
  for (let i = 0; i < runIdx; i++) tipBtn(".help-next").click();
  assert(backdrop().classList.contains("help-interactive"), "demoRun: backdrop пропускает клики");
  assert(resCard.classList.contains("help-highlight"), "demoRun: #results-card подсвечен");
  assert(!batchCard.classList.contains("help-highlight"), "demoRun: таблица пакета не подсвечена");

  // шаг разметки: наследует демо-результаты — тот же интерактив и подсветка
  tipBtn(".help-next").click();
  assert(backdrop().classList.contains("help-interactive"), "разметка: backdrop пропускает клики");
  assert(resCard.classList.contains("help-highlight"), "разметка: #results-card подсвечен");
  includes(tip().textContent, "✓ ✗ ? 💬", "текст шага про триаду");
  includes(tip().textContent, "1/2/3", "текст шага про хоткеи");

  // шаг demoBatch: подсветка переехала на таблицу пакета
  tipBtn(".help-next").click();
  assert(backdrop().classList.contains("help-interactive"), "demoBatch: backdrop пропускает клики");
  assert(batchCard.classList.contains("help-highlight"), "demoBatch: #batch-results-card подсвечена");
  assert(!resCard.classList.contains("help-highlight"), "demoBatch: подсветка одиночных результатов снята");

  // обычный шаг после демо: интерактив выключен, лишней подсветки нет
  tipBtn(".help-next").click();
  assert(!backdrop().classList.contains("help-interactive"), "после демо: backdrop снова глушит клики");
  assert(!batchCard.classList.contains("help-highlight"), "после демо: подсветка таблицы снята");

  // возврат на demoBatch и закрытие: вся подсветка убрана
  tipBtn(".help-prev").click();
  assert(batchCard.classList.contains("help-highlight"), "возврат на demoBatch: подсветка восстановлена");
  closeHelp();
  assert(!document.querySelector(".help-highlight"), "после закрытия тура подсветки не осталось");
  assert(!document.querySelector(".help-backdrop"), "backdrop удалён");
});

test("help: шаг «Запуск» дёргает onDemoRun один раз (гард против повторов)", () => {
  localStorage.clear();
  closeHelp();
  domHelp();
  const calls = [];
  initHelp({
    onDemoEnter: () => calls.push("enter"),
    onDemoRun: () => calls.push("run"),
    onDemoExit: () => calls.push("exit"),
  });
  const runIdx = HELP_STEPS.findIndex((s) => s.demoRun);
  assert(runIdx > 0, "шаг с demoRun есть");
  eq(HELP_STEPS[runIdx].target, "tb-run", "demoRun на шаге «Запуск»");
  for (let i = 0; i < runIdx; i++) tipBtn(".help-next").click();
  includes(tipBtn(".help-tip-counter").textContent, `${runIdx + 1} / ${HELP_STEPS.length}`);
  eq(calls.filter((c) => c === "run").length, 1, "onDemoRun при входе на шаг");
  // ушли и вернулись — повторного вызова нет
  tipBtn(".help-prev").click();
  tipBtn(".help-next").click();
  eq(calls.filter((c) => c === "run").length, 1, "гард: повторный вход не дёргает onDemoRun");
  closeHelp();
  includes(calls.join(","), "exit", "onDemoExit при закрытии");
});

test("help: pageMode симметричен — «Назад» с шага пакета откатывает фон, повторный вход применяет снова", () => {
  localStorage.clear();
  closeHelp();
  domHelp();
  const calls = [];
  initHelp({
    onPageMode: (m) => calls.push("page:" + m),
    onPageModeQuery: () => "single",
    onDemoEnter: () => calls.push("enter"),
    onDemoBatch: () => calls.push("batch"),
    onDemoExit: () => calls.push("exit"),
  });
  includes(calls.join(","), "enter", "onDemoEnter при открытии");
  // тур открылся на шаге 0: исходный режим совпадает с basePageMode — хуков нет
  eq(calls.filter((c) => c.startsWith("page:")).length, 0, "лишний onPageMode на старте");
  const clickTopic = (name) => {
    const b = tip().querySelectorAll(".help-topic").find((x) => x.textContent === name);
    assert(b, `тема «${name}» не найдена`);
    b.click();
  };
  clickTopic("Пакетная проверка");
  includes(calls.join(","), "page:batch", "onPageMode(batch) при входе на шаг пакета");
  eq(calls.filter((c) => c === "batch").length, 1, "onDemoBatch при входе на шаг пакета");
  // «Назад» — фон откатывается к исходному режиму
  tipBtn(".help-prev").click();
  eq(calls[calls.length - 1], "page:single", "«Назад» не откатил pageMode");
  // «Далее» — режим пакета применяется снова, демо-хук — нет (одноразовый гард)
  tipBtn(".help-next").click();
  eq(calls[calls.length - 1], "page:batch", "повторный вход не применил pageMode(batch)");
  eq(calls.filter((c) => c === "batch").length, 1, "гард: onDemoBatch сработал повторно");
  closeHelp();
  includes(calls.join(","), "exit", "onDemoExit при закрытии");
});

test("help: «Поиграть с демо» сворачивает тур в плашку, возврат — на тот же шаг с реинициализацией демо", () => {
  localStorage.clear();
  closeHelp();
  domHelp();
  const calls = [];
  initHelp({
    onDemoEnter: () => {},
    onDemoRun: () => calls.push("run"),
    onDemoBatch: () => {},
    onDemoExit: () => {},
  });
  const runIdx = HELP_STEPS.findIndex((s) => s.demoRun);
  const backdrop = () => document.querySelector(".help-backdrop");
  const resCard = document.getElementById("results-card");
  // кнопка «Поиграть с демо» есть только на демо-шагах
  assert(!tip().querySelector(".help-play"), "кнопка «Поиграть» на обычном шаге");
  for (let i = 0; i < runIdx; i++) tipBtn(".help-next").click();
  const play = tipBtn(".help-play");
  assert(play, "нет кнопки «Поиграть с демо» на демо-шаге");
  eq(calls.filter((c) => c === "run").length, 1, "onDemoRun при входе на шаг");

  // сворачивание: затемнение снято, тултип — плашка, подсветка убрана
  play.click();
  assert(backdrop().classList.contains("help-minimized"), "backdrop не прозрачный в свёрнутом виде");
  assert(!backdrop().classList.contains("help-interactive"), "help-interactive не снят");
  assert(tip().classList.contains("help-plaque"), "тултип не стал плашкой");
  includes(tip().querySelector(".help-plaque-label").textContent, `Тур: шаг ${runIdx + 1} из ${HELP_STEPS.length}`);
  assert(tipBtn(".help-restore"), "в плашке нет кнопки «Вернуться к туру»");
  assert(!resCard.classList.contains("help-highlight"), "подсветка результатов не снята");

  // разворачивание кликом по плашке: тот же шаг, подсветка и интерактив назад,
  // демо-результаты подложены заново (в свёрнутом виде их могли очистить)
  tip().click();
  assert(!tip().classList.contains("help-plaque"), "клик по плашке не развернул тур");
  assert(!backdrop().classList.contains("help-minimized"), "затемнение не восстановлено");
  assert(backdrop().classList.contains("help-interactive"), "интерактив демо-шага не восстановлен");
  assert(resCard.classList.contains("help-highlight"), "подсветка результатов не восстановлена");
  includes(tipBtn(".help-tip-counter").textContent, `${runIdx + 1} / ${HELP_STEPS.length}`, "шаг сбросился");
  eq(calls.filter((c) => c === "run").length, 2, "возврат к туру подкладывает демо заново");

  // то же через кнопку «Вернуться к туру»
  tipBtn(".help-play").click();
  assert(tip().classList.contains("help-plaque"), "повторное сворачивание не сработало");
  tipBtn(".help-restore").click();
  assert(!tip().classList.contains("help-plaque"), "«Вернуться к туру» не развернула тур");
  includes(tipBtn(".help-tip-counter").textContent, `${runIdx + 1} / ${HELP_STEPS.length}`);
  eq(calls.filter((c) => c === "run").length, 3, "и через кнопку демо тоже подкладывается заново");
  closeHelp();
});

test("help: Esc и ✕ в свёрнутом виде закрывают тур с onDemoExit", () => {
  localStorage.clear();
  closeHelp();
  domHelp();
  const calls = [];
  initHelp({ onDemoEnter: () => {}, onDemoExit: () => calls.push("exit") });
  const runIdx = HELP_STEPS.findIndex((s) => s.demoRun);
  for (let i = 0; i < runIdx; i++) tipBtn(".help-next").click();

  // фаза 1: Esc в свёрнутом виде
  tipBtn(".help-play").click();
  document.fire("keydown", { key: "Escape" });
  assert(!isHelpOpen(), "Esc в свёрнутом виде не закрыл тур");
  includes(calls.join(","), "exit", "onDemoExit не вызван при Esc");

  // фаза 2: ✕ в плашке
  openHelp(runIdx);
  tipBtn(".help-play").click();
  tip().querySelector(".banner-close").click();
  assert(!isHelpOpen(), "✕ в свёрнутом виде не закрыл тур");
  eq(calls.filter((c) => c === "exit").length, 2, "onDemoExit не вызван при ✕");
});
