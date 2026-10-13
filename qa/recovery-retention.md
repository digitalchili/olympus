# Explicit recovery retention and Hermes 0.21.7 deployment

The operator-only recovery utility handles two verified legacy failure shapes: completed tasks with saved ready child results whose native terminal delivery was dropped, and a failed foreground turn with an obsolete running marker. It preserves the exact journal snapshot and native records in `retained_recovery`; new workers include the saved results as untrusted historical context. It never replays tools, acknowledges native delivery, completes a task, alters transcripts, or removes queued follow-ups.

The utility requires an authenticated drain with zero active runs, matching task/profile and journal fingerprints, failed foreground runs, no unresolved latest-run interaction, and matching native ownership/terminal state. It takes online journal backups and holds a persistent maintenance fence across replacement. The unchanged live full Hermes maintenance check must pass. Failed repairs restore exact journal state; uncertain commit or rollback outcomes retain the fence.

## Validation (2026-10-13)

- Full `npm test`, TypeScript check, production build, and focused maintenance/queue checks passed.
- Python recovery suite: 53 tests, 49 passed and four optional native tests skipped. Coverage includes stale fingerprints, live/missing/foreign native work, exact restoration, preserved queues/failed runs, unresolved interactions, and post-commit interruption.
- Independent focused review completed; interruption and unresolved-interaction findings were fixed and regression-tested.
- Disposable Docker rehearsal used released Olympus 0.7.42 with its native Hermes 0.21.5 and real SessionDB/native delegation schema. The unchanged full maintenance check blocked before repair and passed afterward. Restarting the old container retained its drain fence.
- Replacing that stopped disposable container with the candidate on the same volume produced Olympus 0.7.44 / Hermes 0.21.7 revision `71d34bad1045610252eda02ee79549436896e784`. Saved child context, task status, unfinished state, and failed-run records were preserved. The full maintenance check passed; after verifying and removing only the owned fence, cancel-drain returned healthy readiness.

## Operator sequence

1. Verify release CI/image and intended main commit. Confirm zero foreground activity; drain, then recheck.
2. Back up Olympus and every selected Hermes profile database using SQLite online backup and integrity checks. Back up relevant persistent profile/config/state files privately on the same host; capture metadata for readback.
3. Stage the released utility plus its recovery/background-work modules. Supply an explicit JSON target manifest (`taskId`, `profile`, `hermesHome`, `fingerprint`) and a new private directory under the installation's `backups`.
4. Run `hermes_recovery_maintenance.py --targets MANIFEST --backup-dir DIRECTORY` using the selected Hermes Python and existing container-local maintenance token. Do not print the token. Require `ready: true` from the unchanged full maintenance guard.
5. Keep drain and `.hermes-update-in-progress` continuously held. Deploy the context-aware release with existing volumes/configuration. Old workers cannot consume the retained context, so never resume old workers after successful retention.
6. Verify runtime version/revision, state preservation and retained context. Remove only this operation's owned fence, cancel drain, and verify healthy readiness. If verification fails, keep fenced and investigate; do not replace journals or replay work speculatively.
