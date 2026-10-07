# Independent Project task workspaces

## Required behavior

A Project groups tasks and supplies their repository. It does not reserve that repository for one conversation. A task creating a PNG, editing code, running checks, or retaining unfinished work must not prevent another task in the same Project from starting.

Each task keeps its own files and protected Git branch across turns. Commit & Push, checks, background recovery, and restore operate on that task only. A publish conflict affects that task's publication; it does not authorize a force push or block other conversations.

## Storage and compatibility

- New task clones live under `project-checkouts/tasks/<projectId>/<taskId>`.
- A separate `project-checkouts/baselines/<projectId>-<sourceKey>` clone supplies the downloaded default branch for new tasks. The source key identifies the repository connection and branch, so changing either preserves earlier downloads and creates the correct baseline. Before creating each new task workspace, Olympus fetches the current default branch into this baseline and records the verified time and commit. Project sync can also refresh it. A failed fetch stops preparation instead of silently using stale source; the saved task request remains retryable. Neither operation merges into existing task folders.
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

A resume requested during an active chat is saved until that turn finishes successfully. It retains the original commit and destination. If Git reports that a target branch has advanced, Olympus keeps that reason visible: stop retrying the saved publication, merge the latest target branch into the task, run checks, then publish the reviewed result.

**Stop retrying this publication** requires confirmation. It records abandonment without undoing anything GitHub may already have accepted. The saved commit and local files remain available.

**Sync latest from GitHub** refreshes the separate baseline. New task workspaces also fetch the latest default branch automatically. Existing task branches and files stay unchanged, and existing tasks can resume offline. The displayed sync time and commit describe the last successful verification, not a guarantee of current connectivity.

An existing task can use its **Task actions → Update from GitHub** action while idle. `POST /api/projects/:id/editor/update-source` accepts `{ taskId }` through the same task/profile ownership and active-work guards as other workspace mutations. It fetches the linked default branch with a read-only token and merges it into that task branch. It never pushes or deploys. Local commits are retained; uncommitted files, unfinished Git operations and pending publications require resolution first. Git conflicts are aborted back to the prior committed tree, and ignored local files are never overwritten. Separately initialized histories are preserved with an actionable explanation. Updating a published task reopens its retained workspace.

After updating, run checks on the combined source before publication; earlier evidence becomes stale when the source changes. Parallel tasks still have separate branches: publication to the default branch uses non-force updates, so a competing change can require another update and verification. A successful Git merge alone does not establish that combined application behavior is correct.

## GitHub source access

Project Settings → GitHub source access lists the GitHub accounts already connected to Olympus. A Project manager can select several accounts and save them independently of the main repository. No source accounts are selected by default. GitHub must still permit the connection to read each source repository; selecting an account does not expand its GitHub App installation permissions.

On the next task message, the agent receives `project_github` with `list`, `check`, and `clone` actions. The server checks the current Project selection and task profile, resolves the repository through that account's catalog, and issues a read-only token restricted to the source repository. Tokens stay on the server. The main repository remains the destination for Commit & Push.

Source clones contain full Git history and all branches under the task profile's `workspace/tasks/<taskId>/sources/<owner>/<repository>` directory, outside the main checkout. They have no stored credentials and their push URL is disabled. Submodules are not recursively cloned. The agent can inspect these sources, run baseline checks, and import history into the main repository. Repeating `clone` returns the existing source folder without refreshing or overwriting local work.

Removing an account blocks subsequent source operations; it does not delete files already downloaded. Selected connections cannot be disconnected globally until their Project uses are removed. Access changes are checked again during each operation. A successful settings save verifies the connection, while `check` or `clone` verifies access to the specific repository.

The tool is available directly to the root task agent. Delegated sessions do not inherit its broker access. On older Hermes versions, `execute_code` does not discover this custom tool; the agent must call `project_github` directly.

## Implementation and verification plan

1. Update `server/db/schema.sql`, `server/db/index.ts`, and `server/db/project-cp.ts`. Verify old database migration twice, retain the legacy lease, and acquire two distinct task leases. Reject two owners of the same folder.
2. Update `server/project-cp.ts`. Resolve exact task ownership, create independent clones, retain resumable folders, and refresh a separate baseline. Test two dirty tasks, unpublished local commits, release/resume, failed clone and sync, and publication excluding the other task's files.
3. Update `server/task-run-lifecycle.ts` and Project, recovery, and verification routes. Hold only the target task during its mutation, including after a browser disconnect. Reject active native work in that target; allow unrelated tasks and their checks to proceed.
4. Expose exact-task editor lookup and a workspace list. Update task and Project pages to select the correct task for status, publishing, and restore. Project sync must not show another task's saved files as a global blocker.
5. Run real Git/HTTP regressions and browser checks. Verify a task producing a poster does not block a second design task, either task can resume, and a Project sync leaves both folders unchanged. Retain profile-access, credentials, source-evidence, drain, and same-task exclusion coverage.
6. Run the full test suite, TypeScript checks, and production build, then independently review the combined change. Stop all disposable browser/test servers after verification.

The live installation must be updated through its normal approved installation flow before it uses this architecture. Do not migrate live files by stashing, resetting, moving, or deleting a running task's checkout.
