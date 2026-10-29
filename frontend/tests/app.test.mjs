// Доменные тесты: app. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, installDom, el, fakeFile, resetState, mockFetch, sleep, domApp, modelsResp, runApiRoutes, TEST_RUN_ID, ansYesNo, runRes, state, results, questions, context, batch, alreadyRun, toolbar, update, assistant, review, persist,
} from "./harness.mjs";
import { singleFingerprint } from "../static/fingerprint.js";

// ================================================================ app (один server job для режима «Оба»)
test("app: режим «Оба» — один /api/run job, canonical decisions+fast_batch и provenance", async () => {
  installDom(); await resetState(); domApp();
  const calls = mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A 27B", status: "running" }]),
    "GET /api/presets": [],
    ...runApiRoutes({ onFile: (file) => ({
      type: "file", i: file.i, status: "ok", errors: [], duration_s: 32,
      runs: [
        { model: "mA", mode: "decisions", ok: true, answers: {}, usage: {}, prompt_format_version: 1,
          metrics: { duration_s: 30, prompt_tokens: 500, prefill_tok_s: 16.7 } },
        { model: "mA", mode: "fast_batch", ok: true, answers: {}, usage: {}, prompt_format_version: 1,
          metrics: { duration_s: 2, prompt_tokens: 520, prefill_tok_s: 260 } },
      ],
    }) }),
  });
  await import("../static/app.js");
  await sleep(30);

  state.runMode = "both";
  state.threads = 3;
  document.getElementById("context-input").value = "Иван врач.";
  state.questions[0].question = "Иван врач?";
  document.getElementById("tb-run").fire("click");
  await sleep(40);

  eq(calls.filter(call => call.key === "POST /api/run").length, 1, "один job на прогон");
  eq(calls.filter(call => call.key === "POST /api/decide").length, 0, "legacy HTTP не используется");
  const created = calls.find(call => call.key === "POST /api/run").body;
  eq(created.overrides.mode, "both", "режим передан серверу");
  eq(created.material_count, 1, "один материал");
  eq(created.threads, 3, "threads одиночного прогона");
  assert(state.results, "результаты сохранены");
  eq(state.results.runMode, "both", "режим both");
  eq(state.results.results.mA.decisions.metrics.duration_s, 30, "метрики обычного свои");
  eq(state.results.results.mA.fast_batch.metrics.prefill_tok_s, 260, "метрики быстрого свои");
  eq(state.resultsMeta.latestRun, TEST_RUN_ID, "latestRun");
  eq(state.results.runIds.mA.decisions, TEST_RUN_ID, "decisions link");
  eq(state.results.runIds.mA.fast_batch, TEST_RUN_ID, "fast link");
  await sleep(300);
  const currentDescriptor = await alreadyRun.currentSingleDescriptor();
  const storedRun = state.resultsMeta.runs[TEST_RUN_ID];
  eq(state.pinnedFormats.mA, 1, "resolved prompt format закреплён в текущем state");
  eq(currentDescriptor.configFingerprint, storedRun.configFingerprint, "current/stored single config fingerprint");
  eq(currentDescriptor.materialsFingerprint, storedRun.materialsFingerprint, "current/stored single materials fingerprint");
  assert(!document.getElementById("already-run-single").classList.contains("hidden"),
    "после completed run фактическая плашка «Уже прогнано» появляется");

  // баннер ошибки: текст в .banner-text и закрытие крестиком
  document.getElementById("context-input").value = "";
  document.getElementById("tb-run").fire("click");
  await sleep(30);
  const errBanner = document.getElementById("error-banner");
  assert(!errBanner.classList.contains("hidden"), "баннер ошибки показан");
  includes(document.getElementById("error-banner-text").textContent, "Материал", "текст ошибки в .banner-text");
  document.getElementById("error-banner-close").fire("click");
  assert(errBanner.classList.contains("hidden"), "баннер закрыт крестиком");
  const fmtBanner = document.getElementById("format-banner");
  fmtBanner.classList.remove("hidden");
  document.getElementById("format-banner-close").fire("click");
  assert(fmtBanner.classList.contains("hidden"), "format-баннер тоже закрывается");
});

// Эти тесты идут после app-теста выше: модуль app.js уже инициализирован на
// текущем DOM (переустановка DOM отвязала бы обработчики), поэтому без installDom.
test("app: картинки — пресет грузит изображения (+ баннер «нужны vision»), прогон шлёт images и пропускает non-vision", async () => {
  await resetState();
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running", vision: false }]),
    "GET /api/presets": [
      { name: "UGC", description: "d", page: "single", input: "пост",
        images: ["data:image/png;base64,QUJD"],
        questions: [{ id: "q1", question: "Q?", type: "yes_no" }] },
    ],
  });
  document.getElementById("tb-menu-btn").fire("click");
  document.getElementById("tb-menu-presets").fire("click");
  await sleep(10);
  const item = [...document.getElementById("tb-menu-presets-sub").children]
    .find(i => i.textContent.includes("UGC"));
  assert(item, "пресет в меню");
  includes(item.textContent, "🖼", "бейдж 🖼 у пресета с картинками");
  // применение пресета очищает прошлые результаты и их fingerprint
  state.results = { results: {}, order: [], runMode: "decisions", questions: [] };
  state.resultsMeta = { fingerprint: "old" };
  state.resultsStale = true;
  item.fire("click");
  eq(state.results, null, "пресет очищает прошлые результаты");
  eq(state.resultsMeta, null, "мета результатов очищена");
  eq(state.resultsStale, false, "stale сброшен");
  eq(state.contextImages.length, 1, "картинка из пресета загружена");
  eq(state.contextImages[0].dataUrl, "data:image/png;base64,QUJD", "dataUrl");
  const fmtBanner = document.getElementById("format-banner");
  assert(!fmtBanner.classList.contains("hidden"), "format-баннер показан");
  includes(document.getElementById("format-banner-text").textContent, "vision-модели", "текст баннера");
  // прогон с картинкой — images в payload, non-vision модели пропущены
  let captured = null;
  let uploaded = null;
  mockFetch({
    "GET /api/models": modelsResp([
      { key: "mA", label: "Qwen A", status: "running", vision: false, api: "decisions" },
      { key: "cB", label: "Clef B", status: "running", vision: true, api: "systemone" },
    ]),
    "GET /api/presets": [],
    ...runApiRoutes({
      onCreate: call => { captured = call.body; },
      onFile: file => {
        uploaded = file;
        return { type: "file", i: file.i, status: "ok", errors: [], duration_s: 1,
          runs: [{ model: "cB", mode: "decisions", ok: true, answers: { q1: ansYesNo(0.9, 0.1) },
            usage: {}, metrics: { duration_s: 1, prompt_tokens: 10 }, prompt_format_version: 1 }] };
      },
    }),
  });
  toolbar.refreshModels();
  await sleep(10); // поллинг → авто-выбор обеих running
  document.getElementById("context-input").value = ""; // пустой текст + картинка
  state.questions = [{ id: "q1", question: "Есть телефон?", type: "yes_no", collapsed: true }];
  document.getElementById("tb-run").fire("click");
  await sleep(30);
  assert(captured, "run создан");
  eq(captured.overrides.models.join(","), "cB", "non-vision модель пропущена");
  eq(uploaded.images.join(","), "data:image/png;base64,QUJD", "images в chunk");
  eq(uploaded.input, "", "пустой текст допустим с картинкой");
  assert(state.results && state.results.images, "images в state.results (бейдж чипа)");
  await sleep(10);
});

