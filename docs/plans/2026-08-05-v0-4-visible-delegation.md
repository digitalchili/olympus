# Olympus Dispatch v0.4.0 — Visible Delegation Implementation Plan

> **For Hermes:** Implement task-by-task with `subagent-driven-development`, independent review, and evidence-backed verification. Do not deploy or update the local Hermes runtime without explicit approval.

**Goal:** Make delegated Hermes work visible and safely controllable inside Olympus: task owners can see child-agent status, progress, stall/timeout reasons, redacted tool history, and final results without exposing private prompts, credentials, or another profile's state.

**Architecture:** Olympus remains a local-first standalone application. Its existing direct Python `AIAgent` worker remains the execution path. A narrow version-pinned worker adapter translates Hermes v0.20 lifecycle events into Olympus-owned task-agent records and SSE events. Where v0.20 outbound hooks are used, they target only an authenticated loopback Olympus endpoint, carry HMAC signatures, and are treated as a wake-up/event-delivery mechanism—not a second source of truth. Olympus SQLite remains the durable UI ledger; Hermes session state remains Hermes-owned.

**Tech stack:** React 19, TypeScript/Express, SQLite (`better-sqlite3`), Python Hermes worker JSONL bridge, Hermes Agent v0.20.0 (`v2026.8.3`), SSE, Node.js 22 for Olympus.

---

## Product scope

### v0.4.0 user-visible outcome

A task detail page gains a **Delegation** panel that shows only child work launched by that task:

- child label and immutable Hermes child/session ID
- state: `queued`, `running`, `waiting`, `stalled`, `completed`, `failed`, or `cancelled`
- start/update timestamps and elapsed duration
- structured timeout/stall reason when Hermes supplies one
- a compact final result or failure summary
- redacted tool progress/history only; never raw prompts, secrets, credentials, or private profile memory
- controls limited to **Wait**, **Reconnect**, and **Cancel**, each visible only when the current child state permits it

The parent task keeps its existing successful-run-to-review behavior. The panel is observability and bounded control; it must not turn Olympus into a remote multi-tenant control plane.

### Explicit non-goals

- No remote host discovery, synchronisation, fallback, or shared state.
- No external A2A agents in v0.4.0.
- No public webhooks or user-entered arbitrary webhook URLs.
- No changes to existing Hermes profiles, secrets, models, or gateway configuration until a separate approved runtime-upgrade step.
- No exposure of tool arguments, tool output, system prompts, credentials, private memories, or hidden child transcripts.
- No direct reads/writes against Hermes SQLite internals.
- No automatic runtime update, installer change, release tag, deployment, or production restart as part of this plan.

### Context Handoff (first v0.4.0 feature)

Olympus tasks are the durable work objects; Telegram and other supported Hermes channels are transient surfaces. Add an explicit, local-only handoff flow rather than silently ingesting all conversation history.

- **Send to Olympus:** a Telegram/Hermes action creates or updates an Olympus task with a compact, source-backed handoff bundle: goal, confirmed decisions, current status, open questions, next action, source-session reference, and declared file/link/artifact references.
- **Continue in channel:** deferred to a follow-on slice until a public Hermes channel-delivery API is verified and pinned. It must remain explicit, destination-locked to the stored origin, preview-first, and never mirror every task event.
- **Canonical identity:** create an immutable local work-item reference (`olympus-task:<task-id>`) and store it with the task, handoff, and source session mapping.
- **Authoritative sources:** record repository path plus optional Git revision, task artifact IDs, and Hermes session references. If a referenced local file is uncommitted or absent from the installed release, say so explicitly; never imply it is published or deployed.
- **Bounded sharing:** handoff is only between the selected local Hermes installation and Olympus instance. It must not search all Telegram history, expose one profile's private memory to another profile, synchronise M4/VPS state, or create a public webhook endpoint.

## Acceptance criteria

