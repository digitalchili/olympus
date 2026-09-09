import assert from 'node:assert/strict';
import { untilStopped } from '../server/run-cancellation.js';

process.env.OLYMPUS_CHAT_MAX_RUN_MS = '1';
process.env.OLYMPUS_CHAT_IDLE_TIMEOUT_MS = '1';
assert.equal(await untilStopped(async () => {
  await new Promise(resolve => setTimeout(resolve, 100));
  return 'completed naturally';
}), 'completed naturally', 'legacy Olympus timeouts cannot stop work');
await assert.rejects(untilStopped(async () => 'should not start', () => true), /stopped by user/);
let stopped = false;
const pending = untilStopped(() => new Promise(() => {}), () => stopped);
stopped = true;
await assert.rejects(pending, /stopped by user/);
await assert.rejects(untilStopped(async () => { throw new Error('native failure'); }), /native failure/);
console.log('Execution cancellation tests passed');
