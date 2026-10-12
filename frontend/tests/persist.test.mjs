// Доменные тесты: persist (автосохранение рабочего состояния в localStorage).
// Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, installDom, resetState, sleep,
  domContext, domQuestions, domBatch, domToolbar,
  state, questions, context, batch, persist,
} from "./harness.mjs";

// ================================================================ persist

test("persist: снапшот пишется дебаунсом; выключатель удаляет ключ", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domToolbar();
  context.initContext({});
  batch.initBatch({});
  persist.resumePersist(); // снять возможную паузу тура из app-тестов
  localStorage.clear();
  persist.initPersist();

  const cb = document.getElementById("tb-menu-persist");
  eq(cb.checked, true, "чекбокс включён по умолчанию");

  context.setContent("текст материала", "text");
  eq(localStorage.getItem("dq-workspace"), null, "сразу после правки снапшота нет (дебаунс)");
  await sleep(900);
  const raw = localStorage.getItem("dq-workspace");
  assert(raw, "снапшот записан после дебаунса");
  const data = JSON.parse(raw);
  eq(data.input, "текст материала", "контекст в снапшоте");
  eq(data.pageMode, "single", "pageMode в снапшоте");
  assert(!("results" in data), "результаты прогонов не сохраняются");

  // выключение — снапшот удаляется
  cb.checked = false;
  cb.fire("change");
  eq(persist.isPersistEnabled(), false, "выключено");
  eq(localStorage.getItem("dq-workspace"), null, "ключ удалён при выключении");
});

test("persist: restoreWorkspace восстанавливает состояние без результатов и stale", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domToolbar();
  context.initContext({});
  batch.initBatch({});
  persist.resumePersist();
  localStorage.clear();
  localStorage.setItem("dq-workspace", JSON.stringify({
    input_format: "text", input: "мой материал",
    images: ["data:image/png;base64,QUJD"],
    questions: [{ id: "q1", question: "Q?", type: "yes_no" }],
    decision: { enabled: true, outcomes: [{ id: "ok", label: "Ок", color: "green", isDefault: true, rules: [] }] },
    pageMode: "batch",
    batchFiles: [{ name: "a.txt", content: "файл" }],
  }));
  const page = persist.restoreWorkspace();
  eq(page, "batch", "вернулась сохранённая страница");
  eq(context.currentText(), "мой материал", "контекст восстановлен");
  eq(state.contextImages.length, 1, "картинки восстановлены");
  eq(state.questions.length, 1, "вопросы восстановлены");
  assert(state.decision && state.decision.outcomes.length === 1, "решение восстановлено");
  eq(state.batch.files.length, 1, "файлы пакета восстановлены");
  eq(state.results, null, "результаты не восстанавливаются");
  eq(state.resultsStale, false, "stale-плашка не возникает");
  // повторный вызов без снапшота / с битым — null
  localStorage.removeItem("dq-workspace");
  eq(persist.restoreWorkspace(), null, "нет снапшота → null");
  localStorage.setItem("dq-workspace", "{битый");
  eq(persist.restoreWorkspace(), null, "битый JSON → null");
});

test("persist: >4 МБ — снапшот без изображений; ошибка квоты молча пропускается", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domToolbar();
  context.initContext({});
  batch.initBatch({});
  persist.resumePersist();
  localStorage.clear();
  state.contextImages = [{ name: "big.png", dataUrl: "data:image/png;base64," + "A".repeat(6 * 1024 * 1024) }];
  persist.saveNow();
  const data = JSON.parse(localStorage.getItem("dq-workspace"));
  eq(data.imagesOmitted, true, "помечено, что изображения пропущены");
  assert(!data.images, "images нет в большом снапшоте");
  // QuotaExceededError — молча, без исключения
  state.contextImages = [];
  const orig = localStorage.setItem;
  localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  persist.saveNow();
  localStorage.setItem = orig;
});

test("persist: пауза тура — правки не сохраняются, resume пересохраняет", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domToolbar();
  context.initContext({});
  batch.initBatch({});
  persist.resumePersist();
  localStorage.clear();
  persist.initPersist();
  persist.pausePersist();
  context.setContent("демо-данные тура", "text");
  await sleep(900);
  eq(localStorage.getItem("dq-workspace"), null, "во время тура снапшот не пишется");
  persist.resumePersist();
  const data = JSON.parse(localStorage.getItem("dq-workspace"));
  eq(data.input, "демо-данные тура", "после тура состояние пересохранено");
});