1. Olympus starts against the supported Hermes v0.20 runtime through its direct Python worker, with an explicit version/capability check and a useful incompatibility response.
2. A parent task can receive a child lifecycle update and persist an Olympus record keyed by parent task ID plus immutable child ID.
3. Duplicate, out-of-order, or replayed lifecycle events do not create duplicate children or move a child backwards in state.
4. The task detail page shows the correct child state, duration, latest safe progress, and final/error summary after page refresh.
5. Child controls call only the Olympus worker adapter, validate parent-task ownership, and reject invalid state transitions.
6. Tool history shown in the UI is explicitly redacted/allowlisted and bounded in length.
7. Event ingestion rejects a bad HMAC, stale timestamp, replayed delivery ID, unknown task, or non-loopback sender without persisting an event.
8. Existing tasks, chat SSE, steering, scheduled tasks, profiles, collaboration, and task review transitions retain their present behavior.
9. `npm test`, `npm run typecheck`, and `npm run build` pass under Node 22.22.3. Targeted Python-worker checks pass using the selected Hermes v0.20 runtime.
10. An explicit channel-to-Olympus handoff creates or updates exactly one local task, persists a compact handoff bundle, and records an immutable work-item ID plus source-session reference.
11. Handoff data is bounded, profile-scoped, source-backed, and does not expose unrelated conversation history or private memory.
12. The plan explicitly defers task-to-channel delivery until a public Hermes delivery capability is verified; no direct `AIAgent` chat is misrepresented as a Telegram/channel send.
13. File references declare their local path and Git/install state accurately, including uncommitted or not-in-release status.

## Data model

Add Olympus-owned tables rather than extending Hermes persistence:

