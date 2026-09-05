# Coding and recovery in v0.6.0

Olympus keeps Hermes as its execution engine. This release adds persisted continuation bookkeeping, bounded automatic recovery and Git verification evidence around that engine.

## Coding tasks

Select a local Git working directory or a managed Project checkout. A task in a repository subdirectory uses the enclosing repository root for source evidence and checks. Olympus records the starting commit and a fingerprint of tracked and nonignored untracked files, including file modes and symlinks. Before a successful coding run can enter review, Olympus runs the repository's required checks and records their command, output, exit status, elapsed time and source fingerprint. Failed, missing or stale checks leave the task in progress. A clean working tree or a no-op follow-up does not bypass checks.

Add `.olympus/verification.json` at the repository root to select commands:

```json
{
  "commands": [
    ["npm", "test"],
    ["npm", "run", "typecheck"],
    ["npm", "run", "build"]
  ]
}
```

Each entry is an executable followed by arguments, executed in the repository root without an implicit shell. Up to eight commands run sequentially with a combined five-minute ceiling, further limited by the agent run's remaining deadline. Without this file, Olympus uses existing `test`, `typecheck` and `build` scripts from `package.json`. Other projects need explicit commands. Commands are ordinary local project code, with the same access as Olympus; this is not a sandbox.

The task's **Code verification** panel shows the checked revision, changed paths, tracked-file diff and check output. Use **Run checks** after correcting a failed check. Passing evidence becomes stale when the source changes, including edits without a new commit. Verification that modifies source cannot attest its starting source; rerun after reviewing those changes. Existing managed Projects still have one editor and a dedicated checkout. Tasks outside Git retain their normal completion flow.

Evidence does not establish functional completeness or replace human review. Ignored files are excluded from the fingerprint; submodules require separate verification. Output and tracked diffs are size limited and common secret assignments are redacted, but the panel remains local project data. Olympus does not publish or push a Git change through this feature.

## Recovery

The worker stores continuation state in a profile-scoped SQLite journal under `OLYMPUS_DISPATCH_HOME/data/continuations-*.db`. Hermes continues to own transcripts, child execution and native results. Queue notifications are hints: the worker also reconciles native durable child records, so a missed notification need not lose a completed result.

Successful synthesis is saved before native acknowledgement. If acknowledgement fails or its response is lost, a later run repairs acknowledgement without repeating synthesis. Busy delivery claims retain pending state rather than replaying the original request. A completed partial turn at the finalization reserve can continue from saved Hermes history.

The server checks recoverable failures every ten seconds and at startup. It starts at most two automatic continuations within two hours of the original run start, and caps each continuation at that same deadline. It waits while owned background work remains active or cannot be verified. Goal continuations retain the original active goal and still require the goal evaluator to confirm completion. Setup, evaluation and streaming share an absolute deadline. Native goal operations run off the JSONL reader and retain a task lock until they finish; new work waits for any late operation instead of racing its state writes; reaching the twenty-turn goal limit is an unfinished result.

Explicit stop, unanswered interactions and ambiguous interrupted model/tool execution block automatic continuation. These states need user input because a journal cannot prove whether arbitrary external tool effects happened. **Pause automatic recovery** prevents a pending dispatch from starting; an already running continuation uses the normal Stop control. Exhausted recovery remains visible and retryable. User-queued follow-ups are stored separately and preserve their existing dispatch semantics.

After an SSE reconnect, the browser reloads persisted history and run status even if the live snapshot expired. Connection trouble is visible. A displayed continuation receipt proves saved recovery metadata or session history; it is not a project-file backup or proof of a native model checkpoint.

## Hermes compatibility

Native recovery contracts were tested against Hermes **v2026.8.31**, source commit `29112bef099274229cadff79cdff7bf7b99c4b77`. Docker pins that image by multi-platform manifest digest:

`sha256:64923faeae267792bf9bf87fe3b4c4869e35004e360c7df01730ad801b74d524`

Olympus builds and runs its server with separately pinned Node 22.22.3 under `/opt/olympus-node`. Hermes keeps its own Node 26 toolchain on PATH. The application does not need to widen its supported Node range or replace Hermes's tool runtime.

The integration depends on native durable delegation lookup, delivery claim/release/acknowledgement and the async-delegation ledger. Incompatible or unavailable native recovery remains an explicit blocker for known unfinished results. Local Hermes installations are not automatically upgraded by this code change. Use the installation dry-run and approval flow before updating a running installation.

See [v0.6.0 validation](testing/v0.6.0.md) for executed checks and limits.
