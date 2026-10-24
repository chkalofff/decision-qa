// Доменные тесты: review (разметка результатов прогонов). Общие фикстуры —
// harness.mjs. initReview() перевешивает document-обработчики после installDom;
// resetReview() чистит модульное состояние (undo, парковка, поповер, фильтры).

import {
  test, assert, eq, includes, notIncludes, installDom, resetState, mockFetch, sleep,
  domResults, domBatch, domToolbar, runApiRoutes, ansYesNo, runRes, state, results, questions, batch, review,
} from "./harness.mjs";
import { openHelp, closeHelp } from "../static/help.js";
import { askAppendOrReplace } from "../static/rerun.js";

const cell1 = { scope: "single", model: "mA", mode: "decisions", question: "q1" };

// Прямой потомок элемента с заданным классом (fake-DOM не умеет :scope).
function child(el, cls) {
  return [...el.children].find(c => c.classList && c.classList.contains(cls)) || null;
}

// Одиночный прогон: 1 модель, 2 вопроса (режим A).
function setupSingleA() {
  state.models = [{ key: "mA", label: "Qwen A", status: "running" }];
  state.results = {
    results: {
      mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1), q2: ansYesNo(0.2, 0.8) }),
    },
    order: ["mA"], runMode: "decisions",
    questions: [
      { id: "q1", question: "Спам?", type: "yes_no" },
      { id: "q2", question: "Есть цифры?", type: "yes_no" },
    ],
  };
  state.resultsMeta = { fingerprint: "fp" };
}

// Сравнение двух прогонов (режим B).
function setupSingleB() {
  state.models = [
    { key: "mA", label: "Qwen A 27B", status: "running" },
    { key: "mB", label: "Qwen B 9B", status: "running" },
  ];
  state.results = {
    results: {
      mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }),
      mB: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.2, 0.8) }),
    },
    order: ["mA", "mB"], runMode: "decisions",
    questions: [{ id: "q1", question: "Спам?", type: "yes_no" }],
  };
  state.resultsMeta = { fingerprint: "fp" };
}

// Пакет: 2 файла × 1 вопрос × 2 модели (mB расходится на файле 1).
function setupBatch() {
  state.models = [
    { key: "mA", label: "Qwen A 27B", status: "running" },
    { key: "mB", label: "Qwen B 9B", status: "running" },
  ];
  state.questions = [{ id: "q1", question: "Спам?", type: "yes_no", collapsed: true }];
  batch.loadPresetFiles([{ name: "a.txt", content: "первый" }, { name: "b.txt", content: "второй" }]);
  const [f1, f2] = state.batch.files;
  f1.status = f2.status = "ok";
  state.batch.results[f1.id] = {
    mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.9, 0.1) }),
    mB: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.2, 0.8) }),
  };
  state.batch.results[f2.id] = {
    mA: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.8, 0.2) }),
    mB: runRes({ duration_s: 1, prompt_tokens: 10 }, { q1: ansYesNo(0.7, 0.3) }),
  };
  batch.renderBatchResults();
  return { f1, f2 };
}

// ================================================================ данные

test("review: ключи целей — фиксированный формат по уровням", async () => {
  await resetState();
  eq(review.targetKey({ scope: "single", model: "m", mode: "decisions" }), "single|run|m|decisions", "прогон");
  eq(review.targetKey(cell1), "single|cell|mA|decisions|q1", "ответ (одиночный)");
  eq(review.targetKey({ scope: "single", question: "q1" }), "single|q|q1", "строка вопроса (B)");
  eq(review.targetKey({ scope: "single", model: "m", mode: "clef", decision: true }), "single|dec|m|clef", "решение (одиночный)");
  eq(review.targetKey({ scope: "batch", model: "m" }), "batch|model|m", "модель в пакете");
  eq(review.targetKey({ scope: "batch", file: "f1" }), "batch|file|f1", "файл");
  eq(review.targetKey({ scope: "batch", file: "f1", question: "q1", model: "m" }), "batch|cell|f1|q1|m", "ячейка пакета");
  eq(review.targetKey({ scope: "batch", file: "f1", model: "m", decision: true }), "batch|dec|f1|m", "решение пакета");
});

test("review: CRUD — создание, перезапись вердикта, toggle, заметка без вердикта, поля записи", async () => {
  installDom(); await resetState(); domResults();
  review.resetReview();
  setupSingleA();

  // создание
  const m = review.setVerdict("single", cell1, "reject");
  eq(m.verdict, "reject");
  assert(m.id.startsWith("m_"), "id с префиксом m_");
  eq(m.criterion, "correctness", "criterion по умолчанию");
  eq(m.author, "local", "author");
  assert(m.created_at && m.updated_at, "таймстампы");
  eq(state.results.marks.length, 1, "пометка в state.results.marks");

  // перезапись вердикта бампит updated_at
  const created = m.created_at;
  m.updated_at = "2000-01-01T00:00:00.000Z"; // контролируем сравнение
  const m2 = review.setVerdict("single", cell1, "accept");
  eq(state.results.marks.length, 1, "всё ещё одна пометка на цель");
  eq(m2.verdict, "accept", "вердикт перезаписан");
  eq(m2.created_at, created, "created_at не тронут");
  assert(m2.updated_at > "2000-01-01", "updated_at обновлён");

  // toggle: повторный клик по активному вердикту снимает пометку
  review.setVerdict("single", cell1, "accept");
  eq(state.results.marks.length, 0, "toggle снял пометку");

  // комментарий без вердикта — «заметка»
  const note = review.setComment("single", cell1, "посмотреть позже");
  eq(note.verdict, null, "заметка без вердикта");
  eq(note.comment, "посмотреть позже");
  // toggle вердикта у пометки с комментарием оставляет заметку
  review.setVerdict("single", cell1, "reject");
  review.setVerdict("single", cell1, "reject");
  eq(state.results.marks.length, 1, "пометка осталась");
  eq(review.findMark("single", cell1).verdict, null, "вердикт снят, комментарий на месте");
  // очистка комментария у заметки удаляет её
  review.setComment("single", cell1, "");
  eq(state.results.marks.length, 0, "пустая заметка удалена");
  // removeMark
  review.setVerdict("single", cell1, "unsure");
  review.removeMark("single", cell1);
  eq(state.results.marks.length, 0, "removeMark удалил");
  // sanitizeMarks: битые записи импорта отбрасываются
  const clean = review.sanitizeMarks([
    { target: { scope: "single", model: "mA", mode: "decisions", question: "q1" }, verdict: "reject", comment: "x" },
    { target: { scope: "single" }, verdict: "bogus" },
    { target: { scope: "batch", file: "f" }, verdict: "accept" }, // чужой scope
    "мусор",
  ], "single");
  eq(clean.length, 1, "только валидная пометка прошла");
});

