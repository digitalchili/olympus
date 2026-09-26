# Publication UI hardening — G3

Scope: `docs/superpowers/plans/2026-09-26-github-publication.md`, Task G3. No live GitHub publication, credentials, deployment or Hermes process was used. No commits were made.

## Behavior

- Task publication opens with the task branch selected. Reopening or switching task/Project resets the optional default-branch choice; Project Code resets it on context changes and successful publication.
- Both entry points display the authoritative pending publication's commit and all target branches, including with a clean working tree. New message/target controls and workspace release are unavailable while that receipt is pending.
- Resume calls only the saved publication ID route with `{taskId}`. Failures refresh status to discover receipts after lost responses; retry never calls the new-commit endpoint.
- Stop retrying confirms that it does not undo changes accepted by GitHub and preserves the saved commit/local files. Canceling confirmation sends no request.
- Success uses the returned version's SHA and branch: `Pushed <SHA> to <branch>`. The task header and menu say Resume publication when status has a pending receipt.
- Sync copy explains that it downloads the starting point for new tasks and preserves existing task branches/files. Documentation describes the same scope and last-verified evidence.

Ruling: keep modal success visible until the user closes it rather than automatically closing after 1.6 seconds. This gives time to inspect the commit/branch and avoids an old timer closing a newly opened dialog. Context-generation checks discard stale modal reads/mutation responses. Project Code retains a confirmed success even if the subsequent status refresh fails.

Ruling: the coordinating agent owns the TaskChat shortcut and final shared documentation. This task changes the existing task header/menu and modal instead of adding another publication control in chat.

## Red and green

`node scripts/run-tests.mjs tests/project_publication_ui.test.ts` initially failed because a newly opened dialog selected the default branch (`true !== false`). The added task-header regression also failed before its pending-label change.

Passing checks:

```sh
node scripts/run-tests.mjs tests/project_publication_ui.test.ts tests/projects_ui.test.ts tests/project_sync_ui.test.ts tests/project_sync_routes.test.ts
npm run typecheck
npm run build
git diff --check
```

The component/API harness exercises production React component callbacks with controlled scheduling/HTTP: open/reopen/task switch defaults, exact new-publication payload, success SHA/branch, uncertain outcome/status reload, immutable receipt display, exact resume payload, reload with a clean tree, abandonment cancellation/confirmation, and no deployment claims. Nine real disposable Git/route sync regressions passed, including preservation of dirty/active workspaces and prior verification evidence. Build completed with the existing large-chunk advisory.

## Browser checks

Fixture: `tests/fixtures/publications.html` + `publications.tsx`, served only by Vite on loopback port 4191. The browser-only fake gateway persists its fixture receipt across reloads and rejects a resume body containing replacement intent. It issues no network request to GitHub or Olympus.

Playwright Chromium exercised the actual Project Code page and task modal:

1. Task-branch checkbox default and conditional deployment explanation.
2. Publication accepted by the fixture but unconfirmed to the UI; pending commit/targets visible and replacement controls absent.
3. Reload restored the pending receipt. A conflict on resume remained visible, and dismissing abandonment did not remove it.
4. Explicit resume displayed Pushed with the same fixture SHA and branch.
5. The task modal restored the same pending receipt, showed the no-undo abandonment confirmation, and returned to its retained file list after abandonment. A subsequent unconfirmed publication resumed successfully.
6. Sync's future-task wording remained visible. No Deployed/build-success claim appeared.

Visually inspected local screenshots (git-ignored): `output/playwright/g3/project-pending.png` and `output/playwright/g3/modal-pushed.png`. The fixture represents UI/gateway behavior; real Git preservation, branch protection and token boundaries are covered separately by G1/G2 tests, and real-account acceptance remains a later authorized pilot.

## Review follow-up

The task modal previously reused its upload progress text while abandoning a saved publication. An actual-component callback regression failed because the pending abandonment showed “Pushing to GitHub” / “Uploading changes”. A distinct busy state now shows “Stopping publication retries…” / “Keeping your saved commit”, with publication controls disabled until the request and status refresh finish. `node scripts/run-tests.mjs tests/project_publication_ui.test.ts` passed after this change. This copy-only follow-up used the existing fake HTTP harness; no new browser server or external publication was started.
