// Онбординг / помощь: пошаговый тур по интерфейсу. Тултип «перепрыгивает»
// между элементами (подсветка + пояснение рядом), навигация «Назад»/«Далее»,
// у шагов есть дрилдаун «Подробнее». Стартовый шаг — оглавление по темам,
// откуда можно прыгнуть в нужный раздел. Тур вызывается кнопкой «?» в тулбаре
// в любой момент; при первом запуске открывается сам (флаг dq-help-seen).

const SEEN_KEY = "dq-help-seen";

// Шаги тура. target — id подсвечиваемого элемента (без target — по центру),
// section — тема для оглавления, details — пункты дрилдауна «Подробнее».
export const HELP_STEPS = [
  {
    section: "Начало",
    title: "Decision-QA — что это",
    text: "Приложение проверяет контент через LLM-модели: вы задаёте контекст и вопросы, " +
      "модель отвечает вероятностями, а правила решения превращают ответы в итоговый вердикт. " +
      "Типовые задачи — модерация контента, скрининг резюме, разбор претензий, QA диалогов.",
    details: [
      "Модель не выдаёт «решение» сама: она отвечает на вопросы, вердикт считается детерминированными правилами — его можно проверить и объяснить.",
      "Это тур: «Далее» ведёт по элементам интерфейса, «Подробнее» раскрывает детали. Ниже — темы, можно прыгнуть сразу в нужную.",
    ],
  },
  {
    section: "Интерфейс",
    title: "Два режима: Одиночный и Батч",
    target: "tb-pagemode",
    text: "«Одиночный» — один контекст (текст, JSON, изображения). «Батч» — сразу много файлов " +
      "с общими вопросами. Вопросы и правила решения общие для обоих режимов. " +
      "Слева — редактор, справа — результаты прогона.",
    details: [
      "Режимы независимы: контекст одиночного и файлы батча живут параллельно и не затирают друг друга.",
      "У ассистента для каждого режима свой чат — он понимает, про какой режим вы говорите.",
    ],
  },
  {
    section: "Модели",
    title: "Бар моделей",
    target: "tb-models",
    text: "Здесь перечислены доступные модели. Точка — статус (зелёная — запущена), " +
      "галочка — модель участвует в прогоне. Клик по модели открывает управление: " +
      "запуск, остановка, настройки. Иконка 🖼 — модель понимает изображения.",
    details: [
      "Локальные модели запускаются и останавливаются прямо из приложения, облачные требуют API-ключ (задаётся в настройках моделей).",
      "Можно выбрать несколько моделей — прогон пойдёт на всех, результаты будет удобно сравнить.",
      "Меню «Модели ▾» — менеджер моделей: видимость в баре, скачивание, удаление, облачные креды.",
    ],
  },
  {
    section: "Контекст",
    title: "Контекст — что проверяем",
    target: "context-card",
    text: "Сюда помещается проверяемый материал: текст, JSON или изображения (📎 — для vision-моделей). " +
      "Контекст — это то, о чём модель будет отвечать на вопросы.",
    details: [
      "Вкладка JSON — для структурированных данных: модель получит их как аккуратно отформатированный текст.",
      "Изображения видят только модели с 🖼; текстовые модели их проигнорируют.",
      "В режиме «Батч» вместо одного контекста — список файлов, к каждому можно приложить свои изображения.",
    ],
  },
  {
    section: "Вопросы",
    title: "Вопросы — что спрашиваем у модели",
    target: "questions-card",
    text: "Модель отвечает на каждый вопрос вероятностью. Типы: Yes/No, «Выбор из вариантов» и " +
      "«Оценка по шкале». Заполняйте формулировку и пояснения вариантов — от них сильно зависит " +
      "качество ответов. «Что лучше» задаёт направление для подсветки результатов.",
    details: [
      "Вопросы нумеруются (№1, №2…) — на эти номера ссылаются условия в правилах решения; порядок меняется кнопками ↑ ↓ и drag-and-drop, связи не ломаются.",
      "Описания «да»/«нет» (вариантов, краёв шкалы) — самое важное место: чёткие критерии дают воспроизводимые ответы.",
      "Кнопка ✨ «Сгенерировать» предложит набор вопросов по контексту — черновик, который стоит проверить и поправить.",
      "Карточки сворачиваются (компактный режим), весь блок «Вопросы» — тоже; счётчик показывает число вопросов.",
    ],
  },
  {
    section: "Решение",
    title: "Решение — правила из ответов",
    target: "decision-card",
    text: "Здесь из ответов собирается итоговый вердикт: исходы («Опубликовать», «Забанить», " +
      "«На ручную проверку»…) с условиями по вопросам — пороги, «и»/«или». Решение считает не " +
      "модель, а детерминированные правила в момент прогона. Не обязательно использовать все вопросы.",
    details: [
      "Последний исход без условий — «по умолчанию»: срабатывает, когда не подошло ничего остального. Система подсветит, если набор правил не покрывает все случаи.",
      "Галочка «Учитывать в прогоне» выключает расчёт решения, не удаляя сами правила.",
      "Цвет исхода используется в результатах; ✨ «Сгенерировать» предложит правила по вопросам и контексту.",
    ],
  },
  {
    section: "Прогон",
    title: "Запуск и результаты",
    target: "tb-run",
    text: "«Запустить» прогоняет контекст по всем выбранным моделям. Рядом (▾) — режим прогона " +
      "и температура. В результатах — вероятности по каждому вопросу и цветной чип решения: " +
      "наведите — краткое объяснение, кликните — полный разбор, почему сработало правило.",
    details: [
      "Режимы: «Обычный» — каждый вопрос отдельно; «Быстрый» — один проход на все вопросы (быстрее, но ответы влияют друг на друга); «Оба» — сравнение рядом.",
      "Температура управляет решительностью оценок (1.0 — как есть), а не выбором победителя.",
      "Направление «что лучше» из вопросов подсвечивает в результатах хорошие и плохие ответы.",
    ],
  },
  {
    section: "Батч",
    title: "Батч — много файлов за раз",
    target: "tb-pagemode",
    text: "В режиме «Батч» (переключатель выше) загружается набор файлов — каждый прогоняется " +
      "по тем же вопросам. К файлу можно приложить изображения. Результаты — таблица: строки — " +
      "файлы, колонки — модели, с исходами решений и нумерацией файлов.",
    details: [
      "Файлы нумеруются (№1, №2…) — номера видны и в списке, и в результатах.",
      "Батч-пресеты (меню «Файл» → «Пресеты») содержат готовые наборы файлов для экспериментов.",
      "Удобно для сравнения моделей на одном и том же наборе кейсов.",
    ],
  },
  {
    section: "AI-функции",
    title: "Ассистент и генерация",
    target: "tb-assistant",
    text: "✨ Ассистент видит контекст, вопросы, правила и результаты прогонов: консультирует, " +
      "предлагает правки карточками «Принять/Отклонить», делает пробные прогоны для проверки " +
      "гипотез. Кнопки ✨ «Сгенерировать» в вопросах и решении создают черновики LLM'ом.",
    details: [
      "Чаты ассистента раздельные для «Одиночного» и «Батча» — чип в шапке панели показывает активный режим.",
      "Предложения ассистента ничего не меняют, пока вы не нажмёте «Принять» в карточке.",
      "Модель для чата и генераций выбирается внизу панели ассистента — общая для всех AI-функций.",
    ],
  },
  {
    section: "Начало",
    title: "Готово — с чего начать",
    text: "Быстрый старт: меню «Файл» → «Пресеты» — готовые примеры с контекстом, вопросами и " +
      "правилами. Загрузите пресет, выберите модель галочкой и нажмите «Запустить». " +
      "Этот тур всегда доступен по кнопке «?» в верхней панели, рядом с переключателем режимов.",
    details: [
      "Пресет можно сохранить из своего настроенного состояния: «Файл» → «Сохранить как пресет».",
      "Экспорт/импорт JSON — в меню «Файл»: перенос вопросов, контекста и батча между машинами.",
    ],
  },
];

