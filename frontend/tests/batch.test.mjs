// Доменные тесты: batch. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, notIncludes, installDom, fakeFile, resetState, mockFetch, sleep, domQuestions, domBatch, runApiRoutes, TEST_RUN_ID, ansYesNo, runRes, state, results, questions, batch, alreadyRun, lightbox, preview, review,
} from "./harness.mjs";
import { batchFingerprint } from "../static/fingerprint.js";

// ================================================================ batch

function setupBatchRun(nFiles) {
  state.models = [{ key: "mA", label: "Qwen A", status: "running" }];
  state.selectedModels = new Set(["mA"]);
  state.questions = [{ id: "q1", question: "Есть цифры?", type: "yes_no", collapsed: true }];
  const files = [];
  for (let i = 1; i <= nFiles; i++) files.push({ name: `r${i}.txt`, content: `резюме ${i} `.repeat(100) });
  batch.loadPresetFiles(files);
}

test("batch: loadPresetFiles наполняет список и прогресс; snapshot — текст → content, картинка → image, round-trip", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchRun(10);
  eq(state.batch.files.length, 10, "10 файлов");
  eq(document.getElementById("batch-list").children.length, 10, "10 строк списка");
  // Прогресс живёт в карточке результатов и виден только во время прогона
  const wrap = document.getElementById("batch-progress-wrap");
  assert(wrap.classList.contains("hidden"), "прогресс скрыт вне прогона");
  eq(wrap.closest("#batch-results-card") !== null, true, "прогресс в карточке «Результаты»");
  eq(document.getElementById("btn-batch-cancel").closest("#batch-results-card") !== null, true, "отмена в карточке «Результаты»");
  eq(document.getElementById("batch-progress").textContent, "", "счётчик пуст");
  // batchFilesSnapshot — без статусов, круговой round-trip
  batch.loadPresetFiles([
    { name: "doc.txt", content: "текст" },
    { name: "p.png", image: "data:image/png;base64,QUJD" },
  ]);
  const snap = batch.batchFilesSnapshot();
  eq(snap.length, 2, "два файла");
  eq(JSON.stringify(Object.keys(snap[0]).sort()), '["content","name"]', "только name+content");
  eq(JSON.stringify(Object.keys(snap[1]).sort()), '["image","name"]', "только name+image");
  eq(snap[0].content, "текст", "content текстового");
  eq(snap[1].image, "data:image/png;base64,QUJD", "image картинки");
  state.batch.decision = { enabled: true, outcomes: [{ id: "old", label: "Old", rules: [] }] };
  state.batch.startedAt = 10;
  state.batch.finishedAt = 20;
  batch.loadPresetFiles(snap);
  eq(state.batch.decision, null, "loadPresetFiles очищает decision прогона");
  eq(state.batch.startedAt, null, "loadPresetFiles очищает startedAt");
  eq(state.batch.finishedAt, null, "loadPresetFiles очищает finishedAt");
  eq(state.batch.files.length, 2, "файлы восстановлены");
  eq(state.batch.files[0].text, "текст", "текст на месте");
  assert(state.batch.files[1].isImage, "картинка на месте");
});

test("batch: один job для N файлов, инкрементальные SSE-строки и cancel активного job", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchRun(2);
  alreadyRun.initAlreadyRun();
  state.threads = 4;
  let incrementalOk = false;
  let progressMidRun = "";
  let calls = mockFetch(runApiRoutes({ onSse: text => {
    const split = text.indexOf("id: 3\n");
    return [text.slice(0, split), () => {
      incrementalOk = document.getElementById("batch-results").children.length > 0;
      progressMidRun = document.getElementById("batch-progress").textContent;
      return text.slice(split);
    }];
  } }));
  await batch.runBatch();
  eq(calls.filter(call => call.key === "POST /api/run").length, 1, "один job");
  eq(calls.find(call => call.key === "POST /api/run").body.threads, 4, "threads пакетного прогона");
  eq(calls.filter(call => call.key === `POST /api/run/${TEST_RUN_ID}/files`).length, 1, "один bounded chunk");
  assert(incrementalOk, "таблица результатов отрисовалась после первого file event");
  includes(progressMidRun, "1 из 2", "прогресс виден во время прогона");
  assert(state.batch.files.every(f => f.status === "ok"), "все файлы ok");
  eq(state.batch.resultsMeta.latestRun, TEST_RUN_ID, "batch latestRun");
  assert(state.batch.files.every(f => state.batch.runIds[f.id].mA === TEST_RUN_ID), "file/model links");
  assert(document.getElementById("batch-progress-wrap").classList.contains("hidden"), "прогресс скрыт после завершения");
  eq(document.getElementById("batch-progress").textContent, "", "счётчик очищен после завершения");
  await sleep(300);
  const currentDescriptor = await alreadyRun.currentBatchDescriptor();
  const storedRun = state.batch.resultsMeta.runs[TEST_RUN_ID];
  eq(currentDescriptor.configFingerprint, storedRun.configFingerprint, "current/stored batch config fingerprint");
  eq(currentDescriptor.materialsFingerprint, storedRun.materialsFingerprint, "current/stored batch materials fingerprint");
  eq(JSON.stringify(currentDescriptor.materialHashes), JSON.stringify(storedRun.materialHashes), "current/stored ordered hashes");
  assert(!document.getElementById("already-run-batch").classList.contains("hidden"),
    "после completed batch фактическая плашка «Уже прогнано» появляется");

  setupBatchRun(3);
  calls = mockFetch(runApiRoutes({ onSse: text => {
    const split = text.indexOf("id: 3\n");
    return [text.slice(0, split), async () => {
      document.getElementById("btn-batch-cancel").fire("click");
      await sleep(0);
      return text.slice(split);
    }];
  } }));
  await batch.runBatch();
  assert(calls.some(call => call.key === `POST /api/run/${TEST_RUN_ID}/cancel`), "отмена ушла в /api/run/cancel");
  eq(state.batch.files[0].status, "ok", "первый успел");
  eq(state.batch.files[1].status, "pending", "второй не завершён");
  eq(state.batch.files[2].status, "pending", "третий не завершён");
});

