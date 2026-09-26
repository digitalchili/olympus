# Olympus Reliability Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. A single inexpensive implementer working sequentially is the intended execution method. Steps use checkbox (`- [ ]`) syntax for tracking. Read the shared spec and the current task's plan before editing.

**Goal:** Track the improvements from the 2026-09-26 OpenAI, stopped-task/retry, GitHub reliability and response-performance review. Authentication shipped in v0.7.19. The user subsequently approved GitHub publication and task reliability hardening (G1–G3, R1–R4); that continuation passed local implementation, independent review and integrated verification. The full performance package remains pending.

**Architecture:** Keep Olympus's existing Hermes-first design. Repair credential lifecycle, worker/SSE failure handling and Git publication recovery. Add a small OAuth bridge/card, shared SSE writer, durable publication receipt and opt-in stage timings. Remove optional catalog blocking and unused repository diagnostics while preserving safety checks.

**Tech Stack:** Node `>=22.22 <26`, TypeScript/Express/SQLite, Python/Hermes, React 19, Git CLI, GitHub App integration, Docker.

**Spec:** [Shared design and acceptance contract](../specs/2026-09-26-reliability-improvements-design.md).

**Historical authentication implementation note — 2026-09-26 (before the v0.7.19 release):** Shared-default OpenAI sign-in, an explicit separate-profile option, native renewal compatibility, and OpenAI-specific reconnect presentation are implemented locally. See [OpenAI authentication evidence](../../testing/openai-authentication.md) and the updated [authentication contract](2026-09-26-openai-authentication.md). This note does not mark all 15 tasks complete or claim a commit, Docker build, deployment or resolution of the reported production incidents. Broader retry/liveness/SSE, GitHub and performance tasks remain pending.

## Global Constraints

The spec's twelve Global constraints apply verbatim. Keep work local and scoped; preserve user data/history; no live credentials, model calls, GitHub writes, installation updates or deployments during automated verification. No task execution timers or arbitrary replay. A real deployment follows `AGENTS.md`/`INSTALL.md` and requires the selected host/volumes and explicit approval after dry-run. No package version bump, release tag or remote push is authorized by this planning handoff.

## Review Focus

- Shared-root token rotation and named-profile reconnect have different storage ownership: A1/A2.
- A failed readiness probe is not proof that an agent process exited: R1.
- Retry after an accepted remote push must retain exact SHA, target and action: G1.
- OAuth helper completion, profile switching, scheduled dispatch and cancellation can race: A2/A3.
- Snapshot backpressure, queued recovery and reload must agree about whether work is running: R3/R4.

## Read this first

Repository: `/Users/michael/Dev/Olympus`. Reviewed baseline: **`1f81b95` / v0.7.18**, clean `main` when planning began. The package began as documentation only; authentication subsequently shipped in **v0.7.19 / `1dd01b2`**. R1–R4/G1–G3 passed local verification on `codex/production-hardening` from that released baseline. See [the integrated evidence](../../../qa/reliability-2026-09-26.md) for the current status. The affected installation is Docker/server, but its actual image, logs and account arrangement have not been inspected.

Read in this order:

1. Repository `AGENTS.md` (binding engineering/installation constraints).
2. [Shared design](../specs/2026-09-26-reliability-improvements-design.md).
3. This execution/checkpoint document.
4. Only the current subsystem plan and its named source files.

| Plan | Tasks | Deliverable |
|---|---|---|
| [Task reliability](2026-09-26-task-reliability.md) | R1–R4 | Non-destructive health, useful failure actions, honest queued recovery, reliable SSE |
| [OpenAI authentication](2026-09-26-openai-authentication.md) | A1–A3 | Compatible renewal fixes, private cancelable device flow, shared-default sign-in and explicit separate-profile reconnect |
| [GitHub publication](2026-09-26-github-publication.md) | G1–G3 | Durable exact-commit retry, scoped credentials, honest push/sync presentation |
| [Response performance](2026-09-26-response-performance.md) | P1–P4 | Measured first-response latency, nonblocking model discovery, lighter source/evidence reads, controlled comparison |
| This document | V1 | Integrated verification, review evidence and rollout handoff |

The findings and expected fixes are fully described in the spec. Do not repeat the broad codebase audit or rely on temporary scripts from the prior review. Implement durable regression tests instead.

## Scope coverage

