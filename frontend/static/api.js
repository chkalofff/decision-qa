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
