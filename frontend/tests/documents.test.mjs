// Доменные тесты: owner-scoped multi-document workspaces и safe tabs.

import {
  test, assert, eq, includes, installDom, resetState, sleep, domApp, restoreGlobalProperty,
  state, context, batch, persist, documents, documentsUi,
} from "./harness.mjs";

const RUN_ID = "run_" + "a".repeat(32);

async function setup({ hash = "", beforeInit = null } = {}) {
  installDom(); await resetState(); domApp();
  context.initContext({});
  batch.initBatch({});
  persist.resumePersist();
  if (beforeInit) beforeInit();
  globalThis.location = { hash };
  globalThis.history = { replaceState: (_a, _b, value) => { globalThis.location.hash = value; } };
  await documentsUi.initDocuments();
}

function provenance() {
  return {
    latestRun: RUN_ID,
    runs: { [RUN_ID]: {
      runId: RUN_ID, status: "completed", configFingerprint: "sha256:config",
      materialsFingerprint: "sha256:materials", materialHashes: ["sha256:one"],
    } },
  };
}

function fillCompleteDocument() {
  state.models = [
    { key: "mA", label: "A", status: "running" },
    { key: "mB", label: "B", status: "running" },
  ];
  state.selectedModels = new Set(["mB"]);
  state.runMode = "decisions";
  state.temperature = 0.65;
  state.threads = 4;
  state.pinnedFormats = { mB: 2 };
  context.setContent("материал default", "text");
  context.setImages(["data:image/png;base64,QUJD"]);
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no", direction: "no" }];
  state.decision = { enabled: true, outcomes: [{ id: "o1", label: "A", color: "green", rules: [] }] };
  state.results = {
    results: { mB: { ok: true, answers: {}, usage: {}, metrics: {} } },
    order: ["mB"], runMode: "both", questions: state.questions,
    runIds: { mB: { decisions: RUN_ID, fast_batch: RUN_ID } },
    marks: [{ id: "mark1", target: { scope: "single", model: "mB", mode: "decisions", question: "q1" },
      verdict: "accept", comment: "ok", criterion: "correctness", author: "local", created_at: "t", updated_at: "t" }],
  };
  state.resultsMeta = { fingerprint: "single-fp", ...provenance() };
  batch.loadPresetFiles([{ name: "a.txt", content: "batch A" }]);
  const fileId = state.batch.files[0].id;
  state.batch.results[fileId] = { mB: { ok: true, answers: {}, usage: {}, metrics: {} } };
  state.batch.runIds[fileId] = { mB: RUN_ID };
  state.batch.marks = [{ id: "mark2", target: { scope: "batch", file: fileId, question: "q1", model: "mB" },
    verdict: "reject", comment: "bad", criterion: "correctness", author: "local", created_at: "t", updated_at: "t" }];
  state.batch.resultsMeta = { fingerprint: "batch-fp", ...provenance() };
  state.batch.questions = state.questions;
  state.batch.decision = state.decision;
}

test("documents: legacy migration once в local:default, owner isolation и corrupt snapshot", async () => {
  installDom(); await resetState();
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    locks: { request: async (_name, _options, callback) => callback() },
  } });
  try {
  localStorage.setItem("dq-workspace", JSON.stringify({ input: "legacy", questions: [] }));
  const first = await documents.migrateLegacyWorkspace("local");
  eq(first.revision, 1, "legacy превратился в revisioned local:default snapshot");
  assert(localStorage.getItem("dq-workspace:local:default"), "новый scoped snapshot записан");
  assert(localStorage.getItem("dq-workspace"), "legacy source сохранён до и после безопасной записи");
  eq(localStorage.getItem("dq-workspace:other:default"), null, "другой owner не получил данные");
  await documents.migrateLegacyWorkspace("local");
  eq(documents.readDocumentSnapshot("local", "default").revision, 1, "повторная migration не дублирует revision");
  localStorage.setItem("dq-workspace:other:default", "{bad");
  let corrupt = null;
  try { documents.readDocumentSnapshot("other", "default"); } catch (error) { corrupt = error; }
  eq(corrupt.code, "corrupt", "corrupt doc id получает явную ошибку");
  } finally {
    restoreGlobalProperty("navigator", oldNavigator);
  }
});

