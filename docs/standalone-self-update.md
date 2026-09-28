# Standalone local self-update runner

Olympus can update a single-service Docker Compose installation without giving the application container the Docker socket. The application talks to a root-owned host runner through a bind-mounted Unix socket; the runner is installation-local and never listens on TCP.

The update path is:

1. `GET /api/updates` reads the latest published stable GitHub Release. Bare tags, draft releases and prereleases do not offer an update.
2. `POST /api/updates/apply` sends the validated release metadata and a bearer token through the Unix socket.
3. The host runner starts one fixed updater executable. Request fields are never evaluated as shell code.
4. The updater locks to one explicit Compose project and service, pulls and verifies the release image, drains active runs, creates a consistent SQLite backup, changes `OLYMPUS_DISPATCH_IMAGE`, recreates only that service, and verifies `/api/ready`.
5. On failure after the image switch, it restores the old `.env` and recreates the old image. The backup and old Docker image remain on the host.

This is intentionally separate from `scripts/docker/update.sh`, which is only for the bundled blue/green topology.

Settings also supports a separately configured **Hermes agent** update with a full state backup, tested runtime target and durable progress. See [Hermes updates](hermes-updates.md). The two buttons share the runner's update lock.

## Prerequisites and credentials

The host needs Python 3 and Docker Engine with Compose v2. Olympus source, releases and `ghcr.io/digitalchili/olympus` images are public; no GitHub or registry token is required for normal installation or updates.

The required credential is `OLYMPUS_DISPATCH_UPDATE_TOKEN` / `OLYMPUS_UPDATER_TOKEN`: the same random installation-local bearer secret on both sides. Generate and save it locally with mode 0600; never paste it into chat, logs or Git. Do not reuse a provider or GitHub credential. `OLYMPUS_DISPATCH_GITHUB_TOKEN` and registry credentials are optional for deliberately configured private mirrors, not prerequisites for public Olympus.

A Git tag is not enough for update discovery. The repository must contain a published stable GitHub **Release** newer than the installed `package.json` version. `.github/workflows/release.yml` creates that Release only after its multi-architecture image is published successfully.

This is optional installation setup. If Settings reports that the local update hook is unavailable, first verify the selected service's existing configuration, socket mount and runner. Do not create a second runner or switch to another installation. Prepare a dry-run and preserve both Olympus and Hermes state before changing a live deployment. Enabling the runner requires approval because it grants the application the ability to replace its own service.

## 1. Lock the updater to the live Compose project

Never infer project identity from a directory named `code`. Read it from the running container:

```bash
cd /absolute/path/to/compose/project
container_id=$(docker compose -f docker-compose.yml ps -q olympus-dispatch)
docker inspect "$container_id" --format '{{ index .Config.Labels "com.docker.compose.project" }}'
docker inspect "$container_id" --format '{{ index .Config.Labels "com.docker.compose.service" }}'
docker inspect "$container_id" --format '{{.Config.User}}'
```

Put those exact project/service values in the runner configuration. The updater always passes `docker compose -p PROJECT` and never runs `down`, `--remove-orphans`, or volume deletion.

The runner uses published images with `--no-build`. For a source-built Dokploy service, enabling it deliberately changes that service to release-image updates. Keep Dokploy's configuration consistent with that choice so a later redeploy does not select a different image. Confirm the existing volume names and private network binding before installing the runner.

## 2. Install the host runner (Linux/systemd)

From a trusted checkout of this repository:

```bash
sudo install -d -m 0755 /opt/olympus-dispatch-updater
sudo install -m 0755 scripts/standalone/update_runner.py /opt/olympus-dispatch-updater/
sudo install -m 0755 scripts/standalone/docker_compose_update.sh /opt/olympus-dispatch-updater/
sudo install -m 0644 deploy/systemd/olympus-dispatch-updater.service /etc/systemd/system/
sudo install -m 0600 deploy/systemd/olympus-dispatch-updater.env.example /etc/olympus-dispatch-updater.env
sudoedit /etc/olympus-dispatch-updater.env
```

Set:

- the exact absolute Compose directory and `.env` path;
- the exact live Compose project label and service label;
- `OLYMPUS_UPDATER_SOCKET_GID` to the application's container GID (`10000` in the bundled image);
- the generated local token;
- a root-only backup directory (the default is `/var/lib/olympus-dispatch-updater/backups`).

