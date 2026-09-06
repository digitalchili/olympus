# Production readiness repairs in 0.6.3

This patch addresses the eleven defects found in the 0.6.2 audit and the Project chat merge failure. It retains the existing Hermes runtime, storage locations and single-editor Project workflow.

## Changes

| Area | Result |
| --- | --- |
| Uploads | Multi-file uploads stage changes and retain originals for rollback. A failed batch restores original bytes; a failed restoration retains its backup and reports where it is. Concurrent upload commits are serialized. |
| Docker SQLite helpers | Backup and standalone update select `/opt/olympus-node/bin/node`, matching the native SQLite module. Older images without that executable retain their original `node` fallback. |
| Maintenance | Scheduled jobs participate in drain accounting. Worker scheduling starts paused until its state is acknowledged; unknown worker state cannot count as idle. Pending task/Project operations remain counted after a browser disconnects. Disk monitoring stops writing during maintenance. |
| New coding repositories | Verification rechecks repository applicability after the agent runs. A repository created during the task requires verification evidence before review. |
| Verification ownership | Message startup, manual verification and Project mutations share ownership through awaited preparation. Checks cannot race a task using the same checkout. |
| Stop and shutdown | Stop cancels checks and waits for their process groups to settle. Deadline cleanup retains ownership while snapshots/checks settle. Shutdown cancels verification within its bounded cleanup window. Stopped work cannot automatically enter review. |
| Disk alerts | Background database failures are caught and logged without requiring another database write. Checks are serialized. A recovered incident can trigger a fresh alert immediately; dismissal retains its cooldown. |
| Test isolation | `npm test` creates separate temporary Olympus, Hermes, database and Project roots for every test program, overriding inherited installation paths. Disk tests initialize isolation before importing database modules. |
| Project synchronization | Merge conflicts report bounded filenames and recovery guidance, abort the failed merge, and preserve the current editor. Only progress proven to match a fetched remote ref advances the published baseline. A newly created local merge checkpoint remains available to Commit & Push before editor handoff. |
| Chat feedback | Project conflicts remain visible in chat while preserving the draft. Ordinary concurrent-send conflicts retain their existing reconnect behavior. |
| Dependencies | Patched DOMPurify and Mermaid dependencies; override `qs` to 6.16.0 because the current Express 4 dependency range excludes the patched minor release. |

## Verification

The regression suite uses real disposable Git repositories, API routes, subprocesses, capped SQLite databases, injected upload failures and deterministic worker scheduling fixtures. Native Hermes recovery, background-work and scheduler tests run against the pinned Hermes v2026.8.31 source in a disposable Python environment.

`npm run test:docker-e2e` creates its own volumes and proves install, drain rejection, SQLite backup integrity, a restored server containing a saved task, successful promotion, recovery from a deliberately failed proxy switch, and rollback to the prior immutable image. CI and release publishing now require this lifecycle test. Local validation also runs it as `linux/amd64` for the VPS architecture.

The disposable browser fixture in `qa/coding-harness` exercises verification Stop/retry and the real Project merge-conflict response using the built client. No model call, production profile or installation database is required.

Validated on 2026-09-06: all 125 TypeScript test programs and eleven Python suites passed. The default Python run skipped seven optional native cases; the three affected suites were rerun against the pinned Hermes source and all 41 tests passed without skips. Server/client typecheck, production build, shell syntax checks and diff checks passed. The complete dependency audit reported zero advisories. The frontend build still reports large bundles; this patch does not optimize their size.

The final AMD64 lifecycle run passed all stages above. The browser showed a user-stopped check remaining in progress, a successful retry moving to review, and visible Project conflict guidance with the original draft intact. Independent review covered each implementation area and the follow-up ownership, shutdown and error-display fixes.

An operator follow-up after publishing 0.6.3 fixes two standalone updater cases: reapplying the installed image and recovering from a replacement that failed before changing the original container. Both now cancel maintenance on the retained container before checking readiness. Regression tests execute the real updater using disposable fixtures with a stubbed Docker CLI and proved both failures before the fix. This script correction is on `main`; it is separate from the already-published 0.6.3 image and can be installed on the update host without changing the application image.

## Operating limits

This is a bounded repair and validation pass, not a claim that arbitrary agent code or every external provider is failure-free. Olympus still assumes trusted callers and deliberately has no application authentication; remote installations need their own access boundary. Shell checks can spawn programs outside the ordinary child process group, so production containment still depends on the selected host/container runtime.

Code validation and installation validation are separate. Follow `INSTALL.md`: select the existing installation, dry-run its appropriate update path, preserve its Hermes/state volumes, and obtain approval before replacing or restarting it. Verify `/api/ready` and the repaired Project workflow after the update. Never apply the portable HA configuration over a customized single-service deployment without reconciling that deployment explicitly.