test("app: direction — применяется из пресета и попадает в снапшот результатов (маркировка score и да/нет)", async () => {
  await resetState();
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running" }]),
    "GET /api/presets": [
      { name: "ScorePreset", description: "d", page: "single", input: "текст",
        questions: [
          { id: "q1", question: "Оценка?", type: "score", levels: ["плохо", "хорошо"], direction: "up" },
          { id: "q2", question: "Есть риск?", type: "yes_no", yes: "да", no: "нет", direction: "no" },
        ] },
    ],
  });
  document.getElementById("tb-menu-btn").fire("click");
  document.getElementById("tb-menu-presets").fire("click");
  await sleep(10);
  const item = [...document.getElementById("tb-menu-presets-sub").children]
    .find(i => i.textContent.includes("ScorePreset"));
  assert(item, "пресет в меню");
  item.fire("click");
  eq(state.questions.length, 2, "вопросы из пресета применены");
  eq(state.questions[0].direction, "up", "direction из пресета сохранён (не сброшен нормализацией)");
  eq(state.questions[1].direction, "no", "direction yes/no из пресета сохранён");
  // прогон — снапшот вопросов в результатах несёт direction
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running" }]),
    "GET /api/presets": [],
    ...runApiRoutes({ onFile: file => ({ type: "file", i: file.i, status: "ok", errors: [], duration_s: 1,
      runs: [{ model: "mA", mode: "decisions", ok: true, usage: {}, prompt_format_version: 1,
        metrics: { duration_s: 1, prompt_tokens: 10 }, answers: {
          q1: { type: "score", score: 1, probabilities: { 0: 0.1, 1: 0.9 }, label_mass: 0.99 },
          q2: { type: "yes_no", probabilities: { yes: 0.8, no: 0.2 }, label_mass: 0.99 },
        } }],
    }) }),
  });
  toolbar.refreshModels();
  await sleep(10);
  document.getElementById("context-input").value = "контекст";
  document.getElementById("tb-run").fire("click");
  await sleep(30);
  assert(state.results, "результаты сохранены");
  eq(state.results.questions[0].direction, "up", "direction в снапшоте результатов");
  eq(state.results.questions[1].direction, "no", "direction yes/no в снапшоте результатов");
  const answers = document.querySelectorAll("#results-list .res-answer");
  eq(answers.length, 2, `две строки ответов; running=${state.running}; error=${document.getElementById("error-banner-text").textContent}; results=${JSON.stringify(state.results.results)}`);
  assert(answers[0].classList.contains("dir-good"), "score промаркирован dir-good");
  assert(answers[1].classList.contains("dir-bad"), "да/нет: «да» при «нет = лучше» → dir-bad");
  await sleep(10);
});

test("app: прогон сохраняет fingerprint; правка вопроса → stale-плашка; новый прогон снимает её", async () => {
  await resetState();
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running" }]),
    "GET /api/presets": [],
    ...runApiRoutes(),
  });
  toolbar.refreshModels();
  await sleep(10);
  document.getElementById("context-input").value = "текст материала";
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no", collapsed: true }];
  document.getElementById("tb-run").fire("click");
  await sleep(30);
  assert(state.results, "результаты сохранены");
  assert(state.resultsMeta && state.resultsMeta.fingerprint, "fingerprint сохранён рядом с результатами");
  eq(state.resultsStale, false, "свежий прогон не stale");
  assert(!document.getElementById("results-stale"), "плашки нет после прогона");

  // правка вопроса → дебаунсированный пересчёт → stale + плашка
  state.questions[0].question = "Другой вопрос?";
  questions.renderQuestions(); // emit("questions") → refreshStale по дебаунсу
  await sleep(450);
  eq(state.resultsStale, true, "stale выставлен после правки вопроса");
  const plaque = document.getElementById("results-stale");
  assert(plaque, "stale-плашка отрисована");
  includes(plaque.textContent, "неактуальн", "текст плашки");

  // новый прогон (результаты есть) — диалог перепрогона; «С нуля» снимает пометку и обновляет fingerprint
  const oldFp = state.resultsMeta.fingerprint;
  document.getElementById("tb-run").fire("click");
  await sleep(30);
  assert(document.getElementById("rerun-dialog"), "диалог перепрогона показан");
  assert(document.getElementById("rerun-append").disabled, "после правки входов append заблокирован");
  includes(document.getElementById("rerun-dialog").textContent, "материалы, вопросы", "причина блокировки append видна");
  document.getElementById("rerun-replace").fire("click");
  await sleep(10);
  eq(state.resultsStale, false, "новый прогон снимает stale");
  assert(state.resultsMeta.fingerprint !== oldFp, "fingerprint обновлён");
  assert(!document.getElementById("results-stale"), "плашка убрана после нового прогона");
});

