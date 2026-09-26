# Task Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use sequential execution for the inexpensive handoff; parallel editing of shared worker/types/chat files is not recommended. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep healthy work alive through probe/connection failures and give stopped tasks truthful, actionable recovery controls.

**Architecture:** Preserve existing workers, admission, durable recovery, and task state. Make probes observational, carry safe error codes end-to-end, derive queue blockers, and share a bounded SSE writer.

**Tech Stack:** TypeScript/Express/SQLite, Python Hermes bridge, React/Zustand, Node streams.

**Spec:** [Reliability design](../specs/2026-09-26-reliability-improvements-design.md), especially Global constraints and R.

**Implementation checkpoint:** R1–R4 are implemented on `codex/production-hardening` from v0.7.19. The original checklist below records the design; consult [integrated evidence](../../../qa/reliability-2026-09-26.md) and its linked worker-liveness-hardening.md, task-recovery-hardening.md and sse-hardening.md reports for executed steps, reviewed adjustments and current verification. Do not reimplement these tasks from the unchecked design steps. Live Docker acceptance remains separate.

## Global Constraints

Every numbered Global constraint in the linked spec applies verbatim. In particular: no runtime timers, no whole-turn retry, no global worker restart, no raw error persistence, no mutation of historical completion or human task status. Node remains `>=22.22 <26`; server imports use `.js`.

## Review Focus

- A stale child exit after worker replacement must not fail the new worker's tasks: R1.
- A generic provider auth failure must not become an OpenAI sign-in action: R2.
- A queued verification repair must retain its `verification_failed` cause/fingerprint: R3.
- Two large initial board snapshots must not create an infinite reconnect loop: R4.
- A missed terminal SSE event must recover from history without another task POST: R4.

## Task R1: Observational liveness and generation-safe lifecycle

**Files:** Modify `server/adapters/hermes-worker.ts`, `server/app.ts`, `server/runtime-liveness.ts`, `server/workers/hermes_worker.py`, `scripts/run-tests.mjs`; inspect `server/adapters/routing.ts`. Create `tests/worker_liveness.test.ts`, `tests/test_worker_model_responsiveness.py`; register the Python test in the runner. Extend `tests/runtime_liveness.test.ts`, `tests/worker_error_terminal.test.ts`, `tests/local_profile_adapter.test.ts`.

**Interfaces:** Preserve `HermesWorkerClient.healthCheck(timeoutMs = 10_000): Promise<boolean>` and `AgentAdapter.healthCheck(): Promise<boolean>`. Change the private exit handler to identify its originating child, e.g. `handleExit(child: ChildProcessWithoutNullStreams, error: Error): void`. No new public lifecycle API is required if the existing pending-stream failure path and delegation reset handle genuine exit correctly.

