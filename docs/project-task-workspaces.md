# Project task workspaces and automatic repository queue

## Required behavior

Project tasks with write access to the same linked repository run in order. Users send requests normally; saved requests wait and start automatically. Tasks in different repositories and unlinked conversations remain independent. Every task retains its own files and branch.

Cards say “Waiting for [task] to finish.” If the earlier task is unsuccessful, awaiting an answer, still has native background work, or cannot pass checks, its work stays saved and the next task explains the hold. Marking a held task Complete cancels its saved start request. Completing a running task does not bypass checks or discard its work.

After a successful native turn, Olympus checkpoints the task locally, runs its required checks on that exact source, and advances a server-owned local development branch. The next task clones that accepted source and incorporates the current downloaded default branch before beginning. Changed, failed, unknown or unverified source cannot advance the development branch. No handoff approval or branch selection is required. Main and GitHub publication remain separate explicit actions. When an authorized publication was saved during the turn, that existing publication protocol creates its commit first; Olympus checks the confirmed commit before handing it to another task, preserving the exact publication request.

Queue identity is the GitHub repository ID, shared across profiles and Project connections. SQLite records the owner and exact run, with no expiring lease. Native workers also hold an OS file lock in persistent storage; an old process cannot overlap its replacement, and native children/processes must clear before handoff. On restart, normal exact-run recovery retains the same owner. Nothing kills old work to let the queue advance.

The initial implementation queues all tasks with write-capable access to a linked repository, including research in that workspace. A “research” label alone is not a read-only boundary. It does not introduce a task-type picker, an agent supervisor, or a parallel-writing switch.

## Storage and compatibility

- New task clones live under `project-checkouts/tasks/<projectId>/<taskId>`.
- Accepted development history lives in the bare local repository `project-checkouts/development/<repository-key-hash>` on `olympus/development`. Retain this directory along with normal task storage in backups. No GitHub refs are changed by handoff.
- A separate `project-checkouts/baselines/<projectId>-<sourceKey>` clone supplies the downloaded default branch for new tasks. The source key identifies the repository connection and branch, so changing either preserves earlier downloads and creates the correct baseline. Before creating each new task workspace, Olympus fetches the current default branch into this baseline and records the verified time and commit. Project sync can also refresh it. A failed fetch stops preparation instead of silently using stale source; the saved task request remains retryable. Project sync leaves task folders unchanged. Before a queued follow-up starts, its task incorporates accepted development and current upstream source; conflicts preserve the original work and hold the queue.
- The existing `project-checkouts/<projectId>` folder remains with its current task. Migration preserves its files, branch, lease, and path, even when dirty or active.
- Lease uniqueness changes from one active lease per Project to one per task and workspace. Releasing a workspace preserves its folder and the task's workdir. Historical released leases that point at another task's legacy folder must not be reused.
- Clones have independent Git metadata and objects. Authentication is supplied only to server Git operations, never persisted in remotes or task files.

## Empty GitHub repositories

An empty repository can start Project tasks immediately. After a failed branch clone, Olympus requires a successful remote ref listing with no refs before creating a local empty starting commit. It adds no application files and publishes nothing during preparation or sync. Missing branches in nonempty repositories and authentication failures remain errors.

The first Commit & Push creates the task branch and default branch atomically. With the task-branch default selected, the default branch contains only the empty starting commit, so task code remains available for review and merge. Selecting **Also push to** the default branch gives both branches the task commit. The default branch is created only if still absent; a concurrent publication cannot be overwritten.

The local starting commit is recorded in checkout Git configuration and survives restarts. Sync retains it while GitHub is empty. Once the remote default branch exists, sync replaces only an untouched starting baseline with that branch, including when someone initialized GitHub independently. Existing task folders and modified baselines are preserved.

## Publication and retry

Commit & Push defaults to the task branch each time the dialog opens or the selected task changes. Also pushing to the default branch requires an explicit choice. A successful push displays its commit and branch. A deployment service may build that branch, but Olympus does not verify deployment.

