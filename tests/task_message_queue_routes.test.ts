import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamEvent } from '../server/adapters/types.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-task-message-queue-routes-'));
const hermesHome = join(root, 'hermes');
const dispatchHome = join(root, 'dispatch');
const reviewerHome = join(hermesHome, 'profiles', 'reviewer');
await mkdir(hermesHome, { recursive: true });
await mkdir(reviewerHome, { recursive: true });
await writeFile(join(hermesHome, 'config.yaml'), '{}\n');
await writeFile(join(hermesHome, 'profile.yaml'), 'displayName: Default\nactive: true\n');
await writeFile(join(reviewerHome, 'profile.yaml'), 'displayName: Reviewer\nactive: true\n');
await writeFile(join(reviewerHome, 'config.yaml'), '{}\n');
process.env.HERMES_HOME = hermesHome;
process.env.OLYMPUS_DISPATCH_HOME = dispatchHome;
process.env.DB_PATH = join(dispatchHome, 'data', 'test.db');

const [{ default: app, adapter }, queries, collaboration, { default: db }] = await Promise.all([
  import('../server/app.js'),
  import('../server/db/queries.js'),
  import('../server/db/collaboration.js'),
  import('../server/db/index.js'),
]);
const { discardRun } = await import('../server/live-chat.js');
const originalChatStream = adapter.chatStream;
adapter.getBackgroundWork = async () => ({ available: true, work: [] });
adapter.chatStream = async function* (sessionId): AsyncIterable<StreamEvent> {
  yield { type: 'done', sessionId, interrupted: true, context: null };
};
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

  const authoritative = {
    ...payload,
    id: 'queue-authoritative',
    content: 'Authoritative queued follow-up',
    settings: { mode: 'task', model: 'current-row-model', reasoningEffort: 'high' },
  };
  assert.equal((await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(authoritative),
  })).status, 200);
  const authoritativeSend = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${task.id}/messages?profile=default`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: authoritative.content,
      settings: { mode: 'task', model: 'stale-request-model', reasoningEffort: 'low' },
      invitedProfileIds: ['reviewer'],
      collaborationScope: 'task',
      confirmPersistentCollaboration: true,
      queuedMessageId: authoritative.id,
    }),
  });
  assert.equal(authoritativeSend.status, 202, await authoritativeSend.text());
  const deliveredTask = queries.getTask(task.id)!;
  assert.equal(deliveredTask.agent_model, 'current-row-model', 'queued delivery settings come from the claimed DB row');
  assert.equal(deliveredTask.reasoning_effort, 'high', 'stale request settings cannot change queued delivery options');
  assert.deepEqual(
    collaboration.listPersistentCollaborationGrants({ taskId: task.id, projectId: task.project_id }).map((grant) => grant.profileId),
    [],
    'tampered queued request collaboration fields cannot create persistent grants before claim',
  );
  assert.deepEqual(await (await fetch(url)).json(), { queuedMessage: null });
  discardRun(task.id);
} finally {
  adapter.chatStream = originalChatStream;
  server.close();
  await once(server, 'close');
  db.close();
  await rm(root, { recursive: true, force: true });
}
