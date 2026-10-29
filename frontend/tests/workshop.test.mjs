// Workshop: editor-only duplication, selection, clipboard and dependency flow.

import {
  test, assert, eq, includes, throws, installDom, resetState, sleep, domApp, restoreGlobalProperty,
  state, questions, batch, context, persist,
  documentsUi, toolbar, workshop, workshopUi,
} from "./harness.mjs";
import * as decision from "../static/decision.js";

async function setup({ withDocuments = false } = {}) {
  installDom(); await resetState(); domApp();
  questions.mountQuestions();
  questions.mountQuestions({ listId: "batch-questions-list", emptyId: "batch-questions-empty" });
  decision.mountDecision({ enabledId: "decision-enabled" });
  decision.mountDecision({ listId: "batch-decision-list", emptyId: "batch-decision-empty", hintsId: "batch-decision-hints", enabledId: "batch-decision-enabled" });
  if (withDocuments) {
    context.initContext({});
    batch.initBatch({});
    persist.resumePersist();
    globalThis.location = { hash: "" };
    globalThis.history = { replaceState: (_a, _b, value) => { globalThis.location.hash = value; } };
    await documentsUi.initDocuments();
  }
  workshopUi.initWorkshop();
}

function seed() {
  questions.setQuestions([
    { id: "qA", question: "A?", type: "yes_no", direction: "no" },
    { id: "qB", question: "B?", type: "choice", options: [{ name: "one", description: "1" }, { name: "two" }] },
    { id: "qC", question: "C?", type: "score", levels: ["low", "high"], direction: "down" },
  ]);
  decision.setDecision({ enabled: true, outcomes: [
    { id: "oX", label: "X", color: "green", isDefault: true, rules: [
      { anyOf: false, conditions: [
        { question: "qA", answer: "yes", op: "gte", threshold: 0.8 },
        { question: "qB", answer: "one", op: "lt", threshold: 0.4 },
        { question: "qC", op: "gte", score: 0.5 },
      ] },
      { anyOf: true, conditions: [{ question: "qA", answer: "no", op: "lt", threshold: 0.2 }] },
    ] },
    { id: "oY", label: "Y", color: "red", rules: [{ anyOf: false, conditions: [{ question: "qA", answer: "yes", op: "gte", threshold: 0.9 }] }] },
  ] });
  for (const outcome of state.decision.outcomes) outcome.collapsed = false;
  decision.renderDecision();
}

function sourceEnvelope() {
  const envelope = workshop.buildWorkshopEnvelope("local", [{ kind: "rule", id: workshop.workshopRuleId("oX", 0) }]);
  workshop.writeWorkshopClipboard("local", envelope);
  return envelope;
}

function cards(kind) {
  return [...document.querySelectorAll("[data-workshop-kind]")].filter(card => card.dataset.workshopKind === kind);
}

function selectedCards(kind) {
  const seen = new Set();
  return cards(kind).filter(card => card.classList.contains("workshop-selected") &&
    !seen.has(card.dataset.workshopId) && seen.add(card.dataset.workshopId));
}

function duplicateCard(card) {
  card.querySelector(".workshop-actions").children[0].fire("click");
}

test("workshop: duplicate создаёт fresh IDs, порядок и default без копирования results/marks", async () => {
  await setup(); seed();
  state.results = { results: { mA: { ok: true } }, order: ["mA"], marks: [{ id: "mark-single" }] };
  state.resultsMeta = { latestRun: "run_source", runs: { run_source: { status: "completed" } } };
  state.batch.marks = [{ id: "mark-batch" }];
  const resultsBefore = JSON.stringify([state.results, state.resultsMeta, state.batch.marks]);
  const originalOutcomeId = state.decision.outcomes[0].id;
  const originalQuestionId = state.questions[0].id;

  duplicateCard(cards("question")[0]);
  eq(state.questions[1].question, "A?", "question вставлен сразу под source");
  assert(state.questions[1].id !== originalQuestionId, "question fresh id");
  eq(state.questions[0].id, originalQuestionId, "original stable id не изменён");

  duplicateCard(cards("outcome")[0]);
  const duplicatedOutcome = state.decision.outcomes[1];
  eq(duplicatedOutcome.label, "X", "outcome вставлен сразу под source");
  assert(duplicatedOutcome.id !== originalOutcomeId, "outcome fresh id");
  eq(duplicatedOutcome.isDefault, false, "duplicate default не создаёт второй default");
  eq(state.decision.outcomes.filter(outcome => outcome.isDefault).length, 1, "ровно один default");
  eq(document.getElementById("decision-list").querySelectorAll("code.outcome-id").length, 0, "IDs не загромождают карточки");
  includes(document.getElementById("decision-list").textContent, "Скопировать ID", "ID доступен через меню исхода");

  duplicateCard(cards("rule")[0]);
  eq(state.decision.outcomes[0].rules.length, 3, "rule вставлен под source");
  eq(state.decision.outcomes[0].rules[1].conditions[0].question, "qA", "single duplicate не переназначает внешние refs");
  eq(JSON.stringify([state.results, state.resultsMeta, state.batch.marks]), resultsBefore,
    "results/marks/provenance не копируются и не очищаются вручную");
});

