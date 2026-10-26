# Automatic repository task handoff

Goal: A user sends tasks normally. Tasks sharing a linked repository run in order, automatically handing checked development source to the next task. Cards explain exactly why a task is waiting.

Architecture: Reuse saved task messages, isolated clones, native background inventory and coding verification. Add durable repository ownership and a local development branch. No new scheduler or task type picker. Repository tasks share a queue regardless of profile or Project; unlinked tasks remain independent. Existing work is preserved. The first release conservatively queues every task with write access to a linked repository: a research label does not enforce read-only tools.

Tech Stack: SQLite, TypeScript/Express, Git, React.

Spec: User directions in this conversation: automatic/no input, one writer per repository, checked integrated handoff, simple waiting explanations, preserve normal tools/delegation/active work.

Global Constraints: No production mutation. No force push. No changes to main or remote deployment branches. Development checkpoints remain in the installation's persistent storage; publication remains an explicit action. No lease timeout permits another writer. Unknown background work and unsuccessful runs retain ownership. New development source is accepted only after passing same-source checks. Existing unmanaged active work must clear before admission. Do not rewrite old task folders or migrate old unfinished changes automatically.

Review Focus: Concurrency, durable ownership across restart, exact source handoff, queue persistence, failure visibility, no lost queued requests, no accidental production publication.

### Task 1: Durable ownership and status
Files: server/db/repository-queue.ts, server/db/schema.sql, shared/types.ts, server/db/queries.ts, tests/repository_queue.test.ts.
Interfaces: claim by canonical repository identity; persist owner and run ID; release only matching ownership; project plain-language status into Task.
Steps: Write real SQLite tests for simultaneous claims, independent repositories, restart persistence and stale release; run and observe failure. Implement minimum tables and functions. Run tests again.
Expected: exactly one owner, queued order stable, stale owner cannot release a replacement, readable waiting labels.

### Task 2: Checked development source
Files: server/repository-development.ts, server/project-cp.ts, tests/repository_development.test.ts.
Interfaces: prepare task from accepted local development SHA; checkpoint before verification; accept only exact verified commit and clean tree.
Steps: Write real Git tests proving B includes A, failed checks never advance accepted source, main stays unchanged, old work remains intact. Observe failures, implement, rerun.
Expected: exact handoff recorded with no remote mutation; source changes and divergence block safely.

### Task 3: Admission and automatic continuation
Files: server/repository-queue.ts, server/routes/project-task-workspace.ts, server/routes/chat.ts, server/index.ts, server/app.ts, tests/repository_queue_routes.test.ts.
Interfaces: save and return queued requests before workspace preparation; hold owner through native inventory and verification; poll durable queue, accept successful source then wake next task; resume same owner through normal recovery.
Steps: Write admission/lifecycle tests covering two tasks, failures, unknown/active native work, restart and retry; implement and run.
Expected: no agent run or clone for a held task; automatic start after safe handoff; no replay of completed work.

### Task 4: Plain-language UI and delivery
Files: client/src/components/TaskCard.tsx, TaskDetailPage.tsx, client/src/hooks/useChat.ts, docs/project-task-workspaces.md, tests/repository_queue_ui.test.ts.
Steps: Test queued response handling and rendered waiting/blocked notices; implement. Run focused and full suite, typecheck and build, then whole-branch independent review. Fix material findings with regression tests. Record verification and limitations.
Expected: held task says Waiting for [task] to finish, starts automatically, failure explains that previous work needs attention. No technical branch controls required in normal flow.
