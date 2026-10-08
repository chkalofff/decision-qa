// Фронтенд-тесты Decision-QA на node + DOM-мок.
// Точка входа: импортирует доменные файлы (регистрируют тесты) и запускает все.
// Запуск: /usr/local/bin/node frontend/tests/run.mjs

import { runAll } from "./harness.mjs";

import "./state.test.mjs";
import "./layout.test.mjs";
import "./results.test.mjs";
import "./questions.test.mjs";
import "./context.test.mjs";
import "./lightbox.test.mjs";
import "./batch.test.mjs";
import "./toolbar.test.mjs";
import "./manager.test.mjs";
import "./contract.test.mjs";
import "./app.test.mjs";
import "./presets.test.mjs";
import "./assistant.test.mjs";
import "./decision.test.mjs";

await runAll();