```sql
CREATE TABLE IF NOT EXISTS task_agents (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  hermes_child_id TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  stall_reason TEXT,
  timeout_reason TEXT,
  result_summary TEXT,
  error_summary TEXT,
  tool_history_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(task_id, hermes_child_id)
);

CREATE TABLE IF NOT EXISTS task_agent_deliveries (
  delivery_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  task_id TEXT,
  event_type TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_handoffs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  work_item_ref TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL,
  origin_channel TEXT,
  origin_chat_id TEXT,
  origin_thread_id TEXT,
  source_session_ref TEXT,
  goal TEXT,
  decisions_json TEXT NOT NULL DEFAULT '[]',
  status_summary TEXT,
  open_questions_json TEXT NOT NULL DEFAULT '[]',
  next_action TEXT,
  sources_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Status transitions are monotonic except explicit user cancellation. Persist raw inbound payloads **never**; normalize only the allowlisted fields needed by the UI.

## Task 0: Add explicit cross-surface Context Handoff

**Objective:** Make a task the durable local work object while keeping Telegram and other channels bounded, intentional entry/continuation surfaces.

**Files:**
- Modify: `server/db/schema.sql`
- Create: `server/db/task-handoffs.ts`
- Create: `server/routes/task-handoffs.ts`
- Modify: `server/app.ts`
- Modify: `server/adapters/worker-protocol.ts`
- Modify: `server/workers/hermes_worker.py`
- Modify: `shared/types.ts`
- Modify: `client/src/lib/api.ts`
- Create: `client/src/components/TaskHandoffPanel.tsx`
- Modify: `client/src/components/TaskDetailPage.tsx`
- Test: `tests/task_handoffs.test.ts`
- Test: `tests/task_handoffs_routes.test.ts`

**Step 1: Write failing persistence and boundary tests**

Cover:
- an explicit handoff creates one `task_handoffs` row and a `olympus-task:<task-id>` reference
- repeated handoff for the same origin updates the same task rather than duplicating it
- only allowlisted bundle fields are stored; arbitrary transcript content, private memory, or raw channel payload is rejected
- repository sources include path plus detected Git revision/state (`committed`, `uncommitted`, `not_in_installed_release`, or `missing`)
- a continuation cannot target a channel/thread not recorded by the selected handoff

**Step 2: Implement the bounded handoff model**

Add `TaskHandoff`, `HandoffBundle`, and `HandoffSource` types. The bundle must include only:

```ts
{
  goal: string;
  decisions: string[];
  statusSummary: string;
  openQuestions: string[];
  nextAction: string;
  sourceSessionRef?: string;
  sources: Array<{ kind: 'file' | 'link' | 'artifact'; value: string; state?: string }>;
}
```

Cap field lengths and item counts. Never use a background session search to pull unrelated Telegram history.

**Step 3: Add authenticated local routes**

Add narrow routes:

```text
POST /api/tasks/handoffs
GET  /api/tasks/:id/handoffs
POST /api/tasks/:id/handoffs/:handoffId/continue
```

The create route resolves the selected active profile and local task/workspace. The continue route must require an existing recorded origin and submit only a generated compact summary through the worker adapter. It must return a preview payload before delivery unless a user explicitly confirms delivery in the current surface.

**Step 4: Bridge the Hermes-facing action**

Expose one explicit worker action, e.g. `olympus.handoff`, rather than grant the agent broad database access. The action receives the compact bundle and calls the local Olympus route. It must be unavailable when Olympus is not local/reachable and must report that cleanly.

**Step 5: Build task-side UI**

Add a **Context** panel to the task detail page. It shows the canonical work-item reference, source session/channel, handoff summary, source files/links with state, and a **Continue in original channel** action. Do not show a full imported transcript.

**Step 6: Verify**

```bash
TSX_TSCONFIG_PATH=client/tsconfig.json node --import tsx tests/task_handoffs.test.ts
TSX_TSCONFIG_PATH=client/tsconfig.json node --import tsx tests/task_handoffs_routes.test.ts
/opt/homebrew/opt/node@22/bin/npm run typecheck
```

**Step 7: Commit**

```bash
git add server/db/schema.sql server/db/task-handoffs.ts server/routes/task-handoffs.ts server/app.ts server/adapters/worker-protocol.ts server/workers/hermes_worker.py shared/types.ts client/src/lib/api.ts client/src/components/TaskHandoffPanel.tsx client/src/components/TaskDetailPage.tsx tests/task_handoffs.test.ts tests/task_handoffs_routes.test.ts
git commit -m "feat: add local task context handoffs"
```

## Task 1: Freeze the v0.4.0 integration contract

**Objective:** Record exactly which Hermes v0.20 public APIs and event shapes Olympus will support before changing runtime code.

**Files:**
- Create: `docs/v0-4-hermes-compatibility.md`
- Modify: `server/workers/hermes_worker.py`
- Test: `tests/test_hermes_worker_resolve.py`

**Step 1: Add a failing capability test**

Assert that the worker health/capability response contains a Hermes version and boolean capabilities such as:

```python
assert payload["hermes_version"].startswith("0.20.")
assert payload["capabilities"]["subagent_lifecycle"] is True
```

**Step 2: Run the focused test**

Run:

```bash
/opt/homebrew/opt/node@22/bin/npm test -- --runInBand
python3 tests/test_hermes_worker_resolve.py
```

Expected before implementation: the capability contract is absent or the selected runtime is reported incompatible.

**Step 3: Implement a narrow capability probe**

In `server/workers/hermes_worker.py`, add a `capabilities.get` request that imports only documented Hermes public surfaces and returns an explicit compatibility result. Do not infer capability from a version string alone. Keep imports guarded so an older runtime returns a structured unsupported response rather than crashing the worker.

**Step 4: Document the pin**

In `docs/v0-4-hermes-compatibility.md`, record:
- official target: Hermes Agent v0.20.0 / `v2026.8.3`
- the exact worker APIs Olympus consumes
- the fallback behavior when a local installation has an older runtime
- that changing Hermes runtime remains an explicit installation/update action

**Step 5: Verify**

Run the focused Python test and `npm run typecheck`.

**Step 6: Commit**

```bash
git add server/workers/hermes_worker.py tests/test_hermes_worker_resolve.py docs/v0-4-hermes-compatibility.md
git commit -m "feat: detect Hermes delegation capabilities"
```

## Task 2: Add durable delegated-agent records

**Objective:** Create the Olympus data model and query layer for safe child-agent lifecycle projection.

**Files:**
- Modify: `server/db/schema.sql`
- Modify: `server/db/index.ts`
- Create: `server/db/task-agents.ts`
- Modify: `shared/types.ts`
- Test: `tests/task_agents.test.ts`

**Step 1: Write failing database tests**

Cover:
- insert/update by `(task_id, hermes_child_id)` is idempotent
- an old event cannot replace a terminal state
- an unknown task is rejected
- result and error summaries are bounded
- tool history is bounded and stores only a redacted shape

**Step 2: Implement schema migration and query helpers**

Create a small query module with operations similar to:

```ts
upsertTaskAgent(event: SafeTaskAgentEvent): TaskAgent
getTaskAgents(taskId: string): TaskAgent[]
recordTaskAgentDelivery(delivery: SafeDelivery): boolean
```

`recordTaskAgentDelivery` returns `false` for duplicates. Database migration must be additive and preserve current installations.

**Step 3: Add shared types**

Define `TaskAgent`, `TaskAgentStatus`, and `TaskAgentEvent` in `shared/types.ts`. Do not share Hermes private classes across the JSONL boundary.

**Step 4: Verify**

```bash
TSX_TSCONFIG_PATH=client/tsconfig.json node --import tsx tests/task_agents.test.ts
/opt/homebrew/opt/node@22/bin/npm run typecheck
```

**Step 5: Commit**

```bash
git add server/db/schema.sql server/db/index.ts server/db/task-agents.ts shared/types.ts tests/task_agents.test.ts
git commit -m "feat: persist delegated task agents"
```

## Task 3: Normalize and redact worker lifecycle events

**Objective:** Translate Hermes v0.20 child lifecycle events into the safe Olympus event contract.

**Files:**
- Modify: `server/workers/hermes_worker.py`
- Modify: `server/adapters/worker-protocol.ts`
- Modify: `server/adapters/hermes-worker.ts`
- Create: `server/task-agent-events.ts`
- Test: `tests/task_agent_events.test.ts`

**Step 1: Write failing redaction tests**

Use a fixture containing a fake token, path, prompt, and tool output. Assert none can appear in `SafeTaskAgentEvent`. Assert permitted fields include only label, status, timestamps, structured reason, bounded result/error summary, and an allowlisted tool name/status/duration/label.

**Step 2: Implement a pure normalizer**

`server/task-agent-events.ts` owns one pure function:

```ts
export function normalizeTaskAgentEvent(input: unknown): SafeTaskAgentEvent | null
```

It must reject unknown shapes, cap string/array lengths, strip object fields not in the allowlist, and never log raw input.

**Step 3: Bridge the Python worker**

Add a JSONL event type such as `task_agent.lifecycle`. The Python worker should emit only normalized-compatible public metadata. It must not serialize Python exception reprs or unredacted child tool history.

**Step 4: Verify**

```bash
TSX_TSCONFIG_PATH=client/tsconfig.json node --import tsx tests/task_agent_events.test.ts
python3 tests/test_hermes_worker_resolve.py
```

**Step 5: Commit**

```bash
git add server/workers/hermes_worker.py server/adapters/worker-protocol.ts server/adapters/hermes-worker.ts server/task-agent-events.ts tests/task_agent_events.test.ts
git commit -m "feat: stream safe delegated agent events"
```

## Task 4: Project lifecycle updates into Olympus SSE and APIs

**Objective:** Let the client retrieve persisted agents and receive incremental updates with existing task SSE semantics.

**Files:**
- Modify: `server/routes/tasks.ts`
- Modify: `server/events.ts`
- Modify: `server/app.ts`
- Create: `server/routes/task-agents.ts`
- Modify: `client/src/lib/api.ts`
- Test: `tests/task_agents_routes.test.ts`

**Step 1: Write failing route tests**

Cover:
- `GET /api/tasks/:id/agents` returns only the requested local task’s agents
- unknown task is `404`
- profile scope prevents cross-profile access
- a lifecycle update broadcasts a `task_agent_updated` event
- duplicate delivery emits no duplicate event

**Step 2: Implement read route and event projection**

Add only:

```text
GET /api/tasks/:id/agents
```

Use existing profile/task ownership helpers. Reuse `/api/events` for board-level changes; do not add a second global EventSource if the existing stream can carry a typed task-agent event.

**Step 3: Verify**

```bash
TSX_TSCONFIG_PATH=client/tsconfig.json node --import tsx tests/task_agents_routes.test.ts
/opt/homebrew/opt/node@22/bin/npm run typecheck
```

**Step 4: Commit**

```bash
git add server/routes/tasks.ts server/routes/task-agents.ts server/events.ts server/app.ts client/src/lib/api.ts tests/task_agents_routes.test.ts
git commit -m "feat: expose delegated agent lifecycle"
```

## Task 5: Build the task detail Delegation panel

**Objective:** Render a compact, accessible child-agent panel that survives reloads and streams live updates.

**Files:**
- Create: `client/src/components/TaskAgentsPanel.tsx`
- Create: `client/src/components/TaskAgentCard.tsx`
- Modify: `client/src/components/TaskDetailPage.tsx`
- Modify: `client/src/hooks/useTasks.ts` or the smallest existing event subscription owner
- Test: `tests/task_agents_panel.test.ts`

**Step 1: Write failing component/helper tests**

Cover status labels, elapsed time, terminal/non-terminal presentation, empty state, redacted tool history rendering, and no control shown for a terminal agent.

**Step 2: Implement minimal display-first UI**

Render an empty state only when the task has no recorded child agents. For each child, show label, state, duration, latest safe progress, reason, and final summary. Do not render an expandable raw JSON view.

**Step 3: Add live update reconciliation**

Use the persisted API for initial state and typed SSE events for updates. Updates are keyed by `TaskAgent.id`; do not append duplicates.

**Step 4: Verify**

```bash
TSX_TSCONFIG_PATH=client/tsconfig.json node --import tsx tests/task_agents_panel.test.ts
/opt/homebrew/opt/node@22/bin/npm run build
```

**Step 5: Commit**

```bash
git add client/src/components/TaskAgentsPanel.tsx client/src/components/TaskAgentCard.tsx client/src/components/TaskDetailPage.tsx client/src/hooks/useTasks.ts tests/task_agents_panel.test.ts
git commit -m "feat: show delegated agents on tasks"
```

## Task 6: Add bounded child-agent controls

**Objective:** Provide safe wait, reconnect, and cancel controls without exposing generic command execution.

**Files:**
- Modify: `server/routes/task-agents.ts`
- Modify: `server/adapters/types.ts`
- Modify: `server/adapters/hermes-worker.ts`
- Modify: `server/workers/hermes_worker.py`
- Modify: `client/src/components/TaskAgentCard.tsx`
- Test: `tests/task_agents_controls.test.ts`

**Step 1: Define transition table and write failing tests**

| Current state | Allowed control | Expected next state |
|---|---|---|
| `running` | Wait | `waiting` or unchanged while Hermes reports running |
| `stalled` | Reconnect | `running` or a surfaced adapter error |
| `queued`, `running`, `waiting`, `stalled` | Cancel | `cancelled` or a surfaced adapter error |
| terminal | none | none |

Tests must reject cross-task IDs, cross-profile IDs, terminal-control attempts, unknown agent IDs, and invalid transitions.

**Step 2: Implement explicit adapter methods**

Add methods with no arbitrary argument passthrough:

```ts
waitForTaskAgent(taskId: string, agentId: string): Promise<TaskAgent>
reconnectTaskAgent(taskId: string, agentId: string): Promise<TaskAgent>
cancelTaskAgent(taskId: string, agentId: string): Promise<TaskAgent>
```

The Python worker maps these to the pinned Hermes public lifecycle adapter. If the runtime lacks a method, return `501` with a clear capability message.

**Step 3: Implement UI controls**

Disable while a control request is in flight. Require one confirmation for Cancel. Do not confirm Wait or Reconnect. Use server-returned state as authoritative.

**Step 4: Verify**

```bash
TSX_TSCONFIG_PATH=client/tsconfig.json node --import tsx tests/task_agents_controls.test.ts
/opt/homebrew/opt/node@22/bin/npm test
```

**Step 5: Commit**

```bash
git add server/routes/task-agents.ts server/adapters client/src/components/TaskAgentCard.tsx tests/task_agents_controls.test.ts
git commit -m "feat: control delegated task agents"
```

## Task 7: Add optional signed loopback webhook ingestion

**Objective:** Use Hermes v0.20 signed outbound events as a resilient wake-up path without relying on public networking.

**Files:**
- Create: `server/routes/hermes-hooks.ts`
- Create: `server/hermes-hook-security.ts`
- Modify: `server/app.ts`
- Modify: `.env.example`
- Modify: `docs/v0-4-hermes-compatibility.md`
- Test: `tests/hermes_hooks.test.ts`

**Step 1: Write security tests before implementation**

Cover valid signature, invalid signature, stale timestamp, replayed delivery ID, wrong event type, non-loopback forwarded address, oversized body, and disabled configuration.

**Step 2: Implement loopback-only route**

Add a private route such as:

```text
POST /api/internal/hermes-hooks
```

Requirements:
- disabled unless a secret exists in the local installation environment
- accept only loopback requests
- verify HMAC-SHA256 before parsing/persisting the payload
- record delivery IDs idempotently
- accept only declared lifecycle event types
- enqueue projection through the existing adapter/event normalizer
- never log request body or signature

**Step 3: Document configuration without leaking values**

Document variable names and local-only target pattern in `.env.example`; do not add real secrets to source or print a secret in tests.

**Step 4: Verify**

```bash
TSX_TSCONFIG_PATH=client/tsconfig.json node --import tsx tests/hermes_hooks.test.ts
/opt/homebrew/opt/node@22/bin/npm test
```

**Step 5: Commit**

```bash
git add server/routes/hermes-hooks.ts server/hermes-hook-security.ts server/app.ts .env.example docs/v0-4-hermes-compatibility.md tests/hermes_hooks.test.ts
git commit -m "feat: ingest signed Hermes lifecycle hooks"
```

## Task 8: Integration rehearsal and release preparation

**Objective:** Prove v0.4.0 works against an isolated local Hermes v0.20 environment without altering the active installation.

**Files:**
- Create: `tests/hermes_v020_integration.py`
- Modify: `docs/development.md`
- Modify: `README.md`
- Modify: `package.json` only if a deliberate version bump is approved

**Step 1: Isolated runtime rehearsal**

Create an isolated temporary `HERMES_HOME`, Hermes state directory, and Olympus `OLYMPUS_DISPATCH_HOME`. Do not point tests at `~/.hermes` or the currently running Olympus instance.

**Step 2: End-to-end scenario**

1. Create a local task.
2. Start a parent agent that delegates a child.
3. Verify child created/running lifecycle appears in Olympus.
4. Simulate or induce a safe terminal child result.
5. Reload the task and verify durable display.
6. Verify a duplicate delivery does not duplicate a card.
7. Verify an invalid signed webhook is rejected without state changes.
8. Cancel an eligible test child and verify its final state.

**Step 3: Full verification**

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm test
npm run typecheck
npm run build
python3 tests/hermes_v020_integration.py
```

