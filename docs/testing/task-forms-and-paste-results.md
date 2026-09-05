# Task forms and pasted text — verified local handoff

## Delivery boundary

The bounded task-question/native-interaction and large-paste slice is implemented, integrated, tested and independently reviewed. The entire Hermes 0.21 core roadmap is **not** complete. Nothing was committed, pushed, released, deployed or applied to live profiles.

Baseline: `b04fb82bd0082170d93756d411db7f5a3e42f28c` (`v0.5.23`). Native verification used Hermes v0.21, release tag `v2026.8.31`.

The 38 changed files before this handoff matched the final frozen review snapshot byte-for-byte. SHA-256 of their sorted-key JSON path/content-hash manifest: `bfc7864aa2b99d9dc3196dc68778615c5d0f927735ac19891b41c3b2531a7f9a`. This fingerprint excludes this later documentation-only handoff.

## Implemented

- Native single/multiple-choice and free-text question forms, including editable Other responses and complete-answer validation.
- Profile/task/run-bound durable requests and response claims, reload hydration, one-shot approval/deny, redacted display, rejection of stale/replayed answers, and explicit ambiguous-delivery handling.
- Bounded waiting that coordinates with the watchdog; cancelled/unanswered requests do not silently succeed or promote a task to review.
- Long pasted text becomes an existing-workspace text attachment at the documented thresholds. Preview, Keep inline, retry/removal, New Task and existing-task send/history preserve user control and original UTF-8 file bytes.
- Responsive pasted-document action rows; narrow-screen clipping was reproduced with a failing bounds assertion, repaired, and verified visually and behaviorally.
- Retained opt-in native/browser QA runner and instructions in [native-interactions.md](native-interactions.md).

## Final verification

All commands ran in disposable/allowlisted environments where relevant. The final chained run exited **0**:

| Gate | Result |
| --- | --- |
| `npm test` | Passed full configured suite |
| `npm run typecheck` | Passed server/client checks |
| `npm run build` | Passed production build |
| Native `tests/hermes_021_native_interactions_test.py -v` | 5 tests passed |
| `tests/fixtures/run_native_interactions_qa.py` | `BROWSER_FEATURES_PASS` |
| `git diff --check` | Passed |

Fresh browser evidence is retained in `.tmp-native-qa-1eikbyc3/`: `evidence.json`, screenshots and app/provider/browser logs. It covers native answer round-trip, reload, stale replay, stop, inert preview, exact Unicode/CRLF downloads, existing-task/New Task flows, injected upload failure followed by real retry/removal, small-paste fallback and 320px control bounds. No uncaught browser JavaScript errors were observed.

Final command logs: `.tmp-olympus-portable-hermes021/final-{tests,typecheck,build,native,browser}.log`.

## Independent review

GPT-5.5 inspected the frozen integrated source and ran its own test/typecheck/build gates. Its final delta review also inspected actual desktop/mobile screenshot pixels and the retained QA runner. Both reviews found **no high/medium blockers**. Reports are retained in `.tmp-olympus-portable-hermes021/coding-result-review-final.json` and `coding-result-review-visual.json`.

Non-blocking follow-up: the existing failed-upload Retry control remains smaller than the new pasted-text preview/remove targets; mobile retry touch-target sizing was not asserted. The production build also reports its large-chunk advisory.

## Limits and remaining work

The deterministic loopback model substitutes only the external provider. Real Hermes tools, worker, database, routes, uploads and browser execute. This proves integration, not any live model's question-selection quality. No dangerous command is executed by approval/preflight tests. Older runtimes without the required scoped approval APIs disable terminal execution fail-closed; computer-use remains disabled pending verification of its separate approval boundary.

Remaining core roadmap: runtime capability/compatibility presentation and child steering/stopping; model privacy warnings/confidential Project enforcement; scheduled-task continuity/reasoning/monitor/notepad controls; consolidated approval inbox/preflight UX; profile-scoped MCP management/health. The interaction bridge and native preflight plumbing here do not imply those full surfaces are delivered.

Requested later-feature reminder: Project team rooms; revision-bound verification evidence panel; watchable isolated browser QA. These remain deferred product features—the disposable test runner is not that product UI.
