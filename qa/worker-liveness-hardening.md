# Worker liveness hardening — R1

Scope: `docs/superpowers/plans/2026-09-26-task-reliability.md`, Task R1, on baseline `1dd01b22eb70cd923f82c9e2da9e48f9093f1ade` (v0.7.19). Implementation and fixtures only; no live account, provider/model request, app instance, installation, or deployment was used.

## Decisions

- Ruling: preserve the observational heartbeat and app readiness changes already shipped in v0.7.19. The plan's original heartbeat red expectation predates that release; its timeout and unrelated-profile tests are regression checks here, not newly reproduced defects.
- Lifecycle updates belong to their originating child and generation. An old startup result/rejection/finally or exit/error callback cannot modify replacement readiness or reject replacement requests. Existing explicit Stop and actual-exit settlement remain in place.
- Model discovery runs in a daemon handler using the original request ID. A catalog-only build lock coalesces successful cache misses; provider/task admission locks are held only around configuration snapshots and cache publication, never discovery I/O. A cache invalidation generation also detects same-mtime settings/auth changes. A changed generation or file mtime discards the old build and rebuilds before responding.
- Catalog failures return fixed safe text. They do not expose the native exception or alter the selected settings.
- No task deadline, execution quota, worker restart policy, authentication behavior, default model, or Hermes pin was changed. The existing named-profile readiness regression remains in `tests/openai_auth_liveness.test.ts` instead of duplicating an app fixture.
- No commits: this worktree is shared with the other authorized hardening tasks.

## Red evidence

Both commands ran before the implementation change:

```sh
node scripts/run-tests.mjs tests/worker_liveness.test.ts
node scripts/run-tests.mjs tests/test_worker_model_responsiveness.py
```

- TypeScript failed: `old child callback must preserve the replacement` (replacement child became `null`). The existing observational heartbeat assertion passed.
- Python failed all four new cases: a held discovery blocked later Stop dispatch; simultaneous requests ran discovery twice; settings mutation allowed the old default model to be returned/cached; a catalog exception exposed the fixture's `SECRET upstream detail`.

## Green evidence

```sh
node scripts/run-tests.mjs tests/worker_liveness.test.ts tests/runtime_liveness.test.ts tests/openai_auth_liveness.test.ts tests/worker_error_terminal.test.ts tests/worker_delegation_events.test.ts tests/local_profile_adapter.test.ts tests/scheduled_worker_handshake.test.ts tests/scheduled_profile_drain.test.ts
node scripts/run-tests.mjs tests/test_worker_model_responsiveness.py tests/test_worker_deadline_budget.py tests/test_hermes_worker_resolve.py tests/test_worker_openai_guard.py tests/test_worker_background_work_rpc.py tests/test_worker_providers.py tests/test_worker_usage.py
```

Both passed: eight TypeScript files and 61 Python assertions/tests across seven files. Lifecycle fixtures cover probe timeout/recovery without replacement, exact-child exit settlement, duplicate/stale callbacks, readiness health/drain/failure races, explicit Stop invalidation, and a late failure after the replacement becomes ready. Catalog fixtures hold discovery on a latch while health, background inventory, real chat admission, and interrupt dispatch proceed; they check coalescing, same-mtime settings invalidation, and safe error replies. All fixture homes and state are disposable.

`npm run typecheck` initially found only the concurrent R3 edit at `server/routes/chat.ts:1271` (`LiveChatRun | undefined` passed where `LiveChatRun | null` is expected). The coordinating agent was notified. A subsequent whole-worktree typecheck and production build passed during G3 verification.

These tests establish the local concurrency contracts. They do not measure production response latency or prove a cause for a particular production disconnect.
