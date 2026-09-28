# Native Hermes updates from Olympus

This helper updates the Hermes runtime selected by **one local Olympus installation**. It prepares the exact revision in that Olympus release's `hermes-runtime.json`, retains the previous source and Python environment, and changes only the selected Olympus service. It never runs `hermes update`, discovers another host, or replaces a shared Hermes checkout in place.

Only a published stable release in `digitalchili/olympus` can authorize a target. A tag without a published release is insufficient. Container installations must use the Docker/Dokploy helper instead.

## Requirements

- A local Git source installation with an identifiable revision and no local changes.
- An explicit Hermes source, Python environment, Hermes data home and Olympus state directory.
- A Hermes data home dedicated to this Olympus installation. `OLYMPUS_HERMES_UPDATER_EXCLUSIVE=1` is the operator's declaration of that ownership. Other gateways, CLIs or Olympus installations must not write this home during the update. A visible process using the selected source causes refusal.
- An installation-local authenticated updater socket, protected executable helper files, enough disk for a new source/venv and full state backup, Git, Python's `venv` support and an existing protected `uv` executable. Candidate dependencies use Hermes's committed lockfile with `uv sync --frozen --extra all --no-dev`; Python downloads are disabled.
- A fixed restart command owned by the operator. The browser cannot supply a command, path or service identifier.

All profile workers and scheduled work are drained. Native background jobs must also be absent. The helper cancels an update if work does not drain within its maintenance wait; it never kills tasks to force the update.

## Configure one macOS LaunchAgent

Use the selected Olympus installation's existing LaunchAgent, maintenance token and updater authentication. Store tokens in its protected local service configuration; do not paste them into chat, source control or a public command transcript.

The updater service needs these environment variables. Paths below are examples and must be replaced with the selected local paths.

```text
OLYMPUS_UPDATER_SOCKET=/absolute/olympus-state/updater/update.sock
OLYMPUS_UPDATER_TOKEN=<existing installation-local updater token>
OLYMPUS_UPDATER_REPOSITORY=digitalchili/olympus
OLYMPUS_UPDATER_COMMAND=/absolute/olympus/scripts/macos/update.sh
OLYMPUS_HERMES_UPDATER_COMMAND=/absolute/olympus/scripts/standalone/hermes_native_update.py
OLYMPUS_HERMES_UPDATER_MODE=native
OLYMPUS_HERMES_UPDATER_STATE_DIR=/absolute/olympus-state/updater/hermes-status
OLYMPUS_HERMES_UPDATER_RESTART_COMMAND=/absolute/olympus/scripts/standalone/hermes_macos_restart.py
OLYMPUS_HERMES_UPDATER_PLIST=/absolute/Library/LaunchAgents/com.olympus.dispatch.plist
OLYMPUS_HERMES_UPDATER_EXCLUSIVE=1
OLYMPUS_HERMES_UPDATER_UV=/absolute/local/bin/uv
OLYMPUS_HERMES_UPDATER_BASE_URL=http://127.0.0.1:6969
HERMES_AGENT_DIR=/absolute/selected-hermes-source
HERMES_PYTHON=/absolute/selected-hermes-source/venv/bin/python
HERMES_HOME=/absolute/selected-hermes-home
OLYMPUS_DISPATCH_HOME=/absolute/olympus-state
OLYMPUS_MAINTENANCE_TOKEN=<existing installation-local maintenance token>
```

Keep the runner and its helper files in the same `scripts/standalone` directory; they share a small Python module. The runner must be a separate supervised service so restarting Olympus does not stop it. Its existing `/update` and Hermes `/hermes` operations share a lock.

Olympus needs the matching `OLYMPUS_DISPATCH_UPDATE_SOCKET` and `OLYMPUS_DISPATCH_UPDATE_TOKEN`. Socket/token values are local to this installation. Never expose the socket on a network endpoint. The helper's optional `OLYMPUS_HERMES_WORKER_DIR` selects this Olympus release's packaged worker directory when helpers are copied outside the release tree; the normal source and `dist/server/server/workers` layouts are detected automatically.

The Mac restart helper reads the selected plist afresh on every attempt. It verifies the expected source, Hermes home and protected file, preserves all other plist settings, and replaces only `HERMES_AGENT_DIR` and `HERMES_PYTHON`. Later updates therefore use the runtime already selected by the preceding update even when the updater service's original environment is older.

