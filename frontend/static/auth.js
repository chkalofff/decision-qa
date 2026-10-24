// Bearer auth для API. Токен живёт в sessionStorage, localStorage — только
// по явному выбору «запомнить»; в URL и логи он не попадает.

const TOKEN_KEY = "dq-access-token";
let token = null;
let owner = "local";
let authRequired = false;
let loginPromise = null;

try {
  token = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || null;
} catch { /* storage недоступен — токен можно ввести в этой вкладке */ }

export function getAuthOwner() {
  return owner;
}

export function authIsRequired() {
  return authRequired;
}

function saveToken(value, remember) {
  token = value;
  try {
    if (remember) {
      localStorage.setItem(TOKEN_KEY, value);
      sessionStorage.removeItem(TOKEN_KEY);
    } else {
      sessionStorage.setItem(TOKEN_KEY, value);
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch { /* действует до перезагрузки текущей вкладки */ }
}

function withBearer(options, value) {
  const headers = new Headers((options && options.headers) || {});
  if (value) headers.set("Authorization", `Bearer ${value}`);
  return { ...(options || {}), headers };
}

async function nativeFetch(path, options) {
  return globalThis.fetch(path, options);
}

function tokenDialog() {
  const overlay = document.createElement("div");
  overlay.className = "preset-dialog-overlay";
  overlay.id = "auth-dialog";
  const box = document.createElement("div");
  box.className = "preset-dialog-box";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "auth-dialog-title");
  const title = document.createElement("h2");
  title.id = "auth-dialog-title";
  title.textContent = "Доступ к Decision-QA";
  const note = document.createElement("p");
  note.textContent = "Введите Bearer access token, выданный администратором.";
  const input = document.createElement("input");
  input.id = "auth-token-input";
  input.type = "password";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Access token");
  const rememberLabel = document.createElement("label");
  const remember = document.createElement("input");
  remember.id = "auth-remember";
  remember.type = "checkbox";
  rememberLabel.appendChild(remember);
  rememberLabel.appendChild(document.createTextNode(" Запомнить в этом браузере"));
  const error = document.createElement("p");
  error.id = "auth-dialog-error";
  error.setAttribute("role", "alert");
  const submit = document.createElement("button");
  submit.id = "auth-submit";
  submit.type = "button";
  submit.className = "btn";
  submit.textContent = "Продолжить";
  box.append(title, note, input, rememberLabel, error, submit);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  input.focus();
  return { overlay, input, remember, error, submit };
}

async function requestToken() {
  if (loginPromise) return loginPromise;
  loginPromise = new Promise((resolve) => {
    const ui = tokenDialog();
    const finish = (value) => {
      ui.overlay.remove();
      loginPromise = null;
      resolve(value);
    };
    const submit = async () => {
      const candidate = ui.input.value.trim();
      if (!candidate) {
        ui.error.textContent = "Введите токен.";
        return;
      }
      ui.submit.disabled = true;
      ui.error.textContent = "";
      try {
        const resp = await nativeFetch("/api/auth/me", withBearer({}, candidate));
        if (resp.status === 401) {
          ui.error.textContent = "Токен отклонён сервером.";
          ui.submit.disabled = false;
          return;
        }
        if (!resp.ok) throw new Error(`Ошибка ${resp.status}`);
        const data = await resp.json();
        saveToken(candidate, ui.remember.checked);
        owner = data.owner || "local";
        authRequired = !!data.auth_required;
        finish(true);
      } catch (e) {
        ui.error.textContent = e.message || "Сервер недоступен.";
        ui.submit.disabled = false;
      }
    };
    ui.submit.addEventListener("click", submit);
    ui.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  });
  return loginPromise;
}

async function authorizedFetch(path, options, canRetry) {
  const resp = await nativeFetch(path, withBearer(options, token));
  if (resp.status !== 401 || !canRetry) return resp;
  const accepted = await requestToken();
  if (!accepted) return resp;
  return authorizedFetch(path, options, false);
}

export function apiFetch(path, options) {
  return authorizedFetch(path, options, true);
}

export async function initAuth() {
  try {
    const resp = await apiFetch("/api/auth/me");
    if (resp.status === 404) {
      owner = "local";  // сервер до auth: совместимость локальной установки и DOM-тестов
      authRequired = false;
      return { owner, auth_required: false, legacy: true };
    }
    if (!resp.ok) return null;
    const data = await resp.json();
    owner = data.owner || "local";
    authRequired = !!data.auth_required;
    return data;
  } catch {
    return null;
  }
}
