// Selection, editor controls, clipboard interoperability and dependency dialog.

import { getAuthOwner } from "./auth.js";
import { formatRu } from "./ru_plural.js";
import { state, subscribe } from "./state.js";
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
let selectionMode = false;
let lastKind = "question";

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
  statusTimer = setTimeout(hideWorkshopStatus, 4500);
}

function hideWorkshopStatus() {
  clearTimeout(statusTimer);
  statusTimer = null;
  statusElement().classList.add("hidden");
}

function insertionLabel() {
  if (!insertion || !insertion.kind) return "в конец";
  if (insertion.kind === "question") {
    return Number.isInteger(insertion.questionIndex) ? `после вопроса №${insertion.questionIndex + 1}` : null;
  }
  if (insertion.kind === "outcome") {
    return Number.isInteger(insertion.outcomeIndex) ? `после исхода №${insertion.outcomeIndex + 1}` : null;
  }
  if (insertion.kind === "rule") {
    return Number.isInteger(insertion.ruleIndex)
      ? `в выбранный исход, после правила №${insertion.ruleIndex + 1}`
      : "в выбранный исход";
  }
  return null;
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
  }
  if (selection.length) selectionMode = true;
  refreshSelectionPanel();
  refreshSelectionCommands();
  document.querySelectorAll(".workshop-select-command").forEach(button => button.classList.toggle("active", selectionMode));
}

