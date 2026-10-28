# Maintenance with saved stop markers

## Demonstrated deployment blocker

Somboon v0.7.51 reached zero active foreground runs on 2026-10-28, but its authenticated Hermes maintenance check rejected three previously stopped tasks. Each reported an available inventory with no work, an explicit stop continuation, and a saved continuation-journal receipt with zero pending delegation IDs and zero undelivered results. The attempted maintenance drain was cancelled; production was not deployed or restarted.

A separate Sweden Travel worker reports unavailable inventory and an agent import error. Its policy module exists and imports in a fresh process, but that does not prove the existing worker is idle. This remains a deployment blocker and is not covered by the stopped-task exception.

## Narrow correction

Maintenance may accept a saved stop only when the latest persisted run is stopped, or its matching recovery record explicitly records user Stop; the native inventory must be available and contain no work. The exact native stop marker and a saved, empty continuation-journal receipt are required. Active children/processes/operations, pending recovery/results, unknown inventory, other blocked reasons, missing or malformed receipts still fail closed.

All tasks including Bots remain in the inventory. Drain checks and runtime import verification remain intact. The check does not modify task status, recovery journals, queued messages, or saved work.

## Verification

- Regression failed before the change: `an explicitly stopped idle task must not prevent maintenance`.
- Focused maintenance tests pass on Node 22.22.3.
- Independent review found a malformed receipt acceptance case; its regression failed first and then passed after strict array/boolean validation.
- Full test suite, typecheck, and production build are recorded in the release validation logs.

## Deployment boundary

The old deployed guard cannot return ready for these retained stop markers. Do not erase or resume stopped journals to satisfy it, ignore the unavailable worker, or claim that candidate tests establish production readiness. A separately authorized bootstrap procedure is required while the old guard is installed. Production deployment and actual Olympus background-reply/queue acceptance remain pending.
