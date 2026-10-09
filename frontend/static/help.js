// Онбординг / помощь: пошаговый тур по интерфейсу. Тултип «перепрыгивает»
// между элементами (подсветка + пояснение рядом), навигация «Назад»/«Далее»,
// у шагов есть дрилдаун «Подробнее» и структурированное тело (абзацы, буллеты,
// нумерация). Первый шаг — hero-welcome с брендом и оглавлением тем. Демо-шаги
// переключают фоновую страницу (pageMode) и заполняют интерфейс примерами
// через хуки из app.js (onDemoEnter/onDemoExit/onDemoBatch); при закрытии тура
// состояние восстанавливается. Тур вызывается кнопкой «?» в тулбаре в любой
// момент; при первом запуске открывается сам (флаг dq-help-seen).

const SEEN_KEY = "dq-help-seen";

// Шаги тура. target — id подсвечиваемого элемента (без target — по центру),
// section — тема для оглавления, details — пункты дрилдауна «Подробнее»,
// variant: "hero" — увеличенная welcome-карточка с бренд-блоком,
// pageMode — фоновая страница приложения на этом шаге,
// demoRun — на шаге подложить демо-результаты одиночного прогона,
// demoBatch — на шаге подгрузить демо-пакет с готовыми результатами.
export const HELP_STEPS = [
  {
    section: "Смысл и кейсы",
    variant: "hero",
    title: "Задавайте контенту вопросы — получайте решения",
    text: "Представьте: нужно отобрать 200 резюме за час. Разобрать тысячу обращений в поддержку. Проверить, не спам ли это объявление. В каждом случае вы задаёте контенту свои вопросы: «у кандидата есть нужный опыт?», «это жалоба или вопрос?», «насколько вежлив ответ оператора?».\n«Вердикт» делает это автоматически. Вы формулируете вопросы обычными словами — модели нового класса отвечают на них распределением вероятностей: «опыт есть — 85%». А ваши правила превращают ответы в конкретное решение: «взять на собеседование», «на ручную проверку», «отклонить».\nВсё объяснимо: по каждому ответу и решению видно, почему оно такое.",
    details: [
      "Чем отличается от чата с нейросетью: чат выдаёт текст — каждый раз разный и непроверяемый. Здесь — числа (вероятности) и ваши правила: результат воспроизводим и поддаётся аудиту.",
      "Чем отличается от классификатора: классификатор умеет только заранее заданные категории. Здесь вы сами меняете и добавляете вопросы, без переобучения модели.",
      "Объяснимость — не украшение: когда решение оспаривают (кандидат, пользователь, регулятор), вы показываете конкретные ответы и пороги, которые к нему привели, а не «ну, модель так решила».",
    ],
  },
  {
    section: "Как это работает",
    title: "Четыре шага от кейса до решения",
    text: "Разберём на примере модерации объявления.\n1. Добавьте материал — текст, данные или фото (объявление пользователя).\n2. Сформулируйте вопросы: «Это продажа товара?», «Есть признаки спама?», «Есть ли товар на фото?».\n3. Задайте решение: исходы («публиковать», «отклонить», «на ручную проверку») и правила для них — такие же понятные условия с порогами, как и вопросы: «публиковать, если спама меньше 5%».\n4. Запустите проверку — модель ответит вероятностями («продажа — 92%, спам — 3%»), а заданные вами правила в момент прогона превратят ответы в исход. Сомнительные случаи уйдут на ручную проверку — по вашим порогам.\nДальше разберём каждый шаг на живом интерфейсе.",
    details: [
      "И вопросы, и правила решения необязательно писать с нуля: кнопка ✨ «Сгенерировать» в обоих блоках предложит черновик по вашему материалу — подставьте экспертизу и поправьте формулировки и пороги под себя.",
      "Решение считают не модель, а заранее заданные вами правила (пороги, условия \"и\"/\"или\") — их можно объяснить коллегам и проверить вручную.",
    ],
  },
  {
    section: "Модели",
    title: "Модели — кто отвечает на вопросы",
    target: "tb-models",
    text: "В строке сверху — преднастроенные в приложении модели нового класса: они отвечают на ваши вопросы вероятностями («да — 85%»), а не свободным текстом. Показываются те, что отмечены в меню «Модели ▾»; галочка у модели в строке — она участвует в прогоне. Клик по модели — запуск и настройки.",
    details: [
      "Ответ вероятностями, а не текстом — принципиально: числа воспроизводимы, их можно сравнивать между моделями и материалами, пороговить правилами и проверять при аудите. Свободный текст чата так не проверить.",
      "Модели бывают локальные (работают на вашей машине, данные никуда не уходят) и облачные (мощнее, но требуют API-ключ и отправки данных наружу). Иконка 🖼 — модель видит изображения.",
      "Состав строки меняется галочками в меню «Модели ▾» — там же менеджер моделей: скачивание, удаление, полная настройка.",
      "Если результаты сомнительны — отметьте вторую модель и сравните ответы на одном материале: так вы калибруете доверие к модели перед тем, как пустить её на реальный поток.",
    ],
  },
  {
    section: "Режимы",
    title: "Один материал или целый пакет",
    target: "tb-pagemode",
    text: "Две кнопки сверху задают масштаб задачи.\n«Один материал» — проверяете одно письмо, резюме, пост. «Пакет материалов» — прогоняете целую пачку файлов по одним и тем же вопросам: весь пул резюме, все обращения за неделю.\nВопросы и правила решения общие — один раз настроили, работает и там, и там.",
    details: [
      "Типовой путь: отладьте вопросы и пороги на одиночных материалах, где видно каждый ответ, — затем пустите тот же набор на пакет. Одиночный режим — это ваш стенд для калибровки.",
      "Режимы независимы: материал одиночного режима и пакет живут параллельно и не затирают друг друга.",
    ],
  },
  {
    section: "Материалы",
    title: "Материалы — что именно вы проверяете",
    target: "context-card",
    text: "Это всё, о чём модель будет отвечать: текст объявления, данные резюме, фото товара, диалог с клиентом. Любая задача начинается с добавления материала.",
    details: [
      "Текст и JSON — для писем, анкет и структурированных данных; JSON отдаётся модели аккуратно отформатированным.",
      "📎 Изображения — только для моделей с 🖼; остальные их проигнорируют.",
      "В пакете добавляется список файлов; к каждому можно приложить свои изображения.",
      "Материал — единственное, что модель знает о вашем кейсе: если ответы кажутся странными, первым делом проверьте, что в материале вообще есть нужная информация.",
    ],
  },
  {
    section: "Вопросы",
    title: "Вопросы — три способа спросить о материале",
    target: "questions-card",
    text: "Вопросы формулируются обычными словами — модель отвечает на каждый вероятностями. Три типа покрывают разные смыслы:\n• «Да/Нет» — факт или признак: «это спам?», «у кандидата есть опыт с X?».\n• «Выбор» — классификация: «обращение — жалоба, возврат или вопрос?».\n• «Оценка по шкале» — степень или качество: «насколько вежлив ответ оператора?», «насколько обоснована претензия?».\nЧем конкретнее формулировка и описания вариантов — тем стабильнее ответы.",
    details: [
      "✨ «Сгенерировать» предложит черновик вопросов по вашему материалу — подставьте экспертизу и поправьте формулировки.",
      "Хороший вопрос звучит как инструкция для живого асессора: не «нормальное резюме?», а «есть ли измеримые результаты: цифры, метрики, эффект?». Время на формулировки окупается стабильностью ответов.",
      "Вопросы нумеруются (№1, №2…); порядок меняется ↑ ↓ / drag-and-drop — ссылки в правилах решения не ломаются.",
      "\"Что лучше\" направляет подсветку результатов: где ответ хороший, а где повод разобраться.",
    ],
  },
  {
    section: "Решение",
    title: "Решение — от ответов к конкретному действию",
    target: "decision-card",
    text: "Ответы модели сами себя не применят. Здесь вы описываете, что делать с материалом: «опубликовать», «отклонить», «взять на собеседование» — и при каких условиях. Например: «опубликовать, если спама меньше 5%», «сомневаемся — на ручную проверку».\nРешение считают не модель, а ваши правила в момент прогона — поэтому его можно объяснить, и оно одинаково работает на всех прогонах.",
    details: [
      "Порог — это баланс двух цен ошибок: «пропустили плохое» против «зря отклонили хорошее». Жёстче порог — меньше ложных срабатываний, но больше пропусков. Настраивайте под цену ошибки в вашем процессе, а не «на глаз».",
      "Сомнительные случаи не обязаны попадать в крайние исходы: выделите им свой исход «на ручную проверку» — так автоматика берёт на себя очевидное, а люди — пограничное.",
      "Последний исход без условий — \"по умолчанию\" для всего, что не подошло под остальные правила; приложение подскажет, если какие-то случаи не покрыты.",
      "Использовать все вопросы не обязательно — решение может опираться на два-три ключевых.",
      "Галочка «Учитывать в прогоне» временно выключает расчёт, не удаляя правил. ✨ «Сгенерировать» предложит черновик правил.",
    ],
  },
  {
    section: "Проверка",
    title: "Запуск — и наглядные результаты",
    target: "tb-run",
    demoRun: true,
    text: "«Запустить» отправляет материал всем отмеченным моделям. В ответе — по каждому вопросу распределение вероятностей и цветной чип решения. Наведите на решение — краткое объяснение, кликните — полный разбор: какие ответы и правила его дали. Перед коллегами результат защищается цифрами, а не «ну, модель так решила».",
    details: [
      "На этом шаге в фоне — готовый демо-прогон по кейсу модерации: пощёлкайте строки и чип решения, пока тур открыт.",
      "Каждое решение разворачивается в цепочку «ответ → условие → исход» — это и есть объяснимость для аудита: любой спорный случай проверяется по числам, а не на веру.",
      "Одной модели достаточно для повседневной работы: настраивайте вопросы и правила под неё. Если ответы кажутся сомнительными — отметьте вторую модель и сравните на одном материале.",
    ],
  },
  {
    section: "Пакетная проверка",
    title: "Пакет материалов — вся пачка за один запуск",
    target: "tb-pagemode",
    pageMode: "batch",
    demoBatch: true,
    text: "Переключитесь в «Пакет материалов» и загрузите файлы: каждый пройдёт по тем же вопросам и правилам. Результат — таблица: строка — материал, в ячейке — вердикт с объяснением. Скрининг сотен резюме или аудит модерации — за минуты, а не за смену.",
    details: [
      "На этом шаге в фоне — демо-пакет резюме с уже посчитанной таблицей: посмотрите, как выглядят готовые результаты.",
      "Материалы нумеруются (№1, №2…) — номера видны в списке и в таблице, поэтому любую строку результата легко трассировать обратно до исходного файла. К материалу можно приложить изображения.",
      "Пакетные пресеты (меню «Файл» → «Пресеты») — готовые шаблоны типовых процессов (скрининг, модерация, возвраты): откройте близкий к вашему и поправьте под себя вместо настройки с нуля.",
      "Таблицу результатов можно экспортировать — для отчёта руководству или сверки с другими системами.",
    ],
  },
  {
    section: "AI-помощник",
    title: "AI-помощник — коллега, который знает вашу задачу",
    target: "tb-assistant",
    text: "✨ Ассистент видит материалы, вопросы, правила и результаты проверок. Спросите: «почему модель посчитала это спамом?», «предложи вопросы для скрининга дизайнеров», «прогони пробно и покажи, что изменится, если поднять порог». Правки он предлагает карточками «Принять/Отклонить» — без вашего согласия ничего не меняется. Кнопки ✨ «Сгенерировать» в вопросах и решении создают черновики формулировок.",
    details: [
      "Чаты ассистента раздельные для «Одного материала» и «Пакета» — чип в шапке показывает активный режим: контекст одиночного кейса не замусоривает обсуждение пакета и наоборот.",
      "Ассистент хорош для разбора спорных случаев: попросите объяснить конкретный вердикт — он опирается на те же числа и правила, что и интерфейс.",
      "Модель для чата и генераций выбирается внизу панели — можно держать для ответов на вопросы одну модель, а для ассистента — другую, посильнее.",
    ],
  },
  {
    section: "Быстрый старт",
    title: "Попробуйте на готовом кейсе",
    text: "Быстрый путь: меню «Файл» → «Пресеты» — там живые кейсы (модерация, скрининг резюме, возвраты) с материалами, вопросами и готовыми правилами. Откройте пресет, отметьте модель галочкой и нажмите «Запустить». Затем меняйте вопросы под свою задачу и сохраняйте своё как пресет.\nТур всегда под рукой — кнопка «?» в верхней панели.",
    details: [
      "Пресеты — это шаблоны типовых процессов: открыв близкий к вашей задаче, вы получаете рабочие формулировки вопросов и разумные стартовые пороги, которые остаётся подкрутить.",
      "Свой кейс сохраняется через «Файл» → «Сохранить как пресет»; экспорт/импорт JSON — для переноса настроенного кейса между машинами и командами: коллега импортирует файл и получает ваши вопросы и правила один в один.",
    ],
  },
];

