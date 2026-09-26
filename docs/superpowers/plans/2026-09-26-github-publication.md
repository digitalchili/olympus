# GitHub Publication Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Keep Git fixtures local and use fake tokens.

**Goal:** Preserve exact publication intent through failures, restrict Git credentials, and accurately report what reached GitHub.

**Architecture:** Keep the existing Project control plane, task checkouts and mutation locks. Add a small SQLite publication receipt and explicit resume/abandon operations. Use one controlled authenticated Git boundary and truthful branch publication UI.

**Tech Stack:** TypeScript, SQLite/better-sqlite3, Git CLI, GitHub App tokens, React.

**Spec:** [Reliability design](../specs/2026-09-26-reliability-improvements-design.md), Global constraints and G.

**Implementation checkpoint:** G1–G3 are implemented on `codex/production-hardening` from v0.7.19. The original checklist below records the design; consult [integrated evidence](../../../qa/reliability-2026-09-26.md) and its linked git-publication-hardening.md and publication-ui-hardening.md reports for executed steps, reviewed adjustments and current verification. Do not reimplement these tasks from the unchecked design steps. Live Docker acceptance remains separate.

## Global Constraints

All Global constraints in the spec apply verbatim. No force push except the existing create-only empty-branch lease, no reset/stash to recover a push, no automatic publication at startup, no implicit merge/rebase, and no change to existing-task sync semantics. Tokens remain out of arguments, remotes, stored configuration, receipts and output. Node remains `>=22.22 <26`; server imports use `.js`.

## Review Focus

- Remote accepted a push but both response and confirmation were lost: G1.
- Process died between commit, persisted SHA, remote update, and recorded version: G1.
- Atomic empty-repository publication has two different intended source SHAs: G1.
- Repo-local configuration/hooks or inherited Git environment can affect authenticated transport: G2.
- A failed external deployment must never receive Olympus's Deployed success label: G3.

## Task G1: Durable exact-commit publication and reconciliation

**Files:** Create `server/db/project-publications.ts`, `tests/project_publication_model.test.ts`, `tests/project_publication_migration.test.ts`, `tests/project_publication_recovery.test.ts`. Modify `server/db/schema.sql`, `server/db/project-cp.ts`, `server/project-cp.ts`, `server/routes/projects.ts`, `server/routes/project-task-workspace.ts`, `shared/types.ts`, `client/src/lib/api.ts`. G3 owns the final visual controls.

There are **no numbered migrations** in this repository. New table/index DDL belongs in `schema.sql`; existing columns, if genuinely required, use `ensureColumn` in `server/db/index.ts`. Do not invent a migrations directory or rewrite existing leases/versions.

**Receipt contract (internal):**

```ts
interface ProjectPublication {
  id: string; // also the eventual project_versions.id
  projectId: string; taskId: string | null; leaseId: string | null;
  repository: { installationId: number; providerRepositoryId: number;
    cloneUrl: string; defaultBranch: string };
  action: 'commit_push' | 'revert'; revertedVersionId: string | null;
  parentSha: string; treeSha: string; commitSha: string | null;
  commitMessage: string; changedFiles: string[]; targetBranch: string;
  refs: Array<{ ref: string; source: 'commit' | string; createOnly: boolean }>;
  state: 'prepared' | 'pending' | 'confirmed' | 'abandoned';
  createdAt: number; completedAt: number | null;
}
```

`source` is either the literal `commit` or a validated exact 40-character SHA (the empty starting commit); `ref` is a server-generated full `refs/heads/...` validated with Git's branch/ref rules. These fields are not accepted as client input. JSON is appropriate only for repository/refs/changed files. Use normal columns for IDs/state/timestamps/action/SHAs. Task/lease foreign keys use `ON DELETE SET NULL` to retain the receipt like version history. Match existing Project deletion semantics. Add a partial unique index on non-null `task_id` where state is prepared/pending.

**DB interfaces:**

```ts
getPendingProjectPublication(projectId: string, taskId: string): ProjectPublication | null;
getProjectPublication(id: string): ProjectPublication | null;
createProjectPublication(input: Omit<ProjectPublication, 'state' | 'completedAt'>): ProjectPublication;
setProjectPublicationCommit(id: string, commitSha: string): ProjectPublication;
confirmProjectPublication(id: string, pushedAt: number): ProjectVersion;
abandonProjectPublication(id: string): ProjectPublication;
```

