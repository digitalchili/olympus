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

The task's **Code verification** panel shows the checked revision, changed paths, tracked-file diff and check output. While checks run, it shows the active command, recent output and elapsed time, including a heartbeat for quiet commands. After an executed check fails on a successfully finished task turn, Olympus queues an automatic repair with the failed command, recent output and verification timezone. The agent repairs within the existing task scope and Olympus reruns the checks, including after native Hermes continuation. **Run checks** also starts this workflow for an existing failed task. Passing evidence becomes stale when the source changes, including edits without a new commit. Verification that modifies source cannot attest its starting source; rerun after reviewing those changes. The final source comparison runs before terminal delivery, with the same explicit cancellation handling as the checks. Checks operate in that task's checkout. Tasks outside Git retain their normal completion flow.

Automatic repairs use the existing durable recovery queue, so reloads and restarts preserve pending work. They wait for an idle task and give queued user messages and unanswered interactions priority. **Pause automatic repair** cancels a queued repair; normal Stop cancels an active one. A repeated failure on unchanged source shows a blocker; source changes can continue through further repairs without a fixed attempt cap. Failed startup, missing check configuration, explicit Stop, and stale evidence do not authorize repair. Upgrading alone does not restart old failed tasks: run their checks once to begin the new workflow. Passing checks moves a task to review, not human completion or deployment.

Evidence does not establish functional completeness or replace human review. Ignored files are excluded from the fingerprint; submodules require separate verification. Output and tracked diffs are size limited and common secret assignments are redacted, but the panel remains local project data. Olympus does not publish or push a Git change through this feature.

## Response timing diagnostics

Optional local diagnostics are enabled only with `OLYMPUS_PERF_DIAGNOSTICS=1` in the Olympus server environment. They write bounded `[olympus-perf]` JSON records to server/worker stderr. Remove that variable (or set it to `0`) and restart the selected installation to disable collection. Apply the installation's normal approval/drain procedure for any live configuration change; remove previously collected records using its normal log-retention controls.

Each Send has a generated trace ID; accepted runs also have a run ID, and adapter dispatch links the worker request ID. No prompt, answer, thinking text, credential, file path, model response or raw error is recorded. Diagnostics use monotonic clocks, one record per fixed stage, and one terminal outcome. They do not create a telemetry endpoint, change task limits, or send data elsewhere. Logging failures cannot fail a task.

Node stages distinguish background inventory (including lazy worker startup), workspace preparation, admission, the pre-agent source baseline, dispatch, first meaningful activity, first answer text, native completion, verification, artifact publication and settlement. Worker stages distinguish slot acquisition, history/setup, runtime resolution, agent construction and the native call. Worker `nativeFirstOutputMs` includes native preparation, retries and provider waiting; it is not an isolated upstream request measurement. Node and worker elapsed values have separate clock origins: compare durations within each source, using the trace ID to correlate them.

The first answer is distinct from the first thinking/tool event and from reaching review. Missing stages remain absent, including a thinking-only turn's first-answer stage. Repeated goal turns record the first occurrence of each stage; contributor exchanges are included in the chair's total waiting time rather than traced independently. Use the disposable fixtures and limits documented in [response performance evidence](../qa/response-performance-2026-09-26.md) before attributing a delay to Olympus or its provider.

Saved settings now load independently of the optional model catalog. A catalog failure cannot block an otherwise ready composer; a required-settings failure keeps the draft editable and requires **Retry settings** before sending. Source identity still freshly hashes the same files and modes, but baseline/freshness reads omit unused status/diff diagnostics. Evidence polling permits only one verification/recovery pair per task generation, pauses while hidden, and refreshes on return or explicit actions.

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

