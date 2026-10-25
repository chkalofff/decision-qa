// Editor-only duplicate/copy/paste operations. Results, review marks, provenance,
// credentials and run state never enter the workshop envelope.

import { state } from "./state.js";
import { renderQuestions } from "./questions.js";
import { renderDecision } from "./decision.js";

export const WORKSHOP_CLIPBOARD_TYPE = "decision-qa.workshop/1";

const clone = value => JSON.parse(JSON.stringify(value));

function freshId(prefix, used) {
  let id;
  do {
    const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "") ||
      `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    id = `${prefix}_${random}`;
  } while (used.has(id));
  used.add(id);
  return id;
}

export function cleanWorkshopQuestion(question) {
  const value = clone(question);
  delete value.collapsed;
  delete value._fresh;
  return value;
}

export function cleanWorkshopOutcome(outcome, { withRules = true } = {}) {
  const value = clone(outcome);
  delete value.collapsed;
  if (!withRules) value.rules = [];
  return value;
}

export function cleanWorkshopRule(rule) {
  return clone(rule);
}

const ruleIdentities = new WeakMap();
let nextRuleIdentity = 1;

function stableRuleId(outcomeId, rule) {
  if (!ruleIdentities.has(rule)) ruleIdentities.set(rule, nextRuleIdentity++);
  return `${outcomeId}:r${ruleIdentities.get(rule)}`;
}

export function workshopRuleId(outcomeId, ruleIndex) {
  const outcome = outcomes().find(item => item.id === outcomeId);
  const rule = outcome?.rules?.[ruleIndex];
  return rule ? stableRuleId(outcomeId, rule) : `${outcomeId}:missing`;
}

function outcomes() {
  if (!state.decision) state.decision = { enabled: true, outcomes: [] };
  return state.decision.outcomes;
}

function ruleSelectionEntry(id) {
  for (const [outcomeIndex, outcome] of outcomes().entries()) {
    for (const [ruleIndex, entity] of (outcome.rules || []).entries()) {
      if (stableRuleId(outcome.id, entity) === id) {
        return { kind: "rule", id, outcomeId: outcome.id, outcomeIndex, ruleIndex, index: ruleIndex, entity };
      }
    }
  }
  return null;
}

function selectionEntries(selection) {
  const entries = [];
  for (const item of selection || []) {
    if (item.kind === "question") {
      const index = state.questions.findIndex(question => question.id === item.id);
      if (index >= 0) entries.push({ kind: "question", id: item.id, index, entity: state.questions[index] });
    } else if (item.kind === "outcome") {
      const index = outcomes().findIndex(outcome => outcome.id === item.id);
      if (index >= 0) entries.push({ kind: "outcome", id: item.id, index, entity: outcomes()[index] });
    } else if (item.kind === "rule") {
      const entry = ruleSelectionEntry(item.id);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function collectWorkshop(selection) {
  const entries = selectionEntries(selection);
  const selectedOutcomes = new Set(entries.filter(entry => entry.kind === "outcome").map(entry => entry.id));
  const questions = entries.filter(entry => entry.kind === "question")
    .sort((left, right) => left.index - right.index)
    .map(entry => ({ sourceId: entry.id, entity: cleanWorkshopQuestion(entry.entity), index: entry.index }));
  const selectedOutcomesList = entries.filter(entry => entry.kind === "outcome")
    .sort((left, right) => left.index - right.index)
    .map(entry => ({ sourceId: entry.id, entity: cleanWorkshopOutcome(entry.entity), index: entry.index }));
  const rules = entries.filter(entry => entry.kind === "rule" && !selectedOutcomes.has(entry.outcomeId))
    .sort((left, right) => left.outcomeIndex - right.outcomeIndex || left.ruleIndex - right.ruleIndex)
    .map(entry => ({
      sourceOutcomeId: entry.outcomeId,
      entity: cleanWorkshopRule(entry.entity),
      outcomeIndex: entry.outcomeIndex,
      ruleIndex: entry.ruleIndex,
    }));
  if (!questions.length && !selectedOutcomesList.length && !rules.length) {
    throw new Error("Выберите вопросы, исходы или правила для копирования.");
  }
  return { questions, outcomes: selectedOutcomesList, rules };
}

function questionReferences(payload) {
  const references = new Set();
  for (const outcome of payload.outcomes) {
    for (const rule of outcome.entity.rules || []) {
      for (const condition of rule.conditions || []) if (condition.question) references.add(condition.question);
    }
  }
  for (const rule of payload.rules) {
    for (const condition of rule.entity.conditions || []) if (condition.question) references.add(condition.question);
  }
  return references;
}

export function buildWorkshopEnvelope(owner, selection) {
  const payload = collectWorkshop(selection);
  const internalQuestions = new Set(payload.questions.map(item => item.sourceId));
  const internalOutcomes = new Set(payload.outcomes.map(item => item.sourceId));
  const dependencies = { questions: [], outcomes: [] };
  for (const questionId of questionReferences(payload)) {
    if (internalQuestions.has(questionId)) continue;
    const question = state.questions.find(item => item.id === questionId);
    if (!question) throw new Error("Нельзя скопировать группу: описание зависимого вопроса отсутствует.");
    dependencies.questions.push({ sourceId: questionId, entity: cleanWorkshopQuestion(question) });
  }
  for (const rule of payload.rules) {
    if (internalOutcomes.has(rule.sourceOutcomeId)) continue;
    if (dependencies.outcomes.some(item => item.sourceId === rule.sourceOutcomeId)) continue;
    const outcome = outcomes().find(item => item.id === rule.sourceOutcomeId);
    if (!outcome) throw new Error("Нельзя скопировать правило: исход не найден.");
    dependencies.outcomes.push({ sourceId: rule.sourceOutcomeId, entity: cleanWorkshopOutcome(outcome, { withRules: false }) });
  }
  return {
    type: WORKSHOP_CLIPBOARD_TYPE,
    owner,
    createdAt: new Date().toISOString(),
    payload: {
      questions: payload.questions.map(item => ({ sourceId: item.sourceId, entity: item.entity })),
      outcomes: payload.outcomes.map(item => ({ sourceId: item.sourceId, entity: item.entity })),
      rules: payload.rules.map(item => ({ sourceOutcomeId: item.sourceOutcomeId, entity: item.entity })),
    },
    dependencies,
  };
}

export function workshopClipboardKey(owner) {
  return `dq-workshop:${owner}:clipboard`;
}

export function parseWorkshopEnvelope(value, owner) {
  const envelope = typeof value === "string" ? JSON.parse(value) : value;
  if (!envelope || envelope.type !== WORKSHOP_CLIPBOARD_TYPE || envelope.owner !== owner ||
      !envelope.payload || !Array.isArray(envelope.payload.questions) ||
      !Array.isArray(envelope.payload.outcomes) || !Array.isArray(envelope.payload.rules) ||
      !envelope.dependencies || !Array.isArray(envelope.dependencies.questions) ||
      !Array.isArray(envelope.dependencies.outcomes)) {
    throw new Error("Буфер мастерской пуст или содержит данные другой версии/владельца.");
  }
  if (!envelope.payload.questions.length && !envelope.payload.outcomes.length && !envelope.payload.rules.length) {
    throw new Error("Буфер мастерской пуст.");
  }
  return clone(envelope);
}

export function writeWorkshopClipboard(owner, envelope) {
  const validated = parseWorkshopEnvelope(envelope, owner);
  localStorage.setItem(workshopClipboardKey(owner), JSON.stringify(validated));
  return validated;
}

export function readWorkshopClipboard(owner) {
  const raw = localStorage.getItem(workshopClipboardKey(owner));
  return raw ? parseWorkshopEnvelope(raw, owner) : null;
}

function questionSignature(question) {
  return JSON.stringify(cleanWorkshopQuestion({ ...question, id: "" }));
}

function outcomeSignature(outcome) {
  return JSON.stringify(cleanWorkshopOutcome({ ...outcome, id: "" }, { withRules: false }));
}

function dependencyPlan(kind, dependency, targetOutcomeId) {
  const sourceId = dependency.sourceId;
  const source = dependency.entity;
  const existing = kind === "question"
    ? state.questions.filter(item => item.id === sourceId)
    : outcomes().filter(item => item.id === sourceId);
  const signature = kind === "question" ? questionSignature(source) : outcomeSignature(source);
  const compatible = existing.find(item =>
    (kind === "question" ? questionSignature(item) : outcomeSignature(item)) === signature);
  const textMatches = (kind === "question" ? state.questions : outcomes()).filter(item =>
    item.id !== sourceId && (kind === "question" ? questionSignature(item) : outcomeSignature(item)) === signature);
  const choices = [];
  let defaultChoice;
  let status;
  if (compatible) {
    status = "compatible";
    defaultChoice = "reuse";
    choices.push({ value: "reuse", label: `Использовать существующий ${sourceId}` });
  } else if (existing.length) {
    status = "collision";
    defaultChoice = "add";
  } else if (textMatches.length === 1) {
    status = "text";
    defaultChoice = "map";
  } else {
    status = "missing";
    defaultChoice = "add";
  }
  if (textMatches.length === 1) {
    choices.push({ value: "map", label: `Сопоставить с «${textMatches[0].question || textMatches[0].label}»` });
  }
  choices.push({ value: "add", label: kind === "question" ? "Добавить вопрос с новым ID" : "Добавить исход с новым ID" });
  if (kind === "question") choices.push({ value: "dangle", label: "Оставить висячую ссылку — Run будет заблокирован" });
  return {
    key: `${kind}:${sourceId}`, kind, sourceId, source, status, choices, defaultChoice,
    existingId: compatible?.id || null,
    textMatchId: textMatches.length === 1 ? textMatches[0].id : null,
    targetOutcomeId: kind === "outcome" ? targetOutcomeId : undefined,
  };
}

export function planWorkshopPaste(envelope, { targetOutcomeId = null } = {}) {
  const validated = parseWorkshopEnvelope(envelope, envelope.owner);
  const dependencies = [];
  for (const dependency of validated.dependencies.questions) dependencies.push(dependencyPlan("question", dependency));
  if (!targetOutcomeId) {
    for (const dependency of validated.dependencies.outcomes) dependencies.push(dependencyPlan("outcome", dependency));
  }
  return { envelope: validated, dependencies, targetOutcomeId };
}

function remapRule(rule, questionMap) {
  const mapped = cleanWorkshopRule(rule);
  for (const condition of mapped.conditions || []) {
    if (condition.question && questionMap.has(condition.question)) condition.question = questionMap.get(condition.question);
  }
  return mapped;
}

function normalizeDefaults(clones) {
  let hasDefault = outcomes().some(outcome => outcome.isDefault);
  for (const outcome of clones) {
    outcome.isDefault = !!outcome.isDefault && !hasDefault;
    if (outcome.isDefault) hasDefault = true;
  }
}

function renderWorkshop() {
  renderQuestions();
  renderDecision();
}

export function duplicateWorkshop(selection) {
  const payload = collectWorkshop(selection);
  const usedQuestions = new Set(state.questions.map(question => question.id));
  const usedOutcomes = new Set(outcomes().map(outcome => outcome.id));
  const questionMap = new Map(payload.questions.map(item => [item.sourceId, freshId("q", usedQuestions)]));
  const outcomeMap = new Map(payload.outcomes.map(item => [item.sourceId, freshId("o", usedOutcomes)]));
  const questionClones = payload.questions.map(item => ({
    ...clone(item.entity), id: questionMap.get(item.sourceId), collapsed: true, _fresh: false,
  }));
  const outcomeClones = payload.outcomes.map(item => ({
    ...clone(item.entity),
    id: outcomeMap.get(item.sourceId),
    collapsed: false,
    rules: (item.entity.rules || []).map(rule => remapRule(rule, questionMap)),
  }));
  normalizeDefaults(outcomeClones);
  const questionIndex = payload.questions.length
    ? Math.max(...payload.questions.map(item => item.index)) + 1 : state.questions.length;
  const outcomeIndex = payload.outcomes.length
    ? Math.max(...payload.outcomes.map(item => item.index)) + 1 : outcomes().length;
  state.questions.splice(questionIndex, 0, ...questionClones);
  outcomes().splice(outcomeIndex, 0, ...outcomeClones);
  const inserted = [
    ...questionClones.map(entity => ({ kind: "question", id: entity.id })),
    ...outcomeClones.map(entity => ({ kind: "outcome", id: entity.id })),
  ];
  const rulesByOutcome = new Map();
  for (const rule of payload.rules) {
    const outcomeId = outcomeMap.get(rule.sourceOutcomeId) || rule.sourceOutcomeId;
    if (!rulesByOutcome.has(outcomeId)) rulesByOutcome.set(outcomeId, []);
    rulesByOutcome.get(outcomeId).push(rule);
  }
  for (const [outcomeId, rules] of rulesByOutcome) {
    const outcome = outcomes().find(item => item.id === outcomeId);
    if (!outcome) throw new Error("Исход для дублирования правила не найден.");
    const index = Math.max(...rules.map(rule => rule.ruleIndex)) + 1;
    const clones = rules.map(rule => remapRule(rule.entity, questionMap));
    outcome.rules.splice(index, 0, ...clones);
    clones.forEach((rule, offset) => inserted.push({ kind: "rule", id: workshopRuleId(outcomeId, index + offset) }));
  }
  renderWorkshop();
  return {
    questions: questionClones.length,
    outcomes: outcomeClones.length,
    rules: payload.rules.length + outcomeClones.reduce((sum, outcome) => sum + outcome.rules.length, 0),
    inserted,
  };
}

export function applyWorkshopPaste(plan, choices = {}, insertion = {}) {
  const { envelope, dependencies, targetOutcomeId } = plan;
  const usedQuestions = new Set(state.questions.map(question => question.id));
  const usedOutcomes = new Set(outcomes().map(outcome => outcome.id));
  const questionMap = new Map(envelope.payload.questions.map(item => [item.sourceId, freshId("q", usedQuestions)]));
  const outcomeMap = new Map(envelope.payload.outcomes.map(item => [item.sourceId, freshId("o", usedOutcomes)]));
  const counts = {
    questions: 0, outcomes: 0, rules: 0,
    reused: 0, mapped: 0, dependencyQuestions: 0, dependencyOutcomes: 0, dangling: 0,
  };
  const dependencyQuestions = [];
  const dependencyOutcomes = [];
  for (const dependency of dependencies) {
    const action = choices[dependency.key] || dependency.defaultChoice;
    if (!dependency.choices.some(choice => choice.value === action)) throw new Error("Недопустимый выбор зависимости.");
    const map = dependency.kind === "question" ? questionMap : outcomeMap;
    if (action === "reuse") {
      map.set(dependency.sourceId, dependency.existingId);
      counts.reused += 1;
    } else if (action === "map") {
      map.set(dependency.sourceId, dependency.textMatchId);
      counts.mapped += 1;
    } else if (action === "add") {
      const id = dependency.kind === "question" ? freshId("q", usedQuestions) : freshId("o", usedOutcomes);
      map.set(dependency.sourceId, id);
      if (dependency.kind === "question") {
        dependencyQuestions.push({ ...clone(dependency.source), id, collapsed: true, _fresh: false });
        counts.dependencyQuestions += 1;
      } else {
        dependencyOutcomes.push({ ...clone(dependency.source), id, collapsed: false, rules: [] });
        counts.dependencyOutcomes += 1;
      }
    } else if (action === "dangle") {
      map.set(dependency.sourceId, freshId("q_missing", usedQuestions));
      counts.dangling += 1;
    }
  }
  const questionClones = envelope.payload.questions.map(item => ({
    ...clone(item.entity), id: questionMap.get(item.sourceId), collapsed: true, _fresh: false,
  }));
  const outcomeClones = envelope.payload.outcomes.map(item => ({
    ...clone(item.entity),
    id: outcomeMap.get(item.sourceId),
    collapsed: false,
    rules: (item.entity.rules || []).map(rule => remapRule(rule, questionMap)),
  }));
  const allOutcomeClones = [...dependencyOutcomes, ...outcomeClones];
  normalizeDefaults(allOutcomeClones);
  const explicitRules = envelope.payload.rules.map(item => remapRule(item.entity, questionMap));
  const ruleDestinations = [];
  if (explicitRules.length && targetOutcomeId) {
    const destination = [...outcomes(), ...allOutcomeClones].find(outcome => outcome.id === targetOutcomeId);
    if (!destination) throw new Error("Исход для вставки правил не найден.");
    ruleDestinations.push({ destinationId: targetOutcomeId, destination, rules: explicitRules });
  } else if (explicitRules.length) {
    const sourceIds = [...new Set(envelope.payload.rules.map(item => item.sourceOutcomeId))];
    for (const sourceId of sourceIds) {
      const destinationId = outcomeMap.get(sourceId) || sourceId;
      const destination = [...outcomes(), ...allOutcomeClones].find(outcome => outcome.id === destinationId);
      if (!destination) throw new Error("Исход для вставки правил не найден.");
      const rules = envelope.payload.rules.filter(item => item.sourceOutcomeId === sourceId)
        .map(item => remapRule(item.entity, questionMap));
      ruleDestinations.push({ destinationId, destination, rules });
    }
  }
  const questionIndex = Number.isInteger(insertion.questionIndex)
    ? insertion.questionIndex + 1 : state.questions.length;
  const outcomeIndex = Number.isInteger(insertion.outcomeIndex)
    ? insertion.outcomeIndex + 1 : outcomes().length;
  state.questions.splice(questionIndex, 0, ...dependencyQuestions, ...questionClones);
  outcomes().splice(outcomeIndex, 0, ...allOutcomeClones);
  const inserted = [
    ...questionClones.map(entity => ({ kind: "question", id: entity.id })),
    ...outcomeClones.map(entity => ({ kind: "outcome", id: entity.id })),
  ];
  for (const { destinationId, destination, rules } of ruleDestinations) {
    const index = targetOutcomeId && Number.isInteger(insertion.ruleIndex) ? insertion.ruleIndex + 1 : destination.rules.length;
    destination.rules.splice(index, 0, ...rules);
    rules.forEach((rule, offset) => inserted.push({ kind: "rule", id: workshopRuleId(destinationId, index + offset) }));
  }
  counts.questions = questionClones.length;
  counts.outcomes = outcomeClones.length;
  counts.rules = explicitRules.length + outcomeClones.reduce((sum, outcome) => sum + outcome.rules.length, 0);
  renderWorkshop();
  return { ...counts, inserted };
}
