# Decision-QA

Веб-приложение для постановки вопросов по контексту и получения распределений
вероятностей ответов от локальных LLM через SGLang (`/v1/decisions`, MLX-бэкенд
для Apple Silicon), decision-моделей Cloudflare Clef (MLX-конвертации
mlx-community, `/v1/systemone`) и малой GGUF-модели Laya через llama.cpp
(тот же протокол `/v1/systemone`). Поддерживаются также облачные модели —
любой удалённый сервер с протоколом `/v1/decisions` или `/v1/systemone`.
Несколько моделей работают одновременно, ответы сравниваются.

## Требования

- macOS 14+ на Apple Silicon, Python 3.12, свежий Rust (для сборки SGLang)
- SGLang, установленный из source с MLX-бэкендом (см. «Установка SGLang»)
- ~64 ГБ Unified Memory для двух моделей одновременно (для одной хватит 24–32 ГБ)

## Установка на новом Mac

Если на машине ещё нет git, uv или Python 3.12+, сначала поставь их одной командой:

```bash
bash scripts/install_prereqs_mac.sh
```

Затем само приложение:

```bash
bash scripts/setup_mac.sh   # проверки + venv'ы + зависимости + профиль RAM
bash scripts/run.sh         # uvicorn на :8000 + открытие браузера
```

`setup_mac.sh` идемпотентен: повторный запуск быстро проходит по уже
существующим venv'ам. Он ставит backend (`.venv-test`) и Clef
(`server/clef/.venv`); SGLang и llama.cpp автоматически не ставятся (тяжёлые
source-чекауты) — при их отсутствии скрипт печатает инструкции из разделов
ниже, а sglang-модели выключает в `backend/models_config.json`.

По объёму RAM скрипт настраивает `enabled` в `backend/models_config.json`:

- **≥ 48 ГБ** — все локальные модели доступны (конфиг не меняется);
- **24–48 ГБ** — тяжёлые модели (27B/35B, `peak_gb` > 15) выключаются с
  подсказкой «не хватает RAM, включите позже» (страница «Модели»);
- **< 24 ГБ** — remote-only: все локальные выключены, включена облачная
  `jev-latest`; введите API-ключ на странице «Модели».

Ручные правки конфига не затираются: если `models_config.json` изменён
относительно состояния после прошлого setup, профиль не применяется без
флага `--force`.

## Режим только облачных моделей

На любой машине (включая Windows — см. `docs/windows.md`) достаточно backend'а:

```bash
pip install -r backend/requirements.txt
uvicorn backend.app:app --port 8000
```

На странице «Модели» введите API-ключ в карточке Jev (или добавьте свою
облачную модель с протоколом `systemone`/`decisions`). Локальные модели
выключите чекбоксом «в баре». На Windows запуск локальных моделей отклоняется
backend'ом (раннеры `server/run_*.sh` — POSIX-only).

## Установка SGLang

```bash
git clone https://github.com/sgl-project/sglang.git server/sglang
cd server/sglang
uv venv -p 3.12 .venv && source .venv/bin/activate
rm -f python/pyproject.toml && mv python/pyproject_other.toml python/pyproject.toml
uv pip install -e "python[all_mps]"
```

Примечание: в MLX-бэкенде на момент установки был баг в `overlap_utils.py`
(перенос тензора без device) — в локальной копии он пропатчен
(`server/sglang/python/sglang/srt/managers/overlap_utils.py`, метод `stash`:
`.to(device=..., dtype=...)`). При обновлении SGLang проверьте, что апстрим
уже содержит фикс.

## Запуск

1. Запустите веб-приложение — `bash scripts/run.sh` (при отсутствии
   `.venv-test` подскажет сначала выполнить `scripts/setup_mac.sh`), либо
   вручную:

   ```bash
   pip install -r backend/requirements.txt
   uvicorn backend.app:app --port 8000
   ```

2. Откройте http://127.0.0.1:8000
3. Модели запускаются, останавливаются, скачиваются и настраиваются из UI
   (страница «Модели» или поповер чипа в баре) — backend сам поднимает
   SGLang/Clef/llama.cpp инстансы через раннеры `server/run_*.sh`.
   Логи: `server/logs/`.

Ручной запуск модели без UI:

```bash
MODEL=mlx-community/Qwen3.8-27B-4bit PORT=30001 MEM_FRACTION=0.25 ./server/run_server.sh
```

