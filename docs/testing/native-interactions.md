# Native task forms and pasted-text verification

This opt-in test exercises the built Olympus app, real Hermes `AIAgent` and native `clarify` tool, worker JSONL transport, SQLite, HTTP upload/download, and Chromium. Only the external model endpoint is substituted by `tests/fixtures/native_interaction_provider.py`. Its text and usage are synthetic fixtures, not live-model or billing evidence.

## Prerequisites

- Run `npm run build` first.
- An independently installed Hermes v0.21 environment and matching source checkout (release tag `v2026.8.31`). The normal npm test suite does not install Hermes.
- Playwright with Chromium already installed in a dedicated scratch location. Browser packages and binaries are not added to runtime dependencies.

```sh
python3 tests/fixtures/run_native_interactions_qa.py \
  --python /absolute/path/to/hermes-venv/bin/python \
  --hermes-root /absolute/path/to/hermes-source \
  --playwright /absolute/path/to/playwright/index.mjs \
  --browsers /absolute/path/to/playwright-browsers
```

The runner creates `.tmp-native-qa-*/` inside the checkout, starts its own loopback provider and app on available ports, waits for real health checks, runs Chromium, and terminates its owned service/worker process groups. It allowlists the child environment and replaces HOME, HERMES_HOME, Olympus home, database and TMPDIR. It does not inherit provider keys, auth homes or live profile state. It neither installs dependencies nor changes an installed app. Preserve the venv Python path rather than resolving its symlink to the base interpreter.

The printed `QA_ARTIFACTS` directory contains `evidence.json`, desktop/mobile screenshots, and provider/app/browser logs. Exit zero plus `BROWSER_FEATURES_PASS` is the positive receipt. Logs and temporary DBs are ignored by Git.

## Covered behavior

- Single-choice, multi-select, free-text and edited Other answers through native Hermes.
- Pending forms after browser reload; exact answers returned to the worker; stop closes pending input without promoting the task to review.
- Large paste as a real UTF-8 attachment, original composer preserved, inert plain-text preview, Keep inline and small-paste fallback.
- 320px action bounds, not merely document scroll width (overflow-hidden ancestors can conceal clipped controls).
- Existing-task and New Task send, navigation/reload and actual stored-file downloads preserving Unicode and CRLF bytes.
- Deliberately injected HTTP 503 upload failure, real retry upload, removal, and reattachment.
- No uncaught browser JavaScript errors.

The feature unit/API tests additionally cover thresholds/limits, response validation, duplicate/stale/cross-profile delivery, expiry/restart recovery and watchdog behavior. `tests/hermes_021_native_interactions_test.py` is separately opt-in: run it with the installed native Python and disposable HOME/HERMES_HOME. It invokes real native clarification and approval gates/preflight without model calls or executing dangerous commands.

## Limits

This demonstrates plumbing and UI behavior, not live-model judgment or question-selection quality. It does not upgrade the shipped Hermes image, prove every provider/privacy policy, or deliver the remaining core roadmap. Unsupported native approval contexts disable terminal execution fail-closed; computer-use stays unavailable until its own turn-scoped native approval transport is verified.
