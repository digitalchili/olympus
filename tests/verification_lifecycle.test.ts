import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = await mkdtemp(join(tmpdir(), 'verification-lifecycle-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'db');
await mkdir(process.env.HERMES_HOME, { recursive: true });
await writeFile(join(process.env.HERMES_HOME, 'config.yaml'), '{}\n');
const { default: app, adapter } = await import('../server/app.js');
const { default: db } = await import('../server/db/index.js');
const { insertTask, getTask } = await import('../server/db/queries.js');
const { createTaskAgentRun, finishTaskAgentRun, getLatestTaskAgentRun } = await import('../server/db/task-agent-runs.js');
const { isVerifying, captureCodingBaseline } = await import('../server/coding-verification.js');
const { discardRun } = await import('../server/live-chat.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const api = `http://127.0.0.1:${address.port}/api/tasks`;
const post = (id: string, body: unknown, path = 'messages') => fetch(`${api}/${id}/${path}?profile=default`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const wait = async (condition: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Operation did not settle');
};
const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd });
async function init(cwd: string) {
  await git(cwd, 'init');
  await git(cwd, 'config', 'user.email', 'test@example.invalid');
  await git(cwd, 'config', 'user.name', 'Test');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', 'Initial');
}
const idle = async () => ({ available: true, work: [], continuation: { status: 'none' as const } });
const tasks: string[] = [];
async function fixture(name: string) {
  const cwd = join(root, name);
  await mkdir(join(cwd, '.olympus'), { recursive: true });
  await writeFile(join(cwd, 'source'), 'before');
  await init(cwd);
  const task = insertTask({ title: name, status: 'in_progress', workdir: cwd, profile_name: 'default' });
  tasks.push(task.id);
  return { task, cwd };
}
async function slowCheck(cwd: string, name: string) {
  const ready = join(root, `${name}-ready`);
  const finished = join(root, `${name}-finished`);
  await writeFile(join(cwd, '.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(finished)},'finished'),800)`,
  ]] }));
  return { ready, finished };
}

