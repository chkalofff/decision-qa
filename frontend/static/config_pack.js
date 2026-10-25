// Версионируемый конфиг-пакет CLI: JCS + SHA-256, без материалов и UI-состояния.

import { state, selectedModelKeys } from "./state.js";
import { buildQuestionsPayload, withDirections } from "./questions.js";
import canonicalize from "./vendor/canonicalize.js";

export const PACK_VERSION = 1;
export const FINGERPRINT_VERSION = 1;
export const AGGREGATION_POLICY = "mean_probability_v1";

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const MODES = new Set(["decisions", "fast_batch", "both"]);
const DIRECTIONS = {
  yes_no: new Set(["yes", "no", "neutral"]),
  score: new Set(["up", "down", "neutral"]),
};
const TOP_LEVEL = new Set([
  "version", "fingerprint_version", "name", "description", "questions",
  "decision", "settings", "hash", "fingerprint", "ui",
]);

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function checkJson(value, path) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || isNumber(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkJson(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) checkJson(item, `${path}.${key}`);
    return;
  }
  fail(path, "value is not finite JSON data");
}

function copyJson(value) {
  if (Array.isArray(value)) return value.map(copyJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJson(item)]));
  }
  return value;
}

function requiredDict(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
  return value;
}

function requiredList(value, path) {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function requiredString(value, path, nonempty = false) {
  if (typeof value !== "string") fail(path, "expected a string");
  if (nonempty && !value.trim()) fail(path, "must not be empty");
  return value;
}

function normalizeQuestion(question, index) {
  const path = `questions[${index}]`;
  const source = requiredDict(question, path);
  const result = copyJson(source);
  requiredString(source.id, `${path}.id`, true);
  result.question = requiredString(source.question ?? "", `${path}.question`);
  const qtype = requiredString(source.type, `${path}.type`);
  if (!["yes_no", "choice", "score"].includes(qtype)) fail(`${path}.type`, `unsupported question type ${JSON.stringify(qtype)}`);
  if (source.direction != null && (!DIRECTIONS[qtype] || !DIRECTIONS[qtype].has(source.direction))) {
    fail(`${path}.direction`, `invalid direction ${JSON.stringify(source.direction)} for ${qtype}`);
  }
  for (const key of ["yes", "no"]) {
    if (source[key] != null) requiredString(source[key], `${path}.${key}`);
  }
  if (qtype === "choice") {
    const options = requiredList(source.options, `${path}.options`);
    if (options.length < 2 || options.length > 26) fail(`${path}.options`, "choice requires 2..26 options");
    const seen = new Set();
    result.options = options.map((option, optionIndex) => {
      const optionPath = `${path}.options[${optionIndex}]`;
      const optionSource = requiredDict(option, optionPath);
      const name = requiredString(optionSource.name, `${optionPath}.name`, true);
      if (/[\r\n]/.test(name)) fail(`${optionPath}.name`, "newlines are not allowed");
      const folded = name.trim().toLowerCase();
      if (seen.has(folded)) fail(`${optionPath}.name`, `duplicate option name ${JSON.stringify(name)}`);
      seen.add(folded);
      if (optionSource.description != null) requiredString(optionSource.description, `${optionPath}.description`);
      return copyJson(optionSource);
    });
  } else if (qtype === "score") {
    const levels = requiredList(source.levels, `${path}.levels`);
    if (levels.length < 2 || levels.length > 10) fail(`${path}.levels`, "score requires 2..10 levels");
    levels.forEach((level, levelIndex) => requiredString(level, `${path}.levels[${levelIndex}]`));
  }
  return result;
}

function normalizeCondition(condition, path, questions) {
  const source = requiredDict(condition, path);
  const result = copyJson(source);
  const qid = requiredString(source.question, `${path}.question`, true);
  const question = questions[qid];
  if (!question) fail(`${path}.question`, `unknown question id ${JSON.stringify(qid)}`);
  const op = source.op ?? "gte";
  if (op !== "gte" && op !== "lt") fail(`${path}.op`, "expected 'gte' or 'lt'");
  result.op = op;
  if (source.answer != null) {
    requiredString(source.answer, `${path}.answer`);
    if (question.type === "score") fail(`${path}.answer`, "score conditions use score, not answer");
    const options = question.type === "yes_no" ? ["yes", "no"] : question.options.map(option => option.name);
    if (!options.includes(source.answer)) fail(`${path}.answer`, `question ${JSON.stringify(qid)} has no answer ${JSON.stringify(source.answer)}`);
    if (!isNumber(source.threshold) || source.threshold < 0 || source.threshold > 1) {
      fail(`${path}.threshold`, "expected a finite number in 0..1");
    }
  } else {
    if (question.type !== "score") fail(`${path}.answer`, "non-score conditions require answer and threshold");
    const maxScore = question.levels.length - 1;
    if (!isNumber(source.score) || source.score < 0 || source.score > maxScore) {
      fail(`${path}.score`, `expected a finite number in 0..${maxScore}`);
    }
  }
  return result;
}

function normalizeDecision(decision, questions) {
  const source = requiredDict(decision, "decision");
  const result = copyJson(source);
  const enabled = source.enabled ?? true;
  if (typeof enabled !== "boolean") fail("decision.enabled", "expected a boolean");
  result.enabled = enabled;
  const outcomes = requiredList(source.outcomes, "decision.outcomes");
  const qmap = Object.fromEntries(questions.map(question => [question.id, question]));
  const outcomeIds = new Set();
  const labels = new Set();
  let defaults = 0;
  result.outcomes = outcomes.map((outcome, outcomeIndex) => {
    const path = `decision.outcomes[${outcomeIndex}]`;
    const outcomeSource = requiredDict(outcome, path);
    const outcomeResult = copyJson(outcomeSource);
    const outcomeId = requiredString(outcomeSource.id, `${path}.id`, true);
    if (outcomeIds.has(outcomeId)) fail(`${path}.id`, `duplicate outcome id ${JSON.stringify(outcomeId)}`);
    outcomeIds.add(outcomeId);
    const label = requiredString(outcomeSource.label, `${path}.label`, true).trim();
    if (labels.has(label)) fail(`${path}.label`, `duplicate outcome label ${JSON.stringify(outcomeSource.label)}`);
    labels.add(label);
    if ("color" in outcomeSource) requiredString(outcomeSource.color, `${path}.color`);
    const isDefault = outcomeSource.isDefault ?? false;
    if (typeof isDefault !== "boolean") fail(`${path}.isDefault`, "expected a boolean");
    outcomeResult.isDefault = isDefault;
    if (isDefault) defaults += 1;
    const rules = requiredList(outcomeSource.rules ?? [], `${path}.rules`);
    outcomeResult.rules = rules.map((rule, ruleIndex) => {
      const rulePath = `${path}.rules[${ruleIndex}]`;
      const ruleSource = requiredDict(rule, rulePath);
      const ruleResult = copyJson(ruleSource);
      const anyOf = ruleSource.anyOf ?? false;
      if (typeof anyOf !== "boolean") fail(`${rulePath}.anyOf`, "expected a boolean");
      ruleResult.anyOf = anyOf;
      const conditions = requiredList(ruleSource.conditions ?? [], `${rulePath}.conditions`);
      ruleResult.conditions = conditions.map((condition, conditionIndex) =>
        normalizeCondition(condition, `${rulePath}.conditions[${conditionIndex}]`, qmap));
      return ruleResult;
    });
    return outcomeResult;
  });
  if (defaults > 1) fail("decision.outcomes", "at most one default outcome is allowed");
  return result;
}

function normalizeSettings(settings) {
  const source = requiredDict(settings, "settings");
  const result = copyJson(source);
  if (!MODES.has(source.mode)) fail("settings.mode", "expected decisions, fast_batch or both");
  const models = requiredList(source.models, "settings.models");
  const seen = new Set();
  models.forEach((model, index) => {
    requiredString(model, `settings.models[${index}]`, true);
    if (seen.has(model)) fail(`settings.models[${index}]`, `duplicate model key ${JSON.stringify(model)}`);
    seen.add(model);
  });
  if (source.aggregation !== AGGREGATION_POLICY) fail("settings.aggregation", `unsupported policy ${JSON.stringify(source.aggregation)}`);
  if ("temperature" in source && (!isNumber(source.temperature) || source.temperature <= 0)) {
    fail("settings.temperature", "expected a finite number greater than zero");
  }
  if ("prompt_formats" in source) {
    const formats = requiredDict(source.prompt_formats, "settings.prompt_formats");
    for (const [model, version] of Object.entries(formats)) {
      requiredString(model, "settings.prompt_formats key", true);
      if (!Number.isInteger(version)) fail(`settings.prompt_formats.${model}`, "expected an integer");
    }
  }
  if ("inference" in source) requiredDict(source.inference, "settings.inference");
  return result;
}

export function normalizePack(pack, { requireDecision = false } = {}) {
  const source = requiredDict(pack, "pack");
  checkJson(source, "pack");
  const unknown = Object.keys(source).filter(key => !TOP_LEVEL.has(key));
  if (unknown.length) fail("pack", `unknown top-level fields: ${unknown.sort().join(", ")}`);
  if (source.version !== PACK_VERSION) fail("version", `expected ${PACK_VERSION}`);
  if (source.fingerprint_version !== FINGERPRINT_VERSION) fail("fingerprint_version", `expected ${FINGERPRINT_VERSION}`);
  const result = copyJson(source);
  for (const key of ["name", "description"]) {
    if (key in source) requiredString(source[key], key);
  }
  for (const key of ["hash", "fingerprint"]) {
    if (key in source && (typeof source[key] !== "string" || !HASH_RE.test(source[key]))) {
      fail(key, "expected 'sha256:' followed by 64 lowercase hex characters");
    }
  }
  const questions = requiredList(source.questions, "questions");
  result.questions = questions.map(normalizeQuestion);
  const questionIds = new Set();
  result.questions.forEach((question, index) => {
    if (questionIds.has(question.id)) fail(`questions[${index}].id`, `duplicate question id ${JSON.stringify(question.id)}`);
    questionIds.add(question.id);
  });
  result.decision = normalizeDecision(source.decision, result.questions);
  result.settings = normalizeSettings(source.settings);
  if (requireDecision && !result.decision.enabled) fail("decision.enabled", "decision pipeline requires enabled:true");
  return result;
}

export function validatePack(pack, options = {}) {
  return normalizePack(pack, options);
}

export function fullProjection(pack) {
  const source = requiredDict(pack, "pack");
  normalizePack(source);
  const projection = copyJson(source);
  delete projection.hash;
  delete projection.fingerprint;
  return projection;
}

function semanticCondition(condition) {
  const result = { question: condition.question, op: condition.op };
  if (condition.answer != null) {
    result.answer = condition.answer;
    result.threshold = condition.threshold;
  } else {
    result.score = condition.score;
  }
  return result;
}

export function semanticProjection(pack) {
  const normalized = normalizePack(pack);
  const questions = normalized.questions.map(question => {
    const projected = { id: question.id, type: question.type, question: question.question };
    if (question.type === "yes_no") {
      projected.yes = question.yes ?? null;
      projected.no = question.no ?? null;
    } else if (question.type === "choice") {
      projected.options = question.options.map(option => ({ name: option.name, description: option.description ?? null }));
    } else {
      projected.levels = copyJson(question.levels);
    }
    return projected;
  });
  const outcomes = normalized.decision.outcomes.map(outcome => ({
    id: outcome.id,
    isDefault: outcome.isDefault,
    rules: outcome.rules.map(rule => ({
      anyOf: rule.anyOf,
      conditions: rule.conditions.map(semanticCondition),
    })),
  }));
  const settings = copyJson(normalized.settings);
  settings.models = [...settings.models].sort();
  return {
    fingerprint_version: FINGERPRINT_VERSION,
    questions,
    decision: { enabled: normalized.decision.enabled, outcomes },
    settings,
  };
}

export function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalize(value));
}

function bytesToHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(projection) {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 недоступен в этом контексте");
  const hash = await globalThis.crypto.subtle.digest("SHA-256", canonicalBytes(projection));
  return "sha256:" + bytesToHex(new Uint8Array(hash));
}

export async function configHash(pack) {
  return digest(fullProjection(pack));
}

export async function configFingerprint(pack) {
  return digest(semanticProjection(pack));
}

export async function finalizePack(pack, { requireDecision = false } = {}) {
  const normalized = normalizePack(pack, { requireDecision });
  delete normalized.hash;
  delete normalized.fingerprint;
  normalized.hash = await configHash(normalized);
  normalized.fingerprint = await configFingerprint(normalized);
  return normalized;
}

export async function effectivePack(pack, { models = null, mode = null } = {}) {
  const effective = normalizePack(pack);
  delete effective.hash;
  delete effective.fingerprint;
  if (models !== null) effective.settings.models = copyJson(models);
  if (mode !== null) effective.settings.mode = mode;
  return finalizePack(effective);
}

function decisionClean(decision) {
  if (!decision) return { enabled: true, outcomes: [] };
  const clean = copyJson(decision);
  clean.enabled = clean.enabled !== false;
  clean.outcomes = clean.enabled && Array.isArray(clean.outcomes) ? clean.outcomes : [];
  for (const outcome of clean.outcomes) delete outcome.collapsed;
  return clean;
}

