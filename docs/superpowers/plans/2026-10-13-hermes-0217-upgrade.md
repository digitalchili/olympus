# Hermes v0.21.7 upgrade implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline, with one independent review before publication.

**Goal:** Upgrade Somboon's paired Olympus/Hermes image to Hermes v0.21.7 without interrupting active tasks or losing persistent state.

**Architecture:** Keep the direct Python AIAgent worker and existing Dokploy service. Pin the official release image by verified digest, retain existing profile settings, and repair only demonstrated compatibility issues.

**Tech Stack:** TypeScript/Node 22, Python/Hermes, SQLite, Docker, Dokploy.

**Spec:** User's October 13 authorization in this thread: verify current Hermes, upgrade to v0.21.7, test Olympus, commit, push, tag and deploy safely.

## Global constraints

- Preserve the unrelated primary checkout and all active production work.
- No plugin-isolation, voice, provider, model or execution-limit changes.
- Tests use disposable state and synthetic provider responses; never mount production credentials locally.
- No moved tags, force pushes, fresh volumes, duplicate live writers or unrelated service deployment.
- Confirm the reviewed remote main before deploying; drain only after active work is zero, recheck admission, back up persistent state and verify the resulting live runtime.

## Review focus

- Release tag, image provenance and runtime identity must agree despite upstream's release-receipt tagging.
- Real native approvals, resume/history, delegation/recovery and worker health must remain compatible.
- Newly installed skills must reach an existing session without weakening profile boundaries.
- Durable state must survive an image replacement and rollback with no parallel writers.
- Local/CI tests alone do not prove production readiness or successful deployment.

## Task 1: Verify and package the runtime

**Files:** Dockerfile, hermes-runtime.json, server/workers/hermes_runtime.py only if demonstrated necessary, native contract tests, docs/coding-harness.md, docs/development.md, docs/testing/native-interactions.md, docs/bots.md, package.json and package-lock.json.

- [x] Read live /api/updates/hermes and readiness; verify official image provenance against release source.
- [x] Run the unchanged local suite with supported Node 22.
- [x] Run existing real Hermes contract tests against the disposable candidate; add regression tests before any necessary compatibility fix.
- [x] Pin the verified image and compatibility manifest, update active compatibility documentation and release version.
- [x] Run full tests, typecheck, build, shell checks, real native worker/browser acceptance and released-image persistence/rollback checks.
- [x] Independently review the final change and resolve material findings.

## Task 2: Publish and deploy the verified release

**Files:** qa/hermes-0217-upgrade.md records evidence and limits; GitHub release notes describe the final change.

- [ ] Commit the narrow change, push main normally, create/push an unused annotated release tag.
- [ ] Verify CI and image publication succeed for that exact commit and apply/read back release notes.
- [ ] Wait for idle production; authenticate maintenance drain, recheck all owned work and back up state with integrity checks.
- [ ] Use the existing Dokploy deployment, preserve volumes/configuration and verify deployment receipt, live versions, readiness and drained-state clearance.
- [ ] Verify preserved profiles/task state and a bounded safe production conversation when idle; report only supported results.
