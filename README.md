# Olympus Dispatch

**A local-first, standalone workspace for Hermes Agent.** Olympus Dispatch gives one local Hermes installation a focused control plane for profiles, tasks, channels, skills, files, and safe self-updates. It keeps task metadata in local SQLite and imports Hermes `AIAgent` directly through its Python worker, preserving chat streaming, goals, compaction, model defaults, steering, skills, files, and scheduled tasks.

Olympus never discovers, synchronizes with, or falls back to another host or Hermes installation.

## Install with Hermes Agent

Paste this into a Hermes conversation:

> Install Olympus Dispatch from https://github.com/digitalchili/olympus on this machine only. Read INSTALL.md first. Run a dry-run, report what will be changed, and wait for approval before installing. Do not connect to or alter any other Hermes installation or host. Preserve Hermes state and credentials, then verify /api/ready.

See the full [installation instructions](INSTALL.md).

## Quick start

Prerequisites are Node.js 22.22–25 (Node 22 LTS recommended) and an installed Hermes Agent checkout/venv.

### macOS

```bash
git clone https://github.com/digitalchili/olympus.git
cd olympus
./scripts/macos/install.sh
```

The installer discovers Hermes at `~/.hermes/hermes-agent`, builds production assets, installs a per-user LaunchAgent, and checks `/api/ready`. Preview it with `./scripts/macos/install.sh --dry-run`.

### Docker or Dokploy host

```bash
git clone https://github.com/digitalchili/olympus.git
cd olympus
./scripts/docker/install.sh
```

The installer identifies a sole running named volume mounted at Hermes `/opt/data`, prints only its volume name, asks before reuse, writes a mode-600 `.env`, and verifies readiness. Use `--hermes-volume NAME` when discovery is ambiguous or `--yes` for confirmed automation.

Open `http://127.0.0.1:6969` by default. Set `OLYMPUS_DISPATCH_BIND_ADDRESS` deliberately for remote access.

## Local Hermes profiles

Olympus discovers the default profile and valid named profiles from the Hermes installation on the same machine. `GET /api/profiles` never reads profile endpoints or configuration belonging to another installation.

Tasks use the default local Hermes worker unless a local profile is selected explicitly. Each selected named profile runs in its own isolated, lazily started worker with that profile's Hermes home, settings, sessions, and credentials.

## Development

```bash
npm ci
npm run dev
npm test
npm run build
```

See [INSTALL.md](INSTALL.md), [Docker operations](docs/docker.md), [Dokploy](docs/dokploy.md), [upgrades](docs/upgrading.md), the [standalone local self-update runner](docs/standalone-self-update.md), and [development notes](docs/development.md).

Olympus Dispatch is based on the MIT-licensed Minions project.
