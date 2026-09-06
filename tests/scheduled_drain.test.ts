import assert from 'node:assert/strict';
import { DrainController } from '../server/drain.js';

let jobs = 1;
let unknown = false;
let schedulerDraining = false;
const drain = new DrainController(() => 0, {
  setDraining(value: boolean) { schedulerDraining = value; },
  async activeRuns() { if (unknown) throw new Error('worker unavailable'); return jobs; },
});

drain.begin();
assert.equal(schedulerDraining, true, 'drain must gate scheduled starts synchronously');
assert.equal(drain.status().activeRuns, null, 'unacknowledged scheduler state is unknown');
assert.equal((await drain.refreshStatus()).activeRuns, 1);
assert.equal(await drain.waitForIdle(10), false, 'running scheduled job prevents idle');
unknown = true;
assert.equal((await drain.refreshStatus()).activeRuns, null);
assert.equal(await drain.waitForIdle(10), false, 'unavailable worker never counts as idle');
unknown = false;
jobs = 0;
assert.equal(await drain.waitForIdle(100), true);
drain.cancel();
assert.equal(schedulerDraining, false, 'cancel resumes scheduling');

console.log('Scheduled maintenance drain tests passed');
