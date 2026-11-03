import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-queued-start-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'db.sqlite');
await mkdir(process.env.HERMES_HOME, { recursive: true });
await writeFile(join(process.env.HERMES_HOME, 'config.yaml'), '{}');
await writeFile(join(process.env.HERMES_HOME, 'profile.yaml'), 'displayName: Default\nactive: true\n');
const { default: app, adapter } = await import('../server/app.js');
const { default: db } = await import('../server/db/index.js');
const { insertTask } = await import('../server/db/queries.js');
const { putQueuedTaskMessage, getQueuedTaskMessage } = await import('../server/db/task-message-queue.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tasks`;
let starts = 0;
adapter.chatStream = async function* (sessionId) { starts++; yield { type: 'done', sessionId }; };

function savedTask(id: string) {
  const task = insertTask({ title: 'Concurrent startup', status: 'in_progress', profile_name: 'default' });
  const now = Date.now();
  putQueuedTaskMessage({ taskId: task.id, id, content: 'Start the saved request', settings: { mode: 'task' }, invitedProfileIds: [], collaborationScope: 'discussion', confirmPersistentCollaboration: false, createdAt: now, updatedAt: now });
  const url = `${base}/${task.id}/messages?profile=default`;
  const send = (queueId = id) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Start the saved request', queuedMessageId: queueId }) });
  return { task, send };
}

try {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  adapter.getBackgroundWork = async () => { entered(); await gate; return { available: true, work: [] }; };
  const { task, send } = savedTask('same-request');
  const first = send();
  await started;
  const second = send();
  const foreign = await fetch(`${base}/${task.id}/messages?profile=default`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Start the saved request', queuedMessageId: 'same-request', recoveryOfRunId: 'unrelated-recovery' }) });
  assert.equal(foreign.status, 409, 'recovery requests must not share ordinary queued admission');
  await new Promise(resolve => setTimeout(resolve, 40));
  release();
  const [one, two] = await Promise.all([first, second]);
  const [oneBody, twoBody] = await Promise.all([one.json(), two.json()]);
  assert.equal(one.status, 202);
  assert.equal(two.status, 202, 'a matching automatic submission should share the result, not show a busy warning');
  assert.equal(twoBody.runId, oneBody.runId, 'both submitters observe the same admitted run');
  assert.equal(starts, 1, 'only one Hermes run starts');
  assert.equal(getQueuedTaskMessage(task.id), undefined);

  let releaseFailure!: () => void;
  let failureEntered!: () => void;
  const failureStarted = new Promise<void>(resolve => { failureEntered = resolve; });
  const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
  adapter.getBackgroundWork = async () => { failureEntered(); await failureGate; return { available: false, work: [] }; };
  const failed = savedTask('failing-request');
  const failedFirst = failed.send();
  await failureStarted;
  const failedSecond = failed.send();
  const different = await failed.send('another-request');
  assert.equal(different.status, 409, 'a different saved request must not be treated as the same admission');
  await new Promise(resolve => setTimeout(resolve, 40));
  releaseFailure();
  const [failureOne, failureTwo] = await Promise.all([failedFirst, failedSecond]);
  assert.equal(failureOne.status, 503);
  assert.equal(failureTwo.status, 503, 'both submitters receive the genuine background-check failure');
  assert.deepEqual(await failureTwo.json(), await failureOne.json());
  assert.equal(getQueuedTaskMessage(failed.task.id)?.id, 'failing-request', 'a failed check keeps the saved request');
  assert.equal(starts, 1, 'a rejected check never starts a second run');

  let releaseDisconnect!: () => void;
  let disconnectEntered!: () => void;
  const disconnectStarted = new Promise<void>(resolve => { disconnectEntered = resolve; });
  const disconnectGate = new Promise<void>(resolve => { releaseDisconnect = resolve; });
  adapter.getBackgroundWork = async () => { disconnectEntered(); await disconnectGate; return { available: true, work: [] }; };
  const disconnected = savedTask('disconnected-request');
  const abort = new AbortController();
  const owner = fetch(`${base}/${disconnected.task.id}/messages?profile=default`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal,
    body: JSON.stringify({ content: 'Start the saved request', queuedMessageId: 'disconnected-request' }),
  }).catch(() => undefined);
  await disconnectStarted;
  const waiting = disconnected.send();
  await new Promise(resolve => setTimeout(resolve, 40));
  abort.abort();
  const uncertain = await waiting;
  assert.equal(uncertain.status, 503, 'a disconnected owner must not manufacture a successful admission');
  assert.equal(getQueuedTaskMessage(disconnected.task.id)?.id, 'disconnected-request');
  releaseDisconnect();
  await owner;

  const corrupt = savedTask('corrupt-request');
  db.prepare('UPDATE task_message_queue SET settings_json = ? WHERE task_id = ?').run('{', corrupt.task.id);
  const corruptResponse = await corrupt.send();
  assert.equal(corruptResponse.status, 500);
  db.prepare('UPDATE task_message_queue SET settings_json = ? WHERE task_id = ?').run('{}', corrupt.task.id);
  adapter.getBackgroundWork = async () => ({ available: false, work: [] });
  assert.equal((await corrupt.send()).status, 503, 'a failed saved-row read must release the task operation');
} finally {
  server.close();
  await once(server, 'close');
  db.close();
  await rm(root, { recursive: true, force: true });
}
console.log('Concurrent queued startup tests passed');
