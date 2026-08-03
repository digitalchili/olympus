# Updating and rollback

## Docker

Run `./scripts/docker/update.sh --dry-run --image ghcr.io/leakim69/olympus-dispatch:NEW_VERSION`, then repeat without `--dry-run`. A verified backup after drain and before promotion is automatic and mandatory. The updater resolves the requested tag to an immutable digest and persists both slot pins in `.env` and `.olympus-slots.env`. Verify readiness, history, a new run, SSE, schedules, and files. `./scripts/docker/rollback.sh` drains identically, takes another verified backup, and starts the retained old slot/image pin.

This is not zero downtime. Existing active runs and HTTP/SSE connections are preserved while draining. During the bounded promotion window new writes receive retryable `503`, `Retry-After: 5`, and `MAINTENANCE_DRAIN`; reads remain available.

## macOS

Run `./scripts/macos/update.sh --dry-run`, then `./scripts/macos/update.sh`. It builds/verifies a candidate release without touching running files, drains to `activeRuns=0`, creates and integrity-checks a SQLite/state backup under `~/.olympus-dispatch/backups`, atomically switches `current`, restarts launchd, and verifies readiness. Failure before switching cancels drain; failure after switching restores the old symlink and restarts the old release.

Lifecycle scripts serialize themselves with a PID-bearing operation lock, so two agents cannot update or uninstall the same installation concurrently.

## Release 0.3.0

CI builds `linux/amd64` and `linux/arm64`, publishes semver and commit-SHA tags plus `latest` only for stable semver, and emits OCI provenance/SBOM. The multi-architecture GHCR manifest is the release artifact. Record its digest and deploy by digest. This repository does not publish from ordinary branch builds.