If GitHub publication cannot be confirmed, the task and Project Code views show the saved commit and all approved target branches, even when the working tree is clean. **Resume publication** uses the saved publication ID; it cannot replace the message, branch choice, or commit. A conflict remains visible and does not authorize a force push or another commit. Uncertain publication does not undo the saved commit or local files, and pending publication prevents workspace release or a new publication.

A clean workspace can still have a task-branch commit to publish to the default branch. The task dialog and Project Code view offer **Push to** the default branch for that existing commit. This reuses its SHA and message, keeps the default branch opt-in, and uses the same durable receipt and non-force Git push. Newer competing branch changes remain protected; a clean checkout alone does not mean the commit reached the default branch.

A resume requested during an active chat is saved until that turn finishes successfully. It retains the original commit and destination. If Git reports that a target branch has advanced, Olympus keeps that reason visible: stop retrying the saved publication, merge the latest target branch into the task, run checks, then publish the reviewed result.

**Stop retrying this publication** requires confirmation. It records abandonment without undoing anything GitHub may already have accepted. The saved commit and local files remain available.

**Sync latest from GitHub** refreshes the separate baseline. New task workspaces also fetch the latest default branch automatically. Sync itself leaves existing task branches and files unchanged. Admitting a queued task or follow-up requires a successful source refresh; a running turn is unaffected by a later loss of connectivity. The displayed sync time and commit describe the last successful verification, not a guarantee of current connectivity.

An existing task can use its **Task actions → Update from GitHub** action while idle. `POST /api/projects/:id/editor/update-source` accepts `{ taskId }` through the same task/profile ownership and active-work guards as other workspace mutations. It fetches the linked default branch with a read-only token and merges it into that task branch. It never pushes or deploys. Local commits are retained; uncommitted files, unfinished Git operations and pending publications require resolution first. Git conflicts are aborted back to the prior committed tree, and ignored local files are never overwritten. Separately initialized histories are preserved with an actionable explanation. Updating a published task reopens its retained workspace.

After updating, run checks on the combined source before publication; earlier evidence becomes stale when the source changes. Tasks retain separate branches: publication to the default branch uses non-force updates, so a competing change can require another update and verification. A successful Git merge alone does not establish that combined application behavior is correct.

## GitHub source access

Project Settings → GitHub source access lists the GitHub accounts already connected to Olympus. A Project manager can select several accounts and save them independently of the main repository. No source accounts are selected by default. GitHub must still permit the connection to read each source repository; selecting an account does not expand its GitHub App installation permissions.

On the next task message, the agent receives `project_github` with `list`, `check`, and `clone` actions. The server checks the current Project selection and task profile, resolves the repository through that account's catalog, and issues a read-only token restricted to the source repository. Tokens stay on the server. The main repository remains the destination for Commit & Push.

Source clones contain full Git history and all branches under the task profile's `workspace/tasks/<taskId>/sources/<owner>/<repository>` directory, outside the main checkout. They have no stored credentials and their push URL is disabled. Submodules are not recursively cloned. The agent can inspect these sources, run baseline checks, and import history into the main repository. Repeating `clone` returns the existing source folder without refreshing or overwriting local work.

Removing an account blocks subsequent source operations; it does not delete files already downloaded. Selected connections cannot be disconnected globally until their Project uses are removed. Access changes are checked again during each operation. A successful settings save verifies the connection, while `check` or `clone` verifies access to the specific repository.

The tool is available directly to the root task agent. Delegated sessions do not inherit its broker access. On older Hermes versions, `execute_code` does not discover this custom tool; the agent must call `project_github` directly.

## Verification and rollout

Real SQLite, Git, HTTP and subprocess regressions cover durable ownership, queue order, failed/unknown native work, exact accepted source, protected upstream refs, and OS exclusion across worker replacement. UI tests cover plain-language notices and board updates without changing task timestamps.

Deploy only through the normal safe idle/drain flow. Existing task folders, histories, native children and previews are preserved. Old unfinished work is never silently accepted into development history. Project repository reconnection is blocked while repository requests exist. Task deletion clears ownership only after native work is confirmed idle; database constraints prevent bulk deletion from leaving an orphaned owner.
