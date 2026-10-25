// Доменные тесты: версионируемый config pack, JCS/SHA-256 и материалы.

import { test, assert, eq, includes, throws, resetState, state } from "./harness.mjs";
import { deepStrictEqual, rejects } from "node:assert";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import * as packs from "../static/config_pack.js";
import { evaluateDecision } from "../static/decision.js";

const FIXTURE = JSON.parse(readFileSync(new NodeURL("../../backend/tests/fixtures/config_pack_parity.json", import.meta.url), "utf8"));

function emptyPack() {
  return {
    version: 1,
    fingerprint_version: 1,
    questions: [],
    decision: { enabled: true, outcomes: [] },
    settings: { mode: "decisions", models: [], aggregation: packs.AGGREGATION_POLICY },
  };
}

test("config pack: official RFC 8785 и локальные Unicode/float vectors", async () => {
  for (const fixture of FIXTURE.jcsCases) {
    const actual = new TextDecoder().decode(packs.canonicalBytes(fixture.input));
    eq(actual, fixture.expected, fixture.name);
  }
  throws(() => packs.canonicalBytes({ value: NaN }), "NaN", "NaN запрещён");
  throws(() => packs.canonicalBytes({ value: Infinity }), "Infinity", "Infinity запрещён");
});

test("config pack: full/semantic projections, hashes, overrides и strict validation", async () => {
  for (const [name, fixture] of Object.entries(FIXTURE.packs)) {
    deepStrictEqual(packs.fullProjection(fixture.pack), fixture.pack, `${name}: exact full projection`);
    eq(await packs.configHash(fixture.pack), fixture.hash, `${name}: full hash`);
    eq(await packs.configFingerprint(fixture.pack), fixture.fingerprint, `${name}: semantic fingerprint`);
    if (fixture.semantic) deepStrictEqual(packs.semanticProjection(fixture.pack), fixture.semantic, `${name}: defaults только в semantic`);
  }
  const base = FIXTURE.packs.base.pack;
  const original = structuredClone(base);
  deepStrictEqual(packs.fullProjection(base), base, "full projection сохраняет cosmetic/UI/direction");
  deepStrictEqual(packs.semanticProjection(base), FIXTURE.semanticProjection, "явная semantic projection");
  const effective = await packs.effectivePack(base, {
    models: FIXTURE.overrides.models,
    mode: FIXTURE.overrides.mode,
  });
  eq(effective.hash, FIXTURE.overrides.hash, "effective full hash");
  eq(effective.fingerprint, FIXTURE.overrides.fingerprint, "effective semantic fingerprint");
  deepStrictEqual(base, original, "overrides не мутируют исходный файл");

  const empty = emptyPack();
  empty.decision.enabled = false;
  empty.decision.outcomes = [{ id: "empty", label: "Empty", rules: [{ conditions: [] }] }];
  eq(packs.validatePack(empty).decision.enabled, false, "enabled:false и пустые web rules легальны");
  throws(() => packs.validatePack(empty, { requireDecision: true }), "decision.enabled", "CLI-facing requireDecision");
  const missing = emptyPack();
  missing.questions = [{ type: "yes_no", question: "Q" }];
  throws(() => packs.normalizePack(missing), "questions[0].id", "ID не генерируется");
  const duplicate = emptyPack();
  duplicate.decision.outcomes = [
    { id: "same", label: "One", rules: [] },
    { id: "same", label: "Two", rules: [] },
  ];
  throws(() => packs.normalizePack(duplicate), "duplicate outcome id", "outcome IDs уникальны");
});

