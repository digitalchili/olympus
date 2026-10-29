# Waiting task board status

A new request saved behind another repository task is unfinished work. Move its card to In Progress immediately, including when the card was in review or complete. Queue reconciliation also corrects waiting cards saved by older releases. Preserve the saved request and the existing explanation naming the task it is waiting for.

The small queue notification change excludes publication-only requests, the owning task, and completed tasks without new requests. It does not change admission, execution, verification, or release ownership.

## Verification

- Regression failed before the fix: expected `in_progress`, received `in_review` for a saved waiting request.
- Admission response and persistent task status now agree. Reconciliation preserves the exact queued request ID.
- Coverage includes a new request on a completed task, a legacy waiting card, unchanged queue owner, and an untouched completed task.
- Targeted queue route, lifecycle, stopped-owner, UI, and queued-publication tests passed.
- Full `npm test`, `npm run typecheck`, and `npm run build` passed with Node 22.22.3.
- Independent review found no issues.

Production deployment and actual Olympus UI verification are tracked separately; these local checks do not establish deployment.
