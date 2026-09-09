# Coding and recovery

Olympus keeps Hermes as its execution engine. Olympus provides persisted continuation bookkeeping, safe automatic recovery and Git verification evidence around that engine.

## Coding tasks

Select a local Git working directory or a managed Project checkout. A task in a repository subdirectory uses the enclosing repository root for source evidence and checks. Olympus records the starting commit and a fingerprint of tracked and nonignored untracked files, including file modes and symlinks. Before a successful coding run can enter review, Olympus runs the repository's required checks and records their command, output, exit status, elapsed time and source fingerprint. Failed, missing or stale checks leave the task in progress. A clean working tree does not bypass checks for coding work, revision changes, explicit verification requests, goals or the manual **Run checks** action.

An unchanged conversational turn without a coding/check request records verification as **skipped** and finishes without launching commands. Read-only terminal activity does not require checks. The comparison uses both the starting revision and source fingerprint, not just Git's changed-file count. A successful turn on unchanged, clean source moves to review while its checks remain explicitly skipped. Existing unverified changes still require checks and show **Verification needed** with the reason and **Run checks** action. The built-in **Continue** prompt explicitly requests remaining verification, including work completed in an earlier turn. A repository created during the turn still requires checks.

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

Each entry is an executable followed by arguments, executed in the repository root without an implicit shell. Up to eight configured commands run sequentially until they finish or the user stops them. Olympus does not impose a verification time limit. Without this file, Olympus uses existing `test`, `typecheck` and `build` scripts from `package.json`. Other projects need explicit commands. Commands are ordinary local project code, with the same access as Olympus; this is not a sandbox.

The task's **Code verification** panel shows the checked revision, changed paths, tracked-file diff and check output. While checks run, it shows the active command, recent output and elapsed time, including a heartbeat for quiet commands. Use **Run checks** after correcting a failed check. Passing evidence becomes stale when the source changes, including edits without a new commit. Verification that modifies source cannot attest its starting source; rerun after reviewing those changes. The final source comparison runs before terminal delivery, with the same explicit cancellation handling as the checks. Checks operate in that task's checkout. Tasks outside Git retain their normal completion flow.

Evidence does not establish functional completeness or replace human review. Ignored files are excluded from the fingerprint; submodules require separate verification. Output and tracked diffs are size limited and common secret assignments are redacted, but the panel remains local project data. Olympus does not publish or push a Git change through this feature.

## Independent Project tasks and GitHub sync

Use **Sync latest from GitHub** on a connected Project. The Project keeps the last successful sync time, checked commit and **Updated** or **Up to date** result across reloads. Failed attempts leave that evidence unchanged; it describes the last verified sync, not a promise that GitHub has not changed since then.

Each new task gets an independent clone and branch from the downloaded Project baseline. Saved changes, active checks, and unfinished runs in another task do not block starting it. Reopening a task retains its files and branch. The existing legacy checkout stays with its owner; migration never stashes, resets, or moves its files. Selecting a task on the Code tab scopes status, publishing, and version restore to that task.

Sync refreshes only the separate baseline for future tasks. It does not change existing task workspaces or require their editors to be released. A new task can use an already downloaded baseline while GitHub is temporarily unavailable. Publishing conflicts affect only that task; Olympus never force pushes to resolve them. Existing Project permissions and task-handler restrictions apply, and GitHub App credentials stay in the server control plane.

Operations in the same task or the same physical workspace remain exclusive until checks and background cleanup settle. Rejected chat startup restores the prompt and attachments without overwriting a newer draft. This protects shared legacy/local folders while allowing independent Project tasks to run concurrently.

Agents receive a separate task output directory under the active profile's workspace for standalone images, HTML drafts, exports, and helper scripts. Absolute output paths use the existing native artifact publisher. These outputs do not trigger source checks unless the agent also changes repository files. Files requested as part of the application still belong in its source checkout and require normal verification.

See [Project task workspace contracts](project-task-workspaces.md) for storage and migration details. Completing a task or publishing from another checkout never proves the original task's files were published.

## Recovery

The worker stores continuation state in a profile-scoped SQLite journal under `OLYMPUS_DISPATCH_HOME/data/continuations-*.db`. Hermes continues to own transcripts, child execution and native results. Queue notifications are hints: the worker also reconciles native durable child records, so a missed notification need not lose a completed result.

Successful synthesis is saved before native acknowledgement. If acknowledgement fails or its response is lost, a later run repairs acknowledgement without repeating synthesis. Busy delivery claims retain pending state rather than replaying the original request. A safely saved partial turn can continue from saved Hermes history.

The server checks recoverable failures every ten seconds and at startup, without an Olympus attempt or elapsed-time cap. It waits while owned background work remains active or cannot be verified. Goal continuations retain the original active goal and require the native Hermes goal evaluator to confirm completion. Olympus does not add a separate goal-turn cap. Native goal operations run off the JSONL reader and retain a task lock until they finish; new work waits for any late operation instead of racing its state writes.