// Оглавление: первые шаги каждой темы (порядок первого появления).
function tocSections() {
  const seen = new Map();
  HELP_STEPS.forEach((s, i) => { if (!seen.has(s.section)) seen.set(s.section, i); });
  return [...seen.entries()].map(([section, step]) => ({ section, step }));
}

// Хуки демо-режима — назначаются из app.js (initHelp):
// onPageMode(mode) — переключить фоновую страницу приложения;
// onDemoEnter() — снапшот состояния + заполнить одиночный демо-пример;
// onDemoRun() — подложить демо-результаты одиночного прогона;
// onDemoBatch() — подгрузить демо-пакет с результатами;
// onDemoExit() — восстановить снапшот.
const hooks = {};

let overlay = null; // {backdrop, tip, cur, highlighted, appliedPageMode}

function markSeen() { localStorage.setItem(SEEN_KEY, "1"); }

function clearHighlight() {
  if (overlay && overlay.highlighted) {
    overlay.highlighted.classList.remove("help-highlight");
    overlay.highlighted = null;
  }
}

export function closeHelp() {
  if (!overlay) return;
  clearHighlight();
  overlay.backdrop.remove();
  overlay.tip.remove();
  overlay = null;
  markSeen();
  if (hooks.onDemoExit) { try { hooks.onDemoExit(); } catch { /* восстановление опционально */ } }
}

