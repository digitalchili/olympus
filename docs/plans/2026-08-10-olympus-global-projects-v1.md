# Olympus Global Projects v1 Implementation Plan

> **For Hermes:** Implement this plan as test-first vertical slices. Preserve the existing GitHub onboarding until its Settings migration is verified. Do not merge or deploy outside the protected preview without Michael's approval.

**Goal:** Replace the repository-centric Studio prototype with Olympus-wide, ACL-scoped Projects that have a replaceable manager profile, Project-owned tasks/references/repository metadata, genuinely routed cross-profile discussion, and collision-safe execution.

**Architecture:** A Project is a global durable object in the Olympus installation. It is not contained by the active profile. Exactly one profile is the accountable manager at a time, with immutable manager history. Tasks point to a nullable Project and snapshot their handler. Repository connections and uploaded references are separate Project resources. Profile invitations are explicit, bounded capabilities and never change Project management.

**Tech Stack:** Express, SQLite/better-sqlite3, React/Vite, TypeScript, existing Hermes profile adapter, GitHub App gateway, multipart uploads, isolated executor/worktree primitives, assertion-script test suite.

---

## Product contract

### Information architecture

- `+ New task` is an action.
- `Inbox` is the set of tasks where `project_id IS NULL`.
- `Projects` are durable work locations visible independently of the active profile.
- `Channels` are cross-location communication views; they never own or copy tasks.
- Profiles are accountable managers or invited participants, not data containers.
- Delegated workers execute bounded work; they do not become Project managers.

### Project management

- Project creation requires `name`, `purpose`, and `managerProfileId`.
- A Project task derives its handler from the current Project manager; the client cannot override it.
- An Inbox task requires an explicit handler profile in the new UI. Legacy clients may continue to use the requested active profile during compatibility migration.
- Manager reassignment affects new tasks only by default.
- Existing tasks retain their handler snapshot.
- Active-task transfer is a separate operation and cannot be implemented until task leases exist.
- Manager changes retain an audit history.
- Changing manager may also change model/provider, skills, rules, memory boundary, and execution policy; the UI must show that consequence.

### Access and privacy

- Global means globally addressable inside Olympus, not globally readable by arbitrary profiles.
- Olympus v1 is a single-human-operator application protected outside the app; it has no internal user-account identity. Do not claim per-human authorization until internal authentication exists.
- Browser Project administration is installation-operator access.
- Profile access is explicit: the manager has implicit `manage`; other profile grants are `view`, `contribute`, or `manage`.
- Agent-side Project context retrieval must check the profile grant independently of browser visibility.
- A discussion-only profile invitation receives a bounded projection of visible task messages and explicitly selected references. It receives no repository credential, attachment path, hidden reasoning, profile session, or unrelated Project document.
- If an invited profile fails, Olympus reports that failure and never substitutes another profile under its identity.

### Resource ownership

- Project owns tasks, references, extracted text, citations, decisions, repository association, activity, and approvals.
- The Olympus installation owns encrypted GitHub App configuration and reusable GitHub installation connections.
- A Project may link one repository in v1; the schema must not place Project identity inside repository metadata.
- Installation and user tokens are minted temporarily and never stored or returned to the browser.
- Executors receive temporary task/repository capabilities only.

### Concurrency

- Repository mutation is allowed only in a task-specific branch/worktree.
- Server-side leases and queues enforce collision protection.
- Warnings in the UI are not locks.
- Direct push to the default/protected branch is forbidden.
- Merge and production deployment remain separate approval operations.

---

## Canonical records

