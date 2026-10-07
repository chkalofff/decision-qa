// Доменные тесты: questions. Общие фикстуры/ассерты — harness.mjs.

import {
  test, assert, eq, includes, notIncludes, throws, installDom, resetState, domQuestions, state, questions,
} from "./harness.mjs";

// ================================================================ questions

test("questions: свежая карточка схлопывается после первого ввода; «свернуть» — крайняя справа", async () => {
  installDom(); await resetState(); domQuestions();
  questions.addQuestion();
  const card = document.getElementById("questions-list").children[0];
  assert(!state.questions[0].collapsed, "свежая развёрнута");
  state.questions[0].question = "Текст вопроса?";
  card.fire("input");
  card.fire("focusout");
  assert(state.questions[0].collapsed, "схлопнута после ввода");
  state.questions[0].collapsed = false;
  questions.renderQuestions();
  const controls = document.getElementById("questions-list").children[0].querySelector(".question-controls");
  const last = controls.children[controls.children.length - 1];
  assert(last.classList.contains("collapse-btn"), "последняя кнопка — collapse");
  const delIdx = controls.children.findIndex(c => c.textContent === "Удалить");
  assert(delIdx >= 0 && delIdx < controls.children.length - 1, "«Удалить» левее «свернуть»");
});

test("questions: moveQuestion меняет порядок", async () => {
  installDom(); await resetState(); domQuestions();
  questions.addQuestion({ question: "Первый?", type: "yes_no" });
  questions.addQuestion({ question: "Второй?", type: "yes_no" });
  questions.addQuestion({ question: "Третий?", type: "yes_no" });
  questions.moveQuestion(0, 2);
  eq(state.questions.map(q => q.question).join("|"), "Второй?|Третий?|Первый?", "порядок");
});

test("questions: валидация payload, ошибка — порядковый номер, а не id", async () => {
  installDom(); await resetState(); domQuestions();
  questions.addQuestion({ question: "", type: "yes_no" });
  throws(() => questions.buildQuestionsPayload(), "пустой текст", "пустой вопрос");
  await resetState();
  questions.addQuestion({ question: "Q?", type: "choice", options: [{ name: "один" }] });
  throws(() => questions.buildQuestionsPayload(), "от 2 до 26", "мало опций");
  await resetState();
  questions.addQuestion({ question: "Q?", type: "choice", options: [{ name: "А" }, { name: "а" }] });
  throws(() => questions.buildQuestionsPayload(), "дублирующееся", "дубли опций case-insensitive");
  await resetState();
  questions.addQuestion({ question: "Q?", type: "score", levels: ["один"] });
  throws(() => questions.buildQuestionsPayload(), "от 2 до 10", "мало уровней");
  // ошибка показывает 1-based номер, а не внутренний id
  questions.setQuestions([{ question: "Ок?", type: "yes_no" }, { question: "", type: "yes_no" }]);
  const emptyId = state.questions[1].id;
  try {
    questions.buildQuestionsPayload();
    throw new Error("исключение не брошено");
  } catch (e) {
    includes(e.message, "Вопрос №2", "1-based номер в списке");
    notIncludes(e.message, emptyId, "внутренний id не показывается");
  }
});

test("questions: подсказка пустого списка появляется и пропадает", async () => {
  installDom(); await resetState(); domQuestions();
  const hint = document.getElementById("questions-empty");
  questions.renderQuestions();
  assert(!hint.classList.contains("hidden"), "подсказка видна при пустом списке");
  questions.addQuestion({ question: "Q?", type: "yes_no" });
  assert(hint.classList.contains("hidden"), "подсказка скрыта при наличии вопросов");
  questions.removeQuestion(0);
  assert(!hint.classList.contains("hidden"), "подсказка вернулась после удаления всех");
});

test("questions: setAllCollapsed", async () => {
  installDom(); await resetState(); domQuestions();
  questions.addQuestion({ question: "Q1?", type: "yes_no" });
  questions.addQuestion({ question: "Q2?", type: "yes_no" });
  questions.setAllCollapsed(false);
  assert(state.questions.every(q => !q.collapsed), "все развёрнуты");
  questions.setAllCollapsed(true);
  assert(state.questions.every(q => q.collapsed), "все схлопнуты");
});

test("questions: direction — normalize, не в payload, в экспорте, переживает setQuestions", async () => {
  installDom(); await resetState(); domQuestions();
  // normalizeQuestion: валидное сохраняется, неизвестное → neutral
  const n = questions.normalizeQuestion({ question: "S?", type: "score", levels: ["a", "b"], direction: "down" });
  eq(n.direction, "down", "direction сохранён");
  const n2 = questions.normalizeQuestion({ question: "S?", type: "score", levels: ["a", "b"], direction: "bogus" });
  eq(n2.direction, "neutral", "неизвестное direction → neutral");
  // не в payload, но в экспорте
  questions.addQuestion({ question: "Оценка?", type: "score", levels: ["плохо", "хорошо"], direction: "up" });
  const payload = questions.buildQuestionsPayload();
  assert(!("direction" in payload[0]), "direction не в payload");
  let captured = null;
  globalThis.URL.createObjectURL = (blob) => { captured = blob.content; return "blob:x"; };
  questions.exportQuestions();
  eq(JSON.parse(captured)[0].direction, "up", "direction в экспорте");
  // setQuestions (импорт/пресеты): валидное direction сохраняется, default neutral
  questions.setQuestions([{ id: "q1", question: "S?", type: "score", levels: ["a", "b"], direction: "down" }]);
  eq(state.questions[0].direction, "down", "setQuestions сохраняет direction");
  questions.setQuestions([{ id: "q2", question: "S?", type: "score", levels: ["a", "b"] }]);
  eq(state.questions[0].direction, "neutral", "default neutral");
  // круговой экспорт → импорт
  questions.setQuestions([{ id: "q3", question: "S?", type: "score", levels: ["a", "b"], direction: "up" }]);
  captured = null;
  questions.exportQuestions();
  const exported = JSON.parse(captured);
  eq(exported[0].direction, "up", "direction в файле экспорта");
  questions.setQuestions([]);
  questions.setQuestions(exported);
  eq(state.questions[0].direction, "up", "direction пережил круговой экспорт/импорт");
});