test("batch: неизменяемый снапшот файлов/конфигурации, stable id и stale после правок во время прогона", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchRun(2);
  state.questions[0].direction = "no";
  state.decision = { enabled: true, outcomes: [
    { id: "o1", label: "Исходный исход", color: "green", isDefault: true, rules: [], collapsed: false },
  ] };
  state.temperature = 0.6;
  state.pinnedFormats = { mA: 1 };
  const originalInputs = state.batch.files.map(f => f.text);
  const originalFingerprint = batchFingerprint();
  for (const f of state.batch.files) {
    f.status = "ok";
    state.batch.results[f.id] = { mOld: runRes({ duration_s: 2, prompt_tokens: 5 }, { q1: ansYesNo(0.7, 0.3) }) };
  }
  state.batch.resultsMeta = { fingerprint: originalFingerprint, runMode: "decisions", temperature: 0.6 };

  let resolveEvents = null;
  let captured = null;
  const uploaded = [];
  const calls = mockFetch(runApiRoutes({
    onCreate: call => { captured = call.body; },
    onStart: call => { uploaded.push(...calls.filter(item => item.key === `POST /api/run/${TEST_RUN_ID}/files`).flatMap(item => item.body.files)); },
    onSse: text => new Promise(resolve => { resolveEvents = () => resolve(text); }),
  }));
  const run = batch.runBatch();
  await sleep(5);
  assert(document.getElementById("rerun-dialog"), "диалог открыт до обработки файлов");
  eq(calls.length, 0, "до выбора HTTP нет");

  // Меняем живые файлы и общую конфигурацию, пока открыт диалог.
  state.batch.files.forEach((f, i) => {
    f.name = `edited-${i}.txt`;
    f.text = `изменённый текст ${i}`;
  });
  state.questions[0].question = "Изменённый вопрос?";
  state.questions[0].direction = "yes";
  state.decision.outcomes[0].label = "Изменённый исход";
  state.temperature = 1.4;
  state.pinnedFormats = { mA: 2 };
  document.getElementById("rerun-append").fire("click");
  await sleep(10);
  eq(uploaded.length, 2, "все файлы ушли одним chunk");
  eq(uploaded[0].input, originalInputs[0], "input первого файла из снапшота");
  eq(captured.pack.questions[0].question, "Есть цифры?", "questions из снапшота");
  eq(captured.overrides.models.join(","), "mA", "models из снапшота");
  eq(captured.overrides.mode, "decisions", "batch runMode зафиксирован");
  eq(captured.pack.settings.temperature, 0.6, "temperature из снапшота");
  eq(captured.pack.settings.prompt_formats.mA, 1, "pinned format из снапшота");

  // Подменяем объект живого файла с тем же id: завершение должно обновить его,
  // а не старую ссылку, захваченную циклом.
  const replacement = { ...state.batch.files[0] };
  state.batch.files[0] = replacement;
  resolveEvents();
  await run;
  eq(uploaded[1].input, originalInputs[1], "input второго файла тоже из снапшота");
  eq(captured.pack.settings.temperature, 0.6, "конфигурация не изменилась");
  eq(replacement.status, "ok", "статус обновлён на текущем объекте по stable id");
  const firstId = replacement.id;
  assert(state.batch.results[firstId].mOld, "append сохранил ответы старой модели");
  assert(state.batch.results[firstId].mA, "ответы новой модели добавлены");
  eq(state.batch.questions[0].question, "Есть цифры?", "question snapshot не переписан правкой");
  eq(state.batch.questions[0].direction, "no", "direction snapshot не переписан правкой");
  eq(state.batch.decision.outcomes[0].label, "Исходный исход", "decision snapshot не переписан правкой");
  assert(!("collapsed" in state.batch.decision.outcomes[0]), "UI collapsed исключён");
  eq(state.batch.resultsMeta.fingerprint, originalFingerprint, "batch fingerprint из снапшота");
  eq(state.batch.resultsMeta.runMode, "decisions", "runMode сохранён в batch resultsMeta");
  eq(state.batch.resultsMeta.temperature, 0.6, "temperature сохранена в batch resultsMeta");
  eq(state.batch.resultsStale, true, "правки во время прогона не сброшены на финише");
});

test("batch: выключенное решение не валидируется и не снапшотится", async () => {
  installDom(); await resetState(); domBatch();
  let err = null;
  batch.initBatch({ showError: (m) => { err = m; } });
  setupBatchRun(1);
  state.decision = { enabled: false, outcomes: [
    { id: "o1", label: "", color: "green", rules: [] },  // пустой label — невалидно
  ] };
  mockFetch(runApiRoutes());
  await batch.runBatch();
  eq(err, null, "прогон прошёл без валидации решения");
  eq(state.batch.decision, null, "решение не снапшотится");
  state.decision.enabled = true;
  await batch.runBatch();
  includes(err, "Решение", "включённое невалидное решение блокирует");
});

test("batch: CSV экранирует запятые и кавычки", async () => {
  installDom(); await resetState(); domBatch();
  const rows = [{
    file: { id: "f1", name: 'a,"b".txt' },
    perModel: { mA: runRes({ duration_s: 1 }, { q1: ansYesNo(0.8, 0.2) }) },
  }];
  const csv = batch.buildBatchCsv(rows, [{ id: "q1", question: "Есть цифры?", type: "yes_no" }]);
  includes(csv, '"a,""b"".txt"', "имя файла экранировано");
});

test("batch: редактор вопросов на батч-странице — общий state с одиночным", async () => {
  installDom(); await resetState(); domQuestions(); domBatch();
  batch.initBatch({});
  questions.mountQuestions();
  questions.mountQuestions({ listId: "batch-questions-list", emptyId: "batch-questions-empty" });
  const emptyB = document.getElementById("batch-questions-empty");
  assert(!emptyB.classList.contains("hidden"), "подсказка пустого списка видна в батче");
  questions.addQuestion({ question: "Есть цифры?", type: "yes_no" });
  eq(document.getElementById("batch-questions-list").children.length, 1, "вопрос отрисован в батче");
  eq(document.getElementById("questions-list").children.length, 1, "тот же вопрос в одиночном");
  assert(emptyB.classList.contains("hidden"), "подсказка скрыта");
  // удаление через батч-инстанс отражается в одиночном
  state.questions[0].collapsed = false;
  questions.renderQuestions();
  const del = [...document.getElementById("batch-questions-list").children[0].querySelectorAll("button")]
    .find(b => b.textContent === "Удалить");
  assert(del, "кнопка «Удалить» есть и в батч-инстансе");
  del.fire("click");
  eq(state.questions.length, 0, "вопрос удалён из общего state");
  eq(document.getElementById("questions-list").children.length, 0, "одиночный инстанс обновлён");
  assert(!emptyB.classList.contains("hidden"), "подсказка вернулась");
});

test("batch: файлы нумеруются № в списке и в таблице результатов", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  batch.loadPresetFiles([
    { name: "a.txt", content: "первый" },
    { name: "b.txt", content: "второй" },
  ]);
  const rows = document.getElementById("batch-list").children;
  eq(rows[0].querySelector(".batch-file-num").textContent, "№1", "№ первого файла");
  eq(rows[1].querySelector(".batch-file-num").textContent, "№2", "№ второго файла");
  // результаты: в заголовке файла — № + имя
  state.models = [{ key: "mA", label: "Model A", status: "running" }];
  state.selectedModels = new Set(["mA"]);
  state.questions = [{ id: "q1", question: "Ок?", type: "yes_no" }];
  const fid = state.batch.files[0].id;
  state.batch.files[0].status = "ok";
  state.batch.results = { [fid]: { mA: { ok: true, answers: { q1: ansYesNo(0.9, 0.1) } } } };
  batch.renderBatchResults();
  const th = document.querySelector("#batch-results .batch-file-th-name");
  includes(th.textContent, "№1 · a.txt", "№ в таблице результатов");
});