- [ ] **Write failing lifecycle regressions.** Assert `healthCheck(15)` with a deliberately unresolved mocked request returns false while `killCalls=[]`, pending stream failure count is zero, and the original child remains installed. Keep the test event loop alive explicitly because the implementation timeout is unref'd. Also assert a subsequent successful probe returns true without a spawn; real exit rejects only the matching worker's stream once; duplicate error/exit and stale old-child exit do not affect a replacement; stale readiness success/finally cannot clear a newer `readyPromise`. Add an app-level test that a default-profile probe failure does not change a named-profile task status.
- [ ] **Run red:** `node scripts/run-tests.mjs tests/worker_liveness.test.ts tests/runtime_liveness.test.ts tests/worker_error_terminal.test.ts tests/local_profile_adapter.test.ts`. The new timeout assertion must fail against baseline because `stop()` is invoked. Existing tests may pass.
- [ ] **Implement the lifecycle change.** Remove `await this.stop()` from heartbeat failure. Keep false/unhealthy result and sanitized `worker_heartbeat_failed` diagnostics. Remove readiness's `interruptActiveRuns` call in `server/app.ts`; retain a safe failure log. Actual child exit still calls `failPending` with `worker_restarted`, and each stream consumer settles its own task. Capture child identity in event closures; invalidate/compare lifecycle generation for asynchronous startup results, and clear a promise only when it is still the current promise. Preserve explicit Stop/shutdown/profile eviction behavior and existing native delegation reset.
- [ ] **Keep the JSONL reader responsive.** Move `models.list` execution to a background handler using the same pattern as `usage.get`; its output still uses the original request ID. Do not perform a broad RPC rewrite. Concurrent cache misses share one catalog build using a separate catalog-only build lock; never hold the provider/task-admission/config lock during discovery network I/O. Recheck configuration generation before caching a result so an old build cannot replace newly selected settings. In `tests/test_worker_model_responsiveness.py`, hold discovery on a latch and prove subsequent health, background inventory, chat admission and interrupt requests are dispatched while it remains outstanding; simultaneous catalog requests perform one build and a settings mutation does not deadlock or install stale results. Run through `node scripts/run-tests.mjs tests/test_worker_model_responsiveness.py`. P2 owns the corresponding browser-loading fix and end-to-end regression.
- [ ] **Run green:** repeat the focused command, plus `node scripts/run-tests.mjs tests/scheduled_worker_handshake.test.ts tests/scheduled_profile_drain.test.ts tests/test_worker_deadline_budget.py tests/test_hermes_worker_resolve.py`. Expect exit 0; no task limit or automatic termination is added.
- [ ] **Record checkpoint:** local commit `fix: keep worker health probes non-destructive`, or provide the scoped diff if this executor was asked not to commit. No push.

## Task R2: Preserve safe failure categories and choose correct actions

**Files:** Modify `server/workers/hermes_worker.py`, `shared/run-errors.ts`, `server/adapters/worker-protocol.ts` only if payload typing needs it, `server/live-chat.ts`, `server/db/task-agent-runs.ts`, `client/src/lib/runFailurePresentation.ts`, `client/src/components/RunFailureBanner.tsx`, `client/src/components/TaskChat.tsx`. Extend existing worker/failure/reconnect tests listed below.

**Interfaces:** Keep `WorkerErrorPayload` free of raw credential fields. Standardize persisted codes `openai_auth_required`, `openai_auth_unavailable`, `auth_error`, `rate_limit`, `quota_exhausted`, `model_error`, `provider_error`. Existing reviewed codes remain valid. Extend `RunFailureNotice` with `action: 'reconnect_openai' | 'provider_settings' | 'usage' | 'model_picker' | 'continue' | 'check_openai'` and produce it in `deriveRunFailureNotice`. Do not add DB columns for UI actions.

**Exact mapping:**

| Code | Title | Primary action |
|---|---|---|
| `openai_auth_required` | OpenAI sign-in required | Reconnect OpenAI |
| `openai_auth_unavailable` | OpenAI connection temporarily unavailable | Check saved login |
| `auth_error` | Provider sign-in or key required | Open provider settings |
| `rate_limit` | Provider rate limit reached | View usage; explain waiting or changing model/provider |
| `quota_exhausted` | Provider allowance unavailable | View usage |
| `model_error` | Selected model is unavailable | Choose model |
| `provider_error` / unknown | Run ended before completion | Continue saved work after reviewing progress |

- [ ] **Write failing tests.** For every code above, assert worker event -> live snapshot -> persisted run -> reloaded presentation retains the same safe code/action. Native OpenAI `AuthError(provider='openai-codex', relogin_required=True)` maps to `openai_auth_required`; transient recognized OpenAI auth/network failure maps to `openai_auth_unavailable`. Generic auth, API-key OpenAI, and another provider never select Codex OAuth. A fake secret in an exception must not appear in persisted data or user-facing fixed copy. Preserve unknown/legacy fallback and the distinction between user Stop and failure.
- [ ] **Run red:** `node scripts/run-tests.mjs tests/test_hermes_worker_resolve.py tests/task_failure_persistence.test.ts tests/worker_error_terminal.test.ts tests/run_failure_presentation.test.ts tests/reconnect_chat.test.ts`.
- [ ] **Implement typed classification at the worker boundary.** Read native exception attributes before message heuristics. Require trusted provider identity for OpenAI-specific codes. Use fixed safe message/hint text for known categories. Keep unrecognized native failure responses generic; never classify arbitrary assistant prose as an OAuth error. Preserve categories through `safeRunErrorCode`, live state and database projection. Do not rewrite old rows or add them to automatic recovery merely because they now have richer codes.
- [ ] **Wire actions.** Use existing profile-aware navigation for Providers/Usage and the actual model picker. OpenAI actions open the selected profile's Providers card from A3; until A3 exists, navigate to Providers with explanatory text instead of a fake reconnect button. After A3, bind to its real flow. Reconnection/checking does not post a task message; Continue saved work retains the existing normal admission/continuation path. Use real structured reset data only; never invent a retry countdown.
- [ ] **Run green:** repeat focused tests, `npm run typecheck`, and an isolated UI test that reconnect completion sends zero message POSTs until the user clicks Continue saved work.
- [ ] **Record checkpoint:** `fix: preserve actionable provider failure categories`.