**Step 4: Review gate**

Run separate spec-compliance and security/quality reviews. Specifically inspect for secret leakage, cross-profile data exposure, unbounded event storage, raw child prompt/tool output exposure, and unapproved runtime/update actions.

**Step 5: Release decision**

Only after review passes, propose:
- the version bump to `0.4.0`
- release notes
- a GitHub tag/release
- installation/runtime upgrade instructions

Wait for explicit approval before any of those side effects.

## Rollback and recovery

- Feature-flag the panel and hook ingestion separately in Olympus configuration.
- If the Hermes v0.20 probe fails, hide controls and show an explicit unsupported-runtime notice; retain ordinary chat/tasks unchanged.
- If hook ingestion fails, preserve existing direct worker/SSE operation; do not block task execution.
- Migration is additive. Rolling back application code leaves `task_agents` and delivery rows inert; never drop them automatically.
- Disable hook ingress and revoke/regenerate the installation-local shared secret if signature verification anomalies occur.

## Verification checklist

- [ ] Task agent records are idempotent and profile-scoped.
- [ ] Event payloads are redacted, bounded, and no raw payload is logged.
- [ ] Bad/replayed/stale signed events are rejected.
- [ ] Existing chat SSE, steering, queued sends, scheduled tasks, and collaboration tests still pass.
- [ ] Child status persists across page reload.
- [ ] Control endpoints reject invalid ownership/state transitions.
- [ ] Full test/typecheck/build pass using Node 22.22.3.
- [ ] Isolated v0.20 integration rehearsal passes without touching active Hermes/Olympus state.
- [ ] No runtime update, release, tag, deployment, or restart occurs without explicit approval.