test("batch: превью текстового файла — hover-тултип, клик-оверлей, json pretty-print", async () => {  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  batch.loadPresetFiles([{ name: "big.txt", content: "абв".repeat(500) }]); // 1500 символов
  const name = document.getElementById("batch-list").children[0].querySelector(".batch-file-name");
  name.fire("mouseenter");
  const tip = document.body.querySelector(".dist-tip");
  assert(tip && !tip.classList.contains("hidden"), "тултип виден");
  const pre = tip.querySelector(".tip-text");
  assert(pre, "в тултипе текстовое превью");
  eq(pre.textContent.length, 601, "600 символов + …");
  name.fire("mouseleave");
  assert(tip.classList.contains("hidden"), "тултип скрыт при уходе курсора");
  // клик — оверлей с полным текстом, Esc закрывает
  name.fire("click");
  assert(preview.isPreviewOpen(), "оверлей открыт");
  const ov = document.body.querySelector(".preview-overlay");
  eq(ov.querySelector(".preview-text").textContent.length, 1500, "полный текст");
  eq(ov.querySelector(".preview-caption").textContent, "big.txt", "имя в шапке");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!preview.isPreviewOpen(), "Esc закрыл оверлей");
  // .json — pretty-print в тултипе и оверлее
  batch.loadPresetFiles([{ name: "data.json", content: '{"a":1,"b":[1,2]}' }]);
  const nameJ = document.querySelector("#batch-list .batch-file-name");
  nameJ.fire("mouseenter");
  const tipText = document.body.querySelector(".dist-tip .tip-text").textContent;
  includes(tipText, '"a": 1', "отступы pretty-print в тултипе");
  nameJ.fire("click");
  const ovText = document.body.querySelector(".preview-overlay .preview-text").textContent;
  includes(ovText, '"a": 1', "отступы pretty-print в оверлее");
  includes(ovText, "\n", "многострочный вывод");
  preview.closePreview();
});

test("batch: превью-оверлей — ⛶ CSS-фолбэк, ✕ и клик по фону закрывают", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  batch.loadPresetFiles([{ name: "a.txt", content: "текст" }]);
  document.querySelector("#batch-list .batch-file-name").fire("click");
  const ov = document.body.querySelector(".preview-overlay");
  const box = ov.querySelector(".preview-box");
  assert(typeof box.requestFullscreen !== "function", "в моке нет Fullscreen API");
  ov.querySelector(".preview-fs").fire("click");
  assert(ov.classList.contains("preview-full"), "CSS-фолбэк включён");
  ov.querySelector(".preview-fs").fire("click");
  assert(!ov.classList.contains("preview-full"), "повторный клик снимает фолбэк");
  ov.querySelector(".preview-close").fire("click");
  assert(!preview.isPreviewOpen(), "✕ закрыл");
  // клик по контенту не закрывает, по фону — закрывает
  document.querySelector("#batch-list .batch-file-name").fire("click");
  box.fire("click");
  assert(preview.isPreviewOpen(), "клик по контенту не закрывает");
  ov.fire("click");
  assert(!preview.isPreviewOpen(), "клик по фону закрывает");
});

test("batch: таблица результатов — hover/клик по имени текстового файла открывают превью, дрилдаун по стрелке", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchResults({
    models: [{ key: "mA", label: "Qwen A", status: "running" }],
    questions: [{ id: "q1", question: "Есть цифры?", type: "yes_no", collapsed: true }],
    files: [{
      name: "r1.txt", content: "резюме",
      results: { mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.8, 0.2) }) },
    }],
  });
  const th = document.querySelector("#batch-results .batch-file-th");
  const nameSpan = th.querySelector(".batch-file-th-name");
  const detail = document.querySelector("#batch-results .batch-detail-row");
  nameSpan.fire("mouseenter");
  const tip = document.body.querySelector(".dist-tip");
  assert(tip.querySelector(".tip-text"), "hover по имени — текстовый тултип");
  includes(tip.textContent, "резюме", "содержимое файла в тултипе");
  nameSpan.fire("mouseleave");
  // клик по имени — превью-оверлей, дрилдаун закрыт
  nameSpan.fire("click");
  assert(preview.isPreviewOpen(), "клик по имени открыл превью");
  includes(document.body.querySelector(".preview-overlay .preview-text").textContent, "резюме", "текст в оверлее");
  assert(detail.classList.contains("hidden"), "дрилдаун не открылся");
  preview.closePreview();
  // дрилдаун — по стрелке
  const chevron = th.querySelector(".batch-file-th-chevron");
  assert(chevron, "стрелка дрилдауна есть");
  chevron.fire("click");
  assert(!detail.classList.contains("hidden"), "стрелка открыла дрилдаун");
  chevron.fire("click");
  assert(detail.classList.contains("hidden"), "повторный клик закрыл дрилдаун");
});

test("preview: openPreview(kind:image) делегирует лайтбоксу", async () => {
  installDom(); await resetState();
  preview.openPreview({ kind: "image", src: "data:image/png;base64,QUJD", name: "a.png" });
  assert(lightbox.isLightboxOpen(), "лайтбокс открыт");
  eq(document.body.querySelector(".lightbox-img").src, "data:image/png;base64,QUJD", "src лайтбокса");
  lightbox.closeLightbox();
});

function fakeDataTransfer() {
  return {
    _d: {},
    setData(k, v) { this._d[k] = v; },
    getData(k) { return this._d[k]; },
    effectAllowed: null,
    dropEffect: null,
  };
}

test("batch: drag&drop меняет порядок файлов; во время прогона заблокирован", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  batch.loadPresetFiles([
    { name: "a.txt", content: "a" },
    { name: "b.txt", content: "b" },
    { name: "c.txt", content: "c" },
  ]);
  const list = document.getElementById("batch-list");
  const dt = fakeDataTransfer();
  const rowA = list.children[0];
  const handleA = rowA.querySelector(".drag-handle");
  eq(handleA.title, "Перетащите, чтобы изменить порядок", "title у handle");
  eq(handleA.draggable, true, "draggable вне прогона");
  handleA.fire("dragstart", { dataTransfer: dt });
  assert(rowA.classList.contains("dragging"), "строка в состоянии dragging");
  const rowC = list.children[2];
  rowC.fire("dragover", { dataTransfer: dt });
  assert(rowC.classList.contains("drop-target"), "индикатор drop-позиции");
  rowC.fire("drop", { dataTransfer: dt });
  eq(state.batch.files.map(f => f.name).join(","), "b.txt,c.txt,a.txt", "порядок в state");
  eq([...list.children].map(r => r.querySelector(".batch-file-name").textContent).join(","),
    "b.txt,c.txt,a.txt", "порядок строк в DOM");
  // во время прогона drag&drop заблокирован
  state.batch.running = true;
  const dt2 = fakeDataTransfer();
  list.children[0].querySelector(".drag-handle").fire("dragstart", { dataTransfer: dt2 });
  list.children[1].fire("dragover", { dataTransfer: dt2 });
  assert(!list.children[1].classList.contains("drop-target"), "нет индикатора во время прогона");
  list.children[1].fire("drop", { dataTransfer: dt2 });
  eq(state.batch.files.map(f => f.name).join(","), "b.txt,c.txt,a.txt", "порядок не изменился");
});

// ---------------------------------------------------------------- изображения (этап 4)

