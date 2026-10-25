// Selection, editor controls, clipboard interoperability and dependency dialog.

import { getAuthOwner } from "./auth.js";
import { subscribe } from "./state.js";
import { currentDocument, documentStateVersion } from "./persist.js";
import { setQuestionWorkshopExtension, renderQuestions } from "./questions.js";
import { setDecisionWorkshopExtension, renderDecision } from "./decision.js";
import {
  buildWorkshopEnvelope, readWorkshopClipboard, writeWorkshopClipboard,
  parseWorkshopEnvelope, duplicateWorkshop, planWorkshopPaste, applyWorkshopPaste,
  workshopRuleId,
} from "./workshop.js";

let selection = [];
let anchor = null;
let insertion = null;
let boundDocument = null;
let statusTimer = null;
let pendingPaste = null;
let asyncEpoch = 0;
let structuralRevision = 0;
let structuralSubscribed = false;

const STRUCTURAL_EVENTS = new Set(["context", "questions", "decision", "images", "batch", "pagemode", "results", "review"]);

function capturePasteTicket() {
  const doc = currentDocument();
  return {
    epoch: asyncEpoch + 1,
    docId: doc?.id || null,
    generation: doc?.generation ?? null,
    stateVersion: documentStateVersion(),
    structuralRevision,
    cancel: null,
  };
}

function pasteTicketCurrent(ticket) {
  const doc = currentDocument();
  return pendingPaste === ticket && ticket.epoch === asyncEpoch &&
    ticket.docId === (doc?.id || null) && ticket.generation === (doc?.generation ?? null) &&
    ticket.stateVersion === documentStateVersion() && ticket.structuralRevision === structuralRevision;
}

export function cancelWorkshopAsync() {
  asyncEpoch += 1;
  const pending = pendingPaste;
  pendingPaste = null;
  if (pending?.cancel) pending.cancel();
}

function abortPaste() {
  showWorkshopStatus("Вставка отменена: документ или его структура изменились.");
  return null;
}

function sameRef(left, right) {
  return left && right && left.kind === right.kind && left.id === right.id;
}

function selectedRef(ref) {
  return selection.some(item => sameRef(item, ref));
}

function statusElement() {
  let element = document.getElementById("workshop-status");
  if (!element) {
    element = document.createElement("div");
    element.id = "workshop-status";
    element.className = "workshop-status hidden";
    element.setAttribute("role", "status");
    document.body.appendChild(element);
  }
  return element;
}

function showWorkshopStatus(text) {
  const element = statusElement();
  clearTimeout(statusTimer);
  element.textContent = text;
  element.classList.remove("hidden");
}

function hideWorkshopStatus() {
  clearTimeout(statusTimer);
  statusElement().classList.add("hidden");
}

function insertionLabel() {
  if (!insertion) return "в конец";
  if (insertion.kind === "question") return `после вопроса №${insertion.questionIndex + 1}`;
  if (insertion.kind === "outcome") return `после исхода №${insertion.outcomeIndex + 1}`;
  return `в исход, после правила №${insertion.ruleIndex + 1}`;
}

function refreshWorkshop() {
  const cards = [...document.querySelectorAll("[data-workshop-kind]")];
  const existing = new Set(cards.map(card => `${card.dataset.workshopKind}:${card.dataset.workshopId}`));
  selection = selection.filter(item => existing.has(`${item.kind}:${item.id}`));
  if (anchor && !existing.has(`${anchor.kind}:${anchor.id}`)) anchor = null;
  if (insertion) {
    const card = cards.find(candidate => candidate.dataset.workshopKind === insertion.kind && candidate.dataset.workshopId === insertion.id);
    insertion = card?.workshopInsertion || null;
  }
  for (const card of cards) {
    const ref = { kind: card.dataset.workshopKind, id: card.dataset.workshopId };
    card.classList.toggle("workshop-selected", selectedRef(ref));
    card.classList.toggle("workshop-paste-target", sameRef(insertion, ref));
    const checkbox = card.querySelector(".workshop-select");
    if (checkbox) checkbox.checked = selectedRef(ref);
  }
  if (selection.length) showWorkshopStatus(`Выбрано: ${selection.length} · вставка ${insertionLabel()}`);
  else hideWorkshopStatus();
}

export function resetWorkshopSelection() {
  cancelWorkshopAsync();
  selection = [];
  anchor = null;
  insertion = null;
  refreshWorkshop();
}

