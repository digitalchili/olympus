import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-task-message-queue-routes-'));
const hermesHome = join(root, 'hermes');
const dispatchHome = join(root, 'dispatch');
await mkdir(hermesHome, { recursive: true });
await writeFile(join(hermesHome, 'config.yaml'), '{}\n');
process.env.HERMES_HOME = hermesHome;
process.env.OLYMPUS_DISPATCH_HOME = dispatchHome;
process.env.DB_PATH = join(dispatchHome, 'data', 'test.db');

const [{ default: app }, queries, { default: db }] = await Promise.all([
  import('../server/app.js'),
  import('../server/db/queries.js'),
  import('../server/db/index.js'),
]);
const task = queries.insertTask({ title: 'Queue route', status: 'in_progress', profile_name: 'default' });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const queueBase = `http://127.0.0.1:${address.port}/api/tasks/${task.id}/queued-message`;
const url = `${queueBase}?profile=default`;

try {
  assert.deepEqual(await (await fetch(url)).json(), { queuedMessage: null });

  const payload = {
    id: 'queue-route-1',
    content: 'Persistent follow-up',
    settings: { mode: 'task', reasoningEffort: 'high' },
    invitedProfileIds: [],
    collaborationScope: 'discussion',
    confirmPersistentCollaboration: false,
  };
  const savedResponse = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(savedResponse.status, 200);
  const saved = (await savedResponse.json()).queuedMessage;
  assert.equal(saved.taskId, task.id);
  assert.equal(saved.content, payload.content);
  assert.deepEqual((await (await fetch(url)).json()).queuedMessage, saved, 'reload hydrates the durable queue');

  const invalidSettings = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, settings: { reasoningEffort: 'impossible' } }),
  });
  assert.equal(invalidSettings.status, 400);

  const replacement = { ...payload, id: 'queue-2', content: 'newer queued message' };
  const replaced = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(replacement),
  });
  assert.equal(replaced.status, 200);

  const staleSend = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${task.id}/messages?profile=default`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: payload.content, settings: payload.settings, queuedMessageId: payload.id }),
  });
  assert.equal(staleSend.status, 409, 'a stale tab cannot send a replaced queue item');
  const afterStaleSend = await (await fetch(url)).json() as { queuedMessage: { id: string } };
  assert.equal(afterStaleSend.queuedMessage.id, replacement.id);

  const staleDelete = await fetch(`${queueBase}/${encodeURIComponent('wrong-id')}?profile=default`, { method: 'DELETE' });
  assert.equal(staleDelete.status, 409);
  const removed = await fetch(`${queueBase}/${encodeURIComponent(replacement.id)}?profile=default`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.deepEqual(await (await fetch(url)).json(), { queuedMessage: null });
} finally {
  server.close();
  await once(server, 'close');
  db.close();
  await rm(root, { recursive: true, force: true });
}
