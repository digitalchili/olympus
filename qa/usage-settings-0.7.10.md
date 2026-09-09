# v0.7.10 verification

Settings → Usage displays accounts available to the selected Hermes profile, with OpenAI first. Subscription allowance shows remaining percentages and reset times. Unknown allowance stays unavailable; API spending is separate. This feature adds no task limits or automatic credit resets.

Usage reads run outside the worker command reader, cache for one minute, and support manual refresh. Visible pages refresh every minute. Failed refreshes retain the last retrieved figures with a warning; switching profiles clears those figures. Provider inventory does not probe custom endpoints.

Startup reconciliation repairs only successful clean skipped runs whose completion was never recorded, with fresh matching source, no later task edit, and no queued message or unanswered interaction. Ambiguous historical human status choices remain untouched. Reconciliation does not rerun agent work.

## Automated checks

- Full `npm test` suite passed.
- TypeScript checking and production build passed.
- Five worker usage tests passed, including worker health responsiveness during a pending lookup.
- Targeted provider usage and verification lifecycle tests passed, including missing allowance, safe errors, profile routing, stale source, failed runs, and post-completion human edits.
- Native Hermes usage contract passed using `tests/test_worker_usage_native.py` with the pinned Hermes source and its dependencies. Credentials and provider HTTP were mocked; the real native parser converted 23/61 percent used to 77/39 percent remaining.
- Production dependency audit reported no vulnerabilities.

## Browser checks

Used the disposable task-start UI fixture with real application routes and simulated provider responses. Inspected the Usage tab at 1440×1000 and 390×844. Verified remaining percentages, unavailable API allowance, reset labels, and no horizontal overflow. A simulated failed refresh displayed a warning while retaining the last figures. Switching from the default profile to Som replaced 77 percent with 31 percent and cleared the previous profile's figures.

This verifies source and UI behavior, not a live provider account or production deployment. The linked production task was inspected read-only and was already in review after its follow-up.