test("review: счётчики — X из Y по целям страницы, заметки в 💬, сироты исключены", async () => {
  installDom(); await resetState(); domResults(); domBatch(); domToolbar();
  review.resetReview();
  // режим B: 2 вопроса? нет — 1 вопрос × 2 прогона = 2 ячейки + 1 строка + 2 прогона = 5 целей
  setupSingleB();
  review.setVerdict("single", cell1, "reject");
  review.setComment("single", { scope: "single", question: "q1" }, "спорная формулировка");
  review.setVerdict("single", { scope: "single", model: "mA", mode: "decisions" }, "accept");
  // сирота: модель не из прогона — не считается нигде
  state.results.marks.push({
    id: "m_orph", target: { scope: "single", model: "gone", mode: "decisions" },
    verdict: "reject", comment: "", criterion: "correctness", author: "local",
    created_at: "x", updated_at: "x",
  });
  const c = review.counts("single");
  eq(c.total, 5, "Y: 2 ячейки + строка вопроса + 2 прогона");
  eq(c.reject, 1); eq(c.unsure, 0); eq(c.accept, 1);
  eq(c.comments, 1, "💬 — пометки с комментарием");
  eq(c.marked, 3, "X — цели с пометкой (заметка считается)");

  // пакет: 2 файла × 1 вопрос × 2 модели = 4 ячейки + 2 файла + 2 модели = 8 целей
  const { f1 } = setupBatch();
  review.setVerdict("batch", { scope: "batch", file: f1.id, question: "q1", model: "mA" }, "reject");
  review.setVerdict("batch", { scope: "batch", file: f1.id }, "unsure");
  const cb = review.counts("batch");
  eq(cb.total, 8, "Y пакета: ячейки + файлы + модели");
  eq(cb.marked, 2); eq(cb.reject, 1); eq(cb.unsure, 1);
});

// ================================================================ UI: триада/бейджи

test("review: режим A — триада на строке: вердикт одним кликом, без диалогов, toggle, бейдж и кромка", async () => {
  installDom(); await resetState(); domResults();
  review.resetReview(); review.initReview();
  setupSingleA();
  results.renderResults();
  const rows = document.getElementById("results-list").children;
  eq(rows.length, 2, "две строки");
  const triad = rows[0].querySelector(".review-triad");
  assert(triad, "триада в строке");
  assert(triad.classList.contains("review-hover-triad"), "триада — hover-оверлей");
  const badge = rows[0].querySelector(".review-badge");
  assert(badge.classList.contains("hidden"), "без пометки бейджа нет");

  // клик по ✗ — пометка сразу, дрилдаун не открыт, диалогов нет
  triad.querySelector(".review-reject").click();
  eq(review.findMark("single", cell1).verdict, "reject", "пометка в state");
  assert(!rows[0].classList.contains("open"), "дрилдаун не открылся");
  assert(!document.getElementById("saveas-dialog"), "диалогов нет");
  assert(!badge.classList.contains("hidden"), "бейдж виден");
  includes(badge.textContent, "✗", "значок вердикта в бейдже");
  assert(rows[0].classList.contains("review-mk-reject"), "кромка строки");
  assert(triad.querySelector(".review-reject").classList.contains("active"), "активная кнопка триады");

  // toggle — повторный клик по активному вердикту снимает пометку
  triad.querySelector(".review-reject").click();
  eq(review.findMark("single", cell1), null, "пометка снята");
  assert(badge.classList.contains("hidden"), "бейдж скрыт");
  assert(!rows[0].classList.contains("review-mk-reject"), "кромка убрана");

  // пометка продублирована в дрилдауне строки (caption с редактором)
  rows[0].fire("click");
  const detail = document.getElementById("results-list").querySelector(".res-detail");
  const inline = detail.querySelector(".res-detail-caption .review-inline");
  assert(inline, "редактор пометки в дрилдауне");
  inline.querySelector(".review-unsure").click();
  eq(review.findMark("single", cell1).verdict, "unsure", "вердикт из дрилдауна");
});

