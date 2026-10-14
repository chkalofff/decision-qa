# ТЗ: автоматизация визуальных проверок — Этап 2 (walkthrough-скрипт)

Статус: проект, код не писан. Основание: исследование оптимизации визуальных
проверок (окт 2026), меры P4+P5+P2 из интегрированного набора. Этап 1
(правило ширин в AGENTS.md, CSS-контракты) уже реализован.

## 1. Цель и ожидаемый эффект

Сейчас после каждого UI-изменения агент вручную: поднимает сервер, открывает
страницы браузерным инструментом, кликает до нужного состояния, снимает и
просматривает 10–15 скриншотов. Это десятки интерактивных шагов и токенов.

Цель: **одна команда** — `node scripts/visual_walkthrough.mjs [git-diff]` —
на выходе папка кропов ключевых экранов (1440px, а при затронутом layout —
и 550px) + `manifest.json`. Агент просматривает результат 1–3 вызовами
чтения изображений.

Ожидаемый эффект: 5–10× по времени агента на регрессионных UI-изменениях,
2–3× на новых экранах.

Не цели этапа 2: pixel-diff с базлайнами (этап 4, P8), layout-asserts
(этап 4, P9), монтажный контактный лист и текстовый дамп (этап 3, P6/P7).

## 2. Технические опоры (проверено по коду)

