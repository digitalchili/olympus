import assert from 'node:assert/strict';
import { createRuntimeLiveness } from '../server/runtime-liveness.js';

let now = 0;
let workerHealthy = false;
const liveness = createRuntimeLiveness({
  checkWorker: async () => workerHealthy,
  now: () => now,
  baseCooldownMs: 1_000,
  maxCooldownMs: 8_000,
});

assert.equal((await liveness.probe()).ready, false, 'an unresponsive worker makes readiness fail');
assert.equal(liveness.status().retryAfter, 1_000, 'first worker failure enters a bounded cooldown');
now = 100;
assert.equal((await liveness.probe()).checked, false, 'cooldown prevents repeated worker probes');
now = 1_000;
workerHealthy = true;
assert.deepEqual(await liveness.probe(), { ready: true, checked: true }, 'a responsive replacement worker restores readiness');
assert.equal(liveness.status().failures, 0, 'success clears liveness failures');

console.log('Runtime liveness tests passed');