test("workshop: mixed group сохраняет порядок и remaps internal refs ровно один раз", async () => {
  await setup(); seed();
  const result = workshop.duplicateWorkshop([
    { kind: "question", id: "qB" },
    { kind: "outcome", id: "oX" },
    { kind: "question", id: "qA" },
  ]);
  eq(result.questions, 2, "group questions");
  eq(state.questions.slice(2, 4).map(question => question.question).join("|"), "A?|B?", "source order внутри group");
  const [newA, newB] = state.questions.slice(2, 4).map(question => question.id);
  const clonedOutcome = state.decision.outcomes[1];
  eq(clonedOutcome.rules[0].conditions.map(condition => condition.question).join("|"), `${newA}|${newB}|qC`,
    "все internal refs указывают на новые IDs без повторного remap");
  const envelope = workshop.buildWorkshopEnvelope("local", [{ kind: "question", id: "qA" }, { kind: "outcome", id: "oX" }]);
  const pasted = workshop.applyWorkshopPaste(workshop.planWorkshopPaste(envelope), {}, {});
  const pastedOutcome = state.decision.outcomes.at(-1);
  eq(pastedOutcome.rules[0].conditions[0].question, pasted.inserted[0].id, "paste internal question remap");
  eq(pastedOutcome.rules[0].conditions[1].question, "qB", "external question reuse не remap повторно");
  eq(pastedOutcome.rules[0].conditions[2].question, "qC", "score external reference сохранён");

  const multi = workshop.buildWorkshopEnvelope("local", [{ kind: "rule", id: workshop.workshopRuleId("oX", 0) }, { kind: "rule", id: workshop.workshopRuleId("oY", 0) }]);
  const multiResult = workshop.applyWorkshopPaste(workshop.planWorkshopPaste(multi), {}, {});
  eq(multiResult.rules, 2, "multi-outcome rule group вставлена целиком");
  eq(state.decision.outcomes.find(outcome => outcome.id === "oX").rules.length, 3, "rule возвращена в oX");
  eq(state.decision.outcomes.find(outcome => outcome.id === "oY").rules.length, 2, "rule возвращена в oY");
});

test("workshop: owner-scoped envelope, cross-tab internal и system clipboard fallback", async () => {
  await setup(); seed();
  const ruleCard = cards("rule")[0];
  ruleCard.querySelector(".workshop-select").fire("click");
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldSecure = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
  let systemText = null;
  let permissionCalls = 0;
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    clipboard: {
      writeText: async () => { throw new Error("denied"); },
      readText: async () => { throw new Error("denied"); },
    },
    permissions: { query: async () => { permissionCalls += 1; throw new Error("unexpected prompt"); } },
  } });
  try {
    const envelope = await workshopUi.copyWorkshopSelection();
    assert(envelope, "internal copy сохранена при system failure");
    eq(workshop.readWorkshopClipboard("local").type, "decision-qa.workshop/1", "same owner/tab читает envelope");
    eq(workshop.readWorkshopClipboard("other"), null, "other owner изолирован");
    const serialized = JSON.stringify(envelope);
    for (const forbidden of ["results", "marks", "provenance", "token"]) eq(serialized.includes(forbidden), false, `clipboard без ${forbidden}`);
    includes(document.getElementById("workshop-status").textContent, "внутренн", "fallback видим и неблокирующ");
    eq(permissionCalls, 0, "нет permission prompt/query");

    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      clipboard: {
        writeText: async text => { systemText = text; },
        readText: async () => systemText,
      },
    } });
    await workshopUi.copyWorkshopSelection();
    localStorage.removeItem(workshop.workshopClipboardKey("local"));
    const pending = workshopUi.pasteWorkshopAt({ kind: "rule", id: workshop.workshopRuleId("oX", 0), targetOutcomeId: "oX", ruleIndex: 0 });
    await sleep(0);
    document.getElementById("workshop-dependency-apply").fire("click");
    const pasted = await pending;
    eq(pasted.rules, 1, "system clipboard использован после удаления internal copy");
  } finally {
    restoreGlobalProperty("navigator", oldNavigator);
    restoreGlobalProperty("isSecureContext", oldSecure);
  }
});