- **Ноль npm-зависимостей.** Node `/usr/local/bin/node` v22.16 имеет
  встроенный WebSocket — CDP-клиент пишется на нём (~200 строк).
  `chrome-headless-shell` уже установлен:
  `~/Library/Caches/ms-playwright/chromium_headless_shell-1234/`
  (бинарь внутри, путь резолвится glob'ом).
- **Демо-состояния детерминированы** и доступны без тура:
  `demo-data.js` экспортирует `applyDemoSingleRun()` и
  `applyDemoBatchResults()`; вероятности/скоры захардкожены, `Math.random`
  только во внутренних id (в пиксели не попадает).
- **Спецификация экранов уже существует**: `help.js` экспортирует
  `HELP_STEPS` (12 шагов, у шагов `target`, `demoRun`/`demoBatch`) и
  `openHelp(startStep)`. Скрипт итерирует шаги тура вместо ручной карты —
  покрытие самосинхронизируется с продуктом (P5). Ручные setup'ы — только
  для не-туровых состояний.
- **Две ловушки детерминизма**, обе закрываются сидированием localStorage
  ДО загрузки страницы (CDP `Page.addScriptToEvaluateOnNewDocument`):
  - автостарт тура на чистом профиле → ставим `dq-help-seen = "1"`;
  - восстановление workspace из persist → ставим `dq-workspace-enabled = "0"`
    (или сидируем `dq-workspace` фикстурой там, где она нужна).
- **Приложение** поднимается: `.venv-test/bin/python -m uvicorn
  backend.app:app --port 8XXX` (порт свободный, не 8000 — может быть занят
  рабочим экземпляром). Модели без серверов стабильно в статусе «stopped».
- Переключение страниц: `toolbar.js` экспортирует `setPageMode(mode)`.

## 3. Архитектура

```
scripts/visual_walkthrough.mjs      — точка входа, CLI, оркестрация
scripts/vw/cdp.mjs                  — минимальный CDP-клиент (WebSocket, ~200 строк)
scripts/vw/screens.mjs              — манифест экранов: setup-выражения, кропы, ширины
scripts/vw/filemap.mjs              — таблица «файл → экраны» (P2)
out/visual/<timestamp>/             — кропы PNG + manifest.json (в .gitignore)
```

Всё в `scripts/` (там уже живут run/build-скрипты). `out/` добавить в
`.gitignore` (прецедент: `server/logs/`, `dist/`).

### Жизненный цикл одного прогона

1. Спавн `chrome-headless-shell --remote-debugging-port=0 --headless=new`
   (порт 0 → читаем ws-endpoint из stderr-строки `DevTools listening`).
2. Спавн uvicorn на свободном порту; ждём `GET /api/models` = 200
   (поллинг, таймаут 30с).
3. `Page.addScriptToEvaluateOnNewDocument`: сидирование localStorage
   (`dq-help-seen`, `dq-workspace-enabled`).
4. `Emulation.setDeviceMetricsOverride`: width 1440 (или 550), height 900,
   `deviceScaleFactor: 1`.
5. Для каждого экрана из манифеста:
   - `Page.navigate` → ждём load;
   - `Runtime.evaluate`: setup-выражение (dynamic import модулей,
     `applyDemoSingleRun()` и т.п.);
   - **ожидание по условию** — `waitForFunction`-стиль: поллинг
     `Runtime.evaluate` предиката каждые 100мс, таймаут 10с. Никаких
     `sleep` — иначе flaky с первого дня (инициализация CodeMirror,
     асинхронный `/api/models`);
   - `Page.captureScreenshot` с `clip` (кроп ключевой области,
     `deviceScaleFactor=1` — без даунскейла, мелкий текст/CodeMirror
     читается).
6. Запись `manifest.json`: экран, ширина, файл, clip, статус, setup,
   время. Код выхода 0/1 (любой экран не дошёл до условия → 1 + имя экрана
   в stderr).

### CLI

```
node scripts/visual_walkthrough.mjs              # все экраны, 1440px
node scripts/visual_walkthrough.mjs --narrow     # + прогон 550px
node scripts/visual_walkthrough.mjs --diff       # экраны по git diff (P2)
node scripts/visual_walkthrough.mjs --only tour,results
```

Правило ширин (P1, уже в AGENTS.md) зашивается в `--diff`: diff трогает
`style.css`/`layout.js`/рендер таблиц (`batch.js`, `results.js`) → добавляется
узкий прогон.

## 4. Манифест экранов (`screens.mjs`)

Две группы.

**Туровые (P5, бесплатная синхронизация):** итерация `HELP_STEPS` через
`openHelp(i)`; кроп = карточка тура + target-элемент (boundingRect через
`Runtime.evaluate`, clip по нему с паддингом). Шаги с `demoRun`/`demoBatch`
покрывают «Запуск и результаты», «Разметку», «Пакет материалов».

**Ручные (не-туровые состояния)** — setup через dynamic import + вызовы
экспортов модулей:

| Экран | Setup (суть) | Кроп | 550px |
|---|---|---|---|
| single-results-разметка | `applyDemoSingleRun()` + пометки через `review.js` API (ok/err + комментарий) | `#results-card` | да |
| batch-таблица | `applyDemoBatchResults()` + пометки ячеек | `#batch-results-card` | да |
| batch-фильтры/глушение | то же + включить фильтр модели | то же | да |
| менеджер пресетов | `openPresetsPage()` | `#page-presets` | нет |
| лайтбокс материала | открыть превью из демо-пакета | `.lightbox-overlay` | нет |
| редактор контекста (CodeMirror + свёртка) | `setPageMode("single")`, сидированный JSON | `#context-card` | нет |
| страница моделей | `setPageMode("models")` | `#page-models` | нет |
| меню «Файл ▾» открытое | клик по `tb-menu-btn` | dropdown | нет |

Список — стартовый; формат записи: `{ id, title, widths:[1440], setup,
waitFor, clip }`, где `setup`/`waitFor` — строки JS для `Runtime.evaluate`.

## 5. Таблица «файл → экраны» (`filemap.mjs`, P2)

Принимает `git diff --name-only` (или `--diff` читает сам), печатает и
ограничивает прогон затронутыми экранами. Стартовая таблица:

```
help.js, demo-data.js        → туровые экраны (все 12)
review.js                    → single-results-разметка, batch-таблица
batch.js, results.js, rerun.js → batch-*, single-results-*
presets.js                   → менеджер пресетов
context.js, preview.js, lightbox.js → редактор, лайтбокс
manager.js, toolbar.js       → страница моделей, меню
style.css, layout.js         → ВСЕ экраны + узкий прогон
прочее                       → все экраны (безопасный дефолт)
```

Таблица живёт в коде, не в AGENTS.md (проза-ритуал агент пропускает).
В AGENTS.md (DoD) добавляется одна строка: «визпроверка —
`node scripts/visual_walkthrough.mjs --diff`, просмотр manifest'а».

## 6. Детерминизм и flaky-риски

- Сидирование localStorage до навигации — обязательно (см. §2).
- Все ожидания — поллинг предикатов (`waitFor`), запрещены `sleep`.
- Экраны с живым временем/прогрессом (батч-прогресс показывает `Date.now`)
  — в манифесте помечаются `volatile: true`: снимаются, но в этапе 4 будут
  исключены из pixel-diff.
- Падение одного экрана не роняет прогон: экран помечается failed в
  manifest, итоговый код выхода 1 со списком упавших.
- Повторный запуск на том же коде обязан давать идентичный набор файлов
  (проверка при приёмке).

## 7. Приёмка (Definition of Done этапа)

1. `--diff` на diff'e, трогающем только `review.js`, снимает ровно
   экраны разметки (2–3 PNG), ≤60с wall time.
2. Полный прогон: ≥20 кропов (12 туровых + ручные), 1440px; с `--narrow` —
   плюс 3 узких.
3. Два запуска подряд → побайтово сравнимые PNG для всех не-volatile
   экранов (проверяет детерминизм; допускается AA-шум ≤0.1% пикселей).
4. Искусственная поломка (убрать класс из style.css) → скрипт/контракты
   падают с понятным сообщением.
5. `/usr/local/bin/node frontend/tests/run.mjs` и
   `.venv-test/bin/python -m pytest -q` зелёные; сам скрипт в тесты не
   встроен (он инструмент агента, не CI).
6. AGENTS.md: DoD ссылается на скрипт; ARCHITECTURE.md: раздел про
   инструмент; `.gitignore`: `out/`.

## 8. Трудоёмкость и порядок работ

| Шаг | Содержание | Оценка |
|---|---|---|
| 1 | CDP-клиент (`cdp.mjs`): запуск шелла, navigate/evaluate/screenshot, waitFor-поллинг | 1.5–2 ч |
| 2 | Оркестрация: uvicorn, сидирование, цикл по манифесту, manifest.json, коды выхода | 1–1.5 ч |
| 3 | Туровые экраны через `openHelp(i)` | 0.5–1 ч |
| 4 | Ручные экраны (8 шт) — основная боль: тайминги CodeMirror, async /api/models | 2–3 ч |
| 5 | `--diff` + `filemap.mjs` + правка AGENTS.md/ARCHITECTURE.md/.gitignore | 0.5–1 ч |
| 6 | Приёмка по §7, стабилизация flaky | 1–1.5 ч |

Итого **6–9 часов** (рецензент: 4–8 ч; +буфер на тайминги). Шаги 1–2 —
скелет, вертикально: сначала один экран end-to-end, потом остальные.

## 9. Открытые вопросы (решаются на шаге 1–2, не блокируют)

- Поведение headless-шрифтов vs Chrome пользователя: субпиксельный AA
  отличается; для вердикта глазами несущественно, но для будущего pixel-diff
  (P8) базлайны снимать тем же шеллом.
- Если chrome-headless-shell в кэше playwright исчезнет (чистка кэша) —
  fallback: `chrome --headless=new` из системного Chrome (детектить оба).
- Пометки разметки в setup экрана: если `review.js` не экспортирует удобный
  API установки пометок — добавить тонкий экспорт (продуктовый код, ~10
  строк), это единственное предполагаемое изменение `frontend/static/`.
