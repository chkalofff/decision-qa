// Доменные тесты: persist (автосохранение рабочего состояния в localStorage).
// Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, installDom, resetState, sleep,
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
  eq(data.results, null, "результатов нет — null в снапшоте");
  eq(data.resultsMeta, null, "resultsMeta null");
  assert("batchResults" in data, "batchResults в снапшоте");

  // фаза: результаты прогонов с разметкой сохраняются в снапшот
  state.results = { results: { mA: { ok: true } }, order: ["mA"], runMode: "decisions", questions: [], marks: [{ id: "m_1", verdict: "reject" }] };
  state.resultsMeta = { fingerprint: "fp-single" };
  batch.loadPresetFiles([{ name: "a.txt", content: "файл" }]);
  const fid = state.batch.files[0].id;
  state.batch.results[fid] = { mA: { ok: true } };
  state.batch.durations[fid] = 1.5;
  state.batch.marks = [{ id: "m_2", verdict: "accept" }];
  state.batch.resultsMeta = { fingerprint: "fp-batch" };
  persist.saveNow();
  const data2 = JSON.parse(localStorage.getItem("dq-workspace"));
  eq(data2.results.marks[0].id, "m_1", "разметка одиночного прогона в снапшоте");
  eq(data2.resultsMeta.fingerprint, "fp-single", "resultsMeta в снапшоте");
  eq(data2.batchResults.results[fid].mA.ok, true, "результаты пакета в снапшоте");
  eq(data2.batchResults.files.join(","), fid, "id файлов сохранены в порядке batchFiles для remap");
  eq(data2.batchResults.marks[0].id, "m_2", "разметка пакета в снапшоте");
  eq(data2.batchResults.resultsMeta.fingerprint, "fp-batch", "resultsMeta пакета в снапшоте");

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
  // Восстановление заменяет документ целиком: пустые результаты снапшота не
  // должны наследовать данные предыдущего состояния.
  state.results = { results: { old: { ok: true } }, order: ["old"], runMode: "decisions", questions: [], marks: [] };
  state.resultsMeta = { fingerprint: "old" };
  state.batch.results = { old_file: { old: { ok: true } } };
  state.batch.resultsMeta = { fingerprint: "old-batch" };
  state.batch.decision = { enabled: true, outcomes: [{ id: "old", label: "Old", rules: [] }] };
  state.batch.marks = [{ id: "old-mark", target: { scope: "batch", file: "old_file" }, verdict: "accept" }];
  state.batch.startedAt = 10;
  state.batch.finishedAt = 20;
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
  eq(state.results, null, "пустой снапшот очищает прежние одиночные результаты");
  eq(state.resultsMeta, null, "прежняя одиночная мета не наследуется");
  eq(state.resultsStale, false, "stale-плашка не возникает");
  eq(Object.keys(state.batch.results).length, 0, "прежние результаты пакета не наследуются");
  eq(state.batch.resultsMeta, null, "прежняя мета пакета не наследуется");
  eq(state.batch.decision, null, "прежнее решение прогона пакета очищено");
  eq(state.batch.marks.length, 0, "прежняя разметка пакета очищена");
  eq(state.batch.startedAt, null, "startedAt очищен");
  eq(state.batch.finishedAt, null, "finishedAt очищен");
  // Отсутствующий/битый снапшот не очищает текущее состояние.
  const keepResults = { results: {}, order: [], runMode: "decisions", questions: [], marks: [] };
  state.results = keepResults;
  const keepText = context.currentText();
  localStorage.removeItem("dq-workspace");
  eq(persist.restoreWorkspace(), null, "нет снапшота → null");
  eq(state.results, keepResults, "отсутствие снапшота не очищает результаты");
  eq(context.currentText(), keepText, "отсутствие снапшота не очищает контекст");
  localStorage.setItem("dq-workspace", "{битый");
  eq(persist.restoreWorkspace(), null, "битый JSON → null");
  eq(state.results, keepResults, "битый JSON не очищает результаты");
  eq(context.currentText(), keepText, "битый JSON не очищает контекст");
});