test("app: перепрогон — диалог «Добавить/С нуля»: слияние сохраняет разметку, замена сбрасывает, Esc отменяет", async () => {
  await resetState();
  // авто-стартовавший тур ловит Esc на document — закрываем, чтобы не мешал диалогу
  const helpMod = await import("../static/help.js");
  helpMod.closeHelp();
  await sleep(5);
  state.models = [
    { key: "mA", label: "Qwen A", status: "running" },
    { key: "mB", label: "Qwen B", status: "running" },
  ];
  state.selectedModels = new Set(["mA"]);
  const calls = mockFetch({
    "GET /api/models": modelsResp(state.models),
    "GET /api/presets": [],
    ...runApiRoutes(),
  });
  document.getElementById("context-input").value = "материал";
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no", collapsed: true }];

  // первый прогон — результата ещё нет, диалог не показывается
  document.getElementById("tb-run").fire("click");
  await sleep(30);
  assert(!document.getElementById("rerun-dialog"), "без результатов диалога нет");
  eq(Object.keys(state.results.results).join(","), "mA", "первый прогон: только mA");
  // регрессия: рендер после сброса running — триада разметки есть в DOM строки
  const firstRow = document.querySelector("#results-list .res-row");
  assert(firstRow && [...firstRow.children].some(c => (c.className || "").includes("review-hover-triad")),
    `hover-триада после прогона; running=${state.running}; error=${document.getElementById("error-banner-text").textContent}`);
  review.setVerdict("single", { scope: "single", model: "mA", mode: "decisions", question: "q1" }, "accept");

  // отмена (Esc) — прогон не стартует, результаты и разметка не тронуты
  const snapshot = JSON.stringify(state.results);
  const nRuns = calls.filter(c => c.key === "POST /api/run").length;
  document.getElementById("tb-run").fire("click");
  await sleep(30);
  assert(document.getElementById("rerun-dialog"), "диалог показан при повторном запуске");
  includes(document.getElementById("rerun-dialog").textContent, "1 пометок, 0 комментариев", "диалог с числом пометок");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  await sleep(10);
  eq(state.running, false, "после отмены прогон не стартовал");
  eq(JSON.stringify(state.results), snapshot, "результаты не изменены");
  eq(calls.filter(c => c.key === "POST /api/run").length, nRuns, "новый job не создан");

  // «Добавить к результатам» (Enter) — слияние: обе модели, разметка своя
  state.selectedModels = new Set(["mB"]);
  document.getElementById("tb-run").fire("click");
  await sleep(30);
  document.dispatchEvent({ type: "keydown", key: "Enter" });
  await sleep(10);
  eq(Object.keys(state.results.results).sort().join(","), "mA,mB", "слияние: обе модели в results");
  eq(state.results.order.join(","), "mA,mB", "order объединён без дублей");
  eq(state.results.marks.length, 1, "разметка сохранена при слиянии");
  eq(review.findMark("single", { scope: "single", model: "mA", mode: "decisions", question: "q1" }).verdict,
    "accept", "пометка mA на месте");
  assert(state.resultsMeta && state.resultsMeta.fingerprint, "fingerprint переписан последним прогоном");
  // фильтр моделей одиночного режима виден и показывает обе модели
  eq(document.querySelectorAll("#model-filter-row .model-toggle-chip").length, 2, "два чипа фильтра моделей");

  // «Начать с нуля» — полная замена, разметка пуста
  state.selectedModels = new Set(["mA"]);
  document.getElementById("tb-run").fire("click");
  await sleep(30);
  document.getElementById("rerun-replace").fire("click");
  await sleep(10);
  eq(Object.keys(state.results.results).join(","), "mA", "замена: только новый прогон");
  eq(state.results.order.join(","), "mA", "order заменён");
  eq(state.results.marks.length, 0, "разметка сброшена при замене");
});

test("app: одиночный прогон использует неизменяемый снапшот до/после await и сохраняет runMode/temperature", async () => {
  await resetState();
  const helpMod = await import("../static/help.js");
  helpMod.closeHelp();
  await sleep(5);
  state.models = [{ key: "mA", label: "Qwen A", status: "running" }];
  state.selectedModels = new Set(["mA"]);
  state.runMode = "decisions";
  state.temperature = 0.7;
  state.pinnedFormats = { mA: 1 };
  document.getElementById("context-input").value = "Исходный материал";
  state.questions = [{ id: "q1", question: "Исходный вопрос?", type: "yes_no", direction: "no", collapsed: true }];
  state.decision = { enabled: true, outcomes: [
    { id: "o1", label: "Исходный исход", color: "green", isDefault: true, rules: [], collapsed: false },
  ] };
  const originalFingerprint = singleFingerprint(context.currentText());
  state.results = { results: {}, order: [], runMode: "decisions", questions: [], marks: [] };
  state.resultsMeta = { fingerprint: originalFingerprint, runMode: "decisions", temperature: 0.7 };

  let captured = null;
  let uploaded = null;
  let resolveEvents = null;
  mockFetch({
    "GET /api/models": modelsResp(state.models),
    "GET /api/presets": [],
    ...runApiRoutes({
      onCreate: call => { captured = call.body; },
      onFile: file => {
        uploaded = file;
        return { type: "file", i: file.i, status: "ok", errors: [], duration_s: 1,
          runs: [{ model: "mA", mode: "decisions", ok: true, answers: { q1: ansYesNo(0.9, 0.1) },
            usage: {}, metrics: { duration_s: 1, prompt_tokens: 10 }, prompt_format_version: 1 }] };
      },
      onSse: text => new Promise(resolve => { resolveEvents = () => resolve(text); }),
    }),
  });
  document.getElementById("tb-run").fire("click");
  await sleep(30);
  assert(document.getElementById("rerun-dialog"), "диалог открыт до сетевого запроса");
  eq(captured, null, "HTTP ещё не начался");

  // Правки во время диалога не должны менять уже захваченный прогон.
  document.getElementById("context-input").value = "Изменённый материал";
  state.questions[0].question = "Изменённый вопрос?";
  state.questions[0].direction = "yes";
  state.decision.outcomes[0].label = "Изменённый исход";
  state.runMode = "fast_batch";
  state.temperature = 1.8;
  state.pinnedFormats = { mA: 2 };
  document.getElementById("rerun-append").fire("click");
  await sleep(10);
  assert(captured, "запрос выполнен после выбора append");
  eq(uploaded.input, "Исходный материал", "chunk input из снапшота");
  eq(captured.pack.questions[0].question, "Исходный вопрос?", "pack question из снапшота");
  eq(captured.overrides.mode, "decisions", "override mode из снапшота");
  eq(captured.pack.settings.temperature, 0.7, "pack temperature из снапшота");
  eq(captured.pack.settings.prompt_formats.mA, 1, "pinned format из снапшота");

  // И ещё одна правка уже после отправки: wrapper/meta тоже остаются исходными.
  state.questions[0].question = "Вопрос после отправки?";
  state.decision.outcomes[0].label = "Исход после отправки";
  state.runMode = "both";
  state.temperature = 2;
  resolveEvents();
  await sleep(30);
  assert(state.results && state.results.results.mA?.ok,
    `ответ сохранён; running=${state.running}; error=${document.getElementById("error-banner-text").textContent}; results=${JSON.stringify(state.results)}`);
  eq(state.results.runMode, "decisions", "runMode wrapper из снапшота");
  eq(state.results.questions[0].question, "Исходный вопрос?", "questions wrapper из снапшота");
  eq(state.results.questions[0].direction, "no", "direction wrapper из снапшота");
  eq(state.results.decision.outcomes[0].label, "Исходный исход", "decision wrapper из снапшота");
  assert(!("collapsed" in state.results.decision.outcomes[0]), "UI collapsed не попал в decision snapshot");
  eq(state.resultsMeta.fingerprint, originalFingerprint, "fingerprint соответствует исходным входам");
  eq(state.resultsMeta.runMode, "decisions", "runMode сохранён в resultsMeta");
  eq(state.resultsMeta.temperature, 0.7, "temperature сохранена в resultsMeta");
  eq(state.resultsStale, true, "текущие правки помечают снапшот результатов stale");
});

