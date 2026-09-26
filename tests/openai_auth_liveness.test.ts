import assert from 'node:assert/strict';
import { HermesWorkerClient } from '../server/adapters/hermes-worker.js';
import { startRun, getRunStatus, discardRun } from '../server/live-chat.js';
import { insertTask } from '../server/db/queries.js';

const client = new HermesWorkerClient('/unused');
let stopped = 0;
client.start = async () => {};
client.request = async () => new Promise<never>(() => {});
client.stop = async () => { stopped++; };
const keepAlive = setInterval(() => {}, 100);
try {
  assert.equal(await client.healthCheck(5), false);
  assert.equal(stopped, 0, 'a delayed auth/runtime probe must not kill a worker or its active tasks');
} finally { clearInterval(keepAlive); }

const { default: app, adapter } = await import('../server/app.js');
adapter.healthCheck = async () => false;
adapter.getScheduledTaskDrainStatus = async () => ({ draining: false, activeRuns: 0 });
const task = insertTask({ title: 'unrelated named profile task', status: 'in_progress', profile_name: 'writer' });
startRun(task.id, task.id, 'fixture');
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
try {
  const result = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/ready`);
  assert.equal(result.status, 503);
  assert.equal(getRunStatus(task.id)?.status, 'streaming', 'shared readiness failure must not terminalize another profile');
} finally {
  discardRun(task.id);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log('OpenAI auth non-destructive readiness tests passed');
