# Olympus reliability improvements: design and acceptance contract

Date: 2026-09-26. Reviewed baseline: `1f81b95`, Olympus `0.7.18`.

## Purpose and authorization

Michael reports repeated OpenAI reauthorization and a Retry button after stopped tasks on a Docker/server installation. He also wants confidence in GitHub pull/push handling. He subsequently added perceived slowness versus Hermes Desktop and clarified that the main delay is waiting for the first response after Send. The source review found reproducible defects and avoidable work, but no live performance comparison has been run. Michael requested improvements, then explicitly requested a detailed implementation plan to hand to a cheaper model. This package began as that planning deliverable. A subsequent, narrower instruction selected authentication for local implementation; the wider retry, GitHub and performance requirements remain pending.

Continue only the scope selected by the user; this design is not authorization to implement every remaining subsystem. A deployment, live account login, server operation, GitHub push, release, or installed Hermes update is a separate action; follow `AGENTS.md` and `INSTALL.md` at that boundary. The production host and image revision have not been inspected. Do not present these source findings as a confirmed diagnosis of the reported incidents.

**Implementation note — 2026-09-26:** Shared-default OpenAI authentication with an explicit separate-profile option is implemented in the local worktree. The A contract below reflects the current worker/RPC/HTTP/UI behavior. See [OpenAI authentication evidence](../../testing/openai-authentication.md) for validation and remaining gates. No commit, Docker build, deployment or completion of the broader package is claimed.

## Selected approach

Keep Hermes as the execution and credential authority. Repair Olympus's integration boundaries and presentation, with small focused modules where a new responsibility requires one. Retain SQLite, existing per-profile workers, task admission, native continuation evidence, and independent Project workspaces.

Alternatives considered:

- A periodic login/refresh script would duplicate native renewal and could worsen refresh-token races. Reject it.
- Replacing Hermes with Codex or rebuilding task orchestration would greatly expand scope. Reject it for this work.
- Relying only on in-memory publication recovery cannot remember approved commit/target after process death. Use a small durable publication receipt, not a general job framework.

## Global constraints

These requirements apply to every implementation task:

1. Keep changes small and necessary. Do not restructure unrelated code or introduce a new framework.
2. Preserve Hermes state, profiles, sessions, skills, credentials, task history, queued messages, Project workspaces, and Git history.
3. Never log, display, commit, or persist in Olympus tables any access token, refresh token, GitHub token, OAuth device secret, authorization code, or raw provider exception. The short-lived user-facing device code may appear only in the active sign-in response/UI.
4. Resolve the selected profile once per request. No discovery, copying, synchronization, or configuration of another host or installation.
5. Hermes owns execution limits. Do not add task runtime/idle limits, goal-turn caps, child quotas, automatic worker termination, or whole-turn replay on network errors. A finite OAuth authorization expiry is not a task execution limit.
6. Explicit Stop and unanswered interactions retain priority. Silence never approves anything. Recovery requires existing native safe-continuation evidence.
7. Preserve automatic review rules: same-source verification for coding, successful terminal completion, human-only Done/publication decisions. These changes do not bypass checks or authorize deployment.
8. Node support remains `>=22.22 <26`; server TypeScript imports retain `.js` extensions. Python implementation must support the chosen pinned Hermes runtime.
9. All test DBs, Hermes homes, and Git remotes are disposable. Set test isolation before importing modules that initialize SQLite. Use fake credentials and provider HTTP in automated tests.
10. Preserve default loopback binding and the single-writer Docker deployment sequence. No live install, restart, migration, or deployment during implementation verification.
11. Keep old stored failure codes/records readable. Additive SQLite changes must work on fresh and existing databases and be idempotent.
12. A failed or uncertain operation must never be displayed as successful. Source tests, Docker compatibility tests, and live acceptance are distinct evidence.

## A. OpenAI authorization

### Existing evidence

