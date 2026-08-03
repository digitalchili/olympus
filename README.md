# Olympus Dispatch

Hermes-first task management with a Kanban review UI. Olympus Dispatch keeps task metadata in SQLite and imports Hermes `AIAgent` directly through its Python worker, preserving chat streaming, goals, compaction, model defaults, steering, skills, files, and scheduled tasks.

## Quick start

Prerequisites are Node.js 22.22–25 (Node 22 LTS recommended) and an installed Hermes Agent checkout/venv.

### macOS

```bash
gh repo clone leakim69/olympus-dispatch
cd olympus-dispatch
./scripts/macos/install.sh
```

The installer discovers Hermes at `~/.hermes/hermes-agent`, builds production assets, installs a per-user LaunchAgent, and checks `/api/ready`. Preview it with `./scripts/macos/install.sh --dry-run`.

### Docker or Dokploy host

```bash
gh repo clone leakim69/olympus-dispatch
cd olympus-dispatch
./scripts/docker/install.sh
```

The installer identifies a sole running named volume mounted at Hermes `/opt/data`, prints only its volume name, asks before reuse, writes a mode-600 `.env`, and verifies readiness. Use `--hermes-volume NAME` when discovery is ambiguous or `--yes` for confirmed automation.

Open `http://127.0.0.1:6969` by default. Set `OLYMPUS_DISPATCH_BIND_ADDRESS` deliberately for remote access.

## Development

```bash
npm ci
npm run dev
npm test
npm run build
```

See [INSTALL.md](INSTALL.md), [Docker operations](docs/docker.md), [Dokploy](docs/dokploy.md), and [upgrades](docs/upgrading.md).

Olympus Dispatch is based on the MIT-licensed Minions project.