test("workshop: selection, insertion feedback, shared editors и hotkey guards", async () => {
  await setup(); seed();
  eq(cards("question").filter(card => card.querySelector(".workshop-actions")).length, 6, "controls в single+batch без дублирования state");
  eq(cards("outcome").filter(card => card.querySelector(".workshop-actions")).length, 4, "controls в обоих decision mounts");
  const questionCards = cards("question");
  questionCards[0].querySelector(".workshop-select").fire("click");
  questionCards[1].querySelector(".workshop-select").onclick({ ctrlKey: true });
  eq(selectedCards("question").length, 2, "Ctrl multi-selection");
  assert(questionCards[0].classList.contains("workshop-paste-target"), "insertion point подсвечен");

  const outcomeCards = cards("outcome");
  outcomeCards[0].querySelector(".workshop-select").fire("click");
  outcomeCards[1].querySelector(".workshop-select").onclick({ shiftKey: true });
  eq(selectedCards("outcome").length, 2, "Shift range selection");
  const editable = document.createElement("div");
  editable.setAttribute("contenteditable", "true");
  const codeMirror = document.createElement("div");
  codeMirror.className = "cm-editor";
  const guarded = [
    document.getElementById("context-input"),
    document.querySelector("select"),
    editable,
    codeMirror,
  ];
  for (const target of guarded) {
    eq(await workshopUi.handleWorkshopHotkey({ ctrlKey: true, key: "c", target, preventDefault() {} }), false,
      "hotkey заблокирован в редакторе");
  }
  const overlay = document.createElement("div");
  overlay.className = "preset-dialog-overlay";
  document.body.appendChild(overlay);
  eq(await workshopUi.handleWorkshopHotkey({ ctrlKey: true, key: "c", target: document.body, preventDefault() {} }), false,
    "hotkey заблокирован под dialog/overlay");
  overlay.remove();
  eq(await workshopUi.handleWorkshopHotkey({ ctrlKey: true, key: "c", target: document.body, preventDefault() {} }), true,
    "standard Ctrl/Cmd+C работает на selection вне editors");
  eq(workshop.readWorkshopClipboard("local").payload.outcomes.length, 2, "hotkey скопировал group");
});

test("workshop: dependencies reuse, unique text map и missing add", async () => {
  await setup(); seed();
  const envelope = sourceEnvelope();
  await resetState();
  questions.setQuestions([
    { id: "qA", question: "A?", type: "yes_no", direction: "no" },
    { id: "qB_existing", question: "B?", type: "choice", options: [{ name: "one", description: "1" }, { name: "two" }] },
  ]);
  decision.setDecision({ outcomes: [{ id: "target", label: "Target", color: "gray", rules: [] }] });
  const plan = workshop.planWorkshopPaste(envelope, { targetOutcomeId: "target" });
  eq(plan.dependencies.map(dependency => dependency.status).join("|"), "compatible|text|missing", "dependency statuses");
  const result = workshop.applyWorkshopPaste(plan, {}, { targetOutcomeId: "target" });
  eq(result.reused, 1, "exact-id compatible reused");
  eq(result.mapped, 1, "unique compatible text mapped");
  eq(result.dependencyQuestions, 1, "missing dependency добавлена");
  const conditions = state.decision.outcomes[0].rules[0].conditions;
  eq(conditions[0].question, "qA", "exact id reused");
  eq(conditions[1].question, "qB_existing", "unique text target");
  assert(conditions[2].question !== "qC", "missing question получил fresh id");
  eq(state.questions.length, 3, "добавлена только missing dependency");
});

