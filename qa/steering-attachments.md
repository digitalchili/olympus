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
