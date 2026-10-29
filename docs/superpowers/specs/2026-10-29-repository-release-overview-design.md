# Repository-wide unpublished work and release choice

Status: proposed design; no product implementation or production changes yet.

## Intent

The user works on one repository through several Olympus tasks. They want to see the accumulated work in the task's right sidebar and publish the combined changes to main, without understanding branches or remembering which task contains which fix. When some work is unfinished, they want a choice for that release: wait for all included tasks or publish what is ready. No silent omissions, lost drafts, interruption of active work, or automatic inclusion of failed/stopped work.

## Verified current behavior

- GitHub main and the release checkout are at v0.7.54, ca0ebacc60285445f239bd29a3a8743f6bca58a5.
- `server/repository-development.ts` already accepts checked task commits into a local repository-wide `olympus/development` branch. Subsequent tasks inherit this accepted work. Acceptance is separate from GitHub publication.
- `TaskCommitPushModal` and `project-cp.commitPush()` publish the selected task's checkout. They do not provide a repository-wide list of included task contributions.
- Existing publication receipts pin a commit/tree and target refs, survive unknown outcomes, and enforce non-force pushes. Reuse those guarantees.
- TaskChat already has a right sidebar for delegated workers, background work, and checks.
- A push to the default branch can trigger an external deployment service, but Olympus currently has no generic deployment-status integration. A push is not proof that production is live.
- Read-only Somboon inspection of Fix Artwork Issue reports saved/requested/actual model `gpt-6-sol`, provider `openai-codex`, no fallback. The supplied screenshot shows `gpt-6.1-terra`, the profile default. The display/selection mismatch is demonstrated; the precise UI cause still needs reproduction.

## Approaches

1. **Recommended: repository work list plus combined release.** Extend the existing repository identity, accepted development history, verification and durable publication machinery. This matches the user's task-oriented workflow and chosen wait/publish-ready choice.
2. **Visibility only.** Add a list but retain task-only publication. Smaller, but leaves the user's main problem unresolved.
3. **Manual branch selection and merging.** Offers control but asks the user to manage Git and risks including unfinished work. Does not fit the requested simple experience.

## What the user sees

A section titled **Unpublished changes** in the right sidebar, shared across tasks linked to the same repository. Each row uses a task title, a short verified change summary when available, and a plain status:

- **Ready to publish** — checked changes accepted into the combined development version, not yet on the target branch.
- **Still working** — the task or its background work is active.
- **Needs attention** — unfinished checks, a conflict, or saved changes whose readiness cannot yet be established. Explain the specific reason and link to the task.
- **Stopped — work saved** — visible retained work, excluded from release by default.

Published work is removed from the unpublished list only after target-branch readback proves inclusion. A small recent-release summary says **On GitHub**. **Live** appears only when an existing supported deployment path provides evidence for that exact published version; otherwise say **Deployment not verified**. Branch names and commits are available in expandable details, not the main experience. Mobile uses a collapsible section. Preserve the existing worker/activity cards.

The list is repository-wide, not just project-title-wide. Respect current project/profile permissions. If another linked project's unpublished work is inaccessible, do not reveal its private details or offer an incomplete release as 'all'; clearly say that full release scope could not be checked.

## Release behavior

The repository action is **Publish changes** with an explicit destination (normally main). A request to publish/deploy the repository should open or invoke the same authoritative release flow, not let an agent independently infer the contents of its own checkout.

If all included changes are ready, show the included tasks and publish their combined checked source. If some are not ready, offer:

- **Wait for all** — save the request, list the tasks being waited for, and publish automatically when that defined group becomes ready. Failure or a question keeps the request visible and paused; it never grants approval or drops a task silently.
- **Publish what's ready** — show the exact ready tasks included and the tasks left out before saving this release intent. Leave all other work intact.

Each release request captures a bounded group of task contributions present when requested. **Wait for all includes already-saved queued requests**, identified by their exact queue entry IDs and then their eventual admitted run IDs. This follows the user's request to include all current task work; an already-queued task must not disappear merely because it has no active run yet. Replacing, editing or removing a captured request invalidates that member's prior scope and shows that the release needs review; it never silently drops it. New tasks and messages added afterward do not silently join the release. While waiting, track each bound active turn or captured queued request's result; later independent edits or new turns cannot silently broaden approval. Existing accepted contributions are tracked by commit ancestry and source evidence, not task status alone. Freeze the combined release source when the captured group is ready; later accepted contributions belong to a later release.

