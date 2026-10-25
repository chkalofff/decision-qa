// Доменные тесты: browser /api/run client.

import {
  test, assert, eq, includes, installDom, resetState, mockFetch, sleep,
  runApiRoutes, runCapabilities, TEST_RUN_ID, state, runClient,
} from "./harness.mjs";
import { buildConfigPack } from "../static/config_pack.js";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

const DIGEST_GOLDEN = JSON.parse(readFileSync(
  new NodeURL("../../backend/tests/fixtures/config_pack_parity.json", import.meta.url), "utf8",
)).materials.digestCases;
const TEXT_GOLDEN = DIGEST_GOLDEN.find(fixture => fixture.name === "text");
const PNG_GOLDEN = DIGEST_GOLDEN.find(fixture => fixture.name === "valid-png");

async function testPack() {
  state.models = [{ key: "mA", label: "Model A", status: "running" }];
  state.selectedModels = new Set(["mA"]);
  state.questions = [{ id: "q1", question: "Q?", type: "yes_no" }];
  return buildConfigPack();
}

test("run_client: authenticated create, bounded chunks, hashes/threads и адаптеры canonical runs", async () => {
  installDom(); await resetState();
  const pack = await testPack();
  const capabilities = runCapabilities({ max_files_per_chunk: 2 });
  const calls = mockFetch(runApiRoutes());
  const materials = [
    { name: "a.txt", input: "A" },
    { name: "b.txt", input: "B", images: [PNG_GOLDEN.images[0]] },
    { name: "c.txt", input: "C" },
  ];
  const job = runClient.executeRun({
    pack, materials, overrides: { models: ["mA"], mode: "decisions" },
    threads: 3, capabilities, idempotencyKey: "web-run-1", retryDelayMs: 0,
  });
  const outcome = await job.done;
  eq(outcome.files.length, 3, "paged/final files возвращены");
  eq(outcome.materialHashes.length, 3, "ordered material hashes");
  assert(outcome.materialHashes.every(hash => hash.startsWith("sha256:")), "material hash format");
  eq(outcome.materialsFingerprint, calls.find(call => call.key === "POST /api/run").body.materials_fingerprint,
    "create fingerprint совпадает с подготовленным");
  const created = calls.find(call => call.key === "POST /api/run");
  eq(created.body.threads, 3, "threads в create");
  eq(new Headers(created.headers).get("Idempotency-Key"), "web-run-1", "idempotency header");
  const chunks = calls.filter(call => call.key === `POST /api/run/${TEST_RUN_ID}/files`);
  eq(chunks.length, 2, "max_files_per_chunk соблюдён");
  eq(chunks[0].body.files.length, 2, "первый chunk");
  eq(chunks[1].body.files.length, 1, "второй chunk");
  eq(chunks[0].body.files[0].material_hash, TEXT_GOLDEN.hash, "text upload hash совпадает с Python");
  eq(chunks[0].body.files[1].material_hash, PNG_GOLDEN.hash, "PNG upload hash совпадает с Python");
  eq(chunks[0].body.files[1].material.images[0].name, "image-1.png", "image metadata для backend hash");
  eq(chunks[0].body.files[1].material.images[0].sha256, PNG_GOLDEN.imageRaw, "metadata хэширует decoded PNG bytes");
  eq(chunks[0].body.files[1].content_sha256, PNG_GOLDEN.composite, "raw composite sha256");
  eq(runClient.singleResultsFromFile(outcome.files[0], "decisions").mA.ok, true, "single legacy shape");
  eq(runClient.batchResultsFromFile(outcome.files[0]).mA.ok, true, "batch legacy shape");
  eq(runClient.singleRunLinks(outcome.files[0], TEST_RUN_ID, "decisions").mA.decisions, TEST_RUN_ID, "single link");
  eq(runClient.batchRunLinks(outcome.files[0], TEST_RUN_ID).mA, TEST_RUN_ID, "batch link");
});

test("run_client: paged results читаются до next_offset=null", async () => {
  installDom(); await resetState();
  const calls = mockFetch({
    [`GET /api/run/${TEST_RUN_ID}/files?offset=0&limit=2`]: {
      files: [{ i: 0 }, { i: 1 }], next_offset: 2,
    },
    [`GET /api/run/${TEST_RUN_ID}/files?offset=2&limit=2`]: {
      files: [{ i: 2 }], next_offset: null,
    },
  });
  const files = await runClient.getRunResults(TEST_RUN_ID, { default_page_limit: 2, max_page_limit: 2 });
  eq(files.map(file => file.i).join(","), "0,1,2", "страницы объединены в source order");
  eq(calls.length, 2, "ровно два запроса страниц");
});

test("run_client: reconnect after/Last-Event-ID и seq dedup после premature EOF", async () => {
  installDom(); await resetState();
  const start = { type: "run_start", seq: 1 };
  const file = { type: "file", seq: 2, i: 0 };
  const end = { type: "run_end", seq: 3, status: "completed" };
  const block = event => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
  const calls = mockFetch({
    [`GET /api/run/${TEST_RUN_ID}/events?after=0`]: { __sse: block(start) },
    [`GET /api/run/${TEST_RUN_ID}/events?after=1`]: { __sse: block(file) + block(file) + block(end) },
  });
  const events = [];
  const cursor = await runClient.watchRun(TEST_RUN_ID, { onEvent: event => events.push(event), retryDelayMs: 0 });
  eq(cursor, 3, "cursor последнего события");
  eq(events.map(event => event.seq).join(","), "1,2,3", "duplicate seq не доставлен повторно");
  eq(calls.length, 2, "premature EOF вызвал reconnect");
  eq(new Headers(calls[1].headers).get("Last-Event-ID"), "1", "Last-Event-ID на reconnect");
});

