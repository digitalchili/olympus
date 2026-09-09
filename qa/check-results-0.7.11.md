# v0.7.11: visible verification results

The reported v0.7.10 Banchii task was inspected and its Run checks button exercised once through the browser. The request started and finished in about four seconds, with 568 tests passing and two date/time assertions failing. The old failed heading remained during admission, then the same collapsed result returned without a completion timestamp. This made a working rerun appear ineffective.

The panel now immediately shows running state, hides the previous failure during execution, and displays the terminal completion time. Failed command output opens at its end, before source metadata; full output remains available. The rerun button sits outside the scrollable log area. A failed result reopens even if the user collapsed progress. Copy explains that rerunning checks does not repair code.

Verification:

- Browser regression failed before the heading fix and separately before the collapsed-progress fix, then passed with the final component.
- The real panel fixture covers immediate progress, hidden old failure, completion time, automatically visible failure output, final-output scroll position, terminal color cleanup, full-log access, and an HTTP 409 rejection that releases the button.
- Inspected styled desktop and 390×844 mobile layouts; failure text and rerun control are visible.
- All 26 verification lifecycle tests and the live command progress tests passed.
- TypeScript checking and production build passed.

Run the browser regression with `npx vite --config tests/fixtures/vite.config.ts`, then open `http://127.0.0.1:4183/tests/fixtures/coding-checks.html`. It renders PASS or the failed assertion and uses simulated HTTP only.

This release changes Olympus's result presentation. It does not alter the Banchii source or bypass its two failing tests. No production deployment or restart was performed.