The reviewed baseline pinned Hermes v2026.8.31, commit `29112bef099274229cadff79cdff7bf7b99c4b77`. That revision can refresh root-borrowed Codex credentials into a named profile without updating their original root store. The singleton refresh transaction is also scoped incorrectly for shared-root peers. Isolated fake-store tests reproduced stale root credentials; production incidence is unknown.

Required upstream fixes:

- `6bd29f26f6631be5b02db7e7d23c75800fd3934a`: write refreshed tokens through to their source.
- `e117e792b676c93464b0e5c79d8a9c298ff00ed4`: hold the source-store transaction across refresh and adopt another caller's rotation.

Hermes already renews tokens and handles some 401 recovery. Olympus must not add a second independent refresh mechanism. The reviewed baseline discarded useful native authentication metadata and lacked a Codex reconnect UI. The local authentication change now preserves safe OpenAI-specific classification and supplies that UI; the wider R2 failure taxonomy remains pending.

The current local pin is **v2026.9.24**, source `f97608f178d1ffeca59860195ab7da295f7c8e5f`, immutable multi-platform digest `sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7`. Isolated source/native tests and registry image revision labels were verified. Docker build/runtime and live-account acceptance remain separate pending gates.

### Implemented authentication contract and remaining acceptance

- Validate a fixed newer Hermes release containing both fixes against Olympus's native contracts; pin its immutable Docker manifest digest only after the tests pass. A candidate is not a verified compatible release merely because it contains those commits.
- Preserve safe structured OpenAI distinctions: login required versus temporarily unavailable. Generic provider authentication must not assume OpenAI. The remaining rate-limit, allowance, invalid-model and general failure presentation requirements belong to pending R2.
- Providers exposes OpenAI sign-in with shared/default login selected initially. A named profile can explicitly choose its own separate login. Shared credentials serve inheriting profiles without replacing separate profile credentials. Show configuration/readiness truthfully; an on-disk token alone does not prove a live model connection.
- Public actions are status, user-triggered saved-login check, device sign-in start, poll and cancel. HTTP `scope` is `shared` or `profile`, defaulting to `shared`; GET carries it in the query and POST in the body. `?profile=` still selects the local profile context, while shared ownership routes to the default worker. JSONL has one `auth.openai` request type with public actions plus internal-only `guard`, `commit` and `invalidate`. HTTP callers cannot request those internal actions. Native Hermes owns OAuth and token storage; no CLI prompt scraping is used.
- Device authorization has one active attempt per owning worker, an opaque attempt ID, native expiry/poll interval and explicit terminal states. Shared-scope views refer to the same default-owned attempt. Wrong-owner/superseded attempts cannot finish. Navigation or profile changes stop local polling and ignore stale responses without cancelling the server attempt; status recovers it on return. Only explicit Cancel, expiry or worker teardown cancels it. Browser polling never repeats a token exchange or saves twice.
- Shared sign-in saves to the default store. Explicit separate-profile sign-in saves only to that profile; neither operation changes model/provider defaults. Ordinary renewal of an inherited login follows upstream source-store ownership and locking, without creating a profile shadow.
- Sign-in can start while tasks run. Hold an approved grant only in memory and show `waiting_for_idle` until safe to save. Shared save waits for default and every started profile worker, including separately authenticated profiles, and defers if a worker is starting or its readiness is uncertain. Guard foreground and scheduled admission on all affected workers, verify every count is zero, then request internal `commit`; separate-profile save guards only its owner. Track and release guards even after a lost acknowledgement, and fail closed on unresolved cleanup. No task is stopped or Python mutex held during browser consent/network exchange.
- Native polling is blocking and not cancelable in the candidate API. Isolate it in an auth-only helper process so cancellation can stop only that attempt. Never terminate the Hermes task worker to cancel sign-in.
- All long OAuth/network work runs off the JSONL reader. The device-flow helper returns credentials privately and never saves autonomously. After adapter coordination, only an internal parent-authorized save operation may invoke the private helper's native write, with attempt identity, cancellation, expiry and admission checked again.
- After successful shared sign-in, invalidate model/usage/config caches across affected started workers; separate sign-in invalidates its owner. No worker restart, default-model switch, task replay or paid model request follows.
- GET status reads only safe in-memory status and returns `unknown` after a worker restart. Do not use native helpers advertised as read-only unless proven free of writes: the candidate's status/pool loader can heal credential stores, and malformed-store handling can create backup files. Explicit POST check may use native credential renewal and reports Saved login ready, not proof that a model request will succeed.
- Reconnect must preserve a known profile-owned account/workspace identity. A different returned principal is an explicit account-mismatch outcome; changing an explicitly owned account is outside this reconnect flow. An inherited root login is not a named profile's explicit account choice; a profile with no known owned login can establish its first explicit account without changing root credentials.
- Reconnect retains the failed task's profile and resolves its effective credential owner: preserve an explicit separate login, use shared for inherited/missing credentials, and require a scope choice if ownership remains unknown. Success only makes an explicit Continue saved work action available; it never posts a task message or replays uncertain tool effects.
- Retain API-key/custom-provider settings behavior. OAuth is fixed to `openai-codex`; callers cannot submit arbitrary issuers, client IDs, credential paths, or endpoints.