test("review: режим B — пометки ячеек и строки вопроса; строка комментария и тоггл 👁 разметки", async () => {
  installDom(); await resetState(); domResults(); domBatch();
  review.resetReview(); review.initReview();
  localStorage.removeItem("dq-review-visible");
  setupSingleB();
  results.renderResults();
  const row = document.getElementById("results-list").children[0];
  const cells = row.querySelectorAll(".res-cell");
  eq(cells.length, 2, "две ячейки");

  // пометка ячейки: бейдж-оверлей + рамка, геометрия в потоке не тронута
  cells[1].querySelector(".review-triad .review-reject").click();
  const cellBadge = cells[1].querySelector(".review-badge");
  includes(cellBadge.textContent, "✗", "бейдж ячейки");
  assert(cellBadge.classList.contains("review-badge-cell"), "бейдж ячейки — оверлей");
  assert(cells[1].classList.contains("review-mk-reject"), "рамка ячейки");
  assert(!cells[0].classList.contains("review-mk-reject"), "соседняя ячейка не тронута");

  // пометка строки вопроса (без модели)
  const rowTriad = [...row.children].find(c => c.classList && c.classList.contains("review-triad"));
  rowTriad.querySelector(".review-unsure").click();
  eq(review.findMark("single", { scope: "single", question: "q1" }).verdict, "unsure", "пометка строки");

  // строка комментария видна по умолчанию; тоггл 👁 скрывает разметку глобально
  review.setComment("single", { scope: "single", model: "mB", mode: "decisions", question: "q1" }, "модель не права");
  review.refresh("single");
  const line = row.querySelector(".review-comment-line");
  assert(line && !line.classList.contains("hidden"), "строка комментария по умолчанию видна");
  includes(line.textContent, "модель не права", "текст комментария");
  const visBtn = document.querySelector("#review-bar .review-visibility-toggle");
  assert(visBtn, "тоггл 👁 в тулбаре");
  visBtn.click();
  eq(localStorage.getItem("dq-review-visible"), "0", "тоггл персистится");
  assert(document.getElementById("results-list").classList.contains("review-hidden-all"),
    "скрытие разметки на списке результатов");
  assert(document.getElementById("batch-results").classList.contains("review-hidden-all"),
    "скрытие разметки в батч-результатах");
  assert(row.querySelector(".review-comment-line").classList.contains("hidden"),
    "строка комментария скрыта");
  // повторный клик возвращает разметку; счётчики тулбара живут в обоих состояниях
  includes(document.getElementById("review-bar").textContent, "размечено", "счётчики при скрытой разметке");
  document.querySelector("#review-bar .review-visibility-toggle").click();
  assert(!document.getElementById("results-list").classList.contains("review-hidden-all"), "разметка возвращена");
  includes(document.getElementById("review-bar").textContent, "размечено", "счётчики при показанной разметке");
});

test("review: шапка — счётчики, нулевое состояние, без кнопок undo/💬", async () => {
  installDom(); await resetState(); domResults();
  review.resetReview(); review.initReview();
  setupSingleA();
  results.renderResults();
  const bar = document.getElementById("review-bar");
  assert(bar, "тулбар разметки в шапке");
  includes(bar.textContent, "Разметка: 0 из 3", "нулевое состояние");
  assert(!bar.querySelector(".review-undo"), "кнопки undo в тулбаре нет");
  assert(!bar.querySelector(".review-comments-toggle"), "кнопки 💬 в тулбаре нет");
  assert(bar.querySelector(".review-visibility-toggle"), "тоггл 👁 в тулбаре");

  review.setVerdict("single", cell1, "accept");
  review.setVerdict("single", { scope: "single", model: "mA", mode: "decisions", question: "q2" }, "reject");
  review.setComment("single", cell1, "ок");
  includes(bar.textContent, "✓1", "счётчик ✓");
  includes(bar.textContent, "✗1", "счётчик ✗");
  includes(bar.textContent, "💬1", "счётчик комментариев");
  includes(bar.textContent, "размечено 2 из 3", "прогресс");
});

test("review: hover-триада на чипах — прогоны и решения (single), модель и decision-ячейка (batch)", async () => {
  installDom(); await resetState(); domResults();
  review.resetReview(); review.initReview();
  // single: правила решения → чип решения и чип прогона
  setupSingleA();
  state.results.decision = { outcomes: [
    { id: "o1", label: "Спам", color: "red", rules: [{ anyOf: false, conditions: [
      { question: "q1", answer: "yes", op: "gte", threshold: 0.5 }] }] },
  ] };
  results.renderResults();
  const runChip = document.querySelector("#run-chips .run-chip");
  assert(child(runChip, "review-hover-triad"), "триада на чипе прогона");
  const decChip = document.querySelector("#decision-chips .decision-chip");
  assert(child(decChip, "review-hover-triad"), "триада на чипе решения");
  // клик по кнопке триады не всплывает к чипу (дрилдаун/оверлей не открываются)
  let chipClicked = false;
  runChip.addEventListener("click", () => { chipClicked = true; });
  child(runChip, "review-hover-triad").querySelector(".review-accept").click();
  assert(!chipClicked, "клик по триаде не дошёл до чипа");
  eq(review.findMark("single", { scope: "single", model: "mA", mode: "decisions" }).verdict, "accept",
    "вердикт на прогон из триады чипа");

  // batch: чип модели и ячейка решения
  installDom(); await resetState(); domBatch(); domToolbar();
  review.resetReview(); review.initReview();
  setupBatch();
  state.batch.decision = { outcomes: [
    { id: "o1", label: "Спам", color: "red", rules: [{ anyOf: false, conditions: [
      { question: "q1", answer: "yes", op: "gte", threshold: 0.5 }] }] },
  ] };
  batch.renderBatchResults();
  const modelChip = document.querySelector("#batch-results .batch-model-chip");
  assert(child(modelChip, "review-hover-triad"), "триада на чипсе модели");
  const decTd = document.querySelector("#batch-results .batch-decision-cell");
  assert(child(decTd, "review-hover-triad"), "триада в ячейке решения");
});

