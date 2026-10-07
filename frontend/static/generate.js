// LLM-генерация вопросов chat-моделями (локальные sglang/bonsai и облачные):
// общий диалог «модель + описание задачи + чекбокс рассуждения» для менеджера
// пресетов (✨ на странице пресетов) и менеджера вопросов (✨ рядом с
// «+ Вопрос»). Список моделей — GET /api/assistant/models (enabled chat).
// Сетевые вызовы — в api.js, применение результата — в колбэке вызывающей.

import { getAssistantModels } from "./api.js";

// onGenerate(modelKey, task, thinking) — async; бросает Error с текстом баннера.
export async function openGenerateDialog({ title, taskPlaceholder, taskValue = "", onGenerate }) {
  closeGenerateDialog();
  let models = [];
  try {
    models = (await getAssistantModels()).models || [];
  } catch {
    models = [];
  }
  const overlay = document.createElement("div");
  overlay.className = "preset-dialog-overlay";
  overlay.id = "generate-dialog";
  const box = document.createElement("div");
  box.className = "preset-dialog-box";
  const h = document.createElement("div");
  h.className = "preset-dialog-title";
  h.textContent = title;
  box.appendChild(h);

  const sel = document.createElement("select");
  sel.className = "mgr-input";
  sel.id = "generate-model";
  if (!models.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Нет chat-моделей — запустите локальную или добавьте облачную на странице «Модели»";
    sel.appendChild(opt);
  }
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.key;
    opt.textContent = (m.remote ? "☁ " : "") + m.label;
    sel.appendChild(opt);
  }
  box.appendChild(sel);

  const taskIn = document.createElement("textarea");
  taskIn.className = "mgr-input";
  taskIn.id = "generate-task";
  taskIn.rows = 4;
  taskIn.placeholder = taskPlaceholder;
  taskIn.value = taskValue;
  box.appendChild(taskIn);

  const thinkLabel = document.createElement("label");
  thinkLabel.className = "gen-thinking-label";
  const think = document.createElement("input");
  think.type = "checkbox";
  think.id = "generate-thinking";
  thinkLabel.appendChild(think);
  thinkLabel.appendChild(document.createTextNode(
    " Рассуждение (дольше, для сложных контекстов)"));
  box.appendChild(thinkLabel);

  const err = document.createElement("div");
  err.className = "mp-error hidden";
  err.id = "generate-error";
  box.appendChild(err);

  const row = document.createElement("div");
  row.className = "mgr-actions";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.id = "generate-ok";
  ok.className = "btn";
  ok.textContent = "Сгенерировать";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.id = "generate-cancel";
  cancel.className = "btn";
  cancel.textContent = "Отмена";
  cancel.onclick = closeGenerateDialog;
  ok.onclick = async () => {
    const task = taskIn.value.trim();
    if (!sel.value) { showErr("Выберите chat-модель"); return; }
    if (!task) { showErr("Опишите задачу"); return; }
    ok.disabled = true;
    ok.textContent = "Генерация…";
    err.classList.add("hidden");
    try {
      await onGenerate(sel.value, task, think.checked);
      closeGenerateDialog();
    } catch (e) {
      showErr(e.message || String(e));
      ok.disabled = false;
      ok.textContent = "Сгенерировать";
    }
  };
  row.append(ok, cancel);
  box.appendChild(row);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeGenerateDialog(); });
  document.body.appendChild(overlay);

  function showErr(msg) {
    err.textContent = msg;
    err.classList.remove("hidden");
  }
}

export function closeGenerateDialog() {
  const dlg = document.getElementById("generate-dialog");
  if (dlg) dlg.remove();
}