## Установка Clef (decision-модели)

Модели `clef-flash-9b-4bit` (9B) и `clef-27b-4bit` (27B) — MLX-конвертации
`mlx-community/clef-flash-4bit` и `mlx-community/clef-4bit`. Запускаются
отдельным venv (версии mlx отличаются от SGLang-venv, смешивать нельзя):

```bash
uv venv -p 3.12 server/clef/.venv
uv pip install -p server/clef/.venv -r server/clef/requirements.txt
```

Раннер — `server/run_clef.sh` (скачивает снапшот и поднимает
`clef_mlx.py serve`, `POST /v1/systemone`). Особенности Clef:

- один не-авторегрессионный проход на все вопросы; режим прогона
  («Обычный»/«Быстрый батч»/«Оба») на него не влияет — в результатах он всегда
  помечается как «clef»;
- temperature не применяется (модель детерминирована; повторные прогоны дают
  идентичные ответы);
- контекст до 16k токенов (длинный `state` транкается, как у референса);
- `label_mass` всегда null, `metrics.mode` = "clef".

## Установка Laya (малая GGUF decision-модель)

`laya-04b-q8` — Laya 0.4B (Q8_0, ~0.43 ГБ) из `ggml-org/Laya-GGUF`, протокол
`/v1/systemone` (совместим с адаптером Clef). Важно: brew-сборка llama.cpp
устарела и не грузит Laya (несовпадение размеров тензоров), а `mys/laya-GGUF`
использует кастомную архитектуру TurboLLM и с llama.cpp несовместим. Поэтому
llama.cpp собирается из master:

```bash
git clone --depth 1 https://github.com/ggml-org/llama.cpp server/llama.cpp
cmake -B server/llama.cpp/build -S server/llama.cpp -DGGML_METAL=ON
cmake --build server/llama.cpp/build -j --target llama-server
```

Раннер — `server/run_llamacpp.sh` (бинарник из `server/llama.cpp/build/bin`
с фолбэком на PATH; `-b/-ub 8192` обязательны — дефолтный physical batch 512
меньше типичного промпта Laya; контекст `-c 16384`). Скачивание GGUF —
кнопкой «Скачать» в менеджере моделей или тем же раннером при старте.
Особенности Laya: англоязычная (на русских контекстах слабее Clef), очень
быстрая (0.4B), `metrics.mode` = "systemone".

## Модели и менеджер моделей

Реестр — `backend/models_config.json` (schema v2). Поля записи:

- локальная (`type`: `"sglang"` | `"clef"` | `"llamacpp"`): `key`, `label`,
  `short_label` (короткое имя для чипа бара), `hf_id`, `port`, `peak_gb`
  (оценка пика памяти для бюджета), `download_gb` (размер образа, для
  прогресса скачивания), `enabled`, для sglang ещё `mem_fraction`, для
  llamacpp — `gguf_file`;
- облачная (`type`: `"remote"`): `key`, `label`, `short_label`, `api`
  (`"decisions"` | `"systemone"`), `base_url`, опционально `api_model`
  (имя модели в теле запроса), `enabled`.

Локальные модели добавляются правкой конфига (нужен свободный `port`),
облачные — прямо из UI (форма «Добавить облачную модель»). Все правки из UI
(переименование, вкл/выкл, добавление/удаление облачных) персистятся обратно
в `models_config.json`.

### Страница «Модели» в UI

Третий сегмент переключателя страниц. Карточка модели: статус с живым
обновлением (поллинг 2 с, пока есть запуск/остановка/скачивание, иначе 15 с),
бейджи типа и влезаемости в бюджет (`влезает`/`впритык`/`не влезает`),
переименование (`label`/`short_label`), кнопки «Скачать» (с прогресс-баром
≈%), «Запустить», «Остановить», «Удалить файлы» (очистка HF-кэша), чекбокс
«в баре» (enabled). У облачной карточки — редактируемый `base_url`, поле
API-ключа и удаление из реестра.

Статусы: `not_downloaded`, `stopped`, `starting`, `running`, `stopping`,
`downloading`, `error` (с хвостом лога), для облачных — `no_credentials` и
`unreachable`.

### API-ключи облачных моделей

Хранятся в `backend/credentials.json` (chmod 600), по ключу модели. API
никогда не возвращает ключ наружу — только флаг `has_credentials`. Ключ
уходит в заголовок `Authorization: Bearer …` запросов `/v1/models`,
`/v1/decisions`, `/v1/systemone` и `/v1/chat/completions` этой модели.
Смена ключа или `base_url` из UI сбрасывает кэш health-пробы (TTL 30 с —
поллинг не ходит во внешний API на каждый тик).