test("batch: drop .png добавляет image-файл — миниатюра, hover-превью, клик → лайтбокс, без 👁", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  const drop = document.getElementById("batch-drop");
  drop.fire("drop", { dataTransfer: { files: [fakeFile("pic.png", "png-bytes")] } });
  await sleep(10);
  eq(state.batch.files.length, 1, "файл добавлен");
  const f = state.batch.files[0];
  assert(f.isImage, "isImage");
  assert(f.dataUrl.startsWith("data:image/png;base64,"), "dataUrl из FileReader");
  eq(f.text, "Изображение: pic.png", "текст-заглушка");
  assert(f.size > 0, "размер от реального файла");
  const row = document.getElementById("batch-list").children[0];
  assert(!row.querySelector(".batch-preview-btn"), "у image-файла нет инлайн-превью (👁)");
  const thumb = row.querySelector(".batch-thumb");
  assert(thumb, "миниатюра в строке");
  thumb.fire("mouseenter");
  const tip = document.body.querySelector(".dist-tip");
  assert(tip && !tip.classList.contains("hidden"), "hover-тултип виден");
  assert(tip.querySelector("img.tip-img"), "в тултипе увеличенная картинка");
  thumb.fire("mouseleave");
  assert(tip.classList.contains("hidden"), "тултип скрыт при уходе курсора");
  thumb.fire("click");
  assert(lightbox.isLightboxOpen(), "клик по миниатюре открыл лайтбокс");
  assert(tip.classList.contains("hidden"), "hover-тултип скрыт при открытии лайтбокса");
  lightbox.closeLightbox();
});

test("batch: пресет с image-файлами → payload runBatch с images", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  state.models = [{ key: "cV", label: "Clef V", status: "running", vision: true }];
  state.selectedModels = new Set(["cV"]);
  state.questions = [{ id: "q1", question: "Есть товар?", type: "yes_no", collapsed: true }];
  batch.loadPresetFiles([{ name: "p.png", image: "data:image/png;base64,QUJD" }]);
  assert(state.batch.files[0].isImage, "image-файл из пресета");
  let captured = null;
  let uploaded = null;
  mockFetch(runApiRoutes({
    onCreate: call => { captured = call.body; },
    onFile: file => {
      uploaded = file;
      return { type: "file", i: file.i, status: "ok", errors: [], duration_s: 1,
        runs: [{ model: "cV", mode: "decisions", ok: true, answers: { q1: ansYesNo(0.8, 0.2) },
          usage: {}, metrics: { duration_s: 1 }, prompt_format_version: 1 }] };
    },
  }));
  await batch.runBatch();
  assert(captured, "run создан");
  eq(uploaded.input, "Изображение: p.png", "input — заглушка");
  eq((uploaded.images || []).join(","), "data:image/png;base64,QUJD", "images в chunk");
  eq(captured.overrides.models.join(","), "cV", "модели");
});

test("batch: файлы с картинками + нет vision-моделей → ошибка до прогона", async () => {
  installDom(); await resetState(); domBatch();
  let err = null;
  batch.initBatch({ showError: (m) => { err = m; } });
  state.models = [{ key: "mA", label: "Qwen A", status: "running", vision: false }];
  state.selectedModels = new Set(["mA"]);
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no", collapsed: true }];
  // image-файл
  batch.loadPresetFiles([{ name: "p.png", image: "data:image/png;base64,QUJD" }]);
  await batch.runBatch();
  includes(err, "не поддерживает", "понятная ошибка (image-файл)");
  eq(state.batch.files[0].status, "pending", "прогон не начался");
  // текстовый файл с прикреплёнными картинками
  err = null;
  batch.loadPresetFiles([{ name: "doc.txt", content: "текст", images: ["data:image/png;base64,QUJD"] }]);
  await batch.runBatch();
  includes(err, "не поддерживает", "понятная ошибка (картинки у файла)");
  eq(state.batch.files[0].status, "pending", "прогон не начался");
});

test("batch: миниатюра в колонке «Файл» — клик открывает лайтбокс, дрилдаун не трогает", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchResults({
    models: [{ key: "cV", label: "Clef V", status: "running", vision: true }],
    questions: [{ id: "q1", question: "Есть товар?", type: "yes_no", collapsed: true }],
    files: [
      {
        name: "p.png", image: "data:image/png;base64,QUJD",
        results: { cV: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }) },
      },
      {
        name: "r.txt", content: "резюме",
        results: { cV: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.8, 0.2) }) },
      },
    ],
  });
  const ths = document.querySelectorAll("#batch-results .batch-file-th");
  eq(ths.length, 2, "две строки файлов");
  const thumb = ths[0].querySelector("img.batch-cell-thumb");
  assert(thumb, "у image-файла миниатюра в колонке «Файл»");
  eq(thumb.src, "data:image/png;base64,QUJD", "src миниатюры");
  assert(!ths[1].querySelector("img.batch-cell-thumb"), "у текстового файла миниатюры нет");
  // hover на миниатюре — тултип-превью
  thumb.fire("mouseenter");
  const tip = document.body.querySelector(".dist-tip");
  assert(tip && !tip.classList.contains("hidden"), "hover-тултип виден");
  assert(tip.querySelector("img.tip-img"), "в тултипе увеличенная картинка");
  // клик по миниатюре — лайтбокс, дрилдаун не открывается
  thumb.fire("click");
  assert(lightbox.isLightboxOpen(), "клик по миниатюре открыл лайтбокс");
  eq(document.body.querySelector(".lightbox-img").src, "data:image/png;base64,QUJD", "src лайтбокса");
  assert(tip.classList.contains("hidden"), "hover-тултип скрыт при открытии лайтбокса");
  const detailRows = document.querySelectorAll("#batch-results .batch-detail-row");
  assert([...detailRows].every(r => r.classList.contains("hidden")), "дрилдауны остались закрыты");
  lightbox.closeLightbox();
  // клик по имени — дрилдаун открывается/закрывается
  const nameSpan = ths[0].querySelector(".batch-file-th-name");
  assert(nameSpan, "имя обёрнуто в span");
  nameSpan.fire("click");
  assert(!detailRows[0].classList.contains("hidden"), "клик по имени открыл дрилдаун");
  // в дрилдауне image-файла — миниатюра вместо инлайн-картинки, клик → лайтбокс
  const dThumb = detailRows[0].querySelector("img.batch-drilldown-thumb");
  assert(dThumb, "миниатюра в дрилдауне вместо инлайн-картинки");
  assert(!detailRows[0].querySelector("img.batch-drilldown-img"), "инлайн-раскрытия картинки нет");
  dThumb.fire("click");
  assert(lightbox.isLightboxOpen(), "клик по миниатюре в дрилдауне открыл лайтбокс");
  lightbox.closeLightbox();
  nameSpan.fire("click");
  assert(detailRows[0].classList.contains("hidden"), "повторный клик закрыл дрилдаун");
});
// ---------------------------------------------------------------- картинки у текстового файла

