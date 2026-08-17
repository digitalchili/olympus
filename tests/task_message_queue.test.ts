import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-task-message-queue-'));
process.env.DB_PATH = join(root, 'olympus.db');
process.env.OLYMPUS_DISPATCH_HOME = root;

try {
  const [{ insertTask, deleteTask }, queue, dbModule] = await Promise.all([
    import('../server/db/queries.js'),
    import('../server/db/task-message-queue.js'),
    import('../server/db/index.js'),
  ]);

  const task = insertTask({
    title: 'Durable queue',
    status: 'in_progress',
    profile_name: 'default',
  });
  const original = {
    id: 'queue-1',
    taskId: task.id,
    content: 'Send this after the active response',
    settings: { model: 'gpt-test', reasoningEffort: 'high' as const, mode: 'task' as const },
    invitedProfileIds: ['reviewer'],
    collaborationScope: 'discussion' as const,
    confirmPersistentCollaboration: false,
    createdAt: 100,
    updatedAt: 100,
  };

  assert.deepEqual(queue.putQueuedTaskMessage(original), original);
  assert.deepEqual(queue.getQueuedTaskMessage(task.id), original, 'queue survives outside React memory in SQLite');
  assert.deepEqual(queue.listQueuedTaskMessages(), [original]);
  assert.equal(queue.consumeQueuedTaskMessage(task.id, 'stale-id'), undefined);
  assert.deepEqual(queue.consumeQueuedTaskMessage(task.id, original.id), original);
  assert.equal(queue.getQueuedTaskMessage(task.id), undefined);
  assert.equal(queue.restoreQueuedTaskMessage(original), true);
  assert.deepEqual(queue.getQueuedTaskMessage(task.id), original);

  const edited = {
    ...original,
    content: 'Edited durable follow-up',
    updatedAt: 200,
  };
  assert.deepEqual(queue.putQueuedTaskMessage(edited), edited, 'one durable queued message per task is replaceable');
  assert.deepEqual(queue.getQueuedTaskMessage(task.id), edited);

  assert.equal(queue.deleteQueuedTaskMessage(task.id, 'wrong-id'), false, 'stale clients cannot delete a replacement');
  assert.equal(queue.deleteQueuedTaskMessage(task.id, edited.id), true);
  assert.equal(queue.getQueuedTaskMessage(task.id), undefined);

  queue.putQueuedTaskMessage(original);
  deleteTask(task.id);
  assert.equal(queue.getQueuedTaskMessage(task.id), undefined, 'task deletion cascades to queued messages');

  dbModule.default.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