test("documents: create/open/duplicate + hash и полный state/results/marks/provenance/run settings", async () => {
  await setup();
  fillCompleteDocument();
  await persist.saveNow();
  const defaultId = persist.currentDocument().id;
  eq(defaultId, "default", "стартовый default doc");
  eq(location.hash, "#doc=default", "hash текущего doc");

  await documentsUi.createNewDocument();
  const blankId = persist.currentDocument().id;
  assert(blankId !== defaultId, "new document fresh id");
  eq(state.results, null, "blank не наследует single results");
  eq(Object.keys(state.batch.results).length, 0, "blank не наследует batch results");
  eq(state.threads, null, "blank не наследует threads");
  eq(location.hash, `#doc=${blankId}`, "switch обновил hash без reload");

  context.setContent("copy source", "text");
  await persist.saveNow();
  await documentsUi.duplicateCurrentDocument();
  const copyId = persist.currentDocument().id;
  assert(copyId !== blankId, "duplicate fresh id");
  eq(context.currentText(), "copy source", "duplicate скопировал материал");
  eq(location.hash, `#doc=${copyId}`, "duplicate hash");

  await documentsUi.openDocument(defaultId);
  eq(context.currentText(), "материал default", "open восстановил материал");
  eq(state.contextImages.length, 1, "images восстановлены");
  eq(state.questions[0].direction, "no", "questions восстановлены");
  eq(state.decision.outcomes[0].label, "A", "decision восстановлен");
  eq(state.results.marks.length, 1, "single marks восстановлены");
  eq(state.resultsMeta.latestRun, RUN_ID, "single provenance восстановлена");
  eq(state.batch.marks.length, 1, "batch marks восстановлены");
  eq(state.batch.resultsMeta.latestRun, RUN_ID, "batch provenance восстановлена");
  eq(state.selectedModels.has("mB") && !state.selectedModels.has("mA"), true, "selectedModels восстановлены");
  eq(state.runMode, "decisions", "runMode восстановлен");
  eq(state.temperature, 0.65, "temperature восстановлена");
  eq(state.threads, 4, "threads восстановлены");
  eq(state.pinnedFormats.mB, 2, "prompt pins восстановлены");

  await documentsUi.openDocument(blankId);
  eq(state.results, null, "повторный open blank не оставил old results");
  eq(state.batch.marks.length, 0, "повторный open blank не оставил old marks");
});

test("documents: navigator.locks, same-doc conflict keep/reload и different-doc independence", async () => {
  await setup();
  context.setContent("local", "text");
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let locks = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    locks: { request: async (_name, _options, callback) => { locks += 1; return callback(); } },
  } });
  try {
    await persist.saveNow();
    eq(locks, 1, "RMW выполнен под navigator.locks");
    const other = await documents.createDocumentMetadata("local");
    await documents.saveDocumentSnapshot("local", other, { input: "other" }, { expectedRevision: 0, writerId: "tab-other" });
    documentsUi.handleDocumentStorageEvent({ key: documents.documentSnapshotKey("local", other.id), newValue: "{}" });
    assert(document.getElementById("doc-conflict-banner").classList.contains("hidden"), "other doc не конфликтует");

    const doc = persist.currentDocument();
    const external = await documents.saveDocumentSnapshot("local", doc, { input: "external", questions: [] }, {
      expectedRevision: doc.revision, writerId: "tab-external",
    });
    documentsUi.handleDocumentStorageEvent({ key: documents.documentSnapshotKey("local", doc.id), newValue: JSON.stringify(external) });
    const banner = document.getElementById("doc-conflict-banner");
    assert(!banner.classList.contains("hidden"), "same doc external update показал conflict");
    includes(document.getElementById("doc-conflict-text").textContent, "автоматического слияния нет", "нет auto-merge");
    document.getElementById("doc-keep").fire("click");
    await sleep(10);
    assert(banner.classList.contains("hidden"), "явный keep разрешил conflict");
    eq(documents.readDocumentSnapshot("local", doc.id).data.input, "local", "keep записал локальную версию явно");

    const second = persist.currentDocument();
    const remote = await documents.saveDocumentSnapshot("local", doc, { input: "remote reload", questions: [] }, {
      expectedRevision: second.revision, writerId: "tab-remote",
    });
    documentsUi.handleDocumentStorageEvent({ key: documents.documentSnapshotKey("local", doc.id), newValue: JSON.stringify(remote) });
    document.getElementById("doc-reload").fire("click");
    eq(context.currentText(), "remote reload", "reload восстановил external snapshot");
    eq(persist.currentDocument().revision, remote.revision, "reload принял external revision");
  } finally {
    restoreGlobalProperty("navigator", oldNavigator);
  }
});