// ================================================================ поповер комментария

test("review: поповер комментария — фокус в textarea, сохранение, «Снять пометку», Esc и скролл", async () => {
  installDom(); await resetState(); domResults();
  review.resetReview(); review.initReview();
  setupSingleA();
  results.renderResults();
  const row = document.getElementById("results-list").children[0];

  // открытие по 💬: ≤2 действия от пометки до фокуса в поле ввода
  review.setVerdict("single", cell1, "reject");
  row.querySelector(".review-comment-btn").click();
  assert(review.isPopoverOpen(), "поповер открыт");
  const popEl = document.querySelector(".review-popover");
  includes(popEl.querySelector(".review-pop-context").textContent, "Спам?", "контекст цели");
  includes(popEl.querySelector(".review-pop-meta").textContent, "local", "автор в мете");
  const ta = popEl.querySelector(".review-pop-text");
  eq(document.activeElement, ta, "фокус в textarea");
  ta.value = "Ложное срабатывание";
  // Ctrl+Enter сохраняет и закрывает
  ta.dispatchEvent({ type: "keydown", key: "Enter", ctrlKey: true });
  assert(!review.isPopoverOpen(), "Ctrl+Enter закрыл");
  eq(review.findMark("single", cell1).comment, "Ложное срабатывание", "комментарий сохранён");
  includes(row.querySelector(".review-badge").textContent, "💬1", "бейдж 💬1");

  // смена вердикта в поповере; клик вне — сохраняет
  row.querySelector(".review-badge").click(); // клик по бейджу открывает поповер
  assert(review.isPopoverOpen(), "поповер по бейджу");
  document.querySelector(".review-popover .review-unsure").click();
  eq(review.findMark("single", cell1).verdict, "unsure", "вердикт сменился в поповере");
  document.dispatchEvent({ type: "click", target: document.body });
  assert(!review.isPopoverOpen(), "клик вне закрыл");

  // Esc закрывает поповер; скролл — тоже, с сохранением текста
  review.openCommentPopover(row, "single", cell1, "ctx");
  document.querySelector(".review-pop-text").value = "черновик";
  document.dispatchEvent({ type: "scroll", target: document.body });
  assert(!review.isPopoverOpen(), "скролл закрыл поповер");
  eq(review.findMark("single", cell1).comment, "черновик", "текст сохранён при скролле");

  // «Снять пометку» удаляет пометку целиком
  review.openCommentPopover(row, "single", cell1, "ctx");
  const removeBtn = [...document.querySelectorAll(".review-pop-actions button")]
    .find(b => b.textContent === "Снять пометку");
  removeBtn.click();
  assert(!review.isPopoverOpen(), "поповер закрыт");
  eq(review.findMark("single", cell1), null, "пометка снята");
});

test("review: Esc в поповере не закрывает оверлей решения под ним (стек Esc)", async () => {
  installDom(); await resetState(); domResults();
  review.resetReview(); review.initReview();
  setupSingleA();
  // правила решения → чип решения
  state.results.decision = { outcomes: [
    { id: "o1", label: "Спам", color: "red", rules: [{ anyOf: false, conditions: [
      { question: "q1", answer: "yes", op: "gte", threshold: 0.5 }] }] },
  ] };
  results.renderResults();
  const chip = document.querySelector("#decision-chips .decision-chip");
  assert(chip, "чип решения");
  chip.click(); // attachDecisionTip: парковка + оверлей
  const overlay = document.querySelector(".decision-overlay");
  assert(!overlay.classList.contains("hidden"), "оверлей открыт");
  // блок оценки решения в оверлее
  const block = overlay.querySelector(".review-overlay-block");
  assert(block, "блок «Ваша оценка решения»");
  block.querySelector(".review-reject").click();
  const decTarget = { scope: "single", model: "mA", mode: "decisions", decision: true };
  eq(review.findMark("single", decTarget).verdict, "reject", "вердикт на решение из оверлея");
  // поповер из блока оверлея: Esc закрывает только его
  block.querySelector(".review-comment-btn").click();
  assert(review.isPopoverOpen(), "поповер над оверлеем");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(!review.isPopoverOpen(), "Esc закрыл поповер");
  assert(!overlay.classList.contains("hidden"), "оверлей под поповером остался открыт");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert(overlay.classList.contains("hidden"), "второй Esc закрыл оверлей");
  // бейдж-суффикс на чипе решения
  includes(chip.querySelector(".review-badge").textContent, "✗", "бейдж на чипе решения");
});

// ================================================================ хоткеи и undo

