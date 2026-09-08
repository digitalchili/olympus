import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';

const root = await mkdtemp(join(tmpdir(), 'olympus-project-merge-test-'));
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.HERMES_HOME = join(root, 'hermes');
process.env.DB_PATH = join(root, 'state', 'test.db');
await mkdir(process.env.HERMES_HOME, { recursive: true });
await writeFile(join(process.env.HERMES_HOME, 'config.yaml'), '{}\n');
const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)('git', args, { cwd })).stdout.trim();
const { createProjectCpService } = await import('../server/project-cp.js');
const { createProject, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { insertTask, updateTask } = await import('../server/db/queries.js');
const { createProjectTaskWorkspaceRouter } = await import('../server/routes/project-task-workspace.js');
const { default: db } = await import('../server/db/index.js');

try {
  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');
  await mkdir(seed);
  await git(seed, 'init', '-b', 'main');
  await git(seed, 'config', 'user.name', 'Fixture');
  await git(seed, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(seed, 'README.md'), 'original\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'Initial');
  await git(root, 'clone', '--bare', seed, remote);
  upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
  const project = createProject({ name: 'Merge fixture', purpose: 'Safe Project recovery', managerProfileId: 'default', changedBy: 'test' });
  const link = upsertProjectRepositoryLink(project.id, 77, { id: 9001, name: 'fixture', fullName: 'fixture/repo', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/repo', cloneUrl: remote });
  const first = insertTask({ title: 'Original editor', status: 'in_progress', project_id: project.id, handling_profile_id: 'default' });
  const next = insertTask({ title: 'New chat', status: 'in_progress', project_id: project.id, handling_profile_id: 'default' });
  const service = createProjectCpService({ rootDir: join(root, 'checkouts') });
  const input = { projectId: project.id, taskId: first.id, profileId: 'default', repositoryLink: link };
  const lease = await service.prepareTask(input);
  await writeFile(join(lease.workdir, 'README.md'), 'saved Olympus work\n');
  await service.commitPush({ projectId: project.id, taskId: first.id, repositoryLink: link, message: 'Saved work' });
  updateTask(first.id, { status: 'in_review' });
  const saved = await git(lease.workdir, 'rev-parse', 'HEAD');
  await writeFile(join(seed, 'README.md'), 'new upstream content\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'Conflicting upstream');
  await git(seed, 'push', remote, 'main');
  await service.sync({ projectId: project.id, repositoryLink: link });

  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createProjectTaskWorkspaceRouter({ projectCp: service }));
  app.post('/api/tasks/:id/messages', (_req, res) => res.json({ started: true }));
  const httpServer = app.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const send = () => fetch(`http://127.0.0.1:${address.port}/api/tasks/${next.id}/messages?profile=default`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Continue work' }),
  });
  try {
    const response = await send();
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.started, true, 'another task starts from GitHub without merging into the older workspace');
    const { getProjectEditorForTask } = await import('../server/db/project-cp.js');
    const nextLease = getProjectEditorForTask(project.id, next.id)!;
    assert.notEqual(nextLease.workdir, lease.workdir);
    assert.equal(await readFile(join(nextLease.workdir, 'README.md'), 'utf8'), 'new upstream content\n');
    assert.equal(await git(lease.workdir, 'rev-parse', 'HEAD'), saved);
    assert.equal(await readFile(join(lease.workdir, 'README.md'), 'utf8'), 'saved Olympus work\n');

    await writeFile(join(lease.workdir, 'local-only.txt'), 'unpublished work\n');
    await git(lease.workdir, 'add', '.');
    await git(lease.workdir, 'commit', '-m', 'Unpublished user work');
    const unpublishedHead = await git(lease.workdir, 'rev-parse', 'HEAD');
    const syncedBase = getProjectEditorForTask(project.id, first.id)?.baseSha;
    await service.sync({ projectId: project.id, repositoryLink: link });
    assert.equal(getProjectEditorForTask(project.id, first.id)?.baseSha, syncedBase, 'baseline sync does not change task evidence');
    assert.equal(await git(lease.workdir, 'rev-parse', 'HEAD'), unpublishedHead);
    assert.equal((await service.status({ projectId: project.id, taskId: first.id })).clean, false);

    const remoteTaskBefore = await git(remote, 'rev-parse', `refs/heads/${lease.branchName}`);
    const remoteMainBefore = await git(remote, 'rev-parse', 'main');
    await assert.rejects(service.commitPush({ projectId: project.id, taskId: first.id, repositoryLink: link, message: 'Publish conflicting source', deployToDefaultBranch: true }), /rejected|atomic|failed/i);
    assert.equal(await git(remote, 'rev-parse', `refs/heads/${lease.branchName}`), remoteTaskBefore, 'atomic publish never advances only the task branch when default branch rejects');
    assert.equal(await git(remote, 'rev-parse', 'main'), remoteMainBefore, 'concurrent GitHub work is never force-pushed away');
    assert.equal(await readFile(join(lease.workdir, 'local-only.txt'), 'utf8'), 'unpublished work\n');
    assert.equal(getProjectEditorForTask(project.id, first.id)?.id, lease.id, 'failed publish keeps this task recoverable');
    assert.equal((await send()).status, 200, 'one task publish conflict never blocks another task');
    assert.equal(await readFile(join(nextLease.workdir, 'README.md'), 'utf8'), 'new upstream content\n');

  } finally {
    await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
  }
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}
console.log('Independent task conflict preservation and atomic publish tests passed');
