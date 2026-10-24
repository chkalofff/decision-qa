// Доменные тесты: Bearer auth и owner-namespace локального чата.

import {
  test, assert, eq, installDom, resetState, domApp, assistant, sleep,
} from "./harness.mjs";
import { apiFetch, initAuth, getAuthOwner } from "../static/auth.js";

const response = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? "OK" : "Unauthorized",
  json: async () => data,
});
const chatPack = (text) => JSON.stringify({
  version: 1,
  convos: {
    single: { history: [], feed: [{ t: "user", text }], annV: 1 },
    batch: { history: [], feed: [], annV: 1 },
  },
});

test("auth: legacy 404 = local; чат мигрирует только после записи в local namespace", async () => {
  installDom(); await resetState(); domApp();
  globalThis.fetch = async () => response(404, { detail: "legacy" });
  const info = await initAuth();
  eq(info.owner, "local");
  eq(getAuthOwner(), "local");
  localStorage.setItem("dq-assistant-chat", chatPack("legacy local"));
  assistant.initAssistant();
  assistant.persistChat();
  const saved = localStorage.getItem("dq-assistant-chat:local");
  assert(saved.includes("legacy local"), "legacy чат сохранён в local namespace");
  eq(localStorage.getItem("dq-assistant-chat"), null, "legacy удалён после успешной записи");
});

test("auth: 401 открывает доступный диалог, Bearer в sessionStorage и один retry", async () => {
  installDom(); await resetState(); domApp();
  const calls = [];
  const secret = "alice-secret-token";
  globalThis.fetch = async (path, options = {}) => {
    const headers = new Headers(options.headers || {});
    const bearer = headers.get("Authorization");
    calls.push({ path, options, bearer });
    if (path === "/api/auth/me" && bearer === `Bearer ${secret}`) {
      return response(200, { owner: "alice", auth_required: true });
    }
    if (path === "/api/decide" && bearer === `Bearer ${secret}`) {
      return response(200, { results: {} });
    }
    return response(401, { detail: "token required" });
  };
  const pending = apiFetch("/api/decide", { method: "POST", body: "{}" });
  await sleep(0);
  const dialog = document.getElementById("auth-dialog");
  assert(dialog, "диалог показан");
  assert(dialog.querySelector(".preset-dialog-box"), "диалог использует существующий layout-класс");
  eq(dialog.querySelector("[role=dialog]").getAttribute("aria-modal"), "true");
  document.getElementById("auth-token-input").value = secret;
  document.getElementById("auth-remember").checked = false;
  document.getElementById("auth-submit").fire("click");
  const resp = await pending;
  eq(resp.status, 200);
  eq(getAuthOwner(), "alice");
  eq(sessionStorage.getItem("dq-access-token"), secret);
  eq(localStorage.getItem("dq-access-token"), null);
  eq(calls.filter(c => c.path === "/api/decide").length, 2, "ровно один retry");
  eq(calls[0].bearer, null);
  eq(calls.at(-1).bearer, `Bearer ${secret}`);
  assert(calls.every(c => !c.path.includes(secret) && !(c.options.body || "").includes(secret)),
         "токен не попадает в URL или тело/report payload");
  eq(document.getElementById("auth-dialog"), null);
});

test("auth: remember переносит токен в localStorage, смена owner не клонирует legacy чат", async () => {
  installDom(); await resetState(); domApp();
  const secret = "bob-secret-token";
  globalThis.fetch = async (path, options = {}) => {
    const bearer = new Headers(options.headers || {}).get("Authorization");
    if (path === "/api/auth/me" && bearer === `Bearer ${secret}`) {
      return response(200, { owner: "bob", auth_required: true });
    }
    if (path === "/api/presets" && bearer === `Bearer ${secret}`) {
      return response(200, []);
    }
    return response(401, { detail: "bad token" });
  };
  const pending = apiFetch("/api/presets");
  await sleep(0);
  document.getElementById("auth-token-input").value = secret;
  document.getElementById("auth-remember").checked = true;
  document.getElementById("auth-submit").fire("click");
  eq((await pending).status, 200);
  eq(localStorage.getItem("dq-access-token"), secret);
  eq(sessionStorage.getItem("dq-access-token"), null);
  eq(getAuthOwner(), "bob");

  localStorage.setItem("dq-assistant-chat", chatPack("не отдавать bob"));
  assistant.initAssistant();
  assistant.persistChat();
  assert(!localStorage.getItem("dq-assistant-chat:bob").includes("не отдавать bob"),
         "remote owner не получает legacy local чат");
  assert(localStorage.getItem("dq-assistant-chat").includes("не отдавать bob"),
         "remote persist не удаляет legacy local");
});
