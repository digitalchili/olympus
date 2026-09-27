# Project Secrets Implementation Plan

> **For agentic workers:** Use the shared contracts below when implementing independent components. Keep secret values out of ordinary chat and worker messages.

**Goal:** Save named credentials directly from Olympus task chat into Project Settings and let project tasks use them for local testing.

**Architecture:** A deterministic parser recognizes secret entry before normal chat, queueing, title generation or attachment upload. A dedicated API encrypts values in SQLite using an installation-local private key. A run-bound `project_run` tool supplies selected values only to a command's child environment and redacts results before returning them to Hermes.

**Tech Stack:** Existing React/TypeScript, Express, SQLite, Node crypto/child processes and Python Hermes worker. No new dependencies.

**Spec:** The approved chat design in this task: direct named-key or `.env` entry, project inferred from the task, explicit target selection for Inbox, names-only acknowledgement and Project Settings management. Olympus web UI only; no secret-saving model tool or Telegram integration.

## Global Constraints

- Preserve existing provider credentials and model settings.
- Never persist or forward a secret-entry message through normal chat, task descriptions, queues, title generation or large-paste uploads.
- Names and timestamps are public metadata; values are write-only to the UI.
- Keep the installation key private and outside repository/workspace browsable roots. Backups must preserve the key with encrypted state.
- Project deletion cascades encrypted entries. Missing/corrupt keys fail closed.
- Project access and task identity are checked server-side; a browser marker is CSRF protection, not authentication. Existing trusted-local deployment assumptions remain.
- Commands use a separate child environment, never global worker/server environment or plaintext `.env` files. No automatic task runtime limit.
- Local execution is trusted: this is not a sandbox against malicious commands, files or same-user processes. Output redaction reduces accidental exposure; it cannot prevent arbitrary transformation or transmission by executed code.

## Review Focus

- Long/malformed secret pastes must not become uploaded text files or ordinary model input.
- Explicit secret setup must work while model settings are unavailable or another message is queued.
- Simultaneous projects with the same variable names must never share values.
- Project/task reassignment, deletion and access revocation must reject stale operations.
- Partial output, errors and process cancellation must not expose secrets or leave owned subprocesses running.

## Tasks and Contracts

### 1. Parser, encrypted storage and API

- [x] Add failing parser/storage/API tests with synthetic values only.
- [x] `shared/project-secrets.ts`: `ProjectSecretEntry {name,value}`, `ProjectSecretMetadata {name,updatedAt}`, `parseProjectSecretInput(text)` returns `none`, `secrets` with entries, or `invalid` with a fixed safe error; `isProjectSecretInput(text)` blocks candidates at ordinary ingress.
- [x] Validate names, sizes, duplicates and process-control variable restrictions; parse literal dotenv values without interpolation or execution.
- [x] `server/db/project-secrets.ts`: names-only list, atomic encrypted upsert, remove, and internal selected-value read. Bind AES-GCM authentication to project/name.
- [x] `server/routes/project-secrets.ts`: GET/PUT `/projects/:id/secrets`, DELETE `/projects/:id/secrets/:name`; PUT accepts entries plus optional taskId, returns metadata/savedNames. Require `X-Olympus-Secret-Entry: 1` and same-origin browser writes; enforce operator/manage access and task project consistency.
- [x] Reject secret candidates during task creation before storing descriptions or queued requests.

### 2. Chat and Settings UI

- [x] Test interception before optimistic chat, queueing, title generation and paste uploads.
- [x] Intercept secret input before chat execution settings; show masked capture and names-only acknowledgement. Keep unrelated queue/attachments intact.
- [x] Ask for a target project when absent; do not move an Inbox task automatically.
- [x] Add names-only Project Settings list with secure add/replace and remove controls.
- [x] Keep secret values transient; clear on successful save or cancellation and ignore stale task/profile responses.

### 3. Runtime use

- [x] Add `project_run({command,secrets:[names]})` private root-run broker and adapter protocol tests.
- [x] Derive scope from the active task, check contribute access and reread current vault values.
- [x] Execute a foreground child command with a minimal environment and selected credentials. Redact captured output before sending results to Hermes.
- [x] Abort and await process-group cleanup on Stop; reject stale replies and unrelated sessions.
- [x] Reject ordinary messages, queued messages and steers containing secret-entry candidates.
- [x] Test concurrent isolation, revoked access, errors, output boundaries, cancellation and worker session ownership.

### 4. Verification and documentation

- [x] Run focused suites, then full tests, typecheck and production build.
- [x] Browser-check secure chat entry, Inbox project selection and Settings using disposable state and fake credentials.
- [x] Independent review of secret flow and leakage boundaries.
- [x] Document usage, backup/key requirements and trusted-execution limits. Do not deploy or test real credentials.


## Verification evidence — 2026-09-27

- Full `npm test` passed. Focused UI/composer and Python recovery/broker suites were rerun after the final keyboard-focus and terminal-disabled continuation fixes.
- `npm run typecheck` and `npm run build` passed; Vite retains the existing large-chunk warning. Python assets were refreshed after the final worker fix.
- Native Project command broker checks passed in a disposable, network-disabled Docker container with no user credentials or volumes; relevant Hermes source hashes matched the pinned runtime.
- Browser checks used a disposable local installation with synthetic values. Chat paste, names-only acknowledgement, Settings removal, Inbox project selection, focus containment and Cancel were verified.
- The browser fixture recorded zero model requests, zero queued messages, an unchanged task count and Inbox project, and no plaintext values in encrypted database rows.
- Independent review and regressions cover parser false positives/large input, interaction answers, clipboard upload interception, cross-project scope, missing/tampered keys, stream-interleaved output, explicit Stop and worker loss.
- This is local source/build/browser evidence. No real service credential, live installation, deployment or publication was exercised.
