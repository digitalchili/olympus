# Portable Installation and Interruption-Free Updates Implementation Plan

> **For Hermes:** Implement task-by-task with tests, independent review, and evidence-backed verification.

**Goal:** Make Olympus Dispatch installable with minimal input on a Mac with Hermes or on a Docker/Dokploy Hermes host, and make future Somboon VPS updates blue/green with graceful draining and rollback.

**Architecture:** Preserve the current direct Hermes Python integration for full feature parity. Native installs auto-discover Hermes. Docker installs use the official Hermes-based Olympus image and auto-detect/reuse the existing Hermes `/opt/data` volume only after a preflight identifies it. A stable Nginx proxy fronts blue/green Olympus slots, but the slots are never concurrent writers: the candidate is first tested against disposable/cloned state; the active slot then enters read-only drain and finishes all active work before the candidate starts against live volumes. Nginx switches only after candidate readiness. Existing connections drain on the old slot, and failed promotion cancels drain and leaves the old slot active. Existing remote profile routing remains optional.

**Tech stack:** Node.js/TypeScript, Python Hermes worker, SQLite WAL, Docker Compose, Nginx, GitHub Actions/GHCR, launchd on macOS.

---

## Constraints and non-goals

- No Somboon-specific IP, network, volume, project, or container names in the portable defaults.
- Do not expose secrets in source, process arguments, logs, or generated documentation.
- Preserve current task/session/state formats and all existing features.
- Do not make the application mutate its own Docker container.
- No production cutover until source, image, fresh-install, update, drain, and rollback checks pass in a shadow stack.
- Gateway-only mode is not the default until Hermes gateway APIs provide feature parity for goals, compaction, steering, defaults, and scheduled tasks.

## Acceptance criteria

1. `npm test` and `npm run build` pass without requiring host `rsync`.
2. The default Compose configuration contains no Digital Chili/Somboon host assumptions and validates with `docker compose config`.
3. A Docker installer can select the sole running Hermes `/opt/data` volume automatically, generate a root-only `.env`, start Olympus, and verify `/api/ready`.
4. A macOS installer can discover a standard Hermes install, build Olympus, generate a LaunchAgent, start it, and verify health with no questions on the standard path.
5. A stable proxy supports blue/green slots without concurrent Olympus writers. An update must preflight the inactive image on disposable state, put the active slot into read-only drain, wait for active work to finish, start and verify the candidate on live volumes, switch new connections without restarting the proxy, and preserve both Olympus and Hermes volumes.
6. Failed preflight leaves the active slot untouched. Failed promotion stops the candidate, cancels the old slot's drain, and leaves the prior slot serving traffic.
7. Olympus exposes authenticated drain, cancel-drain, and status endpoints; rejects new writes while draining; sets a SQLite busy timeout; serializes schema migration; and allows active agent runs to finish before SSE clients are asked to reconnect.
8. CI tests/builds source and the Docker image. Tagged releases publish immutable GHCR tags and digests.
9. Documentation gives a Hermes Agent an exact Mac, Docker, Dokploy, upgrade, rollback, backup, and verification path.
10. The existing Somboon deployment has a documented one-time migration into the stable-proxy layout and a tested shadow rehearsal before any live cutover.

## Task 1: Baseline and portable build assets

- Add a Node build-assets script and test it.
- Replace the `rsync` package script.
- Run the targeted test, full tests, and build.

## Task 2: Runtime readiness and graceful drain

- Add a drain state module with authenticated begin/cancel/status endpoints.
- Add `/api/ready` distinct from liveness.
- Reject new mutating requests while draining and add SQLite busy-timeout plus serialized migration behavior.
- Let active runs finish, notify/close SSE clients, and make SIGTERM use the same drain path with a bounded timeout.
- Add state-machine and HTTP behavior tests.

## Task 3: Portable Docker packaging

- Replace the environment-specific Compose defaults with portable volumes, bind address, image/build settings, and health checks.
- Add a high-availability Compose overlay with stable Nginx proxy and blue/green slots.
- Add deterministic proxy configuration templates and validation.
- Keep a separate documented Somboon override example rather than encoding it in defaults.

## Task 4: Minimal-input installers

- Add a Docker installer that auto-detects an existing Hermes `/opt/data` named volume, prints a sanitized identification summary, requires confirmation unless `--yes` or an explicit volume is supplied, generates secure defaults, and verifies readiness.
- Add Docker status, single-writer blue/green update, rollback, backup, and uninstall commands. Candidate preflight must use disposable/cloned state; live promotion begins only after the old slot is drained and idle.
- Add a macOS installer/update/uninstall flow with Hermes discovery and launchd.
- Ensure scripts are non-interactive on the standard path and accept flags/env for ambiguous hosts.
- Add shell/static contract tests and dry-run modes.

## Task 5: Release and CI

- Add GitHub Actions for tests/build/Compose validation/Docker smoke.
- Add tagged GHCR image publication with immutable semantic-version and commit tags.
- Add version metadata labels and a documented release process.

## Task 6: Documentation

- Rewrite README quick start around Mac and Docker paths.
- Add `INSTALL.md`, `docs/docker.md`, `docs/dokploy.md`, `docs/upgrading.md`, and `docs/somboon-migration.md`.
- Update `AGENTS.md`, `.env.example`, and development docs.

## Task 7: Verification and review

- Fresh native source install smoke in an isolated state directory.
- Build image and run a fresh Docker shadow stack on the Dokploy host without touching the live service.
- Exercise successful blue/green update, active-run drain behavior, failed-candidate rollback, state persistence, and health/readiness.
- Run independent spec and security/quality reviews; fix blockers.
- Commit and publish a branch/PR. Do not cut over production without explicit deployment approval.