function contextRef(context) {
  if (context.kind === "rule") return { kind: "rule", id: workshopRuleId(context.outcome.id, context.index) };
  return { kind: context.kind, id: context.entity.id };
}

function contextInsertion(context) {
  const ref = contextRef(context);
  if (context.kind === "question") {
    return { ...ref, questionIndex: context.index };
  }
  if (context.kind === "outcome") {
    return {
      ...ref, outcomeIndex: context.index, targetOutcomeId: context.entity.id,
      ruleIndex: (context.entity.rules || []).length - 1,
    };
  }
  return { ...ref, targetOutcomeId: context.outcome.id, ruleIndex: context.index };
}

function orderedRefs(kind) {
  const seen = new Set();
  return [...document.querySelectorAll("[data-workshop-kind]")]
    .filter(card => card.dataset.workshopKind === kind && !seen.has(card.dataset.workshopId) && seen.add(card.dataset.workshopId))
    .map(card => ({ kind, id: card.dataset.workshopId }));
}

function selectWorkshopEntity(ref, { toggle = false, range = false } = {}) {
  const currentInsertion = insertion;
  if (range && anchor?.kind === ref.kind) {
    const ordered = orderedRefs(ref.kind);
    const from = ordered.findIndex(item => sameRef(item, anchor));
    const to = ordered.findIndex(item => sameRef(item, ref));
    if (from >= 0 && to >= 0) {
      selection = ordered.slice(Math.min(from, to), Math.max(from, to) + 1);
    }
  } else if (toggle) {
    if (selectedRef(ref)) selection = selection.filter(item => !sameRef(item, ref));
    else selection.push(ref);
    anchor = ref;
  } else {
    selection = [ref];
    anchor = ref;
  }
  insertion = currentInsertion?.kind === ref.kind ? currentInsertion : null;
  if (!insertion) {
    const card = [...document.querySelectorAll("[data-workshop-kind]")]
      .find(candidate => candidate.dataset.workshopKind === ref.kind && candidate.dataset.workshopId === ref.id);
    if (card?.workshopInsertion) insertion = card.workshopInsertion;
  }
  refreshWorkshop();
}

function actionButton(text, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn workshop-action";
  button.textContent = text;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.onclick = onClick;
  return button;
}

function interactiveTarget(target) {
  return target?.closest("input") || target?.closest("textarea") || target?.closest("select") ||
    target?.closest("button") || target?.closest("[contenteditable]") || target?.closest(".cm-editor");
}

function decorateWorkshopCard(context) {
  const ref = contextRef(context);
  const pastePoint = contextInsertion(context);
  context.card.dataset.workshopKind = ref.kind;
  context.card.dataset.workshopId = ref.id;
  context.card.workshopInsertion = pastePoint;
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "workshop-select";
  checkbox.title = "Выбрать; Ctrl/Cmd — добавить, Shift — диапазон";
  checkbox.setAttribute("aria-label", checkbox.title);
  checkbox.checked = selectedRef(ref);
  checkbox.onclick = event => selectWorkshopEntity(ref, {
    toggle: !!(event.ctrlKey || event.metaKey), range: !!event.shiftKey,
  });
  context.head.insertBefore(checkbox, context.head.children[0] || null);
  context.head.addEventListener("click", event => {
    if (!(event.ctrlKey || event.metaKey || event.shiftKey) || interactiveTarget(event.target)) return;
    event.preventDefault();
    selectWorkshopEntity(ref, { toggle: !!(event.ctrlKey || event.metaKey), range: !!event.shiftKey });
  });
  const actions = document.createElement("span");
  actions.className = "workshop-actions";
  actions.appendChild(actionButton("⧉", "Дублировать", () => {
    const result = duplicateWorkshop(selectedRef(ref) ? selection : [ref]);
    selection = result.inserted;
    anchor = selection[0] || null;
    insertion = pastePoint;
    refreshWorkshop();
  }));
  actions.appendChild(actionButton("⎘", "Копировать", () => {
    if (!selectedRef(ref)) selectWorkshopEntity(ref);
    copyWorkshopSelection();
  }));
  actions.appendChild(actionButton("📋", "Вставить после", () => {
    insertion = pastePoint;
    refreshWorkshop();
    pasteWorkshopAt(pastePoint);
  }));
  const controls = context.controls || context.head;
  controls.insertBefore(actions, controls.children[controls.children.length - 1] || null);
  context.card.classList.toggle("workshop-selected", selectedRef(ref));
  context.card.classList.toggle("workshop-paste-target", sameRef(insertion, ref));
}

