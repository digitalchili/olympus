# Backup and restore

Create a consistent standalone backup with `./scripts/docker/backup.sh`. It drains, waits idle, checkpoints and backs up SQLite, verifies `PRAGMA integrity_check`, archives non-DB Olympus state, writes metadata, then cancels drain. Hermes data is deliberately excluded.

The macOS updater performs the same SQLite checkpoint/backup/integrity check and non-database state archive automatically before switching releases. Native backups default to `~/.olympus-dispatch/backups` and can be redirected with `OLYMPUS_BACKUP_DIR`.

For a native restore, unload the LaunchAgent, copy the verified SQLite file to `~/.olympus-dispatch/data/olympus-dispatch.db` without WAL/SHM companions, extract the state archive while preserving the restored database, run `PRAGMA integrity_check` with the retained release's Node and `better-sqlite3`, then reload launchd and verify readiness, tasks, files, schedules, and Hermes sessions. Restore into a copied state directory first when space permits; retain the original until verification passes.

For restore, record current status, stop both application slots, and keep the proxy unavailable. Create a new empty Olympus state volume; never overwrite the original. Extract `*-state.tgz`, copy the verified SQLite file to `data/olympus-dispatch.db` as UID/GID 10000, and do not restore WAL/SHM files. Run `PRAGMA integrity_check` using the exact pinned image in metadata. Point Compose at the new state volume, start only the recorded active slot/image, verify directly and through proxy, then restore access. Retain the original volume until task, file, schedule, and Hermes-session checks pass.
