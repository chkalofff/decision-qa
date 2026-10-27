---
name: decision-qa
description: Validate and classify text/image materials with a Decision-QA config pack through a server. Use for reproducible batches, CI/cron classification, text+photo manifests, resume-safe downstream processing, and local explain/diff of CLI reports.
---

# Decision-QA CLI

Use `dqa` with a reachable Decision-QA server and either a raw config-pack v1 or a unified `decision-qa-document` v1 exported by the web UI. For the document form, `--config` reads only its `config` section; `materials` and `results` are ignored, so input files still come from paths/stdin/manifest. The CLI does not run models locally and never accepts provider credentials.

## Connect and check

```bash
python -m pip install -r cli/requirements.txt   # Python 3.12+
cli/bin/dqa doctor --server http://localhost:8000
cli/bin/dqa config init
cli/bin/dqa config set --profile staging server https://dqa.example.com
cli/bin/dqa config set --profile staging token "$DQA_TOKEN"
cli/bin/dqa config show --profile staging
```

Precedence: `--server`/`--profile` → `DQA_SERVER`/`DQA_PROFILE` → profile file → `http://localhost:8000`. `DQA_CONFIG_DIR` relocates the TOML file. Bearer tokens come only from `DQA_TOKEN` or a protected profile; there is no `--token` flag. `config show` masks tokens and shows provenance. `doctor [--config pack.json] [--format json]` checks environment, server, auth, models, and optional pack.

## Validate, then run

```bash
dqa validate inbox/ --config pack.json --models clef-a,clef-b --threads 4
dqa run inbox/ --config pack.json --models clef-a,clef-b --threads 4 \
  --report artifacts/run.json --format json -o artifacts/selected.json
```

`--config` is mandatory. `--models` replaces the pack's set for this run and changes the effective fingerprint. Omit `--threads` to use the server default; `threads_effective` comes from `run_start`. Other useful flags: `--mode decisions|fast_batch|both`, `--retry N`, `--timeout SEC`, `--fail-on error|any|none|id[,id]`, `--quiet`, `--verbose`.

Validate and dry-run are local preflight plus authenticated capabilities, not inference:

```bash
dqa run inbox/ --config pack.json --dry-run
```

Supported inputs are files/directories, `--glob` and `-r`, implicit/explicit `--stdin [--name case.txt]`, `--files-from FILE [--null]`, `--manifest`, and repeated `--image` for one material. Text: `.txt/.md/.json`; images: PNG/JPEG/WebP/GIF. UTF-8-SIG is deterministic; use `--encoding cp1251` explicitly for Windows text. No encoding guessing and no binary image stdin.

Directory expansion alone applies basename grouping: `claim.txt` absorbs `claim.jpg` and `claim_p1.jpg` in the same directory. Ambiguity is an error; orphans remain separate with warnings. For explicit text+photo groups, use a manifest:

```json
[
  {"path": "claim-17.txt", "name": "claim-17", "images": ["p2.jpg", "p1.jpg"]}
]
```

```bash
dqa validate --manifest claims.json --config pack.json
```

Manifest order is attachment order. Manifest grouping overrides naming conventions; direct positional files do not trigger conventions.

## Output and reports

- JSON: envelope with `schema:1`, run/config metadata, `summary`, and `files[]` (same shape for one or many). Aggregate answers/decision, raw runs/by_model/errors, material and `content_sha256` are present.
- NDJSON: events `run_start`, `file`, `run_end`. File records are `select(.type=="file")`, in completion order. `run_end` carries returned/filtered/pending counts.
- CSV: UTF-8 BOM, stable question columns, no by_model. Table is TTY-only; non-TTY table exits 64.
- `-o/--output` writes the selected format atomically. `--outcome-filter` changes displayed records only, never policy, progress, manifest, or the full audit report.
- `--report PATH` is always full and unfiltered. Small reports are JSON; >10,000 records are NDJSON. `PATH.partial` is the streaming artifact while work is incomplete and remains usable after failure. A finished well-formed report replaces the previous target atomically.

Example NDJSON filtering:

```bash
dqa run inbox/ --config pack.json --format ndjson \
  | jq -c 'select(.type=="file") | {path, outcome: .decision.outcome}'
```

## Exit codes and partial errors

Priority is launch errors, interruption, policy, degraded, success:

- 64 usage; 65 validation; 66 missing input; 69 unavailable/incompatible/transport; 70 internal/job/lock failure; 77 auth.
- 130 SIGINT/SIGTERM; 75 overall timeout.
- 10 `--fail-on` matched. `error` matches status=error **and any per-model errors**, even when the file has a decision.
- 2 degraded errors/skips when policy did not fire; 0 success.

Read the exit code before parsing output. Partial per-model failure can produce `status:"ok"` plus nonempty `errors[]`; partial/transient results are never added to the processed manifest.

## Identity and repeat runs

`content_sha256` identifies raw content and ordered attachments, not the filename: a rename is the same material. `config.effective_fingerprint` changes for rules/questions/models/mode/aggregation/inference changes, not cosmetic label/color edits. Branch on `decision.outcome` (outcome.id), never label/index.

`--skip-processed seen.ndjson` uses a versioned append-only manifest and exclusive lock. Reused records have `reason:"already_processed"`, prior run id, current path/label, and `answers:null`; no duplicate history or new inference is added. Only complete successful decisions with empty errors are recorded.

```bash
dqa run inbox/ --config pack.json --skip-processed state/seen.ndjson \
  --report state/run.json --fail-on none
```

## Local analysis and downstream actions

```bash
dqa explain /absolute/path/inbox/a.txt --report state/run.json
dqa diff old.json new.json --format json
```

`explain` also accepts a unique name. `diff` requires two complete, unfiltered reports and joins by `content_sha256` (rename-safe). Outcome transitions include `already_processed`; numeric deltas exclude it. Delta thresholds are probability 0.1 and score 0.5.

Never act on streaming events or a partial/filtered report. Downstream work starts only after a complete final report is verified. `cli/examples/workflow_consumer.py` demonstrates validate → run → exit/report checks → exhaustive outcome mapping → idempotent actions and a locked done ledger:

```bash
python cli/examples/workflow_consumer.py \
  --pack pack.json --server http://localhost:8000 inbox/ \
  --report state/run.json --processed state/seen.ndjson --ledger state/done.ndjson \
  --outcome ok=invite --outcome reject=block \
  --fake-action state/actions.ndjson --dqa "python -m dqa"
# After a consumer failure, replay without another inference:
python cli/examples/workflow_consumer.py --consume-only \
  --pack pack.json --report state/run.json --ledger state/done.ndjson \
  --outcome ok=invite --outcome reject=block \
  --fake-action state/actions.ndjson
```

Unknown outcomes alert before any new action. `--dry-run` prints intended actions without writing the ledger or marking them done.