test("review: хоткеи — 1/2/3 по припаркованной цели, RU-раскладка (key «с», code KeyC), гарды", async () => {
  installDom(); await resetState(); domResults();
  review.resetReview(); review.initReview();
  setupSingleA();
  results.renderResults();
  const rows = document.getElementById("results-list").children;
  // без hover-цели клавиши молчат
  document.dispatchEvent({ type: "keydown", code: "Digit2", key: "2" });
  eq(state.results.marks, undefined, "нет цели — нет пометки");
  // hover паркует цель; уход курсора её не сбрасывает
  rows[0].fire("mouseenter");
  rows[0].fire("mouseleave");
  document.dispatchEvent({ type: "keydown", code: "Digit2", key: "2" });
  eq(review.findMark("single", cell1).verdict, "reject", "Digit2 → ✗ на припаркованной цели");
  // новый hover перехватывает цель
  rows[1].fire("mouseenter");
  document.dispatchEvent({ type: "keydown", code: "Digit1", key: "1" });
  const cell2 = { ...cell1, question: "q2" };
  eq(review.findMark("single", cell2).verdict, "accept", "Digit1 → ✓ на новой цели");
  // русская раскладка: key «с», code KeyC — поповер комментария
  document.dispatchEvent({ type: "keydown", code: "KeyC", key: "с" });
  assert(review.isPopoverOpen(), "KeyC в RU-раскладке открыл поповер");
  // цифры при фокусе в textarea поповера — текст, а не вердикты
  const ta = document.querySelector(".review-pop-text");
  ta.dispatchEvent({ type: "keydown", code: "Digit3", key: "3", target: ta });
  eq(review.findMark("single", cell2).verdict, "accept", "цифра в textarea не сменила вердикт");
  // фокус вне textarea — цифры меняют вердикт цели поповера
  document.dispatchEvent({ type: "keydown", code: "Digit3", key: "3" });
  eq(review.findMark("single", cell2).verdict, "unsure", "Digit3 применился к цели поповера");
  review.closePopover(true);

  // гард: ввод текста
  const inp = document.createElement("input");
  document.body.appendChild(inp);
  document.dispatchEvent({ type: "keydown", code: "Digit2", key: "2", target: inp });
  eq(review.findMark("single", cell2).verdict, "unsure", "гарды: input — молчит");
  // гард: идёт прогон
  state.running = true;
  document.dispatchEvent({ type: "keydown", code: "Digit1", key: "1" });
  eq(review.findMark("single", cell2).verdict, "unsure", "гарды: прогон — молчит");
  state.running = false;
  // гард: открыт тур
  openHelp(0);
  document.dispatchEvent({ type: "keydown", code: "Digit1", key: "1" });
  eq(review.findMark("single", cell2).verdict, "unsure", "гарды: тур — молчит");
  closeHelp();

  // undo: U и Ctrl+Z; кнопки ⟲ в тулбаре больше нет
  document.dispatchEvent({ type: "keydown", code: "KeyU", key: "u" });
  eq(review.findMark("single", cell2).verdict, "accept", "U отменила смену вердикта");
  document.dispatchEvent({ type: "keydown", code: "KeyZ", key: "z", ctrlKey: true });
  eq(review.findMark("single", cell2), null, "Ctrl+Z отменил создание");
  document.dispatchEvent({ type: "keydown", code: "KeyU", key: "u" });
  eq(review.findMark("single", cell1), null, "U отменил первую пометку");
});

test("review: undo-стек — откат снятия/комментария, лимит 10", async () => {
  installDom(); await resetState(); domResults();
  review.resetReview(); review.initReview();
  setupSingleA();
  results.renderResults();
  review.setVerdict("single", cell1, "reject");
  review.setComment("single", cell1, "почему");
  review.undo(); // откат комментария
  eq(review.findMark("single", cell1).comment, "", "комментарий откачен");
  review.undo(); // откат вердикта
  eq(review.findMark("single", cell1), null, "вердикт откачен");
  // откат снятия пометки восстанавливает запись
  review.setVerdict("single", cell1, "accept");
  review.removeMark("single", cell1);
  review.undo();
  eq(review.findMark("single", cell1).verdict, "accept", "снятие откачено");
  // лимит стека: 12 операций → откатываются только 10
  for (let i = 0; i < 12; i++) review.setVerdict("single", cell1, i % 2 ? "reject" : "accept");
  let n = 0;
  while (review.undo()) n += 1;
  eq(n, 10, "стек ограничен 10 операциями");
  eq(review.findMark("single", cell1).verdict, "reject", "до начального состояния не откатились");
});

// ================================================================ фильтры

test("review: фильтры одиночного режима — скрытие строк, глушение ячеек B, счётчик, чип-сброс, ⚡-гард", async () => {
  installDom(); await resetState(); domResults();
  review.resetReview(); review.initReview();
  setupSingleB();
  results.renderResults();
  const row = document.getElementById("results-list").children[0];
  const bar = document.getElementById("review-bar");
  // меню фильтра: ⚡ доступен в режиме B
  bar.querySelector(".review-filter-btn").click();
  const items = bar.querySelectorAll(".menu-dropdown .menu-item");
  eq(items.length, 6, "шесть фильтров");
  const disagreeItem = [...items].find(i => i.textContent.includes("Расхождения"));
  assert(!disagreeItem.classList.contains("menu-item-disabled"), "⚡ доступен в режиме B");

  // «✗ Ошибки»: строка видна при ✗ на ячейке, ячейка без ✗ глушится
  review.setVerdict("single", { scope: "single", model: "mB", mode: "decisions", question: "q1" }, "reject");
  [...items].find(i => i.textContent.includes("Ошибки")).click();
  assert(!row.classList.contains("review-hidden"), "строка с ✗ видна");
  const cells = row.querySelectorAll(".res-cell");
  assert(cells[0].classList.contains("review-dim"), "ячейка без ✗ заглушена");
  assert(!cells[1].classList.contains("review-dim"), "✗-ячейка не глушится");
  includes(bar.textContent, "показано 1 из 1", "счётчик «показано X из Y»");
  const chipEl = bar.querySelector(".review-filter-chip");
  assert(chipEl, "чип активного фильтра");
  chipEl.querySelector(".review-filter-clear").click();
  assert(!row.classList.contains("review-hidden"), "сброс фильтра вернул строку");
  assert(!cells[0].classList.contains("review-dim"), "глушение снято");

  // «⚡ Расхождения»: строка diff видна
  review.setFilter("single", "disagree");
  assert(!row.classList.contains("review-hidden"), "расходящаяся строка видна");
  // «⚪ Без отметок»: при размеченной строке, но неразмеченной ячейке — видна
  review.setFilter("single", "unmarked");
  assert(!row.classList.contains("review-hidden"), "есть неразмеченная ячейка — видна");
  review.setVerdict("single", cell1, "accept");
  review.setVerdict("single", { scope: "single", question: "q1" }, "accept");
  review.refresh("single");
  assert(row.classList.contains("review-hidden"), "всё размечено — строка скрыта");
  review.setFilter("single", "all");

  // режим A: ⚡ недоступен (расхождение не определено)
  setupSingleA();
  results.renderResults();
  const barA = document.getElementById("review-bar");
  barA.querySelector(".review-filter-btn").click();
  const disA = [...barA.querySelectorAll(".menu-item")].find(i => i.textContent.includes("Расхождения"));
  assert(disA.classList.contains("menu-item-disabled"), "⚡ недоступен в режиме A");
  assert(disA.title.length > 5, "у недоступного фильтра пояснение в title");
});

