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
const { getProjectEditor } = await import('../server/db/project-cp.js');
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
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.code, 'PROJECT_MERGE_CONFLICT');
    assert.deepEqual(body.conflictingFiles, ['README.md']);
    assert.equal(body.activeTaskId, first.id);
    assert.match(body.error, /README\.md/);
    assert.equal(await git(lease.workdir, 'rev-parse', 'HEAD'), saved);
    assert.equal(await readFile(join(lease.workdir, 'README.md'), 'utf8'), 'saved Olympus work\n');
    assert.equal(await git(lease.workdir, 'status', '--porcelain'), '');
    assert.equal(getProjectEditor(project.id)?.taskId, first.id);
    assert.equal((await service.prepareTask(input)).taskId, first.id, 'original editor remains available for conflict recovery');

    const external = join(root, 'external');
    await git(root, 'clone', remote, external);
    await git(external, 'config', 'user.name', 'Fixture');
    await git(external, 'config', 'user.email', 'fixture@example.invalid');
    await git(external, 'checkout', lease.branchName);
    await writeFile(join(external, 'remote-only.txt'), 'published elsewhere\n');
    await git(external, 'add', '.');
    await git(external, 'commit', '-m', 'Published branch advance');
    await git(external, 'push', 'origin', lease.branchName);
    const published = await git(external, 'rev-parse', 'HEAD');
    assert.equal((await send()).status, 409);
    assert.equal(await git(lease.workdir, 'rev-parse', 'HEAD'), published);
    assert.equal(getProjectEditor(project.id)?.baseSha, published, 'published fast-forward is not misclassified as an unpublished checkpoint');
    assert.equal((await service.status({ projectId: project.id, taskId: first.id })).clean, true);
    assert.equal((await send()).status, 409, 'retry remains a resolvable conflict, not a permanently busy editor');

    await assert.rejects(git(external, 'merge', '--no-edit', 'origin/main'));
    await git(external, 'checkout', '--ours', 'README.md');
    await git(external, 'add', 'README.md');
    await git(external, 'commit', '-m', 'Resolve conflict preserving saved work');
    await git(external, 'push', 'origin', lease.branchName);
    await service.sync({ projectId: project.id, repositoryLink: link });
    assert.equal(getProjectEditor(project.id)?.baseSha, await git(lease.workdir, 'rev-parse', 'HEAD'));
    assert.equal((await service.status({ projectId: project.id, taskId: first.id })).clean, true, 'explicit sync reconciles the active lease');

    const syncedBase = getProjectEditor(project.id)?.baseSha;
    await writeFile(join(lease.workdir, 'local-only.txt'), 'unpublished work\n');
    await git(lease.workdir, 'add', '.');
    await git(lease.workdir, 'commit', '-m', 'Unpublished user work');
    await assert.rejects(service.sync({ projectId: project.id, repositoryLink: link }), /checkpoint|unpublished/i);
    assert.equal(getProjectEditor(project.id)?.baseSha, syncedBase, 'unpublished work never becomes a published baseline');
    assert.equal((await service.status({ projectId: project.id, taskId: first.id })).clean, false);

    await service.commitPush({ projectId: project.id, taskId: first.id, repositoryLink: link, message: 'Publish local work' });
    await writeFile(join(seed, 'upstream-only.txt'), 'independent upstream change\n');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-m', 'Nonconflicting upstream work');
    await git(seed, 'push', remote, 'main');
    const beforeMerge = await git(lease.workdir, 'rev-parse', 'HEAD');
    const pending = await send();
    const pendingBody = await pending.json();
    assert.equal(pending.status, 409, JSON.stringify(pendingBody));
    assert.equal(pendingBody.code, 'PROJECT_CHECKPOINT_PENDING');
    assert.equal(pendingBody.activeTaskId, first.id);
    assert.equal(getProjectEditor(project.id)?.taskId, first.id, 'unpublished merge retains its editor');
    assert.equal(getProjectEditor(project.id)?.baseSha, beforeMerge, 'only published progress advances the baseline');
    assert.equal((await service.status({ projectId: project.id, taskId: first.id })).clean, false);
    const merge = await git(lease.workdir, 'rev-parse', 'HEAD');
    assert.notEqual(merge, beforeMerge);
    await service.commitPush({ projectId: project.id, taskId: first.id, repositoryLink: link, message: 'Publish synchronized checkpoint' });
    assert.equal(await git(remote, 'rev-parse', `refs/heads/${lease.branchName}`), merge);
    assert.equal((await send()).status, 200, 'handoff succeeds after the previous editor publishes the merge');
    assert.equal(getProjectEditor(project.id)?.taskId, next.id);
  } finally {
    await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
  }
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}
console.log('Project conflict preservation and sync baseline regression tests passed');
