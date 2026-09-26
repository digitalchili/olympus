# Git publication hardening evidence — 2026-09-26

Scope: G1 and G2 of `docs/superpowers/plans/2026-09-26-github-publication.md`. Implemented in the shared `codex/production-hardening` worktree based on `1dd01b2` (v0.7.19). This file reports local source and disposable-fixture evidence, not a deployment or live GitHub acceptance test.

## Behavior delivered

- SQLite publication receipts preserve the repository identity, original action/message/parent/tree, exact commit, target branches and every ref source. One unresolved receipt per task; version insertion and receipt confirmation are one idempotent transaction. Existing schema upgrade conventions remain unchanged.
- A prepared receipt precedes commit creation or restore. Recovery adopts the matching direct-child commit or completes its saved staged tree; changed/partial restore state fails closed. Pending commits have private retention refs. Publication never resets/stashes task work and never substitutes current HEAD for the saved SHA.
- Exact multi-ref confirmation repairs lost acknowledgements and failed database finalization. Explicit retry keeps the saved intent; empty repository initialization keeps distinct task/base SHAs and atomic create-only semantics. No background/startup push was added. Abandon changes only the receipt and does not undo remote changes.
- `ProjectGitStatus.pendingPublication` exposes only ID/action/SHA/branches/state. Guarded retry/abandon routes accept only `{taskId}`. Pending receipts block another publication and editor release. Confirmed retries are read-only and idempotent. The task-chat shortcut reports pending state and explains where to resume; it neither consumes nor replays an older queued shortcut automatically.
- Both route wrappers forward the exact repository ID and read/write scope. Clone/fetch/ref checks request read scope; push requests write scope, retaining the existing gateway's Workflows permission contract.
- Shared controlled Git environment removes inherited Git overrides/tracing, disables executable hooks and credential helpers, disables redirects/submodule recursion/tag following, enforces TLS and HTTPS for token-bearing requests, and scopes the transient header to the repository URL. Local transport overrides, includes/rewrites and changed origin/push URLs fail before credentials. Git stderr is replaced by fixed public messages, with the existing safe Workflows upgrade message retained.
- Project baseline sync still updates only future task starting points. Existing task branches/files/evidence remain untouched.

## Red evidence

Before implementation:

```sh
node scripts/run-tests.mjs tests/project_publication_recovery.test.ts tests/project_git_auth.test.ts
```

Failed on `accepted but unconfirmed publication must retain its exact commit`: the local HEAD had been soft-reset to its parent while the disposable bare remote already held the new commit. The injected failure occurred only after real Git accepted the push, and the subsequent confirmation was made unavailable. The test runner stops at the first failing file.

Separate initial executions of `tests/project_git_auth.test.ts` and `tests/project_publication_model.test.ts` failed because their new helper/model modules did not yet exist. Subsequent existing tests exposed old soft-reset/raw-stderr expectations; these were updated to assert retained exact commits and safe errors while preserving file, branch, ownership, and atomicity checks. The existing task isolation regression caught a lost cross-task restore guard during implementation; the guard was restored and the full focused matrix passed.

## Green evidence

Node `v22.22.3`; `git version 2.54.0 (Apple Git-157)`.

This complete 19-file command exited 0:

```sh
node scripts/run-tests.mjs \
  tests/project_publication_model.test.ts \
  tests/project_publication_recovery.test.ts \
  tests/project_git_auth.test.ts \
  tests/project_cp_model.test.ts \
  tests/project_cp_safety.test.ts \
  tests/project_empty_repository.test.ts \
  tests/project_cp_routes.test.ts \
  tests/project_task_workspace_routes.test.ts \
  tests/project_task_workspace_queued_claim.test.ts \
  tests/project_cp_lifecycle_routes.test.ts \
  tests/project_operation_drain.test.ts \
  tests/project_task_isolation.test.ts \
  tests/project_baseline_identity.test.ts \
  tests/project_merge_recovery.test.ts \
  tests/project_sync_routes.test.ts \
  tests/project_github_access.test.ts \
  tests/studio_github_read_scope.test.ts \
  tests/studio_github_manifest_gateway.test.ts \
  tests/studio_github_credentials.test.ts
```

The two TAP suites reported 5/5 drain cases and 9/9 sync cases; the other 17 files use top-level assertions and completed successfully. Later additions to the model and publication recovery fixtures were rerun individually and passed. Server and client TypeScript checks and `git diff --check` exited 0:

```sh
npx tsc -p server/tsconfig.json --noEmit
npx tsc -p client/tsconfig.json --noEmit
git diff --check
```

Coverage includes accepted push plus lost response/confirmation; interruption immediately before/after commit creation; interrupted version finalization; fresh service recovery; definite rejection; immutable repository/target/SHA; changed index refusal; later dirty-file preservation; complete-ref confirmation; non-rewinding concurrent task/default branch writes; empty-repository atomic rejection; restore recovery and partial restore refusal; local-only abandon; duplicate confirmation; pre-receipt schema upgrade with historical rows and repeated schema application; task/lease deletion retention; scoped tokens through both HTTP wrappers; real pre-commit/post-commit/pre-push hooks and credential-helper sentinels; inherited tracing/config controls; URL/transport/include rejection before token minting; no automatic tag publication; task-handler ACL/active work/pending release restrictions; HTTP error redaction; disconnected retry/abandon drain ownership; read-only source cancellation and access rechecks.