test("batch: прикрепление картинок к текстовому файлу — до 3, удаление крестиком, hover/превью миниатюры", async () => {
  installDom(); await resetState(); domBatch();
  let err = null;
  batch.initBatch({ showError: (m) => { err = m; } });
  batch.loadPresetFiles([{ name: "doc.txt", content: "текст" }]);
  const f = state.batch.files[0];
  assert(!f.isImage && Array.isArray(f.images) && f.images.length === 0, "images = [] у текстового файла");
  const rowAt = () => document.getElementById("batch-list").children[0];
  const attachBtn = rowAt().querySelector(".batch-attach-btn");
  assert(attachBtn, "кнопка 📎 у текстового файла");
  assert(!attachBtn.disabled, "кнопка активна");
  await batch.attachImagesToFile(f.id, [fakeFile("a.png", "p1"), fakeFile("b.png", "p2")]);
  eq(f.images.length, 2, "две картинки");
  assert(f.images[0].dataUrl.startsWith("data:image/png;base64,"), "dataUrl из FileReader");
  eq(rowAt().querySelectorAll(".batch-file-images .batch-att-thumb").length, 2, "две миниатюры в строке");
  // ✕ файла — крайняя справа: идёт после миниатюр, 📎 и спейсера
  const kids = [...rowAt().children];
  const delIdx = kids.indexOf(rowAt().querySelector(".btn-danger"));
  assert(delIdx === kids.length - 1, "✕ файла последний в строке");
  assert(kids.indexOf(rowAt().querySelector(".batch-file-images")) < kids.indexOf(rowAt().querySelector(".batch-file-spacer")), "миниатюры до спейсера");
  assert(kids.indexOf(rowAt().querySelector(".batch-attach-btn")) < delIdx, "📎 перед ✕");
  await batch.attachImagesToFile(f.id, [fakeFile("c.png", "p3")]);
  eq(f.images.length, 3, "три картинки");
  assert(rowAt().querySelector(".batch-attach-btn").disabled, "при 3 кнопка disabled");
  await batch.attachImagesToFile(f.id, [fakeFile("d.png", "p4")]);
  eq(f.images.length, 3, "4-я не прикреплена");
  includes(err, "не больше", "ошибка о лимите");
  // удаление крестиком; миниатюра — hover-тултип и превью
  const pic = rowAt().querySelector(".batch-att-thumb img");
  pic.fire("mouseenter");
  const tip = document.body.querySelector(".dist-tip");
  assert(tip && tip.querySelector("img.tip-img"), "hover — картинка в тултипе");
  pic.fire("mouseleave");
  pic.fire("click");
  assert(preview.isPreviewOpen() || lightbox.isLightboxOpen(), "клик по миниатюре открыл превью");
  lightbox.closeLightbox();
  rowAt().querySelectorAll(".batch-att-remove")[0].fire("click");
  eq(f.images.length, 2, "картинка удалена");
  eq(f.images[0].name, "b.png", "остались вторая и третья");
  eq(rowAt().querySelectorAll(".batch-att-thumb").length, 2, "миниатюра удалена из DOM");
});

test("batch: прикрепление — не-картинки отфильтровываются; у image-файла 📎 нет и attach — no-op", async () => {
  installDom(); await resetState(); domBatch();
  let err = null;
  batch.initBatch({ showError: (m) => { err = m; } });
  batch.loadPresetFiles([{ name: "doc.txt", content: "текст" }]);
  const f = state.batch.files[0];
  await batch.attachImagesToFile(f.id, [fakeFile("notes.txt", "не картинка")]);
  eq(f.images.length, 0, "текстовый файл не прикреплён");
  eq(err, null, "и без ошибки");
  // у image-файла кнопки 📎 нет, attach — no-op
  batch.loadPresetFiles([{ name: "p.png", image: "data:image/png;base64,QUJD" }]);
  const fi = state.batch.files[0];
  const row = document.getElementById("batch-list").children[0];
  assert(!row.querySelector(".batch-attach-btn"), "у image-файла нет 📎");
  await batch.attachImagesToFile(fi.id, [fakeFile("a.png", "p1")]);
  assert(!fi.images, "к image-файлу ничего не прикреплено");
});

test("batch: текстовый файл с картинками — payload с images и vision-фильтр моделей", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  state.models = [
    { key: "mA", label: "Qwen A", status: "running", vision: false },
    { key: "cV", label: "Clef V", status: "running", vision: true },
  ];
  state.selectedModels = new Set(["mA", "cV"]);
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no", collapsed: true }];
  batch.loadPresetFiles([
    { name: "doc.txt", content: "текст", images: ["data:image/png;base64,QUJD", "data:image/png;base64,REVG"] },
    { name: "plain.txt", content: "просто текст" },
  ]);
  const uploaded = [];
  let created = null;
  const calls = mockFetch(runApiRoutes({
    onCreate: call => { created = call.body; },
    onFile: (file, create) => {
      uploaded.push(file);
      const models = file.images?.length ? ["cV"] : create.overrides.models;
      return { type: "file", i: file.i, status: "ok", errors: [], duration_s: 1,
        runs: models.map(model => ({ model, mode: "decisions", ok: true,
          answers: { q1: ansYesNo(0.8, 0.2) }, usage: {}, metrics: { duration_s: 1 }, prompt_format_version: 1 })) };
    },
  }));
  await batch.runBatch();
  eq(calls.filter(call => call.key === "POST /api/run").length, 1, "один job для смешанного пакета");
  eq((uploaded[0].images || []).join(","), "data:image/png;base64,QUJD,data:image/png;base64,REVG", "images в chunk");
  eq(uploaded[0].input, "текст", "input — текст файла, не заглушка");
  assert(!("images" in uploaded[1]), "у файла без картинок images нет");
  eq(created.overrides.models.join(","), "mA,cV", "job сохраняет обе модели");
  const firstId = state.batch.files[0].id;
  const secondId = state.batch.files[1].id;
  eq(Object.keys(state.batch.results[firstId]).join(","), "cV", "server event пропустил non-vision для картинки");
  eq(Object.keys(state.batch.results[secondId]).sort().join(","), "cV,mA", "обе модели у текстового файла");
});

test("batch: миниатюры прикреплённых картинок в колонке «Файл» и в дрилдауне", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchResults({
    models: [{ key: "cV", label: "Clef V", status: "running", vision: true }],
    questions: [{ id: "q1", question: "Q?", type: "yes_no", collapsed: true }],
    files: [{
      name: "r.txt", content: "резюме", images: ["data:image/png;base64,QUJD"],
      results: { cV: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }) },
    }],
  });
  const th = document.querySelector("#batch-results .batch-file-th");
  const thumb = th.querySelector("img.batch-cell-thumb");
  assert(thumb, "миниатюра в колонке «Файл» у текстового файла с картинками");
  eq(thumb.src, "data:image/png;base64,QUJD", "src миниатюры");
  thumb.fire("click");
  assert(lightbox.isLightboxOpen(), "клик по миниатюре открыл лайтбокс");
  lightbox.closeLightbox();
  th.querySelector(".batch-file-th-chevron").fire("click");
  const detail = document.querySelector("#batch-results .batch-detail-row");
  assert(!detail.classList.contains("hidden"), "дрилдаун открыт");
  assert(detail.querySelector(".batch-preview-text"), "в дрилдауне превью текста");
  const dThumbs = detail.querySelectorAll(".batch-drilldown-images img.batch-drilldown-thumb");
  eq(dThumbs.length, 1, "в дрилдауне миниатюра прикреплённой картинки");
  dThumbs[0].fire("click");
  assert(lightbox.isLightboxOpen(), "клик по миниатюре в дрилдауне — лайтбокс");
  lightbox.closeLightbox();
});

test("batch: экспорт/импорт и пресет с images — round-trip", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  batch.loadPresetFiles([
    { name: "doc.txt", content: "текст", images: ["data:image/png;base64,QUJD"] },
    { name: "plain.txt", content: "без картинок" },
  ]);
  const snap = batch.batchFilesSnapshot();
  eq(snap[0].images.join(","), "data:image/png;base64,QUJD", "images в снапшоте");
  assert(!("images" in snap[1]), "у файла без картинок images не экспортируется");
  batch.loadPresetFiles(snap);
  eq(state.batch.files[0].images.length, 1, "картинка восстановлена");
  eq(state.batch.files[0].images[0].dataUrl, "data:image/png;base64,QUJD", "dataUrl на месте");
  eq(state.batch.files[1].images.length, 0, "у plain-файла images пуст");
  // пресет: из 4 картинок берутся только первые 3
  batch.loadPresetFiles([{
    name: "many.txt", content: "x",
    images: ["data:1", "data:2", "data:3", "data:4"],
  }]);
  eq(state.batch.files[0].images.length, 3, "пресет обрезан до 3 картинок");
});

