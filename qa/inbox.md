# Inbox verification — 2026-10-05

Verified with disposable local state and the real Olympus API/UI. No live installation or model provider was used.

- All three categories, one row per task and installation-wide sidebar count.
- Profile and Project filters, combined empty state and clear filters.
- Questions preview without answering; saved replies preview without marking the task read or complete.
- Opening a result switches to the task's profile; artifact download links use that profile too.
- Desktop split view and 390 × 844 mobile list/detail/back navigation.
- Simulated API failure retains a clearly stale list and shows a refresh warning. Restoring the API recovers the count.
- Answering the fixture question and completing a fixture review removes both items and dismisses the resolved preview.

Automated checks passed: full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Eight environment-dependent native Hermes checks were skipped by the test suite. Focused Inbox, run-snapshot and Markdown regressions passed again after final error-handling changes. The production build reports the existing large-chunk advisory.

Independent code review identified and verified the fix for recovery records that are waiting on human input. A full-suite failure also exposed a same-millisecond run-state race; a deterministic regression now covers both new live admission and stale live state against a later persisted run.

Local screenshot: `.tmp-native-qa-inbox/inbox-desktop.png` (sample tasks only, ignored by Git). Reproduce using the fixture described in `docs/inbox.md`.

## v0.7.25 release candidate

Integrated with the latest v0.7.24 source in an isolated worktree, preserving unrelated local changes. Independent integration review found no actionable regressions in profile access, Project access, auth fencing, maintenance reads or recovery classification.

After installing the final lockfile, full `npm test`, `npm run typecheck`, `npm run build`, `npm run lint:shell` and `git diff --check` passed. The newer baseline's test suite skipped 24 environment-dependent Python checks locally. Production `npm audit --omit=dev --audit-level=high` reports zero vulnerabilities after compatible updates to brace-expansion, DOMPurify and Multer. The existing build chunk-size advisory remains. Docker upgrade/rollback verification and multi-platform image publication run in the tag-triggered GitHub release workflow; no live deployment is performed.