## Task R3: Truthful waiting reasons for queued recovery

**Files:** Modify `server/db/task-agent-runs.ts`, `server/run-recovery.ts`, `server/routes/task-recovery.ts`, queue mutations in `server/routes/chat.ts`, `shared/types.ts`, `client/src/lib/api.ts`, `client/src/lib/store.ts`, `client/src/lib/runFailurePresentation.ts`, `client/src/components/RunFailureBanner.tsx`, `client/src/components/TaskChat.tsx`, `client/src/components/CodingEvidencePanel.tsx`, and snapshot projection call sites found by `rg 'recoveryState'`.

**Interfaces:** Define `RecoveryWaitReason = 'queued_message' | 'awaiting_input'`. Add `recoveryWaitReason?: RecoveryWaitReason | null` to `TaskAgentRun`, `TaskRunState`, and `LiveChatRun`; add `waitReason: RecoveryWaitReason | null` to the recovery endpoint's `TaskRecoveryStatus`. Derive it from the exact run's pending/waiting recovery plus current queue/unanswered interaction, with `awaiting_input` taking precedence. Use one projection helper or shared query expression so endpoints agree. No persisted wait-reason column or new recovery state.

- [ ] **Write failing tests.** Failed recoverable run + queued input: three reconciliations perform zero dispatches, projected wait reason is `queued_message`, UI says Paused for your queued message and offers Send queued message. Repeat with verification repair and assert stored `reason='verification_failed'`, fingerprint, attempts and checkpoint remain unchanged. Queue removal broadcasts explicit null and permits exactly one native-evidence-qualified continuation; a stale queue ID cannot remove its replacement. Unanswered interaction says Answer the pending request first. Older partial snapshots preserve the field, explicit null clears it, and a newer run wins.
- [ ] **Run red:** `node scripts/run-tests.mjs tests/automatic_recovery.test.ts tests/verification_repair.test.ts tests/task_message_queue_routes.test.ts tests/task_run_snapshot.test.ts tests/reconnect_run_store.test.ts tests/run_failure_presentation.test.ts`.
- [ ] **Implement projection and broadcasts.** Preserve queue/interaction priority in `reconcileRecoveries`; update display metadata rather than its causal `reason`. Emit `task_run_updated` after successful queue save/remove/consume/restore where projection changes, using the latest actual row and exact task scope. Do not emit inside an uncommitted SQLite transaction. Update state equality and undefined-versus-null merge handling. Include the same reason in `/recovery`, history and board snapshots.
- [ ] **Implement truthful controls.** RunFailureBanner and CodingEvidencePanel stop promising imminent automatic work when blocked by queue/input. Use Send queued message, Retry sending message, and Answer pending request copy in the owning controls. Use existing queue ID comparisons and admission; do not duplicate the queue sending implementation. Clearing input makes the existing reconciler eligible, not automatically successful.
- [ ] **Run green:** repeat targeted tests and `node scripts/run-tests.mjs tests/task_recovery_routes.test.ts tests/interrupted_run_recovery.test.ts`. Verify one browser fixture with a queued message and failed run across reload, send, and removal.
- [ ] **Record checkpoint:** `fix: show why task recovery is waiting`.