test("documents: quota/fallback видимы; persist-off удаляет только current owner и безопасно включается", async () => {
  await setup();
  const other = await documents.createDocumentMetadata("other", { id: "default" });
  await documents.saveDocumentSnapshot("other", other, { input: "other owner" }, { expectedRevision: 0, writerId: "other" });
  const key = documents.documentSnapshotKey("local", "default");
  const original = localStorage.setItem;
  localStorage.setItem = (k, value) => {
    if (k === key) throw new Error("QuotaExceededError");
    original(k, value);
  };
  await persist.saveNow();
  localStorage.setItem = original;
  const banner = document.getElementById("doc-storage-banner");
  assert(!banner.classList.contains("hidden"), "quota стала видимой");
  includes(document.getElementById("doc-storage-text").textContent, "Освободите место", "actionable quota text");

  state.results = { results: { mA: { ok: true, text: "x".repeat(5 * 1024 * 1024) } }, order: ["mA"], runMode: "decisions", questions: [], marks: [] };
  await persist.saveNow();
  includes(document.getElementById("doc-storage-text").textContent, "НЕ сохранены", "честный fallback без results");

  persist.setPersistEnabled(false);
  eq(localStorage.getItem(key), null, "current owner snapshot удалён");
  assert(localStorage.getItem("dq-workspace:other:default"), "other owner snapshot не тронут");
  assert(documents.readDocumentRegistry("other").documents.default, "other registry не тронут");
  persist.setPersistEnabled(true);
  const restored = await persist.saveNow();
  assert(restored, `persist-on безопасно создал новый snapshot; error=${document.getElementById("doc-storage-text").textContent}; conflict=${document.getElementById("doc-conflict-text").textContent}; doc=${JSON.stringify(persist.currentDocument())}`);
  eq(restored.revision, 2, "persist-on пересохранил, явный save поднял следующую revision");
});

test("documents: unknown hash recoverable и corrupt open не стирает текущий документ", async () => {
  await setup({ hash: "#doc=missing" });
  eq(persist.currentDocument().id, "default", "unknown hash восстановлен через default");
  eq(location.hash, "#doc=default", "unknown hash заменён recoverable default");
  assert(!document.getElementById("doc-storage-banner").classList.contains("hidden"), "recovery warning виден");
  includes(document.getElementById("doc-storage-text").textContent, "не найден", "unknown id объяснён");

  await documentsUi.createNewDocument();
  const validId = persist.currentDocument().id;
  context.setContent("keep me", "text");
  localStorage.setItem("dq-workspace:local:default", "{corrupt");
  let error = null;
  try { await documentsUi.openDocument("default"); } catch (caught) { error = caught; }
  assert(error, "corrupt open отклонён");
  eq(persist.currentDocument().id, validId, "corrupt не сменил active doc");
  eq(context.currentText(), "keep me", "corrupt не стёр текущий документ");
});


test("documents: outgoing save обязателен перед create/open; failure/conflict блокирует switch", async () => {
  await setup();
  context.setContent("stable", "text");
  await persist.saveNow();
  context.setContent("latest immediate edit", "text");
  await documentsUi.createNewDocument();
  const otherId = persist.currentDocument().id;
  await documentsUi.openDocument("default");
  eq(context.currentText(), "latest immediate edit", "create→reopen сохранил последний edit");

  const original = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key === "dq-workspace:local:default") throw new Error("QuotaExceededError");
    original(key, value);
  };
  context.setContent("must stay current", "text");
  let failed = null;
  try { await documentsUi.createNewDocument(); } catch (error) { failed = error; }
  localStorage.setItem = original;
  assert(failed, "save failure отменил create/open");
  eq(persist.currentDocument().id, "default", "failed save не сменил doc");
  eq(context.currentText(), "must stay current", "failed save не потерял editor");

  const doc = persist.currentDocument();
  const external = await documents.saveDocumentSnapshot("local", doc, { input: "external", questions: [] }, {
    expectedRevision: documents.readDocumentSnapshot("local", doc.id).revision, writerId: "other-tab",
  });
  documentsUi.handleDocumentStorageEvent({ key: documents.documentSnapshotKey("local", doc.id), newValue: JSON.stringify(external) });
  let blocked = null;
  try { await documentsUi.openDocument(otherId); } catch (error) { blocked = error; }
  eq(blocked.code, "conflict", "unresolved conflict блокирует switch");
  eq(persist.currentDocument().id, "default", "conflict не сменил doc");
  eq(context.currentText(), "must stay current", "conflict не очистил editor");
});

