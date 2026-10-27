# Stopped and unchanged repository handoffs

## Reported failures

- A user-stopped task retained repository ownership indefinitely, even after its native work ended.
- Every managed repository turn forced project checks. Two information-only conversations made no source changes but were held by unrelated environment failures.
- Every handoff error was replaced with the same vague message, including on the owner itself (incorrectly described as the “previous task”).

## Changes

- Release explicitly stopped owners only under the task operation claim, after fresh native inventory proves no active work, with a fresh run/stop/request check. Retain files, commits, task status, history and the native stopped checkpoint. Do not accept unfinished source.
- Recognize Hermes's retained user-stop marker only with its saved continuation receipt and no active native work. Apply the same rule when admitting the next task; unknown inventory and other blocked continuations still fail closed.
- Ordinary no-change conversations may skip unrelated checks. Publication, explicit check requests and verification repairs retain their checks. A clean unchanged conversation can release only at its original workspace baseline or the already accepted commit; it never advances shared source.
- Show specific, safe handoff causes and the preceding task's name. Waiting cards say the request is saved and starts automatically. Never expose raw Git errors.

## Regression evidence

Observed red before each fix, green afterward:

- `repository_queue_stopped.test.ts`: idle stopped owner and legacy exact-run stop release; native work, missing inventory/receipt, non-stopped pending results, new messages and resumed runs preserve ownership; the next admission also succeeds with the retained stop marker.
- `repository_development.test.ts`: real Git commits and unfinished files survive stop; successors start at accepted code. Unchanged conversations, follow-ups after acceptance and refreshed tasks use accepted code without checks or new source acceptance. Unverified commits remain blocked.
- `repository_conversation.test.ts`: actual HTTP chat admission and completion with an external agent stub; information-only turns reach review and release, while an explicit failing test request remains blocked with the specific cause.
- Existing queued publication regressions continue to enforce exact checked source and publication intent.

Full local suite, typecheck and production build passed before review. Review identified the retained native stop marker and refreshed-task cases; both received additional red/green regressions and final targeted validation. Release CI reruns the full suite, build and upgrade/rollback checks.

## Production correction and verification

The two historical no-code conversations require a scoped correction, not a general rewrite of old failures. During guarded idle maintenance: back up every selected database and configuration, retain the original failed evidence, confirm exact run IDs, clean workspaces, original baseline fingerprints, no pending messages/interactions or native work, then use existing verification/completion methods to record that checks were unnecessary and move the completed conversations to review. No code is changed or accepted by that correction; failed checks are not called passing.

After ordinary deployment, verify the stopped task no longer owns the repository, both corrected tasks have no queue blocker, and a private live fixture can wait behind a stopped task then start from the last accepted code while the stopped task's unfinished files remain intact. Preserve all test evidence and leave unrelated active work alone. Runtime verification is recorded separately after deployment; local tests alone do not establish it.
