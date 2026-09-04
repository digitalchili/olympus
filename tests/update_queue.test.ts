import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createPendingUpdateStore } from '../server/db/update-queue.js';
import {
  DurableUpdateCoordinator,
  type PendingUpdateRequest,
} from '../server/update-queue.js';

const database = new Database(':memory:');
database.exec(`
  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
const store = createPendingUpdateStore(database);
const request: PendingUpdateRequest = {
  id: 'pending-1',
  repository: 'digitalchili/olympus',
  currentVersion: '0.5.5',
  latestVersion: '0.6.0',
  releaseUrl: 'https://github.com/digitalchili/olympus/releases/tag/v0.6.0',
  requestedAt: 1_700_000_000_000,
};

let activeRuns = 1;
let dispatches = 0;
let failFirstDispatch = false;
const coordinator = new DurableUpdateCoordinator({
  store,
  activeRuns: () => activeRuns,
  currentVersion: () => '0.5.5',
  dispatch: async () => {
    dispatches += 1;
    if (failFirstDispatch && dispatches === 1) return 503;
    return 202;
  },
  pollIntervalMs: 5,
});

assert.deepEqual(coordinator.enqueue(request), request);
assert.deepEqual(store.load(), request, 'the pending request must be persisted in SQLite');
assert.equal(await coordinator.attemptDispatch(), 'waiting');
assert.equal(dispatches, 0, 'active work must not be interrupted by starting the host updater');

const duplicate = coordinator.enqueue({ ...request, id: 'pending-2', requestedAt: request.requestedAt + 1 });
assert.equal(duplicate.id, request.id, 'repeated clicks must coalesce into one pending update');

// A fresh coordinator simulates an Olympus process restart over the same SQLite state.
activeRuns = 0;
const restarted = new DurableUpdateCoordinator({
  store,
  activeRuns: () => activeRuns,
  currentVersion: () => '0.5.5',
  dispatch: async () => {
    dispatches += 1;
    return 202;
  },
  pollIntervalMs: 5,
});
assert.equal(await restarted.attemptDispatch(), 'accepted');
assert.equal(dispatches, 1);
assert.equal(store.load(), null, 'the request is removed only after the host hook accepts it');

// A temporary host-hook failure remains durable and is retried automatically.
dispatches = 0;
failFirstDispatch = true;
coordinator.enqueue({ ...request, id: 'pending-retry' });
coordinator.start();
await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('pending update was not retried')), 500);
  const check = setInterval(() => {
    if (dispatches >= 2 && store.load() === null) {
      clearTimeout(timeout);
      clearInterval(check);
      resolve();
    }
  }, 5);
});
coordinator.stop();
assert.equal(dispatches, 2);

// If the requested version is already installed after a restart, do not invoke the hook again.
store.saveIfEmpty({ ...request, id: 'already-installed' });
const upgraded = new DurableUpdateCoordinator({
  store,
  activeRuns: () => 0,
  currentVersion: () => '0.6.0',
  dispatch: async () => {
    throw new Error('must not dispatch an already-installed version');
  },
});
assert.equal(await upgraded.attemptDispatch(), 'stale');
assert.equal(store.load(), null);

database.close();
console.log('Durable update queue tests passed');
