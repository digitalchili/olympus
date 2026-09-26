# SSE buffering and reconnect verification

Date: 2026-09-26. Baseline: `1dd01b2`, isolated `codex/production-hardening` checkout.

## Scope

R4 uses one bounded writer per board, project or live-chat connection. `write(false)` has already accepted its frame. The writer waits for drain, skips keepalives while blocked, and records missed incremental events with one flag. It finishes the finite initial snapshot batch before closing a stream that needs resynchronization. Reconnection uses existing snapshot/history reads and never restarts task execution.

The board batch has task-run and delegation snapshots; project/live streams have one snapshot (or an empty batch when no live run exists). The subscriber is registered before bootstrap. Profile/task deletion and maintenance use writer cleanup. No task/runtime timer, transcript replay or client composer change was introduced.

## Red evidence

`node scripts/run-tests.mjs tests/sse_backpressure.test.ts tests/sse_drain.test.ts tests/reconnect_chat.test.ts`

The first new test ran against the baseline using a real Node `Writable` with a one-byte high-water mark and delayed write callbacks. After an accepted false write and a real drain, a second board update was absent: expected 2 frames, observed 1. This reproduced the silent-unsubscribe defect before implementation.

An intermediate implementation also exposed a real write-after-end error when external response end preceded its finish notification. The final writer checks ended/destroyed state before writing.

## Green evidence

Passed the focused isolated checks:

```sh
node scripts/run-tests.mjs tests/sse_backpressure.test.ts tests/sse_drain.test.ts tests/reconnect_chat.test.ts tests/reconnect_run_store.test.ts tests/task_run_snapshot.test.ts
node scripts/run-tests.mjs tests/profile_task_isolation.test.ts tests/task_deletion_lifecycle.test.ts
npx tsc -p server/tsconfig.json --noEmit
```

Coverage includes accepted false writes followed by drain; large live snapshots; two serialized board snapshots without loss/repetition; bounded missed-event handling; bootstrap registration races; blocked keepalives; thrown writes; close/error listener cleanup and late drain; independent subscribers; replacement connections; deletion and maintenance. The existing chat hook is exercised with missed `done`, `error` and `stopped` events after the in-memory snapshot expires. Durable history restores terminal state; every request in those reconnect scenarios is GET, with zero task POSTs.

## Browser fixture and limits

```sh
npx vite --config tests/fixtures/vite.config.ts --host 127.0.0.1 --port 4186
```

Open `/tests/fixtures/sse-reconnect.html`. This fixture renders the real `useChat` hook and an editable local composer using synthetic HTTP/EventSource responses. Change the draft, select the missed terminal event, disconnect, then reconnect after snapshot expiry. Expected: connected → reconnecting → connected, recovered terminal history, unchanged draft, and `Task POSTs: 0`.

Root-agent browser verification passed using the actual browser through CUA at `http://127.0.0.1:4186/tests/fixtures/sse-reconnect.html`. Root edited the unsent draft, disconnected, and observed `reconnecting / running / Task POSTs: 0`. After reconnecting with the live snapshot expired, the fixture showed `connected / not running`, recovered saved work, the unchanged edited draft, and `Task POSTs: 0`.

The subagent itself had no browser provider; the browser evidence above is root-agent verification. The composer fixture is a focused hook host, not the full TaskChat page. Automated reconnect and writer tests passed without live Hermes state, credentials, model requests, external hosts or deployment changes.

## Deviations

Three existing response fakes now use Node EventEmitter so they support production listener removal; tests explicitly bootstrap their synthetic subscriptions. The exported add/subscribe helpers return their writer, and board serialization stays in `bootstrapEvents`. No production client-hook changes were needed. Broader repository checks and browser verification belong to the combined hardening validation.