The supplied systemd unit creates persistent state under `/var/lib/olympus-dispatch-updater`. Keep the socket in its `socket/` directory. Unlike a systemd `RuntimeDirectory`, this host directory is not deleted and recreated when the runner restarts, so Docker's bind mount continues to point at the live socket directory.

Validate the update command without changing Docker state:

```bash
sudo sh -c 'set -a; . /etc/olympus-dispatch-updater.env; set +a; \
  /opt/olympus-dispatch-updater/docker_compose_update.sh --version RELEASE_VERSION --dry-run'
```

Replace `RELEASE_VERSION` with the published semantic version selected for this installation. The dry-run only prints the plan; it does not fetch the image, validate readiness or apply changes. Review the selected project/service and backup path before approving the live update.

## 3. Mount and configure the socket in Olympus

Add only the following to the existing Olympus service. Keep all existing volumes and environment values:

```yaml
services:
  olympus-dispatch:
    environment:
      OLYMPUS_DISPATCH_GITHUB_REPOSITORY: https://github.com/digitalchili/olympus.git
      OLYMPUS_DISPATCH_UPDATE_SOCKET: /run/olympus-dispatch-updater/update.sock
      OLYMPUS_DISPATCH_UPDATE_TOKEN: ${OLYMPUS_DISPATCH_UPDATE_TOKEN}
    volumes:
      - /var/lib/olympus-dispatch-updater/socket:/run/olympus-dispatch-updater
```

Put the application-side update secret in its existing protected `.env` (mode `0600`). Do not mount `/var/run/docker.sock` into Olympus.

Start the runner before reconciling the Compose service so the bind-mount source exists:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now olympus-dispatch-updater.service
sudo systemctl status --no-pager olympus-dispatch-updater.service
sudo test -S /var/lib/olympus-dispatch-updater/socket/update.sock
curl --unix-socket /var/lib/olympus-dispatch-updater/socket/update.sock \
  -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost/update
```

The unauthenticated probe must return `401`. Then reconcile only the named Olympus service with its existing project identity, for example:

```bash
docker compose -p EXACT_PROJECT --env-file .env -f docker-compose.yml \
  up -d --no-deps olympus-dispatch
```

## 4. Verify before using the button

Inside the running application container, verify that the socket is mounted and the configuration is present without printing secret values:

```bash
docker compose -p EXACT_PROJECT --env-file .env -f docker-compose.yml exec -T olympus-dispatch \
  node -e 'const fs=require("fs"); for (const k of ["OLYMPUS_DISPATCH_UPDATE_SOCKET","OLYMPUS_DISPATCH_UPDATE_TOKEN"]) if (!process.env[k]) process.exit(1); fs.accessSync(process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET, fs.constants.R_OK|fs.constants.W_OK)'
```

Check `Settings -> Updates`. A disabled button reporting an unavailable hook means the local runner configuration/socket must be repaired; adding a GitHub token does not fix that. `Update available` remains false unless a published stable release is newer than the installed package version. A public release lookup error should be diagnosed as release/network availability first.

During an update, follow the host runner and inspect the backup:

```bash
sudo journalctl -fu olympus-dispatch-updater.service
sudo find /var/lib/olympus-dispatch-updater/backups -maxdepth 1 -type f -name '*.db' -ls
```

After success, verify `/api/ready`, `/api/version`, task history, a new task, SSE streaming, schedules, and files. Do not delete the old image or pre-update database backup until those checks pass.

## Publishing a release

For a new version, first update `package.json` and `package-lock.json` together, commit, and push a matching tag after the required checks. Replace `NEXT_VERSION` below with the approved next version:

```bash
npm version NEXT_VERSION --no-git-tag-version
npm test
npm run typecheck
git add package.json package-lock.json
git commit -m 'release: NEXT_VERSION'
git tag -a vNEXT_VERSION -m 'Release vNEXT_VERSION'
git push --atomic origin main vNEXT_VERSION
gh run watch --repo digitalchili/olympus
gh release view vNEXT_VERSION --repo digitalchili/olympus
```

The release workflow rejects a tag that does not match `package.json`, validates a released-image upgrade/rollback, publishes `ghcr.io/digitalchili/olympus:VERSION`, and then creates the GitHub Release used by the Settings check. Publishing a release does not itself update an installation.