function temperatureIsActual(models, mode) {
  if (mode !== "decisions" && mode !== "both") return false;
  return models.some(key => state.models.find(model => model.key === key)?.api !== "systemone");
}

function promptFormatsFor(models, explicit) {
  const source = explicit ?? state.promptFormats ?? state.pinnedFormats;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const result = {};
  for (const key of models) {
    if (source[key] != null) result[key] = source[key];
  }
  return Object.keys(result).length ? result : null;
}

export function packFromState({ name, description, promptFormats } = {}) {
  const questions = withDirections(buildQuestionsPayload());
  const decision = decisionClean(state.decision);
  const models = selectedModelKeys();
  const mode = state.pageMode === "batch" ? "decisions" : state.runMode;
  const settings = { mode, models, aggregation: AGGREGATION_POLICY };
  if (temperatureIsActual(models, mode)) settings.temperature = state.temperature;
  const formats = promptFormatsFor(models, promptFormats);
  if (formats) settings.prompt_formats = formats;
  const pack = {
    version: PACK_VERSION,
    fingerprint_version: FINGERPRINT_VERSION,
    questions,
    decision,
    settings,
  };
  if (name != null) pack.name = name;
  if (description != null) pack.description = description;
  return pack;
}

export async function buildConfigPack(options = {}) {
  const pack = packFromState(options);
  if (!pack.settings.models.length) {
    throw new Error("Выберите хотя бы одну работающую модель перед экспортом конфига.");
  }
  return finalizePack(pack);
}