export async function copyWorkshopSelection() {
  try {
    const owner = getAuthOwner();
    const envelope = buildWorkshopEnvelope(owner, selection);
    writeWorkshopClipboard(owner, envelope);
    let notice = `Скопировано: ${selection.length}. Внутренний буфер сохранён.`;
    if (globalThis.isSecureContext && globalThis.navigator?.clipboard?.writeText) {
      try {
        await globalThis.navigator.clipboard.writeText(JSON.stringify(envelope));
        notice = `Скопировано: ${selection.length}. Доступно и в системном буфере.`;
      } catch {
        notice = "Системный буфер недоступен — используется внутренняя копия.";
      }
    }
    showWorkshopStatus(notice);
    return envelope;
  } catch (error) {
    showWorkshopStatus(error.message);
    return null;
  }
}

async function readClipboard(owner) {
  let fallbackNotice = null;
  if (globalThis.isSecureContext && globalThis.navigator?.clipboard?.readText) {
    try {
      const text = await globalThis.navigator.clipboard.readText();
      try {
        return { envelope: parseWorkshopEnvelope(text, owner), notice: null };
      } catch {
        fallbackNotice = "Системный буфер не содержит копию мастерской — используется внутренняя.";
      }
    } catch {
      fallbackNotice = "Системный буфер недоступен — используется внутренняя копия.";
    }
  }
  return { envelope: readWorkshopClipboard(owner), notice: fallbackNotice };
}

function dependencySummary(plan, choices) {
  const payload = plan.envelope.payload;
  const counts = {
    questions: payload.questions.length,
    outcomes: payload.outcomes.length,
    rules: payload.rules.length + payload.outcomes.reduce((sum, item) => sum + (item.entity.rules || []).length, 0),
    add: 0, reuse: 0, map: 0, dangle: 0,
  };
  for (const dependency of plan.dependencies) {
    const action = choices[dependency.key] || dependency.defaultChoice;
    if (action === "add") counts.add += 1;
    if (action === "reuse") counts.reuse += 1;
    if (action === "map") counts.map += 1;
    if (action === "dangle") counts.dangle += 1;
  }
  return `Добавить: вопросы ${counts.questions}, исходы ${counts.outcomes}, правила ${counts.rules}. ` +
    `Зависимости: добавить ${counts.add}, использовать ${counts.reuse}, сопоставить ${counts.map}, висячие ${counts.dangle}.`;
}

function askWorkshopDependencies(ticket, plan) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "preset-dialog-overlay workshop-dependency-overlay";
    overlay.id = "workshop-dependency-dialog";
    const box = document.createElement("div");
    box.className = "preset-dialog-box workshop-dependency-box";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const title = document.createElement("div");
    title.className = "preset-dialog-title";
    title.textContent = "Зависимости перед вставкой";
    const note = document.createElement("div");
    note.className = "workshop-dependency-note";
    note.textContent = "Внутренние ссылки уже переназначены. Выберите обработку внешних зависимостей; несовместимые ID не перезаписываются.";
    const summary = document.createElement("div");
    summary.className = "workshop-dependency-summary";
    summary.id = "workshop-dependency-summary";
    const choices = Object.fromEntries(plan.dependencies.map(dependency => [dependency.key, dependency.defaultChoice]));
    const update = () => { summary.textContent = dependencySummary(plan, choices); };
    const list = document.createElement("div");
    list.className = "workshop-dependency-list";
    const statusLabels = { compatible: "совместимый ID", collision: "конфликт ID", text: "совпадение текста", missing: "отсутствует" };
    for (const dependency of plan.dependencies) {
      const row = document.createElement("label");
      row.className = "workshop-dependency-row";
      const description = document.createElement("span");
      description.textContent = `${dependency.kind === "question" ? "Вопрос" : "Исход"} «${dependency.source.question || dependency.source.label || dependency.sourceId}» · ${statusLabels[dependency.status]}`;
      const select = document.createElement("select");
      select.dataset.dependencyKey = dependency.key;
      for (const choice of dependency.choices) {
        const option = document.createElement("option");
        option.value = choice.value;
        option.textContent = choice.label;
        select.appendChild(option);
      }
      select.value = dependency.defaultChoice;
      select.onchange = () => { choices[dependency.key] = select.value; update(); };
      row.append(description, select);
      list.appendChild(row);
    }
    let finished = false;
    const done = value => {
      if (finished) return;
      finished = true;
      ticket.cancel = null;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(value);
    };
    ticket.cancel = () => done(null);
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "btn";
    apply.id = "workshop-dependency-apply";
    apply.textContent = "Вставить";
    apply.onclick = () => done(choices);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.id = "workshop-dependency-cancel";
    cancel.textContent = "Отмена";
    cancel.onclick = () => done(null);
    const onKey = event => { if (event.key === "Escape") done(null); };
    document.addEventListener("keydown", onKey);
    box.append(title, note, list, summary, apply, cancel);
    overlay.appendChild(box);
    overlay.addEventListener("click", event => { if (event.target === overlay) done(null); });
    document.body.appendChild(overlay);
    update();
  });
}

