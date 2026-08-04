# Docker operations

`docker-compose.ha.yml` provides stable Nginx and blue/green application slots. Both slots reference the same SQLite and Hermes volumes, so strict single-writer sequencing is mandatory.

```bash
./scripts/docker/status.sh
./scripts/docker/backup.sh
./scripts/docker/update.sh --dry-run --image ghcr.io/digitalchili/olympus:NEW_VERSION
./scripts/docker/update.sh --image ghcr.io/digitalchili/olympus:NEW_VERSION
./scripts/docker/rollback.sh
```

Update pulls and resolves the candidate to a digest/image ID, preflights it with disposable Olympus state and the existing Hermes volume read-only, then removes preflight state. It never clones Hermes. It drains the old slot, waits for `activeRuns=0`, requires a verified backup, starts the candidate on live volumes, verifies it directly, switches the directory-mounted Nginx configuration, reloads, verifies through the proxy, then stops old. During live-volume overlap old rejects all writes and has zero active work.

At any promotion failure, including post-switch proxy readiness, recovery restores the old upstream and reloads it, stops candidate, cancels old drain directly in the active container even when the proxy is unavailable, and restores active-slot/image metadata. Rollback takes a verified pre-rollback backup and starts the retained slot at its immutable per-slot pin, never `latest`. Use the scripts rather than a direct `docker compose up`: the scripts source the retained pins, and the same pins are mirrored into `.env` so operator-initiated Compose reconciliation cannot silently replace them with a moving tag.

Install, update, rollback, backup, and uninstall take an atomic operation lock. A concurrent invocation fails immediately; a lock whose recorded process no longer exists is recovered automatically.

Backup drains and waits idle, checkpoints WAL, uses the pinned Olympus image and `better-sqlite3` backup API, runs `PRAGMA integrity_check`, archives non-DB Olympus state, and writes timestamp/slot/version/image metadata. A standalone backup cancels drain. Hermes is excluded. See [backup and restore](backup-restore.md).

This is not zero downtime: active runs and HTTP/SSE connections are preserved while draining, but new writes receive retryable 503 during the bounded promotion window. Reads remain available.