## Task R4: Bounded SSE buffering with correct bootstrap

**Files:** Create `server/sse-writer.ts`, `tests/sse_backpressure.test.ts`. Modify `server/live-chat.ts`, `server/events.ts`, initial stream setup in `server/app.ts`, `server/routes/projects.ts`, `server/routes/chat.ts`. Extend `tests/sse_drain.test.ts`, `tests/reconnect_chat.test.ts`.

**Interfaces:** Export `createSseWriter(res: Response): { bootstrap(frames: readonly string[]): void; send(frame: string): void; keepalive(): void; close(): void }`. Each stream owns one writer. Call `bootstrap` once with the finite initial frame list (two for board, one for live/project); normal send during bootstrap marks a resync requirement rather than growing an event queue. Serialization of event objects stays at the owning layer.

- [ ] **Write stream regressions with a real Node Writable/fake Response.** Small high-water mark: `write(false)` buffers the frame and a later drain keeps subscription alive. A large initial live snapshot drains with no forced reconnect. The board's first large snapshot drains before its second is sent, with neither lost nor repeated. A state update arriving while blocked marks resync; after bootstrap/drain the writer closes so reconnect receives latest state. Keepalive does not cause a false disconnect or unbounded queue. Close/error removes listeners; a late drain does nothing. Another subscriber stays live.
- [ ] **Run red:** `node scripts/run-tests.mjs tests/sse_backpressure.test.ts tests/sse_drain.test.ts tests/reconnect_chat.test.ts`.
- [ ] **Implement the small writer.** Track only closed, blocked, bootstrap index/list, and needsResync. A false write is already accepted into Node's buffer: advance the bootstrap index once and await drain, never resend it. While blocked skip keepalive; mark missed normal events without retaining deltas. On drain continue remaining bootstrap frames; once bootstrap completes, close if updates were missed, otherwise stay connected. Clean listeners and subscriptions idempotently. The bootstrap array is bounded by known server snapshot count, not arbitrary stream history.
- [ ] **Integrate every write path.** Route initial snapshots, normal events and keepalives through the writer. Register the subscriber before bootstrap so racing state changes request resync. Profile deletion and maintenance call close, rather than bypassing writer cleanup. Avoid standalone `res.write(false)` removal logic remaining in either event module.
- [ ] **Run green:** repeat focused tests and `node scripts/run-tests.mjs tests/reconnect_run_store.test.ts tests/task_run_snapshot.test.ts`. Extend the hook test to lose a terminal event, reconnect after live TTL expiry, and recover persisted completion with zero task POSTs. Browser fixture verifies connected/reconnecting state and preserved composer text.
- [ ] **Record checkpoint:** `fix: recover SSE streams after output backpressure`.

## Regression assertion examples

These are assertions to put into the named fixture tests, not standalone scripts. Build fixture setup in those files using existing test patterns; do not mock away the behavior under test.

```ts
// worker_liveness.test.ts: heartbeat_timeout_preserves_pending_stream
assert.equal(await client.healthCheck(15), false);
assert.deepEqual(killCalls, []);
assert.equal(streamFailureCount, 0);

// task_failure_persistence.test.ts: preserves_openai_auth_category
assert.equal(getLatestTaskAgentRun(task.id)?.errorCode, 'openai_auth_required');

// automatic_recovery.test.ts: queued_repair_retains_cause
assert.equal(getRecovery(task.id)?.reason, 'verification_failed');
assert.equal(getLatestTaskAgentRun(task.id)?.recoveryWaitReason, 'queued_message');
assert.equal(recoveryDispatchCount, 0);

// sse_backpressure.test.ts: two_bootstrap_frames_survive_first_drain
assert.deepEqual(writtenFrames, [taskRunsFrame, delegationsFrame]);
assert.equal(responseEnded, false);
```

## Completion checkpoint

- [ ] Run the shared V1 gate in the handoff plan after integrating A and G. Update `docs/coding-harness.md` and `AGENTS.md` only for changed contracts; do not claim the production symptoms are fixed.