Use the existing accepted development version as the release source. Ready contributions already present through ancestry are counted once; do not cherry-pick each inherited task branch and duplicate shared work. 'Publish what's ready' means a dependency-complete checked version, never arbitrary file selection. A change depending on unaccepted work is not ready.

Old task branches and saved drafts must be discovered and shown. They are not automatically declared ready because they are committed or marked complete. Work not yet accepted can join only after normal idle/source/check/handoff validation; a read-only sidebar fetch must not run checks, modify Git, resume tasks or repair history. Ambiguous legacy work remains visible with a concrete explanation.

Build/check the combined candidate in server-owned isolated release storage, preserving every task checkout. Reuse required verification rules; the final candidate must be checked against current main. Conflicts preserve all work and show the affected tasks. Coordinate publication and repository handoff using existing repository/task guards with an exact-source check; do not stop active tasks or mutate their folders. Recheck permissions, repository identity, current target, selected source and checks immediately before publication. Never force-push main.

Persist one pending repository release intent with its included contributions, target, waiting state and exact publication receipt once ready. Retry an uncertain publication only for that saved commit and destination. Reuse existing receipt/retry/cancel semantics; avoid a second independent push implementation. Confirm GitHub refs before marking inclusion. A restart must not expand scope or repeat a completed push.

For 'push and deploy', publish the same defined version and pass that version to the project's existing authorized deployment workflow. Preserve its active-work/approval gates. Do not invent a generic deployment engine or assume every repository uses Dokploy. With no configured/verifiable deployment path, finish at **On GitHub — deployment not verified**, without claiming live success. The proposed feature does not itself authorize publishing or deploying Chili Radio now.

## Model selector correction

Reproduce the mismatch using the real hook/composer flow, including queued messages, browser reload, task/profile switching and late settings responses. Preserve explicit task model/provider/reasoning choices through these transitions. Display the current run's actual model separately when it differs from the next-message selection. Fix only the demonstrated cause; do not switch the running model, change defaults, or interrupt the current task. Verify requested and actual resolution after sending in an isolated fixture.

## Implementation boundaries and builder choices

Keep changes focused on repository contribution visibility, durable batch publication through existing mechanisms, minimal task context explaining inherited accepted work, and the verified model UI correction. No new planner, supervisor, memory service, automatic repair subsystem, custom branch manager or task limits.

The builder may choose the smallest schema extension for contribution provenance and a repository-level release intent, reusing the existing publication receipt table/API where feasible. Record task/run/source provenance at acceptance. Legacy reconciliation must be read-only and evidence-based. The builder chooses component breakdown, caching and polling/event wiring, tests and exact endpoint names. Expensive Git checks belong off the hot chat path; loading the sidebar must not delay sending a message.

## Acceptance

Use a private fixture repository and actual Olympus task chat, without touching unrelated production work:

1. Two checked tasks contribute different changes. The sidebar names both once, including from an older task view. Publish both to fixture main and verify both files and exact target SHA.
2. With another task still active and one already queued, Wait for all visibly names both, preserves work, then includes their checked results automatically. A later new task is outside that saved release scope; replacing a captured queued request requires review.
3. Publish what's ready includes only the displayed dependency-complete version; a held/failed/stopped task's files remain saved and visibly excluded.
4. Failed/stale checks, conflicts and upstream advancement prevent publication. An uncertain response/restart retries only the same saved intent without duplicate commits or extra tasks.
5. Two projects pointing at the same repository share the view/serialization with access checks. Unrelated repositories continue normally.
6. Model selection remains consistent across the reproduced failure path; runtime resolution matches the selected setting. No changes to normal tools/delegation or active work.
7. Show publication and deployment status truthfully. Preserve all existing histories, profiles, workspaces, queues and configuration during any separately authorized Olympus deployment.

## Approval

The user has selected a per-release choice between waiting for all and publishing ready work. A fresh builder review raised only the already-queued-request scope; the paragraph above resolves it from the user's requirement to include current task work. The user approved implementation, GitHub publication and safe Somboon deployment on 2026-10-29. No push/deployment of this new feature has occurred yet.
