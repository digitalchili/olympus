import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'olympus-secret-chat-guards-'));
const hermes = join(root, 'hermes'); await mkdir(hermes);
await writeFile(join(hermes, 'config.yaml'), '{}\n');
await writeFile(join(hermes, 'profile.yaml'), 'displayName: Default\nactive: true\n');
process.env.HERMES_HOME = hermes;
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'test.db');
const { default: app, adapter } = await import('../server/app.js');
const { default: db } = await import('../server/db/index.js');
const { insertTask, getTask } = await import('../server/db/queries.js');
const { getQueuedTaskMessage, putQueuedTaskMessage } = await import('../server/db/task-message-queue.js');
const { getRun, discardRun } = await import('../server/live-chat.js');
let workerCalls = 0;
adapter.chatStream = async function* () { workerCalls++; yield { type: 'done' }; };
adapter.steerChat = async () => { workerCalls++; return true; };
const task = insertTask({ title: 'Secret input guard', status: 'in_progress', profile_name: 'default' });
const initialTask = getTask(task.id);
const queue = { id: 'existing', taskId: task.id, content: 'Existing safe request', settings: { mode: 'task' as const }, invitedProfileIds: [], collaborationScope: 'discussion' as const, confirmPersistentCollaboration: false, createdAt: 1, updatedAt: 1 };
putQueuedTaskMessage(queue);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}/api/tasks/${task.id}`;
try {
  for (const content of ['Save this secret:\nAPI_KEY=fake-canary-value', 'DATABASE_URL=postgres://tester:fake-pass@localhost/test', 'API_KEY=unterminated value']) {
    for (const endpoint of ['messages', 'queued-message', 'steer', 'MESSAGES/', 'QUEUED-MESSAGE/', 'STEER/']) {
      const response = await fetch(`${base}/${endpoint}?profile=default`, { method: endpoint.toLowerCase().startsWith('queued-message') ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...queue, content }) });
      assert.equal(response.status, 400, endpoint);
      const result = await response.json(); assert.equal(result.code, 'PROJECT_SECRET_INPUT_REQUIRED');
      assert.equal(JSON.stringify(result).includes('fake-'), false);
      assert.deepEqual(getQueuedTaskMessage(task.id), queue, 'existing queue untouched');
      assert.deepEqual(getTask(task.id), initialTask, 'task metadata untouched');
      assert.equal(getRun(task.id), undefined);
    }
  }
  assert.equal(workerCalls, 0, 'secrets never reach agent or steer');
  assert.equal(db.prepare('SELECT count(*) AS count FROM task_agent_runs WHERE task_id = ?').get(task.id)!.count, 0);
} finally {
  discardRun(task.id);
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await adapter.stop(); db.close(); await rm(root, { recursive: true, force: true });
}
console.log('Normal chat, queued input and steer secret backstops passed');
