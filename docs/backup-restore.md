# Backup and restore

Create a consistent standalone backup with `./scripts/docker/backup.sh`. It drains, waits idle, checkpoints and backs up SQLite, verifies `PRAGMA integrity_check`, archives non-DB Olympus state, writes metadata, then cancels drain. Hermes data is deliberately excluded.

The macOS updater performs the same SQLite checkpoint/backup/integrity check and non-database state archive automatically before switching releases. Native backups default to `~/.olympus-dispatch/backups` and can be redirected with `OLYMPUS_BACKUP_DIR`.

Native backup directories are private (mode 700); database copies, state archives and metadata use mode 600 regardless of the caller's umask. Keep the verified database if an archive fails, but do not treat that partial backup as a complete restore set.

Project secrets require both the encrypted database entries and the matching `data/project-secrets.key` from the state archive. Preserve mode 600 and the application user's ownership when restoring that key. A database-only restore cannot decrypt secrets, and Olympus fails closed if the key is missing, corrupt or insecure. Never discard or regenerate the original key to repair a restore. See [Project secrets](project-secrets.md).

Before a production update, also arrange a consistent backup of the explicitly selected Hermes home/volume using its own backup process. Olympus backups do not include Hermes profiles, transcripts or authentication state. Verify a restore into disposable state first. Preserve any newer provider credential rotation when recovering; restoring an old login snapshot can invalidate otherwise working authentication.

For a native restore, unload the LaunchAgent, copy the verified SQLite file to `~/.olympus-dispatch/data/olympus-dispatch.db` without WAL/SHM companions, extract the state archive while preserving the restored database, run `PRAGMA integrity_check` with the retained release's Node and `better-sqlite3`, then reload launchd and verify readiness, tasks, files, schedules, and Hermes sessions. Restore into a copied state directory first when space permits; retain the original until verification passes.

For restore, record current status, stop both application slots, and keep the proxy unavailable. Create a new empty Olympus state volume; never overwrite the original. Extract `*-state.tgz`, copy the verified SQLite file to `data/olympus-dispatch.db` as UID/GID 10000, and do not restore WAL/SHM files. Run `PRAGMA integrity_check` using the exact pinned image in metadata. Point Compose at the new state volume, start only the recorded active slot/image, verify directly and through proxy, then restore access. Retain the original volume until task, file, schedule, and Hermes-session checks pass.
