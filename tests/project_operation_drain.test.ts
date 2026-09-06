import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectCpService } from '../server/project-cp.js';

const root = await mkdtemp(join(tmpdir(), 'project-operation-drain-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'state', 'test.db');
await mkdir(process.env.HERMES_HOME, { recursive: true });
await writeFile(join(process.env.HERMES_HOME, 'config.yaml'), '{}\n');
const { default: app, adapter, drainController } = await import('../server/app.js');
const { createProjectsRouter } = await import('../server/routes/projects.js');
const { createProjectTaskWorkspaceRouter } = await import('../server/routes/project-task-workspace.js');
const { createTaskRecoveryRouter } = await import('../server/routes/task-recovery.js');
const { createProject, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { insertTask } = await import('../server/db/queries.js');
const { claimTaskOperation } = await import('../server/task-run-lifecycle.js');
const { default: db } = await import('../server/db/index.js');
adapter.setScheduledTasksDraining = () => {};
adapter.getScheduledTaskDrainStatus = async () => ({ draining: true, activeRuns: 0 });
const project = createProject({ name: 'Draining checkout', purpose: 'Preserve single writer', managerProfileId: 'default', changedBy: 'test' });
upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
upsertProjectRepositoryLink(project.id, 77, { id: 9001, name: 'fixture', fullName: 'fixture/repo', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/repo', cloneUrl: join(root, 'unused.git') });
const task = insertTask({ title: 'Editor', status: 'in_progress', project_id: project.id });
let mutation = async (): Promise<never> => { throw new Error('Unexpected mutation'); };
const projectCp = {
  sync: () => mutation(),
  prepareTask: async () => ({}),
  commitPush: () => mutation(),
} as unknown as ProjectCpService;
app.use('/test-projects', createProjectsRouter({ projectCp }));
app.use('/test-tasks', createTaskRecoveryRouter({ getBackgroundWork: async () => ({ available: true, work: [], continuation: { status: 'none' } }) }));
app.use('/test-tasks', createProjectTaskWorkspaceRouter({ projectCp }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Fixture operation did not settle');
}

try {
  await test('drain counts a task and its Project as one operation with idempotent release', async () => {
    const release = claimTaskOperation(task.id, project.id);
    assert.ok(release);
    try { assert.equal((await drainController.refreshStatus()).activeRuns, 1); }
    finally { release(); release(); }
    assert.equal((await drainController.refreshStatus()).activeRuns, 0);
  });

  for (const path of [`test-projects/${project.id}/sync`, `test-tasks/${task.id}/messages`]) {
    await test(`drain cannot hand off while disconnected ${path.split('/')[0]} Git work is pending`, async () => {
      let entered = false;
      let settled = false;
      let finish!: () => void;
      mutation = async () => {
        entered = true;
        await new Promise<void>(resolve => { finish = resolve; });
        settled = true;
        throw new Error('Fixture Git failure');
      };
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${address.port}/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '/commit push' }), signal: controller.signal,
      }).catch(() => null);
      try {
        await waitFor(() => entered);
        controller.abort(); await pending;
        await new Promise(resolve => setTimeout(resolve, 30));
        drainController.begin();
        assert.equal((await drainController.refreshStatus()).activeRuns, 1, 'closed HTTP request still owns an unsettled Git operation');
        assert.equal(await drainController.waitForIdle(30), false);
      } finally {
        finish?.();
        await waitFor(() => settled);
        assert.equal(await drainController.waitForIdle(1000), true, 'Git settlement releases the maintenance handoff');
        drainController.cancel();
      }
    });
  }
} finally {
  drainController.cancel();
  server.close(); await once(server, 'close'); db.close();
  await rm(root, { recursive: true, force: true });
}
