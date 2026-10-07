// Минимальный DOM/браузерный мок для node-тестов фронтенда.
// Поддерживает то, что реально используют модули frontend/static/*.js.

function kebab(s) {
  return s.replace(/[A-Z]/g, c => "-" + c.toLowerCase());
}

let docRegistry = null; // Map id -> element (переустанавливается в installDom)

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...cs) { cs.forEach(c => this.set.add(c)); }
  remove(...cs) { cs.forEach(c => this.set.delete(c)); }
  toggle(c, force) {
    const want = force === undefined ? !this.set.has(c) : !!force;
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
  contains(c) { return this.set.has(c); }
}

class MockElement {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._text = "";
    this._attrs = {};
    this._id = "";
    this._listeners = {};
    this.style = new Proxy({ setProperty: (k, v) => { this.style["--" + k.replace(/^--/, "")] = v; } }, {
      get: (t, k) => t[k],
      set: (t, k, v) => { t[k] = v; return true; },
    });
    this.classList = new ClassList(this);
    this.dataset = new Proxy({}, {
      get: (t, k) => t[k],
      set: (t, k, v) => { t[k] = v; this._attrs["data-" + kebab(k)] = String(v); return true; },
    });
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.title = "";
    this.hidden = false;
    this.colSpan = 1;
    this.rowSpan = 1;
    this.draggable = false;
    this.onclick = null;
    this.onchange = null;
    this.oninput = null;
  }

  get id() { return this._id; }
  set id(v) {
    if (this._id && docRegistry) docRegistry.delete(this._id);
    this._id = v;
    if (v && docRegistry) docRegistry.set(v, this);
  }

  get className() { return [...this.classList.set].join(" "); }
  set className(v) {
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  get textContent() {
    return this._text + this.children.map(c => c.textContent).join("");
  }
  set textContent(v) {
    this._text = String(v ?? "");
    this.children = [];
  }

  get innerHTML() { return this._html || ""; }
  set innerHTML(v) { this._html = String(v ?? ""); this.children = []; this._text = ""; }

  get firstChild() { return this.children[0] || null; }
  get offsetWidth() { return 100; }
  get offsetHeight() { return 50; }

  setAttribute(k, v) {
    this._attrs[k] = String(v);
    if (k === "id") this.id = v;
  }
  getAttribute(k) {
    if (k.startsWith("data-")) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (camel in this.dataset) return String(this.dataset[camel]);
    }
    return k in this._attrs ? this._attrs[k] : null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    // Как в браузере: у <select> без явного value выбрана первая опция.
    if (this.tagName === "SELECT" && child.tagName === "OPTION" &&
        !this.children.some(c => c !== child && c.tagName === "OPTION")) {
      this.value = child.value;
    }
    return child;
  }
  append(...nodes) { nodes.forEach(n => this.appendChild(n)); }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter(c => c !== this);
      this.parentNode = null;
    }
    // В реальном DOM remove() убирает элемент из дерева, и getElementById
    // его больше не находит — вычищаем id из реестра (включая потомков).
    if (docRegistry) {
      const unlink = (el) => {
        if (el._id) docRegistry.delete(el._id);
        for (const c of el.children) unlink(c);
      };
      unlink(this);
    }
  }
  after(node) {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    this.parentNode.children.splice(i + 1, 0, node);
    node.parentNode = this.parentNode;
  }

  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn);
  }
  dispatchEvent(evt) {
    evt.target = evt.target || this;
    evt.preventDefault = evt.preventDefault || (() => {});
    evt.stopPropagation = evt.stopPropagation || (() => {});
    for (const fn of [...(this._listeners[evt.type] || [])]) fn(evt);
    return true;
  }
  // удобный хелпер для тестов
  fire(type, extra = {}) {
    this.dispatchEvent({ type, ...extra });
    if (type === "click" && this.onclick) this.onclick({ stopPropagation: () => {} });
  }
  click() {
    globalThis.__clicks = globalThis.__clicks || [];
    globalThis.__clicks.push(this);
    this.fire("click");
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }

  matches(sel) {
    // простой селектор без пробелов: tag, #id, .cls, [attr], [attr="v"]
    const re = /([#.]?[\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]/g;
    let m;
    let matchedAny = false;
    const tagMatch = sel.match(/^[a-zA-Z][\w-]*/);
    if (tagMatch && this.tagName !== tagMatch[0].toUpperCase()) return false;
    while ((m = re.exec(sel))) {
      if (m[1]) {
        const tok = m[1];
        if (tok === tagMatch?.[0]) continue;
        matchedAny = true;
        if (tok.startsWith("#")) { if (this.id !== tok.slice(1)) return false; }
        else if (tok.startsWith(".")) { if (!this.classList.contains(tok.slice(1))) return false; }
        else if (this.tagName !== tok.toUpperCase()) return false;
      } else if (m[2]) {
        matchedAny = true;
        const v = this.getAttribute(m[2]);
        if (v === null) return false;
        if (m[3] !== undefined && v !== m[3]) return false;
      }
    }
    return matchedAny || !!tagMatch;
  }

  _descendants() {
    const out = [];
    const walk = (el) => { for (const c of el.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }

  contains(el) {
    return el === this || this._descendants().includes(el);
  }

  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    let current = [this];
    for (const part of parts) {
      const next = [];
      for (const root of current) {
        for (const d of root._descendants()) {
          if (d.matches(part) && !next.includes(d)) next.push(d);
        }
      }
      // оставляем только тех, у кого цепочка предков проходит через предыдущий уровень — упрощённо: все совпавшие
      current = next;
    }
    return current;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  closest(selector) {
    let el = this;
    while (el) {
      if (el.matches && el.matches(selector)) return el;
      el = el.parentNode;
    }
    return null;
  }
}

class MockDocument extends MockElement {
  constructor() {
    super("#document");
    this.body = new MockElement("body");
    this.activeElement = null;
  }
  createElement(tag) { return new MockElement(tag); }
  createTextNode(text) {
    const node = new MockElement("#text");
    node.textContent = text;
    return node;
  }
  getElementById(id) { return docRegistry.get(id) || null; }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    let current = [this.body];
    for (const part of parts) {
      const next = [];
      for (const root of current) {
        for (const d of root._descendants()) {
          if (d.matches(part) && !next.includes(d)) next.push(d);
        }
      }
      current = next;
    }
    return current;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

// ---------------------------------------------------------------- установка

export function installDom() {
  docRegistry = new Map();
  const document = new MockDocument();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: () => {},
  };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  globalThis.__clicks = [];
  globalThis.confirm = () => true;
  globalThis.Blob = class {
    constructor(parts) { this.content = (parts || []).join(""); }
  };
  globalThis.URL = {
    createObjectURL: (blob) => "blob:" + blob.content.length,
    revokeObjectURL: () => {},
  };
  globalThis.FileReader = class {
    readAsText(file) {
      this.result = file.__content ?? "";
      setTimeout(() => this.onload && this.onload(), 0);
    }
    readAsDataURL(file) {
      this.result = file.__dataUrl
        || "data:image/png;base64," + Buffer.from(String(file.__content ?? ""), "utf8").toString("base64");
      setTimeout(() => this.onload && this.onload(), 0);
    }
  };
  return document;
}

// Элемент с id, сразу зарегистрированный и (опционально) прикреплённый к body.
export function el(tag, { id, className, text, parent, attrs, dataset } = {}) {
  const e = document.createElement(tag);
  if (id) e.id = id;
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (dataset) for (const [k, v] of Object.entries(dataset)) e.dataset[k] = v;
  (parent || document.body).appendChild(e);
  return e;
}

// Фейковый файл для импорта/батча.
export function fakeFile(name, content, type) {
  return {
    name,
    size: content.length,
    type: type || "",
    __content: content,
    text: async () => content,
  };
}

// Сброс состояния приложения между тестами.
export async function resetState() {
  const { state } = await import("../static/state.js");
  state.models = [];
  state.questions = [];
  state.selectedModels = new Set();
  state.pinnedModels = new Set();
  state._pinnedLoaded = false;
  state.inputMode = "text";
  state.contextImages = [];
  state.temperature = 1;
  state.runMode = "decisions";
  state.pageMode = "single";
  state.pinnedFormats = {};
  state.results = null;
  state.running = false;
  state.panels = { width: 50, focus: null, collapsed: null };
  state.batchPanels = { width: 50, focus: null, collapsed: null };
  state.batch = {
    files: [], running: false, cancelled: false,
    startedAt: null, finishedAt: null, results: {}, durations: {},
  };
  state._seenModels = null;
  return state;
}

// Мок fetch: routes — { "GET /api/models": data | fn }.
// Ответ-ошибка: { __status: 422, detail: "…" } → resp.ok === false.
export function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    const method = options.method || "GET";
    const key = `${method} ${path}`;
    calls.push({ key, body: options.body ? JSON.parse(options.body) : null });
    let route = routes[key] ?? routes[path];
    if (typeof route === "function") route = await route(calls[calls.length - 1]);
    if (route === undefined) {
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({ detail: "no mock" }) };
    }
    if (route && route.__status) {
      return { ok: false, status: route.__status, statusText: route.__statusText || "Error",
               json: async () => ({ detail: route.detail }) };
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => route };
  };
  return calls;
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- мок deep-chat

// Мини-парсер html-фрагментов, которые assistant.js отдаёт в addMessage
// (proposal/trial-карточки, thinking-блок): простые вложенные теги с
// class/style/data-атрибутами и текстом. Не полноценный HTML — только то, что
// мы сами генерируем.
const HTML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const VOID_TAGS = new Set(["br", "hr", "img", "input"]);

function decodeEntities(text) {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, m => HTML_ENTITIES[m] ?? m);
}