| Reviewed improvement | Implementation ownership |
|---|---|
| Shared OpenAI refresh storage/locking defect in Docker pin | A1 |
| Native auth errors lose reconnect/temporary-failure meaning | R2, A2 |
| No in-app shared/default or separate-profile OpenAI reconnect | A2, A3; shipped in v0.7.19, live acceptance tracked separately |
| A slow health probe kills work and globalizes failure | R1 |
| Distinct provider failures collapse into generic Retry | R2, A3 |
| Queued input contradicts automatic-resume promises | R3 |
| SSE backpressure silently abandons an open browser | R4 |
| Lost push acknowledgement breaks ordinary retry | G1 |
| Publishing token/hook/config boundary is weaker than source reads | G2 |
| Push success is mislabeled Deployed; default branch starts selected | G3 |
| Pull/sync expectations for existing versus new tasks | G3; existing isolation tests remain mandatory |
| Slow first response after Send versus Hermes Desktop | P1/P4 measure each stage and define a fair comparison; no current speed claim |
| Optional model discovery blocks chat dispatch and composer readiness | R1 worker handler, P2 UI/integration |
| Unused repository diagnostics and overlapping polling compete with startup | P3, preserving exact source freshness |

Not included: replacing Hermes, adding another provider, automatic whole-turn resends, a generalized job engine, new execution quotas/timeouts, a deployment monitor, PR/merge orchestration, changing branch-protection policy, or connecting to the production host.

## Execution order and progress ledger

The original package order remains below. Authentication shipped in v0.7.19. The subsequent production-hardening approval covers R1–R4/G1–G3 and their integrated checks; performance P1–P4 and live rollout remain separate:

| Order | Task | Dependencies | Status |
|---|---|---|---|
| 1 | P1 — timing instrumentation and before baseline | Preflight | Not started |
| 2 | R1 — observational liveness and reader responsiveness | Existing probe fix retained | Implemented and locally verified; see integrated evidence |
| 3 | A1 — candidate Hermes compatibility/pin | Preflight | Shipped in v0.7.19; native contracts rerun for hardening; live acceptance pending |
| 4 | R2 — failure categories/actions | R1; candidate API checked in A1 | Implemented and locally verified; see integrated evidence |
| 5 | R3 — queued recovery projection | R2 | Implemented and locally verified; see integrated evidence |
| 6 | R4 — SSE writer and bootstrap | R1 | Implemented and locally verified; see integrated evidence |
| 7 | P2 — nonblocking settings/catalog | P1, R1 | Not started |
| 8 | P3 — exact source identity and bounded polling | P1, R3 | Not started |
| 9 | G1 — publication receipts/reconciliation | Preflight | Implemented and locally verified; see integrated evidence |
| 10 | G2 — scoped Git credentials | G1 signatures | Implemented and locally verified; see integrated evidence |
| 11 | G3 — publication/sync controls | G1, G2 | Implemented and locally verified; see integrated evidence |
| 12 | A2 — worker OAuth manager/helper | A1; auth-only reader/admission safety | Shipped in v0.7.19; native helper rerun for hardening; live acceptance pending |
| 13 | A3 — routes/UI/task reconnect | A2; OpenAI-specific R2 mapping | Shipped in v0.7.19; task action regressions retained; live acceptance pending |
| 14 | P4 — performance acceptance/comparison handoff | P1–P3, R1/R4; A1 revision recorded | Not started |
| 15 | V1 — final integrated gates | Authorized R/G subset | Local suite/build/native/browser/review complete; Docker/live acceptance and P1–P4 pending |

For a separately authorized whole-package continuation, if A1 is blocked by unavailable/incompatible native runtime, complete independent R/G/P tasks with fake providers; record the runtime used for performance fixtures. R2 can retain its typed error mapping using mocked native attributes, but do not claim real candidate compatibility. Do not substitute another model/provider or silently redesign OAuth. A2/A3 remain gated on a verified native contract. An unavailable Desktop benchmark does not block independently tested local changes.

For authentication, use `docs/testing/openai-authentication.md`. When the broader package is resumed, update this ledger and append to `qa/reliability-2026-09-26.md`: task ID; source revision; changed files; red regression result; green command/result; native/browser/Docker evidence; skips/limitations; local commit. A local commit is a useful checkpoint, not permission to push. Preserve this planning package in the execution checkout.

## Preflight (completed for the R/G continuation; repeat only when baseline changes)