function setupBatchResults({ models, questions, files }) {
  state.models = models;
  state.questions = questions;
  batch.loadPresetFiles(files.map(f => ({ name: f.name, content: f.content, image: f.image, images: f.images })));
  state.batch.files.forEach((f, i) => {
    f.status = "ok";
    state.batch.results[f.id] = files[i].results;
    state.batch.durations[f.id] = 1;
  });
  batch.renderBatchResults();
}

const Q_LONG = "Есть ли в резюме конкретные цифры достижений?";
const Q_SHORT = "Кандидат подходит?";

test("batch: плейсхолдер результатов — виден без результатов, исчезает при первых", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  const res = document.getElementById("batch-results");
  const empty = () => res.querySelector(".results-empty");
  assert(empty(), "плейсхолдер на пустом батче");
  includes(empty().textContent, "Запустите прогон", "текст плейсхолдера");
  // файлы без результатов — плейсхолдер остаётся
  batch.loadPresetFiles([{ name: "a.txt", content: "текст" }]);
  assert(empty(), "файлы без результатов — плейсхолдер остаётся");
  // первые результаты — плейсхолдер исчезает
  setupBatchResults({
    models: [{ key: "mA", label: "Qwen A", status: "running" }],
    questions: [{ id: "q1", question: "Есть цифры?", type: "yes_no", collapsed: true }],
    files: [{ name: "a.txt", content: "текст", results: { mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }) } }],
  });
  assert(!empty(), "с результатами плейсхолдера нет");
  // очистка — плейсхолдер возвращается, decision и таймеры тоже сброшены
  state.batch.decision = { enabled: true, outcomes: [{ id: "old", label: "Old", rules: [] }] };
  state.batch.startedAt = 10;
  state.batch.finishedAt = 20;
  batch.resetBatch();
  assert(empty(), "после очистки плейсхолдер снова виден");
  eq(state.batch.decision, null, "resetBatch очищает decision");
  eq(state.batch.startedAt, null, "resetBatch очищает startedAt");
  eq(state.batch.finishedAt, null, "resetBatch очищает finishedAt");
});

test("batch: колонка «Решение» — тумблер enabled, hover-объяснение, CSV без колонки", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  const qs = [{ id: "q1", question: "Есть цифры?", type: "yes_no", collapsed: true }];
  setupBatchResults({
    models: [{ key: "mA", label: "Qwen A", status: "running" }],
    questions: qs,
    files: [{ name: "r1.txt", content: "резюме",
      results: { mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }) } }],
  });
  const theadText = () => document.querySelector("#batch-results table thead").textContent;
  notIncludes(theadText(), "Решение", "без правил колонки нет");
  const d = { outcomes: [
    { id: "o1", label: "Опубликовать", color: "green", rules: [{ anyOf: false, conditions: [
      { question: "q1", answer: "yes", op: "gte", threshold: 0.8 }] }] },
  ] };
  const csvRows = () => [{ file: state.batch.files[0], perModel: state.batch.results[state.batch.files[0].id] }];
  // включённое решение: колонка, бейдж с hover-объяснением, CSV с колонкой
  state.batch.decision = d;
  batch.renderBatchResults();
  includes(theadText(), "Решение", "колонка появилась");
  const badge = document.querySelector("#batch-results .batch-decision-cell .decision-chip");
  eq(badge.textContent, "Опубликовать", "бейдж исхода");
  eq(badge.title, "", "нативного title нет");
  badge.fire("mouseenter");
  const tip = document.body.querySelector(".dist-tip");
  includes(tip.textContent, "Исход: Опубликовать", "заголовок объяснения");
  includes(tip.textContent, "✓ №1 «Есть цифры?» → «да» 90% при пороге ≥ 80%", "условие: факт vs порог");
  badge.fire("mouseleave");
  includes(batch.buildBatchCsv(csvRows(), qs), "решение", "CSV с колонкой решения");
  includes(batch.buildBatchCsv(csvRows(), qs), "Опубликовать", "CSV со значением");
  // разметка: +2 колонки ячейки всегда, +2 решения при включённом решении
  const fid0 = state.batch.files[0].id;
  review.setVerdict("batch", { scope: "batch", file: fid0, question: "q1", model: "mA" }, "reject");
  review.setComment("batch", { scope: "batch", file: fid0, question: "q1", model: "mA" }, "ложное срабатывание");
  review.setVerdict("batch", { scope: "batch", file: fid0, model: "mA", decision: true }, "unsure");
  const csvM = batch.buildBatchCsv(csvRows(), qs);
  includes(csvM, "отметка,комментарий,отметка_решения,комментарий_решения", "колонки разметки в CSV");
  includes(csvM, "Опубликовать,ошибка,ложное срабатывание,спорно,", "значения разметки в строке CSV");
  // JSON-экспорт: marks с именем файла и текстом вопроса (читается без состояния)
  let captured = null;
  globalThis.URL.createObjectURL = (blob) => { captured = blob.content; return "blob:x"; };
  [...document.querySelectorAll("#batch-results .batch-export-row .btn")]
    .find(b => b.textContent === "Экспорт JSON").click();
  const dump = JSON.parse(captured);
  eq(dump.decisions["r1.txt"].mA.id, "o1", "decision outcome id сохранён в JSON dump");
  eq(dump.decisions["r1.txt"].mA.label, "Опубликовать", "прежний label сохранён");
  eq(dump.marks.length, 2, "обе пометки в JSON");
  eq(dump.marks[0].target.file, "r1.txt", "target.file — имя файла");
  eq(dump.marks[0].target.question_text, "Есть цифры?", "target дополнен текстом вопроса");
  // выключенный тумблер: ни колонки, ни бейджа, ни CSV-колонки
  state.batch.decision = { ...d, enabled: false };
  batch.renderBatchResults();
  notIncludes(theadText(), "Решение", "enabled:false — колонка скрыта");
  assert(!document.querySelector("#batch-results .batch-decision-cell"), "бейджа нет");
  notIncludes(batch.buildBatchCsv(csvRows(), qs), "решение", "CSV без колонки");
});