export function parseHtml(html) {
  const root = document.createElement("div");
  const stack = [root];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[5] !== undefined) {
      const text = decodeEntities(m[5]);
      if (text.trim()) {
        const node = document.createElement("span");
        node.textContent = text;
        stack[stack.length - 1].appendChild(node);
      }
      continue;
    }
    const [, closing, tag, attrText, selfClose] = m;
    if (closing) {
      // закрывающий тег: снимаем со стека до совпадения
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
      }
      continue;
    }
    const el = document.createElement(tag);
    const attrRe = /([\w-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = attrRe.exec(attrText))) {
      const [, name, value = ""] = a;
      if (name === "class") el.className = decodeEntities(value);
      else if (name === "style") el._attrs.style = value;  // стили не применяем
      else if (name.startsWith("data-")) {
        el.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = decodeEntities(value);
      } else el.setAttribute(name, decodeEntities(value));
    }
    stack[stack.length - 1].appendChild(el);
    if (!selfClose && !VOID_TAGS.has(tag.toLowerCase())) stack.push(el);
  }
  return root;
}

// Привязка событий по классам — аналог htmlClassUtilities deep-chat.
function applyClassUtilities(node, utils) {
  if (!utils) return;
  for (const el of [node, ...node._descendants()]) {
    for (const cls of Object.keys(utils)) {
      const u = utils[cls];
      if (u && u.events && el.classList && el.classList.contains(cls)) {
        for (const [type, fn] of Object.entries(u.events)) el.addEventListener(type, fn);
      }
    }
  }
}

