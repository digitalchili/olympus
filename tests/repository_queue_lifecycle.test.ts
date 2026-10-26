import assert from 'node:assert/strict';
import { once } from 'node:events';
import app, { adapter, repositoryQueue } from '../server/app.js';
import db from '../server/db/index.js';
import { createProject, upsertProjectRepositoryLink } from '../server/db/projects.js';
import { upsertGitHubInstallation } from '../server/db/studio-projects.js';
import { insertTask, getTask } from '../server/db/queries.js';
import { enqueueRepositoryTask, claimRepositoryTask, repositoryOwner, queuedRepositoryTasks, finishRepositoryTask } from '../server/db/repository-queue.js';
import { putQueuedTaskMessage, getQueuedTaskMessage } from '../server/db/task-message-queue.js';

upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
const project = createProject({ name: 'Lifecycle', purpose: 'Queue lifecycle regressions', managerProfileId: 'default', changedBy: 'test' });
upsertProjectRepositoryLink(project.id, 77, { id: 903, name: 'fixture', fullName: 'fixture/repo', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/repo', cloneUrl: '/unused' });
let active = false;
adapter.getBackgroundWork = async () => ({ available: true, work: active ? [{ id: 'child', kind: 'delegation', status: 'running' }] : [] });
const a = insertTask({ title: 'Preparation failed', status: 'in_progress', project_id: project.id });
enqueueRepositoryTask('github:903', a.id); claimRepositoryTask('github:903', a.id);
assert.throws(() => db.prepare('DELETE FROM tasks WHERE id=?').run(a.id), /FOREIGN KEY/, 'bulk deletion must not orphan an owner');
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address === 'object');
const request = (path: string, method: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}/api/${path}?profile=default`, {
  method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
try {
  active = true;
  assert.equal((await request(`tasks/${a.id}`, 'DELETE')).status, 409);
  assert.equal(repositoryOwner('github:903')?.taskId, a.id);
  active = false;
  const removed = await request(`tasks/${a.id}`, 'DELETE');
  assert.equal(removed.status, 200, await removed.text());
  assert.equal(repositoryOwner('github:903'), undefined);
  assert.equal(getTask(a.id), undefined);

  const b = insertTask({ title: 'First request cancelled', status: 'in_progress', project_id: project.id });
  assert.equal(await repositoryQueue.admit(b), true);
  await repositoryQueue.tick();
  assert.equal(repositoryOwner('github:903'), undefined, 'native empty-journal inventory releases an unstarted owner');

  const c = insertTask({ title: 'Earlier work', status: 'in_progress', project_id: project.id });
  const d = insertTask({ title: 'Waiting request', status: 'in_progress', project_id: project.id });
  enqueueRepositoryTask('github:903', c.id); claimRepositoryTask('github:903', c.id);
  enqueueRepositoryTask('github:903', d.id);
  putQueuedTaskMessage({ taskId: d.id, id: 'request-d', content: 'Do later', settings: {}, invitedProfileIds: [], collaborationScope: 'discussion', confirmPersistentCollaboration: false, createdAt: 1, updatedAt: 1 });
  const reconnected = await request(`projects/${project.id}`, 'PATCH', { repositoryLink: { installationId: 77, repositoryId: 904 } });
  assert.equal(reconnected.status, 409, await reconnected.clone().text());
  assert.match(await reconnected.text(), /tasks waiting to run/);
  const completed = await request(`tasks/${d.id}/move`, 'POST', { status: 'done' });
  assert.equal(completed.status, 200, await completed.text());
  assert.equal(getQueuedTaskMessage(d.id), undefined);
  assert.ok(!queuedRepositoryTasks().includes(d.id));
  const stale = await request(`tasks/${d.id}/messages`, 'POST', { content: 'Do later', queuedMessageId: 'request-d' });
  assert.equal(stale.status, 409, 'a dispatcher holding the old request cannot start a completed task');
  assert.equal(getTask(d.id)?.status, 'done');
  const owner = repositoryOwner('github:903')!; finishRepositoryTask(owner.key, owner.token);
} finally { server.close(); await once(server, 'close'); }
console.log('Repository queue deletion, reconnection, completion and fresh-profile cancellation passed');
