import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { createProjectTaskWorkspaceRouter } from '../server/routes/project-task-workspace.js';
import { createRepositoryQueue } from '../server/repository-queue.js';
import { createProject, upsertProjectRepositoryLink } from '../server/db/projects.js';
import { upsertGitHubInstallation } from '../server/db/studio-projects.js';
import { insertTask, getTask, updateTask } from '../server/db/queries.js';
import { getQueuedTaskMessage } from '../server/db/task-message-queue.js';
import { createTaskAgentRun, finishTaskAgentRun } from '../server/db/task-agent-runs.js';
import { repositoryOwner } from '../server/db/repository-queue.js';

upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
const project = createProject({ name: 'Repository queue', purpose: 'Preserve requests', managerProfileId: 'default', changedBy: 'test' });
upsertProjectRepositoryLink(project.id, 77, { id: 901, name: 'fixture', fullName: 'fixture/repo', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/repo', cloneUrl: '/unused' });
const a = insertTask({ title: 'Implement login', status: 'in_progress', project_id: project.id });
const b = insertTask({ title: 'Add settings', status: 'in_review', project_id: project.id });
const adapter = { async getBackgroundWork() { return { available: true, work: [], continuation: { status: 'none' as const } }; } };
const queue = createRepositoryQueue({ rootDir: process.env.OLYMPUS_DISPATCH_HOME!, adapter });
let prepared: string[] = []; let started: string[] = [];
const app = express(); app.use(express.json());
app.use('/api/tasks', createProjectTaskWorkspaceRouter({ repositoryQueue: queue, projectCp: {
  async prepareTask(input: { taskId: string }) { prepared.push(input.taskId); return {}; },
} as never }));
app.post('/api/tasks/:id/messages', (req, res) => {
  started.push(req.params.id); createTaskAgentRun({ runId: `run-${req.params.id}-${started.length}`, taskId: req.params.id, kind: 'chat', status: 'streaming', startedAt: Date.now() });
  res.status(202).json({ runId: `run-${req.params.id}-${started.length}` });
});
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address === 'object');
const post = (taskId: string, content: string, extra = {}) => fetch(`http://127.0.0.1:${address.port}/api/tasks/${taskId}/messages?profile=default`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, ...extra }),
});
try {
  assert.equal((await post(a.id, 'Implement login')).status, 202);
  const held = await post(b.id, 'Add settings'); assert.equal(held.status, 202);
  const heldResponse = await held.json();
  assert.equal(heldResponse.action, 'repository_queued');
  assert.equal(heldResponse.task.status, 'in_progress', 'a saved request belongs in progress while waiting for another task');
  assert.equal(getTask(b.id)?.status, 'in_progress', 'waiting status persists across board reloads');
  assert.deepEqual(started, [a.id]); assert.deepEqual(prepared, [a.id], 'held task does not clone stale code');
  const saved = getQueuedTaskMessage(b.id)!;
  assert.equal(saved.content, 'Add settings');
  assert.equal(getTask(b.id)?.repositoryQueue?.message, 'Waiting for “Implement login” to finish. Your request is saved and will start automatically.');
  assert.equal((await post(b.id, 'Do something else')).status, 409, 'another tab cannot replace a saved request');
  assert.equal(getQueuedTaskMessage(b.id)?.id, saved.id);
  const completed = insertTask({ title: 'Reopen completed work', status: 'done', project_id: project.id });
  assert.equal((await post(completed.id, 'Do the next change')).status, 202);
  assert.equal(getTask(completed.id)?.status, 'in_progress', 'new work also reopens a completed task while it waits');
  const untouched = insertTask({ title: 'Finished with no request', status: 'done', project_id: project.id });
  finishTaskAgentRun(`run-${a.id}-1`, 'error');
  updateTask(a.id, { status: 'in_review' });
  updateTask(b.id, { status: 'in_review' }); // A waiting card saved by an older release.
  await queue.tick();
  assert.equal(getTask(b.id)?.repositoryQueue?.state, 'blocked');
  assert.equal(getTask(b.id)?.status, 'in_progress', 'queue reconciliation also corrects existing waiting cards');
  assert.equal(getQueuedTaskMessage(b.id)?.id, saved.id, 'reconciliation preserves the exact saved request');
  assert.equal(getTask(a.id)?.status, 'in_review', 'the previous task is not moved just because it holds the queue');
  assert.equal(getTask(untouched.id)?.status, 'done', 'completed tasks without new work stay complete');
  // Reconstructing the service simulates process-local state loss: ownership stays.
  const restarted = createRepositoryQueue({ rootDir: process.env.OLYMPUS_DISPATCH_HOME!, adapter });
  assert.equal(await restarted.admit(b), false);
  assert.equal(repositoryOwner('github:901')?.taskId, a.id);
  assert.deepEqual(started, [a.id]);
  assert.equal((await post(a.id, 'Continue from saved work')).status, 202, 'same owner may continue normally');
} finally { server.close(); await once(server, 'close'); }
console.log('Repository queue admission and restart tests passed');
const otherProject = createProject({ name: 'Cancelled request', purpose: 'Verify queue cancellation', managerProfileId: 'default', changedBy: 'test' });
upsertProjectRepositoryLink(otherProject.id, 77, { id: 902, name: 'other', fullName: 'fixture/other', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/other', cloneUrl: '/unused' });
const cancelled = insertTask({ title: 'Never started', status: 'in_progress', project_id: otherProject.id });
assert.equal(await queue.admit(cancelled), true);
await queue.tick();
assert.equal(repositoryOwner('github:902'), undefined, 'a removed initial request cannot permanently hold the repository');