test("review: фильтры пакета — ячейки глушатся, строки файлов скрываются, «Итого» остаётся", async () => {
  installDom(); await resetState(); domBatch();
  domToolbar();
  review.resetReview(); review.initReview();
  const { f1, f2 } = setupBatch();
  const fid1 = f1.id;
  review.setVerdict("batch", { scope: "batch", file: fid1, question: "q1", model: "mA" }, "reject");
  review.setFilter("batch", "reject");
  const rows = [...document.querySelectorAll("#batch-results tbody tr")]
    .filter(tr => tr.querySelector("th.batch-file-th"));
  eq(rows.length, 2, "две строки файлов");
  assert(!rows[0].classList.contains("review-hidden"), "строка с ✗ видна");
  assert(rows[1].classList.contains("review-hidden"), "строка без ✗ скрыта");
  const cells0 = rows[0].querySelectorAll("td[data-review-key]");
  assert(!cells0[0].classList.contains("review-dim"), "✗-ячейка не глушится");
  assert(cells0[1].classList.contains("review-dim"), "соседняя ячейка глушится");
  const aggTh = document.querySelector("#batch-results .batch-agg-row th");
  includes(aggTh.textContent, "фильтр активен", "«Итого» с пометкой фильтра");
  assert(!document.querySelector("#batch-results .batch-agg-row").classList.contains("review-hidden"),
    "агрегатная строка остаётся");
  // пометка уровня файла — попадание для вердикт-фильтров
  review.setVerdict("batch", { scope: "batch", file: f2.id }, "unsure");
  review.setFilter("batch", "unsure");
  assert(rows[0].classList.contains("review-hidden"), "файл без ? скрыт");
  assert(!rows[1].classList.contains("review-hidden"), "файл с ? виден");
  // «⚪ Без отметок»: пометка файла не закрывает неразмеченные ячейки
  review.setFilter("batch", "unmarked");
  assert(!rows[1].classList.contains("review-hidden"), "файл с пометкой, но пустыми ячейками виден");
  // ⚡: расходится группа файл1×q1 (mA да, mB нет)
  review.setFilter("batch", "disagree");
  assert(!rows[0].classList.contains("review-hidden"), "файл с расхождением виден");
  assert(rows[1].classList.contains("review-hidden"), "файл без расхождения скрыт");
  review.setFilter("batch", "all");
  assert(!rows[0].classList.contains("review-hidden") && !rows[1].classList.contains("review-hidden"),
    "сброс вернул все строки");
});

// ================================================================ батч: цели и жизненный цикл

test("review: батч — пометки на ячейке, файле, решении и модели (поповер ⓘ)", async () => {
  installDom(); await resetState(); domBatch();
  domToolbar();
  review.resetReview(); review.initReview();
  const { f1 } = setupBatch();
  state.batch.decision = { outcomes: [
    { id: "o1", label: "Спам", color: "red", rules: [{ anyOf: false, conditions: [
      { question: "q1", answer: "yes", op: "gte", threshold: 0.5 }] }] },
  ] };
  batch.renderBatchResults();

  // ячейка
  const cell = document.querySelector("#batch-results .batch-cell[data-review-key]");
  cell.querySelector(".review-triad .review-accept").click();
  eq(review.findMark("batch", { scope: "batch", file: f1.id, question: "q1", model: "mA" }).verdict, "accept",
    "пометка ячейки");
  assert(cell.classList.contains("review-mk-accept"), "рамка ячейки");
  // файл (th)
  const th = document.querySelector("#batch-results .batch-file-th");
  th.querySelector(".review-triad .review-unsure").click();
  eq(review.findMark("batch", { scope: "batch", file: f1.id }).verdict, "unsure", "пометка файла");
  // решение (бейдж в ячейке «Решение»)
  const decTd = document.querySelector("#batch-results .batch-decision-cell");
  decTd.querySelector(".decision-chip").click(); // оверлей с блоком оценки
  document.querySelector(".decision-overlay .review-overlay-block .review-reject").click();
  eq(review.findMark("batch", { scope: "batch", file: f1.id, model: "mA", decision: true }).verdict, "reject",
    "пометка решения");
  includes(decTd.querySelector(".review-badge").textContent, "✗", "бейдж на ячейке решения");
  // модель по пакету — в поповере статистики ⓘ
  document.querySelector("#batch-results .batch-model-chip-info").click();
  const pop = document.body.querySelector(".batch-model-popover");
  includes(pop.textContent, "Оценить прогон", "строка разметки в поповере модели");
  pop.querySelector(".review-inline .review-accept").click();
  eq(review.findMark("batch", { scope: "batch", model: "mA" }).verdict, "accept", "пометка модели");
  const chipBadge = document.querySelector("#batch-results .batch-model-chip .review-badge");
  includes(chipBadge.textContent, "✓", "бейдж на чипсе модели");
});

