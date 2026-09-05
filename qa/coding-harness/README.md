# Disposable coding-harness browser fixture

Run `npm run build`, then `npx tsx qa/coding-harness/fixture.ts` from the repository root. The fixture prints two loopback URLs. It uses temporary Git, Olympus and Hermes directories with a fake adapter; no real profiles, credentials or model calls are used. Stop the fixture with SIGTERM to remove its state.

The coding URL starts with failed checks. POST `/qa/checks-pass`, click **Run checks**, and verify review promotion and a passing panel. POST `/qa/change-source` and verify the panel becomes stale after refresh. Check that there is exactly one evidence panel after repeated polling, and verify desktop and 320px layouts.

The reconnect URL starts with a live stream. POST `/qa/expire-stream` to persist an interrupted terminal run, discard the live snapshot and close SSE without sending the terminal event. Verify the browser reconnects, retrieves saved history/status, releases streaming controls and shows recovery state. Pause recovery and reload to verify that the pause persists.

These fixture-only endpoints are not mounted in the production app. Browser screenshots and CLI logs belong under `output/playwright/` and `.playwright-cli/` (ignored).