## R. Task execution, recovery, and live updates

### Non-destructive health

`HermesWorkerClient.healthCheck()` currently calls `stop()` when its heartbeat fails. `stop()` sends SIGTERM and may SIGKILL after 500 ms. An isolated test confirmed the path fails active streams. Readiness's failure callback then interrupts every in-memory task, even though only the default worker was probed.

Required behavior:

- A failed heartbeat returns degraded readiness and records a safe diagnostic. It does not stop/restart a process, fail an active stream, or alter task status.
- Actual process exit continues to reject only that worker's pending operations, with existing `consumeChatRun`/settlement recording terminal outcomes. Avoid a second global terminalization path.
- Old process callbacks and old startup promises cannot clear a replacement worker's state. Compare the originating process/generation before applying lifecycle updates.
- Keep readiness/drain truthfulness and bounded probe cooldown; do not add an agent-run timeout. Move potentially slow model inventory work off the single JSONL reader where needed.

### Actionable failures

- Reuse `task_agent_runs.error_code`; keep safe categories in the existing allowlist. Do not persist raw provider text.
- Use explicit OpenAI-owned codes for OAuth actions. Generic `auth_error` must offer provider settings, never an assumed OpenAI login.
- Render a consistent title, explanation, and action across live output, board/task state, history hydration, and reload. Preserve old timeout codes for historical display without reinstating those limits.
- Rate limits show a wait/switch action; display a reset time only if real structured evidence exists. Quota failure offers Usage/provider settings. Invalid model offers model selection. None triggers arbitrary whole-turn retries.

### Queued work and recovery

- Queue priority remains unchanged. A failed run with queued input must say it is waiting for that queued message, with Send queued message as the appropriate action.
- Project a safe `recoveryWaitReason` (`queued_message` or `awaiting_input`) from current exact-run state. Do not overwrite `task_recovery.reason`, especially `verification_failed`, or damage `repair_fingerprint`.
- Do not promise imminent automatic resumption while a user action blocks it. Keep existing native recovery/acknowledgement semantics and queue consume-once IDs.
- Labels distinguish Retry sending message, Continue saved work, Resume publication, and Reconnect OpenAI. Do not label them all Retry.

### Live updates

`res.write(false)` means buffering, not a closed connection. Both live-chat and board event code currently drop such subscribers without closing their sockets.

- Use one small shared SSE writer policy for initial snapshots, real events, and keepalives.
- Keep the connection after a buffered write. While blocked, skip keepalives. If subsequent real events cannot be written, mark that a fresh snapshot is needed rather than accumulating an unlimited queue.
- On drain, keep the connection if nothing was missed; otherwise close it so existing EventSource reconnection reloads authoritative snapshots/history.
- A large initial snapshot must not cause a permanent close/reconnect loop.
- The board sends two initial snapshots (task runs and delegations). Serialize this finite bootstrap batch across drain before normal incremental delivery; never discard its second snapshot just because its first is large.
- Closing or throwing removes listeners/subscriptions idempotently. A display reconnect never restarts the agent.