test("documents: switch guard и stable flush сохраняют v2 при blocked second lock", async () => {
  await setup();
  const other = await documents.createDocumentMetadata("local", { name: "other" });
  context.setContent("v1", "text");
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let lockCalls = 0;
  let releaseSecond = null;
  let markSecond = null;
  const secondEntered = new Promise(resolve => { markSecond = resolve; });
  const secondBlocked = new Promise(resolve => { releaseSecond = resolve; });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    locks: { request: async (_name, _options, callback) => {
      lockCalls += 1;
      if (lockCalls === 2) {
        markSecond();
        await secondBlocked;
      }
      return callback();
    } },
  } });
  try {
    const switching = documentsUi.openDocument(other.id);
    await secondEntered;
    let prevented = false;
    let stopped = false;
    document.dispatchEvent({
      type: "input",
      target: document.getElementById("context-input"),
      preventDefault: () => { prevented = true; },
      stopImmediatePropagation: () => { stopped = true; },
    });
    assert(prevented && stopped, "реальное UI-событие заблокировано во время switch");
    context.setContent("v2", "text");
    releaseSecond();
    await switching;
    assert(lockCalls >= 3, "state version изменился, outgoing save повторён до stable snapshot");
    eq(documents.readDocumentSnapshot("local", "default").data.input, "v2", "v2 записан до reset");
    await documentsUi.openDocument("default");
    eq(context.currentText(), "v2", "reopen подтверждает отсутствие потери v2");
  } finally {
    releaseSecond();
    restoreGlobalProperty("navigator", oldNavigator);
  }
});

test("documents: optimistic fallback сохраняет обе версии и восстанавливает concurrent registry entries", async () => {
  await setup();
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const original = localStorage.setItem;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  try {
    let b = null;
    let createInterleaved = false;
    localStorage.setItem = (key, value) => {
      if (key === documents.documentRegistryKey("local") && !createInterleaved) {
        createInterleaved = true;
        b = documents.createDocumentMetadata("local", { id: "doc_B", name: "B" });
      }
      original(key, value);
    };
    const a = documents.createDocumentMetadata("local", { id: "doc_A", name: "A" });
    localStorage.setItem = original;
    const registry = documents.readDocumentRegistry("local");
    assert(createInterleaved && registry.documents[a.id] && registry.documents[b.id],
      "перезапись реестра не потеряла durable per-doc entries");

    const key = documents.documentSnapshotKey("local", a.id);
    let snapshotB = null;
    let writeInterleaved = false;
    localStorage.setItem = (storageKey, value) => {
      if (storageKey === key && !writeInterleaved) {
        writeInterleaved = true;
        snapshotB = documents.saveDocumentSnapshot("local", a, { input: "B" }, {
          expectedRevision: 0, writerId: "tab-B",
        });
      }
      original(storageKey, value);
    };
    const snapshotA = documents.saveDocumentSnapshot("local", a, { input: "A" }, {
      expectedRevision: 0, writerId: "tab-A",
    });
    localStorage.setItem = original;
    eq(snapshotA.revision, snapshotB.revision, "детерминированно получен same-revision race без ложного CAS");
    const backups = [snapshotA, snapshotB].map(snapshot =>
      JSON.parse(localStorage.getItem(documents.documentConflictBackupKey("local", a.id, snapshot.backupId))));
    eq(new Set(backups.map(snapshot => snapshot.data.input)).size, 2, "обе версии доступны в conflict backups");
    assert(backups.some(snapshot => snapshot.data.input === "A") && backups.some(snapshot => snapshot.data.input === "B"),
      "не потеряна ни A, ни B");

    persist.activateDocument("local", a, snapshotB);
    documentsUi.handleDocumentStorageEvent({ key, newValue: JSON.stringify(snapshotA) });
    const banner = document.getElementById("doc-conflict-banner");
    assert(!banner.classList.contains("hidden"), "same revision + different hash открыл explicit conflict UI");
    assert(!document.getElementById("doc-backup-picker").classList.contains("hidden"), "backup picker доступен");
    eq(document.getElementById("doc-conflict-backups").children.length, 2, "обе версии представлены в picker");
    eq(document.getElementById("doc-conflict-text").textContent.includes("dq-document-conflicts:local:"), false,
      "компактный banner не содержит developer keys");
  } finally {
    localStorage.setItem = original;
    restoreGlobalProperty("navigator", oldNavigator);
  }
});

