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

Olympus Dispatch source, backend, and frontend run on Michael's M4. New task execution is routed to authenticated Hermes gateway targets on the Somboon VPS:

- Som → `som-spirithouse-wine`
- Somchai → `somchai-chili-radio`
- Somboon → `default`

The browser receives only sanitized labels, descriptions, availability, icons, and remote profile names. Gateway URLs and `API_SERVER_KEY` values stay server-side.

Configure the registry with either `OLYMPUS_REMOTE_PROFILES_JSON` or `OLYMPUS_REMOTE_PROFILES_PATH`. Values may reference env vars with `$NAME`; API keys are referenced by env var name:

```json
{
  "som": { "baseUrl": "$SOM_HERMES_GATEWAY_PROFILE_URL", "apiKeyEnv": "SOM_API_SERVER_KEY" },
  "somchai": { "baseUrl": "$SOMCHAI_HERMES_GATEWAY_URL", "apiKeyEnv": "SOMCHAI_API_SERVER_KEY" },
  "somboon": { "baseUrl": "$SOMBOON_HERMES_GATEWAY_URL", "apiKeyEnv": "SOMBOON_API_SERVER_KEY" }
}
```

Hermes 0.19.1 gateway multiplexing selects profiles by URL prefix, not by a JSON body field. Set Som's `baseUrl` to the profile-prefixed gateway URL, for example `https://gateway.example.test/p/som-spirithouse-wine`. Dedicated Somchai endpoints and the default Somboon endpoint may use root gateway URLs such as `https://gateway.example.test`; Olympus appends `/v1/chat/completions` for chat requests. `remoteProfile` is display/routing metadata in Olympus Dispatch and does not switch remote gateway profiles in the request body.

If a target lacks endpoint or key configuration, it is listed as unavailable and routing to it fails closed. Existing legacy tasks with no stored `profile_name` continue to use the local worker; newly created tasks are routed only through the remote registry.

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
