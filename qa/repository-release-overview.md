# Repository release sidebar and model selection — v0.7.55

## Local evidence

- Complete `npm test` passed: 260 isolated Python/TypeScript test files. The worker-heartbeat timeout line is an intentional lifecycle regression fixture.
- `npm run typecheck` and `npm run build` passed on Node 22.22.3; build reports the existing bundle-size advisory.
- One independent whole-branch review identified four important cases, each reproduced by a failing regression before the fix:
  - `repository_release_same_task`: captured active turn plus queued follow-up resolves to the final checked result.
  - `repository_release_target_refresh`: external main advancement cannot relabel published work as ready; background target cache never alters task checkouts.
  - `repository_release_cancel`: explicit cancellation terminates only release checks and releases maintenance ownership before returning.
  - `repository_release_stopped_scope`: historical stopped work stays visible and preserved outside a new wait-all group.
- Real Git/SQLite integration covers checked combined sources, cross-Project repository membership, access boundaries, stale previews, exact queue binding, later work exclusion, upstream conflict, stopped runs, check failures and unknown push reconciliation.
- Actual React hook tests cover saved model reconciliation, task/profile isolation and unsent settings surviving reload.
- Browser fixture checked at desktop and 390px mobile: included/excluded preview, both actions, saved wait/cancel and unsent composer content retained. Screenshots retained locally at `/tmp/repository-release-ready-desktop.jpg` and `/tmp/repository-release-wait-mobile.jpg`.

## Implementation decisions

- Reused the existing isolated worktree, automatic handoff, same-source check rules and publication receipts.
- A queued follow-up in the same task continues the current files and gets one final accepted result; no intermediate acceptance is invented.
- Sidebar reads remain read-only. The periodic release service refreshes a separate bare target-object cache; unknown ancestry is temporarily shown as checking, never assumed ready.
- Stopped or unchecked saved drafts stay under Left for later by default; a captured active task that subsequently stops still blocks that saved request.
- On GitHub is deliberately distinct from verified deployment. No generic deployment-provider subsystem was added.

## Production acceptance

Pending. Local tests and publication do not prove Somboon deployment or live acceptance. Require exact release CI/image, idle drain/native guard, fresh backups, preservation readback and actual Olympus publish/model flows before completion.