test("app: «Экспорт данных» — диалог, direction score-вопросов и batch_files в файле", async () => {
  await resetState();
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  state.questions = [{ id: "q1", question: "S?", type: "score", levels: ["a", "b"], direction: "down", collapsed: true }];
  document.getElementById("context-input").value = "контекст";
  batch.loadPresetFiles([
    { name: "a.txt", content: "текст" },
    { name: "p.png", image: "data:image/png;base64,QUJD" },
  ]);
  let captured = null;
  globalThis.URL.createObjectURL = (blob) => { captured = blob.content; return "blob:x"; };
  document.getElementById("tb-menu-save-copy").fire("click");
  const dlg = document.getElementById("saveas-dialog");
  assert(dlg, "диалог «Экспорт данных» открыт");
  eq(document.getElementById("saveas-filename").value, "контекст", "имя по умолчанию — из контекста");
  document.getElementById("saveas-ok").fire("click");
  await sleep(10);
  assert(captured, "файл экспортирован");
  const data = JSON.parse(captured);
  eq(data.materials.input, "контекст", "контекст в экспорте");
  eq(data.config.questions[0].direction, "down", "direction в экспорте");
  eq(data.materials.batch_files.length, 2, "batch_files в экспорте");
  eq(data.materials.batch_files[0].content, "текст", "текстовый файл → content");
  eq(data.materials.batch_files[1].image, "data:image/png;base64,QUJD", "картинка → image (dataUrl)");
  assert(!data.results, "без чекбокса результатов нет");
  assert(!document.getElementById("saveas-dialog"), "диалог закрыт");
  await sleep(10);
});

test("app: меню «Новый» — полная очистка с подтверждением", async () => {
  await resetState();
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  document.getElementById("context-input").value = "материал";
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no", collapsed: true }];
  state.decision = { enabled: true, outcomes: [{ id: "o1", label: "A", color: "green", rules: [] }] };
  batch.loadPresetFiles([{ name: "a.txt", content: "x" }]);
  const batchId = state.batch.files[0].id;
  state.batch.results[batchId] = { mA: { ok: true } };
  state.batch.resultsMeta = { fingerprint: "batch-fp" };
  state.batch.decision = { enabled: true, outcomes: [{ id: "o1", label: "A", rules: [] }] };
  state.batch.marks = [{ id: "m_b", target: { scope: "batch", file: batchId }, verdict: "accept" }];
  state.batch.startedAt = 10;
  state.batch.finishedAt = 20;
  state.results = { results: {}, order: [], runMode: "decisions", questions: [] };
  state.resultsMeta = { fingerprint: "fp" };
  state.resultsStale = true;
  // отмена dirty guard — ничего не очищено
  document.getElementById("tb-menu-new").fire("click");
  document.getElementById("document-cancel").fire("click");
  await sleep(10);
  eq(state.questions.length, 1, "при отмене вопросы на месте");
  assert(state.results, "при отмене результаты на месте");
  // «Не сохранять» — очищается всё
  const previousDocId = persist.currentDocument().id;
  document.getElementById("tb-menu-new").fire("click");
  document.getElementById("document-discard").fire("click");
  await sleep(80);
  eq(document.getElementById("context-input").value, "", "контекст очищен");
  eq(state.contextImages.length, 0, "изображения очищены");
  eq(state.questions.length, 1, "новый документ имеет один пустой вопрос");
  assert(persist.currentDocument().id !== previousDocId, "новый документ получил fresh id");
  eq(persist.currentDocument().status, "new", "новый документ не связан с файлом");
  eq(state.decision.outcomes.length, 0, "решение очищено (setDecision(null) → пустое)");
  eq(state.batch.files.length, 0, "файлы пакета очищены");
  eq(Object.keys(state.batch.results).length, 0, "результаты пакета очищены");
  eq(state.batch.resultsMeta, null, "мета пакета очищена");
  eq(state.batch.decision, null, "decision-снапшот пакета очищен");
  eq(state.batch.marks.length, 0, "разметка пакета очищена");
  eq(state.batch.startedAt, null, "startedAt пакета очищен");
  eq(state.batch.finishedAt, null, "finishedAt пакета очищен");
  eq(state.results, null, "результаты очищены");
  eq(state.resultsMeta, null, "мета очищена");
  eq(state.resultsStale, false, "stale сброшен");
  await sleep(10);
});

