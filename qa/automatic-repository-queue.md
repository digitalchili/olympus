# Automatic repository queue

## Behavior

Tasks with write access to one linked GitHub repository share a durable FIFO across Projects and profiles. The next saved request starts automatically after the previous task's native work finishes and its exact source passes required checks. Task clones remain independent; accepted development commits stay in the installation's persistent storage. GitHub publication and production deployment remain explicit actions.

Cards name the task they are waiting for. The task page explains that the request is saved and will start automatically. Failures preserve work and hold the queue. Marking a held task Complete cancels its unstarted request; ordinary approval is not required for successful handoff.

## Verification

- Real SQLite tests: canonical repository ownership, FIFO, independent repositories, restart persistence, exact-run ownership and rejection of stale releases.
- Real Git tests: exact accepted source inherited by the next task, unchecked changes excluded, remote main unchanged, current upstream included in the recorded starting SHA, retained task reopening and preservation of unfinished Git operations.
- HTTP tests: a held task saves its request without preparing a stale clone or starting an agent; stale request IDs cannot replace messages. Failure and service reconstruction retain ownership. Deletion requires verified native idle; reconnection is blocked while requests exist; Complete cancels held work.
- Subprocess tests: a live old process retains its OS lock; another process cannot acquire it until exit. A busy lock prevents AIAgent invocation. Different repositories remain independent.
- Existing publication regression: exact saved publication intent is preserved. Its publication protocol commits first; the confirmed commit is checked before automatic handoff. No extra agent turn is required.
- Browser fixture: actual TaskCard and RepositoryQueueNotice render running, waiting and blocked states. The waiting card names its predecessor and the detailed notice explains automatic start. The fixture made no model or production requests and was removed afterward.

Final verification on Node 22.22.3, 27 October 2026:

- `npm test` — passed the complete Python and TypeScript suite, including existing deletion, publication and recovery behavior.
- `npm run typecheck` — passed.
- `npm run build` — passed; Vite reports its existing large-chunk advisory.
- `git diff --check` — passed.

The full suite exposed a deletion regression during goal setup: the new repository ownership check had been applied to ordinary tasks before their existing cancellation settled. The guard now applies only to repository owners after cancellation; both existing task-deletion tests and the new queue lifecycle tests pass.

Tests use disposable local state. These checks do not claim live deployment or a production worker-restart exercise.

## Independent review

A fresh reviewer identified five important lifecycle issues: publication fingerprint invalidation, orphaned ownership after deletion, queue entries stranded by repository reconnection, native empty-journal inventory, and held requests starting after being marked Complete. All were accepted and addressed with regression coverage. No second review was commissioned.

## Boundary

The initial policy serializes all write-capable linked task work, including research in that checkout, because a research label does not restrict tools. Separate repositories and unlinked conversations remain concurrent. Normal tools, delegation and native completion behavior remain available. The queue does not coordinate arbitrary writers outside this Olympus installation.
