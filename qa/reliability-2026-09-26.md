# Olympus production-hardening evidence — 2026-09-26

This is the authorized R1–R4/G1–G3 continuation after authentication shipped in v0.7.19. The implementation is on local branch `codex/production-hardening`, based on `1dd01b22eb70cd923f82c9e2da9e48f9093f1ade`. It is saved as a local implementation checkpoint, not pushed, deployed or released. The original checkout and its installed Hermes state were not changed.

## Delivered scope and focused evidence

| Task | Behavior | Evidence |
|---|---|---|
| R1 | Actual child/generation owns worker lifecycle; slow catalog discovery does not block chat, Stop or health dispatch | [Worker liveness](worker-liveness-hardening.md) |
| R2 | Typed safe provider failures offer sign-in, settings, usage or model selection; explicit Continue preserves saved progress | [Failure actions and waiting](task-recovery-hardening.md) |
| R3 | Queue/input wait reason agrees across DB, HTTP, SSE and reload; new input wins both asynchronous recovery admission races | [Failure actions and waiting](task-recovery-hardening.md) |
| R4 | Finite SSE bootstrap drains correctly; missed events reconnect and hydrate without task replay | [Stream buffering](sse-hardening.md) |
| G1 | Durable exact-commit publication receipts, idempotent confirmation and explicit resume/abandon preserve files/history | [Git publication](git-publication-hardening.md) |
| G2 | Repository-scoped read/write tokens, controlled Git configuration, suppressed hooks/helpers/signers and safe permission errors | [Git publication](git-publication-hardening.md) |
| G3 | Task branch default, immutable pending target, truthful pushed/abandoned copy and baseline-only sync explanation | [Publication UI](publication-ui-hardening.md) |

The baseline focused tests passed before implementation: `project_cp_safety`, `runtime_liveness`, `run_failure_presentation`, `automatic_recovery`, and `sse_drain`, using `node scripts/run-tests.mjs` and disposable state. The component evidence uses production callbacks and UI fixtures, while local Git evidence uses real disposable bare repositories. No live GitHub publication, model call, credential store or server deployment was used.

## Integrated verification

Final standard gate: all five commands below passed after the review fixes. The full `npm test` run exited 0 across all 181 TypeScript and 18 Python files. Its nine native skips passed separately as described below. Typecheck, production build, shell syntax and final diff checks exited 0. Built worker/schema assets match their source. The production bundle retains the existing large-chunk warning.

Ephemeral logs: `/tmp/olympus-hardening-full-tests-green.log`, `/tmp/olympus-hardening-typecheck.log`, `/tmp/olympus-hardening-build.log`, `/tmp/olympus-hardening-shell.log`. The final test correction changed only an old expectation, so the successful typecheck/build remain applicable to the same product code.

```sh
npm test
npm run typecheck
npm run build
npm run lint:shell
git diff --check
```

Environment: Node 22.22.3, system Python 3.9.6, Git 2.54.0 (Apple Git-157). The full test runner discovers 181 TypeScript files and explicitly runs 18 Python files, each with disposable Olympus/Hermes/Project state. The ordinary runner skips nine native-dependency cases; all nine are covered by the separate native gate below.

The first combined test run stopped in the new migration fixture: random UUID ordering could insert a restore version before its referenced original. The fixture now deliberately reverses dependency IDs, defers constraints only during seed insertion, and checks all foreign keys afterward. This was a test setup defect. The corrected model test passed before restarting integration. An existing Vite test-shutdown dependency-scan diagnostic appeared after the Markdown route fixture closed its dev server; that test's assertions passed. This is distinct from the failing migration fixture. A second integrated run reached the older task-run persistence test, whose exact object expectation omitted the new explicit null recovery fields. The expectation now asserts both null fields so completed runs clear stale recovery UI; that focused test passed. Product code was unchanged by this test alignment.

## Independent review

Different implementers reviewed each other's lanes. Concrete findings were reproduced and corrected rather than waived:

- Recovery input could arrive after its first probe but before final admission; the regression now covers both queued input and unanswered interactions, zero starts while blocked and one claim after resolution.
- A consumed model-picker request could reopen after a busy task became idle; the production component regression now covers request consumption.
- Explicit model failure codes with status 403 were hidden by the generic auth classification; structured model codes now retain the model-selection action.
- Repository-controlled push signing and credential prompts could execute programs with the temporary token environment; real Git sentinel fixtures verify both are suppressed.
- Token minting could mask the reviewed GitHub permission-upgrade error; route regressions retain actionable permission guidance and exact-commit resume.
- Local-only abandonment displayed push progress; the component regression distinguishes those operations.
- Failed one-shot native results could become task titles, while nonfailed incomplete chat summaries could disappear from live output. Structured guards now suppress failed provider output and preserve nonfailed partial progress, with regressions for both paths.

