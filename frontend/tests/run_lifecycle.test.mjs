// Доменные тесты: entry guards, immutable pre-await snapshots и generation reset.

import {
  test, assert, eq, installDom, resetState, mockFetch, sleep, domApp,
  runApiRoutes, TEST_RUN_ID, state, batch, persist,
} from "./harness.mjs";

function models() {
  return [
    { key: "mA", label: "A", status: "running", api: "decisions", type: "sglang", vision: true },
    { key: "mB", label: "B", status: "running", api: "decisions", type: "sglang", vision: true },
  ];
}

function setupBatch() {
  state.models = models();
  state.selectedModels = new Set(["mA"]);
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no" }];
  batch.loadPresetFiles([{ name: "a.txt", content: "исходный файл" }]);
}

function delayedDigest() {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.digest.bind(subtle);
  let release;
  let announce;
  const started = new Promise(resolve => { announce = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  let delayed = false;
  subtle.digest = (...args) => {
    if (delayed) return original(...args);
    delayed = true;
    announce();
    return pending.then(() => original(...args));
  };
  return {
    started,
    release: () => { subtle.digest = original; release(); },
    restore: () => { subtle.digest = original; },
  };
}

test("lifecycle batch: double-run создаёт один job; delayed completion после resetDocumentState не пишет в новый документ", async () => {
  installDom(); await resetState(); domApp(); batch.initBatch({}); setupBatch();
  let calls = mockFetch(runApiRoutes());
  await Promise.all([batch.runBatch(), batch.runBatch()]);
  eq(calls.filter(call => call.key === "POST /api/run").length, 1, "batch guard сработал до hashing/dialog");
  eq(state.batch.running, false, "batch running очищен текущим job");

  setupBatch();
  let resolveEvents;
  calls = mockFetch(runApiRoutes({ onSse: text => new Promise(resolve => { resolveEvents = () => resolve(text); }) }));
  const running = batch.runBatch();
  await sleep(30);
  assert(resolveEvents, "старый batch job ждёт terminal SSE");
  persist.resetDocumentState();
  resolveEvents();
  await running;
  eq(Object.keys(state.batch.results).length, 0, "старые file events не записали batch results");
  eq(state.batch.resultsMeta, null, "старый final не записал batch latestRun/runs");
  eq(state.batch.running, false, "fresh batch не блокирован старым finally");
  eq(state.batch.files.length, 0, "fresh batch остаётся пустым");
});

test("lifecycle batch: delayed hash + edit сохраняет файлы/config/decision snapshot и stale", async () => {
  installDom(); await resetState(); domApp(); batch.initBatch({}); setupBatch();
  state.decision = { enabled: true, outcomes: [{ id: "o1", label: "Старый исход", color: "green", rules: [] }] };
  state.temperature = 0.6;
  state.threads = 3;
  const delay = delayedDigest();
  const calls = mockFetch(runApiRoutes());
  const running = batch.runBatch();
  try {
    await delay.started;
    state.batch.files[0].name = "new.txt";
    state.batch.files[0].text = "Новый файл";
    state.questions[0].question = "Новый вопрос?";
    state.decision.outcomes[0].label = "Новый исход";
    state.selectedModels = new Set(["mB"]);
    state.temperature = 1.7;
    state.threads = 7;
    delay.release();
  } finally {
    delay.restore();
  }
  await running;
  const created = calls.find(call => call.key === "POST /api/run").body;
  const uploaded = calls.find(call => call.key.includes("/files") && call.body?.files).body.files[0];
  eq(uploaded.input, "исходный файл", "file input захвачен до await");
  eq(uploaded.name, "a.txt", "file name захвачен до await");
  eq(created.pack.questions[0].question, "Q?", "questions до await");
  eq(created.pack.decision.outcomes[0].label, "Старый исход", "decision до await");
  eq(created.overrides.models.join(","), "mA", "models до await");
  eq(created.pack.settings.temperature, 0.6, "temperature до await");
  eq(created.threads, 3, "threads до await");
  eq(state.batch.decision.outcomes[0].label, "Старый исход", "старые answers не совмещены с новым decision");
  eq(state.batch.resultsStale, true, "post-await batch edits помечены stale");
});


test("lifecycle batch: cancel HTTP failure всё равно останавливает локальный run и показывает точную ошибку", async () => {
  installDom(); await resetState(); domApp(); batch.initBatch({}); setupBatch();
  let error = null;
  batch.initBatch({ showError: message => { error = message; } });
  let resolveEvents;
  const routes = runApiRoutes({ onSse: text => new Promise(resolve => { resolveEvents = () => resolve(text); }) });
  routes[`POST /api/run/${TEST_RUN_ID}/cancel`] = { __status: 503, detail: "cancel unavailable" };
  const calls = mockFetch(routes);
  const running = batch.runBatch();
  await sleep(30);
  document.getElementById("btn-batch-cancel").fire("click");
  resolveEvents();
  await running;
  await sleep(450);
  assert(error, `cancel failure показан пользователю; running=${state.batch.running}; cancelled=${state.batch.cancelled}; calls=${calls.map(call => call.key).join("|")}`);
  eq(error.includes("cancel unavailable"), true, "текст содержит точную причину");
  eq(state.batch.running, false, "running очищен despite cancel failure");
  eq(state.batch.cancelled, true, "локальная отмена зафиксирована");
});


test("lifecycle batch: early cancel до activeRunJob во время hashing и rerun-dialog не даёт создать job", async () => {
  installDom(); await resetState(); domApp(); batch.initBatch({}); setupBatch();
  const delay = delayedDigest();
  let calls = mockFetch(runApiRoutes());
  const hashing = batch.runBatch();
  try {
    await delay.started;
    document.getElementById("btn-batch-cancel").fire("click");
    delay.release();
  } finally {
    delay.restore();
  }
  await hashing;
  eq(calls.filter(call => call.key === "POST /api/run").length, 0, "cancel во время hashing предотвратил create");
  eq(state.batch.cancelled, true, "ранняя отмена не перезаписана");
  eq(state.batch.running, false, "hashing phase завершилась локально");

  calls = mockFetch(runApiRoutes());
  await batch.runBatch();
  eq(calls.filter(call => call.key === "POST /api/run").length, 1, "после отмены можно явно запустить новый job");
  const dialogRun = batch.runBatch();
  await sleep(20);
  assert(document.getElementById("rerun-dialog"), "rerun dialog открыт до activeRunJob");
  document.getElementById("btn-batch-cancel").fire("click");
  await dialogRun;
  eq(document.getElementById("rerun-dialog"), null, "early cancel закрыл dialog");
  eq(calls.filter(call => call.key === "POST /api/run").length, 1, "cancel во время dialog не создал второй job");
  eq(state.batch.cancelled, true, "dialog cancellation не сброшена");
  eq(state.batch.running, false, "dialog phase завершилась локально");
});
