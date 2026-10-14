// Диалог выбора при перепрогоне: «Добавить к результатам» / «Начать с нуля».
// Единый для одиночного режима и пакета. Возвращает Promise:
// "append" — слияние с сохранением разметки, "replace" — полная замена,
// null — отмена (Esc / клик по фону / «Отмена»). Результатов ещё нет —
// диалог не показывается, сразу "replace".

import { state } from "./state.js";
import { marksCount } from "./review.js";

export function askAppendOrReplace(scope) {
  const hasResults = scope === "batch"
    ? Object.keys(state.batch.results).length > 0
    : !!state.results;
  if (!hasResults) return Promise.resolve("replace");
  // Защита от двойного запуска: повторный Enter на сфокусированной «Запустить»
  // не должен открывать второй диалог поверх (оба run() ждали бы выбора).
  if (document.getElementById("rerun-dialog")) return Promise.resolve(null);
  return new Promise((resolve) => {
    const mc = marksCount(scope);
    const overlay = document.createElement("div");
    overlay.className = "preset-dialog-overlay";
    overlay.id = "rerun-dialog";
    const box = document.createElement("div");
    box.className = "preset-dialog-box";

    const h = document.createElement("div");
    h.className = "preset-dialog-title";
    h.textContent = "Уже есть результаты прогона";
    box.appendChild(h);

    const sub = document.createElement("div");
    sub.className = "rerun-sub";
    sub.textContent = "Выберите, как объединить новый прогон с текущими результатами.";
    box.appendChild(sub);

    const done = (result) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };

    const appendBtn = document.createElement("button");
    appendBtn.type = "button";
    appendBtn.id = "rerun-append";
    appendBtn.className = "rerun-option primary";
    const appendTitle = document.createElement("strong");
    appendTitle.textContent = "Добавить к результатам (Enter)";
    const appendDesc = document.createElement("span");
    appendDesc.className = "rerun-desc";
    appendDesc.textContent = "Новые ответы допишутся к текущим; разметка сохранится.";
    appendBtn.append(appendTitle, appendDesc);
    appendBtn.onclick = () => done("append");

    const replaceBtn = document.createElement("button");
    replaceBtn.type = "button";
    replaceBtn.id = "rerun-replace";
    replaceBtn.className = "rerun-option";
    const replaceTitle = document.createElement("strong");
    replaceTitle.textContent = "Начать с нуля";
    const replaceDesc = document.createElement("span");
    replaceDesc.className = "rerun-desc";
    replaceDesc.textContent =
      `Текущие результаты будут удалены; разметка будет сброшена (${mc.marks} пометок, ${mc.comments} комментариев).`;
    replaceBtn.append(replaceTitle, replaceDesc);
    replaceBtn.onclick = () => done("replace");

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.id = "rerun-cancel";
    cancel.className = "btn rerun-cancel";
    cancel.textContent = "Отмена";
    cancel.onclick = () => done(null);

    box.append(appendBtn, replaceBtn, cancel);
    overlay.appendChild(box);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(null); });
    const onKey = (e) => {
      if (e.key === "Enter") {
        // Кнопка диалога — Enter обрабатывает она сама (клик по ней); любой
        // другой фокус (в т.ч. «Запустить» под оверлеем) — дефолт «Добавить»
        // с глушением дефолтного клика, иначе повторно запустится run().
        if (e.target && e.target.tagName === "BUTTON" && overlay.contains(e.target)) return;
        if (e.preventDefault) e.preventDefault();
        done("append");
      } else if (e.key === "Escape") {
        done(null);
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
  });
}
