# Task failure and waiting-state hardening (R2/R3)

Base: v0.7.19 / 1dd01b2. Worktree branch: codex/production-hardening. No live providers, Hermes stores or server installation used.

## Reproduced failures

- `tests/test_worker_openai_guard.py`: structured status/code lost to exception prose, including wrong auth classification and leaked secret sentinel. Six failing assertions before R2; typed categories and safe fixed copy pass afterward. Returned native failure regression separately failed on `agent_failed` before implementing the safe result-reason mapping.
- `tests/worker_error_terminal.test.ts`: the real adapter returned a secret sentinel for an OpenAI error before boundary sanitization. All seven reviewed provider categories now keep their code and fixed safe message.
- `tests/task_failure_persistence.test.ts`: live error snapshots contained the sentinel before sanitization. Worker/live/persisted/reloaded category and action checks now pass for all seven codes.
- `tests/run_failure_presentation.test.ts`: generic auth had no provider-settings action before R2. Provider settings, usage, model selection, continued work and queued/input pause presentation now pass.
- `tests/recovery_wait_reason.test.ts`: queued recovery projected `undefined` instead of `queued_message` before R3. It now verifies three idle reconciliations dispatch nothing, cause/checkpoint remain unchanged, unanswered input takes precedence, stale queue ID cannot delete input, explicit null clears the reason, queue arrivals during asynchronous inventory retain priority, and removal permits exactly one continuation claim.
- Extended verification repair regression preserves `verification_failed`, fingerprint, checkpoint and attempt count across repeated queued pauses.
- Store regression verifies partial snapshots preserve metadata, explicit null clears it, and new runs never inherit old waiting state.
- Queue route regression verifies actual HTTP save/remove, profile-scoped board events and recovery endpoint agree on the waiting reason, including explicit null after removal.

## Focused verification

Passed through isolated `scripts/run-tests.mjs`:
`test_worker_openai_guard.py`, `test_hermes_worker_resolve.py`, `task_failure_persistence.test.ts`, `run_failure_presentation.test.ts`, `openai_auth_ui.test.ts`, `worker_error_terminal.test.ts`, `reconnect_chat.test.ts`, `openai_auth_liveness.test.ts`, `recovery_wait_reason.test.ts`, `reconnect_run_store.test.ts`, `task_run_snapshot.test.ts`, `task_recovery_routes.test.ts`, `task_message_queue_routes.test.ts`, `automatic_recovery.test.ts`, `interrupted_run_recovery.test.ts`, `verification_repair.test.ts`.

Local log files: `/tmp/olympus-r2-r3-focused.log`, `/tmp/olympus-r2-adapter-green.log`, `/tmp/olympus-r3-route.log`, `/tmp/olympus-r3-green.log` (ephemeral).

## Browser evidence

Root used the Codex in-app browser against the disposable fixture on port 4186. Actual production RunFailureBanner/InputToolbar components rendered with synthetic run state:
- Queue input shows Paused for your queued message and Send queued message, retains the composer text across state changes, and shows the same waiting state on reload.
- Removing input restores recovery presentation without invoking Continue.
- Model failure offers Choose model; clicking opens the actual ModelPicker.
- Allowance failure offers View usage and Continue saved work, with no OpenAI sign-in control.

This fixture tests presentation/actions; actual queue persistence and admission are covered by isolated route/DB tests. It does not prove live provider behavior, and draft persistence across full browser reload is not introduced here. Settings actions open the selected profile in a separate tab to preserve the current task draft. Signing in does not send a task message (existing OpenAI UI regression retained).

## Deliberate scope

No new task limits, whole-turn retries, historical-row rewrites, automatic model changes or authentication migration. Wait reason is derived display metadata, not a new persisted state. Existing expired/cancelled unanswered interactions retain their native safety block; no silent approval is added.

## Admission race found during review

