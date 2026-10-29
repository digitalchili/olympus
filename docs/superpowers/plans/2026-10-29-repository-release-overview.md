# Repository changes and publication implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline, followed by a fresh whole-branch review.

**Goal:** Show all unpublished repository work, offer Wait for all and Publish what's ready, and preserve the user's model selection.

**Architecture:** Record checked contribution provenance at the existing repository handoff. A small durable repository release intent captures exact contributions and queued/running requests. Build its candidate in isolated storage and publish through the existing publication receipt machinery. The sidebar is read-only; no task work is changed by viewing it.

**Tech Stack:** TypeScript, Express, SQLite, Git, React, existing Hermes worker.

**Spec:** `docs/superpowers/specs/2026-10-29-repository-release-overview-design.md` (approved).

## Global Constraints

Preserve all task folders, histories, queues, profiles and defaults. Repository identity and access checks span Projects. Never force-push, silently broaden saved release scope, infer readiness from task status, or claim deployment from a Git push. Use same-source checks on the combined candidate. Only the selected Somboon service is authorized for deployment, after global idle, authenticated native guard and verified backups. Existing isolation and completed v0.7.54 verification are retained; no repeated baseline development work.

## Review Focus

Check cross-project/profile visibility, run and queued-request binding, stale checks, dependency-complete subset selection, upstream advancement, unknown push outcomes, restart recovery, cancellation, maintenance during release checks, and possible writes from read-only inventory. Check that unsent model choices survive reload and late settings responses without changing the current run or another profile.

### Task 1: Correct model choice reconciliation

**Files:** `client/src/hooks/useAgentConfig.ts`, `client/src/components/TaskChat.tsx`, `client/src/components/RunModelResolution.tsx`, configuration fixtures/tests.

**Interfaces:** Hook reconciles saved task changes while retaining explicit next-message choices. Current run actual settings are separate from next-message settings.

- [ ] Add a failing real-hook regression for a queued request applying settings after initial load, explicit draft choices and reload/profile isolation. Add current-run versus next-choice rendering coverage.
- [ ] Run `node --import tsx tests/agent_config_loading.test.ts` and relevant UI test. Expected: new regression fails before the fix.
- [ ] Implement narrow reconciliation and scoped persistence; preserve explicit choices against late responses.
- [ ] Run configuration/composer/model-resolution tests. Expected: all pass; sending uses selected provider/model/reasoning.
- [ ] Commit the tested model fix.

### Task 2: Repository contribution inventory

**Files:** `server/db/schema.sql`, `server/db/repository-releases.ts` (new), `server/repository-development.ts`, `server/repository-releases.ts` (new), `shared/types.ts`, repository integration tests.

**Interfaces:** Accepted contribution records identify repository, task, run, source and predecessor. Inventory includes saved legacy work and active/queued work without mutation, with explicit readiness and inclusion reasons.

- [ ] Add failing real SQLite/Git tests for accepted provenance, cross-project identity, duplicate ancestry, unverified legacy changes and read-only inventory.
- [ ] Run the targeted repository test. Expected: missing contribution/inventory behavior fails.
- [ ] Record provenance at successful handoff; implement bounded read-only inventory and safe legacy evidence recognition.
- [ ] Run repository inventory and existing development/queue tests. Expected: accepted changes appear once and unready work remains saved.
- [ ] Commit tested inventory.

### Task 3: Durable publication with two choices

**Files:** repository release DB/service, `server/project-cp.ts`, `server/routes/projects.ts`, `server/app.ts`, `server/index.ts`, publication/release integration tests.

**Interfaces:** Snapshot preview -> saved intent (mode, bounded members, target). Wait binds captured queue IDs to admitted runs. Ready chooses a dependency-complete accepted source. Isolated checked candidate -> existing project publication receipt -> verified remote refs.

- [ ] Add failing integration tests for both modes, active plus queued membership, replacement invalidation, later-work exclusion, cancellation/restart and failed/stale/conflicting/upstream-advanced publication.
- [ ] Run targeted tests. Expected: release behavior fails before implementation.
- [ ] Persist one pending intent per repository, enforce permission and identity rechecks, build/check pinned isolated candidate, reuse non-force receipt/readback publication, and integrate safe background dispatch with maintenance activity.
- [ ] Run release, publication, queue, permissions and maintenance tests. Expected: exact intended commits only, no task checkout writes and no duplicate publication.
- [ ] Commit tested publication service.

### Task 4: Sidebar and clear publication flow

**Files:** `client/src/components/RepositoryChanges.tsx` (new), task sidebar, API/types, project task context, UI fixtures/tests.

**Interfaces:** Read-only overview and preview; explicit Wait for all/Publish what's ready request; visible included/excluded tasks, waiting explanation, retry/cancel and truthful On GitHub/deployment status.

- [ ] Add failing UI/route tests for named contributions, options, included/excluded preview, protected contributions, waiting/blocked/confirmed states and task context.
- [ ] Run targeted tests. Expected: missing UI/route behavior fails.
- [ ] Add responsive sidebar and publication dialog using existing components and route permissions. Keep chat input and existing activity available.
- [ ] Run UI/route tests and inspect browser fixture including mobile. Expected: clear scope and status without technical branch management requirements.
- [ ] Commit tested UI.

### Task 5: Release and actual Olympus verification

- [ ] Run full `npm test`, `npm run typecheck`, `npm run build`. Expected: green. Record evidence and run one fresh whole-branch review; fix demonstrated important issues with failing regressions.
- [ ] Publish a new version after verifying current GitHub main, without moving prior tags. Expected: exact-release CI and image green; release notes read back.
- [ ] Wait for Somboon global idle, authenticate drain, require native guard, take online backups and safe state fingerprints; ordinary Deploy existing service. Expected: exact version/SHA, healthy non-draining service, preserved state.
- [ ] Exercise actual private-fixture Olympus tasks: multiple contributions visible from older task, both publication options, queued membership and actual model settings. Verify remote exact source/files, preserved excluded work and UI screenshots. Expected: all specified acceptance cases are demonstrated; otherwise investigate only the demonstrated failure.
- [ ] Report concise release and live evidence; remove any follow-up created for this work only after full completion.