В конфиге преднастроены облачные Jev (TypeSafe System One,
`https://api.typesafe.ai`): `jev-latest` (включена) и `jev-preview`
(выключена, включается чекбоксом «в баре» в менеджере). Ключ задаётся
кнопкой «Сохранить ключ» в карточке модели.
Не коммитьте `credentials.json`.

### Бюджет памяти

Бюджет в ГБ: доля от RAM устройства (на 64 ГБ при 0.65 — 41.6 ГБ). Источник
доли по приоритету: `backend/settings.json` (`budget_fraction`, правится из
UI — карточка «Память» на странице «Модели», `GET/PUT /api/settings`) > env
`MODELS_BUDGET_FRACTION` > дефолт 0.65. Перед запуском бэкенд суммирует `peak_gb` уже
запущенных и блокирует старт (HTTP 409), если сумма с новой моделью превысит
бюджет; модель с `peak_gb > бюджет` блокируется всегда (бейдж «не влезает»).
Сообщение об ошибке подсказывает, что остановить.

Остановка работает и для процессов, переживших перезапуск бэкенда: если порт
занят узнаваемым модельным сервером (sglang/clef_mlx/llama-server с этим
портом в командной строке), он останавливается по группе процессов; 409
возвращается только если порт занят посторонним процессом.

Примечание про метрику RSS: у MLX-моделей (особенно clef) основная память
живёт в GPU-heap Metal и не попадает в RSS процесса, поэтому RSS показывается
только для sglang-моделей; для остальных ориентир — `peak_gb`.

Примечание про скачивание/удаление: HF Xet-дедуп делает прогресс и
освобождение места приблизительными (общие чанки между моделями); полная
очистка кэша — `hf cache prune`.

Важные флаги запуска (в `run_server.sh`): `--mamba-radix-cache-strategy no_buffer`,
`--disable-overlap-schedule`, `--disable-radix-cache`, `--mlx-enable-sampling` —
все четыре обязательны для decisions на MLX (см. историю: баги mamba-кэша и
device mismatch, logprobs заперты за флагом sampling).

`RADIX_CACHE=1` включает prefix cache, но для гибридных моделей (linear+full
attention, обе наши) MLX-бэкенд всё равно пересчитывает префикс — ускорения нет
(замерено: 51 с vs 51 с на пресете QA), а воспроизводимость вероятностей
ухудшается. Оставлять выключенным. `--max-total-tokens` (default 8192) задаёт
размер stub-пула KV; без него MLX ставит 256 и длинные контексты (>250 токенов)
отклоняются.

## Использование

Интерфейс v5: верхний рабочий бар (меню слева, модели с запуском/остановкой,
режим прогона, temperature, переключатель страниц, запуск) и двухпанельная
компоновка — слева редактор контекста и вопросов, справа результаты (ширина
панелей меняется перетаскиванием, ⛶ — панель на весь экран, — — свернуть в
restore-вкладку, Esc — вернуть).

1. Вставьте контекст (текст или JSON) или выберите пресет из меню (4 одиночных
   набора + батч-пресет «Скрининг резюме» с 10 готовыми резюме).
   JSON-режим контекста — редактор CodeMirror: подсветка, схлопывание узлов,
   линт ошибок; ⛶ в шапке карточки — редактор на весь экран.
2. Сконструируйте вопросы (Yes/No, Choice 2–26 опций, Score 2–10 уровней;
   у score есть настройка направления шкалы «выше/ниже = лучше»). Карточки
   сворачиваются в одну строку, перетаскиваются (⠿).
3. Выберите модели в чипах бара (запуск/остановка — в поповере чипа), режим
   прогона — «Обычный», «Быстрый батч» (один префилл, ~в 10 раз быстрее,
   ответы зависимы) или «Оба — сравнить» (запросы идут последовательно, чтобы
   метрики каждого были чистыми).
4. Temperature (обычный режим): поповер по кнопке «T = …»; управляет
   решительностью оценки, не выбором победителя.
5. Результаты: одна строка на вопрос (иконка типа, микробар, ответ · %);
   клик — дрилдаун с полным распределением; ховер — тултип распределения
   (в сравнении — у каждой ячейки свой); шапка — сводка и чипы метрик по
   прогонам.
