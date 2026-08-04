# Installation

This private repository and its GHCR package require explicit recipient access; a browser link alone is insufficient.

```bash
gh auth login
gh repo clone digitalchili/olympus
cd olympus-dispatch
```

## macOS

Install Hermes Agent and Node.js 22.22–25. Node 22 LTS is preferred automatically; Node 26 is rejected. Preview and install:

```bash
./scripts/macos/install.sh --dry-run
./scripts/macos/install.sh
curl --fail http://127.0.0.1:6969/api/ready
```

Hermes is found through `HERMES_AGENT_DIR` or `~/.hermes/hermes-agent`. Releases live under `~/.olympus-dispatch/app/releases`; an atomic `current` symlink is the LaunchAgent working directory. State remains under `~/.olympus-dispatch` and uninstall preserves it.

## Docker with existing Hermes data

```bash
gh auth token | docker login ghcr.io -u "$(gh api user --jq .login)" --password-stdin
./scripts/docker/install.sh --dry-run --hermes-volume YOUR_VOLUME
./scripts/docker/install.sh --hermes-volume YOUR_VOLUME
./scripts/docker/status.sh
```

The installer can use existing `gh` credentials automatically if the private pull initially fails. It never prints the token. Without `--hermes-volume`, it proceeds only when exactly one running named volume is mounted at `/opt/data`, and confirmation remains required unless `--yes` is supplied. It creates/checks the external Olympus state volume, writes mode-600 secrets and immutable per-slot image pins, and starts only blue plus the proxy. Ambiguous image or volume detection fails closed. Dry-run performs no writes or Docker mutations.

If GHCR access is unavailable but source access exists, build locally with `docker build -t olympus-dispatch:0.3.0 .`, set `OLYMPUS_DISPATCH_IMAGE=olympus-dispatch:0.3.0`, and install. The listener defaults to `127.0.0.1:6969`.

`/api/health` is liveness. `/api/ready` includes Hermes readiness and returns 503 while draining. Before acceptance, run a test task, observe SSE, and confirm successful work moves to review.
