// Облачные chat API — зеркало backend/remote_llm.APIS.
// api="systemone" с чужим base_url — протокол /v1/systemone (не chat);
// chat — только с base_url api.system1.cloud (или без base_url: дефолт).

export const CHAT_APIS = {
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  clef: { label: "Clef cloud (ai.1lab.club)", baseUrl: "https://ai.1lab.club/v1" },
  systemone: { label: "SystemOne cloud (api.system1.cloud)", baseUrl: "https://api.system1.cloud/v1" },
  laya: { label: "Laya cloud", baseUrl: "https://laya.ai/api/v1" },
};

export function isChatApi(api) {
  return Object.prototype.hasOwnProperty.call(CHAT_APIS, api);
}

// Модель из GET /api/models — облачная chat-модель?
export function isChatRemote(m) {
  if (!m || m.type !== "remote" || !isChatApi(m.api)) return false;
  if (m.api === "systemone" && m.base_url &&
      m.base_url.replace(/\/+$/, "") !== CHAT_APIS.systemone.baseUrl) return false;
  return true;
}

// Облачные chat-модели из state.models для селекторов генерации/ассистента.
export function remoteChatModels(models) {
  return (models || []).filter(m => isChatRemote(m) && m.enabled !== false);
}