try {
  await test('new repositories require passing checks before review', async () => {
    const cwd = join(root, 'new-repository'); await mkdir(cwd);
    const task = insertTask({ title: 'Create repository', status: 'in_progress', workdir: cwd, profile_name: 'default' }); tasks.push(task.id);
    adapter.getBackgroundWork = idle;
    adapter.chatStream = async function* (sessionId) {
      await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'exit 1' } }));
      await init(cwd);
      yield { type: 'text_delta', content: 'Created project' };
      yield { type: 'done', sessionId };
    };
    assert.equal((await post(task.id, { content: 'Create a project' })).status, 202);
    await wait(() => getLatestTaskAgentRun(task.id)?.status === 'done');
    assert.equal(getTask(task.id)?.status, 'in_progress', 'new code with failing checks cannot enter review');
    const result = await (await fetch(`${api}/${task.id}/verification`)).json();
    assert.equal(result.evidence.status, 'failed');
  });

  await test('Stop cancels automatic checks and cannot promote the stopped run', async () => {
    const { task, cwd } = await fixture('stop');
    const { ready, finished } = await slowCheck(cwd, 'stop');
    adapter.getBackgroundWork = idle;
    adapter.interruptChat = async () => false; // Hermes has already emitted its terminal event.
    adapter.chatStream = async function* (sessionId) {
      await writeFile(join(cwd, 'source'), 'after');
      yield { type: 'text_delta', content: 'Changed source' };
      yield { type: 'done', sessionId };
    };
    await post(task.id, { content: 'Edit source' });
    await wait(() => existsSync(ready));
    const stopped = await post(task.id, {}, 'interrupt');
    await wait(() => !isVerifying(task.id));
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(stopped.status, 200);
    assert.equal(existsSync(finished), false, 'cancelled checks must not keep executing');
    assert.equal(getLatestTaskAgentRun(task.id)?.status, 'stopped');
    assert.equal(getTask(task.id)?.status, 'in_progress');
  });

  await test('manual verification cannot start while message preparation owns the task', async () => {
    const { task, cwd } = await fixture('ownership');
    await slowCheck(cwd, 'ownership');
    createTaskAgentRun({ taskId: task.id, runId: 'previous', kind: 'chat', status: 'streaming', startedAt: 1 });
    finishTaskAgentRun('previous', 'done', 2);
    await captureCodingBaseline(task, 'previous');
    let releaseInventory!: () => void;
    let entered = false;
    adapter.getBackgroundWork = async () => { entered = true; await new Promise<void>(resolve => { releaseInventory = resolve; }); return idle(); };
    let overlapped = false;
    adapter.chatStream = async function* (sessionId) {
      overlapped = isVerifying(task.id);
      await writeFile(join(cwd, 'source'), 'next run');
      yield { type: 'done', sessionId };
    };
    const message = post(task.id, { content: 'Next edit' });
    await wait(() => entered);
    const manual = post(task.id, {}, 'verification');
    // Let manual preparation reach its ownership check while inventory is held.
    await new Promise(resolve => setTimeout(resolve, 50));
    releaseInventory();
    assert.equal((await message).status, 202);
    const checked = await manual;
    await wait(() => getLatestTaskAgentRun(task.id)?.status === 'done' && !isVerifying(task.id));
    assert.equal(checked.status, 409);
    assert.equal(overlapped, false, 'agent and manual verification must share task ownership');
  });

  await test('manual checks can be stopped without changing a previously completed agent run', async () => {
    const { task, cwd } = await fixture('manual-stop');
    const { ready, finished } = await slowCheck(cwd, 'manual-stop');
    createTaskAgentRun({ taskId: task.id, runId: 'manual-stop-run', kind: 'chat', status: 'streaming', startedAt: 1 });
    finishTaskAgentRun('manual-stop-run', 'done', 2);
    const checking = post(task.id, {}, 'verification');
    await wait(() => existsSync(ready));
    assert.equal((await post(task.id, {}, 'interrupt')).status, 200);
    const result = await (await checking).json();
    assert.equal(result.evidence.status, 'failed');
    assert.match(result.evidence.reason, /stopped/i);
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(existsSync(finished), false);
    assert.equal(getTask(task.id)?.status, 'in_progress');
    assert.equal(getLatestTaskAgentRun(task.id)?.status, 'done', 'manual verification is separate from the completed agent run');
  });

  await test('another task cannot prepare the same Project during manual verification', async () => {
    const { createProject } = await import('../server/db/projects.js');
    const project = createProject({ name: 'Shared checkout', purpose: 'Verification ownership', managerProfileId: 'default', changedBy: 'test' });
    const { task, cwd } = await fixture('project-ownership');
    db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(project.id, task.id);
    const next = insertTask({ title: 'Next editor', status: 'in_progress', project_id: project.id, workdir: cwd, profile_name: 'default' }); tasks.push(next.id);
    const { ready } = await slowCheck(cwd, 'project-ownership');
    createTaskAgentRun({ taskId: task.id, runId: 'project-ownership-run', kind: 'chat', status: 'streaming', startedAt: 1 });
    finishTaskAgentRun('project-ownership-run', 'done', 2);
    adapter.getBackgroundWork = idle;
    adapter.chatStream = async function* (sessionId) { yield { type: 'done', sessionId }; };
    const manual = post(task.id, {}, 'verification');
    await wait(() => existsSync(ready));
    const requested = await post(next.id, { content: 'Use the checkout' });
    await manual;
    await wait(() => !isVerifying(next.id));
    assert.equal(requested.status, 409, 'a Project checkout has one operation owner across tasks');
  });

  await test('Stop wins when the terminal result arrives before Hermes acknowledges cancellation', async () => {
    const task = insertTask({ title: 'Stop terminal handoff', status: 'in_progress', profile_name: 'default' }); tasks.push(task.id);
    let ready = false;
    let complete!: () => void;
    adapter.getBackgroundWork = idle;
    adapter.chatStream = async function* (sessionId) {
      ready = true;
      await new Promise<void>(resolve => { complete = resolve; });
      yield { type: 'done', sessionId };
    };
    adapter.interruptChat = async () => { complete(); await new Promise(resolve => setTimeout(resolve, 80)); return false; };
    await post(task.id, { content: 'Work' }); await wait(() => ready);
    assert.equal((await post(task.id, {}, 'interrupt')).status, 200);
    await wait(() => getLatestTaskAgentRun(task.id)?.status !== 'streaming');
    assert.equal(getLatestTaskAgentRun(task.id)?.status, 'stopped');
    assert.equal(getTask(task.id)?.status, 'in_progress');
  });

  for (const phase of ['baseline', 'verification']) await test(`hard deadline awaits cancellation of a stalled ${phase} snapshot`, async () => {
    const { task, cwd } = await fixture(`snapshot-deadline-${phase}`);
    await writeFile(join(cwd, '.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e', 'process.exit(0)']] }));
    const bin = join(root, `slow-git-${phase}`); await mkdir(bin);
    const realGit = (await promisify(execFile)('which', ['git'])).stdout.trim();
    const marker = join(root, `snapshot-escaped-${phase}`);
    const snapshotStarted = join(root, `snapshot-started-${phase}`);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const stalled = `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'escaped');process.stdout.write('0'.repeat(40));},60000)`;
    // Delegate normal Git directly; starting Node for every probe made the
    // fixture consume its deadline before it reached the operation under test.
    await writeFile(join(bin, 'git'), `#!/bin/sh
if [ "$1" = rev-parse ] && [ "$2" = HEAD ]; then
  printf '%s' "$$" > ${quote(snapshotStarted)}
  exec ${quote(process.execPath)} -e ${quote(stalled)}
fi
exec ${quote(realGit)} "$@"
`);
    const snapshotAlive = () => {
      if (!existsSync(snapshotStarted)) return false;
      try { process.kill(Number(readFileSync(snapshotStarted, 'utf8')), 0); return true; }
      catch { return false; }
    };
    await chmod(join(bin, 'git'), 0o755);
    const originalPath = process.env.PATH;
    const originalBudget = process.env.OLYMPUS_CHAT_MAX_RUN_MS;
    process.env.OLYMPUS_CHAT_MAX_RUN_MS = '2000';
    adapter.getBackgroundWork = idle;
    adapter.chatStream = async function* (sessionId) {
      process.env.PATH = `${bin}:${originalPath}`;
      yield { type: 'done', sessionId };
    };
    try {
      if (phase === 'baseline') process.env.PATH = `${bin}:${originalPath}`;
      assert.equal((await post(task.id, { content: 'Verify' })).status, 202);
      await wait(() => existsSync(snapshotStarted) || getLatestTaskAgentRun(task.id)?.status !== 'streaming');
      assert.equal(existsSync(snapshotStarted), true, JSON.stringify(getLatestTaskAgentRun(task.id)));
      await wait(() => getLatestTaskAgentRun(task.id)?.status !== 'streaming');
      assert.equal(getLatestTaskAgentRun(task.id)?.status, 'error', JSON.stringify(getLatestTaskAgentRun(task.id)));
      const activeAtSettlement = isVerifying(task.id);
      await wait(() => !isVerifying(task.id));
      await wait(() => !snapshotAlive());
      assert.equal(activeAtSettlement, false, 'a settled run cannot leave its verification behind');
      assert.equal(existsSync(marker), false, 'deadline must terminate the pending Git snapshot');
      assert.equal(getLatestTaskAgentRun(task.id)?.errorCode, 'run_runtime_timeout');
    } finally {
      if (snapshotAlive()) process.kill(Number(readFileSync(snapshotStarted, 'utf8')), 'SIGKILL');
      process.env.PATH = originalPath;
      if (originalBudget === undefined) delete process.env.OLYMPUS_CHAT_MAX_RUN_MS;
      else process.env.OLYMPUS_CHAT_MAX_RUN_MS = originalBudget;
    }
  });

  await test('disconnect does not release ownership until Project preparation settles', async () => {
    const { default: express } = await import('express');
    const { createTaskRecoveryRouter } = await import('../server/routes/task-recovery.js');
    const { createProjectTaskWorkspaceRouter } = await import('../server/routes/project-task-workspace.js');
    const { chatRouter } = await import('../server/routes/chat.js');
    const { createProject, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
    const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
    const { putQueuedTaskMessage, getQueuedTaskMessage } = await import('../server/db/task-message-queue.js');
    const project = createProject({ name: 'Preparing', purpose: 'Ownership test', managerProfileId: 'default', changedBy: 'test' });
    upsertGitHubInstallation({ id: 707, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
    upsertProjectRepositoryLink(project.id, 707, { id: 707, name: 'fixture', fullName: 'fixture/repo', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/fixture', cloneUrl: '/not-used' });
    const { task, cwd } = await fixture('disconnect');
    db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(project.id, task.id);
    await writeFile(join(cwd, '.olympus/verification.json'), JSON.stringify({ commands: [[process.execPath, '-e', 'process.exit(0)']] }));
    createTaskAgentRun({ taskId: task.id, runId: 'disconnect-run', kind: 'chat', status: 'streaming', startedAt: 1 });
    finishTaskAgentRun('disconnect-run', 'done', 2);
    putQueuedTaskMessage({ id: 'queued-preparation', taskId: task.id, content: 'Prepare', settings: { mode: 'task' }, invitedProfileIds: [], collaborationScope: 'discussion', confirmPersistentCollaboration: false, createdAt: 1, updatedAt: 1 });
    let entered = false;
    let releasePreparation!: () => void;
    let agentStarted = false;
    adapter.getBackgroundWork = idle;
    adapter.chatStream = async function* (sessionId) { agentStarted = true; yield { type: 'done', sessionId }; };
    const delayed = express(); delayed.use(express.json());
    delayed.use('/api/tasks', createTaskRecoveryRouter(adapter));
    delayed.use('/api/tasks', createProjectTaskWorkspaceRouter({ projectCp: {
      async prepareTask() { entered = true; await new Promise<void>(resolve => { releasePreparation = resolve; }); return {} as never; },
    } as never }));
    delayed.use('/api/tasks', chatRouter);
    const delayedServer = delayed.listen(0, '127.0.0.1'); await once(delayedServer, 'listening');
    const bound = delayedServer.address(); assert.ok(bound && typeof bound === 'object');
    const abort = new AbortController();
    const message = fetch(`http://127.0.0.1:${bound.port}/api/tasks/${task.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Prepare', queuedMessageId: 'queued-preparation' }), signal: abort.signal,
    }).catch(() => null);
    try {
      await wait(() => entered); abort.abort(); await message;
      await new Promise(resolve => setTimeout(resolve, 30));
      const blocked = await post(task.id, {}, 'verification');
      releasePreparation();
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(blocked.status, 409, 'preparation still owns the task after response close');
      assert.equal(agentStarted, false, 'a disconnected preparation cannot start an agent');
      assert.equal(getQueuedTaskMessage(task.id)?.id, 'queued-preparation', 'a disconnected preparation must restore its queued input');
      assert.equal((await post(task.id, {}, 'verification')).status, 200, 'ownership is released after preparation settles');
    } finally { releasePreparation?.(); delayedServer.close(); await once(delayedServer, 'close'); }
  });
} finally {
  for (const id of tasks) discardRun(id);
  server.close(); await once(server, 'close'); db.close();
  await rm(root, { recursive: true, force: true });
}