Creation always uses `prepared` and null completion. `setProjectPublicationCommit` changes only a matching prepared receipt to pending; repeated same-SHA calls are idempotent. `confirmProjectPublication` atomically inserts the version with receipt ID and marks confirmed, returning the same version if already confirmed. Add optional `id` to `RecordProjectVersionInput` rather than another publication-ID column; ordinary old callers still generate IDs.

**Service additions:**

```ts
retryPublication(input: { projectId: string; taskId: string; publicationId: string;
  repositoryLink: ProjectRepositoryLink; tokenProvider?: InstallationTokenProvider }): Promise<ProjectVersion>;
abandonPublication(input: { projectId: string; taskId: string; publicationId: string }): Promise<void>;
```

Extend `ProjectGitStatus` with `pendingPublication: { id; action; commitSha; targetBranches: string[]; state: 'prepared' | 'pending' } | null` (use explicit field types in code). Public output excludes internal receipt paths, repository credentials, and arbitrary Git error text.

- [ ] **Write failing DB tests.** Fresh schema and repeated migration preserve old version/lease rows exactly. One unresolved receipt per task is enforced. Confirming twice returns one version with the receipt ID, correct action/revertedVersionId and no duplicate row. Inject a DB failure between version insert and receipt update and assert rollback. Task/lease deletion retains receipt history according to the declared foreign keys.
- [ ] **Write real-local-Git failure tests.** Use temporary bare remotes and a runner wrapper that performs the real push before simulating response loss. Cases: accepted push + unavailable confirmation; genuine pre-acceptance failure; process reconstruction after local commit but before saved SHA; after push but before DB finalization; after finalization but before HTTP response. Assert the exact SHA survives a later same-message retry at a different timestamp, one version exists, and no soft reset occurs. New dirty edits remain untouched and excluded from the saved push. Restore retains `action='revert'` and original version ID. Conflicts preserve HEAD/index/files/receipt.
- [ ] **Write target/ref tests.** Receipt identity/target/action is immutable across retry. Changed Project repository or lease ownership fails before token minting. Confirm **all** intended refs, not one. Empty repository non-default publication records starting SHA -> default branch plus new SHA -> task branch; explicit default publication records new SHA -> both. Concurrent first default-branch creation at a different SHA is never overwritten. All-ref exact match finalizes without push; a later remote descendant is conservatively left unresolved rather than assumed to prove this operation.
- [ ] **Run red:** `node scripts/run-tests.mjs tests/project_publication_model.test.ts tests/project_publication_migration.test.ts tests/project_publication_recovery.test.ts tests/project_cp_safety.test.ts tests/project_empty_repository.test.ts`.
- [ ] **Implement immutable preparation.** Under existing task/workspace guards, reject a new commit/restore when an unresolved receipt exists. Validate origin/repository and determine the complete authorized ref list, including empty-remote inspection, before receipt creation. For an ordinary change stage once, capture parent, `git write-tree`, message, paths and refs, persist prepared, then commit. For an existing unpublished checkpoint record its exact parent/tree/SHA without recommitting. For restore persist desired version/tree and intent before restoring. If the process dies during staging/restore and state is partial, preserve it and require inspection; do not replay arbitrary file writes.
- [ ] **Implement prepared recovery.** If HEAD is a direct child of saved parent and its tree/subject match, adopt that exact commit. If HEAD is still saved parent and the staged tree equals the saved tree, complete the original commit. A restore may start only when the original parent is still clean; a partially changed restore fails closed. Any other HEAD/index conflict is explicit and leaves files unchanged. Record pending SHA before first remote push. Keep the original commit reachable with a private `refs/olympus/publications/<receipt-id>` ref while unresolved if normal branch movement could make it unreachable; never use that ref as a remote target.
- [ ] **Replace `pushWithRecovery`.** Build refspecs from saved SHAs, never HEAD. Preserve atomic multi-ref semantics. On success finalize once; on failure inspect all saved refs. Exact match finalizes; unreachable/different refs leave pending and return safe `PUBLICATION_UNCONFIRMED` or `PUBLICATION_CONFLICT`. Remove the soft reset entirely. On explicit retry check remote first; only push the same recorded intent if still necessary. Create-only refs: absent -> original empty lease; already exact -> no-op exact lease; different -> conflict. Never silently convert a create-only operation into an overwrite. Refresh expired GitHub tokens normally via the scoped provider, not by altering intent.
- [ ] **Add guarded routes.** `POST /api/projects/:id/publications/:publicationId/retry` body `{taskId}` -> existing version response shape; `/abandon` body `{taskId}` -> `{abandoned:true}`. Reject extra replacement message/target/action/source fields. Apply the same access, task ownership, background-work, workspace and drain guards as commit-push. Confirmed receipt retry is read-only/idempotent. Abandon records the decision and stops retries; it does no Git operation and does not undo an already accepted push. Pending publication prevents editor release even when the working tree looks clean. Update task-chat shortcut to return pending info instead of silently resuming a default-branch publication.
- [ ] **Run green:** repeat tests and `node scripts/run-tests.mjs tests/project_cp_routes.test.ts tests/project_task_workspace_routes.test.ts tests/project_merge_recovery.test.ts tests/project_operation_drain.test.ts tests/project_task_isolation.test.ts tests/project_baseline_identity.test.ts`. Update old failed-push tests to assert retained commit rather than rollback, while preserving their file-protection assertions.
- [ ] **Record checkpoint:** `fix: persist and reconcile exact GitHub publication intent`.