Explicit stop, unanswered interactions and ambiguous interrupted model/tool execution block automatic continuation. These states need user input because a journal cannot prove whether arbitrary external tool effects happened. **Pause automatic recovery** prevents a pending dispatch from starting; an already running continuation uses the normal Stop control. Recovery records exhausted by older releases are rechecked against native continuation evidence at startup. User-queued follow-ups are stored separately and preserve their existing dispatch semantics.

After an SSE reconnect, the browser reloads persisted history and run status even if the live snapshot expired. Connection trouble is visible. A displayed continuation receipt proves saved recovery metadata or session history; it is not a project-file backup or proof of a native model checkpoint.

## Hermes compatibility

Native recovery contracts were tested against Hermes **v2026.8.31**, source commit `29112bef099274229cadff79cdff7bf7b99c4b77`. Docker pins that image by multi-platform manifest digest:

`sha256:64923faeae267792bf9bf87fe3b4c4869e35004e360c7df01730ad801b74d524`

Olympus builds and runs its server with separately pinned Node 22.22.3 under `/opt/olympus-node`. Hermes keeps its own Node 26 toolchain on PATH. The application does not need to widen its supported Node range or replace Hermes's tool runtime.

The integration depends on native durable delegation lookup, delivery claim/release/acknowledgement and the async-delegation ledger. Incompatible or unavailable native recovery remains an explicit blocker for known unfinished results. Local Hermes installations are not automatically upgraded by this code change. Use the installation dry-run and approval flow before updating a running installation.

See [v0.6.0 validation](testing/v0.6.0.md) for executed checks and limits.


## Recovering a task blocked by background work

When a finished or interrupted turn leaves a command or preview server alive, the chat shows **Task recovery** above the message box. **Check again** refreshes real process status; exited processes are reconciled automatically. **Stop background work** asks for confirmation, stops only the task's currently listed terminal processes, and then lets the user send the preserved draft. It never sends a message or marks checks passed by itself.

Cleanup requires the same latest run and exact process IDs shown to the user. The server holds task and Project ownership until the worker settles, including after a browser disconnect. The profile-scoped worker independently checks session lineage and exact native process ownership; active agents, delegated work, unavailable or oversized inventories prevent cleanup. Native process APIs retain their PID identity checks and output history. Cleanup does not need a model-run slot and never uses a blanket OS process kill, Git reset, checkout, or application restart.

Disposable browser fixtures should be stopped when verification ends or fails. A stopped fixture is not evidence that verification passed; existing failed-run and coding-evidence rules still apply.

## Task execution and recovery in v0.7.7

The board column remains the human workflow status. The task header and cards separately show **Running** only for an active run, **Resuming…** while automatic continuation is pending, **Waiting to resume** when recovery is waiting for background work or evidence, and **Needs attention** when execution has stopped. These outcomes persist across reloads and server restarts. The chat uses one recovery banner; **Continue task** resumes through normal admission without clearing an unsent draft, and **Pause automatic recovery** prevents another automatic dispatch.

Olympus no longer imposes a 40-step limit. It uses Hermes's unlimited step default, honors an explicit profile `agent.max_turns` or `OLYMPUS_AGENT_MAX_ITERATIONS`, and retains the finite wall-clock deadline.

A foreground tool such as an installer can be silent for more than five minutes. Its running/completed lifecycle now suspends only the idle timeout; the absolute run deadline still applies. After the tool or child-result wait finishes, the model idle timeout applies again.

A tool-iteration limit can now continue automatically if Hermes returned normally at that boundary and its returned conversation matches durable session history, with every tool call resolved and no unknown effects or cleanup failures. The child result remains unacknowledged until synthesis succeeds. Recovery still checks every ten seconds, permits at most two automatic attempts within two hours, and never treats a partial result as completion. User stops, crashes, interrupted tools and uncertain effects remain explicit blockers; no arbitrary actions are replayed automatically.


## Native execution and activity in v0.7.8

Hermes owns task execution limits. Olympus no longer injects an idle timeout, wall-clock deadline, finalization steer, cumulative child quota, 30-second child-result cutoff, or goal-turn ceiling. It uses Hermes's constructor defaults and honors the selected Hermes profile's `agent.max_turns`; legacy `OLYMPUS_CHAT_*` budget settings and `OLYMPUS_AGENT_MAX_ITERATIONS` no longer impose limits. Safe recovery has no attempt or time window cap. An unanswered clarification or approval stays waiting until answered or explicitly cancelled; silence never grants approval.

Task cards and the task header show an animated, indeterminate activity bar only while a run is active. The header includes elapsed time. The indicator stops when execution settles, and respects reduced-motion preferences. It is activity, not an estimate of percentage complete.

Olympus does not automatically kill slow task, verification, or reference-extraction processes. Explicit Stop and installation shutdown still cancel their owned work. Worker readiness failure reports unavailability without killing the worker. Hermes's native tool policies and limits continue to apply. Bot messaging retains its separate exchange/transport policy.