// Мок web component <deep-chat>: addMessage сохраняет html-сообщения в
// queryable DOM (с биндингом htmlClassUtilities), connect.handler прячет
// intro-панель (первый ребёнок), clearMessages чистит ленту и возвращает intro.
export function installDeepChatMock(chat) {
  chat.messages = [];
  const intro = () => chat.children.find(c => !c.classList.contains("dc-added")) || null;
  const hideIntro = () => { const i = intro(); if (i) i.classList.add("hidden"); };
  const showIntro = () => { const i = intro(); if (i) i.classList.remove("hidden"); };
  chat.addMessage = (msg) => {
    chat.messages.push(msg);
    hideIntro();
    if (msg && msg.html) {
      const node = parseHtml(msg.html);
      node.classList.add("dc-added");
      chat.appendChild(node);
      applyClassUtilities(node, chat.htmlClassUtilities);
    }
  };
  chat.clearMessages = () => {
    chat.messages = [];
    for (const c of [...chat.children]) {
      if (c.classList.contains("dc-added")) c.remove();
    }
    showIntro();
  };
  let connect = null;
  Object.defineProperty(chat, "connect", {
    configurable: true,
    get: () => connect,
    set: (c) => {
      connect = c;
      if (c && typeof c.handler === "function") {
        const orig = c.handler;
        c.handler = (body, signals) => { hideIntro(); return orig(body, signals); };
      }
    },
  });
  return chat;
}
