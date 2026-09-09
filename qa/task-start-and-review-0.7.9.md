# Task startup and review status — v0.7.9

New Task now stores the initial request and task atomically, then starts the saved request through server queue dispatch. Navigation no longer owns startup. Requests retain profile, mode, model settings, attachments and collaboration invites. Older empty tasks show their saved description with a draft recovery action.

The profile menu gives names their own line, so the Default badge, review count and selection mark cannot squeeze Somboon into an abbreviation.

The Continue prompt requests verification of work from earlier turns. Successful conversational turns on unchanged clean source enter review without claiming skipped checks passed. Unverified changes retain their check requirement with a visible reason and Run checks action.

## Regression evidence

- `tests/task_start.test.ts`: initial request exists before the creation response; server dispatch works without browser startup; exactly one run; invalid input creates no task; queue write failure rolls back task creation.
- `tests/project_task_workspace_queued_claim.test.ts`: queue remains durable during asynchronous Project preparation; failed preparation preserves a concurrent replacement.
- `tests/verification_lifecycle.test.ts`: exact built-in Continue prompt verifies existing changes and enters review; clean greeting and standalone output enter review with skipped checks; dirty read-only work retains its verification requirement.
- `tests/verification_request.test.ts` and `tests/run_failure_presentation.test.ts`: explicit remaining-check requests and truthful terminal status labels.

## Browser verification

Run `node scripts/run-tests.mjs tests/fixtures/task-start-ui-server.ts` for the disposable real-route fixture on port 4181. It uses temporary state and fake Hermes, without calling a model provider.

Verified in the browser:

1. Submit a Som task, navigate away immediately after creation, return: original prompt and response remain, task is in review, queue is empty, run starts once.
2. Create a Goal containing `fail goal`: asynchronous setup fails after consuming the queue; the restored request appears with retry/edit controls and no agent execution.
3. Open an older empty task: Use original request fills the composer without sending automatically or replacing an existing draft.
4. Open the profile picker with Somboon selected and one review notification: the full name, Default badge, count and checkmark remain visible in the 186-pixel row.
5. Project a skipped check result with existing changes: Verification needed and Run checks are visible without opening a hidden disclosure. This panel check uses fixture response data.
6. Running activity spans the full header content width with equal 24-pixel desktop padding. During startup, the empty chat says it is waiting for the first response.

These checks validate source behavior and local UI; release image publication and installation upgrades are separate operations.
