# Task-run reliability verification

Run from the repository root. No release, deployment or provider API call is part
of this fixture. The Python wrapper uses disposable HOME, Hermes home, Olympus
state, DB and temp paths and drops inherited credentials. Set
`OLYMPUS_QA_TEMP_ROOT` to a short, executable temp root if `/tmp` is noexec.

```sh
python3 qa/task-run-reliability/run-isolated.py npm test
python3 qa/task-run-reliability/run-isolated.py npm run typecheck
python3 qa/task-run-reliability/run-isolated.py npm run build
```

## Native Hermes checks (credential-free)

Substitute the installation paths appropriate for this machine:

```sh
python3 qa/task-run-reliability/run-isolated.py env \
  OLYMPUS_NATIVE_HERMES_SOURCE="$HERMES_AGENT_DIR" HERMES_AGENT_DIR="$HERMES_AGENT_DIR" \
  "$HERMES_PYTHON" tests/test_background_work_native.py
python3 qa/task-run-reliability/run-isolated.py env \
  OLYMPUS_NATIVE_HERMES_SOURCE="$HERMES_AGENT_DIR" \
  "$HERMES_PYTHON" tests/test_delegate_reasoning_native.py
```

Set `OLYMPUS_WORKER_TEST_DIR="$PWD/dist/server/server/workers"` in the first
command's `env` arguments to also exercise the copied production worker's JSONL
RPC. The inventory test starts and cleans only its own harmless subprocesses.
The reasoning check runs the installed native child builder with the final agent
constructor replaced to capture arguments without credentials/model calls.
Native tests are explicitly skipped by the ordinary system-Python suite unless
the native source is selected; run the native commands separately.

## Rendered browser fixture

```sh
npm --prefix qa/task-run-reliability install
(cd qa/task-run-reliability && npx playwright install chromium)
python3 qa/task-run-reliability/run-isolated.py node --import tsx \
  qa/task-run-reliability/browser-smoke.ts
```

For an already installed browser/module, pass `OLYMPUS_PLAYWRIGHT_MODULE` and
`OLYMPUS_CHROMIUM_PATH` after `env` in the wrapper command. Chromium runs without
its sandbox only against this isolated loopback fixture. No live Olympus data
is opened. The fixture refuses to run without the isolation wrapper marker.

This uses the built React UI and real Express/SQLite routes with explicitly
stubbed model execution/history. It checks failed and successful tasks, partial
history, durable reload notice, paused queue, explicit survivor-conflict response,
and desktop/mobile rendering with no JavaScript errors. Screenshots and failure
diagnostics go to `.tmp-olympus-portable-reliability/` by default. This is local
fixture evidence, not proof of a live deployment.