test("review: батч — runBatch спрашивает «добавить/с нуля»: замена сбрасывает пометки, слияние сохраняет", async () => {
  installDom(); await resetState(); domBatch();
  domToolbar();
  batch.initBatch({});
  review.resetReview(); review.initReview();
  const { f1 } = setupBatch();
  review.setVerdict("batch", { scope: "batch", file: f1.id, question: "q1", model: "mA" }, "reject");
  review.setComment("batch", { scope: "batch", file: f1.id }, "коммент");

  // перепрогон: диалог с числом пометок; «С нуля» — пометки сброшены, вопросы снапшотятся
  state.selectedModels = new Set(["mA"]);
  state.questions = [{ id: "q1", question: "Спам?", type: "yes_no", direction: "yes", collapsed: true }];
  mockFetch(runApiRoutes());
  let p = batch.runBatch();
  await sleep(5);
  const dlg = document.getElementById("rerun-dialog");
  assert(dlg, "диалог перепрогона показан");
  includes(dlg.textContent, "2 пометок, 1 комментариев", "диалог с числом пометок");
  document.getElementById("rerun-replace").fire("click");
  await p;
  eq(state.batch.marks.length, 0, "пометки сброшены прогоном");
  assert(state.batch.questions, "снапшот вопросов записан");
  eq(state.batch.questions[0].direction, "yes", "direction в снапшоте");

  // повторный прогон (результаты уже есть) — диалог снова; «Добавить» сохраняет разметку
  review.setVerdict("batch", { scope: "batch", file: f1.id }, "unsure");
  state.selectedModels = new Set(["mA", "mB"]);
  p = batch.runBatch();
  await sleep(5);
  assert(document.getElementById("rerun-dialog"), "диалог показан и без пометок — результаты есть");
  document.getElementById("rerun-append").fire("click");
  await p;
  eq(state.batch.marks.length, 1, "при слиянии разметка сохранена");
  eq(review.findMark("batch", { scope: "batch", file: f1.id }).verdict, "unsure", "своя пометка на месте");
  eq(Object.keys(state.batch.results[f1.id]).sort().join(","), "mA,mB", "слияние пофайлово: старая и новая модели");
  // отмена диалога — прогон не стартует
  p = batch.runBatch();
  await sleep(5);
  document.getElementById("rerun-cancel").fire("click");
  await p;
  eq(state.batch.running, false, "после отмены прогон не запущен");

  // таблица рендерится по снапшоту: удаление вопроса после прогона не прячет колонку
  state.questions = [];
  batch.renderBatchResults();
  includes(document.querySelector("#batch-results table thead").textContent, "Спам?", "колонка по снапшоту");

  // removeFile удаляет пометки файла
  review.setVerdict("batch", { scope: "batch", file: f1.id, question: "q1", model: "mA" }, "reject");
  review.setVerdict("batch", { scope: "batch", file: f1.id }, "unsure");
  document.getElementById("batch-list").children[0].querySelector(".btn-danger").click();
  eq(state.batch.marks.length, 0, "пометки файла удалены с ним");
  // clearFiles чистит пометки и снапшот
  const { f1: g1 } = setupBatch();
  review.setVerdict("batch", { scope: "batch", file: g1.id }, "accept");
  state.batch.decision = { enabled: true, outcomes: [{ id: "old", label: "Old", rules: [] }] };
  state.batch.startedAt = 10;
  state.batch.finishedAt = 20;
  document.getElementById("btn-batch-clear").click();
  eq(state.batch.marks.length, 0, "clearFiles чистит пометки");
  eq(state.batch.questions, null, "clearFiles чистит снапшот вопросов");
  eq(state.batch.decision, null, "clearFiles чистит снапшот решения");
  eq(state.batch.startedAt, null, "clearFiles чистит startedAt");
  eq(state.batch.finishedAt, null, "clearFiles чистит finishedAt");
});