test("app: импорт batch_files — страница «Батч», баннер и отмена диалога", async () => {
  await resetState();
  mockFetch({ "GET /api/models": modelsResp([]), "GET /api/presets": [] });
  const label = document.getElementById("tb-menu-open");
  const payload = JSON.stringify({ input: "", batch_files: [
    { name: "a.txt", content: "x" },
    { name: "p.png", image: "data:image/png;base64,QUJD" },
  ] });
  label.fire("change", { target: { files: [fakeFile("s.json", payload)], value: "" } });
  await sleep(0);
  document.getElementById("import-materials").checked = true;
  document.getElementById("import-materials").fire("change");
  document.getElementById("import-apply").fire("click");
  await sleep(10);
  eq(state.batch.files.length, 2, "файлы загружены в батч");
  assert(state.batch.files[1].isImage, "картинка распознана");
  eq(state.pageMode, "batch", "страница переключена на «Батч»");
  const fmt = document.getElementById("format-banner-text");
  assert(!document.getElementById("format-banner").classList.contains("hidden"), "баннер показан");
  includes(fmt.textContent, "пакета", "текст баннера про файлы пакета");
  // повторный импорт при непустом батче: отмена диалога — ничего не меняется
  label.fire("change", { target: { files: [fakeFile("s2.json", '{"batch_files":[{"name":"b.txt","content":"y"}]}')], value: "" } });
  await sleep(0);
  document.getElementById("import-cancel").fire("click");
  await sleep(10);
  eq(state.batch.files.length, 2, "отмена диалога — батч не изменился");
  eq(state.batch.files[0].name, "a.txt", "старые файлы на месте");
});

test("app: ✨ генерация вопросов — диалог, POST с контекстом, вопросы добавлены", async () => {
  await resetState();
  state.models = [
    { key: "rG", label: "GPT cloud", type: "remote", api: "openai", enabled: true,
      base_url: "https://api.openai.com/v1", api_model: "gpt-4o" },
    { key: "mA", label: "Local", type: "sglang", status: "running" },  // не chat-remote — не в селекторе
  ];
  const calls = mockFetch({
    "GET /api/models": modelsResp(state.models),
    "GET /api/presets": [],
    "GET /api/assistant/models": { models: [
      { key: "rG", label: "GPT cloud", remote: true },
      { key: "bonsai2-27b", label: "Bonsai-2 27B 2bit", remote: false },
    ] },
    "POST /api/questions/generate": {
      questions: [
        { id: "q1", question: "Есть цифры?", type: "yes_no", yes: "цифры есть" },
        { id: "q2", question: "Стек?", type: "choice", options: [{ name: "Python" }, { name: "Go" }] },
      ],
    },
  });
  document.getElementById("context-input").value = "резюме Ивана";
  document.getElementById("btn-gen-questions").fire("click");
  await sleep(10);  // диалог открывается после fetch /api/assistant/models
  const dlg = document.getElementById("generate-dialog");
  assert(dlg, "диалог открыт");
  const sel = document.getElementById("generate-model");
  eq(sel.children.length, 2, "облачная и локальная chat-модели в селекторе");
  includes(sel.children[0].textContent, "☁", "облачная помечена ☁");
  includes(sel.children[1].textContent, "Bonsai", "bonsai видна в диалоге");
  assert(!document.getElementById("generate-thinking").checked,
    "рассуждение выключено по умолчанию");
  document.getElementById("generate-task").value = "проверка резюме";
  document.getElementById("generate-ok").fire("click");
  await sleep(10);
  const gen = calls.find(c => c.key === "POST /api/questions/generate");
  assert(gen, "generate вызван");
  eq(gen.body.model_key, "rG", "модель из селектора");
  eq(gen.body.thinking, false, "thinking=false без чекбокса");
  eq(gen.body.input, "резюме Ивана", "текущий контекст ушёл как input");
  eq(gen.body.hint, "проверка резюме", "описание задачи ушло как hint");
  const texts = state.questions.map(q => q.question);
  includes(texts.join("|"), "Есть цифры?", "сгенерированный вопрос добавлен");
  includes(texts.join("|"), "Стек?", "второй вопрос добавлен");
  const gen1 = state.questions.find(q => q.question === "Есть цифры?");
  eq(gen1.yes, "цифры есть", "yes-описание сохранено");
  assert(gen1.id !== "q1" || !state.questions.some(q => q !== gen1 && q.id === "q1"),
    "id перегенерирован");
  assert(!document.getElementById("generate-dialog"), "диалог закрыт после успеха");
  // ошибка API — остаётся в диалоге
  mockFetch({
    "GET /api/models": modelsResp(state.models),
    "GET /api/presets": [],
    "GET /api/assistant/models": { models: [{ key: "rG", label: "GPT cloud", remote: true }] },
    "POST /api/questions/generate": { __status: 502, detail: "API ответил 429" },
  });
  document.getElementById("btn-gen-questions-batch").fire("click");
  await sleep(10);  // диалог открывается после fetch /api/assistant/models
  document.getElementById("generate-task").value = "задача";
  document.getElementById("generate-ok").fire("click");
  await sleep(10);
  const err = document.getElementById("generate-error");
  assert(!err.classList.contains("hidden"), "ошибка показана в диалоге");
  includes(err.textContent, "429", "текст 502 в диалоге");
  assert(document.getElementById("generate-dialog"), "диалог остался открытым");
  document.getElementById("generate-cancel").fire("click");
  await sleep(10);
});

// ---------------------------------------------------------------- тур: демо-прогоны и восстановление

