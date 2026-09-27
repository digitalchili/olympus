# v0.7.20 release acceptance — 27 September 2026

The user authorized completing the remaining container checks and publishing the hardening release. This candidate combines the R1–R4/G1–G3 implementation checkpoint `0f2194b` with install/update hardening, release-gate improvements and the package/lockfile version bump to 0.7.20. Authentication A1–A3 previously shipped in v0.7.19. Performance P1–P4 and live operational acceptance are still pending.

## Final local gates

All passed on the final product source and package version:

- Full `npm test`: exit 0, 183 TypeScript files and 18 Python files. The ordinary runner's nine existing native skips remain separately covered by the earlier isolated native evidence.
- Typecheck, production build, shell syntax and diff checks: exit 0. The existing large client-chunk warning remains.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilities reported.
- Built Linux arm64 candidate: `olympus-dispatch:release-check-0.7.20`, image `sha256:c406edf7ebb347086b6e8f2fc12005519626e501f6502037c224b90abab20ddc`. This is the local acceptance image; the release workflow builds the published image from the tag.
- Final integrated `test:docker-e2e`: exit 0 against that candidate and the actual v0.7.18 release pinned to `sha256:2ac9aafcced1be576acdb650342508e1469285370173094b3d664b679e2bd954`.
- Independent source/release review and a separate review of the final container harnesses found no unresolved release blockers.

The Docker gate ran on the user's local OrbStack with disposable state only. It verifies built worker/helper assets with the pinned Hermes runtime, blocked model-inventory responsiveness, synthetic native OAuth, uncertain Git publication across a forced process restart, upgrade/readiness/drain, Olympus/Hermes persistence, failed-promotion recovery, rollback to the released image and backup restoration. The publication fixture starts the actual compiled HTTP server after restart and waits for readiness before asserting no automatic publication. Two explicit retries confirm one version, with the original commit/push and later uncommitted work preserved.

Both new container gates run as part of the existing CI and pre-publication Docker lifecycle gate. No real provider endpoint, installed credential store, production volume or live GitHub repository is used by these fixtures. See [worker/authentication evidence](docker-worker-acceptance-2026-09-27.md), [installer evidence](installer-hardening-2026-09-27.md) and [R/G evidence](reliability-2026-09-26.md).

Ephemeral local logs: `/tmp/olympus-v0720-full-tests.log`, `/tmp/olympus-v0720-typecheck.log`, `/tmp/olympus-v0720-build.log`, `/tmp/olympus-v0720-audit.log`, `/tmp/olympus-v0720-shell.log`, `/tmp/olympus-v0720-docker-build.log`, `/tmp/olympus-v0720-docker-final.log`. Final lifecycle project: `olympus-e2e-35592`. These logs are not release artifacts.

## Publication gate

This record is committed before publication. Completion additionally requires the main/tag push, successful CI and release workflow, a published GitHub Release, and the public image manifest containing Linux amd64 and arm64. Verify those remotely against the tagged commit; local success alone does not establish publication.

## Selected-installation pilot

The selected live application was observed at v0.7.18 with its installation-local update hook unavailable. That message alone does not identify whether the runner is absent, disconnected or misconfigured. No live service was modified. Its exact Dokploy project/service and selected volume identities are needed before preparing the concrete dry-run.

The pilot must preserve Olympus and Hermes state, verify a recoverable backup, use the existing installation topology, and follow its approved single-writer update sequence. Do not apply the bundled HA installer to an existing single-service Compose deployment. After an approved rollout, verify readiness, profiles/history, user-completed sign-in if required, a safe task reaching review, browser reconnect/Stop, and separately authorized test-repository publication. Authentication rotation and rollback compatibility must be considered before restoring old credentials.

These local gates do not prove the reported live disconnects are resolved, establish a fair Hermes Desktop speed comparison, or certify production readiness. The exact live dry-run, update-hook diagnosis, provider/GitHub pilot, recovery trial and operational observation remain separate evidence.
