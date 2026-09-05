# Task question forms and pasted text — bounded implementation slice

## Authority and scope

Michael requested Codex-like question forms inside a task and large pasted text saved as an attachment. Implement, test, and independently review. No push, release, deployment, or changes to live profiles. Other Hermes 0.21 roadmap lanes remain separate and unfinished.

## Design

Extend Olympus's existing zinc/light-dark palette, typography, border radii and compact task progress. Group one to five questions in one task card, with clear question legends, radio/checkbox options, Other/free-text fields and a single Submit answers button. The waiting state is explicit; partial responses cannot submit. No decorative gradients or new icon/font packages. Mobile must wrap without horizontal overflow; native labels, visible focus, live error status and keyboard-operable previews are required.

Long pasted text is a text document, not a huge composer value. Default conversion: at least 4,000 characters OR 50 lines. A compact document chip uses a first-line preview and line/size metadata. Preview, remove and Keep inline preserve user control. Small text and existing image/file paste remain unchanged. New Task and existing-task chat share the implementation. Existing typed text is preserved. The exact UTF-8 paste is uploaded through the existing workspace attachment API, retained after sending/queueing, and readable/downloadable from history. No filesystem-root widening or Project-reference reclassification.

## Acceptance gates

- Actual native clarify handler and Olympus worker JSONL suspend until the exact task/run/form receives complete answers; returned single/multiple/free-text values match the response.
- Pending request survives browser reload. Stop, expiry, server/worker loss and stale/replayed/cross-profile answers cannot silently continue or grant approval.
- Approval requests, if native policy emits one, allow once or deny only; no permanent/session grants.
- Durable database response claim prevents double submission. Lost acknowledgment is not an automatic retry.
- Form awaiting input does not trigger the provider-idle watchdog or promote a task to review.
- Paste thresholds, Unicode/newlines, empty/small paste, existing text, failed upload, retry/removal, Keep inline, queued sends, navigation and persisted history are exercised.
- Full tests, typecheck, production build, built native worker smoke, real Chromium desktop/mobile browser QA, independent review, then repairs/retest as needed.

## Verification boundaries

Disposable HOME/HERMES_HOME/Olympus state only; provider credentials are not inherited. Native-runtime QA may substitute a clearly labelled deterministic loopback model endpoint, while exercising the real AIAgent, native tool, worker JSONL, routes, database and frontend. This proves plumbing, not any live model's question-selection quality. No destructive command is executed by approval/preflight tests.
