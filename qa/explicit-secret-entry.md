# Explicit secret entry — 2026-10-05

Regression: pasting ordinary task text that resembled an assignment or credential opened Add secret, cleared the draft, and could be blocked again by Send or server ingress guards.

The fix removes automatic classification from New Task, existing task chat, initial messages, queues, steering, task edits and question answers. Only an explicit Add secret / Project Settings action opens secret entry. Encrypted storage, access checks, masking, output redaction and the existing `.env` file-attachment policy are unchanged.

Verified:

- A failing test reproduced paste interception in the real composer and hooks before the fix; a route regression reproduced the HTTP 400 before message admission.
- Composer and route tests now exercise ordinary assignment-like text, queueing, steering, task creation/edits and question answers. Explicit Add secret opens a blank form without consuming the chat draft.
- Existing secret-entry save, scoping, masking, focus, storage and runtime tests pass.
- Browser QA in a disposable local fixture: both New Task and existing task chat retain pasted example text without a popup; Add secret opens only after clicking it; Cancel preserves the draft.
- Full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` pass. Environment-dependent Python checks remain skipped locally. The build retains its existing large-chunk advisory.
- Independent review found no functional issues. Its trailing-whitespace finding was fixed and rechecked.

No live Hermes state or real credentials were used. Screenshot: `.tmp-native-qa-secrets/paste-without-popup.jpg` (ignored local fixture evidence).