test("workshop: outcome dependencies reuse/map/add без потери rule target", async () => {
  await setup(); seed();
  const envelope = sourceEnvelope();
  const exactQuestions = () => questions.setQuestions([
    { id: "qA", question: "A?", type: "yes_no", direction: "no" },
    { id: "qB", question: "B?", type: "choice", options: [{ name: "one", description: "1" }, { name: "two" }] },
    { id: "qC", question: "C?", type: "score", levels: ["low", "high"], direction: "down" },
  ]);
  await resetState(); exactQuestions();
  decision.setDecision({ outcomes: [{ id: "oX", label: "X", color: "green", isDefault: true, rules: [] }] });
  let plan = workshop.planWorkshopPaste(envelope);
  eq(plan.dependencies.at(-1).status, "compatible", "outcome metadata compatible даже при subset rules");
  let result = workshop.applyWorkshopPaste(plan, {}, {});
  eq(result.dependencyOutcomes, 0, "exact outcome reused");
  eq(state.decision.outcomes[0].rules.length, 1, "rule вставлен в existing outcome");

  await resetState(); exactQuestions();
  decision.setDecision({ outcomes: [{ id: "oExisting", label: "X", color: "green", isDefault: true, rules: [] }] });
  plan = workshop.planWorkshopPaste(envelope);
  eq(plan.dependencies.at(-1).status, "text", "unique outcome text mapping предложен");
  result = workshop.applyWorkshopPaste(plan, {}, {});
  eq(state.decision.outcomes[0].rules.length, 1, "rule target сопоставлен по unique text");
  eq(result.mapped, 1, "outcome map count");

  await resetState(); exactQuestions();
  decision.setDecision({ outcomes: [] });
  plan = workshop.planWorkshopPaste(envelope);
  eq(plan.dependencies.at(-1).status, "missing", "missing outcome виден");
  result = workshop.applyWorkshopPaste(plan, {}, {});
  eq(result.dependencyOutcomes, 1, "missing outcome добавлен");
  assert(state.decision.outcomes[0].id !== "oX", "dependency outcome fresh id");
  eq(state.decision.outcomes[0].rules.length, 1, "rule прикреплён к новому outcome один раз");
});

test("workshop: collisions и ambiguous text не перезаписывают destination", async () => {
  await setup(); seed();
  const envelope = sourceEnvelope();
  await resetState();
  questions.setQuestions([
    { id: "qA", question: "Incompatible", type: "yes_no" },
    { id: "qB1", question: "B?", type: "choice", options: [{ name: "one", description: "1" }, { name: "two" }] },
    { id: "qB2", question: "B?", type: "choice", options: [{ name: "one", description: "1" }, { name: "two" }] },
  ]);
  decision.setDecision({ outcomes: [{ id: "target", label: "Target", color: "gray", rules: [] }] });
  const plan = workshop.planWorkshopPaste(envelope, { targetOutcomeId: "target" });
  eq(plan.dependencies[0].status, "collision", "same-id incompatible виден как collision");
  eq(plan.dependencies[0].choices.some(choice => choice.value === "reuse"), false, "collision нельзя silently reuse");
  eq(plan.dependencies[1].choices.some(choice => choice.value === "map"), false, "ambiguous text не предлагается");
  const result = workshop.applyWorkshopPaste(plan, {}, { targetOutcomeId: "target" });
  eq(result.dependencyQuestions, 3, "collision/ambiguous/missing добавлены отдельно");
  eq(state.questions[0].question, "Incompatible", "same-id destination не перезаписан");
  assert(state.decision.outcomes[0].rules[0].conditions.every(condition => !["qA", "qB", "qC"].includes(condition.question)),
    "refs указывают на fresh dependencies, не на collisions");

  await resetState();
  decision.setDecision({ outcomes: [{ id: "oX", label: "Changed", color: "red", rules: [] }] });
  const outcomePlan = workshop.planWorkshopPaste(envelope);
  eq(outcomePlan.dependencies.at(-1).status, "collision", "outcome same-id collision виден");
  workshop.applyWorkshopPaste(outcomePlan, {}, {});
  eq(state.decision.outcomes[0].label, "Changed", "outcome collision не перезаписан");
  assert(state.decision.outcomes[1].id !== "oX", "colliding outcome добавлен с fresh id");
});