test("app: тур — демо-результаты в фоне; выход восстанавливает состояние бит-в-бит", async () => {
  await resetState();
  const helpMod = await import("../static/help.js");
  helpMod.closeHelp();
  await sleep(10);
  mockFetch({
    "GET /api/models": modelsResp([{ key: "mA", label: "Qwen A", status: "running" }]),
    "GET /api/presets": [
      { slug: "content_moderation", name: "Модерация", page: "single", input: "демо-пост",
        questions: [{ id: "has_insults", question: "Есть ли оскорбления?", type: "yes_no", direction: "no" }],
        decision: { outcomes: [{ id: "ok", label: "Ок", color: "green", isDefault: true, rules: [] }] } },
      { slug: "batch_resume_screening", name: "Резюме", page: "batch",
        questions: [{ id: "q1", question: "Цифры?", type: "yes_no", direction: "yes" }],
        decision: { outcomes: [{ id: "ok", label: "Ок", color: "green", isDefault: true, rules: [] }] },
        files: [{ name: "resume_01_petrov.txt", content: "Резюме Петрова" }] },
    ],
  });

  // --- состояние пользователя до тура: свой текст, свой прогон (с разметкой), пустой пакет
  document.getElementById("context-input").value = "мой текст";
  const userResults = {
    results: { mA: runRes({ duration_s: 3, prompt_tokens: 10 }, { q1: ansYesNo(0.7, 0.3) }) },
    order: ["mA"], runMode: "decisions", questions: [{ id: "q1", question: "Мой вопрос?", type: "yes_no" }],
    marks: [{ id: "m_u1", target: { scope: "single", model: "mA", mode: "decisions", question: "q1" },
              verdict: "reject", comment: "моя пометка", criterion: "correctness",
              author: "local", created_at: "t", updated_at: "t" }],
  };
  state.results = userResults;
  state.resultsMeta = { fingerprint: "user-fp" };
  state.resultsStale = true; // у пользователя были неактуальные результаты
  const userPageMode = state.pageMode;

  const steps = helpMod.HELP_STEPS;
  const runIdx = steps.findIndex(s => s.demoRun);
  const batchIdx = steps.findIndex(s => s.demoBatch);

  // --- фаза 1: интерактивный demoRun — клики по результатам, выход прямо с шага
  helpMod.openHelp(runIdx);
  await sleep(20); // onDemoEnter + onDemoRun (fetch пресетов)
  assert(state.results && state.results.results.demo, "демо-прогон подложен в state.results");
  assert(document.getElementById("results-list").children.length > 0, "результаты отрисованы в фоне");
  // интерактив: backdrop пропускает клики, область результатов над затемнением
  assert(document.querySelector(".help-backdrop").classList.contains("help-interactive"),
    "demoRun: backdrop в интерактивном режиме");
  assert(document.getElementById("results-card").classList.contains("help-highlight"),
    "demoRun: область результатов подсвечена");
  // persist на паузе: демо-контент не меняет документ и не попадает в legacy storage
  const savedDuringTour = localStorage.getItem("dq-workspace");
  assert(!savedDuringTour || !savedDuringTour.toLowerCase().includes("оскорблен"),
    "демо-вопросы тура не записались в прежнее хранилище");
  // клики по демо-результатам: строка разворачивается в дрилдаун, чип решения — в разбор
  document.getElementById("results-list").querySelector(".res-row").fire("click");
  assert(document.getElementById("results-list").querySelector(".res-detail"),
    "дрилдаун строки открылся поверх тура");
  const chip = document.querySelector("#decision-chips .decision-chip");
  assert(chip, "чип решения отрисован");
  chip.fire("click");
  assert(document.querySelector(".decision-overlay"), "разбор решения открылся поверх тура");
  document.querySelector(".decision-overlay").fire("click"); // закрыть разбор
  // разметка демо-результатов на шаге тура — штатная часть обучения
  review.setVerdict("single", { scope: "single", model: "demo", mode: "decisions", question: "has_insults" }, "accept");
  eq(state.results.marks.length, 1, "пометка на демо-результате поставлена");
  // выход прямо с интерактивного шага — снапшот восстановлен, несмотря на клики
  helpMod.closeHelp();
  await sleep(10);
  eq(JSON.stringify(state.results), JSON.stringify(userResults), "результаты пользователя (с разметкой) восстановлены после выхода с demoRun-шага");
  eq(document.getElementById("context-input").value, "мой текст", "контекст восстановлен");
  eq(state.pageMode, userPageMode, "pageMode восстановлен");
  assert(!document.querySelector(".help-highlight"), "подсветка тура снята");

  // --- фаза 2: интерактивный demoBatch — дрилдаун таблицы, выход с шага
  helpMod.openHelp(batchIdx);
  await sleep(20);
  eq(state.batch.files.length, 1, "демо-файл пакета загружен");
  eq(state.batch.files[0].status, "ok", "демо-файл помечен обработанным");
  assert(Object.keys(state.batch.results).length > 0, "демо-результаты пакета подложены");
  assert(document.getElementById("batch-results").querySelector(".batch-table-wrap, table"), "таблица результатов пакета отрисована");
  assert(document.querySelector(".help-backdrop").classList.contains("help-interactive"),
    "demoBatch: backdrop в интерактивном режиме");
  assert(document.getElementById("batch-results-card").classList.contains("help-highlight"),
    "demoBatch: карточка результатов пакета подсвечена");
  // клик по дрилдауну строки таблицы поверх открытого тура
  document.querySelector("#batch-results .batch-file-th-chevron").fire("click");
  const batchDetail = document.querySelector("#batch-results .batch-detail-row");
  assert(batchDetail && !batchDetail.classList.contains("hidden"),
    "дрилдаун строки пакета открылся поверх тура");
  // пометка на демо-пакете (batchMarks — явное поле tourSnap)
  review.setVerdict("batch", { scope: "batch", file: state.batch.files[0].id }, "reject");
  eq(state.batch.marks.length, 1, "пометка на демо-пакете поставлена");

  // --- выход: пакет был пуст → демо-файлы убраны, результаты пользователя на месте
  helpMod.closeHelp();
  await sleep(10);
  eq(state.batch.files.length, 0, "демо-файлы очищены при изначально пустом пакете");
  eq(JSON.stringify(state.batch.results), "{}", "демо-результаты пакета убраны");
  eq(state.batch.marks.length, 0, "демо-разметка пакета убрана");
  eq(JSON.stringify(state.results), JSON.stringify(userResults), "результаты пользователя восстановлены");
  eq(state.resultsMeta && state.resultsMeta.fingerprint, "user-fp", "fingerprint пользователя восстановлен");
  eq(state.resultsStale, true, "stale-флаг восстановлен — ложной плашки нет, своя не потеряна");
  eq(document.getElementById("context-input").value, "мой текст", "контекст восстановлен");

  // --- фаза 3: непустой пакет и его результаты переживают тур
  batch.loadPresetFiles([{ name: "mine.txt", content: "мой файл" }]);
  const mineId = state.batch.files[0].id;
  state.batch.results[mineId] = { mA: runRes({ duration_s: 2, prompt_tokens: 5 }, { q1: ansYesNo(0.9, 0.1) }) };
  state.batch.durations[mineId] = 2;
  state.batch.marks = [{ id: "m_ub", target: { scope: "batch", file: mineId }, verdict: "accept",
    comment: "", criterion: "correctness", author: "local", created_at: "t", updated_at: "t" }];
  const userBatchResults = JSON.stringify(state.batch.results);
  const userBatchMarks = JSON.stringify(state.batch.marks);
  helpMod.openHelp(batchIdx);
  await sleep(20);
  eq(state.batch.files.length, 1, "демо-пакет снова загружен");
  eq(state.batch.files[0].name, "resume_01_petrov.txt", "это демо-файл");
  eq(state.batch.marks.length, 0, "разметка пользователя на время тура убрана");
  helpMod.closeHelp();
  await sleep(10);
  eq(state.batch.files.length, 1, "файл пользователя восстановлен");
  eq(state.batch.files[0].name, "mine.txt", "имя файла пользователя");
  eq(JSON.stringify(state.batch.results), userBatchResults, "результаты пакета пользователя восстановлены");
  eq(JSON.stringify(state.batch.marks), userBatchMarks, "разметка пакета пользователя восстановлена");
});

