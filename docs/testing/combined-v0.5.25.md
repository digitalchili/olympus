# v0.5.25 combined integration verification

This release combines the v0.5.24 reliability fixes, deadline-aware task finalization, and native question forms / large-paste attachments. Unfinished follow-on features in the Hermes core roadmap are not included.

## Integration correction

Human input pauses activity/runtime accounting but cannot extend the absolute run ceiling. The server watchdog caps pending waits by the hard deadline. The worker fixes a monotonic deadline before bootstrap and passes it to both clarification and approval callbacks. The broker caps displayed expiry and response acceptance and denies a response that resumes after the run deadline.

Hermes's native multi-question protocol uses generated `qid` values on the callback wire and restores model-supplied `id` values in its result. The native integration test explicitly verifies the original semantic IDs survive; no alternative wire format was introduced.

## Executed verification

- Clean `npm ci --include=dev`.
- `npm audit --omit=dev --audit-level=high`: passed the release gate; five moderate advisories remain in the existing dependency tree.
- Full `npm test`, typecheck, production build, package dry-run, and `git diff --check`: passed after the correction.
- Six opt-in native Hermes interaction tests: passed, including real approval denial at the hard deadline and stable semantic question IDs.
- Thirteen worker-broker tests: passed, including already-expired runs and late approval/clarification rejection.
- Disposable Chromium/native-Hermes browser QA: passed desktop and 320px mobile forms, reload, exact UTF-8 attachment persistence, preview, Keep inline, retry/removal, New Task creation, and stop handling.
- Added-line credential-pattern scan: no unreviewed matches. The sole match was verified as the deliberately synthetic alphabet/digit redaction-test key.
- Independent GPT-5.5 source review identified the deadline integration defect; bounded re-review after correction found no remaining high/medium blockers.

The native browser fixture substitutes a deterministic model endpoint; it verifies real UI/API/worker plumbing, not live-provider judgment. Verification used disposable state and did not update a running installation or live profile. GitHub CI, release, and image publication are separate delivery gates.