## G. GitHub pull, publication, and credentials

### Preserve existing workspace contracts

- Sync updates the separate baseline for future tasks. Existing task branches and edits remain unchanged.
- Keep origin validation, independent clones, task/workspace mutation locks, atomic multi-ref publication, empty-repository initialization, and conflict rejection. Do not add force pushes, automatic resets/stashes, or automatic merges into active task workspaces.
- Explain baseline-only sync in the UI/docs. No new pull-into-running-task capability is in scope.

### Durable publication intent

The current push handler resets the local commit when both push and follow-up remote inspection fail. A real disposable Git test reproduced an accepted push followed by an ordinary retry failing as non-fast-forward.

Required behavior:

- Record a durable receipt binding the approved repository identity, task/lease, action, source commit/tree, message, and complete target ref list. Persist intent before a remote push; preserve enough pre-commit intent to recover local preparation safely.
- Retry/resume uses the original receipt and exact object IDs, never the current HEAD or a newly created timestamp-dependent commit. It cannot change the approved branch mode or repository.
- Preserve local work on every failure. Do not soft-reset on an uncertain or rejected push.
- A successful remote observation can finalize the existing receipt without another commit/push. All intended refs must be confirmed, including empty-repo/default-branch atomic cases.
- A remote outage leaves publication unconfirmed. Explicit retry may recheck and publish the same intent; startup may restore state but never automatically push.
- The version record and receipt completion commit in one SQLite transaction and are idempotent. A crash after remote success but before the DB write must not duplicate publication/version records.
- Conflicting remote changes remain visible and require explicit resolution. Never infer success from an unreachable remote or silently change the publication target.
- Revert follows the same receipt/reconciliation mechanism, preserving action and restored-version metadata.

### Credential boundary

- Mint an installation token scoped to the one server-validated repository and the existing required write permissions. Read-only source access stays read-only.
- Revalidate fetch and push origins before obtaining a token. Do not accept an arbitrary caller-provided URL.
- Disable hooks, credential helpers, redirects, and recursive submodule behavior for server-owned authenticated Git operations; sanitize inherited Git configuration environment overrides. Scope the auth header to the verified GitHub URL. Do not bypass TLS validation.
- Because repository-local Git configuration can still affect transport, explicitly validate relevant URL rewriting/transport overrides; disabling only global configuration is not sufficient.
- Tokens stay transient in the server-controlled process environment, never remotes, command arguments, stored config, task context, receipts, or output.

### Truthful publication UX

- Default new publication dialogs to the task branch. Publishing to the default branch is an explicit choice on each new operation.
- A push success says Pushed to `<branch>` with its commit. It never says Deployed or claims a build started without evidence.
- Do not add deployment polling, CI orchestration, or a PR/merge subsystem in this change. Describe configured webhook effects as conditional, not observed success.
- A pending receipt shows Publication not confirmed and Resume publication; exact approved commit/target are visible and immutable during resume.

## P. Response performance

### Priority and evidence boundary

Prioritize Send to first answer, while separately measuring first meaningful activity and finished/review. Do not count an optimistic spinner, old history or model-resolution metadata as a new response. A coding verification after the answer is not first-response latency.

Confirmed current overhead includes fresh background-work inventory before admission, coding baseline capture before the agent starts, optional `models.list` work on the single worker request reader, and repository scans during verification polling. A real-hook fixture reproduced required settings waiting unnecessarily for an unresolved optional model catalog. Existing Project workspaces do not fetch the remote on every message. Workers persist per profile; they are not spawned each turn. Browser deltas already use animation-frame batching.

