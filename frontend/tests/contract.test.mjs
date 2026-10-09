// Доменные тесты: contract. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, notIncludes, installDom, resetState, mockFetch, domBatch, domToolbar, modelsResp, state, results, batch, toolbar, presetsMod,
} from "./harness.mjs";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";  // глобальный URL подменён DOM-моком

// ================================================================ UI-контракт
// Инварианты, которые нельзя забыть: новая страница/статус без покрытия роняет тест.

test("contract: каждая страница открывается; у служебных страниц есть кнопка возврата", async () => {
  installDom(); await resetState(); domToolbar(); domBatch();
  const manager = await import("../static/manager.js");
  state.device = { ram_gb: 64, budget_gb: 41.6 };
  manager.initManager({});
  batch.initBatch({});
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  toolbar.initToolbar({});

  const modes = [...document.querySelectorAll("#tb-pagemode button")].map(b => b.dataset.pagemode);
  assert(modes.length >= 2, "есть хотя бы две страницы");
  // Страницы сегмента (single/batch) переключаются самим сегментом — кнопки
  // возврата у них нет. Страница «Модели» в сегмент не входит — открывается
  // из дропдауна «Модели ▾» и потому имеет #btn-models-back.
  for (const mode of modes) {
    toolbar.setPageMode(mode);
    const page = document.getElementById("page-" + mode);
    assert(page && !page.classList.contains("hidden"), `страница ${mode} открылась`);
    toolbar.setPageMode("single");
    assert(!document.getElementById("page-single").classList.contains("hidden"), `с ${mode} возврат в single через сегмент`);
  }
  toolbar.setPageMode("models");
  assert(!document.getElementById("page-models").classList.contains("hidden"), "страница models открылась");
  const modelsBack = document.getElementById("btn-models-back");
  assert(modelsBack, "у страницы models есть кнопка возврата #btn-models-back");
  modelsBack.fire("click");
  eq(state.pageMode, "single", "кнопка возврата со страницы models ведёт в single");
  // Менеджер пресетов — тоже страница с кнопкой возврата (инцидент «нет выхода» не повторяем)
  presetsMod.initPresets({});
  presetsMod.openPresetsPage();
  assert(!document.getElementById("page-presets").classList.contains("hidden"), "страница presets открылась");
  const presetsBack = document.getElementById("btn-presets-back");
  assert(presetsBack, "у страницы presets есть кнопка возврата #btn-presets-back");
  presetsBack.fire("click");
  eq(state.pageMode, "single", "кнопка возврата со страницы presets ведёт в single");
});

test("contract: Run недоступен на не-прогонных страницах с понятным title", async () => {
  installDom(); await resetState(); domToolbar();
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  toolbar.initToolbar({});
  toolbar.setPageMode("models");
  const btn = document.getElementById("tb-run");
  assert(btn.disabled, "Run disabled на странице моделей");
  assert((btn.title || "").length > 10, "у disabled Run есть поясняющий title");
});

test("contract: index.html — favicon, порядок бара, сегмент страниц", async () => {
  const html = readFileSync(new NodeURL("../static/index.html", import.meta.url), "utf8");
  // favicon.svg подключён
  const head = html.match(/<head>[\s\S]*?<\/head>/);
  assert(head, "<head> найден");
  includes(head[0], 'rel="icon"', "link rel=icon в <head>");
  includes(head[0], 'type="image/svg+xml"', "тип svg");
  includes(head[0], 'href="favicon.svg"', "href на favicon.svg");
  const svg = readFileSync(new NodeURL("../static/favicon.svg", import.meta.url), "utf8");
  includes(svg, "<svg", "файл favicon.svg существует и валиден как svg");
  // порядок бара — Файл ▾, Модели ▾, чипы, сегмент, Запустить
  const header = html.match(/<header[\s\S]*?<\/header>/);
  assert(header, "<header> найден");
  includes(header[0], ">Файл ▾<", "меню переименовано в «Файл ▾»");
  notIncludes(header[0], ">Меню ▾<", "старого названия «Меню ▾» нет");
  let pos = -1;
  for (const id of ["tb-menu-btn", "tb-models-menu", "tb-models", "tb-pagemode", "tb-run"]) {
    const i = header[0].indexOf(`id="${id}"`);
    assert(i !== -1, `id="${id}" есть в баре`);
    assert(i > pos, `id="${id}" идёт после предыдущего элемента бара`);
    pos = i;
  }
  // сегмент страниц — ровно «Одиночный» и «Батч»
  const seg = html.match(/id="tb-pagemode"[\s\S]*?<\/div>/);
  assert(seg, "сегмент #tb-pagemode найден в index.html");
  const modes = [...seg[0].matchAll(/data-pagemode="(\w+)"/g)].map(m => m[1]);
  eq(modes.join(","), "single,batch", "ровно две страницы в сегменте");
});

test("contract: статусы моделей и шкалы в CSS — метки toolbar=manager, conf-0..4, dir-*, старых классов нет", async () => {
  const toolbarSrc = readFileSync(new NodeURL("../static/toolbar.js", import.meta.url), "utf8");
  const managerSrc = readFileSync(new NodeURL("../static/manager.js", import.meta.url), "utf8");
  const css = readFileSync(new NodeURL("../static/style.css", import.meta.url), "utf8");
  const keysOf = (src) => {
    const block = src.match(/STATUS_LABELS\s*=\s*\{([^}]+)\}/s);
    assert(block, "STATUS_LABELS не найден");
    return [...block[1].matchAll(/^\s*(\w+):/gm)].map(m => m[1]).sort();
  };
  const tbKeys = keysOf(toolbarSrc);
  const mgrKeys = keysOf(managerSrc);
  eq(mgrKeys.join(","), tbKeys.join(","), "наборы статусов в toolbar и manager совпадают");
  for (const status of tbKeys) {
    assert(css.includes(".dot-" + status), `для статуса ${status} нет цвета .dot-${status} в style.css`);
  }
  // нейтральная шкала conf-0..conf-4, старых классов нет
  for (const cls of [".conf-0", ".conf-1", ".conf-2", ".conf-3", ".conf-4"]) {
    assert(css.includes(cls), `в style.css нет ${cls}`);
  }
  for (const cls of [".cb-0", ".cb-1", ".cb-2", ".cb-3", ".cb-4"]) {
    assert(css.includes(cls), `в style.css нет ${cls}`);
  }
  for (const old of ["conf-good", "conf-mid", "conf-bad", "more-mark", "cb-good", "cb-mid", "cb-bad"]) {
    notIncludes(css, old, `старый класс ${old} удалён из style.css`);
  }
  // Семантическая маркировка score по направлению шкалы — отдельные классы,
  // нейтральная conf-шкала при этом остаётся (см. проверки выше).
  for (const cls of [".dir-good", ".dir-mid", ".dir-bad"]) {
    assert(css.includes(cls), `в style.css нет ${cls}`);
  }
  const resultsSrc = readFileSync(new NodeURL("../static/results.js", import.meta.url), "utf8");
  const batchSrc = readFileSync(new NodeURL("../static/batch.js", import.meta.url), "utf8");
  for (const old of ["conf-good", "conf-mid", "conf-bad", "more-mark"]) {
    notIncludes(resultsSrc + batchSrc, old, `старый класс ${old} удалён из JS`);
  }
});
