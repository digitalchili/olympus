# Standalone local self-update runner

Olympus can update a single-service Docker Compose installation without giving the application container the Docker socket. The application talks to a root-owned host runner through a bind-mounted Unix socket; the runner is installation-local and never listens on TCP.

The update path is:

1. `GET /api/updates` reads the latest GitHub Release using a read-only token (required because this repository is private).
2. `POST /api/updates/apply` sends the validated release metadata and a bearer token through the Unix socket.
3. The host runner starts one fixed updater executable. Request fields are never evaluated as shell code.
4. The updater locks to one explicit Compose project and service, pulls and verifies the release image, drains active runs, creates a consistent SQLite backup, changes `OLYMPUS_DISPATCH_IMAGE`, recreates only that service, and verifies `/api/ready`.
5. On failure after the image switch, it restores the old `.env` and recreates the old image. The backup and old Docker image remain on the host.

This is intentionally separate from `scripts/docker/update.sh`, which is only for the bundled blue/green topology.

## Prerequisites and credentials

The host needs Python 3, Docker Engine with Compose v2, and access to the private GHCR package. Use three distinct values:

- `OLYMPUS_DISPATCH_GITHUB_TOKEN`: a fine-grained GitHub token or GitHub App installation token with **Metadata: read** and **Contents: read** on `leakim69/olympus-dispatch`. This is passed only to the application and lets the GitHub Releases API see the private repository.
- A host Docker credential for `ghcr.io` with **Packages: read** (and private-repository access). Authenticate the same OS account that runs the systemd service; the supplied service runs as root:

  ```bash
  printf '%s' "$GHCR_READ_TOKEN" | sudo docker login ghcr.io -u YOUR_GITHUB_USER --password-stdin
  ```

- `OLYMPUS_DISPATCH_UPDATE_TOKEN` / `OLYMPUS_UPDATER_TOKEN`: the same random installation-local bearer secret on both sides. Generate it with `openssl rand -hex 32`. Do not reuse either GitHub credential.

A Git tag is not enough for update discovery. The repository must contain a GitHub **Release** newer than the installed `package.json` version. `.github/workflows/release.yml` creates that Release only after its multi-architecture image is published successfully.

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

Validate the update command without changing Docker state:

```bash
sudo sh -c 'set -a; . /etc/olympus-dispatch-updater.env; set +a; \
  /opt/olympus-dispatch-updater/docker_compose_update.sh --version 0.3.1 --dry-run'
```

Use a plausible semantic version in the dry run; it is not fetched or applied.

## 3. Mount and configure the socket in Olympus

Add only the following to the existing Olympus service. Keep all existing volumes and environment values:

```yaml
services:
  olympus-dispatch:
    environment:
      OLYMPUS_DISPATCH_GITHUB_REPOSITORY: https://github.com/leakim69/olympus-dispatch.git
      OLYMPUS_DISPATCH_GITHUB_TOKEN: ${OLYMPUS_DISPATCH_GITHUB_TOKEN}
      OLYMPUS_DISPATCH_UPDATE_SOCKET: /run/olympus-dispatch-updater/update.sock
      OLYMPUS_DISPATCH_UPDATE_TOKEN: ${OLYMPUS_DISPATCH_UPDATE_TOKEN}
    volumes:
      - /run/olympus-dispatch-updater:/run/olympus-dispatch-updater
```

Put the two application-side secrets in its existing protected `.env` (mode `0600`). Do not mount `/var/run/docker.sock` into Olympus.

Start the runner before reconciling the Compose service so the bind-mount source exists:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now olympus-dispatch-updater.service
sudo systemctl status --no-pager olympus-dispatch-updater.service
sudo test -S /run/olympus-dispatch-updater/update.sock
curl --unix-socket /run/olympus-dispatch-updater/update.sock \
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
  node -e 'const fs=require("fs"); for (const k of ["OLYMPUS_DISPATCH_GITHUB_TOKEN","OLYMPUS_DISPATCH_UPDATE_SOCKET","OLYMPUS_DISPATCH_UPDATE_TOKEN"]) if (!process.env[k]) process.exit(1); fs.accessSync(process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET, fs.constants.R_OK|fs.constants.W_OK)'
```

Check `Settings -> Software update`. A private-repository `404` means the GitHub token is missing/invalid or no GitHub Release exists. `Update available` remains false until the release version is greater than the installed package version.

During an update, follow the host runner and inspect the backup:

```bash
sudo journalctl -fu olympus-dispatch-updater.service
sudo find /var/lib/olympus-dispatch-updater/backups -maxdepth 1 -type f -name '*.db' -ls
```

After success, verify `/api/ready`, `/api/version`, task history, a new task, SSE streaming, schedules, and files. Do not delete the old image or pre-update database backup until those checks pass.

## Publishing the first operational release

There are currently no Releases in the private repository, so no installation can discover an update yet. For a new version, first update `package.json` and `package-lock.json` together, commit, and push a matching tag:

```bash
npm version 0.3.1 --no-git-tag-version
npm test
npm run typecheck
git add package.json package-lock.json
git commit -m 'release: 0.3.1'
git tag v0.3.1
git push origin main v0.3.1
gh run watch --repo leakim69/olympus-dispatch
gh release view v0.3.1 --repo leakim69/olympus-dispatch
```

Choose the actual next version; `v0.3.1` is an example. The release workflow rejects a tag that does not match `package.json`, publishes `ghcr.io/leakim69/olympus-dispatch:VERSION`, and then creates the GitHub Release used by the Settings check.
