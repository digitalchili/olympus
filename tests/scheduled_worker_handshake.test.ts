import assert from 'node:assert/strict';
import { HermesWorkerClient } from '../server/adapters/hermes-worker.js';

const client = new HermesWorkerClient('/unused-test-hermes-home');
const internal = client as unknown as {
  ready: boolean;
  ensureStarted(): void;
  sendRequest(request: { type: string; draining?: boolean }): Promise<unknown>;
  handleExit(error: Error): void;
};
const requests: Array<{ type: string; draining?: boolean }> = [];
let acknowledge!: () => void;
let blockFirstHandshake = true;
let unavailable = false;
internal.ensureStarted = () => {};
internal.sendRequest = async (request) => {
  requests.push(request);
  if (request.type === 'health') return { ok: true };
  if (unavailable) throw new Error('scheduler unavailable');
  if (blockFirstHandshake) {
    blockFirstHandshake = false;
    await new Promise<void>((resolve) => { acknowledge = resolve; });
  }
  return { draining: request.draining, activeRuns: 0 };
};

const startup = client.start();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(requests[1]?.type, 'scheduledTasks.drain', 'readiness requires scheduler handshake');
assert.equal(internal.ready, false);
client.setScheduledTasksDraining(true);
acknowledge();
await startup;
assert.equal(requests.at(-1)?.draining, true, 'drain that races startup is acknowledged before readiness');
assert.equal(internal.ready, true);
internal.handleExit(new Error('simulated crash'));
await client.start();
assert.equal(requests.at(-1)?.draining, true, 'restarted worker inherits active drain');
unavailable = true;
await assert.rejects(client.getScheduledTaskDrainStatus(), /unavailable/, 'RPC failure remains unknown');
internal.handleExit(new Error('simulated crash'));
await assert.rejects(client.start(), /unavailable/);
assert.equal(internal.ready, false, 'failed maintenance handshake prevents worker readiness');

console.log('Scheduled worker readiness handshake tests passed');
