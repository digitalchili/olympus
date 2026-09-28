# Update Hermes from Olympus

Settings → Updates → **Hermes agent** shows the running version/revision and the compatible target. Updates apply to the installation and all its profiles. Olympus offers only the revision recorded in a published, stable Olympus release's `hermes-runtime.json`; it does not follow Hermes `main` or install arbitrary releases.

- **Native Mac/Linux:** the target is the Hermes revision tested with the installed Olympus release. Update Olympus first to obtain a newer compatibility target. A separate candidate source/virtual environment is prepared, then this Olympus service is restarted with it. See [native setup](hermes-native-updater.md).
- **Docker/Dokploy:** Hermes belongs to the Olympus image. The button performs a paired Olympus image replacement using the newest published Olympus release with a valid compatibility manifest. Existing persistent volumes are retained.

The interface displays progress from the installation-local host helper. An accepted request, lost connection, or elapsed time is never reported as success. Completion requires the helper's completed receipt and the running Hermes revision to match. Refreshing the page resumes observation of the durable receipt.

## One-time installation setup

This feature does not automatically grant Olympus deployment access. Reuse the selected installation's existing [Unix-socket updater](standalone-self-update.md); do not expose the Docker socket to Olympus, create a public webhook, or use a task/model to run the upgrade. Host commands and service identity are fixed in protected host configuration. The browser supplies only the confirmed release/revision.

Read `INSTALL.md`, select one installation, preserve its existing Hermes home and volumes, run the appropriate dry-run below, review its selected paths/service, and obtain approval before installing/configuring/restarting the host helper. No repository defaults refer to a particular customer's machine or Dokploy project.

### Docker Compose and Dokploy host helper

Supported topology: **one explicitly selected Compose service and exclusive ownership of its Hermes/Olympus state**. The bundled blue/green installer must continue using its existing single-writer deployment procedure; this helper does not guess its active slot. Another native Hermes process, gateway or container must not write these state directories during updates. The helper rejects a second running container sharing a writable state mount.

Install `scripts/standalone/hermes_docker_update.py` beside `update_runner.py` as protected, executable host files. Keep the existing Olympus updater command configured. Add these values to that runner's protected environment, using the chosen installation's actual values:

```dotenv
OLYMPUS_HERMES_UPDATER_COMMAND=/opt/olympus-dispatch-updater/hermes_docker_update.py
OLYMPUS_HERMES_UPDATER_MODE=docker
OLYMPUS_HERMES_UPDATER_STATE_DIR=/var/lib/olympus-dispatch-updater/hermes
OLYMPUS_HERMES_UPDATER_EXCLUSIVE=1
OLYMPUS_UPDATER_COMPOSE_DIR=/absolute/path/to/selected/compose
OLYMPUS_UPDATER_COMPOSE_PROJECT=exact-project-label
OLYMPUS_UPDATER_SERVICE=olympus-dispatch
OLYMPUS_UPDATER_COMPOSE_FILE=docker-compose.yml
```

`OLYMPUS_HERMES_UPDATER_EXCLUSIVE=1` is an operator assertion about state ownership, not a bypass for failed checks. Both `HERMES_HOME` and `OLYMPUS_DISPATCH_HOME` must be explicit environment variables in the selected container and backed by dedicated writable persistent mounts. Preserve its existing `OLYMPUS_MAINTENANCE_TOKEN`, updater socket mount/token, profile home and database/key paths.

The selected Compose file must use `image: ${OLYMPUS_DISPATCH_IMAGE}` and its `.env` must contain exactly one `OLYMPUS_DISPATCH_IMAGE=` entry. The helper replaces only that service with `--no-deps --no-build`; it does not remove volumes, run `down`, or start parallel writers. A private full state archive is retained under the helper state directory, so provision room for both state and the candidate image before enabling updates.

For **Dokploy**, set mode `dokploy` and add:

```dotenv
OLYMPUS_DOKPLOY_URL=https://your-selected-dokploy-dashboard.example
OLYMPUS_DOKPLOY_COMPOSE_ID=exact-compose-id
OLYMPUS_DOKPLOY_API_KEY_FILE=/absolute/private/path/dokploy-api-key
```

The key file must be readable only by the helper owner (mode `0600`). Never put its contents in chat, application responses or repository files. Use the narrowest Dokploy permissions available for reading/updating this selected Compose service. Dokploy must use **raw Docker Compose**, with automatic and isolated deployments disabled, and the same image variable in its saved Compose/environment. The saved `appName` must match the selected Compose project label. Source-build/Git-managed definitions require a deliberate deployment configuration change first; the helper refuses them.

The host helper updates Dokploy's saved image variable and the existing local Compose `.env`, then recreates only that selected service. It owns the update transaction directly, rather than queuing a second independent Dokploy deployment that could race recovery. Do not trigger a manual Dokploy redeploy or edit service configuration during this operation. Concurrent environment edits are rejected rather than overwritten.

Before approval, load the protected helper environment locally and run:

```sh
/opt/olympus-dispatch-updater/hermes_docker_update.py --olympus-version RELEASE_VERSION --dry-run
```

This reports the selected service, persistent state and backup location without pulling/replacing an image or creating update state. Replace `RELEASE_VERSION` with a published Olympus version. A dry-run is a configuration review, not proof of a successful deployment.

After approved setup, restart only the selected host runner/service as needed. Verify the socket rejects unauthenticated requests, `/api/ready` returns ready, and the Hermes Settings card correctly identifies the installation. A live end-to-end update still needs to be validated on that chosen installation; local unit tests do not establish VPS readiness.

## What the helper verifies

1. Official published release and exact compatibility manifest; the container's image metadata, embedded manifest and actual Hermes revision must agree.
2. Candidate imports the Olympus/Hermes bridge using disposable state, without production credentials or provider calls.
3. New work pauses; foreground, scheduled and native background work must finish. No task is killed to make an update proceed.
4. A persistent `.hermes-update-in-progress` marker keeps a restarted Olympus instance paused until verification finishes. The maintenance cancel endpoint refuses to reopen work while that marker exists.
5. The selected state is backed up privately, including Olympus's database and project-secret encryption key and Hermes's profile data. Docker stops the old writer before archiving.
6. The replacement remains paused while its actual Hermes runtime and background-work state are checked. Only verified success reopens work.

Changing `hermes-runtime.json` is a release-engineering action: run the native contract tests and container smoke checks, update the digest-pinned Dockerfile base in the same change, and publish the Olympus image before publishing its stable release. A bare tag, missing manifest or failed network check cannot authorize an update.

## Recovery

`failed` means the attempt did not complete; read its safe message. `rolled_back` means the helper verified the previous runtime after recovery. `interrupted` means the outcome or recovery requires local attention; the button remains disabled. A runner restart cannot assume an orphaned helper has stopped, so uncertain operation receipts also require review.

Keep the private operation receipt, request, previous runtime/image and backup. Do not delete the marker or press through an error just to make tasks run. Identify whether the original helper is still alive, establish that no writers are active, and verify the selected service/container and stored configuration before recovery. Never start a second updater over an uncertain one.

Docker recovery stops the candidate before restoring state and the previous image. If stopping it, restoring data, or confirming configuration ownership fails, it leaves recovery interrupted. If work might already have resumed, it does **not** restore a snapshot that could discard new work. Re-establish maintenance and inspect the current installation first.

Native recovery has additional details in [the native guide](hermes-native-updater.md), including backups and the case where a runtime rollback cannot establish data compatibility.

After deliberate recovery, verify the authenticated `/api/maintenance/hermes/check` result and expected revision while still paused; then remove only this operation's marker, cancel maintenance, and confirm `/api/ready`. Preserve the prior receipt in a private archive before clearing an interrupted helper receipt. These steps require installation-specific review; Olympus does not silently erase uncertain state.
