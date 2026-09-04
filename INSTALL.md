# Installation

Olympus Dispatch is a **local-first, standalone** workspace for Hermes Agent. It runs beside one local Hermes installation and does not discover, sync with, or fall back to another host.

- **macOS:** runs as your user and keeps its own state under `~/.olympus-dispatch`.
- **Docker:** attaches only to the Hermes data volume you explicitly select on that same host.
- **Public releases:** `ghcr.io/digitalchili/olympus` is public; no GitHub token is required to pull a release image.

## Ask Hermes Agent to install Olympus

If you gave a Hermes Agent this repository URL, use this prompt:

> Install Olympus Dispatch from https://github.com/digitalchili/olympus on this machine only. Read `INSTALL.md` first. Run the appropriate installer in `--dry-run` mode, report what it will use, and wait for my approval before making changes. Never connect to, copy from, or configure another Hermes installation or host. Preserve existing Hermes state and credentials. Verify `/api/ready` after installation.

The agent should not paste credentials into chat, expose secrets, or enable public network access by default.

## macOS

Requirements: Node.js 22.22–25 (Node 22 LTS recommended) and an installed Hermes Agent checkout/venv.

```bash
git clone https://github.com/digitalchili/olympus.git
cd olympus
./scripts/macos/install.sh --dry-run
# After reviewing the dry run:
./scripts/macos/install.sh
curl --fail http://127.0.0.1:6969/api/ready
```

The installer discovers Hermes at `HERMES_AGENT_DIR` or `~/.hermes/hermes-agent`, builds production assets, installs a per-user LaunchAgent, and checks readiness. Releases live under `~/.olympus-dispatch/app/releases`; an atomic `current` symlink is the LaunchAgent working directory. State remains under `~/.olympus-dispatch` and uninstall preserves it.

## Docker with existing Hermes data

Run this on the same Docker host as the Hermes data you intend to use:

```bash
git clone https://github.com/digitalchili/olympus.git
cd olympus
./scripts/docker/install.sh --dry-run --hermes-volume YOUR_VOLUME
# After confirming that volume belongs to this local Hermes installation:
./scripts/docker/install.sh --hermes-volume YOUR_VOLUME
./scripts/docker/status.sh
```

Without `--hermes-volume`, the installer proceeds only when exactly one running named volume is mounted at `/opt/data`; otherwise it fails closed. Confirmation remains required unless `--yes` is supplied. It creates/checks the external Olympus state volume, writes mode-600 local secrets and immutable per-slot image pins, and starts only its own containers. Dry-run performs no writes or Docker mutations.

The listener defaults to `127.0.0.1:6969`. Set `OLYMPUS_DISPATCH_BIND_ADDRESS` deliberately if remote access is required.

## Storage Configuration

By default, Olympus stores all repositories, agent sessions, and state locally on the VPS host or local Mac/Linux filesystem.

If you want to use an attached volume (e.g. Hetzner Cloud Volume, AWS EBS) or store repositories on another server using SSH (SSHFS/NFS), see [Storage Options & Configuration](docs/storage.md) for step-by-step instructions.

`/api/health` is liveness. `/api/ready` includes Hermes readiness and returns 503 while draining. Before acceptance, run a test task, observe SSE, and confirm successful work moves to review.