- [x] Run `git status --short --branch`, `git rev-parse HEAD`, and `git remote -v`; confirm the selected repository. Preserve unrelated work. If baseline has moved, inspect only relevant differences, mark an already-fixed requirement complete with current evidence, and do not downgrade code to the reviewed revision.
- [x] Use an isolated worktree/branch `codex/reliability-improvements` for implementation when necessary to preserve the user's working checkout. Read the worktree skill at execution time. Copy/include the uncommitted planning documents if creating a worktree from HEAD; managed worktrees do not copy uncommitted files automatically. Do not execute against a different checkout accidentally.
- [x] Confirm a supported Node and Python environment. Use existing package lockfiles and project tools. No dependency upgrade is needed outside A1's pinned Hermes candidate. If install is necessary, install only development dependencies into this execution workspace, never the running server.
- [x] Use `node scripts/run-tests.mjs <test files>` for focused tests. It makes disposable state, DB, Hermes home and Project root before importing test modules. New Python tests must be added to its explicit list; `.test.ts` files are discovered automatically. Do not run production app startup just to inspect code.
- [x] Run one focused baseline set (the continuation used the five-file set recorded in the integrated evidence): `node scripts/run-tests.mjs tests/runtime_liveness.test.ts tests/task_failure_persistence.test.ts tests/automatic_recovery.test.ts tests/reconnect_chat.test.ts tests/project_cp_safety.test.ts tests/project_empty_repository.test.ts tests/test_worker_usage.py tests/test_worker_providers.py`. Record failures as baseline evidence; do not repeatedly rerun a flaky full suite before beginning.

## Task V1: Integrated verification and review handoff — R/G local gates complete

**Files:** Create/update `qa/reliability-2026-09-26.md` and `qa/response-performance-2026-09-26.md`; update `docs/coding-harness.md`, `docs/project-task-workspaces.md`, and affected AGENTS contracts to match implemented behavior. Do not erase historical version notes; clearly label old behavior and the new contract.

**Current evidence:** [Integrated R/G report and pending Docker checklist](../../../qa/reliability-2026-09-26.md). The unchecked Docker and P4 steps remain outstanding; browser completion below refers to R/G fixtures, with authentication UI evidence retained from v0.7.19.

**Output:** A tested local branch with reproducible evidence, no unresolved high-impact correctness findings, and a separate pending live-acceptance checklist. No success claim for unexecuted native or deployment checks.

- [x] **Run each new failure regression at least once before and after its fix.** Keep tests behavior-based: real local Git for uncertain pushes; actual Node stream buffering for SSE; fake native/HTTP/stores plus candidate-native contracts for auth; process identity/race fixtures for lifecycle. Static source-string assertions alone do not prove these behaviors.
- [x] **Run the final standard gate once after integration:**

  ```sh
  npm test
  npm run typecheck
  npm run build
  npm run lint:shell
  git diff --check
  ```

  Expect zero failures and successful exit for each. There is no general linter in this repo. Do not add one. Repeat a check only after relevant changes/failures. `npm run typecheck` emits server build output by existing design; generated artifacts should remain ignored.

- [x] **Run native candidate contracts without the default skips.** Use the isolated candidate source path from A1 as `OLYMPUS_NATIVE_HERMES_SOURCE` for `tests/test_worker_recovery.py`, `tests/test_background_work_native.py`, and `tests/test_project_github_worker.py` through the isolated runner. Run `tests/test_worker_usage_native.py` and new `tests/test_worker_openai_auth_native.py` with that source as explicit argument under the candidate's test Python/dependencies. Use temporary profile/default stores and mocked HTTP. Also exercise `tests/hermes_021_native_interactions_test.py` with the selected native source on its import path and disposable state. Write exact runtime/path/commands to the evidence report; do not point at or alter the installed live Hermes directory.
- [ ] **Validate candidate Docker packaging.** Build the changed image locally with temporary state/volumes only. Verify selected native source/image digest, new Python helper assets, ready/drain behavior, worker responsiveness during auth/model-list operations, and clean restart with pending publication receipts. Keep fake authentication/provider HTTP. Read the existing Docker E2E harness before invoking it: it contains disposable installers and must be confined to its unique test resources, never reused with live `.env` or volumes. If Docker is unavailable, mark this gate incomplete and do not label the image release-ready.
- [x] **Complete browser acceptance using disposable fixtures.** OpenAI card: status/check/start/cancel/expiry/wait-for-idle/save/profile-switch/reload. Task: auth versus quota/model failure, preserved unsent draft, queued pause/removal/send, no unsolicited task POST. Streams: large bootstrap and lost terminal event recover correctly. Git: both interfaces, task-branch default, exact pending target, resume/abandon, successful push labels, baseline-only sync. Stop fixture servers afterward.
- [x] **Inspect the final diff.** All product changes must map to a task in this package. No credential fixtures, local state, temporary scripts, native checkout changes, unrelated formatting, version bump or generated bundles are included. Add regression tests for a discovered interaction rather than weakening assertions.
- [ ] **Include P4 performance evidence.** Report Send-to-first-activity and Send-to-first-answer separately from verification completion, with before/after fixtures and exact revisions. Confirm diagnostics are opt-in and contain no sensitive content. Preserve source identity, selected model/reasoning and recovery safety. State explicitly whether a real Hermes Desktop comparison occurred; do not turn synthetic timing into a production speed claim.
- [x] **Obtain one final independent review where available.** Focus on auth ownership/cancel-save races, worker generation safety, exact-ref Git recovery and credential transport. A stronger reviewer at this final gate is more economical than expensive broad reviews after every small task. If unavailable, record that limitation; do not invent independent review evidence. Fix actionable findings and rerun affected checks before finishing.
- [x] **Report completion precisely.** List tasks done/blocked, source commits, selected Hermes tag/digest, tests and skipped gates, UI evidence, and remaining operational checks. State explicitly that code is local and whether any commit/push/deployment occurred. Do not say the server disconnects are solved until live acceptance supports that claim.