No additional actionable finding was reported in the bounded worker, stream and publication reviews. This is scoped engineering review, not a claim of a comprehensive security audit.

## Native runtime contracts

Hermes remains pinned to `v2026.9.24`, source `f97608f178d1ffeca59860195ab7da295f7c8e5f`, image digest `sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7`. The pin is unchanged in this continuation.

Used the prior isolated candidate at `/var/folders/46/zhty75_55831rn5c_bwsg6sc0000gn/T/olympus-native-auth-661x8y7y/candidate`, with its sibling `runtime/bin/python`. Commands were launched with a whitelist environment, temporary HOME/HERMES_HOME/CODEX_HOME/Olympus state/DB/Project paths, candidate-only PYTHONPATH and OLYMPUS_NATIVE_HERMES_SOURCE. No installed profile or credential environment was inherited.

```sh
# SOURCE and PYTHON refer to the isolated paths above, not a live installation.
# Run with the disposable environment described above and PYTHON's directory first on PATH.
node scripts/run-tests.mjs tests/test_worker_recovery.py tests/test_background_work_native.py tests/test_project_github_worker.py tests/test_scheduled_task_drain.py tests/test_bot_messaging.py
"$PYTHON" tests/test_worker_usage_native.py "$SOURCE"
"$PYTHON" tests/test_worker_openai_auth_native.py "$SOURCE"
"$PYTHON" tests/test_worker_openai_auth_helper_native.py "$SOURCE"
"$PYTHON" tests/hermes_021_native_interactions_test.py
```

Passed: recovery 35 (rerun after the partial-output correction), background work 10, Project GitHub 17, scheduled drain 6, Bot messaging 14, OpenAI auth 4, interactions 6, plus 12 worker auth/failure-boundary tests, the usage contract and the real auth-helper contract. Native HTTP/credentials were mocked; helper networking was denied. The upstream compatibility warnings for moved approval-context functions and the expected cancelled-approval traceback remain visible; no assertion failed. Ephemeral logs: `/tmp/olympus-hardening-native.log`, `/tmp/olympus-hardening-native-helper.log` and `/tmp/olympus-hardening-native-recovery-final.log`. The final recovery/guard rerun used the explicit Node executable `/Users/michael/.local/bin/node`; an initial launcher attempt had no Node on its restricted PATH and ran no tests.

## Browser acceptance

The focused fixtures exercised actual failure/banner/model-picker components, the chat reconnect hook, and both publication interfaces. Verified queue/input pause text, explicit queued send, unchanged edited draft across state changes/reconnect, model picker, generic provider settings versus usage, pending receipt after reload, immutable resume, abandonment confirmation and returned SHA/branch. Stream reconnect recovered expired terminal state with zero task POSTs. Fixture servers/tabs were stopped afterward. They do not prove full-app draft persistence across page reload or live provider/remote behavior.

Authentication's complete device-flow UI evidence remains in [the v0.7.19 authentication report](../docs/testing/openai-authentication.md). Existing auth UI regressions run in the integrated suite; real account reauthorization remains user-driven live acceptance.

## Pending Docker and operational acceptance

The local Docker daemon was unavailable at `/Users/michael/.orbstack/run/docker.sock`. No daemon or installed container was started. `INSTALL.md` and `tests/docker_e2e.sh` were inspected. No changed-image build or container-runtime acceptance is claimed. This branch is not yet image-release-ready.

For a later selected test Docker host, use the E2E harness only with unique disposable images, volumes, project name and loopback port. It already covers install/update, zero-run drain, backup/restore, proxy promotion recovery and rollback. Additional hardening acceptance must verify copied worker assets, delayed model catalog responsiveness, restart with pending receipts and a fake provider/auth transport. Never reuse live `.env` files or live volumes for that harness.

For the actual installation, first obtain its exact URL/host, operator method and Hermes/Olympus volumes. The required sequence remains: report running image; installer update dry-run; review selected paths/volumes; explicit approval; verified backup and restore evidence; disposable candidate preflight; authenticated drain to zero; candidate readiness as the sole live writer; proxy switch; `/api/ready`; safe task reaching review. Preserve credential rotation when planning rollback. Use a separately authorized test repository for real GitHub permissions/branch protection. Olympus still requires a trusted/private or externally authenticated server boundary.

## Scope still separate

Performance P1–P4 is not implemented here. R1 removes a catalog-reader bottleneck, but no before/after latency baseline or fair Hermes Desktop comparison was run. No claim that the reported live disconnects are solved is supported yet. No new task timeouts, automatic whole-turn replays, model fallback, version bump, tag, remote push or deployment was introduced.