test("persist: resetDocumentState полностью очищает документ и batch running/cancelled", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domToolbar();
  context.initContext({});
  batch.initBatch({});
  context.setContent("материал", "text");
  state.contextImages = [{ name: "a.png", dataUrl: "data:image/png;base64,QUJD" }];
  questions.setQuestions([{ id: "q1", question: "Q?", type: "yes_no" }]);
  state.decision = { enabled: true, outcomes: [{ id: "o1", label: "A", color: "green", rules: [] }] };
  state.results = { results: { mA: { ok: true } }, order: ["mA"], runMode: "decisions", questions: [], marks: [] };
  state.resultsMeta = { fingerprint: "single" };
  state.resultsStale = true;
  batch.loadPresetFiles([{ name: "a.txt", content: "A" }]);
  const fid = state.batch.files[0].id;
  state.batch.results[fid] = { mA: { ok: true } };
  state.batch.durations[fid] = 2;
  state.batch.resultsMeta = { fingerprint: "batch" };
  state.batch.resultsStale = true;
  state.batch.decision = { enabled: true, outcomes: [{ id: "o1", label: "A", rules: [] }] };
  state.batch.questions = [{ id: "q1", question: "Q?", type: "yes_no" }];
  state.batch.marks = [{ id: "m1", target: { scope: "batch", file: fid }, verdict: "accept" }];
  state.batch.running = true;
  state.batch.cancelled = true;
  state.batch.startedAt = 10;
  state.batch.finishedAt = 20;
  document.getElementById("btn-batch-cancel").classList.remove("hidden");
  document.getElementById("batch-progress-wrap").classList.remove("hidden");
  document.getElementById("batch-progress").textContent = "обработано 1 из 1";

  persist.resetDocumentState();

  eq(context.currentText(), "", "контекст очищен");
  eq(state.contextImages.length, 0, "изображения очищены");
  eq(state.questions.length, 0, "вопросы очищены");
  eq(state.decision.outcomes.length, 0, "решение очищено через setDecision");
  eq(state.results, null, "одиночные результаты очищены");
  eq(state.resultsMeta, null, "одиночная мета очищена");
  eq(state.resultsStale, false, "одиночный stale сброшен");
  eq(state.batch.files.length, 0, "файлы пакета очищены");
  eq(Object.keys(state.batch.results).length, 0, "результаты пакета очищены");
  eq(Object.keys(state.batch.durations).length, 0, "durations пакета очищены");
  eq(state.batch.resultsMeta, null, "мета пакета очищена");
  eq(state.batch.resultsStale, false, "stale пакета сброшен");
  eq(state.batch.decision, null, "decision пакета очищен");
  eq(state.batch.questions, null, "questions-снапшот пакета очищен");
  eq(state.batch.marks.length, 0, "разметка пакета очищена");
  eq(state.batch.running, false, "running пакета сброшен полным resetBatch");
  eq(state.batch.cancelled, false, "cancelled пакета сброшен полным resetBatch");
  eq(state.batch.startedAt, null, "startedAt очищен");
  eq(state.batch.finishedAt, null, "finishedAt очищен");
  assert(document.getElementById("btn-batch-clear").disabled, "кнопка очистки пустого пакета disabled");
  assert(document.getElementById("btn-batch-cancel").classList.contains("hidden"), "кнопка отмены скрыта");
  assert(document.getElementById("batch-progress-wrap").classList.contains("hidden"), "прогресс скрыт");
  eq(document.getElementById("batch-progress").textContent, "", "текст прогресса очищен");
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

test("persist: restoreWorkspace восстанавливает результаты и разметку без stale", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domToolbar();
  context.initContext({});
  batch.initBatch({});
  persist.resumePersist();
  localStorage.clear();
  const oldBatchResult = (duration) => ({
    mA: { ok: true, answers: {}, usage: {}, metrics: { duration_s: duration } },
  });
  localStorage.setItem("dq-workspace", JSON.stringify({
    input_format: "text", input: "материал", questions: [], decision: null,
    pageMode: "single",
    batchFiles: [{ name: "a.txt", content: "A" }, { name: "b.txt", content: "B" }],
    results: { results: { mA: { ok: true, answers: {}, usage: {}, metrics: {} } }, order: ["mA"], runMode: "decisions", questions: [],
      marks: [{ id: "m_1", target: { scope: "single", model: "mA", mode: "decisions", question: "q1" }, verdict: "reject", comment: "плохо", criterion: "correctness", author: "local", created_at: "t", updated_at: "t" }] },
    resultsMeta: { fingerprint: "fp-single" },
    batchResults: {
      files: ["f1", "f2"],
      // Порядок ключей нарочно обратный: remap идёт по files/id, не по позиции ключа.
      results: { f2: oldBatchResult(2), f1: oldBatchResult(1) },
      durations: { f2: 22, f1: 11 },
      decision: null,
      questions: [],
      marks: [
        { id: "m_2", target: { scope: "batch", file: "f2", question: "q1", model: "mA" }, verdict: "accept", comment: "", created_at: "t", updated_at: "t" },
        { id: "m_orphan", target: { scope: "batch", file: "f_missing" }, verdict: "reject", comment: "" },
        { id: "m_model", target: { scope: "batch", model: "mA" }, verdict: "unsure", comment: "" },
      ],
      resultsMeta: { fingerprint: "fp-batch", runMode: "decisions", temperature: 0.4 },
    },
  }));
  const page = persist.restoreWorkspace();
  eq(page, "single", "страница восстановлена");
  eq(state.results.marks[0].id, "m_1", "разметка одиночного прогона на месте");
  eq(state.resultsMeta.fingerprint, "fp-single", "resultsMeta восстановлен");
  eq(state.resultsStale, false, "stale одиночного не выставлен");
  const [newF1, newF2] = state.batch.files;
  assert(newF1.id !== "f1" && newF2.id !== "f2", "loadPresetFiles создал новые id");
  eq(state.batch.results[newF1.id].mA.metrics.duration_s, 1, "результат f1 привязан к первому файлу по id");
  eq(state.batch.results[newF2.id].mA.metrics.duration_s, 2, "результат f2 привязан ко второму файлу по id");
  eq(state.batch.results.f1, undefined, "старый id не остаётся сиротой");
  eq(state.batch.durations[newF1.id], 11, "duration f1 remap'нута");
  eq(state.batch.durations[newF2.id], 22, "duration f2 remap'нута");
  eq(newF1.status, "ok", "статус первого файла восстановлен");
  eq(newF2.status, "ok", "статус второго файла восстановлен");
  eq(state.batch.marks.length, 2, "валидная файловая и модельная пометки восстановлены, сирота отброшена");
  eq(state.batch.marks.find(m => m.id === "m_2").target.file, newF2.id, "target.file пометки remap'нут");
  eq(state.batch.marks.find(m => m.id === "m_model").target.file, undefined, "пометка модели не требует file");
  eq(state.batch.resultsMeta.fingerprint, "fp-batch", "camelCase resultsMeta адаптирован в results_meta");
  eq(state.batch.resultsMeta.runMode, "decisions", "runMode пакета восстановлен");
  eq(state.batch.resultsMeta.temperature, 0.4, "температура пакета восстановлена");
  eq(state.batch.resultsStale, false, "stale пакета не выставлен");
});