test("run_client: resync_required replay и понятная ошибка oversized chunk", async () => {
  installDom(); await resetState();
  const block = event => `data: ${JSON.stringify(event)}\n\n`;
  const calls = mockFetch({
    [`GET /api/run/${TEST_RUN_ID}/events?after=0`]: {
      __sse: block({ type: "run_start", seq: 1 }) + block({ type: "resync_required", seq: 2 }),
    },
    [`GET /api/run/${TEST_RUN_ID}/events?after=1`]: {
      __sse: block({ type: "file", seq: 2, i: 0 }) + block({ type: "run_end", seq: 3, status: "completed" }),
    },
  });
  const events = [];
  await runClient.watchRun(TEST_RUN_ID, { onEvent: event => events.push(event), retryDelayMs: 0 });
  eq(events.map(event => event.seq).join(","), "1,2,3", "resync replay продолжил с последнего accepted seq");
  eq(calls.length, 2, "один replay");

  const pack = await testPack();
  mockFetch({});
  const job = runClient.executeRun({
    pack, materials: [{ input: "x".repeat(2000) }], capabilities: runCapabilities({ max_chunk_bytes: 1000 }),
    overrides: { models: ["mA"], mode: "decisions" }, retryDelayMs: 0,
  });
  let error = null;
  try { await job.done; } catch (caught) { error = caught; }
  assert(error, "oversized chunk отклонён");
  includes(error.message, "лимит чанка", "ошибка называет лимит");
});


test("run_client: both native + remote_chat + SystemOne сохраняет decisions/clef и одинаковые links", async () => {
  const file = { runs: [
    { model: "native", mode: "decisions", ok: true, answers: {}, usage: {}, metrics: {} },
    { model: "native", mode: "fast_batch", ok: true, answers: {}, usage: {}, metrics: {} },
    { model: "remote", mode: "decisions", ok: true, answers: {}, usage: {}, metrics: {} },
    { model: "clef", mode: "decisions", ok: true, answers: {}, usage: {}, metrics: {} },
  ] };
  const systemOne = new Set(["clef"]);
  const adapted = runClient.singleResultsFromFile(file, "both", systemOne);
  const links = runClient.singleRunLinks(file, TEST_RUN_ID, "both", systemOne);
  assert(adapted.native.decisions && adapted.native.fast_batch, "native оба прохода");
  assert(adapted.remote.decisions, "remote sole ordinary остаётся decisions");
  eq(adapted.remote.clef, undefined, "remote не классифицируется как clef");
  assert(adapted.clef.clef, "SystemOne использует clef slot");
  eq(links.remote.decisions, TEST_RUN_ID, "remote decisions link");
  eq(links.remote.clef, undefined, "remote clef link отсутствует");
  eq(links.clef.clef, TEST_RUN_ID, "SystemOne clef link");
});

test("run_client: cancel during create отменяет созданный job до upload; HTTP failure aborts local SSE и доходит до caller/done", async () => {
  installDom(); await resetState();
  const pack = await testPack();
  let resolveCreate;
  const calls = mockFetch({
    "POST /api/run": () => new Promise(resolve => {
      resolveCreate = () => resolve({ run_id: TEST_RUN_ID, status: "uploading" });
    }),
    [`POST /api/run/${TEST_RUN_ID}/cancel`]: { run_id: TEST_RUN_ID, status: "cancelled" },
    [`GET /api/run/${TEST_RUN_ID}`]: { run_id: TEST_RUN_ID, status: "cancelled" },
  });
  const capabilities = runCapabilities();
  const creating = runClient.executeRun({
    pack, materials: [{ input: "A" }], capabilities,
    overrides: { models: ["mA"], mode: "decisions" }, retryDelayMs: 0,
  });
  await sleep(10);
  await creating.cancel();
  resolveCreate();
  const createdOutcome = await creating.done;
  eq(createdOutcome.metadata.status, "cancelled", "just-created job отменён");
  eq(calls.filter(call => call.key === `POST /api/run/${TEST_RUN_ID}/cancel`).length, 1, "cancel после create");
  eq(calls.filter(call => call.key === `POST /api/run/${TEST_RUN_ID}/files`).length, 0, "upload не начат");
  eq(calls.filter(call => call.key === `POST /api/run/${TEST_RUN_ID}/start`).length, 0, "inference не начат");

  let resolveEvents;
  const routes = runApiRoutes({ onSse: text => new Promise(resolve => { resolveEvents = () => resolve(text); }) });
  routes[`POST /api/run/${TEST_RUN_ID}/cancel`] = { __status: 503, detail: "cancel unavailable" };
  mockFetch(routes);
  const running = runClient.executeRun({
    pack, materials: [{ input: "A" }], capabilities,
    overrides: { models: ["mA"], mode: "decisions" }, retryDelayMs: 0,
  });
  await sleep(20);
  let cancelError = null;
  try { await running.cancel(); } catch (error) { cancelError = error; }
  assert(cancelError, "HTTP cancel failure дошёл до caller");
  includes(cancelError.message, "cancel unavailable", "точная причина cancel failure");
  let doneError = null;
  const done = running.done.catch(error => { doneError = error; });
  resolveEvents();
  await done;
  assert(doneError, "aborted local SSE завершил done с ошибкой");
  includes(doneError.message, "cancel unavailable", "done сохраняет точную причину");
});