### `projects`

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `purpose TEXT NOT NULL`
- `manager_profile_id TEXT NOT NULL`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`
- unique normalized project name for active records in v1

### `project_manager_history`

- `id TEXT PRIMARY KEY`
- `project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE`
- `profile_id TEXT NOT NULL`
- `effective_from INTEGER NOT NULL`
- `effective_to INTEGER`
- `changed_by TEXT NOT NULL`
- at most one open interval per Project

### `project_profile_grants`

- `project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE`
- `profile_id TEXT NOT NULL`
- `role TEXT NOT NULL CHECK(role IN ('view','contribute','manage'))`
- timestamps and granting actor
- manager access is implicit and does not require a duplicate grant row

### `tasks` compatibility migration

Add:

- `project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`
- `handling_profile_id TEXT`
- `delegated_worker_id TEXT`

Backfill `handling_profile_id = COALESCE(profile_name, 'default')`. During v1 compatibility, every task insert/update writes `handling_profile_id` and legacy `profile_name` together. Existing profile-isolation routes remain enforced by the handler snapshot until they can be renamed without breaking clients.

### `project_repository_links`

- one row per Project in v1
- references a reusable GitHub installation connection
- stores repository identity and non-secret checkout metadata
- migrates current `studio_projects` repository records without deleting the compatibility source in the first slice

### References and execution records

Later slices add:

- `project_references`
- `project_reference_versions`
- `project_reference_chunks`
- `project_discussion_grants` only if persistent task participation is required; one-shot discussion invitations remain collaboration-run scoped
- `project_task_leases`
- `project_task_queue`
- `task_workspaces`
- immutable evidence and approval records

---

## Slice 1 — Global Projects and manager history

### Task 1.1: Schema and migration contract

**Files:**
- Modify: `server/db/schema.sql`
- Modify: `server/db/index.ts`
- Create: `server/db/projects.ts`
- Modify: `shared/types.ts`
- Test: `tests/projects_schema_migration.test.ts`
- Test: `tests/projects_model.test.ts`

**TDD:**
1. Write a migration test that starts from the pre-Projects schema and inserts legacy tasks and `studio_projects` rows.
2. Verify it fails because canonical tables/columns do not exist.
3. Add tables, indexes, compatibility columns, task handler backfill, and idempotent Studio repository migration.
4. Test manager history has exactly one open interval and repository identity remains separate.

### Task 1.2: Project API and profile authorization primitives

**Files:**
- Create: `server/routes/projects.ts`
- Modify: `server/app.ts`
- Create: `server/project-access.ts`
- Test: `tests/projects_routes.test.ts`
- Test: `tests/project_access.test.ts`

**Endpoints:**
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:id`
- `PATCH /api/projects/:id`
- `POST /api/projects/:id/reassign`
- `GET /api/projects/:id/tasks`

**Rules:**
- Validate manager against the active local profile registry.
- Reassignment is transactional and future-only.
- Return manager display/model/provider projection without exposing profile files.
- Project profile context helpers fail closed without manager or grant access.

### Task 1.3: Task relationship and routing

**Files:**
- Modify: `server/db/queries.ts`
- Modify: `server/routes/tasks.ts`
- Modify: `server/profile-context.ts`
- Modify: `shared/types.ts`
- Modify: `client/src/lib/api.ts`
- Test: `tests/project_task_routing.test.ts`
- Update: `tests/profile_task_isolation.test.ts`

**Rules:**
- `projectId` supplied: server derives current manager and ignores/rejects conflicting handler input.
- `projectId` absent: explicit `handlingProfileId` is accepted; legacy omission uses the requested profile during migration.
- Existing tasks keep their handler after Project reassignment.
- Project task listing is installation-operator scoped; actual task execution remains handler-profile scoped.

### Task 1.4: Projects UI and New Task location

**Files:**
- Create: `client/src/components/ProjectsPage.tsx`
- Create: `client/src/components/ProjectDetailPage.tsx`
- Modify: `client/src/components/NewTaskPage.tsx`
- Modify: `client/src/components/Sidebar.tsx`
- Modify: `client/src/App.tsx`
- Keep `/studio` as a compatibility redirect until GitHub moves to Settings.
- Test: `tests/projects_ui.test.ts`

