# Olympus Dispatch

**Digital Chili's Hermes-first mission control for autonomous work.**

Olympus Dispatch is a private Digital Chili fork of [Minions](https://github.com/agent37-platform/minions), tailored for supervising Hermes agents across projects. It is a local-first Kanban and review cockpit — not a replacement for Codex or an IDE.

## What it does

- Create and supervise autonomous Hermes tasks
- Move completed agent work into a human review queue
- Stream visible agent activity and responses live
- Select a **server-hosted project folder** for each task
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