Before installing/reconfiguring or restarting a service, run the native helper with the configured environment and the published Olympus version:

```sh
/absolute/olympus/scripts/standalone/hermes_native_update.py --olympus-version 0.7.24 --dry-run
```

Use an actually published version containing the manifest. Dry-run validates release authority, paths, ownership declaration and source cleanliness, and reports the selected local paths and target. It does not install dependencies, stop work, write state or restart anything. Review that selection and obtain the operator's approval before configuring the live service. Dependency/import preflight runs when an approved update is applied.

## Other native service managers

A Linux service can supply its own protected, fixed restart executable through `OLYMPUS_HERMES_UPDATER_RESTART_COMMAND`. It receives no command-line arguments. Its trusted environment contains:

- `OLYMPUS_HERMES_EXPECTED_SOURCE`: the source the service must currently select.
- `OLYMPUS_HERMES_CANDIDATE_SOURCE`: the replacement source directory.
- `OLYMPUS_HERMES_CANDIDATE_PYTHON`: the replacement venv executable.

The executable must support `OLYMPUS_HERMES_SERVICE_ACTION=stop|restart`. For `stop`, compare the selected installation, stop only that service, and return success only after its process and writers have exited. For `restart`, compare the current selection, atomically change only that installation's source/Python configuration, preserve Hermes home and Olympus state, and restart only that service. Return failure on a mismatch or an uncertain stop. The helper persists the verified selection for subsequent updates, then checks it against the running service after draining. A generic shell command from an HTTP request is never accepted. A concrete systemd wrapper is not included in this change.

## Update and recovery behavior

The helper creates a new immutable-by-convention candidate directory under `OLYMPUS_DISPATCH_HOME/updater/hermes-releases`. It fetches the approved full Git revision from the fixed official Hermes repository, creates a fresh venv, synchronizes the committed dependency lock with a disposable home and without provider/updater credentials, and imports Olympus's worker with disposable Hermes state. The live source and credentials remain untouched during preparation.

After draining, it creates `.hermes-update-in-progress` in the Olympus state directory. New Olympus processes see this marker and remain paused. The selected service is stopped and its selected worker processes must exit before the helper creates a private archive containing Olympus state (including the project-secrets encryption key) and Hermes data, plus a verified SQLite backup. Backups exclude the candidate source, updater files, existing backups and sockets. Keep these archives private; they contain credentials. If the selected Olympus service uses a custom `DB_PATH`, supply that same path to the updater.

After restart, the authenticated maintenance probe must verify the exact runtime revision, successful worker imports and empty active/background work. Only then is the marker removed and admission resumed. Status is durable across the Olympus restart. A lost response while resuming never triggers code rollback underneath possibly accepted new work; the helper fences the installation for local confirmation instead.

If candidate verification fails before admission resumes, the helper confirms the candidate service and selected workers have stopped. It validates the private archive's digest and paths, stages its contents, restores the saved Olympus/Hermes data and database while preserving updater/backups/source/fence paths, then reselects the previous source/Python. The previous runtime must pass the maintenance probe before admission resumes. If stopping, archive validation, state restore or restart is uncertain, Olympus stays fenced and the operation reports `interrupted`; it never restores files underneath a running writer. Backups and both source environments are retained.

For interrupted recovery, keep the admission marker in place. Inspect the protected operation receipt, backup `runtime.json` and selected service configuration locally. Stop the selected Olympus service and any other writers before considering a state restore; preserve the failed state separately. Restore the complete corresponding Olympus/Hermes backup only when its compatibility is understood, including the project-secrets key and correct database location. Select the intended source/Python, restart while still fenced, and verify through authenticated `/api/maintenance/hermes/check`. Only after a successful check should an operator remove the marker, cancel maintenance, and archive/reset the interrupted receipt. Do not clear a receipt or marker just to make the Update button available.

Dependency synchronization flags follow the [uv command reference](https://docs.astral.sh/uv/reference/cli/#uv-sync).

The implementation is covered by disposable tests for source discovery, private preflight, archive contents, failed candidate recovery, uncertain resume, stale Mac runner settings and rejection of another operation's fence. These tests are not proof that a particular live service has been configured or updated.
