import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import type { ProjectCpService } from '../server/project-cp.js';

const root = await mkdtemp(join(tmpdir(), 'project-mutation-ownership-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'state', 'test.db');
await mkdir(process.env.HERMES_HOME, { recursive: true });
await writeFile(join(process.env.HERMES_HOME, 'config.yaml'), '{}\n');
const { createProjectsRouter } = await import('../server/routes/projects.js');
const { ProjectRepositoryCheckpointError } = await import('../server/project-cp.js');
const { createProject, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { insertTask } = await import('../server/db/queries.js');
const { claimTaskOperation } = await import('../server/task-run-lifecycle.js');
const { startRun, startCompactionRun, discardRun } = await import('../server/live-chat.js');
const { verifyCodingRun, cancelCodingVerification } = await import('../server/coding-verification.js');
const { default: db } = await import('../server/db/index.js');

const project = createProject({ name: 'Shared checkout', purpose: 'Mutation ownership', managerProfileId: 'default', changedBy: 'test' });
upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
upsertProjectRepositoryLink(project.id, 77, { id: 9001, name: 'fixture', fullName: 'fixture/repo', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/repo', cloneUrl: join(root, 'unused.git') });
const target = insertTask({ title: 'Requested task', status: 'in_progress', project_id: project.id });
const owner = insertTask({ title: 'Other editor', status: 'in_progress', project_id: project.id, workdir: join(root, 'checkout') });
const routes = ['editor/acquire', 'editor/prepare', 'editor/release', 'sync', 'commit-push', 'versions/version-1/revert'];
let mutation: () => Promise<never> = async () => { throw new Error('Unexpected checkout mutation'); };
// A controllable Git boundary lets each route remain pending after its caller disconnects.
const projectCp = Object.fromEntries(['acquireEditor', 'prepareTask', 'releaseEditor', 'sync', 'commitPush', 'revert', 'status'].map(name => [name, () => mutation()])) as unknown as ProjectCpService;
const app = express();
app.use(express.json());
app.use('/api/projects', createProjectsRouter({ projectCp }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const post = (route: string, signal?: AbortSignal) => fetch(`http://127.0.0.1:${address.port}/api/projects/${project.id}/${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: target.id, message: 'Save work' }), signal,
});
async function assertBlocked() {
  for (const route of routes) {
    const response = await post(route);
    const body = await response.json();
    assert.equal(response.status, 409, `${route}: ${JSON.stringify(body)}`);
    assert.equal(body.code, 'PROJECT_OPERATION_ACTIVE', route);
  }
}
async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Fixture operation did not settle');
}

try {
  await test('a pending sync checkpoint identifies the editor who can publish it', async () => {
    mutation = async () => { throw new ProjectRepositoryCheckpointError(owner.id); };
    try {
      const response = await post('sync');
      const body = await response.json();
      assert.equal(response.status, 409);
      assert.equal(body.code, 'PROJECT_CHECKPOINT_PENDING');
      assert.equal(body.activeTaskId, owner.id);
    } finally {
      mutation = async () => { throw new Error('Unexpected checkout mutation'); };
    }
  });

  await test('all direct Project mutations reject another task operation in the checkout', async () => {
    const release = claimTaskOperation(owner.id, project.id);
    assert.ok(release);
    try { await assertBlocked(); } finally { release(); }
  });

  for (const phase of ['streaming', 'compacting']) await test(`all direct Project mutations reject another ${phase} task`, async () => {
    if (phase === 'streaming') startRun(owner.id, owner.id, 'Working');
    else startCompactionRun(owner.id, owner.id);
    try { await assertBlocked(); } finally { discardRun(owner.id); }
  });

  await test('an accepted chat still excludes Project mutation after its HTTP ownership ends', async () => {
    const { default: liveApp, adapter } = await import('../server/app.js');
    const { getLatestTaskAgentRun } = await import('../server/db/task-agent-runs.js');
    const liveProject = createProject({ name: 'Accepted chat', purpose: 'Post-202 ownership', managerProfileId: 'default', changedBy: 'test' });
    const task = insertTask({ title: 'Active editor', status: 'in_progress', project_id: liveProject.id });
    adapter.getBackgroundWork = async () => ({ available: true, work: [], continuation: { status: 'none' } });
    let entered = false;
    let complete!: () => void;
    adapter.chatStream = async function* (sessionId) {
      entered = true;
      await new Promise<void>(resolve => { complete = resolve; });
      yield { type: 'done', sessionId };
    };
    const liveServer = liveApp.listen(0, '127.0.0.1');
    await once(liveServer, 'listening');
    const liveAddress = liveServer.address();
    assert.ok(liveAddress && typeof liveAddress === 'object');
    const livePost = (path: string, body: unknown) => fetch(`http://127.0.0.1:${liveAddress.port}/api/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    try {
      assert.equal((await livePost(`tasks/${task.id}/messages`, { content: 'Keep working' })).status, 202);
      await waitFor(() => entered);
      const response = await livePost(`projects/${liveProject.id}/editor/release`, { taskId: task.id });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'PROJECT_OPERATION_ACTIVE');
    } finally {
      complete?.();
      await waitFor(() => getLatestTaskAgentRun(task.id)?.status === 'done');
      discardRun(task.id);
      liveServer.close(); await once(liveServer, 'close');
    }
  });

  await test('automatic verification keeps the shared checkout unavailable to direct mutation', async () => {
    const cwd = owner.workdir!;
    const ready = join(root, 'check-ready');
    await mkdir(join(cwd, '.olympus'), { recursive: true });
    await writeFile(join(cwd, '.olympus', 'verification.json'), JSON.stringify({ commands: [[process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready');setInterval(()=>{},1000)`]] }));
    const git = (...args: string[]) => promisify(execFile)('git', args, { cwd });
    await git('init');
    await git('add', '.');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Initial');
    const checking = verifyCodingRun(owner, 'automatic-check', 10_000);
    try {
      await waitFor(() => existsSync(ready));
      await assertBlocked();
    } finally {
      await cancelCodingVerification(owner.id);
      await checking;
    }
  });

  for (const route of routes) await test(`${route} retains Project ownership until a disconnected mutation settles`, async () => {
    let entered = false;
    let settle!: () => void;
    mutation = async () => {
      entered = true;
      await new Promise<void>(resolve => { settle = resolve; });
      throw new Error('Fixture Git failure');
    };
    const controller = new AbortController();
    const pending = post(route, controller.signal).catch(() => null);
    try {
      await waitFor(() => entered);
      controller.abort();
      await pending;
      await new Promise(resolve => setTimeout(resolve, 30));
      const conflicting = claimTaskOperation(owner.id, project.id);
      conflicting?.();
      assert.equal(conflicting, null, 'response close must not release a checkout still being mutated');
    } finally {
      settle?.();
      await waitFor(() => {
        const release = claimTaskOperation(owner.id, project.id);
        release?.();
        return Boolean(release);
      });
    }
  });
} finally {
  discardRun(owner.id);
  server.close(); await once(server, 'close'); db.close();
  await rm(root, { recursive: true, force: true });
}