test("batch: шапка таблицы — вопрос-major при 2+ моделях, плоская при одной", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchResults({
    models: [
      { key: "mA", label: "Qwen A 27B", short_label: "AA", status: "running" },
      { key: "mB", label: "Qwen B 35B", short_label: "BB", status: "running" },
    ],
    questions: [
      { id: "q1", question: Q_LONG, type: "yes_no", collapsed: true },
      { id: "q2", question: Q_SHORT, type: "yes_no", collapsed: true },
    ],
    files: [{
      name: "r1.txt", content: "резюме",
      results: {
        mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1), q2: ansYesNo(0.3, 0.7) }),
        mB: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.2, 0.8), q2: ansYesNo(0.6, 0.4) }),
      },
    }],
  });
  const thead = document.querySelector("#batch-results table thead");
  eq(thead.children.length, 2, "две строки шапки");
  const top = thead.children[0].children;
  eq(top[0].textContent, "Файл", "угол — файл");
  eq(top[0].rowSpan, 2, "файл на две строки");
  eq(top[1].textContent, Q_LONG.slice(0, 24) + "…", "вопрос 1 обрезан до 24 с многоточием");
  eq(top[1].title, Q_LONG, "полный вопрос в title");
  eq(top[1].colSpan, 2, "вопрос 1 на две модели");
  eq(top[2].textContent, Q_SHORT, "вопрос 2 целиком");
  eq(top[2].colSpan, 2, "вопрос 2 на две модели");
  const sub = [...thead.children[1].children].map(th => th.textContent);
  eq(sub.join(","), "AA,BB,AA,BB", "под каждым вопросом — все модели");
  // тело: ячейки файла сгруппированы по вопросам (q1: mA,mB; q2: mA,mB)
  const row = document.querySelector("#batch-results tbody tr");
  const cells = [...row.querySelectorAll(".batch-cell .batch-cell-answer")].map(td => td.textContent.trim());
  eq(cells.join("|"), "да · 90%|нет · 80%|нет · 70%|да · 60%", "порядок ячеек вопрос-major");
  // итого — под каждой парой вопрос×модель в том же порядке
  const agg = [...document.querySelector("#batch-results .batch-agg-row").children];
  eq(agg.length, 5, "файл + 4 агрегата");
  eq(agg[1].textContent, "да в 100%", "агрегат q1×mA");
  eq(agg[2].textContent, "да в 0%", "агрегат q1×mB");
  eq(agg[3].textContent, "да в 0%", "агрегат q2×mA");
  eq(agg[4].textContent, "да в 100%", "агрегат q2×mB");
  // при одной модели — плоская шапка
  state.models = [{ key: "mA", label: "Qwen A", status: "running" }];
  for (const fid of Object.keys(state.batch.results)) {
    state.batch.results[fid] = { mA: state.batch.results[fid].mA };
  }
  batch.renderBatchResults();
  const thead1 = document.querySelector("#batch-results table thead");
  eq(thead1.children.length, 1, "одна строка шапки");
  const heads = [...thead1.children[0].children].map(th => th.textContent);
  eq(heads[0], "Файл", "первый столбец — файл");
  eq(heads[1], Q_LONG.slice(0, 40) + "…", "вопрос 1 в плоской шапке с многоточием");
  eq(heads[2], Q_SHORT, "вопрос 2 в плоской шапке");
});

test("batch: чипсы моделей переключают колонки и шапку; ⓘ — поповер статистики", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchResults({
    models: [
      { key: "mA", label: "Qwen A 27B", short_label: "AA", status: "running" },
      { key: "mB", label: "Qwen B 35B", short_label: "BB", status: "running" },
    ],
    questions: [{ id: "q1", question: "Есть цифры?", type: "yes_no", collapsed: true }],
    files: [
      { name: "r1.txt", content: "резюме", results: {
        mA: runRes({ duration_s: 2, prompt_tokens: 100, prefill_tok_s: 50, rss_gb: 10.5, label_mass_min: 0.4 }, { q1: ansYesNo(0.9, 0.1) }),
        mB: runRes({ duration_s: 1, prompt_tokens: 200, prefill_tok_s: 80 }, { q1: ansYesNo(0.3, 0.7) }),
      } },
      { name: "r2.txt", content: "резюме 2", results: {
        mA: runRes({ duration_s: 4, prompt_tokens: 300, prefill_tok_s: 70, rss_gb: 11.5, label_mass_min: 0.7 }, { q1: ansYesNo(0.8, 0.2) }),
      } },
    ],
  });
  const chips = () => [...document.querySelectorAll("#batch-results .batch-model-chip")];
  const theadRows = () => document.querySelector("#batch-results table thead").children.length;
  // нативного select больше нет, по умолчанию все чипсы активны
  assert(!document.querySelector("#batch-results select"), "нативного select нет");
  eq(chips().length, 2, "два чипса моделей");
  assert(chips().every(c => !c.classList.contains("off")), "по умолчанию все включены");
  eq(chips()[0].title, "Qwen A 27B", "полное имя в title");
  includes(chips()[0].textContent, "AA", "короткое имя на чипсе");
  eq(theadRows(), 2, "вопрос-major шапка при двух моделях");
  // клик по чипсу mB выключает его: одна колонка, плоская шапка
  chips()[1].fire("click");
  eq(chips().length, 2, "чипсы на месте после перерендера");
  assert(chips()[1].classList.contains("off"), "чипс mB выключен");
  eq(theadRows(), 1, "плоская шапка при одной видимой модели");
  const cells = [...document.querySelectorAll("#batch-results tbody tr .batch-cell")];
  eq(cells.length, 2, "по одной ячейке на файл (только mA)");
  assert(cells.every(c => includes(c.textContent, "да") || true), "ячейки mA");
  notIncludes(document.querySelector("#batch-results tbody").textContent, "нет · 70%", "ответов mB нет");
  // повторный клик включает обратно
  chips()[1].fire("click");
  assert(!chips()[1].classList.contains("off"), "чипс mB снова включён");
  eq(theadRows(), 2, "шапка снова вопрос-major");
  // выключить обе — вместо таблицы подсказка
  chips()[0].fire("click");
  chips()[1].fire("click");
  assert(!document.querySelector("#batch-results table"), "таблицы нет без видимых моделей");
  includes(document.getElementById("batch-results").textContent, "Все модели скрыты", "подсказка видна");
  chips()[0].fire("click");
  chips()[1].fire("click");
  eq(theadRows(), 2, "таблица восстановлена");
  // поповер статистики по ⓘ: mA обработал 2 файла из 2
  const info = chips()[0].querySelector(".batch-model-chip-info");
  assert(info, "иконка ⓘ на чипсе");
  info.fire("click");
  const pop = document.body.querySelector(".batch-model-popover");
  assert(pop && !pop.classList.contains("hidden"), "поповер открыт");
  includes(pop.textContent, "Qwen A 27B", "имя модели в поповере");
  includes(pop.textContent, "файлов обработано: 2 из 2", "файлы mA");
  includes(pop.textContent, "ток/с", "скорость в поповере");
  includes(pop.textContent, "суммарные токены промптов: 400", "сумма токенов mA");
  // время — серверное (metrics.duration_s 2 и 4 → среднее 3.0), а не клиентский таймер (1 с)
  includes(pop.textContent, "среднее время на файл: 3.0 с", "серверное время в поповере");
  includes(pop.textContent, "память сервера: 11.0 ГБ", "средний rss в поповере");
  includes(pop.textContent, "худшая доля на вариантах: 40%", "min label_mass по прогонам");
  // повторный клик по ⓘ закрывает
  info.fire("click");
  assert(pop.classList.contains("hidden"), "повторный клик закрыл поповер");
  // поповер mB: 1 файл из 2; клик вне закрывает
  chips()[1].querySelector(".batch-model-chip-info").fire("click");
  includes(pop.textContent, "файлов обработано: 1 из 2", "файлы mB");
  document.dispatchEvent({ type: "click", target: document.body });
  assert(pop.classList.contains("hidden"), "клик вне закрыл поповер");
});