// ---------------------------------------------------------------- lifecycle: entry guard / reset / pre-await snapshot

function lifecycleModels() {
  return [
    { key: "mA", label: "A", status: "running", api: "decisions", type: "sglang", vision: true },
    { key: "mB", label: "B", status: "running", api: "decisions", type: "sglang", vision: true },
  ];
}

async function setupLifecycleSingle() {
  await resetState();
  state.models = lifecycleModels();
  state.selectedModels = new Set(["mA"]);
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no" }];
  document.getElementById("context-input").value = "исходный материал";
}

function lifecycleDelayedDigest() {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.digest.bind(subtle);
  let release;
  let announce;
  const started = new Promise(resolve => { announce = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  let delayed = false;
  subtle.digest = (...args) => {
    if (delayed) return original(...args);
    delayed = true;
    announce();
    return pending.then(() => original(...args));
  };
  return {
    started,
    release: () => { subtle.digest = original; release(); },
    restore: () => { subtle.digest = original; },
  };
}

test("lifecycle single: double-click создаёт один job; delayed completion после resetDocumentState не пишет в новый документ", async () => {
  await setupLifecycleSingle();
  let calls = mockFetch({
    "GET /api/models": modelsResp(lifecycleModels()), "GET /api/presets": [], ...runApiRoutes(),
  });
  document.getElementById("tb-run").fire("click");
  document.getElementById("tb-run").fire("click");
  await sleep(40);
  eq(calls.filter(call => call.key === "POST /api/run").length, 1, "guard сработал до первого await");
  eq(state.running, false, "running очищен текущим job");

  persist.resetDocumentState();
  await setupLifecycleSingle();
  let resolveEvents;
  calls = mockFetch({
    "GET /api/models": modelsResp(lifecycleModels()), "GET /api/presets": [],
    ...runApiRoutes({ onSse: text => new Promise(resolve => { resolveEvents = () => resolve(text); }) }),
  });
  document.getElementById("tb-run").fire("click");
  await sleep(30);
  assert(resolveEvents, "старый job ждёт terminal SSE");
  persist.resetDocumentState();
  resolveEvents();
  await sleep(40);
  eq(state.results, null, "старый file/final не восстановил results");
  eq(state.resultsMeta, null, "старый final не записал latestRun/runs");
  eq(state.running, false, "fresh scope не блокирован старым finally");
  eq(calls.filter(call => call.key === "POST /api/run").length, 1, "reset не создал новый job");
});

test("lifecycle single: delayed hash + edit сохраняет полный старый snapshot и помечает его stale", async () => {
  await resetState();
  state.models = lifecycleModels();
  state.selectedModels = new Set(["mA"]);
  state.questions = [{ id: "q1", question: "Старый вопрос?", type: "yes_no", direction: "no" }];
  state.decision = { enabled: true, outcomes: [{ id: "o1", label: "Старый исход", color: "green", rules: [] }] };
  state.temperature = 0.6;
  state.threads = 3;
  document.getElementById("context-input").value = "Старый материал";
  const delay = lifecycleDelayedDigest();
  const calls = mockFetch({
    "GET /api/models": modelsResp(state.models), "GET /api/presets": [], ...runApiRoutes(),
  });
  try {
    document.getElementById("tb-run").fire("click");
    await delay.started;
    document.getElementById("context-input").value = "Новый материал";
    state.questions[0].question = "Новый вопрос?";
    state.questions[0].direction = "yes";
    state.decision.outcomes[0].label = "Новый исход";
    state.selectedModels = new Set(["mB"]);
    state.runMode = "fast_batch";
    state.temperature = 1.7;
    state.threads = 7;
    delay.release();
  } finally {
    delay.restore();
  }
  await sleep(50);
  const created = calls.find(call => call.key === "POST /api/run").body;
  const uploaded = calls.find(call => call.key.includes("/files") && call.body?.files).body.files[0];
  eq(uploaded.input, "Старый материал", "input захвачен до await");
  eq(created.pack.questions[0].question, "Старый вопрос?", "questions до await");
  eq(created.pack.decision.outcomes[0].label, "Старый исход", "decision до await");
  eq(created.overrides.models.join(","), "mA", "models до await");
  eq(created.overrides.mode, "decisions", "mode до await");
  eq(created.pack.settings.temperature, 0.6, "temperature до await");
  eq(created.threads, 3, "threads до await");
  eq(state.results.decision.outcomes[0].label, "Старый исход", "старые answers не совмещены с новым decision");
  eq(state.results.questions[0].direction, "no", "UI snapshot direction сохранён");
  eq(state.resultsStale, true, "post-await edits помечены stale");
});

// ---------------------------------------------------------------- обновления

function domUpdateBanner() {
  const banner = el("div", { id: "update-banner", className: "error-banner hidden" });
  el("span", { id: "update-banner-text", className: "banner-text", parent: banner });
  const link = el("a", { id: "update-banner-link", parent: banner });
  el("button", { id: "update-banner-close", parent: banner });
  return { banner, link };
}

const GH_LATEST = "https://api.github.com/repos/chkalofff/decision-qa/releases/latest";

function clearUpdateStorage() {
  localStorage.removeItem("dq-update-check");
  localStorage.removeItem("dq-update-dismissed");
}

test("app: dangling workshop dependency блокирует Run до HTTP job", async () => {
  await resetState();
  const calls = mockFetch({});
  state.models = [{ key: "mA", label: "A", status: "running" }];
  state.selectedModels = new Set(["mA"]);
  document.getElementById("context-input").value = "material";
  state.questions = [{ id: "q1", question: "Valid?", type: "yes_no", collapsed: true }];
  state.decision = { enabled: true, outcomes: [{ id: "o1", label: "Review", color: "gray", rules: [
    { anyOf: false, conditions: [{ question: "q_missing", answer: "yes", op: "gte", threshold: 0.5 }] },
  ] }] };
  document.getElementById("tb-run").fire("click");
  await sleep(20);
  eq(calls.filter(call => call.key === "POST /api/run").length, 0, "dangling reference не создаёт run job");
  includes(document.getElementById("error-banner-text").textContent, "вопрос не найден", "показана причина блокировки");
});

test("update: semver-парсинг и сравнение версий", () => {
  eq(JSON.stringify(update.parseVersion("0.2.0")), "[0,2,0]", "0.2.0");
  eq(JSON.stringify(update.parseVersion("v1.10.3")), "[1,10,3]", "v-префикс");
  eq(update.parseVersion("dev"), null, "dev — не semver");
  eq(update.parseVersion(""), null, "пустая строка");
  assert(update.isNewerVersion("v0.3.0", "0.2.0"), "0.3.0 новее 0.2.0");
  assert(update.isNewerVersion("0.2.1", "0.2.0"), "0.2.1 новее 0.2.0");
  assert(!update.isNewerVersion("0.2.0", "0.2.0"), "равные — не новее");
  assert(!update.isNewerVersion("0.2.0", "v0.3.0"), "старая не новее новой");
  assert(!update.isNewerVersion("1.0", "0.2.0"), "не-semver игнорируется");
});

test("update: новый релиз → баннер с версией и командой", async () => {
  installDom(); clearUpdateStorage();
  const { banner, link } = domUpdateBanner();
  const calls = mockFetch({
    "GET /api/version": { version: "0.2.0" },
    [`GET ${GH_LATEST}`]: { tag_name: "v0.3.0", html_url: "https://github.com/chkalofff/decision-qa/releases/tag/v0.3.0" },
  });
  const info = await update.checkForUpdate();
  assert(info, "инфо о новой версии");
  eq(info.version, "0.3.0", "версия без v");
  update.renderUpdateBanner(info);
  assert(!banner.classList.contains("hidden"), "баннер виден");
  includes(document.getElementById("update-banner-text").textContent, "0.3.0", "текст с версией");
  includes(document.getElementById("update-banner-text").textContent, "update_mac.sh", "команда обновления");
  eq(link.href, "https://github.com/chkalofff/decision-qa/releases/tag/v0.3.0", "ссылка на релиз");
  // закрытие скрывает баннер и запоминает dismissed-версию
  document.getElementById("update-banner-close").fire("click");
  assert(banner.classList.contains("hidden"), "баннер скрыт");
  eq(JSON.parse(localStorage.getItem("dq-update-dismissed")), "v0.3.0", "dismissed записан");
  // повторная проверка той же версии → null
  clearUpdateStorage();
  localStorage.setItem("dq-update-dismissed", JSON.stringify("v0.3.0"));
  const again = await update.checkForUpdate();
  eq(again, null, "закрытая версия не предлагается повторно");
});

test("update: равные версии и ошибки сети → без баннера, GitHub не опрашивается лишний раз", async () => {
  installDom(); clearUpdateStorage();
  domUpdateBanner();
  const calls = mockFetch({
    "GET /api/version": { version: "0.2.0" },
    [`GET ${GH_LATEST}`]: { tag_name: "v0.2.0", html_url: "u" },
  });
  eq(await update.checkForUpdate(), null, "та же версия — null");
  eq(calls.filter(c => c.key === `GET ${GH_LATEST}`).length, 1, "один запрос к GitHub");
  assert(document.getElementById("update-banner").classList.contains("hidden"), "баннер не показан");
  // ошибки — тихий фейл
  clearUpdateStorage();
  mockFetch({
    "GET /api/version": { version: "0.2.0" },
    [`GET ${GH_LATEST}`]: { __status: 403, detail: "rate limit" },
  });
  eq(await update.checkForUpdate(), null, "ошибка GitHub — null");
  assert(document.getElementById("update-banner").classList.contains("hidden"), "баннер не показан");
  mockFetch({});
  eq(await update.checkForUpdate(), null, "backend не ответил — null");
});

test("update: кэш суток — повтор без запроса; протухший кэш → запрос", async () => {
  installDom(); clearUpdateStorage();
  domUpdateBanner();
  const calls = mockFetch({
    "GET /api/version": { version: "0.2.0" },
    [`GET ${GH_LATEST}`]: { tag_name: "v0.3.0", html_url: "u" },
  });
  await update.checkForUpdate();
  await update.checkForUpdate();
  await update.checkForUpdate();
  eq(calls.filter(c => c.key === `GET ${GH_LATEST}`).length, 1, "GitHub опрошен один раз");
  // протухший кэш → повторный запрос
  localStorage.setItem("dq-update-check", JSON.stringify({
    at: Date.now() - 25 * 60 * 60 * 1000, latest: { tag: "v0.1.0", url: "u" },
  }));
  const info = await update.checkForUpdate();
  assert(info && info.version === "0.3.0", "после протухания кэша версия свежая");
  eq(calls.filter(c => c.key === `GET ${GH_LATEST}`).length, 2, "запрос к GitHub выполнен повторно");
});
