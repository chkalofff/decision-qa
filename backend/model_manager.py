"""Реестр моделей, управление процессами (SGLang / clef_mlx / llama-server),
скачивание и удаление, бюджет памяти в ГБ, удалённые модели, метрики."""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

import httpx

try:
    import psutil
except ImportError:  # pragma: no cover
    psutil = None

from backend import credentials as creds
from backend import settings as app_settings

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent
RUN_SERVER = PROJECT_ROOT / "server" / "run_server.sh"
RUN_CLEF = PROJECT_ROOT / "server" / "run_clef.sh"
RUN_LLAMACPP = PROJECT_ROOT / "server" / "run_llamacpp.sh"
LOG_DIR = PROJECT_ROOT / "server" / "logs"
CONFIG_PATH = BACKEND_DIR / "models_config.json"
HF_CACHE = Path.home() / ".cache" / "huggingface" / "hub"

PROBE_TIMEOUT = 2.0
REQUEST_TIMEOUT = 600.0
LOG_TAIL_LINES = 5
# Health-probe облачных моделей кэшируется — поллинг каждые 2/15 с не должен
# ддосить внешний API (а decide дёргает model_status на каждый запуск).
PROBE_CACHE_TTL = 30.0
_probe_cache: dict[str, tuple[float, bool]] = {}  # key → (monotonic, reachable)


def invalidate_remote_probe(key: str) -> None:
    """Сброс кэша пробы — после смены ключа или base_url статус обновится сразу."""
    _probe_cache.pop(key, None)

# Лимит суммарной оценки памяти запущенных моделей: доля от RAM устройства.
# Источник: backend/settings.json > env MODELS_BUDGET_FRACTION > дефолт 0.65.
BUDGET_FRACTION = app_settings.load_budget_fraction()

# Прогресс скачивания из tqdm-строк hf: «1.23G/4.56G» или «45%»
_TQDM_SIZE_RE = re.compile(r"([\d.]+)\s*([GMK])(?:i?B)?/([\d.]+)\s*([GMK])(?:i?B)?")
_TQDM_PCT_RE = re.compile(r"(\d{1,3})%")
_UNIT_GB = {"K": 1e-6, "M": 1e-3, "G": 1.0}


def total_ram_gb() -> float:
    """Объём RAM устройства, ГБ. psutil — кроссплатформенно (macOS/Linux/Windows);
    sysctl hw.memsize — фолбэк без psutil на macOS; иначе консервативный дефолт."""
    if psutil is not None:
        try:
            return psutil.virtual_memory().total / (1024**3)
        except Exception:  # pragma: no cover
            pass
    try:
        out = subprocess.run(["sysctl", "-n", "hw.memsize"],
                             capture_output=True, text=True, timeout=5)
        return int(out.stdout.strip()) / (1024**3)
    except Exception:
        return 32.0  # консервативный фолбэк


TOTAL_RAM_GB = total_ram_gb()
BUDGET_GB = BUDGET_FRACTION * TOTAL_RAM_GB


def set_budget_fraction(fraction: float) -> None:
    """Смена доли бюджета на лету (BUDGET_FRACTION/BUDGET_GB) + персист
    в settings.json. fit()/budget_check читают BUDGET_GB на каждый вызов,
    поэтому новое значение действует сразу. Сначала персист: при ошибке
    записи in-memory значение не меняется."""
    app_settings.save_budget_fraction(fraction)
    global BUDGET_FRACTION, BUDGET_GB
    BUDGET_FRACTION = fraction
    BUDGET_GB = BUDGET_FRACTION * TOTAL_RAM_GB

RUNNERS = {"sglang": RUN_SERVER, "clef": RUN_CLEF, "llamacpp": RUN_LLAMACPP}


