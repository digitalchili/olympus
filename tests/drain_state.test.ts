import assert from 'node:assert/strict';
import { DrainController } from '../server/drain.js';

let activeRuns = 1;
const drain = new DrainController(() => activeRuns);

assert.deepEqual(drain.status(), { draining: false, activeRuns: 1, ready: true });
assert.equal(drain.begin(), true);
assert.equal(drain.begin(), false);
assert.deepEqual(drain.status(), { draining: true, activeRuns: 1, ready: false });

const idle = drain.waitForIdle(100);
activeRuns = 0;
drain.notifyRunChange();
assert.equal(await idle, true);

assert.equal(drain.cancel(), true);
assert.equal(drain.cancel(), false);
assert.equal(drain.status().ready, true);

activeRuns = 1;
drain.begin();
assert.equal(await drain.waitForIdle(5), false);

console.log('Drain state tests passed');
