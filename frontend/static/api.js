// fetch-обёртки для backend v2.

async function request(path, options) {
  let resp;
  try {
    resp = await fetch(path, options);
  } catch (e) {
    throw new Error("Сетевая ошибка: " + e.message);
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Ошибка ${resp.status}: ${data.detail || resp.statusText}`);
  }
  return data;
}

export function getModels() {
  return request("/api/models");  // {models: [...], device: {ram_gb, budget_gb}}
}

export function startModel(key) {
  return request(`/api/models/${encodeURIComponent(key)}/start`, { method: "POST" });
}

export function stopModel(key) {
  return request(`/api/models/${encodeURIComponent(key)}/stop`, { method: "POST" });
}

export function downloadModel(key) {
  return request(`/api/models/${encodeURIComponent(key)}/download`, { method: "POST" });
}

export function deleteModelFiles(key) {
  return request(`/api/models/${encodeURIComponent(key)}/delete`, { method: "POST" });
}

export function patchModel(key, patch) {
  return request(`/api/models/${encodeURIComponent(key)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function createRemoteModel(data) {
  return request("/api/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function removeModel(key) {
  return request(`/api/models/${encodeURIComponent(key)}`, { method: "DELETE" });
}

export function putCredentials(key, apiKey) {
  return request(`/api/models/${encodeURIComponent(key)}/credentials`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
}

export function deleteCredentials(key) {
  return request(`/api/models/${encodeURIComponent(key)}/credentials`, { method: "DELETE" });
}

export function getAssistantModels() {
  return request("/api/assistant/models");  // {models: [{key, label, remote}]}
}

export function getPresets() {
  return request("/api/presets");
}

// Сухая валидация предложения ассистента (без применения): 422 с detail,
// если payload невалиден. snapshot (опционально, облегчённый: {questions,
// batchFiles}) — единый базис валидации (A3): сервер прогоняет те же
// state-зависимые проверки по id, что и в агентном цикле.
export function validateProposal(kind, payload, snapshot) {
  const body = { kind, payload: payload || {} };
  if (snapshot) body.snapshot = snapshot;
  return request("/api/assistant/propose/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// id сессии ассистента (v1.2): живёт пока живёт вкладка (sessionStorage),
// сквозная привязка ходов чата и биконов карточек в журнале assistant.jsonl.
let _sessionIdMem = null;

function _newSessionId() {
  if (globalThis.crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "s-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function getAssistantSessionId() {
  try {
    let id = sessionStorage.getItem("assistant_session_id");
    if (!id) {
      id = _newSessionId();
      sessionStorage.setItem("assistant_session_id", id);
    }
    return id;
  } catch {
    // sessionStorage недоступен (приватный режим) — id в памяти на жизнь вкладки
    return _sessionIdMem || (_sessionIdMem = _newSessionId());
  }
}

// Бикон исходов карточек ассистента (v0.8): принято/отклонено/отменено/
// невалидно → строка в журнале assistant.jsonl. Fire-and-forget: сетевая
// ошибка глотается, бикон не должен влиять на UI.
export function assistantEvent(payload) {
  return fetch("/api/assistant/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: getAssistantSessionId(), ...payload }),
  }).catch(() => {});
}

// «Прервать» на живой карточке пробного прогона (макет 4.2): бэкенд гасит
// незавершённые шаги и отдаёт частичный результат (trial aborted:true).
// Ответ не нужен — финал придёт SSE-событием в поток чата; сетевая ошибка
// глотается (гонка «клик после финала» безобидна — бэк отвечает 409).
export function assistantTrialAbort() {
  return fetch("/api/assistant/trial/abort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: getAssistantSessionId() }),
  }).catch(() => null);
}

export function createPreset(data) {
  return request("/api/presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function renamePreset(slug, name) {
  return request(`/api/presets/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export function deletePreset(slug) {
  return request(`/api/presets/${encodeURIComponent(slug)}`, { method: "DELETE" });
}

export function generatePreset(data) {
  return request("/api/presets/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function generateQuestions(data) {
  return request("/api/questions/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function generateDecision(data) {
  return request("/api/decision/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function setBudgetFraction(fraction) {
  return request("/api/settings/budget", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fraction }),
  });
}

export function decide(body) {
  return request("/api/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
