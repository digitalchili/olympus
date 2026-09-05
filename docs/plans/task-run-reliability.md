# Task-run reliability repair

## Scope and authority
Implement, test and independently review only. No push, release, deployment, live config changes, or interruption of existing feature workers. Work from clean v0.5.23 in isolated worktrees; preserve the Hermes 0.21 feature checkout.

## Acceptance
1. Pinned child models cannot inherit a known incompatible reasoning effort unchecked. Use a narrow tested worker integration, not shared config mutation or approval bypass.
2. Failed/incomplete provider or child results remain failed, not completed; successful finite tasks retain review flow.
3. Runtime/idle/iteration failure, cancellation, and partial progress cannot auto-promote task to review. A trailing done frame cannot erase an error.
4. Persist a safe typed terminal blocker. UI shows unfinished/blocked state on live stream and reload, retains partial output, and pauses automatic queued followups until explicit action.
5. Before new execution of an existing failed task, verify existing task-owned background processes/delegations; reject unavailable checks or active work without consuming queue data. Preserve other tasks and all running work. Never blindly restart or kill a shared worker.
6. Keep existing finite watchdog budgets. This repair does not promise infinite agent execution or autonomous completion of arbitrary long jobs.

## Verification
Regression RED/GREEN, Python projection/native compatibility checks, route tests with a disposable SQLite store and fake worker (no model requests), migration compatibility, typecheck, full tests/build, rendered browser/API smoke, independent exact-diff review.

## Non-goals
No new scheduler, no full process supervisor, no auto-retry loop, no unrelated feature merge, no provider credentials or privacy-policy change. Arbitrary external daemons not registered to Hermes are outside the background ownership inventory.