**UX:**
- Global Projects index does not change when active profile changes.
- Create Project uses `Name`, `Purpose`, and required `Managed by`.
- Project detail shows manager, model/provider, grouped tasks, references placeholder, repository status, and settings.
- Reassignment review explicitly says new tasks only and offers previous-manager grant handling.
- New Project task shows derived handler without a profile selector.
- New Inbox task requires `Handled by`.

---

## Slice 2 — Scoped cross-profile Project discussion

**Reuse:** Existing `collaboration_runs`, `collaboration_contributions`, `ProfileAgentAdapter`, bounded transcript projection, visible attribution, and private-event filtering.

**Add:**
- Project/task access check before assembling any Project reference context.
- Default invitation scope `discussion`.
- Explicit confirmation for persistent `task` or `project` grants.
- Visible participant and failure records in the task timeline.
- No manager/handler/delegated-worker mutation from a mention.

**Tests:**
- genuine invited profile adapter invocation;
- manager unchanged after contribution;
- bounded context excludes unrelated Project references and credentials;
- inaccessible Project reference selection fails closed;
- failed profile is not impersonated.

---

## Slice 3 — Project References

**Initial formats:** PDF, DOCX, plain text/Markdown, CSV, XLSX, PNG/JPEG scans.

**Pipeline:**
1. stream upload to a Project-scoped quarantine path;
2. enforce allowlist, byte limit, extension/MIME agreement, safe filename, and archive limits;
3. hash and preserve immutable original;
4. extract text in an isolated worker with timeout/resource limit;
5. OCR images/scanned pages when a configured local OCR provider exists;
6. chunk with page/sheet/cell provenance;
7. index into the configured Project-scoped retrieval backend;
8. expose citations and deletion/reindex lifecycle.

**Preview rule:** Use synthetic documents only. Disposable preview storage is not durable staging.

---

## Slice 4 — GitHub Connections in Settings

- Move connect/manage UI from Projects to Settings.
- Support all verified GitHub App installation connections; no hardcoded limit.
- Project creation/editing optionally selects one repository from one connection.
- Preserve current encrypted manifest-created App configuration and state/cookie security.
- Remove single-repository auto-import as a Project creation side effect.
- Increase App permissions only in the reviewed write-capability slice.
- Every write is branch/PR scoped; no default-branch push or merge authority in executor tokens.

---

## Slice 5 — Isolated execution, leases, and queues

- Reconcile with the existing repository-overlap guard work before implementation.
- Use server transactions to acquire leases by Project/repository and conflicting path scope.
- Queue conflicting tasks fairly and display queue state.
- Create a recorded task branch/worktree from immutable base SHA.
- Recover expired/interrupted leases safely after restart.
- Provide explicit active-task transfer only after lease ownership can be transferred or released safely.
- Record verification, branch, PR, artifacts, approvals, and cleanup evidence.

---

## Verification and delivery gates

For every vertical slice:

1. Observe the targeted regression test fail for the intended missing behavior.
2. Implement the smallest coherent slice.
3. Run targeted tests.
4. Run `npm test` in an isolated temporary Olympus root.
5. Run `npm run typecheck` and `npm run build`.
6. Run `git diff --check` and inspect status/diff for secrets and unrelated edits.
7. Obtain independent spec and security/quality reviews.
8. Run browser checks for desktop/mobile, disabled/error/empty states, and console failures.
9. Push only to `feat/studio-control-plane` and verify CI.
10. Overwrite only the existing protected preview and verify its live URL.
11. Do not merge, modify production data, or deploy production without separate approval.

## Current assumptions and non-goals

- The current application is single-human-operator. Multi-user account authorization is not fabricated in this v1.
- The active profile does not filter the global Projects index.
- Existing GitHub read-only onboarding remains operational until the Settings migration is complete.
- Existing profile-private Files/Skills/Channels behavior remains unchanged.
- Project deletion, archival, boards, milestones, nested Projects, issue synchronization, production deployment, and autonomous merge are outside the first global-Projects slice.
