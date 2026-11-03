# Queued Task Startup Implementation Plan

> Execute locally with focused tests before considering deployment.

**Goal:** Remove competing automatic queue deliveries and preserve recoverable failures.

**Architecture:** Coordinate concurrent submissions of the exact same saved message at the existing server admission point. The later request waits for the first and receives the same outcome; different messages remain independently guarded. No polling, new persistent state or client changes are needed.

**Tech Stack:** Express, SQLite, React, TypeScript, Node test fixtures.

**Spec:** docs/superpowers/specs/2026-11-03-queued-start-design.md

## Global constraints

- Preserve queued content, settings, attachments, profiles, project workspace and replacement semantics.
- Do not automatically replay failed or stopped work. Do not deploy or restart production.

**Ruling:** Michael asked for a simpler solution. A shared admission result eliminates the observed conflict without changing queue ownership or introducing status polling and error persistence. If the owning connection closes before its result is known, the duplicate must receive an honest retryable error rather than an invented success.

## Review focus

- Slow initial background check: a new task produces no competing automatic send or false warning.
- New task: server starts it without a browser.
- Queue during an active run: starts after successful settlement, remains paused after failure or stop.
- Genuine admission failures: the saved request stays visible and retryable, with a meaningful error.
- Stale replacement, multiple tabs and server restart: no duplicate execution or lost request.

## Task 1: Own automatic dispatch on the server

**Files:** server/routes/task-recovery.ts and a focused admission integration test.

- [x] Write and run a failing integration test reproducing delayed admission and asserting one run with no false warning.
- [x] Test genuine pre-admission failure, different queue identities, an interrupted owner request and a saved-row read error.
- [x] Implement a small server-only change; preserve explicit manual retry and queue identity checks.
- [x] Run focused queue, startup and recovery tests, a delayed browser fixture, the repository test suite and typecheck.
- [ ] Verify the live VPS after safe deployment.

## Task 2: Historical hangs

- [x] Inspect retained historical run metadata and available logs read-only; distinguish worker restarts, iteration limits and provider errors.
- [x] Report the evidence gap for the longer hangs; avoid speculative retries or process termination.