test("persist: legacy без files — однозначный remap, неоднозначный backup/warning без сирот", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domToolbar();
  context.initContext({});
  batch.initBatch({});
  persist.resumePersist();
  localStorage.clear();
  const singleResults = {
    results: { mA: { ok: true, answers: {}, usage: {}, metrics: {} } },
    order: ["mA"], runMode: "decisions", questions: [], marks: [],
  };
  const batchResult = { mA: { ok: true, answers: {}, usage: {}, metrics: {} } };
  const base = { input_format: "text", questions: [], decision: null, pageMode: "batch" };

  // Единственный файл + единственный старый id: безопасный legacy remap.
  localStorage.setItem("dq-workspace", JSON.stringify({
    ...base, input: "legacy-one",
    batchFiles: [{ name: "one.txt", content: "one" }],
    batchResults: {
      results: { old_only: batchResult }, durations: { old_only: 3 },
      marks: [{ id: "m_legacy", target: { scope: "batch", file: "old_only" }, verdict: "accept", comment: "" }],
      results_meta: { fingerprint: "legacy-batch" },
    },
  }));
  let warnings = [];
  const page = persist.restoreWorkspace({ onWarning: (text) => warnings.push(text) });
  eq(page, "batch", "pageMode возвращается и с options-колбэком");
  eq(warnings.length, 0, "однозначный legacy не требует предупреждения");
  const only = state.batch.files[0];
  assert(state.batch.results[only.id], "один legacy результат remap'нут на новый id");
  eq(state.batch.durations[only.id], 3, "legacy duration remap'нута");
  eq(state.batch.marks[0].target.file, only.id, "legacy target.file remap'нут");
  eq(state.batch.resultsMeta.fingerprint, "legacy-batch", "старый snake_case results_meta принят");

  // Несколько файлов без files: входы и одиночные результаты восстанавливаем,
  // но пакетные результаты/разметку не угадываем.
  const raw = JSON.stringify({
    ...base, input: "legacy-many",
    batchFiles: [{ name: "a.txt", content: "A" }, { name: "b.txt", content: "B" }],
    results: singleResults, resultsMeta: { fingerprint: "single-legacy" },
    batchResults: {
      results: { old_a: batchResult, old_b: batchResult },
      durations: { old_a: 1, old_b: 2 },
      decision: { enabled: true, outcomes: [{ id: "o", label: "O", rules: [] }] },
      questions: [{ id: "q1", question: "Q?", type: "yes_no" }],
      marks: [{ id: "m_ambiguous", target: { scope: "batch", file: "old_a" }, verdict: "reject", comment: "" }],
    },
  });
  localStorage.setItem("dq-workspace", raw);
  warnings = [];
  persist.restoreWorkspace({ onWarning: (text) => warnings.push(text) });
  eq(context.currentText(), "legacy-many", "входные данные восстановлены");
  assert(state.results && state.results.results.mA.ok, "одиночные результаты восстановлены");
  eq(state.resultsMeta.fingerprint, "single-legacy", "одиночная мета восстановлена");
  eq(state.batch.files.length, 2, "файлы пакета восстановлены");
  eq(Object.keys(state.batch.results).length, 0, "неоднозначные результаты не прикреплены");
  eq(Object.keys(state.batch.durations).length, 0, "неоднозначные durations не прикреплены");
  eq(state.batch.marks.length, 0, "неоднозначная разметка не прикреплена");
  eq(state.batch.resultsMeta, null, "мета неоднозначного прогона не прикреплена");
  eq(state.batch.decision, null, "decision неоднозначного прогона не прикреплён");
  eq(state.batch.questions, null, "questions неоднозначного прогона не прикреплены");
  eq(localStorage.getItem("dq-workspace-legacy-unmapped"), raw, "сырой JSON сохранён в backup");
  eq(warnings.length, 1, "показано одно постоянное предупреждение");
  includes(warnings[0], "не восстановлены", "предупреждение объясняет потерю отображения результатов");
  includes(warnings[0], "dq-workspace-legacy-unmapped", "предупреждение содержит backup key");

  // Битая длина files тоже не допускает угадывания; существующий backup не затираем.
  const badRaw = JSON.stringify({
    ...base, input: "bad-mapping",
    batchFiles: [{ name: "a.txt", content: "A" }, { name: "b.txt", content: "B" }],
    batchResults: { files: ["only_one"], results: { only_one: batchResult }, marks: [] },
  });
  localStorage.setItem("dq-workspace", badRaw);
  warnings = [];
  persist.restoreWorkspace({ onWarning: (text) => warnings.push(text) });
  eq(Object.keys(state.batch.results).length, 0, "files неправильной длины отклонён");
  eq(localStorage.getItem("dq-workspace-legacy-unmapped"), raw, "существующий backup не перезаписан");
  eq(localStorage.getItem("dq-workspace-legacy-unmapped-2"), badRaw, "второй raw JSON сохранён под суффиксом");
  includes(warnings[0], "dq-workspace-legacy-unmapped-2", "warning называет фактический backup key");

  // Ещё один неоднозначный legacy получает отдельную копию. Все копии обязаны
  // пережить следующий autosave, который заменяет основной dq-workspace.
  const raw2 = JSON.stringify({
    ...base, input: "legacy-many-2",
    batchFiles: [{ name: "c.txt", content: "C" }, { name: "d.txt", content: "D" }],
    batchResults: { results: { other_a: batchResult, other_b: batchResult }, marks: [] },
  });
  localStorage.setItem("dq-workspace", raw2);
  warnings = [];
  persist.restoreWorkspace({ onWarning: (text) => warnings.push(text) });
  eq(localStorage.getItem("dq-workspace-legacy-unmapped-3"), raw2, "третий raw JSON сохранён отдельно");
  includes(warnings[0], "dq-workspace-legacy-unmapped-3", "warning содержит ключ новой копии");
  persist.saveNow();
  assert(localStorage.getItem("dq-workspace") !== raw2, "saveNow перезаписал основной workspace");
  eq(localStorage.getItem("dq-workspace-legacy-unmapped"), raw, "первый ambiguous raw пережил autosave");
  eq(localStorage.getItem("dq-workspace-legacy-unmapped-2"), badRaw, "промежуточный backup пережил autosave");
  eq(localStorage.getItem("dq-workspace-legacy-unmapped-3"), raw2, "второй ambiguous raw пережил autosave");
});

test("persist: снапшот >4 МБ без изображений — fallback без результатов", async () => {
  installDom(); await resetState(); domContext(); domQuestions(); domBatch(); domToolbar();
  context.initContext({});
  batch.initBatch({});
  persist.resumePersist();
  localStorage.clear();
  // огромный результат (без изображений тоже > лимита) → фолбэк
  state.results = { results: { mA: { ok: true, text: "x".repeat(5 * 1024 * 1024) } }, order: ["mA"], runMode: "decisions", questions: [], marks: [] };
  state.resultsMeta = { fingerprint: "fp" };
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (m) => warnings.push(m);
  persist.saveNow();
  console.warn = origWarn;
  const data = JSON.parse(localStorage.getItem("dq-workspace"));
  eq(warnings.length, 1, "console.warn о фолбэке");
  assert(!("results" in data), "results не сохранены в фолбэке");
  assert(!("batchResults" in data), "batchResults не сохранены в фолбэке");
  eq(data.input, "", "входные данные сохранены");
  eq(state.results.order[0], "mA", "state не тронут");
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
