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
    section: "Смысл и кейсы",
    title: "Задавайте контенту вопросы — получайте решения",
    text: "Представьте: нужно отобрать 200 резюме за час. Разобрать тысячу обращений в поддержку. Проверить, не спам ли это объявление. В каждом случае вы задаёте контенту свои вопросы: «у кандидата есть нужный опыт?», «это жалоба или вопрос?», «насколько вежлив ответ оператора?».\n«Вердикт» делает это автоматически. Вы формулируете вопросы обычными словами — модели нового класса отвечают на них распределением вероятностей: «опыт есть — 85%». А ваши правила превращают ответы в конкретное решение: «взять на собеседование», «на ручную проверку», «отклонить».\nВсё объяснимо: по каждому ответу и решению видно, почему оно такое.",
    details: [
      "Чем отличается от чата с нейросетью: чат выдаёт текст — каждый раз разный и непроверяемый. Здесь — числа (вероятности) и ваши правила: результат воспроизводим и поддаётся аудиту.",
      "Чем отличается от классификатора: классификатор умеет только заранее заданные категории. Здесь вы сами меняете и добавляете вопросы, без переобучения модели.",
    ],
  },
  {
    section: "Как это работает",
    title: "Четыре шага от кейса до решения",
    text: "Разберём на примере модерации объявления.\n1. Добавьте материал — текст, данные или фото (объявление пользователя).\n2. Сформулируйте вопросы: «Это продажа товара?», «Есть признаки спама?», «Есть ли товар на фото?».\n3. Запустите проверку — модель ответит вероятностями: «продажа — 92%, спам — 3%».\n4. Решение сработает само: «продажа и не спам → публиковать». Сомнительные случаи уйдут на ручную проверку — по вашим порогам.\nДальше разберём каждый шаг на живом интерфейсе.",
    details: [
      "Решение считают не модель, а заранее заданные вами правила (пороги, условия \"и\"/\"или\") — их можно объяснить и проверить вручную.",
    ],
  },
  {
    section: "Режимы",
    title: "Один материал или целый пакет",
    target: "tb-pagemode",
    text: "Две кнопки сверху задают масштаб задачи.\n«Один материал» — проверяете одно письмо, резюме, пост. «Пакет материалов» — прогоняете целую пачку файлов по одним и тем же вопросам: весь пул резюме, все обращения за неделю.\nВопросы и правила решения общие — один раз настроили, работает и там, и там.",
    details: [
      "Режимы независимы: материал одиночного режима и пакет живут параллельно и не затирают друг друга.",
      "У ассистента для каждого режима свой чат — он понимает, про какой вы говорите.",
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
    ],
  },
  {
    section: "Вопросы",
    title: "Вопросы — три способа спросить о материале",
    target: "questions-card",
    text: "Вопросы формулируются обычными словами — модель отвечает на каждый вероятностями. Три типа покрывают разные смыслы:\n• «Да/Нет» — факт или признак: «это спам?», «у кандидата есть опыт с X?».\n• «Выбор» — классификация: «обращение — жалоба, возврат или вопрос?».\n• «Оценка по шкале» — степень или качество: «насколько вежлив ответ оператора?», «насколько обоснована претензия?».\nЧем конкретнее формулировка и описания вариантов — тем стабильнее ответы.",
    details: [
      "✨ «Сгенерировать» предложит черновик вопросов по вашему материалу — подставьте экспертизу и поправьте формулировки.",
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
      "Последний исход без условий — \"по умолчанию\" для всего, что не подошло под остальные правила; приложение подскажет, если какие-то случаи не покрыты.",
      "Использовать все вопросы не обязательно — решение может опираться на два-три ключевых.",
      "Галочка «Учитывать в прогоне» временно выключает расчёт, не удаляя правил. ✨ «Сгенерировать» предложит черновик правил.",
    ],
  },
  {
    section: "Проверка",
    title: "Запуск — и наглядные результаты",
    target: "tb-run",
    text: "«Запустить» отправляет материал всем отмеченным моделям. В ответе — по каждому вопросу распределение вероятностей и цветной чип решения. Наведите на решение — краткое объяснение, кликните — полный разбор: какие ответы и правила его дали. Перед коллегами результат защищается цифрами, а не «ну, модель так решила».",
    details: [
      "Одной модели достаточно для повседневной работы: настраивайте вопросы и правила под неё. Если ответы кажутся сомнительными — отметьте вторую модель и сравните на одном материале.",
    ],
  },
  {
    section: "Пакетная проверка",
    title: "Пакет материалов — вся пачка за один запуск",
    target: "tb-pagemode",
    text: "Переключитесь в «Пакет материалов» и загрузите файлы: каждый пройдёт по тем же вопросам и правилам. Результат — таблица: строка — материал, в ячейке — вердикт с объяснением. Скрининг сотен резюме или аудит модерации — за минуты, а не за смену.",
    details: [
      "Материалы нумеруются (№1, №2…) — номера видны в списке и в таблице; к материалу можно приложить изображения.",
      "Пакетные пресеты (меню «Файл» → «Пресеты») — готовые наборы кейсов для экспериментов.",
    ],
  },
  {
    section: "Модели",
    title: "Модели — кто отвечает на вопросы",
    target: "tb-models",
    text: "В строке сверху — модели, готовые к работе. Галочка — модель отвечает на вопросы в прогоне; клик по модели — запуск и настройки. Иконка 🖼 — модель видит изображения. Если результаты сомнительны — отметьте вторую модель и сравните ответы на одном материале.",
    details: [
      "Меню «Модели ▾» — менеджер моделей: что показывать в строке, скачивание, удаление, настройки.",
    ],
  },
  {
    section: "AI-помощник",
    title: "AI-помощник — коллега, который знает вашу задачу",
    target: "tb-assistant",
    text: "✨ Ассистент видит материалы, вопросы, правила и результаты проверок. Спросите: «почему модель посчитала это спамом?», «предложи вопросы для скрининга дизайнеров», «прогони пробно и покажи, что изменится, если поднять порог». Правки он предлагает карточками «Принять/Отклонить» — без вашего согласия ничего не меняется. Кнопки ✨ «Сгенерировать» в вопросах и решении создают черновики формулировок.",
    details: [
      "Чаты ассистента раздельные для «Одного материала» и «Пакета» — чип в шапке показывает активный режим.",
      "Модель для чата и генераций выбирается внизу панели.",
    ],
  },
  {
    section: "Быстрый старт",
    title: "Попробуйте на готовом кейсе",
    text: "Быстрый путь: меню «Файл» → «Пресеты» — там живые кейсы (модерация, скрининг резюме, возвраты) с материалами, вопросами и готовыми правилами. Откройте пресет, отметьте модель галочкой и нажмите «Запустить». Затем меняйте вопросы под свою задачу и сохраняйте своё как пресет.\nТур всегда под рукой — кнопка «?» в верхней панели.",
    details: [
      "Свой кейс сохраняется через «Файл» → «Сохранить как пресет»; экспорт/импорт JSON — для переноса между машинами.",
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