test("workshop: dependency dialog counts/cancel и explicit dangling validation", async () => {
  await setup(); seed(); sourceEnvelope();
  await resetState();
  decision.setDecision({ outcomes: [{ id: "target", label: "Target", color: "gray", rules: [] }] });
  const insertion = { kind: "rule", id: "target:0", targetOutcomeId: "target", ruleIndex: 0 };
  const cancelled = workshopUi.pasteWorkshopAt(insertion);
  await sleep(0);
  assert(document.getElementById("workshop-dependency-dialog"), "dependency dialog открыт");
  document.getElementById("workshop-dependency-cancel").fire("click");
  eq(await cancelled, null, "cancel результат");
  eq(state.questions.length, 0, "cancel не добавил dependencies");
  eq(state.decision.outcomes[0].rules.length, 0, "cancel не добавил rules");

  const pending = workshopUi.pasteWorkshopAt(insertion);
  await sleep(0);
  const selects = [...document.querySelectorAll("[data-dependency-key]")];
  eq(selects.length, 3, "все dependencies в диалоге");
  for (const select of selects) {
    select.value = "dangle";
    select.onchange();
  }
  includes(document.getElementById("workshop-dependency-summary").textContent, "висячие 3", "resulting counts обновлены");
  document.getElementById("workshop-dependency-apply").fire("click");
  const result = await pending;
  eq(result.dangling, 3, "dangling только после явного выбора");
  eq(state.questions.length, 0, "dangling не добавил вопросы");
  throws(() => decision.validateDecision(state.decision, state.questions), "вопрос не найден", "validation блокирует dangling");
  includes(document.getElementById("decision-hints").textContent, "удалённый вопрос", "hint показывает dangling");
});

test("workshop: pending dependency dialog закрывается на document switch и structural edit", async () => {
  await setup({ withDocuments: true }); seed(); sourceEnvelope();
  const pending = workshopUi.pasteWorkshopAt({ kind: "rule", id: workshop.workshopRuleId("oX", 0), targetOutcomeId: "oX", ruleIndex: 0 });
  await sleep(0);
  assert(document.getElementById("workshop-dependency-dialog"), "dialog открыт перед switch");
  const switching = documentsUi.createNewDocument();
  document.getElementById("document-discard").fire("click");
  await switching;
  eq(await pending, null, "pending paste отменён при document switch");
  eq(document.getElementById("workshop-dependency-dialog"), null, "dialog закрыт при switch");
  eq(state.decision.outcomes.length, 0, "paste не попал в новый документ");

  decision.setDecision({ outcomes: [{ id: "target", label: "Target", color: "gray", rules: [] }] });
  const stale = workshopUi.pasteWorkshopAt({ kind: "rule", id: "target:insertion", targetOutcomeId: "target", ruleIndex: 0 });
  await sleep(0);
  assert(document.getElementById("workshop-dependency-dialog"), "dialog для structural fixture открыт");
  questions.setQuestions([{ id: "qNew", question: "Changed structure", type: "yes_no" }]);
  eq(await stale, null, "structural revision отменяет pending paste");
  eq(document.getElementById("workshop-dependency-dialog"), null, "dialog закрыт после structural edit");
  eq(state.decision.outcomes[0].rules.length, 0, "stale plan не применён");
});

test("workshop: delayed clipboard read не переносит paste в другой документ", async () => {
  await setup({ withDocuments: true }); seed();
  const envelope = sourceEnvelope();
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldSecure = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
  let markEntered = null;
  let release = null;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    clipboard: { readText: async () => { markEntered(); await blocked; return JSON.stringify(envelope); } },
  } });
  try {
    const pending = workshopUi.pasteWorkshopAt({ kind: "rule", id: workshop.workshopRuleId("oX", 0), targetOutcomeId: "oX", ruleIndex: 0 });
    await entered;
    const switching = documentsUi.createNewDocument();
    document.getElementById("document-discard").fire("click");
    await switching;
    release();
    eq(await pending, null, "async result после switch отброшен");
    eq(document.getElementById("workshop-dependency-dialog"), null, "stale dialog не открыт");
    eq(state.decision.outcomes.length, 0, "новый документ не получил stale rules");
  } finally {
    release();
    restoreGlobalProperty("navigator", oldNavigator);
    restoreGlobalProperty("isSecureContext", oldSecure);
  }
});