The user's Desktop/server settings, versions and latency have not been measured. Hermes Desktop uses the same agent core through a different backend; a faster experience is plausible, not established for these installations. Do not infer that Docker, Python IPC, networking, model reasoning or server hardware is the bottleneck without timings.

### Required implementation

- Add opt-in `OLYMPUS_PERF_DIAGNOSTICS=1` local stage timings with opaque server-owned correlation IDs and monotonic durations. No prompts, history, credentials, configured URLs, local paths, raw provider errors, third-party telemetry or new timing database. Diagnostics are disabled by default, bounded per turn and must not affect execution.
- Measure admission/background inventory, workspace preparation, baseline, worker dispatch/queue, history/setup, runtime resolution/agent construction, native first activity/text, browser receipt/render and verification separately. Do not subtract unsynchronized clocks or call native setup-to-text pure provider latency.
- Implement R1's background model-list handling without blocking chat/admission/Stop. Concurrent catalog misses share one catalog build; catalog locks do not cover task admission or settings mutation. Changed configuration must not be overwritten by a stale build.
- Load required task/profile settings independently from the optional catalog. Keep model/provider/reasoning choices exact, protect against stale responses after switching, and show a recoverable settings error instead of silently sending with another profile's defaults.
- Extract exact full-content `SourceIdentity` from full source diagnostics. Baselines and fingerprint-only freshness callers use it; checked source still includes changed paths/diff. Preserve the existing fingerprint bytes, abort paths, enclosing-root/workdir checks, old evidence JSON and all same-source review/repair gates. No HEAD/mtime/TTL cache or concurrent agent edits during baseline capture.
- Prevent overlapping evidence polls and pause periodic background-tab polling; refresh on visibility return and explicit actions. Newer freshness requests must not reuse an older scan as proof. Ignore stale task/request responses. Server safety checks remain fresh.
- Preserve native retry behavior, thread-safe per-turn agent creation, resource ownership and selected reasoning/model. Persistent agent caching, concurrency changes, source watcher caches and broad rendering refactors require measured justification and a separate bounded design.

### Performance acceptance

P1 records a before baseline and P4 repeats controlled disposable fixtures with the same model delay, history, repository bytes, machine and load. Report median/p95, sample count and failures; separate warm from cold and ordinary chat from Git/collaboration. The hard gates are no optional-catalog dependency, no settings drift, exact fingerprints, non-overlapping polling and correct streaming/recovery. Proposed diagnostic targets are warm plain-chat server preparation p95 below 250ms and foreground receive-to-render p95 below 100ms; these are not promised results, user task deadlines or automatic execution limits. Large repository scans have their own reported before/after measurements.

A real Desktop comparison is a later user-operated/authorized test with matching provider/model/reasoning, prompt/history, tools/skills and concurrency, recording actual revisions and network/hardware differences. Do not contact or configure another installation as part of this plan. Local integration improvements can be accepted independently while the real-world comparison remains unverified.

## Evidence and acceptance

At the original review baseline, focused suites passed but four native recovery checks were skipped. The authentication implementation subsequently ran the selected native contracts explicitly against the new source; its scoped results are recorded in the linked authentication evidence. The identified failures were exposed by additional isolated probes. The review's temporary `/tmp` scripts are not durable test coverage; recreate meaningful regressions in the repository.

Acceptance has three separate gates:

1. Local implementation: red-before/green-after regression tests, targeted suites, full tests/typecheck/build, disposable browser fixtures, clean scoped diff.
2. Candidate Docker compatibility: fixed Hermes source plus immutable image digest, native auth/continuation/usage/tool contracts exercised with fake secrets and temporary state; a skipped required native test is not a pass.
3. Authorized live acceptance: selected host/volumes only, installer dry-run, backup, drain-to-zero single-writer update, readiness, user-owned sign-in, controlled task and publication acceptance. This gate is not authorized by the planning request.

The executor must report completed tasks, exact tested revisions, commands/results, skips, remaining uncertainty, and whether anything was deployed. Never equate local test results with proof that the server incidents are resolved.
