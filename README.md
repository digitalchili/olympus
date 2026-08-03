# Olympus Dispatch

**Digital Chili's Hermes-first mission control for autonomous work.**

Olympus Dispatch is a private Digital Chili fork of [Minions](https://github.com/agent37-platform/minions), tailored for supervising Hermes agents across projects. It is a local-first Kanban and review cockpit — not a replacement for Codex or an IDE.

## What it does

- Create and supervise autonomous Hermes tasks
- Move completed agent work into a human review queue
- Stream visible agent activity and responses live
- Select a **server-hosted project folder** for each task
- Route new work to remote Hermes execution profiles
- Manage recurring Hermes jobs
- Browse workspace files and installed skills
- Keep task metadata in local SQLite while Hermes retains session transcripts

## Intended workflow

```text
Telegram / browser request
        ↓
Olympus Dispatch creates and tracks the task
        ↓
Hermes performs the work in the chosen workspace
        ↓
Human reviews evidence and approves, reopens, or completes
```

Codex and other coding agents remain the hands-on implementation environment. Olympus Dispatch is the control plane: task visibility, workspace context, run history, and review.

## Remote Hermes routing

Olympus uses the Hermes worker installed on the same machine by default. Remote execution profiles are optional and are loaded from deployment-owned configuration at startup; the application does not contain a fixed list of agents or business-specific routing rules.

Configure a registry with either `OLYMPUS_REMOTE_PROFILES_JSON` or `OLYMPUS_REMOTE_PROFILES_PATH`. Profile IDs, labels, gateway targets, optional default routing, and keyword rules all come from that registry. API keys remain in environment variables named by `apiKeyEnv` and are never returned to the browser.

Routing precedence is explicit profile selection, configured keyword rules, configured default profile, then local Hermes. Explicit remote routes fail closed when unavailable; ordinary unmatched work remains local when no remote default is configured.

See [remote profile configuration](docs/remote-profiles.md) and the [example registry](docs/remote-profiles.example.json).

## Quick start

**Prerequisites:** Node.js 18+ and [Hermes Agent](https://hermes-agent.nousresearch.com).

```bash
npm install
npm run dev
```

Open [http://localhost:6969](http://localhost:6969).

The default local state directory is `~/.olympus-dispatch/`:

- `data/olympus-dispatch.db` — task metadata
- `logs/` — application logs
- `workspace/` — default agent workspace
- `skills/` — Olympus Dispatch-managed skills

Set `OLYMPUS_DISPATCH_HOME` to relocate this state directory. `DB_PATH` can override the database path independently.

## Development

```bash
npm run dev      # development server on :6969
npm run build    # production build
npm run start    # run the compiled build
npm test         # worker and TypeScript checks
```

## Upstream and licensing

This repository is a private Digital Chili fork of [agent37-platform/minions](https://github.com/agent37-platform/minions), currently based on upstream `v0.1.24`.

The upstream remote is retained as `upstream` so future updates can be reviewed and merged deliberately. Olympus Dispatch retains the upstream MIT license and attribution.