class ModelEntry:
    def __init__(self, key: str, label: str, hf_id: str, port: int,
                 mem_fraction: float = 0.85, type: str = "sglang",
                 short_label: str | None = None, peak_gb: float | None = None,
                 download_gb: float | None = None, enabled: bool = True,
                 api: str | None = None, base_url: str | None = None,
                 api_model: str | None = None, gguf_file: str | None = None,
                 vision: bool = False):
        self.key = key
        self.label = label
        self.short_label = short_label or label
        self.hf_id = hf_id
        self.port = port
        self.mem_fraction = mem_fraction
        self.type = type
        self.enabled = enabled
        # peak_gb — оценка пика RAM для бюджета/гейта; дефолт из mem_fraction на 64 ГБ
        self.peak_gb = peak_gb if peak_gb is not None else mem_fraction * 64.0
        self.download_gb = download_gb
        self.api_model = api_model
        self.gguf_file = gguf_file
        self.vision = vision
        self._api = api
        self.base_url = base_url
        # runtime
        self.proc: subprocess.Popen | None = None  # запущен нами
        self.started_at: float | None = None
        self.stopping = False
        self.dl_proc: subprocess.Popen | None = None
        self.dl_progress: float | None = None      # 0..1
        self.dl_done_gb: float | None = None
        self.dl_error: str | None = None

    @property
    def managed(self) -> bool:
        """Локальная модель — процесс, которым мы управляем."""
        return self.type != "remote"

    @property
    def api(self) -> str:
        """Протокол decide-запросов."""
        if self._api:
            return self._api
        return "decisions" if self.type == "sglang" else "systemone"

    @property
    def url(self) -> str:
        if self.base_url:
            return self.base_url.rstrip("/")
        return f"http://127.0.0.1:{self.port}"

    def fit(self) -> str | None:
        """Влезает ли модель в бюджет этого устройства вообще."""
        if not self.managed:
            return None
        if self.peak_gb > BUDGET_GB:
            return "no"
        if self.peak_gb > BUDGET_GB * 0.6:
            return "tight"  # влезает одна, но почти ни с кем
        return "ok"

    def to_config(self) -> dict:
        d: dict = {"key": self.key, "label": self.label, "short_label": self.short_label,
                   "type": self.type, "enabled": self.enabled}
        if self.managed:
            d.update(hf_id=self.hf_id, port=self.port, peak_gb=self.peak_gb,
                     download_gb=self.download_gb)
            if self.type == "sglang":
                d["mem_fraction"] = self.mem_fraction
            if self.gguf_file:
                d["gguf_file"] = self.gguf_file
        else:
            d.update(api=self._api, base_url=self.base_url)
        if self.api_model:
            d["api_model"] = self.api_model
        d["vision"] = self.vision
        return d


def load_registry() -> dict[str, ModelEntry]:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        config = json.load(f)
    return {c["key"]: ModelEntry(c["key"], c["label"], c.get("hf_id", ""), c.get("port", 0),
                                 c.get("mem_fraction", 0.85), c.get("type", "sglang"),
                                 c.get("short_label"), c.get("peak_gb"), c.get("download_gb"),
                                 c.get("enabled", True), c.get("api"), c.get("base_url"),
                                 c.get("api_model"), c.get("gguf_file"),
                                 c.get("vision", False)) for c in config}


REGISTRY: dict[str, ModelEntry] = load_registry()


def save_registry() -> None:
    """Атомарная запись текущего REGISTRY в models_config.json."""
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump([e.to_config() for e in REGISTRY.values()], f,
                  ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, CONFIG_PATH)


def is_downloaded(hf_id: str) -> bool:
    """Модель считается скачанной, если в HF-кэше есть непустой snapshot."""
    cache_dir = HF_CACHE / ("models--" + hf_id.replace("/", "--")) / "snapshots"
    if not cache_dir.is_dir():
        return False
    for snapshot in cache_dir.iterdir():
        if snapshot.is_dir() and any(snapshot.iterdir()):
            return True
    return False


def _auth_headers(entry: ModelEntry) -> dict[str, str]:
    key = creds.get(entry.key)
    return {"Authorization": f"Bearer {key}"} if key else {}