test("documents: backup picker восстанавливает выбранный payload и сохраняет его как выбранную версию", async () => {
  await setup();
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  try {
    context.setContent("backup local", "text");
    const local = await persist.saveNow();
    assert(local.backupKey, "fixture: optimistic fallback создал recoverable backup");
    const doc = persist.currentDocument();
    const external = await documents.saveDocumentSnapshot("local", doc, { input: "external", questions: [] }, {
      expectedRevision: local.revision, writerId: "other-tab",
    });
    documentsUi.handleDocumentStorageEvent({
      key: documents.documentSnapshotKey("local", "default"), newValue: JSON.stringify(external),
    });
    const select = document.getElementById("doc-conflict-backups");
    assert(select.children.some(option => option.value === local.backupKey), "UI прочитал local backup key");
    context.setContent("dirty current", "text");
    select.value = local.backupKey;
    document.getElementById("doc-recover-backup").fire("click");
    eq(context.currentText(), "backup local", "selected backup payload прошёл normal restore");
    eq(documents.readDocumentSnapshot("local", "default").data.input, "backup local",
      "recovery явно сохранила выбранную версию в primary");
    eq(persist.currentDocument().revision, external.revision + 1, "recovery продолжила external revision");
    assert(document.getElementById("doc-conflict-banner").classList.contains("hidden"), "conflict разрешён");
    assert(document.getElementById("doc-backup-picker").classList.contains("hidden"), "picker скрыт после recovery");
  } finally {
    restoreGlobalProperty("navigator", oldNavigator);
  }
});

test("documents: accepting deleted snapshot очищает revision и contentHash перед следующим save", async () => {
  await setup();
  context.setContent("before delete", "text");
  await persist.saveNow();
  assert(persist.currentDocument().contentHash, "fixture: hash присутствует");
  localStorage.removeItem(documents.documentSnapshotKey("local", "default"));
  documentsUi.handleDocumentStorageEvent({ key: documents.documentSnapshotKey("local", "default"), newValue: null });
  document.getElementById("doc-reload").fire("click");
  eq(persist.currentDocument().revision, 0, "deleted acceptance сбросил revision");
  eq(persist.currentDocument().contentHash, null, "deleted acceptance сбросил contentHash");
  context.setContent("after delete", "text");
  const saved = await persist.saveNow();
  eq(saved.revision, 1, "следующий save создал rev1 без self-conflict");
  assert(document.getElementById("doc-conflict-banner").classList.contains("hidden"), "self-conflict не появился");
});

test("documents: initial restore использует enabled текущего owner, не legacy flag", async () => {
  await setup({ beforeInit: () => {
    localStorage.setItem("dq-documents:local:enabled", "0");
    localStorage.setItem("dq-workspace-enabled", "1");
    localStorage.setItem("dq-workspace:local:default", "{corrupt and must not be read");
  } });
  eq(persist.currentDocument().id, "default", "disabled owner default активирован");
  eq(context.currentText(), "", "disabled owner не восстановил snapshot");
  eq(document.getElementById("tb-menu-persist").checked, false, `checkbox отражает owner flag; enabled=${localStorage.getItem("dq-documents:local:enabled")}; doc=${JSON.stringify(persist.currentDocument())}`);
});