## Task G2: Repository-scoped tokens and controlled authenticated Git

**Files:** Create `server/project-git-auth.ts`, `tests/project_git_auth.test.ts`. Modify `server/project-cp.ts`, `server/project-github.ts` only to share appropriate primitives, wrappers in `server/routes/projects.ts` and `server/routes/project-task-workspace.ts`, and gateway tests. Existing `server/studio/github-app.ts` already accepts scope; preserve Workflows write permission for supported publication.

**Interfaces:**

```ts
type InstallationTokenProvider = (installationId: number,
  scope: { repositoryId: number; readOnly: boolean }) => Promise<string>;
buildProjectGitEnv(input: { baseEnv: NodeJS.ProcessEnv; cloneUrl: string;
  token?: string }): NodeJS.ProcessEnv;
validateProjectGitTransportConfig(entries: readonly { key: string; value: string }[]): void;
```

`buildProjectGitEnv` strips inherited `GIT_CONFIG_*`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_PROXY_COMMAND` and trace/debug variables before installing server-controlled values. Preserve ordinary PATH/runtime environment. Credentials must not enter traced output. Do not change normal agent shell authentication.

- [ ] **Write failing scope/boundary tests.** Both route wrappers pass the exact server-owned repository ID. Clone/fetch/ref inspection request read-only scope; publication requests write. Mismatched origin or receipt repository fails before token minting. Fake tokens never appear in args, remotes, local config, receipts, HTTP errors or logs. A repo pre-push hook/credential helper receives no invocation with credentials. Hostile inherited Git overrides, URL rewrite, alternate push URLs and local transport overrides are rejected/neutralized. Existing read-only Project source behavior remains read-only.
- [ ] **Run red:** `node scripts/run-tests.mjs tests/project_git_auth.test.ts tests/studio_github_read_scope.test.ts tests/project_github_access.test.ts tests/project_cp_routes.test.ts tests/project_task_workspace_routes.test.ts`.
- [ ] **Implement the controlled environment.** Use `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`; empty credential helper, `core.hooksPath=/dev/null`, `http.followRedirects=false`, no recursive submodules and HTTPS-only token-bearing transport. Reset inherited extra-header config and scope the new Authorization header to the validated GitHub repository URL. Keep TLS verification enabled. Use the same token-free environment for origin validation and the token-bearing operation. This is not a same-user filesystem sandbox.
- [ ] **Validate repository-local transport before credentials.** Read local effective config with includes into memory without logging values. Reject `url.*.insteadOf`, `url.*.pushInsteadOf`, `remote.*.vcs`, `remote.*.proxy`, `remote.*.uploadpack`, `remote.*.receivepack`, `core.gitProxy`, repository-local `http.*` transport overrides and include/includeIf directives for this server-owned path. Reject unsupported local transport customization with a fixed message; never rewrite it silently. Fetch URL and every push URL must equal the Project's fixed GitHub clone URL. Ordinary core repository/branch/user settings remain valid; hooks/helpers are disabled by command scope. Keep token-free local Git fixture support separate from production HTTPS authentication.
- [ ] **Apply scope and safe errors.** `tokenFor` receives operation intent and always forwards `providerRepositoryId`/readOnly. Preserve the read-only broker's cancellation and access rechecks. Convert Git failures to reviewed codes (conflict, permission upgrade, unavailable, unconfirmed) and fixed messages; raw stderr may contain credentials or hostile hook text and must not reach clients. Retain existing actionable Workflows permission upgrade behavior.
- [ ] **Run green:** repeat focused tests and `node scripts/run-tests.mjs tests/studio_github_manifest_gateway.test.ts tests/studio_github_credentials.test.ts tests/project_empty_repository.test.ts tests/project_publication_recovery.test.ts tests/project_baseline_identity.test.ts`.
- [ ] **Record checkpoint:** `fix: scope and harden Project GitHub credentials`.

## Task G3: Honest publication and baseline-sync UX

**Files:** Modify `client/src/components/TaskCommitPushModal.tsx`, `client/src/components/ProjectDetailPage.tsx`, `client/src/components/TaskChat.tsx` where its shortcut surfaces a receipt, `client/src/lib/api.ts`, `docs/project-task-workspaces.md`, `docs/coding-harness.md`. Create `tests/project_publication_ui.test.ts`; extend `tests/projects_ui.test.ts`, `tests/project_sync_ui.test.ts` and route tests as needed.

**Client interfaces:** `retryProjectPublication(projectId, taskId, publicationId)` and `abandonProjectPublication(projectId, taskId, publicationId)` use G1's exact routes and typed responses. Keep `deployToDefaultBranch` as a backwards-compatible API field, while changing user-facing wording.

- [ ] **Write failing UI tests.** Every newly opened publication dialog defaults to task branch, even after a prior default-branch push or Project/task switch. Success contains Pushed, SHA and branch, and never Deployed/Dokploy/build-success claims. A pending receipt shows its original target(s), disables replacement message/target selection, and Resume publication passes only its ID. Abandon confirmation explicitly says it does not undo GitHub changes. Sync copy explains future-task baseline; test that sync does not modify current task files/verification evidence.
- [ ] **Run red:** `node scripts/run-tests.mjs tests/project_publication_ui.test.ts tests/projects_ui.test.ts tests/project_sync_ui.test.ts tests/project_sync_routes.test.ts`.
- [ ] **Implement exact copy.** Checkbox off by default: Also push to `<defaultBranch>`. Explanation: Your deployment service may build this branch. Olympus does not verify deployment. Buttons: Commit & Push, Resume publication, Stop retrying this publication. Success: Pushed `<short SHA>` to `<branch>`. Pending: GitHub publication could not be confirmed. Resume the saved commit to `<branches>`. Confirming abandonment preserves commit/files/receipt and never uses reset. Apply in both interfaces, not only the modal.
- [ ] **Explain sync without changing its semantics.** Next to Sync latest from GitHub: Downloads the starting point for new tasks. Existing task branches and files stay unchanged. Keep recorded last-successful sync evidence distinct from a current connectivity promise. No deployment watcher or PR subsystem is added.
- [ ] **Run green and browser QA:** repeat tests; exercise both publication entry points in a disposable fake-gateway fixture for successful push, unknown outcome, reload/resume, conflict, and abandon. Verify drafts and unsaved files survive. Run `npm run typecheck` and `npm run build` after integration.
- [ ] **Record checkpoint:** `fix: distinguish GitHub publication from deployment`.

## Regression assertion examples

Implement these inside the real-local-Git and UI fixtures described above. Simulate the lost acknowledgement only after the bare remote has actually accepted the push.

```ts
// project_publication_recovery.test.ts: accepted_push_lost_response_reuses_exact_commit
assert.equal(await git(workdir, 'rev-parse', 'HEAD'), originallyPushedSha);
assert.equal((await service.retryPublication(retryInput)).commitSha, originallyPushedSha);
assert.equal(listProjectVersions(project.id).length, 1);
assert.equal(await git(remoteDir, 'rev-parse', taskRef), originallyPushedSha);

// project_publication_ui.test.ts: push_is_not_deployment_evidence
assert.match(successText, /Pushed/);
assert.doesNotMatch(successText, /Deployed|Successfully.*deployed|Dokploy build/);
```

## Completion checkpoint

Run the shared V1 gate. The implementation must not perform a live GitHub push or server deployment to demonstrate these fixes. An authorized later pilot should separately validate real GitHub permissions, branch protection and network behavior.
