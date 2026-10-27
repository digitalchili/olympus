import assert from 'node:assert/strict';
import { createRepositoryQueue } from '../server/repository-queue.js';
import { insertTask, getTask } from '../server/db/queries.js';
import { createTaskAgentRun, finishTaskAgentRun } from '../server/db/task-agent-runs.js';
import { enqueueRepositoryTask, claimRepositoryTask, repositoryOwner } from '../server/db/repository-queue.js';
import { beginRecovery, cancelRecovery } from '../server/run-recovery.js';
import { putQueuedTaskMessage } from '../server/db/task-message-queue.js';
import { configureQueuedMessageDispatcher } from '../server/queued-message-dispatcher.js';
import { createProject, upsertProjectRepositoryLink } from '../server/db/projects.js';
import { upsertGitHubInstallation } from '../server/db/studio-projects.js';

let available = true;
let active = false;
let continuation: 'none' | 'pending' | 'blocked' = 'none';
let pendingResults = false;
let receiptAvailable = true;
let duringProbe = () => {};
const dispatched: string[] = [];
configureQueuedMessageDispatcher({ schedule: id => { dispatched.push(id); } });
const queue = createRepositoryQueue({ rootDir: process.env.OLYMPUS_DISPATCH_HOME!, adapter: {
  async getBackgroundWork() {
    duringProbe();
    return { available, work: active ? [{ id: 'child', kind: 'delegation' as const, status: 'running' }] : [],
      continuation: { status: continuation, reason: continuation === 'blocked' ? 'Stopped by user or interaction; explicit continuation is required.' : undefined },
      checkpoint: receiptAvailable ? { saved: true, source: 'task-continuation-journal', pendingDelegationIds: pendingResults ? ['child'] : [], undeliveredResultCount: pendingResults ? 1 : 0 } : undefined };
  },
} });
upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
for (const [index, mode] of ['stopped', 'legacy-stop', 'failed', 'new-request', 'resumed'].entries()) {
  const project = createProject({ name: mode, purpose: 'Stopped queue admission', managerProfileId: 'default', changedBy: 'test' });
  upsertProjectRepositoryLink(project.id, 77, { id: 910 + index, name: mode, fullName: `fixture/${mode}`, owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/repo', cloneUrl: '/unused' });
  const key = `github:${910 + index}`;
  const a = insertTask({ title: 'Earlier task', status: 'in_progress', project_id: project.id });
  const b = insertTask({ title: 'Next task', status: 'in_progress', project_id: project.id });
  enqueueRepositoryTask(key, a.id); claimRepositoryTask(key, a.id); enqueueRepositoryTask(key, b.id);
  const request = (id: string) => putQueuedTaskMessage({ taskId: id, id: `request-${id}`, content: 'Continue', settings: {}, invitedProfileIds: [], collaborationScope: 'discussion', confirmPersistentCollaboration: false, createdAt: 1, updatedAt: 1 });
  request(b.id);
  createTaskAgentRun({ taskId: a.id, runId: mode, status: 'streaming', kind: 'chat', startedAt: 1 });
  beginRecovery(a.id, mode, 1);
  finishTaskAgentRun(mode, mode === 'legacy-stop' ? 'done' : mode === 'failed' ? 'error' : 'stopped');
  if (mode !== 'failed') cancelRecovery(a.id);
  active = true;
  await queue.tick();
  assert.equal(repositoryOwner(key)?.taskId, a.id, 'stopped parents cannot release running children');
  active = false; available = false;
  await queue.tick();
  assert.equal(repositoryOwner(key)?.taskId, a.id, 'unknown inventory never grants a second writer');
  available = true; continuation = 'pending';
  await queue.tick();
  assert.equal(repositoryOwner(key)?.taskId, a.id, 'unacknowledged native results retain ownership');
  continuation = 'blocked'; pendingResults = true;
  receiptAvailable = false;
  await queue.tick();
  assert.equal(repositoryOwner(key)?.taskId, a.id, 'a stop marker alone is not proof that native results are settled');
  receiptAvailable = true;
  duringProbe = () => {
    if (mode === 'new-request') request(a.id);
    if (mode === 'resumed') {
      createTaskAgentRun({ taskId: a.id, runId: 'replacement', status: 'streaming', kind: 'chat', startedAt: 2 });
      beginRecovery(a.id, 'replacement', 2);
    }
    duringProbe = () => {};
  };
  await queue.tick();
  if (mode === 'stopped' || mode === 'legacy-stop') {
    assert.equal(repositoryOwner(key), undefined, 'an idle user-stopped owner must release the queue');
    assert.ok(dispatched.includes(b.id), 'the saved next request is scheduled automatically');
    assert.equal(getTask(a.id)?.status, 'in_progress', 'release never marks unfinished work complete');
    assert.equal(await queue.admit(b), true, 'the retained stopped checkpoint cannot block the next admission either');
    assert.equal(pendingResults, true, 'saved child results are retained, not consumed or discarded to release the queue');
  } else assert.equal(repositoryOwner(key)?.taskId, a.id, 'failure, a new request or a resumed run must not be abandoned');
}
console.log('Stopped owners release only after proven idle, without losing later work');