function positionTip(tip, target, hero) {
  const rect = !hero && target && target.getBoundingClientRect ? target.getBoundingClientRect() : null;
  if (!rect || (!rect.width && !rect.height)) {
    tip.style.left = "50%";
    tip.style.top = "50%";
    tip.style.transform = "translate(-50%, -50%)";
    return;
  }
  tip.style.transform = "";
  const vw = (window.innerWidth || 1024);
  const vh = (window.innerHeight || 768);
  const tw = Math.min(hero ? 620 : 380, vw - 24);
  tip.style.width = tw + "px";
  // сначала под элементом; если не влезает — над ним
  let top = rect.bottom + 12;
  const tipH = tip.offsetHeight || 220;
  if (top + tipH > vh - 12) top = Math.max(12, rect.top - tipH - 12);
  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.max(12, Math.min(left, vw - tw - 12));
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}

// Структурированное тело шага: «• …» подряд — в <ul>, «1. …» — в <ol>,
// остальные строки — абзацы <p>.
function renderBody(body, text) {
  const lines = String(text).split("\n");
  let list = null; // {el, item(tag)}
  const flush = () => { if (list) { body.appendChild(list.el); list = null; } };
  for (const line of lines) {
    const bullet = line.match(/^•\s+(.*)$/);
    const numbered = line.match(/^\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tag !== tag) {
        flush();
        list = { tag, el: document.createElement(tag) };
      }
      const li = document.createElement("li");
      li.textContent = (bullet || numbered)[1];
      list.el.appendChild(li);
    } else {
      flush();
      const p = document.createElement("p");
      p.textContent = line;
      body.appendChild(p);
    }
  }
  flush();
}

