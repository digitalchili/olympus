# Inbox

Open **Inbox** in the sidebar (keyboard: **G**, then **I**) to see tasks needing attention across the active profiles on this installation. The sidebar count is outstanding work, including results you have already viewed. Filter by profile or Project to narrow the list.

- **Questions & approvals**: an agent is waiting for a response in its current run.
- **Ready for review**: tasks on the existing review board.
- **Needs help**: unfinished or stopped runs, uncertain response delivery, or recovery waiting on human input.

Select an item to preview its question or latest saved reply, then open the original task to respond, review, or recover it. Opening a preview does not mark anything read, grant permission, retry work or complete a task. The task's existing controls remain authoritative. Items disappear when their underlying state is resolved. Lists refresh every ten seconds while visible, and on focus or manual refresh.

Normal running tasks, Bots, completed tasks and automatic recovery without a human blocker stay out of the Inbox. There is no elapsed-time rule that declares work stuck. A refresh failure is shown explicitly instead of claiming the Inbox is empty.

## Implementation contract

`GET /api/inbox` is an installation-wide, read-only projection for Olympus's trusted local operator, similar to profile attention counts. Each Project task is included only if its handling profile still has Project access. Inactive and deleting profiles are excluded. It does not load histories, call a model or inspect repository files during polling.

`GET /api/inbox/:taskId?key=…` loads a preview on selection. It revalidates profile, Project access and attention identity after awaiting Hermes history. Questions must match the current live run; replies are labelled as the latest saved reply, not proof of successful completion. Local artifact links use the task's explicit profile. All mutation and approval checks stay in the existing task routes.

## Verification

Automated coverage: `tests/inbox_routes.test.ts`, `tests/task_run_snapshot.test.ts` and `tests/markdown_downloads.test.ts`.

For repeatable browser QA without real Hermes state or model calls, run `node --import tsx tests/fixtures/inbox_ui_server.ts` and open `http://127.0.0.1:4195/inbox?profile=default`. The fixture creates a temporary database and three profiles, uses the real API/UI, and substitutes saved Hermes replies. Stop it with SIGTERM to remove its temporary state.
