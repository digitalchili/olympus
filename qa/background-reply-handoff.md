# Background processes must not trap a finished reply

## Reproduction

A task's agent finished its response but left a task-local test database running.
The repository checkpoint waited for every native process to exit before emitting
the terminal event. The UI stayed Running, a saved follow-up could not dispatch,
and background cleanup was unavailable because the reply still appeared active.

## Fix

- A process-only inventory with no native continuation or pending result defers
  Git checkpointing, verifies current files, and lets the completed reply settle.
- The same successful repository owner may receive normal follow-ups in its
  existing workspace. That admission never refreshes or merges upstream source.
- The repository stays owned until every background command ends. Only fresh
  passing evidence permits the deferred commit; checks run on that commit before
  acceptance. Failed/stale files and interrupted work remain preserved.
- Fresh ownership, input, recovery, interaction and native-idle checks protect
  handoff. Checks in one repository do not hold up other repositories.
- Publication remains blocked while background work runs. No timers, process
  termination, model changes, native delegation changes or journal rewrites added.
- The background notice explains that the reply finished, this chat can continue,
  and other repository tasks are waiting for background work and passing checks.

## Verification

`repository_background_reply.test.ts` reproduced the original indefinite wait
before the fix. It now uses real Git repositories and a real HTTP service to
verify terminal delivery, exactly one saved follow-up, retained service liveness,
no source refresh/commit underneath it, explicit publication rejection, native
child/result guards, and automatic checked handoff after the service exits.

`repository_background_handoff.test.ts` holds an actual check open while another
repository completes. A message arriving during that check prevents acceptance
and release. Failed evidence leaves uncommitted work and accepted source intact.

The existing queue, stopped-owner, task-recovery and repository-development
regressions pass. Independent review covered admission, deferred verification,
publication and message/Stop races. Production deployment and live verification
are recorded separately; these local tests alone are not production proof.

## Unused reservation after Stop (v0.7.54)

The Somboon acceptance fixture exposed a retained repository reservation whose
`run_id` was null: a stopped task had reserved a later request without starting
another run. Its native inventory was empty, but its saved Stop receipt made
the unstarted-reservation path wait forever. The stopped run and receipt remain
untouched. This path now uses the existing stopped-idle predicate, then rechecks
the latest run, active work, queued request and reservation before releasing it.

The added `repository_queue_stopped.test.ts` scenario failed before the fix with
the null-run owner still present. It passes after the fix. Active children,
unavailable inventory, pending continuation, missing receipts, a failed previous
run, a newly queued request and a resumed run all retain ownership. The last two
changes occur during the intended owner's inventory probe, not another task's.
No unfinished source is accepted and no saved native result is discarded.

Full `npm test`, `npm run typecheck`, `npm run build`, and independent focused
review passed for this correction. Live acceptance remains a separate gate.
