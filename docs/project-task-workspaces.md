# Independent Project task workspaces

## Required behavior

A Project groups tasks and supplies their repository. It does not reserve that repository for one conversation. A task creating a PNG, editing code, running checks, or retaining unfinished work must not prevent another task in the same Project from starting.

Each task keeps its own files and protected Git branch across turns. Commit & Push, checks, background recovery, and restore operate on that task only. A publish conflict affects that task's publication; it does not authorize a force push or block other conversations.

## Storage and compatibility

- New task clones live under `project-checkouts/tasks/<projectId>/<taskId>`.
- A separate `project-checkouts/baselines/<projectId>-<sourceKey>` clone supplies the downloaded default branch for new tasks. The source key identifies the repository connection and branch, so changing either preserves earlier downloads and creates the correct baseline. Project sync refreshes this baseline and records the verified time and commit. It never merges into existing task folders.
- The existing `project-checkouts/<projectId>` folder remains with its current task. Migration preserves its files, branch, lease, and path, even when dirty or active.
- Lease uniqueness changes from one active lease per Project to one per task and workspace. Releasing a workspace preserves its folder and the task's workdir. Historical released leases that point at another task's legacy folder must not be reused.
- Clones have independent Git metadata and objects. Authentication is supplied only to server Git operations, never persisted in remotes or task files.

## Implementation and verification plan

1. Update `server/db/schema.sql`, `server/db/index.ts`, and `server/db/project-cp.ts`. Verify old database migration twice, retain the legacy lease, and acquire two distinct task leases. Reject two owners of the same folder.
2. Update `server/project-cp.ts`. Resolve exact task ownership, create independent clones, retain resumable folders, and refresh a separate baseline. Test two dirty tasks, unpublished local commits, release/resume, failed clone and sync, and publication excluding the other task's files.
3. Update `server/task-run-lifecycle.ts` and Project, recovery, and verification routes. Hold only the target task during its mutation, including after a browser disconnect. Reject active native work in that target; allow unrelated tasks and their checks to proceed.
4. Expose exact-task editor lookup and a workspace list. Update task and Project pages to select the correct task for status, publishing, and restore. Project sync must not show another task's saved files as a global blocker.
5. Run real Git/HTTP regressions and browser checks. Verify a task producing a poster does not block a second design task, either task can resume, and a Project sync leaves both folders unchanged. Retain profile-access, credentials, source-evidence, drain, and same-task exclusion coverage.
6. Run the full test suite, TypeScript checks, and production build, then independently review the combined change. Stop all disposable browser/test servers after verification.

The live installation must be updated through its normal approved installation flow before it uses this architecture. Do not migrate live files by stashing, resetting, moving, or deleting a running task's checkout.
