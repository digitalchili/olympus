# v0.7.12: automatic verification repair

An executed check failure after a successful task response now queues a normal agent follow-up. The server supplies the failed command, recent redacted output, source directory and verification timezone as untrusted diagnostics. The agent is instructed to repair within the user's task scope; Olympus reruns required checks before review. Publication still requires its existing authorization and checks.

Pending repair uses the existing durable recovery record. Restart and browser reload preserve it. Queued human messages and unanswered interactions take priority. Pause cancels pending repair, and Stop wins during both check admission and source freshness checks. Duplicate manual requests cannot erase pending repair. Native Hermes continuations preserve mandatory verification throughout a repair chain. An unchanged failing repair becomes an actionable blocker; progressing repairs have no fixed attempt cap.

Verification evidence:

- Ten regression tests use temporary Git repositories, real failing/passing verification commands and a simulated agent. They cover automatic repair to review, no-progress blocking, more than two advancing repairs, native iteration recovery, duplicate manual admission, human queue priority, restart, Stop during check admission, and stale asynchronous source snapshots.
- Reproduced the missing automatic queue, Stop races, native continuation check skipping, and discarded pending repair before their fixes; the final ten tests pass.
- The actual React checks panel browser fixture passes with `?repair=1`: visible queued repair, disabled duplicate checks, working Pause, then the existing progress, completion timestamp, failed-output and rejected-request checks.
- Verified startup migration from the v0.7.11 schema: the new fingerprint column is added and an existing completed recovery remains unqueued.
- Full `npm test`, TypeScript checking, production build, shell syntax checks and the production dependency audit passed (zero vulnerabilities). Independent review found no remaining blockers.
- The fixture uses simulated HTTP; this is not a live model repair or production deployment test.

Run server regressions with `node scripts/run-tests.mjs tests/verification_repair.test.ts`. Run the browser fixture with `npx vite --config tests/fixtures/vite.config.ts`, then open `http://127.0.0.1:4183/tests/fixtures/coding-checks.html?repair=1`.

The live Banchii report on v0.7.11 had two failing date/time assertions. This change does not edit that repository or claim those tests are fixed. After upgrading, run checks once on an existing failed task to start the repair workflow; upgrade alone does not restart old tasks. No production restart or deployment was performed.