test("workshop: stable rule identity после delete/reorder направляет duplicate под intended rule", async () => {
  await setup(); seed();
  let outcome = state.decision.outcomes[0];
  const afterDelete = workshop.workshopRuleId("oX", 1);
  outcome.rules.splice(0, 1);
  decision.renderDecision();
  eq(workshop.workshopRuleId("oX", 0), afterDelete, "identity не зависит от index после delete");
  workshop.duplicateWorkshop([{ kind: "rule", id: afterDelete }]);
  eq(outcome.rules[0].conditions.length, 1, "original intended остался на месте");
  eq(outcome.rules[1].conditions.length, 1, "duplicate intended, не preceding rule");
  eq(outcome.rules[1].anyOf, true, "anyOf intended сохранён");

  await resetState(); seed();
  outcome = state.decision.outcomes[0];
  const afterReorder = workshop.workshopRuleId("oX", 0);
  outcome.rules = [outcome.rules[1], outcome.rules[0]];
  decision.renderDecision();
  eq(workshop.workshopRuleId("oX", 1), afterReorder, "identity следует за object после reorder");
  workshop.duplicateWorkshop([{ kind: "rule", id: afterReorder }]);
  eq(outcome.rules[1].conditions.length, 3, "reordered original остался перед insertion");
  eq(outcome.rules[2].conditions.length, 3, "duplicate вставлен именно под reordered original");
});

test("workshop: insertion point пересчитывается после delete preceding rule перед paste", async () => {
  await setup(); seed(); sourceEnvelope();
  const outcome = state.decision.outcomes[0];
  const intended = workshop.workshopRuleId("oX", 1);
  const selectedCard = cards("rule").find(card => card.dataset.workshopId === intended);
  selectedCard.querySelector(".workshop-select").fire("click");
  outcome.rules.splice(0, 1);
  decision.renderDecision();
  const updatedCard = cards("rule").find(card => card.dataset.workshopId === intended);
  eq(updatedCard.workshopInsertion.ruleIndex, 0, "insertion index пересчитан после delete");
  eq(selectedCards("rule")[0].dataset.workshopId, intended, "selection сохранён на intended object");
  const pending = workshopUi.pasteWorkshopAt(updatedCard.workshopInsertion);
  await sleep(0);
  document.getElementById("workshop-dependency-apply").fire("click");
  await pending;
  eq(outcome.rules.length, 2, "добавлена только pasted rule");
  eq(outcome.rules[0].conditions.length, 1, "intended original остался перед insertion");
  eq(outcome.rules[1].conditions.length, 3, "pasted rule вставлена ниже intended, не по stale index");
});

test("workshop: cross single↔batch и document paste сохраняется в полный файл", async () => {
  await setup({ withDocuments: true }); seed();
  const envelope = workshop.buildWorkshopEnvelope("local", [{ kind: "question", id: "qA" }]);
  workshop.writeWorkshopClipboard("local", envelope);
  const firstQuestion = document.querySelector("[data-workshop-kind='question'] .workshop-select");
  firstQuestion.fire("click");
  const switching = documentsUi.createNewDocument();
  document.getElementById("document-discard").fire("click");
  await switching;
  eq(selectedCards("question").length, 0, "selection очищена при document switch");
  toolbar.setPageMode("batch");
  const pasted = await workshopUi.pasteWorkshopAt({ kind: "question", id: "target", questionIndex: 0 });
  eq(pasted.questions, 1, "cross-document paste");
  eq(document.getElementById("questions-list").children.length, 2, "single mount обновлён");
  eq(document.getElementById("batch-questions-list").children.length, 2, "batch mount разделяет questions");
  const handle = { name: "workshop.json", content: "", createWritable: async () => ({
    write: async blob => { handle.content = blob.content; }, close: async () => {},
  }) };
  globalThis.showSaveFilePicker = async () => handle;
  state.questions[0].question = "Новый вопрос?";
  await documentsUi.initDocuments({ onError: message => { throw new Error(message); } });
  assert(await documentsUi.saveCurrentDocumentAs(), "paste сохраняется штатным полным save");
  eq(JSON.parse(handle.content).config.questions.length, 2, "файл содержит pasted question");
});
