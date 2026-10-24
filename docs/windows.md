# Decision-QA на Windows (remote-only)

Полноценный запуск с локальными моделями возможен только на macOS (Apple
Silicon): SGLang с MLX-бэкендом, MLX-конвертации Clef и Metal-сборка llama.cpp
привязаны к платформе, а backend управляет модельными процессами через
POSIX-раннеры `server/run_*.sh`. На Windows поддерживается **режим только
облачных моделей**: backend + фронтенд работают, прогоны идут на удалённые
серверы (Jev/TypeSafe или любой свой endpoint с протоколом `/v1/decisions` или
`/v1/systemone`).

## Установка

Требуется Python 3.12+ (python.org или `winget install Python.Python.3.12`).

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python -m pip install -r backend\requirements.txt
```

## Запуск

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run.ps1
```

или вручную:

```powershell
.\.venv\Scripts\python -m uvicorn backend.app:app --port 8000
```

Откройте http://127.0.0.1:8000. Локальный вход без токена не изменился.
Для внешнего доступа создайте Bearer-токен на сервере:

```powershell
.\.venv\Scripts\python scripts\dqa_token.py create alice
.\.venv\Scripts\python scripts\dqa_token.py list
.\.venv\Scripts\python scripts\dqa_token.py revoke <prefix>
```

Сырой токен показывается только при создании. Файл
`backend\access_tokens.json` содержит только SHA-256 и метаданные, но на
Windows POSIX chmod 600 не применяется: ограничьте доступ к установочной
папке средствами ACL и не передавайте её другим пользователям. То же
относится к `server\state\` (per-user пресеты/журналы и SQLite-квитанции).
Updater сохраняет оба пути; в релизные архивы они не входят.

## Настройка облачной модели

1. Страница «Модели» → карточка **Jev (облако) · latest** → поле API-ключа →
   «Сохранить ключ». Ключ хранится локально в `backend\credentials.json`
   (chmod 600 на POSIX; на Windows — обычный файл, не передавайте его никому).
2. Своя облачная модель: «Добавить облачную модель» на той же странице —
   укажите `base_url`, протокол (`systemone`/`decisions`) и ключ.

Бюджет памяти (`GET /api/settings`) на Windows считается через psutil —
кроссплатформенно, на remote-only работу он не влияет.

## CLI через `dqa.cmd`

В архиве есть `cli\bin\dqa.cmd` и `cli\requirements.txt`. Шим сначала выбирает
`.venv-test`, затем `py -3.12`/системный Python и проверяет зависимости. Клиент
переводит stdout/stderr на UTF-8; CSV дополнительно начинается с UTF-8 BOM, а
TTY-table отключает ANSI при неподдерживаемом терминале.

```powershell
py -3.12 -m pip install -r cli\requirements.txt
.\cli\bin\dqa.cmd doctor --server http://localhost:8000
.\cli\bin\dqa.cmd validate "C:\интервью" --config pack.json
.\cli\bin\dqa.cmd run "C:\интервью" --config pack.json `
  --report "C:\reports\run.json" --format csv -o "C:\reports\result.csv"
```

Для сервера на другой машине укажите её адрес и токен администратора, созданный
`dqa_token.py create` на сервере. Не используйте localhost, если backend
на другом хосте, и не передавайте токен аргументом:

```powershell
$env:DQA_SERVER = "https://dqa.example.com"
$env:DQA_TOKEN = "dqa_..."
.\cli\bin\dqa.cmd doctor --format json
```

Пути с кириллицей и пробелами заключайте в кавычки. Для NUL-списков используйте
`--files-from list.bin --null`; для папок с Windows-текстом — явную
`--encoding cp1251`. Поддержка CLI не означает запуск локальных моделей на
Windows: клиенту по-прежнему нужен запущенный сервер Decision-QA с запущенными
моделями здесь или на другой машине.

## Ограничения на Windows

- Нет локальных моделей: SGLang, Clef (`clef_mlx`) и Laya (`llama-server`)
  не запускаются — backend отвечает на start/stop ошибкой «поддерживается
  только на macOS/Linux». Карточки локальных моделей показываются, но кнопки
  запуска/скачивания бесполезны — выключите их чекбоксом «в баре».
- Раннеры `server/run_*.sh` — bash-скрипты (mac/linux-only); управление
  процессами (`os.killpg`, группы процессов) — POSIX-only.
- Live-smoke тесты (`RUN_LIVE=1 pytest -m live`) без локальных моделей
  проверяют только облачные.
- Frontend-тесты требуют Node.js (только для разработки, не для рантайма).