test("documents: primary setItem failure не принимает revision/hash", async () => {
  await setup();
  context.setContent("v1", "text");
  persist.setPersistEnabled(false);
  persist.setPersistEnabled(true);
  context.setContent("v2", "text");
  await persist.saveNow();
  const stored = documents.readDocumentSnapshot("local", "default");
  eq(stored.revision, 2, "fixture: stored rev2");
  eq(persist.currentDocument().revision, 2, "fixture: active rev2");
  const original = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key === documents.documentSnapshotKey("local", "default")) throw new Error("primary quota");
    original(key, value);
  };
  context.setContent("uncommitted v3", "text");
  const failed = await persist.saveNow();
  localStorage.setItem = original;
  eq(failed, null, "primary failure возвращает failure");
  eq(documents.readDocumentSnapshot("local", "default").revision, 2, "stored остался rev2");
  eq(persist.currentDocument().revision, 2, "active остался rev2");
  eq(persist.currentDocument().contentHash, stored.contentHash, "active hash не принят из uncommitted snapshot");
  const retry = await persist.saveNow();
  eq(retry.revision, 3, "retry продолжает от stored rev2 без self-conflict");
});

test("documents: persist-off инвалидирует revision0 pending save и очищает own late commit", async () => {
  await setup();
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let block = true;
  let release = null;
  let markEntered = null;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    locks: { request: async (_name, _options, callback) => {
      if (block) {
        markEntered();
        await blocked;
      }
      return callback();
    } },
  } });
  const original = localStorage.setItem;
  try {
    context.setContent("pending revision0", "text");
    const pending = persist.saveNow();
    await entered;
    persist.setPersistEnabled(false);
    release();
    eq(await pending, null, "pending save отменён после persist-off");
    eq(localStorage.getItem(documents.documentSnapshotKey("local", "default")), null,
      "revision0 late write не recreated snapshot");
    eq(persist.currentDocument().revision, 0, "active revision остаётся 0");
    assert(document.getElementById("doc-conflict-banner").classList.contains("hidden"),
      "отменённая запись не создала self-conflict");

    block = false;
    persist.setPersistEnabled(true);
    await persist.saveNow();
    let disableDuringPrimary = true;
    localStorage.setItem = (key, value) => {
      if (disableDuringPrimary && key === documents.documentSnapshotKey("local", "default")) {
        disableDuringPrimary = false;
        persist.setPersistEnabled(false);
      }
      original(key, value);
    };
    const late = await persist.saveNow();
    localStorage.setItem = original;
    eq(late, null, "late committed save не принят после смены generation");
    eq(localStorage.getItem(documents.documentSnapshotKey("local", "default")), null,
      "own late snapshot удалён после commit");
    eq(persist.currentDocument().revision, 0, "late commit не изменил active revision");
    persist.setPersistEnabled(true);
    const restarted = await persist.saveNow();
    assert(restarted, "persist-on после late cleanup сохраняет без self-conflict");
  } finally {
    release();
    localStorage.setItem = original;
    restoreGlobalProperty("navigator", oldNavigator);
  }
});

test("documents: registry/mirror failure reconciles committed revision/hash без self-conflict", async () => {
  await setup();
  await persist.saveNow();
  const registryKey = documents.documentRegistryKey("local");
  const baseline = persist.currentDocument().revision;
  const original = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key === registryKey) throw new Error("registry quota");
    original(key, value);
  };
  await persist.saveNow();
  localStorage.setItem = original;
  const afterRegistry = persist.currentDocument();
  eq(afterRegistry.revision, baseline + 1, "registry failure принял committed revision");
  assert(afterRegistry.contentHash, "committed contentHash reconciled");
  const afterNext = await persist.saveNow();
  eq(afterNext.revision, baseline + 2, "следующий save не считает committed snapshot чужим conflict");

  localStorage.setItem = (key, value) => {
    if (key === "dq-workspace") throw new Error("mirror quota");
    original(key, value);
  };
  await persist.saveNow();
  localStorage.setItem = original;
  eq(persist.currentDocument().revision, baseline + 3, "mirror failure тоже reconciled");
  const afterMirror = await persist.saveNow();
  eq(afterMirror.revision, baseline + 4, "после mirror failure нет self-conflict");
  assert(document.getElementById("doc-conflict-banner").classList.contains("hidden"),
    "registry/mirror ошибки не классифицируются как another writer");
});