The review reproduced a remaining native-recovery race with the real HTTP routes and a fake adapter: input arriving during the second background inventory (after the reconciler claimed recovery) still returned 202 and started one run. The queued message remained saved, but did not get its promised priority. The final synchronous admission gate now checks both queued input and unanswered interactions for the exact failed run for every recovery continuation. Existing native-evidence and recovery identity checks remain in place; verification repair keeps its task-status check.

`node scripts/run-tests.mjs tests/recovery_admission.test.ts` failed before the fix with `202 !== 409`. After the fix, this new regression covers both a queue and an unanswered interaction arriving during the second lookup: 409, zero agent starts, unchanged prior run and saved queue; removing/resolving the blocker permits exactly one normal recovery claim.

Passed after the change:

```sh
node scripts/run-tests.mjs tests/recovery_admission.test.ts tests/recovery_wait_reason.test.ts tests/task_recovery_routes.test.ts tests/verification_repair.test.ts
```

Ephemeral evidence: `/tmp/olympus-r3-admission-red.log` and `/tmp/olympus-r3-admission-green.log`. The test uses the runner's disposable Hermes/state directories and a mocked worker stream; no real provider or model execution occurs.

## Independent boundary review

The review traced worker failure classification through persisted run codes, API/live snapshots, board updates, client state and failure actions. It confirmed the final recovery admission gate rechecks exact-run queued input and unanswered interactions before starting work. No additional recovery admission or action-routing defect was identified in this bounded review.

One additional returned-result boundary was reproduced: a failed native one-shot result became a successful generated title because its modern provider message did not match the legacy text prefixes. Four mocked native failure cases in `test_worker_openai_guard.py` failed before the fix (`WorkerError not raised`). The one-shot path now applies the existing safe OpenAI/provider failure mapping before reading failed `final_response`; its nonfailed partial-result behavior remains unchanged. Afterward all 12 tests in that file passed, including a secret-sentinel assertion and a nonfailed partial-title regression. No native credentials or model request was used.

The review also reproduced a main-chat display regression using the existing disposable recovery fixture: a nonfailed, persisted iteration summary produced no live text event because completion checking moved ahead of fallback output. This was reported to the main implementer for a separate narrow correction, while failed provider output must remain suppressed.

## Additional integration review checks

- ModelPicker consumed an external open request again when a running task became idle. The actual component hook regression failed before adding a consumed-request ref; it now stays closed for that old request and opens for a new request (`tests/model_picker_action.test.ts`).
- Candidate Hermes reason `upstream_rate_limit` now maps to the same safe usage action as `rate_limit`. The final JSONL request boundary logs only a fixed diagnostic; an injected exception previously exposed a secret sentinel and traceback. Both assertions failed before the fixes and passed afterward in `test_worker_openai_guard.py` (10 tests). Ephemeral logs: `/tmp/olympus-r2-final-boundary-red.log` and `/tmp/olympus-r2-final-boundary-green.log`.
- Additional browser checks showed Awaiting your answer with no Continue action; explicit Send queued message invoked only its callback and retained the edited composer; generic auth offered Open provider settings without an OpenAI card. The fixture tab was closed and its Vite server stopped after verification.

The main-chat partial-output correction is now complete: failed native provider results are rejected before fallback output, while nonfailed incomplete summaries still stream before their terminal error. `test_worker_recovery.py` reproduced the missing summary before the fix; afterward 35 tests passed with the selected native candidate, including all four native cases that the ordinary runner skips. A failed provider response with a secret sentinel emits no fallback text. Recovery journal semantics are unchanged. Also reproduced and corrected explicit `model_not_found`/`invalid_model` codes with status 403, preserving model selection instead of generic provider settings. All 12 guard tests passed with the native candidate. Logs: `/tmp/olympus-r2-model403-red.log`, `/tmp/olympus-r2-model403-green.log`, `/tmp/olympus-r2-partial-red.log`, `/tmp/olympus-hardening-native-recovery-final.log`.
