import assert from 'node:assert/strict';
import { once } from 'node:events';

// The test runner supplies isolated state before these application imports.
const { default: app, adapter } = await import('../server/app.js');
const { insertTask } = await import('../server/db/queries.js');
const { getRunStatus, discardRun } = await import('../server/live-chat.js');
const { getActiveTaskRunCount } = await import('../server/task-run-lifecycle.js');
const { default: db } = await import('../server/db/index.js');
const { createProjectsRouter } = await import('../server/routes/projects.js');
const { createProject, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const task = insertTask({ title: 'Stop admission', status: 'in_progress' });
const project = createProject({ name: 'Stop admission', purpose: 'Keep the old editor protected', managerProfileId: 'default', changedBy: 'test' });
upsertGitHubInstallation({ id: 781, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
upsertProjectRepositoryLink(project.id, 781, { id: 781, name: 'fixture', fullName: 'fixture/repo', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/fixture', cloneUrl: '/not-used' });
let baselineSyncs = 0;
let workspaceMutations = 0;
const baselineSha = 'a'.repeat(40);
app.use('/test-projects', createProjectsRouter({ adapter, projectCp: {
  async sync() {
    baselineSyncs += 1;
    return { updated: true, currentSha: baselineSha, message: 'Fixture baseline synchronized' };
  },
  async releaseEditor() {
    workspaceMutations += 1;
    return { id: 'fixture-lease', projectId: project.id, taskId: task.id, status: 'released' };
  },
} as never }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const post = (path: string, body: unknown = {}) => fetch(`http://127.0.0.1:${address.port}/api/tasks/${task.id}/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const projectPost = (path: string, body: unknown = {}) => fetch(`http://127.0.0.1:${address.port}/test-projects/${project.id}/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Fixture did not settle');
}
let streamStarted = false;
let stopping = false;
let releaseStream!: () => void;
let releaseStop!: () => void;
let starts = 0;
let compactStarts = 0;
adapter.getBackgroundWork = async () => ({ available: true, work: [], continuation: { status: 'none' } });
adapter.chatStream = async function* (sessionId) {
  starts += 1;
  if (starts === 1) {
    streamStarted = true;
    await new Promise<void>(resolve => { releaseStream = resolve; });
  }
  yield { type: 'done', sessionId };
};
adapter.interruptChat = async () => {
  stopping = true;
  await new Promise<void>(resolve => { releaseStop = resolve; });
  return true;
};
adapter.compressSession = async () => { compactStarts += 1; return { summary: 'fixture', context: null } as never; };
let stopped: Promise<Response> | undefined;
try {
  assert.equal((await post('messages', { content: 'First run' })).status, 202);
  await waitFor(() => streamStarted);
  db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(project.id, task.id);
  stopped = post('interrupt');
  await waitFor(() => stopping);
  assert.equal(getRunStatus(task.id)?.status, 'stopped');
  const next = await post('messages', { content: 'Second run' });
  const verification = await post('verification');
  const compact = await post('compact');
  const projectSync = await projectPost('sync');
  const workspaceRelease = await projectPost('editor/release', { taskId: task.id });
  assert.equal(next.status, 409, 'a stopped snapshot must not release an unsettled run');
  assert.equal(verification.status, 409, 'manual checks must wait for the old run to settle');
  assert.equal(compact.status, 409, 'compaction must wait for the old run to settle');
  assert.equal(projectSync.status, 200, 'independent baseline sync does not wait for a stopped task workspace');
  assert.equal((await projectSync.json()).lastSync.currentSha, baselineSha, 'successful sync records the verified fixture baseline');
  assert.equal(workspaceRelease.status, 409, 'the stopped task workspace remains protected until its run settles');
  assert.equal((await workspaceRelease.json()).code, 'PROJECT_OPERATION_ACTIVE');
  assert.equal(starts, 1);
  assert.equal(compactStarts, 0);
  assert.equal(baselineSyncs, 1);
  assert.equal(workspaceMutations, 0, 'no task Git mutation reaches the service during unsettled cancellation');
  releaseStream(); releaseStop(); await stopped;
  await waitFor(() => getActiveTaskRunCount() === 0);
  assert.equal((await projectPost('editor/release', { taskId: task.id })).status, 200);
  assert.equal(workspaceMutations, 1, 'the task workspace becomes available only after cancellation settles');
  db.prepare('UPDATE tasks SET project_id=NULL WHERE id=?').run(task.id);
  assert.equal((await post('messages', { content: 'After settlement' })).status, 202);
  await waitFor(() => getActiveTaskRunCount() === 0);
  console.log('Stop admission regression passed');
} finally {
  releaseStream?.(); releaseStop?.(); await stopped;
  await waitFor(() => getActiveTaskRunCount() === 0);
  discardRun(task.id);
  server.close(); await once(server, 'close'); db.close();
}