export function resetWorkshopSelection() {
  cancelWorkshopAsync();
  selection = [];
  anchor = null;
  insertion = null;
  selectionMode = false;
  hideWorkshopStatus();
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
  if (selection.length && selection[0].kind !== ref.kind) {
    selection = [];
    anchor = null;
    insertion = null;
    showWorkshopStatus("Прежнее выделение снято: копируем элементы одного типа");
  }
  lastKind = ref.kind;
  selectionMode = true;
  const currentInsertion = insertion;
  if (range && anchor?.kind === ref.kind) {
    const ordered = orderedRefs(ref.kind);
    const from = ordered.findIndex(item => sameRef(item, anchor));
    const to = ordered.findIndex(item => sameRef(item, ref));
    if (from >= 0 && to >= 0) selection = ordered.slice(Math.min(from, to), Math.max(from, to) + 1);
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

function interactiveTarget(target) {
  return target?.closest("input") || target?.closest("textarea") || target?.closest("select") ||
    target?.closest("button") || target?.closest("[contenteditable]") || target?.closest(".cm-editor");
}

function kindLabel(kind, count) {
  if (kind === "question") return formatRu(count, "Вопрос", "Вопроса", "Вопросов");
  if (kind === "outcome") return formatRu(count, "Исход", "Исхода", "Исходов");
  return formatRu(count, "Правило", "Правила", "Правил");
}

function selectionPanel() {
  const activePanel = document.getElementById(state.pageMode === "batch" ? "batch-panel-left" : "panel-left");
  if (!activePanel) return null;
  let panel = activePanel.querySelector(".workshop-selection-panel");
  if (panel) return panel;
  panel = document.createElement("div");
  panel.className = "workshop-selection-panel hidden";
  const main = document.createElement("div");
  main.className = "workshop-selection-main";
  const copyWrap = document.createElement("div");
  const total = document.createElement("strong");
  total.className = "workshop-selection-total";
  const types = document.createElement("div");
  types.className = "workshop-selection-types hint";
  copyWrap.append(total, types);
  const actions = document.createElement("div");
  actions.className = "workshop-selection-actions";
  for (const [action, label] of [["duplicate", "Дублировать"], ["copy", "Копировать"], ["paste", "Вставить сюда"], ["done", "Готово"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action === "duplicate" ? "btn btn-small btn-primary" : action === "done" ? "btn btn-small btn-quiet" : "btn btn-small";
    button.dataset.action = action;
    button.textContent = label;
    actions.appendChild(button);
  }
  main.append(copyWrap, actions);
  const destination = document.createElement("div");
  destination.className = "workshop-selection-destination hint";
  const all = document.createElement("button");
  all.type = "button";
  all.className = "btn btn-small btn-quiet";
  all.dataset.action = "all";
  panel.append(main, destination, all);
  const body = activePanel.querySelector(".panel-body");
  activePanel.insertBefore(panel, body);
  panel.querySelector('[data-action="duplicate"]').onclick = () => {
    if (!selection.length) return;
    const result = duplicateWorkshop(selection);
    selection = result.inserted;
    anchor = selection[0] || null;
    refreshWorkshop();
  };
  panel.querySelector('[data-action="copy"]').onclick = () => { if (selection.length) copyWorkshopSelection(); };
  panel.querySelector('[data-action="paste"]').onclick = () => pasteWorkshopAt(insertion || {});
  panel.querySelector('[data-action="done"]').onclick = () => resetWorkshopSelection();
  panel.querySelector('[data-action="all"]').onclick = () => {
    const refs = orderedRefs(lastKind);
    selection = refs;
    anchor = refs[0] || null;
    const cards = [...document.querySelectorAll(`[data-workshop-kind="${lastKind}"]`)];
    insertion = cards.at(-1)?.workshopInsertion || insertion;
    selectionMode = true;
    refreshWorkshop();
  };
  return panel;
}

function refreshSelectionPanel() {
  const panel = selectionPanel();
  if (!panel) return;
  panel.classList.toggle("hidden", !selectionMode);
  if (!selectionMode) return;
  panel.querySelector(".workshop-selection-total").textContent = `Выбрано: ${selection.length}`;
  panel.querySelector(".workshop-selection-types").textContent = selection.length
    ? kindLabel(lastKind, selection.length)
    : "Клик — один элемент · Ctrl/Cmd — добавить · Shift — диапазон";
  const place = insertionLabel();
  panel.querySelector(".workshop-selection-destination").textContent = place ? `Вставка: ${place}` : "";
  panel.querySelector('[data-action="duplicate"]').disabled = !selection.length;
  panel.querySelector('[data-action="copy"]').disabled = !selection.length;
  panel.querySelector('[data-action="paste"]').disabled = false;
  const all = panel.querySelector('[data-action="all"]');
  all.textContent = lastKind === "question" ? "Выбрать все вопросы"
    : lastKind === "outcome" ? "Выбрать все исходы" : "Выбрать все правила в исходе";
}

function ensureSelectionCommands() {
  for (const cardId of ["questions-card", "decision-card", "batch-questions-card", "batch-decision-card"]) {
    const head = document.getElementById(cardId)?.querySelector(".section-head");
    if (!head || head.querySelector(".workshop-select-command")) continue;
    const side = head.querySelector(".section-actions, .block-collapse-side") || head;
    const paste = document.createElement("button");
    paste.type = "button";
    paste.className = "icon-btn workshop-paste-command";
    paste.textContent = "Вставить";
    paste.title = "Вставить из буфера обмена в конец";
    paste.onclick = () => pasteWorkshopAt({}, cardId.includes("questions") ? "question" : "decision");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-btn workshop-select-command";
    button.textContent = "Выбрать";
    button.title = "Выделение элементов: клик, Ctrl/Cmd, Shift или правая кнопка мыши";
    button.onclick = () => {
      if (selectionMode) resetWorkshopSelection();
      else {
        selectionMode = true;
        lastKind = cardId.includes("questions") ? "question" : "rule";
        refreshWorkshop();
      }
    };
    const collapse = side.querySelector(".block-collapse-btn");
    side.insertBefore(button, collapse || null);
    side.insertBefore(paste, button);
  }
}

function refreshSelectionCommands() {
  for (const cardId of ["questions-card", "decision-card", "batch-questions-card", "batch-decision-card"]) {
    const head = document.getElementById(cardId)?.querySelector(".section-head");
    if (!head) continue;
    const questionsEmpty = cardId.includes("questions");
    const empty = questionsEmpty ? state.questions.length === 0 : !state.decision?.outcomes?.length;
    head.querySelector(".workshop-select-command")?.classList.toggle("hidden", empty);
    head.querySelector(".workshop-paste-command")?.classList.toggle("hidden", !empty);
    if (!questionsEmpty) head.querySelector(".decision-enabled-toggle")?.classList.toggle("hidden", empty);
  }
}

function openWorkshopContextMenu(ref, pastePoint, event) {
  document.querySelector(".workshop-context-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "workshop-context-menu";
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  const duplicate = document.createElement("button");
  duplicate.type = "button";
  duplicate.className = "menu-item";
  duplicate.textContent = "Дублировать";
  duplicate.onclick = () => {
    const result = duplicateWorkshop(selection);
    selection = result.inserted;
    menu.remove();
    refreshWorkshop();
  };
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "menu-item";
  copy.textContent = "Копировать";
  copy.onclick = () => { copyWorkshopSelection(); menu.remove(); };
  const paste = document.createElement("button");
  paste.type = "button";
  paste.className = "menu-item";
  paste.textContent = "Вставить после";
  paste.onclick = () => { insertion = pastePoint; menu.remove(); pasteWorkshopAt(pastePoint); };
  menu.append(duplicate, copy, paste);
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}

function decorateWorkshopCard(context) {
  const ref = contextRef(context);
  const pastePoint = contextInsertion(context);
  context.card.dataset.workshopKind = ref.kind;
  context.card.dataset.workshopId = ref.id;
  context.card.workshopInsertion = pastePoint;
  context.head.addEventListener("click", event => {
    if (interactiveTarget(event.target)) return;
    event.preventDefault();
    selectWorkshopEntity(ref, { toggle: !!(event.ctrlKey || event.metaKey), range: !!event.shiftKey });
  });
  context.head.addEventListener("contextmenu", event => {
    if (interactiveTarget(event.target)) return;
    event.preventDefault();
    selectWorkshopEntity(ref, { toggle: true });
    openWorkshopContextMenu(ref, pastePoint, event);
  });
  context.head.tabIndex = 0;
  context.head.addEventListener("keydown", event => {
    if (event.target !== context.head || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    selectWorkshopEntity(ref, { toggle: true });
  });
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
    let timeout = null;
    try {
      const text = await Promise.race([
        globalThis.navigator.clipboard.readText(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("clipboard read timeout")), 1000); }),
      ]);
      try {
        return { envelope: parseWorkshopEnvelope(text, owner), notice: null };
      } catch {
        fallbackNotice = "Системный буфер не содержит копию мастерской — используется внутренняя.";
      }
    } catch {
      fallbackNotice = "Системный буфер недоступен — используется внутренняя копия.";
    } finally {
      clearTimeout(timeout);
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
    existingQuestions: 0, existingOutcomes: 0, dangling: 0,
  };
  for (const dependency of plan.dependencies) {
    const action = choices[dependency.key];
    if (action === "add") counts[dependency.kind === "question" ? "questions" : "outcomes"] += 1;
    if (action === "reuse" || action === "map") {
      counts[dependency.kind === "question" ? "existingQuestions" : "existingOutcomes"] += 1;
    }
    if (action === "dangle") counts.dangling += 1;
  }
  const added = [
    counts.questions && formatRu(counts.questions, "вопрос", "вопроса", "вопросов"),
    counts.outcomes && formatRu(counts.outcomes, "исход", "исхода", "исходов"),
    counts.rules && formatRu(counts.rules, "правило", "правила", "правил"),
  ].filter(Boolean);
  const lines = [`Будут добавлены: ${added.join(", ")}.`];
  for (const [kind, existing] of [["questions", counts.existingQuestions], ["outcomes", counts.existingOutcomes]]) {
    if (!existing) continue;
    const label = kind === "questions" ? "Связанные вопросы" : "Связанные исходы";
    const used = existing === 1 ? "будет использован" : "будут использованы";
    lines.push(`${label}: ${existing} уже есть в документе и ${used}.`);
  }
  if (counts.dangling) {
    lines.push(`Без связанного вопроса: ${counts.dangling}. Запуск будет заблокирован, пока связь не восстановлена.`);
  }
  const place = insertionLabel();
  if (place) lines.push(`Место: ${place}.`);
  return lines.join("\n");
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
    title.textContent = "Вставка скопированных элементов";
    const summary = document.createElement("div");
    summary.className = "workshop-dependency-summary";
    summary.id = "workshop-dependency-summary";
    const details = document.createElement("details");
    details.className = "workshop-dependency-details";
    const detailsTitle = document.createElement("summary");
    const hasQuestions = plan.dependencies.some(dependency => dependency.kind === "question");
    detailsTitle.textContent = hasQuestions ? "Проверить связанные вопросы" : "Проверить связанные элементы";
    const list = document.createElement("div");
    list.className = "workshop-dependency-list";
    details.append(detailsTitle, list);
    const note = document.createElement("div");
    note.className = "workshop-dependency-note";
    note.textContent = "Существующие данные документа не изменятся.";
    const choices = Object.fromEntries(plan.dependencies.map(dependency => [dependency.key, dependency.defaultChoice || ""]));
    const apply = document.createElement("button");
    const update = () => {
      summary.textContent = dependencySummary(plan, choices);
      apply.disabled = plan.dependencies.some(dependency => !choices[dependency.key]);
    };
    for (const dependency of plan.dependencies) {
      const row = document.createElement("label");
      row.className = "workshop-dependency-row";
      const description = document.createElement("span");
      const kind = dependency.kind === "question" ? "Вопрос" : "Исход";
      description.textContent = `${kind} «${dependency.source.question || dependency.source.label || dependency.sourceId}»`;
      const action = choices[dependency.key];
      const needsChoice = dependency.status === "collision" || !action;
      if (needsChoice) {
        const select = document.createElement("select");
        select.dataset.dependencyKey = dependency.key;
        if (!action) {
          const placeholder = document.createElement("option");
          placeholder.value = "";
          placeholder.textContent = "Выберите действие…";
          select.appendChild(placeholder);
        }
        for (const choice of dependency.choices) {
          const option = document.createElement("option");
          option.value = choice.value;
          option.textContent = choice.label;
          select.appendChild(option);
        }
        select.value = action;
        select.onchange = () => { choices[dependency.key] = select.value; update(); };
        row.append(description, select);
      } else {
        const outcome = document.createElement("span");
        outcome.className = "workshop-dependency-action";
        outcome.textContent = action === "add"
          ? `Будет добавлен как новый ${dependency.kind === "question" ? "вопрос" : "исход"}`
          : "Будет использован существующий";
        row.append(description, outcome);
      }
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
    apply.type = "button";
    apply.className = "btn btn-primary";
    apply.id = "workshop-dependency-apply";
    apply.textContent = "Вставить";
    apply.onclick = () => { if (!apply.disabled) done(choices); };
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.id = "workshop-dependency-cancel";
    cancel.textContent = "Отмена";
    cancel.onclick = () => done(null);
    const onKey = event => { if (event.key === "Escape") done(null); };
    document.addEventListener("keydown", onKey);
    box.append(title, summary, details, note, apply, cancel);
    overlay.appendChild(box);
    overlay.addEventListener("click", event => { if (event.target === overlay) done(null); });
    document.body.appendChild(overlay);
    update();
  });
}

export async function pasteWorkshopAt(pastePoint = insertion, expectedKind = null) {
  cancelWorkshopAsync();
  const ticket = capturePasteTicket();
  asyncEpoch = ticket.epoch;
  pendingPaste = ticket;
  try {
    insertion = pastePoint || {};
    const owner = getAuthOwner();
    const { envelope, notice } = await readClipboard(owner);
    if (!pasteTicketCurrent(ticket)) return abortPaste();
    if (!envelope) throw new Error("Буфер обмена пуст или не содержит совместимых данных Вердикта.");
    const incompatible = expectedKind === "question"
      ? !envelope.payload.questions.length
      : expectedKind === "decision" && !envelope.payload.outcomes.length && !envelope.payload.rules.length;
    if (incompatible) throw new Error("Буфер обмена пуст или данные не подходят для этой секции.");
    const plan = planWorkshopPaste(envelope, { targetOutcomeId: insertion.targetOutcomeId || null });
    let choices = {};
    if (plan.dependencies.length) {
      choices = await askWorkshopDependencies(ticket, plan);
      if (!pasteTicketCurrent(ticket)) return abortPaste();
      if (!choices) {
        showWorkshopStatus("Вставка отменена; документ не изменён.");
        return null;
      }
    }
    const confirmedPlan = planWorkshopPaste(envelope, { targetOutcomeId: insertion.targetOutcomeId || null });
    if (pendingPaste === ticket) pendingPaste = null;
    const result = applyWorkshopPaste(confirmedPlan, choices, insertion);
    selection = result.inserted;
    anchor = selection[0] || null;
    refreshWorkshop();
    const insertedQuestions = result.questions + result.dependencyQuestions;
    const insertedOutcomes = result.outcomes + result.dependencyOutcomes;
    const inserted = [
      insertedQuestions && formatRu(insertedQuestions, "вопрос", "вопроса", "вопросов"),
      insertedOutcomes && formatRu(insertedOutcomes, "исход", "исхода", "исходов"),
      result.rules && formatRu(result.rules, "правило", "правила", "правил"),
    ].filter(Boolean);
    const dangling = result.dangling ? ` Без связанного вопроса: ${result.dangling}; запуск будет заблокирован.` : "";
    showWorkshopStatus(`${notice ? notice + " " : ""}Вставлено: ${inserted.join(", ")}.${dangling}`);
    return result;
  } catch (error) {
    const message = /Буфер мастерской/.test(error.message)
      ? "Буфер обмена пуст или не содержит совместимых данных Вердикта."
      : error.message;
    showWorkshopStatus(message);
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

function workshopPasteHotkeyBlocked(target) {
  return target?.closest("input") || target?.closest("textarea") || target?.closest("select") ||
    target?.closest("[contenteditable]") || target?.closest(".cm-editor") || overlayActive();
}

export async function handleWorkshopHotkey(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  const key = String(event.key || "").toLowerCase();
  if (key === "v") {
    if (workshopPasteHotkeyBlocked(event.target)) return false;
    event.preventDefault();
    await pasteWorkshopAt(insertion || {});
    return true;
  }
  if (workshopHotkeyBlocked(event.target)) return false;
  if (key === "c" && selection.length) {
    event.preventDefault();
    await copyWorkshopSelection();
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
    document.addEventListener("blockcollapse", event => {
      if (event.detail?.collapsed && selectionMode && /questions|decision/.test(event.detail.cardId || "")) {
        resetWorkshopSelection();
      }
    });
  }
  ensureSelectionCommands();
  resetWorkshopSelection();
  renderQuestions(false);
  renderDecision(false);
}