test("config pack: text/dict/list, ordered images, materials и run fingerprints", async () => {
  for (const fixture of FIXTURE.materials.cases) {
    eq(await packs.rawContentSha256(fixture.content), fixture.raw, `${fixture.name}: raw content`);
    eq(await packs.compositeContentSha256(fixture.content, fixture.images), fixture.composite, `${fixture.name}: rename-stable composite`);
    eq(await packs.materialHash(fixture.content, fixture.images, fixture.metadata), fixture.hash, `${fixture.name}: material`);
    if (fixture.reversedImagesHash) {
      eq(await packs.materialHash(fixture.content, [...fixture.images].reverse(), fixture.metadata),
        fixture.reversedImagesHash, "порядок изображений значим");
    }
  }
  const materials = FIXTURE.materials;
  const actual = await packs.materialsFingerprint(materials.orderedHashes);
  eq(actual, materials.materialsFingerprint, "ordered materials fingerprint");
  assert(await packs.materialsFingerprint([...materials.orderedHashes].reverse()) !== actual,
    "порядок материалов значим");
  eq(await packs.runFingerprint(FIXTURE.packs.base.fingerprint, actual), materials.runFingerprint,
    "run = JCS(config_fingerprint + materials_fingerprint)");
});

test("config pack: raw image bytes и content_digest совпадают с Python golden", async () => {
  for (const fixture of FIXTURE.materials.digestCases) {
    eq(await packs.compositeContentSha256(fixture.content, fixture.images), fixture.composite,
      `${fixture.name}: composite digest`);
    if (fixture.imageRaw) {
      eq(await packs.imageContentSha256(fixture.images[0]), fixture.imageRaw, `${fixture.name}: decoded image bytes`);
      const encoded = fixture.images[0].slice(fixture.images[0].indexOf(",") + 1);
      const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      eq(await packs.imageContentSha256(encoded), fixture.imageRaw, `${fixture.name}: bare base64`);
      eq(await packs.imageContentSha256(bytes), fixture.imageRaw, `${fixture.name}: Uint8Array`);
      eq(await packs.imageContentSha256(bytes.buffer), fixture.imageRaw, `${fixture.name}: ArrayBuffer`);
      assert(await packs.rawContentSha256(fixture.images[0]) !== fixture.imageRaw,
        "data URL/base64 text не должен хэшироваться вместо image bytes");
    }
    eq(await packs.materialHash(fixture.content, fixture.images, fixture.metadata, fixture.composite), fixture.hash,
      `${fixture.name}: materialHash(content_digest)`);
  }
  await rejects(packs.materialHash("A", [], {}, "ABC"), /content_digest/, "digest валидация");
  await rejects(packs.materialHash("A", [], {}, "A".repeat(64)), /content_digest/, "lowercase hex обязателен");
});

test("config pack: aggregation fixtures совместимы с JS decision, both/partial сохранены", async () => {
  for (const fixture of FIXTURE.aggregationCases) {
    deepStrictEqual(evaluateDecision(fixture.config.decision, fixture.expected.answers),
      fixture.expected.decision, `${fixture.name}: aggregate decision`);
    const ordinary = fixture.runs.filter(run => run.mode === "decisions");
    for (const run of ordinary) {
      const expected = fixture.expected.modelOutcomes[run.model];
      if (run.ok) {
        eq(evaluateDecision(fixture.config.decision, run.answers)?.outcomeId ?? null, expected,
          `${fixture.name}: ${run.model} individual decision`);
      } else {
        eq(expected, null, "failed ordinary model не даёт решения");
      }
    }
    assert(fixture.runs.some(run => run.mode === "fast_batch") || fixture.name.includes("ties"),
      "both diagnostic run сохранён в общей fixture");
  }
});

