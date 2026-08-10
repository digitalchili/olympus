import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-persistent-collaboration-'));
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = join(root, 'data', 'persistent-collaboration.db');

try {
  const { createProject } = await import('../server/db/projects.js');
  const { insertTask, deleteTask } = await import('../server/db/queries.js');
  const {
    grantPersistentCollaboration,
    listPersistentCollaborationGrants,
    revokePersistentCollaborationGrant,
  } = await import('../server/db/collaboration.js');
  const { default: db } = await import('../server/db/index.js');

  const project = createProject({
    name: 'Persistent Collaboration Test',
    purpose: 'Synthetic grant lifecycle coverage',
    managerProfileId: 'default',
    changedBy: 'test',
  }, 100);
  const task = insertTask({
    title: 'Synthetic collaboration task',
    description: 'No external side effects',
    status: 'in_progress',
    workdir: null,
    project_id: project.id,
    handling_profile_id: 'default',
    delegated_worker_id: null,
    profile_name: 'default',
    routing_source: 'project',
  });

  const first = grantPersistentCollaboration({
    scope: 'task', scopeId: task.id, profileId: 'somchai', grantedBy: 'default',
  }, 200);
  const updated = grantPersistentCollaboration({
    scope: 'task', scopeId: task.id, profileId: 'somchai', grantedBy: 'manager',
  }, 250);
  assert.equal(first.createdAt, 200);
  assert.equal(updated.createdAt, 200);
  assert.equal(updated.updatedAt, 250);
  assert.equal(updated.grantedBy, 'manager');

  grantPersistentCollaboration({
    scope: 'project', scopeId: project.id, profileId: 'reviewer', grantedBy: 'default',
  }, 300);
  assert.deepEqual(
    listPersistentCollaborationGrants({ taskId: task.id, projectId: project.id })
      .map((grant) => `${grant.scope}:${grant.profileId}`),
    ['task:somchai', 'project:reviewer'],
  );

  assert.equal(revokePersistentCollaborationGrant('task', task.id, 'somchai'), true);
  assert.equal(revokePersistentCollaborationGrant('task', task.id, 'somchai'), false);
  assert.deepEqual(
    listPersistentCollaborationGrants({ taskId: task.id, projectId: project.id })
      .map((grant) => `${grant.scope}:${grant.profileId}`),
    ['project:reviewer'],
  );

  deleteTask(task.id);
  const taskGrantCount = db.prepare('SELECT COUNT(*) AS count FROM task_collaboration_grants').get() as { count: number };
  assert.equal(taskGrantCount.count, 0);
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  const projectGrantCount = db.prepare('SELECT COUNT(*) AS count FROM project_collaboration_grants').get() as { count: number };
  assert.equal(projectGrantCount.count, 0);
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Persistent task and Project collaboration grant tests passed');