export async function pasteWorkshopAt(pastePoint = insertion) {
  cancelWorkshopAsync();
  const ticket = capturePasteTicket();
  asyncEpoch = ticket.epoch;
  pendingPaste = ticket;
  try {
    if (!pastePoint) throw new Error("Выберите точку вставки в редакторе.");
    insertion = pastePoint;
    const owner = getAuthOwner();
    const { envelope, notice } = await readClipboard(owner);
    if (!pasteTicketCurrent(ticket)) return abortPaste();
    if (!envelope) throw new Error("Буфер мастерской пуст.");
    const plan = planWorkshopPaste(envelope, { targetOutcomeId: pastePoint.targetOutcomeId || null });
    let choices = {};
    if (plan.dependencies.length) {
      choices = await askWorkshopDependencies(ticket, plan);
      if (!pasteTicketCurrent(ticket)) return abortPaste();
      if (!choices) {
        showWorkshopStatus("Вставка отменена; документ не изменён.");
        return null;
      }
    }
    const confirmedPlan = planWorkshopPaste(envelope, { targetOutcomeId: pastePoint.targetOutcomeId || null });
    if (pendingPaste === ticket) pendingPaste = null;
    const result = applyWorkshopPaste(confirmedPlan, choices, pastePoint);
    selection = result.inserted;
    anchor = selection[0] || null;
    refreshWorkshop();
    showWorkshopStatus(`${notice ? notice + " " : ""}Вставлено: вопросы ${result.questions + result.dependencyQuestions}, исходы ${result.outcomes + result.dependencyOutcomes}, правила ${result.rules}. Использовано ${result.reused}, сопоставлено ${result.mapped}, висячих ${result.dangling}.`);
    return result;
  } catch (error) {
    showWorkshopStatus(error.message);
    return null;
  } finally {
    if (pendingPaste === ticket) pendingPaste = null;
  }
}

function overlayActive() {
  for (const selector of [".preset-dialog-overlay", ".decision-overlay", ".lightbox-overlay", ".preview-overlay", ".help-overlay"]) {
    if ([...document.querySelectorAll(selector)].some(element => !element.classList.contains("hidden"))) return true;
  }
  return [...document.querySelectorAll("[role='dialog']")].some(element => !element.classList.contains("hidden"));
}

export function workshopHotkeyBlocked(target) {
  if (interactiveTarget(target) || overlayActive()) return true;
  return false;
}

export async function handleWorkshopHotkey(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || workshopHotkeyBlocked(event.target)) return false;
  const key = String(event.key || "").toLowerCase();
  if (key === "c" && selection.length) {
    event.preventDefault();
    await copyWorkshopSelection();
    return true;
  }
  if (key === "v" && insertion) {
    event.preventDefault();
    await pasteWorkshopAt(insertion);
    return true;
  }
  return false;
}

export function initWorkshop() {
  setQuestionWorkshopExtension({ decorate: decorateWorkshopCard, rendered: refreshWorkshop });
  setDecisionWorkshopExtension({ decorate: decorateWorkshopCard, rendered: refreshWorkshop });
  if (!structuralSubscribed) {
    structuralSubscribed = true;
    subscribe(event => {
      if (!STRUCTURAL_EVENTS.has(event)) return;
      structuralRevision += 1;
      if (pendingPaste && pendingPaste.structuralRevision !== structuralRevision) cancelWorkshopAsync();
    });
  }
  if (boundDocument !== document) {
    boundDocument = document;
    document.addEventListener("keydown", event => { handleWorkshopHotkey(event); });
  }
  resetWorkshopSelection();
  renderQuestions();
  renderDecision();
}