// Оглавление: первые шаги каждой темы (порядок первого появления).
function tocSections() {
  const seen = new Map();
  HELP_STEPS.forEach((s, i) => { if (!seen.has(s.section)) seen.set(s.section, i); });
  return [...seen.entries()].map(([section, step]) => ({ section, step }));
}

let overlay = null; // {backdrop, tip, cur, highlighted}

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
}

function positionTip(tip, target) {
  const rect = target && target.getBoundingClientRect ? target.getBoundingClientRect() : null;
  if (!rect || (!rect.width && !rect.height)) {
    tip.style.left = "50%";
    tip.style.top = "50%";
    tip.style.transform = "translate(-50%, -50%)";
    return;
  }
  tip.style.transform = "";
  const vw = (window.innerWidth || 1024);
  const vh = (window.innerHeight || 768);
  const tw = Math.min(380, vw - 24);
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

function renderStep() {
  const { tip, cur } = overlay;
  const step = HELP_STEPS[cur];
  clearHighlight();
  tip.innerHTML = "";

  const head = document.createElement("div");
  head.className = "help-tip-head";
  const title = document.createElement("span");
  title.className = "help-tip-title";
  title.textContent = step.title;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "banner-close";
  close.title = "Закрыть (Esc)";
  close.textContent = "×";
  close.addEventListener("click", closeHelp);
  head.append(title, close);
  tip.appendChild(head);

  const body = document.createElement("div");
  body.className = "help-tip-body";
  body.textContent = step.text;
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
  positionTip(tip, target);
}

export function openHelp(startStep = 0) {
  closeHelp();
  const backdrop = document.createElement("div");
  backdrop.className = "help-backdrop";
  const tip = document.createElement("div");
  tip.className = "help-tip";
  document.body.append(backdrop, tip);
  overlay = { backdrop, tip, cur: Math.max(0, Math.min(startStep, HELP_STEPS.length - 1)), highlighted: null };
  renderStep();
}

export function isHelpOpen() { return !!overlay; }

export function initHelp() {
  const btn = document.getElementById("tb-help");
  if (btn) btn.addEventListener("click", () => { if (isHelpOpen()) closeHelp(); else openHelp(0); });
  document.addEventListener && document.addEventListener("keydown", (e) => {
    if (overlay && e.key === "Escape") closeHelp();
  });
  if (!localStorage.getItem(SEEN_KEY)) openHelp(0);
}
