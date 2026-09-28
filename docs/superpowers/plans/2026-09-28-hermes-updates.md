# Hermes Updates Implementation Plan

> **For agentic workers:** Use the approved design and contracts below to implement independent pieces, with failing tests before behavior changes and a final integration review.

**Goal:** Update the Hermes runtime from Olympus Settings on native and Docker/Dokploy installations without relying on another agent or Mac.

**Architecture:** Settings uses an installation-wide status endpoint and a fixed authenticated host updater. A checked-in compatibility manifest identifies the Hermes revision tested with an Olympus release. The detached updater owns progress, backup, replacement, verification and recovery so it survives an Olympus restart.

**Tech Stack:** Existing React/TypeScript, Python standard library, Git, uv, Docker/Compose, Dokploy API and installation-local Unix socket. No new application dependencies; the native host helper requires an existing uv executable.

**Spec:** User-approved recommendation in this task: current version, latest tested compatible version, release notes, explicit Update action, drain active work, preserve state, verify replacement and retain rollback. One-time host/Dokploy configuration is separate from implementation.

## Global Constraints

- Never mutate a live installation during development or connect to another host. Tests use disposable state and synthetic credentials.
- Hermes source and Docker updates are distinct. Docker replaces the Olympus image containing Hermes; native updates target the current Olympus release's tested Hermes revision.
- Preserve the selected Hermes source/profile identity, all profiles, credentials, sessions, project secrets and disk volumes.
- Only official published Olympus releases and their validated compatibility manifests can authorize a candidate. Do not accept executable paths, commands, arbitrary images or service identifiers from browser requests.
- The host helper survives app restarts, serializes updates, records durable names-only progress, and fails closed on interrupted/unknown outcomes.
- Drain all profile work and native background activity before replacement. Never terminate active tasks to force an update.
- Restore code/image automatically only when safe; retain backups and report a recovery requirement if data compatibility makes automatic restoration uncertain.

## Review Focus

- Old releases without manifests and failed network checks must not report falsely up to date or enable an update.
- Stale browser confirmations and duplicate requests must not apply a different target or launch parallel updates.
- Runtime discovery must stay lightweight and must not initialize user credentials or a model.
- A source checkout with local changes or ambiguous/shared ownership must not be overwritten.
- Reconnection must confirm actual runtime revision and host operation result, not infer Hermes success from the Olympus version alone.

## Tasks

### 1. Runtime identity and native update helper

**Files:** worker/adapters, `scripts/standalone/update_runner.py`, new fixed native helper and tests.
**Interfaces:** `getHermesRuntime(): Promise<HermesRuntimeInfo>`; types in `shared/hermes-updates.ts`. Authenticated runner GET `/hermes` returns `{method, configured, operation}`. POST `/hermes` accepts `{repository, olympusVersion, target}` where target is validated compatibility metadata; returns `{accepted:true, operationId}`. Existing `/update` remains compatible and shares the operation lock.

- [x] Test lightweight source/image identity, unknown/dirty sources and protocol routing.
- [x] Implement runtime discovery and exact approved revision selection.
- [x] Add detached native update, persistent progress, private backups, preflight, restart verification and recovery tests.

### 2. Compatibility manifest, API and Docker/Dokploy helper

**Files:** `hermes-runtime.json`, build/release packaging, `server/routes/hermes-updates.ts`, standalone Docker/Dokploy helper and tests.
**Interfaces:** GET `/api/updates/hermes?refresh=true` returns `HermesUpdateStatus`; POST `/api/updates/hermes/apply` accepts `{targetRevision,targetOlympusVersion}` and revalidates them server-side. It delegates only to the configured installation-local runner.

- [x] Test strict manifest/release validation and installed-target comparison.
- [x] Package the tested Hermes manifest and verify it against the Dockerfile pin.
- [x] Implement status, explicit setup reasons, target revalidation, safe errors and host handoff.
- [x] Implement image replacement through configured Compose or Dokploy with consistent state backup, exact image selection, candidate runtime preflight and recovery tests.

### 3. Settings UI

**Files:** `HermesUpdateSettings.tsx`, Settings tab, API helpers and UI tests.

- [x] Show current runtime, tested target, release notes, installation method and setup guidance.
- [x] Confirm the exact version; container updates disclose the paired Olympus version.
- [x] Poll durable operation status through disconnects; never treat a timeout or an accepted request as success.
- [x] Cover duplicate submission, unavailable setup, stale replies, failures and confirmed completion.

### 4. Integration and verification

- [x] Document installation-local native/Compose/Dokploy setup and recovery, including data backups.
- [x] Run focused tests, full tests, type checks, production build and shell checks.
- [x] Verify Settings flows in a disposable local browser fixture, then independently review update authority and recovery boundaries.
- [x] Report source/local evidence separately from live deployment. Do not publish or deploy without a new request.

## Local verification evidence

- Full `npm test` passed; focused UI, API, authenticated socket, release-authority and maintenance tests also passed after review fixes.
- `npm run typecheck`, production build, packaged-manifest load and shell syntax checks passed.
- An isolated browser fixture verified the target confirmation, progress, disabled duplicate action and completed state after reload.
- A local Docker image built successfully. Its Hermes imports and actual revision matched the manifest using disposable state with network disabled.
- A disposable running container verified startup maintenance fencing, refused early resume, authenticated runtime verification and readiness only after explicit resume. No production state mounts or provider credentials were used.
- A second real Docker test backed up and restored a disposable volume, preserving original file content, UID/GID 10000 and private 0600 permissions; the Olympus user could read the restored key fixture.
- The final full suite passed with Python 3.12 selected. The reviewed updater/runtime suites also passed separately, including real temporary archive restore, invalid-backup refusal and uncertain-resume recovery.
- Native service updates and the selected VPS/Dokploy deployment have not been exercised live. Installation-specific setup and a reviewed dry-run remain separate operational work.