## Later live rollout checklist — a separate approved operation

This is a plan for a later operator, not authorization to contact a host now.

1. Michael identifies the exact Docker installation/host and existing Hermes/Olympus volumes. Read `INSTALL.md`; run its update dry-run on that selected installation and report the source/image/volumes/actions. Get the required explicit approval before non-dry-run changes.
2. Record the actual running image/revision and sanitized failure categories around one affected task. Check whether profiles share default authorization. Do not print tokens, whole environment files, transcripts or raw auth dumps.
3. Back up Olympus DB/state and Hermes state with verified restore evidence. Preserve rotated credentials during rollback: never restore an old refresh token blindly, since it may already be invalid. Confirm the new native store format can be read by the rollback version or plan a fresh user login instead.
4. Follow the repository's disposable preflight, authenticated drain-to-zero, single-writer candidate readiness, and proxy switch sequence. Do not start two live task writers or bypass volume identity/approval checks.
5. User completes any genuine OpenAI sign-in. Verify one safe task reaches review, a longer task survives readiness checks, and profile switching does not invalidate the shared login. Native renewal/concurrency tests remain separate from this short pilot; absence of a failure in one run is not proof of long-term stability.
6. Use a separately authorized test repository/branch for real GitHub scope, protected/default branch behavior, and push status. Do not simulate uncertain writes on an important production branch. Confirm deployment independently if a webhook exists.
7. Monitor meaningful operational categories (`worker_heartbeat_failed`, real `worker_restarted`, safe auth codes, publication receipt outcomes). No tokens/raw provider errors in logs. Return source/local/native/live evidence separately.
8. If Michael wants a live speed comparison, follow P4's matched settings/versions procedure on the expressly selected installations. Record first-response stage timings and Docker CPU/memory/storage/network conditions. Enable diagnostics only for that selected operation and disable them afterward. No real model benchmark calls or other installation access are authorized by the planning request.

## Copyable executor prompt

> Read `docs/superpowers/plans/2026-09-26-reliability-handoff.md`, its linked design, and `qa/reliability-2026-09-26.md` before editing. Authentication shipped in v0.7.19; R1–R4/G1–G3 are the authorized hardening continuation. Inspect the current branch and evidence rather than reimplementing completed work. Performance P1–P4 and live rollout remain separate: continue only the subset the user next requests. For a requested performance continuation, record the P1 baseline before optimizing and keep model/reasoning unchanged. Preserve existing work, add failing regressions first and use disposable state. Update the relevant evidence and ledger. Do not deploy, update installed Hermes, use real credentials, push to GitHub or replay tasks automatically. Distinguish source/native fixtures, Docker runtime checks and live acceptance; report pending checks without claiming all 15 tasks complete.

## When the implementer needs help

Escalate a concrete failing fixture/interface mismatch rather than restarting the design: native token ownership/API differs from A1; a receipt cannot distinguish accepted publication without changing intent; a worker/save race cannot be covered under current locks; or the Docker candidate breaks native continuation contracts. Provide the task ID, smallest reproduction, expected/actual behavior, and proposed bounded adjustment. Routine naming/formatting and ordinary local tests do not need renewed approval.