// Фоновые действия шага: переключение страницы и демо-пакет — только при
// смене шага, повторный renderStep того же шага не дёргает хуки.
function applyStepSideEffects(step) {
  if (!overlay) return;
  if (step.pageMode && overlay.appliedPageMode !== step.pageMode) {
    overlay.appliedPageMode = step.pageMode;
    if (hooks.onPageMode) { try { hooks.onPageMode(step.pageMode); } catch { /* опционально */ } }
  }
  if (step.demoRun && !overlay.demoRunApplied) {
    overlay.demoRunApplied = true;
    if (hooks.onDemoRun) { try { hooks.onDemoRun(); } catch { /* опционально */ } }
  }
  if (step.demoBatch && !overlay.demoBatchApplied) {
    overlay.demoBatchApplied = true;
    if (hooks.onDemoBatch) { try { hooks.onDemoBatch(); } catch { /* опционально */ } }
  }
}

function renderStep() {
  const { tip, cur } = overlay;
  const step = HELP_STEPS[cur];
  clearHighlight();
  tip.innerHTML = "";
  tip.classList.toggle("hero", step.variant === "hero");

  const head = document.createElement("div");
  head.className = "help-tip-head";
  let lead;
  if (step.variant === "hero") {
    const brand = document.createElement("div");
    brand.className = "help-brand";
    const icon = document.createElement("span");
    icon.className = "help-brand-icon";
    icon.textContent = "⚖️";
    const name = document.createElement("span");
    name.className = "help-brand-name";
    name.textContent = "Вердикт";
    brand.append(icon, name);
    lead = brand;
  } else {
    const title = document.createElement("span");
    title.className = "help-tip-title";
    title.textContent = step.title;
    lead = title;
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "banner-close";
  close.title = "Закрыть (Esc)";
  close.textContent = "×";
  close.addEventListener("click", closeHelp);
  head.append(lead, close);
  tip.appendChild(head);

  const body = document.createElement("div");
  body.className = "help-tip-body";
  renderBody(body, step.text);
  tip.appendChild(body);

  if (step.details && step.details.length) {
    const det = document.createElement("details");
    det.className = "help-tip-details";
    const sum = document.createElement("summary");
    sum.textContent = "Подробнее";
    det.appendChild(sum);
    const ul = document.createElement("ul");
    for (const d of step.details) {
      const li = document.createElement("li");
      li.textContent = d;
      ul.appendChild(li);
    }
    det.appendChild(ul);
    tip.appendChild(det);
  }

  if (cur === 0) {
    const toc = document.createElement("div");
    toc.className = "help-topics";
    for (const t of tocSections()) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "help-topic";
      b.textContent = t.section;
      b.addEventListener("click", () => { overlay.cur = t.step; renderStep(); });
      toc.appendChild(b);
    }
    tip.appendChild(toc);
  }

  const foot = document.createElement("div");
  foot.className = "help-tip-foot";
  const counter = document.createElement("span");
  counter.className = "help-tip-counter";
  counter.textContent = `${cur + 1} / ${HELP_STEPS.length}`;
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "btn btn-small help-skip";
  skip.textContent = "Пропустить";
  skip.addEventListener("click", closeHelp);
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "btn btn-small help-prev";
  prev.textContent = "← Назад";
  prev.disabled = cur === 0;
  prev.addEventListener("click", () => { if (overlay.cur > 0) { overlay.cur -= 1; renderStep(); } });
  const next = document.createElement("button");
  next.type = "button";
  next.className = "btn btn-small btn-primary help-next";
  const last = cur === HELP_STEPS.length - 1;
  next.textContent = last ? "Готово" : "Далее →";
  next.addEventListener("click", () => {
    if (last) { closeHelp(); return; }
    overlay.cur += 1;
    renderStep();
  });
  foot.append(counter, skip, prev, next);
  tip.appendChild(foot);

  const target = step.target ? document.getElementById(step.target) : null;
  if (target) {
    target.classList.add("help-highlight");
    overlay.highlighted = target;
    if (target.scrollIntoView) target.scrollIntoView({ block: "nearest" });
  }
  applyStepSideEffects(step);
  positionTip(tip, target, step.variant === "hero");
}

export function openHelp(startStep = 0) {
  closeHelp();
  const backdrop = document.createElement("div");
  backdrop.className = "help-backdrop";
  const tip = document.createElement("div");
  tip.className = "help-tip";
  document.body.append(backdrop, tip);
  overlay = {
    backdrop, tip,
    cur: Math.max(0, Math.min(startStep, HELP_STEPS.length - 1)),
    highlighted: null, appliedPageMode: null, demoRunApplied: false, demoBatchApplied: false,
  };
  if (hooks.onDemoEnter) { try { hooks.onDemoEnter(); } catch { /* демо опционально */ } }
  renderStep();
}

export function isHelpOpen() { return !!overlay; }

export function initHelp(opts = {}) {
  Object.assign(hooks, opts);
  const btn = document.getElementById("tb-help");
  if (btn) btn.addEventListener("click", () => { if (isHelpOpen()) closeHelp(); else openHelp(0); });
  document.addEventListener && document.addEventListener("keydown", (e) => {
    if (overlay && e.key === "Escape") closeHelp();
  });
  if (!localStorage.getItem(SEEN_KEY)) openHelp(0);
}
