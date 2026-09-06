# Production readiness fixes implementation plan

> Agentic workers: use test-first implementation and independent review for each task; keep all tests and container probes isolated from installation state.

Goal: repair the blocked Project workflow and all eleven findings from the v0.6.2 audit in a single patch release.

Architecture: retain Hermes as execution owner and Olympus's single-editor Project model. Extend existing ownership, cancellation and maintenance boundaries to include verification and scheduled work. Preserve Git history and original upload contents; do not replace the runtime or add a new orchestration layer.

Scope is approved by the user's request to fix all previously reported issues. Source baseline is 6b66230. Live checkout recovery is separately evidenced on the explicitly selected server; installation changes require the repository dry-run process.

## Constraints

- Node 22.22–25 for Olympus; Hermes's tool runtime stays independent.
- No real installation database, credentials, profiles, repository or data volume in tests.
- Preserve existing file bytes, Git commits and user stops; fail visibly when safe continuation cannot be established.
- Reproduce each defect before changing behavior. Run scoped checks after each change, followed by the integrated suite and independent review.
- No remote pushes, application replacement, restart or service configuration changes without applicable session authorization.

## Task 1: verification lifecycle (release_review)

Files: server/coding-verification.ts, server/routes/coding-verification.ts, server/routes/chat.ts, server/routes/task-recovery.ts, server/task-run-lifecycle.ts, associated tests. Export shutdown cancellation for root integration in server/index.ts.

- [ ] Reproduce new-repository review bypass, startup-versus-verification race, Stop during checks, and detached child surviving parent exit with isolated API/process tests.
- [ ] Re-evaluate repository applicability after the agent creates a repository and require configured, passing evidence.
- [ ] Serialize execution ownership so manual checks and agent startup cannot overlap, including after awaited preparation.
- [ ] Route cancellation to verification; terminate and reap verification process groups on Stop and shutdown. A stopped run cannot enter review.
- [ ] Run meaningful regression tests and return shutdown integration interface plus evidence for review.

## Task 2: storage alerts, safe tests and uploads (storage_audit)

Files: server/disk-alert.ts, server/routes/storage.ts, server/routes/files.ts, tests/disk_alert.test.ts, tests/storage_routes.test.ts, upload tests, test runner scripts. Coordinate package.json changes with root; root owns server/index.ts integration.

- [ ] Reproduce SQLite-full process termination, destructive test state, duplicate concurrent alerts, cooldown suppressing a fresh incident, and failed upload deleting original data.
- [ ] Make alert polling settle safely on operational failure; serialize checks and distinguish automatic recovery from dismissal cooldown.
- [ ] Initialize isolated state before module imports and enforce temporary test defaults at the test entry point.
- [ ] Preserve original files when any upload entry fails; prefer a small staged/rollback solution or explicit collision rejection consistent with the existing UI.
- [ ] Run regression tests including seeded sentinel state and original file-byte preservation; return caller integration instructions for alert polling.

## Task 3: scheduled work and maintenance (deploy_audit)

Files: server/workers/hermes_scheduled_tasks.py, server/workers/hermes_worker.py, server/adapters/*, server/drain*.ts, server/app.ts, scheduled/drain tests. Root owns final server/index.ts integration.

- [ ] Reproduce scheduled work remaining active while maintenance reports idle.
- [ ] Gate new scheduled starts when draining and include running scheduled work in the existing idle contract across active profile workers; unknown worker state must not count as idle.
- [ ] Resume scheduling on cancelled drain; preserve normal manual scheduling behavior outside drain.
- [ ] Test active job, due job during drain, profile routing, cancellation and worker failure with deterministic native runners.
- [ ] Return integration interface and scoped test evidence for review.

## Task 4: Project recovery and Docker lifecycle (root)

Files: server/project-cp.ts, server/db/project-cp.ts, Project routes, Project regression tests, scripts/docker/backup.sh, scripts/standalone/docker_compose_update.sh, tests/docker_e2e.sh, CI/release workflows, release documentation and version metadata.

- [ ] Inspect the selected live checkout; preserve its old branch and verify the unique commit before reconciling it with main. Do not replay the pending user task automatically.
- [ ] Reproduce conflict handoff and partial sync with real disposable Git repositories.
- [ ] Return bounded conflict filenames and recovery guidance; preserve checkout and ownership after failed merges. Reconcile the lease baseline only for proven published sync progress.
- [ ] Make Olympus maintenance helpers use its pinned Node executable and add execution coverage for native SQLite in lifecycle tests.
- [ ] Run disposable Docker backup, restore and update E2E; require lifecycle coverage in release validation.
- [ ] Review available compatible dependency security patches; verify actual audit results and relevant UI/runtime behavior.

## Integration and acceptance

- [ ] Review each task's diff and regression evidence; resolve findings before acceptance.
- [ ] Integrate shutdown/polling hooks without weakening maintenance or stop behavior.
- [ ] Full isolated tests, typecheck, production build, shell checks, dependency audit and diff checks pass.
- [ ] Disposable production image passes readiness plus backup/restore/update and failure recovery checks. Verify AMD64 behavior for the user's server, not only ARM64.
- [ ] Browser verification covers Project conflict presentation and verification Stop/retry behavior where changed.
- [ ] Record exact tests, skips, remaining limitations and live recovery actions. Integrate the completed release safely and keep deployment validation distinct from source control.
