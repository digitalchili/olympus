# Hermes 0.21 Core Integration Implementation Plan

> **For Hermes:** Use subagent-driven-development with strict test-first implementation and independent spec then quality/security review.

**Goal:** Expose the approved Hermes 0.21 core workflows through Olympus, preserving existing task/project/profile boundaries.

**Architecture:** Retain Express/SQLite control state and the direct Python AIAgent JSONL adapter. Add capability-negotiated extensions, not a second gateway or scheduler. Durable user decisions belong in Olympus; Hermes owns execution and cron state. Missing native support is a typed unsupported result, never a simulated success.

**Tech stack:** Node 22, TypeScript/React, SQLite, Python/Hermes v0.21 (tag v2026.8.31, source 29112bef099274229cadff79cdff7bf7b99c4b77).

## Approved scope and authority

- Core: compatibility/capabilities, model privacy warnings and confidential Project enforcement, multi-question clarification, cron continuity/notepads/monitor/reasoning, child steering/stopping, approval inbox/preflight, and profile-scoped MCP management.
- Implement, test and independently review only. No pushes, releases, live restarts, production migrations, real profile configuration/credential writes or new paid services.
- Existing jobs/profile settings stay unchanged. New scheduling options are opt-in.
- Ordinary Projects warn; explicitly confidential Projects block training-enabled and unknown-policy tiers before dispatch. Unknown is not safe. Never infer retention guarantees from training metadata.
- No confidential context may reach an unapproved fallback or advisory/delegation route.
- Unanswered questions/approvals persist; consequential work never silently proceeds. Approval is a bounded one-action decision, not a standing blanket grant.
- Existing design, ACL, single-editor rule, compact progress and private-memory boundaries remain intact.

## Execution lanes

1. **Runtime and child controls:** add `server/workers/hermes_runtime.py`, runtime capability RPC, child list/steer/stop bridge, typed unsupported state, delegated-worker controls. Verify pinned upstream signatures before use. Tests must bind a child to its live parent and reject unknown/stale/wrong-task control. Update Docker default to a verified digest only if obtainable; never guess a digest.
2. **Privacy:** add model warning metadata from verified native selection guards, server-owned Project confidentiality, pre-dispatch/fallback safety and warning UI. Test unchanged ordinary Projects, explicit confidentiality, unknown/train/no-train metadata and all dispatch paths. Do not treat the authenticated provider inventory as privacy proof.
3. **Scheduled tasks:** extend native Hermes adapter, shared DTO, routes and form with continuity, reasoning, monitor and notepad controls. Preserve omitted fields, prior job state, profile ownership and native scheduler execution. Validate upstream API and test read/write roundtrip plus unsupported old runtimes. Never start a job to test live state.
4. **MCP:** add a profile-scoped module/RPC/API/Settings panel for redacted list/health/test and explicit reviewed config import. Use supported native APIs, retain secrets in Hermes, require explicit confirmation for imported commands/URLs, no shell interpolation or background auto-install. Report unavailable telemetry honestly. Test malformed/untrusted imports, sensitive output, profile isolation, health failure and safe merge behavior with disposable homes.
5. **Interactions:** add durable question/approval records, worker request/answer transport, visible waiting/answer UI and approval-check. Bind decisions to exact task/run/profile, validate complete answers and one-shot approval, handle worker stop/restart/expiry safely, reject stale/cross-profile replies. Browser disconnect must not lose a question. Awaiting input is not successful task completion.

Each lane follows RED -> GREEN -> broader regression checks. Use independent worktrees and feature modules; parent coordinates shared protocol/route/UI integration. Review code rather than trusting worker self-reports.

## Verification gates

1. Baseline `npm test` and inspect Git status before edits.
2. New tests fail for missing behavior before implementation, then pass. Use real SQLite/routes/worker serialization and disposable Hermes homes; injected model/tool runners only at external effects.
3. `npm test`, new Python module tests, `npm run typecheck`, `npm run build` on integrated source.
4. Exercise shipped Python/JSONL path against pinned Hermes source where available, without provider spend or touching real profile state.
5. Disposable local app/browser: question survives reload, answer validation and single-submit, denied/stale approvals, schedule settings, MCP no-secret states, ordinary/confidential privacy UI, child controls and unsupported runtime UX. Desktop/mobile checks, no overflow, keyboard focus and accessible labels.
6. Independent spec review, then security/quality review on frozen integrated diff; fix material issues and rerun checks. No claim of live deployment.

## Deferred features — reminder at core-package handoff

Michael requested a reminder, not implementation now. Bring these back up when presenting the core package:

- Project team rooms with explicit membership and durable peer conversations.
- Verification evidence panel bound to actual commands, results and exact source revision.
- Watchable isolated browser QA with retained screenshots/artifact evidence.

These are intentionally deferred, not rejected or silently included. No timed notification was requested; this checklist is the durable project follow-up and final handoff reminder.
