# Olympus Dispatch

**A local-first, standalone workspace for Hermes Agent.** Olympus Dispatch gives one local Hermes installation a focused control plane for profiles, tasks, channels, skills, files, and safe self-updates. It keeps task metadata in local SQLite and imports Hermes `AIAgent` directly through its Python worker, preserving chat streaming, goals, compaction, model defaults, steering, skills, files, and scheduled tasks.

Olympus never discovers, synchronizes with, or falls back to another host or Hermes installation.

## v0.7.0 Bots

Open **Bots** for one persistent conversation per local Hermes profile. Bots can ask teammates for help with Hermes's native `message_agent` tool; Olympus owns the durable queue, attributed replies, Stop, and deployment drain. Bot conversations stay separate from Kanban tasks. See [Bot conversations and messaging](docs/bots.md) for usage and limits.

## v0.6.0 coding harness

Coding tasks now retain Git and check evidence before entering review. Durable child-result reconciliation and bounded continuation recover safely saved work after missed notifications or restarts. See [coding and recovery](docs/coding-harness.md) for setup, runtime compatibility and limits.

## Install with Hermes Agent

Paste this into a Hermes conversation:

> Install Olympus Dispatch from https://github.com/digitalchili/olympus on this machine only. Read INSTALL.md first. Run a dry-run, report what will be changed, and wait for approval before installing. Do not connect to or alter any other Hermes installation or host. Preserve Hermes state and credentials, then verify /api/ready.

See the full [installation instructions](INSTALL.md) and the repository’s [agent safety rules](AGENTS.md).

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

If a profile tool normally targets a Docker-only service name or another endpoint that is unreachable from the Olympus process, put only the Olympus-specific values in `<profile-home>/.olympus-dispatch.env`. Olympus applies this file after the profile's native `.env` but before external secret sources, machine-managed environment policy, and profile plugin discovery; external and managed values therefore remain authoritative. Keep the file mode `0600`; never commit it. All `HERMES_*` and `OLYMPUS_*` variables, plus core process variables such as `HOME`, `PATH`, and `PYTHONPATH`, are rejected. Restart or evict the profile worker after changing the file.

## Development

```bash
npm ci
npm run dev
npm test
npm run build
```

See [INSTALL.md](INSTALL.md), [Docker operations](docs/docker.md), [Dokploy](docs/dokploy.md), [upgrades](docs/upgrading.md), the [standalone local self-update runner](docs/standalone-self-update.md), and [development notes](docs/development.md).

Olympus Dispatch is based on the MIT-licensed Minions project.