6. Меню → «Экспорт JSON»: вопросы, контекст или всё сразу (снапшот сессии);
   импорт сам определяет тип файла. Формат снапшота «Всё»:
   `{input_format, input, images?, questions?, batch_files?}`, где
   `batch_files` — `[{name, content}]` для текстовых файлов и `[{name, image}]`
   для картинок (image — data URL). Файлы батча входят в экспорт независимо от
   текущей страницы; при импорте с `batch_files` открывается страница «Батч»
   (непустой батч заменяется после подтверждения). Старые файлы без
   `batch_files`/`images` импортируются как раньше.

### Батч файлов

Переключатель «Батч» в баре: загрузите множество файлов-контекстов
(.txt/.md/.json) или примените батч-пресет (10 резюме), задайте один набор
вопросов — прогон пойдёт последовательно по файлам на выбранные модели.
Страница — двухпанельная, как одиночная: слева «Ввод» (файлы + редактор
вопросов, общий со страницей «Одиночный»), справа «Результаты»; панели
сворачиваются/разворачиваются на весь экран (⛶/—, Esc). У строки файла —
превью содержимого (👁, первые 2000 символов, «показать всё», для .json —
pretty-print) и drag&drop порядка за «⠿» (порядок = порядок прогона).
Прогресс — полоса «N из M» с текущим файлом, прошедшим временем и ETA;
строки таблицы появляются по мере готовности; отмена останавливает цикл
между файлами. Результаты — таблица файлы × вопросы с агрегатами, экспорт в
CSV/JSON.

## Тесты

```bash
pytest            # unit-тесты backend, SGLang замокан
RUN_LIVE=1 pytest -m live   # live-smoke против запущенных моделей
/usr/local/bin/node frontend/tests/run.mjs   # фронтенд-тесты (DOM-мок, без браузера)
```

Фронтенд-тесты включают блок «UI-контракт»: инварианты навигации (каждая
страница покидаема), доступности Run и полноты статусов — новая страница или
статус без покрытия роняют тест. См. правило «Definition of Done для UI» в
`AGENTS.md`.

## API

- `GET /api/models` — `{models: [...], device: {ram_gb, budget_gb}}`; поля
  модели: `status` (not_downloaded/stopped/starting/running/stopping/
  downloading/error/no_credentials/unreachable), `progress`/`dl_done_gb` при
  скачивании, `rss_gb` (только sglang), `type`, `api`, `managed`, `enabled`,
  `peak_gb`, `download_gb`, `fit`, `has_credentials`
- `POST /api/models/{key}/start` / `stop` — управление модельными процессами
  (409 — не хватает памяти по бюджету или порт занят посторонним процессом)
- `POST /api/models/{key}/download` — скачивание в HF-кэш (для GGUF —
  с `--include <gguf_file>`)
- `POST /api/models/{key}/delete` — удаление файлов локальной модели из кэша
  (409, если запущена или скачивается)
- `PATCH /api/models/{key}` — правка `label`/`short_label`/`enabled`/
  `base_url` (персистится в конфиг)
- `POST /api/models` — добавление облачной модели `{label, base_url, api,
  api_model?, api_key?}`; `DELETE /api/models/{key}` — удаление облачной
  из реестра (локальную — 422, выключайте через `enabled`)
- `PUT`/`DELETE /api/models/{key}/credentials` — API-ключ облачной модели
- `GET /api/presets` — демо-пресеты (4 одиночных + батч-пресет с полем
  `page: "batch"` и массивом `files` из 10 резюме)
- `POST /api/decide` — `{input, models, questions, temperature?,
  prompt_format_version?, mode?: "decisions"|"fast_batch"}`
  → `{"results": {<model>: {ok, answers, usage, metrics} | {ok: false, error}}}`.
  fast_batch: один префилл на все вопросы через `/v1/chat/completions` с regex-
  ограничением и top_logprobs; `label_mass` всегда null, `metrics.mode` = "fast_batch".
  Диспетчер по протоколу модели (`api`): `systemone` (clef, laya, облачные
  SystemOne) — один не-авторегрессионный проход через `/v1/systemone` в любом
  режиме, temperature игнорируется, `metrics.mode` = "clef"/"systemone";
  `decisions` — `/v1/decisions` или fast_batch. Отключённые (`enabled: false`)
  модели в decide отклоняются с 422.
