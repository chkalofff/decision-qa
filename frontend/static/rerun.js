// Диалог выбора при перепрогоне: «Добавить к результатам» / «Начать с нуля».
// Единый для одиночного режима и пакета. Возвращает Promise:
// "append" — слияние с сохранением разметки, "replace" — полная замена,
// null — отмена (Esc / клик по фону / «Отмена»). Результатов ещё нет —
// диалог не показывается, сразу "replace". При несовместимых входах/режиме/
// температуре append disabled, Enter ничего не выбирает. У legacy без
// температуры append остаётся доступен с предупреждением о неизвестной
// сопоставимости; модели при этом разрешено менять.

import { state } from "./state.js";
import { marksCount } from "./review.js";

function appendCompatibility(scope, options) {
  // Старые вызовы без конфигурации сохраняют прежнее поведение; текущие run()
  // передают свежий fingerprint/режим/температуру своего неизменяемого снапшота.
  if (!options) return { compatible: true, legacyTemperature: false, reasons: [] };
  const meta = (scope === "batch" ? state.batch.resultsMeta : state.resultsMeta) || {};
  // Пакет исторически всегда работал в decisions; у одиночного старый режим
  // хранится внутри results, поэтому отсутствие новых полей не ломает старые сессии.
  const previousMode = meta.runMode ??
    (scope === "batch" ? "decisions" : state.results && state.results.runMode);
  const reasons = [];
  if (!meta.fingerprint) reasons.push("у предыдущего прогона нет fingerprint входных данных");
  else if (meta.fingerprint !== options.fingerprint) {
    reasons.push("изменились материалы, вопросы или правила решения");
  }
  if (!previousMode) reasons.push("режим предыдущего прогона неизвестен");
  else if (previousMode !== options.runMode) reasons.push("изменился режим прогона");
  const legacyTemperature = typeof meta.temperature !== "number" || !Number.isFinite(meta.temperature);
  if (!legacyTemperature && typeof options.temperature === "number" &&
      meta.temperature !== options.temperature) {
    reasons.push("изменилась температура");
  }
  return { compatible: reasons.length === 0, legacyTemperature, reasons };
}

export function askAppendOrReplace(scope, options = null) {
  const hasResults = scope === "batch"
    ? Object.keys(state.batch.results).length > 0
    : !!state.results;
  if (!hasResults) return Promise.resolve("replace");
  // Защита от двойного запуска: повторный Enter на сфокусированной «Запустить»
  // не должен открывать второй диалог поверх (оба run() ждали бы выбора).
  if (document.getElementById("rerun-dialog")) return Promise.resolve(null);
  const compatibility = appendCompatibility(scope, options);
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
    if (!compatibility.compatible) {
      sub.textContent = `Добавление недоступно: ${compatibility.reasons.join("; ")}. ` +
        "Можно только явно начать с нуля или отменить.";
    } else if (compatibility.legacyTemperature) {
      sub.textContent = "Температура предыдущего прогона не сохранена: сопоставимость результатов " +
        "неизвестна. Добавление разрешено для старых сессий, но «Начать с нуля» безопаснее.";
    }
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
    appendBtn.disabled = !compatibility.compatible;
    const appendTitle = document.createElement("strong");
    appendTitle.textContent = compatibility.compatible
      ? "Добавить к результатам (Enter)"
      : "Добавить к результатам";
    const appendDesc = document.createElement("span");
    appendDesc.className = "rerun-desc";
    appendDesc.textContent = compatibility.compatible
      ? "Новые ответы допишутся к текущим; разметка сохранится."
      : compatibility.reasons.join("; ") + ".";
    appendBtn.append(appendTitle, appendDesc);
    appendBtn.onclick = () => { if (!appendBtn.disabled) done("append"); };

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
        if (!compatibility.compatible) {
          // Ни append, ни destructive replace не выбираются по Enter: при
          // несовместимости нужен явный клик по замене либо отмена.
          if (e.preventDefault) e.preventDefault();
          return;
        }
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