## Deviations and limits

- Migration assertions are kept in `project_publication_model.test.ts` instead of a separate migration file, avoiding duplicated database fixtures. They exercise a schema without the receipt table, insert existing project/task/lease/version rows, apply the current schema twice, and compare every historical row.
- Crash boundaries are deterministic injected Git/database failures followed by a fresh service instance against durable SQLite, not an operating-system power-loss test. The remote operations themselves are real Git against disposable bare repositories.
- Added `push.followTags=false` and `push.recurseSubmodules=false` to preserve the exact saved ref set despite repository-local settings. A real annotated-tag fixture proves the tag remains local.
- Queue recovery broadcasts requested by R3 occur after successful queue consumption/restoration in the task workspace route. No queue schema or automatic queue cleanup was added.
- Scope is the server-owned Git path, not a sandbox against a malicious process with the same local user permissions. Agent shell Git behavior remains unchanged.
- No live tokens, GitHub writes, model calls, application deployment/restart, production data, release, or commit was used. Real GitHub App permission/branch-protection behavior and live publication remain a later authorized pilot. G3 browser evidence and the integrated build/full-suite gate are recorded separately by their owners.

## Independent bounded review

A separate reviewer inspected G1/G2 receipt preparation/recovery/confirmation, retry routes, transport configuration and their existing QA/tests. No additional actionable G1 receipt-identity, reset/data-loss or multi-ref reconciliation defect was found in that bounded source review. This does not extend the live-GitHub evidence boundary above.

Two G2 issues were reproduced before follow-up fixes and sent to the coordinating agent:

- A repository with `push.gpgSign=true` and a custom `gpg.program` passes configuration validation. Against a disposable bare remote advertising push certificates, real Git executed that repository-selected signer with the fake Authorization header in its environment. The controlled environment must disable push signing (or reject it before credentials). Reproduction: `node --import tsx /tmp/olympus-git-review-7AT3LW/push-signing.mts`; observed `repositorySignerExecuted: true` and `receivedAuthorizationHeader: true`.
- A fake installation-token provider throwing the existing safe `GitHubPermissionUpgradeError` for write scope was converted by `tokenFor` into a generic Git error, then exposed as `PUBLICATION_UNCONFIRMED`/503. It must retain the actionable permission-upgrade type; the later publication catch already supports it. Reproduction: `node scripts/run-tests.mjs /tmp/olympus-git-review-7AT3LW/permission-upgrade.mts`; the assertion expecting the permission-upgrade type failed.

These were new targeted disposable reproductions, not reruns of the full suite. Both used temporary local Git repositories and fake credentials only. Their temporary scripts remain local review artifacts; follow-up regression and green evidence belong to the fixes.

## Follow-up corrections after independent review

The signer reproduction was incorporated into `project_git_auth.test.ts`: a real bare remote advertises push certificates and the task repository enables `push.gpgSign` with a sentinel `gpg.program`. Before the correction, the sentinel executed and reported only `authenticated` (no credential bytes were printed). Command-scoped `push.gpgSign=false` now prevents execution and the push succeeds.

A further bounded credentials-challenge check reproduced repository `core.askPass` execution during real `git credential fill`, despite `GIT_TERMINAL_PROMPT=0` and a disabled credential helper. Its sentinel ran before the fix. Command-scoped `core.askPass=''` now prevents the repository prompt program from executing. This regression uses no network and checks executable behavior rather than only inspecting config entries.

Both HTTP entry points now test a fake write-token provider throwing `GitHubPermissionUpgradeError`. The red response was 503/`PUBLICATION_UNCONFIRMED`; `tokenFor` now preserves that reviewed safe error, while sanitizing other token failures. Green responses are 409/`GITHUB_PERMISSION_UPGRADE_REQUIRED`, with Workflows upgrade instructions and the same pending commit available for retry after permissions are fixed.

The integrated suite exposed a nondeterministic migration-fixture ordering failure: random UUID sorting could insert a restored version before the original version referenced by its foreign key. This was fixture seeding, not schema migration behavior. The fixture now deliberately orders the child ID before its parent, copies only its own Project's rows inside a transaction with deferred foreign keys, and asserts `foreign_key_check` is empty before testing repeated upgrade. It no longer depends on random UUID order or unrelated fixture rows.

Final correction verification exited 0:

```sh
node scripts/run-tests.mjs tests/project_git_auth.test.ts tests/project_publication_model.test.ts tests/project_cp_safety.test.ts tests/project_publication_recovery.test.ts
npx tsc -p server/tsconfig.json --noEmit
git diff --check
```

The preceding six-file correction run also passed `project_task_workspace_routes.test.ts` and `studio_github_read_scope.test.ts`. The root agent owns the final integrated full-suite result; the original 19-file run above preceded these review corrections. No commit, live credential, external Git request or deployment was performed.
