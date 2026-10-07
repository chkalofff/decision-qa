// Доменные тесты: state. Общие фикстуры/ассерты — harness.mjs.

import {
  test, eq, resetState, state,
} from "./harness.mjs";

// ================================================================ state

test("state: selectedModelKeys фильтрует не-running модели", async () => {
  await resetState();
  state.models = [
    { key: "mA", status: "running" },
    { key: "mB", status: "stopped" },
  ];
  state.selectedModels = new Set(["mA", "mB"]);
  const { selectedModelKeys } = await import("../static/state.js");
  eq(selectedModelKeys().join(","), "mA", "только running");
});