export async function rawContentSha256(content) {
  let bytes;
  if (content instanceof Uint8Array) bytes = content;
  else if (content instanceof ArrayBuffer) bytes = new Uint8Array(content);
  else if (typeof content === "string") bytes = new TextEncoder().encode(content);
  else if (content !== null && typeof content === "object") bytes = canonicalBytes(content);
  else throw new TypeError("content must be bytes, text, a dict or a list");
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(hash));
}

function base64Bytes(value) {
  const encoded = value.startsWith("data:") && value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  let decoded;
  try {
    decoded = atob(encoded);
  } catch (error) {
    throw new Error("image string must be base64 or a base64 data URL", { cause: error });
  }
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

function imageBytes(image) {
  if (image instanceof Uint8Array) return image;
  if (image instanceof ArrayBuffer) return new Uint8Array(image);
  if (typeof image === "string") return base64Bytes(image);
  throw new TypeError("image payload must be bytes or a base64 string");
}

function imageParts(image, index) {
  if (image !== null && typeof image === "object" && !(image instanceof Uint8Array) && !(image instanceof ArrayBuffer)) {
    const metadata = copyJson(image.metadata || {});
    const payloadKeys = ["bytes", "data", "dataUrl", "data_url", "base64"];
    for (const [key, value] of Object.entries(image)) {
      if (![...payloadKeys, "metadata"].includes(key)) metadata[key] = copyJson(value);
    }
    const key = payloadKeys.find(candidate => candidate in image);
    if (!key) throw new Error(`images[${index}] has no raw payload`);
    return { payload: imageBytes(image[key]), metadata };
  }
  return { payload: imageBytes(image), metadata: {} };
}

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map(pair => parseInt(pair, 16)));
}

export async function compositeContentSha256(content, images = []) {
  const chunks = [];
  if (content != null) chunks.push(hexToBytes(await rawContentSha256(content)));
  for (const [index, image] of images.entries()) {
    const { payload } = imageParts(image, index);
    chunks.push(hexToBytes(await rawContentSha256(payload)));
  }
  const joined = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const hash = await globalThis.crypto.subtle.digest("SHA-256", joined);
  return bytesToHex(new Uint8Array(hash));
}

export async function materialHash(content, images = [], metadata = {}) {
  const projectedImages = [];
  for (const [index, image] of images.entries()) {
    const { payload, metadata: imageMetadata } = imageParts(image, index);
    projectedImages.push({ sha256: await rawContentSha256(payload), metadata: imageMetadata });
  }
  return digest({
    content_sha256: content == null ? null : await rawContentSha256(content),
    images: projectedImages,
    metadata: copyJson(metadata),
  });
}

export async function materialsFingerprint(materialHashes) {
  const hashes = [...materialHashes];
  if (hashes.some(value => typeof value !== "string")) throw new TypeError("material hashes must be strings");
  return digest(hashes);
}

export async function runFingerprint(configFingerprintValue, materialsFingerprintValue) {
  if (typeof configFingerprintValue !== "string" || typeof materialsFingerprintValue !== "string") {
    throw new TypeError("config and materials fingerprints must be strings");
  }
  return digest({
    config_fingerprint: configFingerprintValue,
    materials_fingerprint: materialsFingerprintValue,
  });
}

export async function downloadConfigPack({ onError, filename = "decision-qa-config.json", ...options } = {}) {
  try {
    const pack = await buildConfigPack(options);
    validatePack(pack);
    if (!/\.json$/i.test(filename)) filename += ".json";
    const blob = new Blob([JSON.stringify(pack, null, 2) + "\n"], { type: "application/json" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    return pack;
  } catch (error) {
    if (onError) onError("Экспорт конфига невозможен: " + error.message);
    return null;
  }
}
