// Проверка обновлений: локальная версия (/api/version) против latest-релиза
// на GitHub. Кэш в localStorage — не чаще раза в сутки; сетевая ошибка —
// тихий фейл (приложение полностью локальное, GitHub может быть недоступен).

const GITHUB_REPO = "chkalofff/decision-qa";
const CHECK_KEY = "dq-update-check";       // {at, latest}
const DISMISS_KEY = "dq-update-dismissed"; // версия, чей баннер закрыли
const TTL_MS = 24 * 60 * 60 * 1000;

// "0.2.0" → [0, 2, 0]; не-semver → null.
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || "").trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// latest строго новее current (обе semver)?
export function isNewerVersion(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим */ }
}

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
}

// Возвращает {version, url} если есть более новый релиз, иначе null.
// Ошибки сети/парсинга глотаются → null.
export async function checkForUpdate() {
  let local;
  try {
    local = (await fetchJson("/api/version")).version || "dev";
  } catch {
    return null; // локальный backend не ответил — проверять нечего
  }

  const cached = readJson(CHECK_KEY);
  let latest = cached && Date.now() - cached.at < TTL_MS ? cached.latest : null;

  if (!latest) {
    try {
      const rel = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
      latest = { tag: rel.tag_name || "", url: rel.html_url || "" };
      writeJson(CHECK_KEY, { at: Date.now(), latest });
    } catch {
      return null; // GitHub недоступен — тихий фейл
    }
  }

  if (!latest.tag || !isNewerVersion(latest.tag, local)) return null;
  if (readJson(DISMISS_KEY) === latest.tag) return null;
  return { tag: latest.tag, version: latest.tag.replace(/^v/, ""), url: latest.url };
}

// Баннер «доступна новая версия». Единственный вызов — из initUpdate().
export function renderUpdateBanner(info) {
  const banner = document.getElementById("update-banner");
  const text = document.getElementById("update-banner-text");
  const link = document.getElementById("update-banner-link");
  if (!banner || !text || !link) return;
  text.textContent =
    `Доступна версия ${info.version}. Обновление: bash scripts/update_mac.sh (Mac) ` +
    `или scripts\\update.ps1 (Windows).`;
  link.href = info.url || `https://github.com/${GITHUB_REPO}/releases`;
  document.getElementById("update-banner-close").onclick = () => {
    banner.classList.add("hidden");
    writeJson(DISMISS_KEY, info.tag);
  };
  banner.classList.remove("hidden");
}

// Запуск проверки: баннер при появлении новой версии, тишина иначе.
export function initUpdate() {
  checkForUpdate().then(info => { if (info) renderUpdateBanner(info); });
}