test("batch: ховер на ячейке — тултип распределения, скрытие и перерендер", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchResults({
    models: [{ key: "mA", label: "Qwen A", status: "running" }],
    questions: [{ id: "q1", question: "Есть цифры?", type: "yes_no", collapsed: true }],
    files: [{
      name: "r1.txt", content: "резюме",
      results: {
        mA: runRes({ duration_s: 1, prompt_tokens: 10 }, {
          q1: { type: "yes_no", probabilities: { yes: 0.6, no: 0.4 }, label_mass: 0.3 },
        }),
      },
    }],
  });
  const cell = document.querySelector("#batch-results .batch-cell");
  assert(cell, "ячейка есть");
  cell.fire("mouseenter");
  const tip = document.body.querySelector(".dist-tip");
  assert(tip && !tip.classList.contains("hidden"), "тултип виден");
  includes(tip.textContent, "Да", "полоса «Да»");
  includes(tip.textContent, "Нет", "полоса «Нет»");
  includes(tip.textContent, "Ответ: да · 60%", "полный ответ");
  includes(tip.textContent, "⚠", "предупреждение о доле на вариантах < 0.5");
  cell.fire("mouseleave");
  assert(tip.classList.contains("hidden"), "тултип скрыт при уходе курсора");
  cell.fire("mouseenter");
  assert(!tip.classList.contains("hidden"), "тултип снова открыт");
  batch.renderBatchResults();
  assert(tip.classList.contains("hidden"), "тултип скрыт при перерендере");
});

test("batch: ячейка score маркируется по direction (up/down), neutral — только conf-*", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  const ans = (score) => ({
    type: "score", score, probabilities: { 0: 0.05, 1: 0.1, 2: 0.85 }, label_mass: 0.99,
  });
  setupBatchResults({
    models: [{ key: "mA", label: "Qwen A", status: "running" }],
    questions: [
      { id: "q1", question: "Качество?", type: "score", levels: ["плохо", "средне", "хорошо"], direction: "up", collapsed: true },
      { id: "q2", question: "Риск?", type: "score", levels: ["низкий", "средний", "высокий"], direction: "down", collapsed: true },
      { id: "q3", question: "Нейтральный?", type: "score", levels: ["а", "б", "в"], direction: "neutral", collapsed: true },
    ],
    files: [{
      name: "r1.txt", content: "резюме",
      results: { mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ans(2), q2: ans(2), q3: ans(2) }) },
    }],
  });
  const cells = [...document.querySelectorAll("#batch-results .batch-cell-answer")];
  eq(cells.length, 3, "три ячейки ответов");
  assert(cells[0].classList.contains("dir-good"), "up + высокий score → dir-good");
  assert(cells[0].className.includes("conf-"), "conf-класс сохранён рядом с dir-*");
  includes(cells[0].style.background, "hsla(120,", "up + высокий score → зелёный inline-фон");
  assert(cells[1].classList.contains("dir-bad"), "down + высокий score → dir-bad");
  includes(cells[1].style.background, "hsla(0,", "down + высокий score → красный inline-фон");
  assert(!cells[2].className.includes("dir-"), "neutral → без dir-класса");
  assert(!cells[2].style.background, "neutral → без inline-подсветки");
  assert(cells[2].className.includes("conf-"), "neutral — только conf-класс");
});

test("batch: дрилдаун файла содержит сворачиваемое превью текста", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchResults({
    models: [{ key: "mA", label: "Qwen A", status: "running" }],
    questions: [{ id: "q1", question: "Есть цифры?", type: "yes_no", collapsed: true }],
    files: [{
      name: "big.txt", content: "абв".repeat(1000), // 3000 символов
      results: { mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.8, 0.2) }) },
    }],
  });
  document.querySelector("#batch-results .batch-file-th-chevron").fire("click");
  const detail = document.querySelector("#batch-results .batch-detail-row");
  assert(!detail.classList.contains("hidden"), "дрилдаун открыт");
  const preview = detail.querySelector(".batch-detail-preview");
  assert(preview, "превью в дрилдауне");
  const pre = preview.querySelector(".batch-preview-text");
  eq(pre.textContent.length, 2001, "первые 2000 символов + …");
  const more = preview.querySelector(".batch-preview-more");
  assert(more, "кнопка «развернуть» есть");
  more.fire("click");
  eq(pre.textContent.length, 3000, "полный текст после «развернуть»");
  // сворачивание по заголовку
  preview.querySelector(".batch-detail-preview-toggle").fire("click");
  assert(pre.classList.contains("hidden"), "превью свёрнуто");
});

test("batch: дрилдаун файла — метрики прогона под заголовком, ошибка модели не проглатывается", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  setupBatchResults({
    models: [
      { key: "mA", label: "Qwen A", status: "running" },
      { key: "mB", label: "Qwen B", status: "running" },
    ],
    questions: [{ id: "q1", question: "Есть цифры?", type: "yes_no", collapsed: true }],
    files: [{
      name: "r1.txt", content: "резюме",
      results: {
        mA: runRes({ duration_s: 2, prompt_tokens: 120 }, { q1: ansYesNo(0.8, 0.2) }),
        mB: { ok: false, error: "HTTP 500: boom" },
      },
    }, {
      name: "r2.txt", content: "резюме 2",
      results: { mB: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.6, 0.4) }) },
    }],
  });
  document.querySelector("#batch-results .batch-file-th-chevron").fire("click");
  const detail = document.querySelector("#batch-results .batch-detail-row");
  assert(!detail.classList.contains("hidden"), "дрилдаун открыт");
  const titles = [...detail.querySelectorAll(".batch-detail-model-title")];
  eq(titles.filter(t => t.textContent === "Qwen B").length, 1, "блок ошибочной модели показан");
  const err = detail.querySelector(".batch-detail-error");
  assert(err, "строка ошибки в дрилдауне");
  includes(err.textContent, "HTTP 500: boom", "текст ошибки");
  const metrics = detail.querySelector(".batch-detail-metrics");
  assert(metrics, "строка метрик прогона");
  includes(metrics.textContent, "2.0 с", "время прогона");
  includes(metrics.textContent, "120 ток", "токены промпта");
});

test("batch: панели — ⛶/— тогглят классы, restore-таб и Esc возвращают", async () => {
  installDom(); await resetState(); domBatch();
  batch.initBatch({});
  const split = document.getElementById("split-batch");
  const fsL = split.querySelector('.icon-btn[data-panel="left"][data-action="fullscreen"]');
  fsL.fire("click");
  assert(split.classList.contains("focus-left"), "focus-left включён");
  fsL.fire("click");
  assert(!split.classList.contains("focus-left"), "focus-left выключен повторным кликом");
  split.querySelector('.icon-btn[data-panel="right"][data-action="collapse"]').fire("click");
  assert(split.classList.contains("collapsed-right"), "правая панель свёрнута");
  assert(!document.getElementById("batch-restore-right").classList.contains("hidden"), "таб возврата виден");
  document.getElementById("batch-restore-right").fire("click");
  assert(!split.classList.contains("collapsed-right"), "таб вернул панель");
  split.querySelector('.icon-btn[data-panel="right"][data-action="fullscreen"]').fire("click");
  assert(split.classList.contains("focus-right"), "focus-right включён");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!split.classList.contains("focus-right"), "Esc снял фокус");
});