def not_running_message(entry: ModelEntry, status: str) -> str:
    if entry.managed:
        return (f"Модель не запущена (статус: {status}). "
                f"Запустите её: POST /api/models/{entry.key}/start")
    return (f"Модель недоступна (статус: {status}). "
            "Проверьте base_url и API-ключ на странице «Модели».")


def rss_gb_for(entry: ModelEntry) -> float | None:
    """RSS имеет смысл только для локальных процессов (у remote port=0)."""
    return rss_gb(entry.port) if entry.managed else None


async def port_running(port: int) -> bool:
    """На порту отвечает /v1/models — сервер жив (неважно, кем запущен)."""
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT) as client:
            resp = await client.get(f"http://127.0.0.1:{port}/v1/models")
        return resp.status_code == 200
    except httpx.HTTPError:
        return False


async def remote_reachable(entry: ModelEntry) -> bool:
    cached = _probe_cache.get(entry.key)
    if cached is not None and time.monotonic() - cached[0] < PROBE_CACHE_TTL:
        return cached[1]
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT) as client:
            resp = await client.get(f"{entry.url}/v1/models", headers=_auth_headers(entry))
        ok = resp.status_code == 200
    except httpx.HTTPError:
        ok = False
    _probe_cache[entry.key] = (time.monotonic(), ok)
    return ok


def log_tail(key: str, lines: int = LOG_TAIL_LINES) -> str:
    log_file = LOG_DIR / f"{key}.log"
    try:
        content = log_file.read_text(encoding="utf-8", errors="replace")
        return "\n".join(content.splitlines()[-lines:])
    except OSError:
        return ""


def _local_status(entry: ModelEntry, running: bool) -> dict:
    info: dict = {}
    if running:
        if entry.stopping:
            info["status"] = "stopping"
            return info
        info["status"] = "running"
        # RSS бессмыслен для MLX-моделей (память в GPU-heap Metal); показываем для sglang
        info["rss_gb"] = rss_gb(entry.port) if entry.type == "sglang" else None
        return info
    if entry.stopping:
        entry.stopping = False  # порт мёртв — остановка завершена
    info["rss_gb"] = None
    if entry.dl_proc is not None:
        if entry.dl_proc.poll() is None:
            info["status"] = "downloading"
            info["progress"] = entry.dl_progress
            info["dl_done_gb"] = entry.dl_done_gb
            return info
        rc = entry.dl_proc.returncode
        entry.dl_proc = None
        if rc == 0:
            info["status"] = "stopped"
            return info
        info["status"] = "error"
        info["error"] = entry.dl_error or f"Скачивание завершилось с кодом {rc}"
        return info
    if entry.proc is not None:
        if entry.proc.poll() is None:
            info["status"] = "starting"
        else:
            info["status"] = "error"
            info["error"] = (
                f"Процесс завершился с кодом {entry.proc.returncode}. "
                f"Последние строки лога:\n{log_tail(entry.key)}"
            )
            entry.proc = None
        return info
    info["status"] = "stopped" if is_downloaded(entry.hf_id) else "not_downloaded"
    return info


async def model_status(entry: ModelEntry) -> dict:
    info = {"key": entry.key, "label": entry.label, "short_label": entry.short_label,
            "type": entry.type, "api": entry.api, "managed": entry.managed,
            "enabled": entry.enabled, "port": entry.port, "hf_id": entry.hf_id,
            "gguf_file": entry.gguf_file, "base_url": entry.base_url,
            "api_model": entry.api_model, "vision": entry.vision,
            "peak_gb": entry.peak_gb if entry.managed else None,
            "download_gb": entry.download_gb if entry.managed else None,
            "fit": entry.fit(),
            "progress": None, "dl_done_gb": None, "rss_gb": None,
            "has_credentials": creds.has(entry.key) if not entry.managed else False}
    if not entry.managed:
        if not info["has_credentials"]:
            info["status"] = "no_credentials"
        elif await remote_reachable(entry):
            info["status"] = "running"
        else:
            info["status"] = "unreachable"
        return info
    info.update(_local_status(entry, await port_running(entry.port)))
    return info