test("review: rerun append — несовместимость блокирует, legacy без temperature предупреждает", async () => {
  installDom(); await resetState();
  const seedSingle = (meta) => {
    state.results = {
      results: { mA: { ok: true } }, order: ["mA"], runMode: "decisions", questions: [], marks: [],
    };
    state.resultsMeta = meta;
  };

  // Изменённый fingerprint: ни Enter, ни программный click disabled-кнопки не
  // выбирают append или destructive replace — остаётся явный выбор пользователя.
  seedSingle({ fingerprint: "old", runMode: "decisions", temperature: 0.5 });
  let choice = askAppendOrReplace("single", { fingerprint: "new", runMode: "decisions", temperature: 0.5 });
  let settled = "pending";
  choice.then(value => { settled = value; });
  let dialog = document.getElementById("rerun-dialog");
  let append = document.getElementById("rerun-append");
  assert(append.disabled, "append disabled при другом fingerprint");
  includes(dialog.textContent, "материалы, вопросы или правила решения", "причина несовместимости видна");
  document.dispatchEvent({ type: "keydown", key: "Enter" });
  append.fire("click");
  await sleep(5);
  eq(settled, "pending", "Enter и disabled append не завершают диалог");
  assert(document.getElementById("rerun-dialog"), "диалог остался открыт");
  document.getElementById("rerun-cancel").fire("click");
  eq(await choice, null, "явная отмена разрешена");

  // Известные mode/temperature обязаны совпасть; замена доступна только явно.
  seedSingle({ fingerprint: "fp", runMode: "decisions", temperature: 0.5 });
  choice = askAppendOrReplace("single", { fingerprint: "fp", runMode: "fast_batch", temperature: 0.7 });
  settled = "pending";
  choice.then(value => { settled = value; });
  dialog = document.getElementById("rerun-dialog");
  assert(document.getElementById("rerun-append").disabled, "append disabled при другом runMode/temperature");
  includes(dialog.textContent, "режим прогона", "указана причина про режим");
  includes(dialog.textContent, "температура", "указана причина про температуру");
  document.dispatchEvent({ type: "keydown", key: "Enter" });
  await sleep(5);
  eq(settled, "pending", "Enter не выбирает destructive replace");
  document.getElementById("rerun-replace").fire("click");
  eq(await choice, "replace", "явная замена разрешена");

  // Старые результаты: runMode берём из wrapper, temperature неизвестна.
  // Append сохраняется (включая Enter), но неопределённость и безопасный replace видны.
  seedSingle({ fingerprint: "fp" });
  choice = askAppendOrReplace("single", { fingerprint: "fp", runMode: "decisions", temperature: 0.7 });
  dialog = document.getElementById("rerun-dialog");
  assert(!document.getElementById("rerun-append").disabled, "legacy без temperature может append");
  includes(dialog.textContent, "сопоставимость результатов неизвестна", "неизвестная сопоставимость показана");
  includes(dialog.textContent, "безопаснее", "replace рекомендован как более безопасный");
  document.dispatchEvent({ type: "keydown", key: "Enter" });
  eq(await choice, "append", "Enter сохраняет прежнее legacy-поведение");
});

// ================================================================ одноразовая подсказка

test("review: подсказка — один раз на реальных результатах; не на демо и не в туре", async () => {
  installDom(); await resetState(); domResults();
  review.resetReview(); review.initReview();
  localStorage.removeItem("dq-review-hint-seen");
  setupSingleA();
  results.renderResults();
  const hint = document.getElementById("review-hint");
  assert(hint, "подсказка показана");
  includes(hint.textContent, "✓/✗/?", "текст подсказки");
  hint.querySelector("button").click(); // «Понятно»
  eq(localStorage.getItem("dq-review-hint-seen"), "1", "флаг записан");
  assert(!document.getElementById("review-hint"), "подсказка убрана");
  results.renderResults();
  assert(!document.getElementById("review-hint"), "повторно не показывается");

  // демо-результаты (нет fingerprint) — подсказки нет
  installDom(); await resetState(); domResults();
  review.resetReview(); review.initReview();
  localStorage.removeItem("dq-review-hint-seen");
  setupSingleA();
  state.resultsMeta = null; // демо
  results.renderResults();
  assert(!document.getElementById("review-hint"), "на демо подсказки нет");
  // во время тура — тоже нет
  state.resultsMeta = { fingerprint: "fp" };
  openHelp(0);
  results.renderResults();
  assert(!document.getElementById("review-hint"), "в туре подсказки нет");
  closeHelp();
});

test("review: revealTarget — телепорт из чата: flash, раскрытие details, сброс фильтра разметки", async () => {
  installDom(); await resetState(); domResults();
  review.resetReview(); review.initReview();
  setupSingleA();
  // цель: ячейка внутри details внутри строки результата (как в реальном UI)
  const target = { scope: "single", model: "mA", mode: "decisions", decision: true };
  const row = document.createElement("div");
  row.className = "res-row";
  review.attachTarget(row, "single", { scope: "single", question: "q1" },
    { triad: false, badge: false }); // у строки свой таргет (строка вопроса)
  const det = document.createElement("details");
  const cell = document.createElement("span");
  review.attachTarget(cell, "single", target, { kind: "chip" });
  det.appendChild(cell);
  row.appendChild(det);
  document.getElementById("results-list").appendChild(row);

  // телепорт к видимой цели: flash + details раскрыт, фильтр не тронут
  let r = review.revealTarget("single", target);
  eq(r.ok, true, "цель найдена");
  eq(r.filterReset, false, "фильтр не сбрасывался");
  eq(det.open, true, "details раскрыт");
  assert(cell.classList.contains("review-flash"), "flash-подсветка");
  assert(cell._scrolledIntoView >= 1, "scrollIntoView вызван");

  // цель скрыта активным фильтром разметки → фильтр сбрасывается
  review.setFilter("single", "reject");
  row.classList.add("review-hidden");
  r = review.revealTarget("single", target);
  eq(r.ok, true, "цель найдена после сброса");
  eq(r.filterReset, true, "фильтр сброшен");
  assert(!row.classList.contains("review-hidden"), "строка снова видима");

  // несуществующая цель — честный отказ
  r = review.revealTarget("single", { scope: "single", model: "zzz", mode: "decisions", decision: true });
  eq(r.ok, false, "неизвестная цель — ok:false");
});
