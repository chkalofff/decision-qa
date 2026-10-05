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

Откройте http://127.0.0.1:8000.

## Настройка облачной модели

1. Страница «Модели» → карточка **Jev (облако) · latest** → поле API-ключа →
   «Сохранить ключ». Ключ хранится локально в `backend\credentials.json`
   (chmod 600 на POSIX; на Windows — обычный файл, не передавайте его никому).
2. Своя облачная модель: «Добавить облачную модель» на той же странице —
   укажите `base_url`, протокол (`systemone`/`decisions`) и ключ.

Бюджет памяти (`GET /api/settings`) на Windows считается через psutil —
кроссплатформенно, на remote-only работу он не влияет.

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