Native authentication, recovery, background work, delegation, interactions, Bot messaging and Project GitHub contracts were tested against Hermes **v2026.9.24**, source commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`. Docker pins that image by multi-platform manifest digest:

`sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7`

The registry manifest was checked on 2026-09-26. Its `linux/amd64` and `linux/arm64` image configurations both identify the source commit above. The source contains the native shared OpenAI grant fixes `6bd29f26f6631be5b02db7e7d23c75800fd3934a` and `e117e792b676c93464b0e5c79d8a9c298ff00ed4`: refresh holds the source store's lock and writes the rotated grant to the root singleton and matching credential pool without creating a profile shadow.

`tests/test_worker_openai_auth_native.py HERMES_SOURCE` exercises the real native device-flow interfaces with mocked HTTP, profile-only login without changing defaults, and simultaneous refreshes from two profile processes sharing a root grant. The shared-refresh regression fails against the previous `29112bef099274229cadff79cdff7bf7b99c4b77` pin and passes against the current source. `tests/test_worker_openai_auth_helper_native.py HERMES_SOURCE` covers the Olympus helper boundary. Both require a disposable source checkout and a Python environment with its dependencies; all credentials and homes are synthetic fixtures.

The pin validation used Python 3.11.15 and isolated stores. Existing native usage, recovery, background-work, delegation-reasoning, interactions, provider/model resolution, Bot, Project GitHub and scheduled-drain tests passed with `OLYMPUS_NATIVE_HERMES_SOURCE` set to that checkout. Bot and Project GitHub refresh guards support the moved native implementation hooks and retain Olympus's exclusive delivery authority; both also passed against the previous pin. The native interaction facade still emits deprecation warnings for approval-context imports. The Docker daemon was unavailable during this validation, so this is source-contract and registry evidence, not a completed Docker image build or container-runtime check.

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


## Unreleased production hardening

Worker heartbeat failures are observational: they cannot terminate a task or another profile’s worker. Lifecycle callbacks are tied to the process that emitted them, and slow model discovery runs outside the JSONL reader so Stop, health and task admission remain responsive.

Failed runs retain safe provider categories through live state and history. Reconnect OpenAI and Check saved login are reserved for the OpenAI subscription provider; other credential failures open Providers, allowance/rate-limit failures open Usage, and unavailable models open the task model picker. Continue saved work remains explicit. Opening Providers/Usage in another tab preserves the unsent task draft.

Recovery shows Paused for your queued message or Answer the pending request first while that input blocks continuation. This is derived display metadata: the original failure, verification fingerprint and attempt history remain unchanged. Sending/removing input uses existing exact queue IDs. Clearing a blocker permits the normal native-evidence check; it does not prove completion.

Board, Project and task streams use bounded backpressure handling. A buffered snapshot drains before the next bootstrap frame; missed later updates close the stream for a fresh snapshot. Reconnection reloads history without posting or replaying task work.

Managed Git publication records the approved commit/tree, repository and full target refs before pushing. Unknown outcomes preserve the commit and receipt. Resume publication checks and retries that exact intent; it never resets/recommits or includes later edits. Stop retrying records abandonment and cannot undo changes already accepted by GitHub. New dialogs default to the task branch; an additional default-branch push is explicit. Pushed is Git evidence, not deployment evidence.

Commit & Push requested during a chat turn returns `202 publication_queued`. It saves a typed action in the existing durable follow-up slot, bound to that run, checkout, source fingerprint and explicit destination. After successful settlement the server dispatches the action through the same Project ACL, repository credentials, mutation lock and native background-work check. Passing evidence must match the saved source; a later conversational turn skipping checks cannot substitute for it. Changed source/destination, failed or stopped work, and interrupted publication require review. The UI shows a cancellable queued action rather than sending it to Hermes again. Once publishing starts, the durable marker prevents automatic replay after a restart; the normal publication receipt owns recovery. No queued request or Git publication authorizes deployment.

Resume requests during an active chat use the same durable publication queue, bound to the existing receipt ID. They retry only that saved commit after successful settlement; later local edits are excluded. A human follow-up cannot be replaced. Git non-fast-forward rejection is recorded as a branch-advanced conflict, survives refresh, and requires merging the target branch and rechecking before a new publication; it is not presented as a network confirmation delay.
