# Attachment steering — 2026-10-05

The steer route returned HTTP 200 with `steered: false` for every message ending in an attachment footer, without asking Hermes. The client silently retained the queue. Large pasted reviews also hit this path because the composer uploads them as text attachments.

The fix preserves the complete message, including uploaded file paths, and forwards it through Hermes's existing native steering boundary. It does not interrupt tools. The queue shows progress during the request and explains when Hermes declines and the update remains saved for the next response.

Verification:

- The route test failed before the fix and passed afterward. It covers pasted documents, images, audio, plain text, named-profile isolation, active-run preservation, declined-steer queue preservation, and completion races.
- The production composer test reproduced missing feedback before the fix. It now covers in-flight status, explicit decline feedback, accepted queue removal, normal follow-up after a 409, visible failures, and no stale notice on a new queued message.
- Browser QA used `tests/fixtures/steering-server.ts` with the production build, real routes and SQLite queue, and a fake Hermes adapter. An accepted update reached the adapter exactly once with its file path intact, appeared with its attachment in chat, consumed the saved queue, and left the run streaming. A declined update showed the explanation, remained queued after reload, and did not appear as delivered.
- Full `npm test`, `npm run typecheck`, `npm run build`, `npm run lint:shell`, `npm audit --omit=dev`, and `git diff --check` passed. Twenty-four environment-dependent Python checks were skipped locally. The build retained its existing large-chunk advisory.
- Independent review found no actionable issues. Native model interpretation of attachment contents was not exercised; the worker's existing steering and final-boundary fallback tests passed.

Ignored local browser screenshots: `.tmp-native-qa-steering/accepted.jpg` and `.tmp-native-qa-steering/declined.jpg`.

Read-only inspection found the reported live installation running 0.7.24. The screenshot's queued message had already cleared, so its exact payload could not be confirmed. No live task was steered and no installation was updated or restarted.

## Late delivery at native finalization — 2026-10-05

A separate failure remained when a steer arrived during the final model response. The pinned Hermes runtime drains it into `run_conversation()`'s `pending_steer` result. Olympus read only the agent's already-empty queue, so no follow-up ran. Its drain wrapper also persisted a display-only receipt even for that undelivered message; replay correctly excluded the receipt, leaving the agent with the older attachment.

The worker now forwards native pending messages, plus any later accepted steer, through the existing `pendingSteer` continuation contract. Pending messages survive intermediate child-result continuations. Collaboration continues only the chair, without repeating contributor work. A failed continuation returns the pending message on its terminal error and saves it in the existing durable queue, preserving newer queued content and requiring explicit retry. Explicit Stop still ends work. Native Hermes owns the persisted applied-steer row; Olympus no longer treats a queue drain as evidence of delivery. Display projection unwraps the native marker while preserving the attachment footer, and model replay keeps its native steering provenance.

Regression coverage includes the native finalizer result with an image footer (failed before the fix), a second late acceptance, successful/failed child-result continuation, explicit Stop, and real Task/Goal/collaboration routes continuing exactly once before review. Worker error transport and durable queue restoration cover failed delivery, including a newer queued request. An optional native test exercises the pinned Hermes steering helper, SQLite persistence, full/paged display, and model replay without invoking a model:

```sh
OLYMPUS_NATIVE_HERMES_SOURCE=/path/to/hermes-agent /path/to/hermes-python tests/test_steering_native.py
```

The reported live conversation was inspected read-only. Its steered image receipt appeared immediately after the completed answer, and the next reply referred to the earlier screenshot. A later ordinary resend produced a response about the new Preview Config screenshot. No live task, transcript, or installation was changed.

Final validation: `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, and the explicit native test against pinned Hermes 0.21.5 passed. The regular suite retains optional environment-dependent skips; the native steering test was run separately with the installed Hermes venv. Independent review found no remaining actionable issues after the collaboration, failed-continuation, and duplicate-queue regressions were fixed. Model interpretation of image pixels was not exercised.