async def budget_check(entry: ModelEntry) -> str | None:
    """Сообщение об ошибке, если с новой моделью сумма оценок памяти превысит лимит."""
    if entry.fit() == "no":
        return (
            f"Модель {entry.key} не влезает в это устройство: пик ~{entry.peak_gb:.0f} ГБ, "
            f"бюджет моделей {BUDGET_GB:.0f} ГБ (RAM {TOTAL_RAM_GB:.0f} ГБ × "
            f"{BUDGET_FRACTION:.0%}, MODELS_BUDGET_FRACTION)."
        )
    running = [e for e in REGISTRY.values()
               if e.managed and e.key != entry.key and await port_running(e.port)]
    used = sum(e.peak_gb for e in running)
    total = used + entry.peak_gb
    if total <= BUDGET_GB:
        return None
    names = ", ".join(f"{e.key} (~{e.peak_gb:.0f} ГБ)" for e in running)
    return (
        f"Не хватит памяти: уже запущены {names} (итого ~{used:.0f} ГБ). "
        f"С {entry.key} (~{entry.peak_gb:.0f} ГБ) будет ~{total:.0f} ГБ — "
        f"бюджет {BUDGET_GB:.0f} ГБ. Остановите одну из запущенных моделей."
    )


async def start_model(entry: ModelEntry) -> tuple[bool, str | None]:
    """Идемпотентный запуск. Возвращает (ok, error)."""
    if not entry.managed:
        return False, "Удалённую модель не нужно запускать — проверьте креды и доступность."
    if os.name != "posix":
        return False, ("Локальные модели запускаются раннерами server/run_*.sh и "
                       "поддерживаются только на macOS/Linux. На этой ОС используйте "
                       "облачные модели (см. docs/windows.md).")
    if await port_running(entry.port):
        return True, None
    if entry.proc is not None and entry.proc.poll() is None:
        return True, None  # уже запускается
    budget_error = await budget_check(entry)
    if budget_error is not None:
        return False, budget_error
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = open(LOG_DIR / f"{entry.key}.log", "ab")
    env = {**os.environ, "MODEL": entry.hf_id, "PORT": str(entry.port)}
    if entry.gguf_file:
        env["GGUF_FILE"] = entry.gguf_file
    if entry.type == "sglang":
        env["MEM_FRACTION"] = str(entry.mem_fraction)
    entry.proc = subprocess.Popen(
        ["bash", str(RUNNERS[entry.type])],
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    entry.started_at = time.monotonic()
    return True, None


def _port_in_cmd(cmd: str, port: int) -> bool:
    """Порт как отдельное слово в командной строке. cmdline иногда приходит
    одним элементом-строкой (argv через bash), поэтому матчим по объединённой
    строке с границами цифр."""
    return re.search(rf"(?<!\d){port}(?!\d)", cmd) is not None


def _model_procs(port: int) -> list:
    """Процессы модельных серверов (sglang/clef_mlx/llama-server) на данном порту."""
    if psutil is None:
        return []
    out = []
    for proc in psutil.process_iter(["cmdline"]):
        try:
            cmdline = proc.info.get("cmdline") or []
            cmd = " ".join(cmdline)
            if ("sglang" in cmd or "clef_mlx" in cmd or "llama-server" in cmd) \
                    and _port_in_cmd(cmd, port):
                out.append(proc)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return out


def adopted_pids(port: int) -> list[int]:
    """PIDы модельных процессов с этим портом, запущенных не нами
    (например, переживших перезапуск бэкенда)."""
    return [p.pid for p in _model_procs(port)]


async def stop_model(entry: ModelEntry) -> tuple[int, str]:
    """Возвращает (http_status, message)."""
    if not entry.managed:
        return 422, "Удалённую модель не нужно останавливать."
    if not hasattr(os, "killpg"):
        return 422, ("Остановка локальных моделей поддерживается только на "
                     "macOS/Linux (нужны группы процессов POSIX).")
    if entry.proc is not None:
        if entry.proc.poll() is None:
            os.killpg(os.getpgid(entry.proc.pid), signal.SIGTERM)
            entry.stopping = True
            return 200, f"Модель {entry.key} останавливается"
        entry.proc = None
    if await port_running(entry.port):
        # Процесс не наш, но это узнаваемый модельный сервер на нашем порту
        # (пережил перезапуск бэкенда) — останавливаем его по группе процессов.
        pids = adopted_pids(entry.port)
        if pids:
            for pgid in {os.getpgid(pid) for pid in pids}:
                os.killpg(pgid, signal.SIGTERM)
            entry.stopping = True
            return 200, f"Модель {entry.key} останавливается (процесс пережил перезапуск бэкенда)"
        return 409, (
            f"Порт {entry.port} занят неизвестным процессом — "
            "остановите его вручную."
        )
    return 200, f"Модель {entry.key} не была запущена"


def _find_hf_cli() -> str | None:
    local = PROJECT_ROOT / "server" / "clef" / ".venv" / "bin" / "hf"
    if local.exists():
        return str(local)
    return shutil.which("hf")


def _parse_tqdm(line: str) -> tuple[float, float] | None:
    """(скачано ГБ, всего ГБ) из tqdm-строки hf download, или None."""
    m = _TQDM_SIZE_RE.search(line)
    if m:
        done = float(m.group(1)) * _UNIT_GB[m.group(2)]
        total = float(m.group(3)) * _UNIT_GB[m.group(4)]
        if total > 0:
            return done, total
    m = _TQDM_PCT_RE.search(line)
    if m:
        pct = min(int(m.group(1)), 100) / 100.0
        return pct, 1.0
    return None


def _watch_download(entry: ModelEntry, proc: subprocess.Popen) -> None:
    """Читает stderr hf download (tqdm) и обновляет прогресс модели."""
    buf = ""
    try:
        while True:
            chunk = proc.stderr.read(1) if proc.stderr else ""
            if not chunk:
                break
            if chunk in ("\r", "\n"):
                parsed = _parse_tqdm(buf)
                if parsed:
                    done, total = parsed
                    entry.dl_done_gb = round(done, 2)
                    if entry.download_gb:
                        entry.dl_progress = min(done / entry.download_gb, 1.0)
                    elif total > 0:
                        entry.dl_progress = min(done / total, 1.0) if total != 1.0 else done
                buf = ""
            else:
                buf += chunk
                if len(buf) > 4096:
                    buf = buf[-4096:]
        # хвост stderr — в dl_error на случай падения
        tail = buf.strip()
        if proc.wait() != 0 and tail:
            entry.dl_error = tail[-500:]
    except Exception as e:  # pragma: no cover
        entry.dl_error = str(e)


async def start_download(entry: ModelEntry) -> tuple[int, str]:
    """Скачивание модели в HF-кэш. Возвращает (http_status, message)."""
    if not entry.managed:
        return 422, "Удалённую модель не нужно скачивать."
    if entry.dl_proc is not None and entry.dl_proc.poll() is None:
        return 409, f"Модель {entry.key} уже скачивается"
    if is_downloaded(entry.hf_id):
        return 409, f"Модель {entry.key} уже скачана"
    hf = _find_hf_cli()
    if hf is None:
        return 500, "Не найден hf CLI (нужен huggingface_hub; см. README — установка Clef)"
    args = [hf, "download", entry.hf_id]
    if entry.gguf_file:
        args += ["--include", entry.gguf_file]
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = open(LOG_DIR / f"{entry.key}-download.log", "ab")
    entry.dl_progress = 0.0
    entry.dl_done_gb = 0.0
    entry.dl_error = None
    entry.dl_proc = subprocess.Popen(
        args, stdout=log_file, stderr=subprocess.PIPE,
        text=True, start_new_session=True,
    )
    threading.Thread(target=_watch_download, args=(entry, entry.dl_proc),
                     daemon=True).start()
    return 200, f"Скачивание {entry.key} запущено (~{entry.download_gb or '?'} ГБ)"


async def delete_model(entry: ModelEntry) -> tuple[int, str]:
    """Удаление модели из HF-кэша. Возвращает (http_status, message)."""
    if not entry.managed:
        return 422, "Удалённую модель удаляйте через DELETE /api/models/{key}."
    if await port_running(entry.port) or entry.stopping:
        return 409, f"Модель {entry.key} запущена — сначала остановите её"
    if entry.dl_proc is not None and entry.dl_proc.poll() is None:
        return 409, f"Модель {entry.key} скачивается — дождитесь окончания"
    cache_dir = HF_CACHE / ("models--" + entry.hf_id.replace("/", "--"))
    if not cache_dir.is_dir():
        return 409, f"Модель {entry.key} не скачана"
    shutil.rmtree(cache_dir)
    return 200, (f"Модель {entry.key} удалена из кэша. Примечание: при Xet-дедупе "
                 "общие чанки могут остаться — полная очистка: hf cache prune")


def update_model(entry: ModelEntry, patch: dict) -> None:
    """Правка label/short_label/enabled/base_url с персистентностью в конфиг."""
    if "label" in patch and patch["label"]:
        entry.label = str(patch["label"])
    if "short_label" in patch and patch["short_label"]:
        entry.short_label = str(patch["short_label"])
    if "enabled" in patch:
        entry.enabled = bool(patch["enabled"])
    if "base_url" in patch and not entry.managed:
        entry.base_url = str(patch["base_url"]).rstrip("/")
        invalidate_remote_probe(entry.key)
    save_registry()


def create_remote_model(data: dict) -> tuple[ModelEntry | None, str | None]:
    """Создание remote-модели. Возвращает (entry, error)."""
    label = str(data.get("label") or "").strip()
    base_url = str(data.get("base_url") or "").strip().rstrip("/")
    api = data.get("api")
    if not label:
        return None, "Нужно название (label)"
    if api not in ("decisions", "systemone"):
        return None, "api должен быть 'decisions' или 'systemone'"
    if not re.match(r"^https?://", base_url):
        return None, "base_url должен начинаться с http:// или https://"
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "remote"
    key = f"remote-{slug}"
    n = 2
    while key in REGISTRY:
        key = f"remote-{slug}-{n}"
        n += 1
    entry = ModelEntry(key, label, "", 0, type="remote", api=api, base_url=base_url,
                       api_model=data.get("api_model") or None,
                       vision=bool(data.get("vision")))
    REGISTRY[key] = entry
    api_key = str(data.get("api_key") or "").strip()
    if api_key:
        creds.save(key, api_key)
    save_registry()
    return entry, None


def delete_remote_model(entry: ModelEntry) -> tuple[int, str]:
    if entry.managed:
        return 422, "Локальную модель нельзя удалить из реестра — выключите её (enabled=false)"
    REGISTRY.pop(entry.key, None)
    creds.delete(entry.key)
    save_registry()
    return 200, f"Удалённая модель {entry.key} удалена из реестра"


def rss_gb(port: int) -> float | None:
    """Суммарный RSS процессов модели на данном порту, в ГБ."""
    total = 0
    for proc in _model_procs(port):
        try:
            mem = proc.memory_info()
            if mem:
                total += mem.rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return round(total / (1024**3), 2) if total else None


def label_mass_metrics(answers: dict) -> tuple[float | None, float | None]:
    masses = [a["label_mass"] for a in answers.values()
              if isinstance(a, dict) and isinstance(a.get("label_mass"), (int, float))]
    if not masses:
        return None, None
    return round(min(masses), 4), round(sum(masses) / len(masses), 4)