test("config pack: сборка из state и download; batch mode, temperature и actionable errors", async () => {
  await resetState();
  state.models = [
    { key: "clef", label: "Clef", status: "running", api: "systemone" },
    { key: "sg", label: "SG", status: "running", api: "decisions" },
    { key: "stopped", label: "Stopped", status: "stopped", api: "decisions" },
  ];
  state.selectedModels = new Set(["clef", "sg", "stopped"]);
  state.questions = [{
    id: "q-verbatim", question: "Подходит?", type: "yes_no", yes: "Да", no: "Нет",
    direction: "yes", collapsed: true, _fresh: true,
  }];
  state.decision = {
    enabled: true,
    outcomes: [{
      id: "o-verbatim", label: "Принять", color: "green", collapsed: false,
      rules: [{ anyOf: false, conditions: [{ question: "q-verbatim", answer: "yes", op: "gte", threshold: 0.5 }] }],
    }],
  };
  state.runMode = "both";
  state.temperature = 0.65;
  state.pinnedFormats = { sg: 7, clef: 3, ignored: 9 };
  const pack = await packs.buildConfigPack({ name: "Текущий документ" });
  eq(pack.version, 1);
  eq(pack.fingerprint_version, 1);
  deepStrictEqual(pack.settings.models, ["clef", "sg"], "только selected WORKING models");
  eq(pack.settings.mode, "both", "single actual mode");
  eq(pack.settings.temperature, 0.65, "ordinary decisions temperature");
  deepStrictEqual(pack.settings.prompt_formats, { sg: 7, clef: 3 }, "per-model formats без сторонних ключей");
  eq(pack.settings.aggregation, "mean_probability_v1");
  eq(pack.questions[0].id, "q-verbatim");
  eq(pack.questions[0].direction, "yes", "direction входит в full pack");
  assert(!("collapsed" in pack.questions[0]) && !("_fresh" in pack.questions[0]), "UI вопроса не экспортируется");
  eq(pack.decision.outcomes[0].id, "o-verbatim", "outcome id сохранён дословно");
  assert(!("collapsed" in pack.decision.outcomes[0]), "UI исхода не экспортируется");
  assert(!("materials" in pack) && !("input" in pack) && !("images" in pack), "материалы не встроены");
  eq(await packs.configHash(pack), pack.hash, "download hash самосогласован");
  eq(await packs.configFingerprint(pack), pack.fingerprint, "download fingerprint самосогласован");

  // Batch всегда использует фактический decisions; только SystemOne — без temperature.
  state.pageMode = "batch";
  state.models = [{ key: "clef", label: "Clef", status: "running", api: "systemone" }];
  state.selectedModels = new Set(["clef"]);
  state.pinnedFormats = { clef: 4 };
  const batchPack = await packs.buildConfigPack();
  eq(batchPack.settings.mode, "decisions", "batch не наследует single both");
  assert(!("temperature" in batchPack.settings), "не применяемая temperature отсутствует");
  deepStrictEqual(batchPack.settings.prompt_formats, { clef: 4 }, "форматы берутся из текущего state");

  let captured = null;
  const originalCreate = globalThis.URL.createObjectURL;
  globalThis.URL.createObjectURL = (blob) => { captured = blob.content; return "blob:config"; };
  const downloaded = await packs.downloadConfigPack({ filename: "my-pack" });
  globalThis.URL.createObjectURL = originalCreate;
  assert(downloaded, "валидный пакет скачан");
  const anchor = globalThis.__clicks.at(-1);
  eq(anchor.download, "my-pack.json");
  const disk = JSON.parse(captured);
  eq(disk.hash, downloaded.hash);
  eq(disk.fingerprint, downloaded.fingerprint);

  const clicksBefore = globalThis.__clicks.length;
  const errors = [];
  state.questions = [];
  const rejected = await packs.downloadConfigPack({ onError: message => errors.push(message) });
  eq(rejected, null, "невалидный документ не скачивается");
  eq(globalThis.__clicks.length, clicksBefore, "при ошибке anchor не создаётся");
  includes(errors[0], "Экспорт конфига невозможен");
  includes(errors[0], "хотя бы один вопрос");

  state.questions = [{ id: "q-verbatim", question: "Подходит?", type: "yes_no" }];
  state.selectedModels = new Set();
  const noModels = await packs.downloadConfigPack({ onError: message => errors.push(message) });
  eq(noModels, null, "пустой набор моделей не скачивается");
  includes(errors[1], "хотя бы одну работающую модель", "ошибка модели понятна пользователю");
  eq(globalThis.__clicks.length, clicksBefore, "обе ошибки обошлись без скачивания");
});
