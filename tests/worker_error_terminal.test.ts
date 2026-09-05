import assert from 'node:assert/strict';
import { HermesWorkerAdapter, HermesWorkerClient } from '../server/adapters/hermes-worker.js';
const worker = new HermesWorkerClient('/unused-hermes-home');
const internal = worker as unknown as { pending: Map<string, unknown>; handleLine(line: string): void };
let pushed = 0, ended = 0;
internal.pending.set('run', { kind: 'stream', push() { pushed++; }, end() { ended++; }, fail() { throw new Error('structured failure should be pushed'); } });
internal.handleLine(JSON.stringify({ id: 'run', type: 'error', error: { code: 'worker_error', message: 'Provider rejected request' } }));
assert.equal(pushed, 1);
assert.equal(ended, 1, 'error-only worker streams settle immediately without waiting for watchdog');
assert.equal(internal.pending.has('run'), false);
internal.handleLine(JSON.stringify({ id: 'run', type: 'done', sessionId: 'session' }));
assert.equal(ended, 1, 'trailing done cannot resettle an error');

const adapter = new HermesWorkerAdapter({ hermesHome: '/unused-hermes-home' });
const adapterInternal = adapter as unknown as {
  client: { stream(): AsyncIterable<{ type: 'error'; error: { code: string; message: string } }> };
};
adapterInternal.client.stream = async function* () {
  yield { type: 'error', error: { code: 'deadline_finalized', message: 'Checkpoint preserved' } };
};
const mapped = [];
for await (const event of adapter.chatStream('session', 'message')) mapped.push(event);
assert.deepEqual(mapped, [{ type: 'error', error: '[deadline_finalized] Checkpoint preserved', code: 'deadline_finalized' }]);
console.log('Worker error terminal tests passed');
