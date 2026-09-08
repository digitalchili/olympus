import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const root = await mkdtemp(join(tmpdir(), 'olympus-task-isolation-'));
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'state', 'test.db');
const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)('git', args, { cwd })).stdout.trim();
const { createProjectCpService, projectBaselineWorkdir } = await import('../server/project-cp.js');
const { createProject, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { insertTask, getTask, updateTask } = await import('../server/db/queries.js');
const { acquireProjectEditor, getProjectEditorForTask } = await import('../server/db/project-cp.js');
const { default: db } = await import('../server/db/index.js');

try {
  const seed = join(root, 'seed'); const remote = join(root, 'remote.git'); const checkouts = join(root, 'checkouts');
  await mkdir(seed); await mkdir(checkouts);
  await git(seed, 'init', '-b', 'main');
  await git(seed, 'config', 'user.name', 'Fixture'); await git(seed, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(seed, 'README.md'), 'Published baseline\n');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Initial');
  await git(root, 'clone', '--bare', seed, remote);
  upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
  const project = createProject({ name: 'Isolated tasks', purpose: 'Keep work independent', managerProfileId: 'default', changedBy: 'test' });
  const repositoryLink = upsertProjectRepositoryLink(project.id, 77, { id: 9001, name: 'fixture', fullName: 'fixture/repo', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/repo', cloneUrl: remote });
  const task = (title: string) => insertTask({ title, status: 'in_progress', project_id: project.id, handling_profile_id: 'default' });
  const legacy = task('Existing poster'); const first = task('First new task'); const second = task('Second new task');
  const legacyPath = join(checkouts, project.id);
  await git(root, 'clone', remote, legacyPath); await git(legacyPath, 'checkout', '-b', 'olympus/legacy');
  await writeFile(join(legacyPath, 'poster.png'), 'Saved poster bytes');
  const legacyLease = acquireProjectEditor({ projectId: project.id, taskId: legacy.id, profileId: 'default', repositoryFullName: repositoryLink.fullName, baseBranch: 'main', branchName: 'olympus/legacy', workdir: legacyPath, baseSha: await git(legacyPath, 'rev-parse', 'HEAD'), leaseToken: 'legacy-token' });
  updateTask(legacy.id, { workdir: legacyPath });
  const service = createProjectCpService({ rootDir: checkouts });
  const prepare = (taskId: string) => service.prepareTask({ projectId: project.id, taskId, profileId: 'default', repositoryLink });
  assert.equal((await prepare(legacy.id)).id, legacyLease.id);
  const [a, b] = await Promise.all([prepare(first.id), prepare(second.id)]);
  assert.equal(a.workdir, join(checkouts, 'tasks', project.id, first.id));
  assert.equal(b.workdir, join(checkouts, 'tasks', project.id, second.id));
  assert.notEqual(a.branchName, b.branchName);
  assert.equal(getProjectEditorForTask(project.id, legacy.id)?.id, legacyLease.id);
  assert.equal(await readFile(join(legacyPath, 'poster.png'), 'utf8'), 'Saved poster bytes');
  assert.equal(await git(legacyPath, 'status', '--porcelain'), '?? poster.png', 'new clones never appear within the legacy repository');
  assert.equal(await git(a.workdir, 'remote', 'get-url', 'origin'), remote);
  assert.equal(await git(b.workdir, 'remote', 'get-url', 'origin'), remote);

  await writeFile(join(a.workdir, 'A.txt'), 'Task A only'); await writeFile(join(b.workdir, 'B.txt'), 'Task B only');
  assert.deepEqual((await service.status({ projectId: project.id, taskId: first.id })).changedFiles, ['A.txt']);
  assert.deepEqual((await service.status({ projectId: project.id, taskId: second.id })).changedFiles, ['B.txt']);
  const publish = (taskId: string) => service.commitPush({ projectId: project.id, taskId, repositoryLink, message: 'Save this task' });
  const [versionA, versionB] = await Promise.all([publish(first.id), publish(second.id)]);
  assert.equal(await git(remote, 'show', `${a.branchName}:A.txt`), 'Task A only');
  assert.equal(await git(remote, 'show', `${b.branchName}:B.txt`), 'Task B only');
  await assert.rejects(git(remote, 'show', `${a.branchName}:B.txt`));
  await assert.rejects(git(remote, 'show', `${b.branchName}:A.txt`));
  await git(a.workdir, 'fetch', 'origin', b.branchName);
  await assert.rejects(service.revert({ projectId: project.id, taskId: first.id, repositoryLink, versionId: versionB.id }), /version.*task|not found/i, 'a version from another task cannot be restored into this workspace');
  assert.equal(await readFile(join(a.workdir, 'A.txt'), 'utf8'), 'Task A only');
  await git(b.workdir, 'fetch', 'origin', a.branchName);
  await git(b.workdir, 'reset', '--hard', versionA.commitSha);
  assert.equal((await service.status({ projectId: project.id, taskId: second.id })).clean, false, 'publication by another task cannot establish this task’s published baseline');
  await git(b.workdir, 'reset', '--hard', versionB.commitSha);
  const released = await service.releaseEditor({ projectId: project.id, taskId: first.id });
  assert.equal(getTask(first.id)?.workdir, a.workdir, 'release preserves the durable task workspace');
  await writeFile(join(a.workdir, 'UNFINISHED.txt'), 'Keep after reopening');
  const resumed = await prepare(first.id);
  assert.equal(resumed.id, released.id, 'only the matching retained task lease is reactivated');
  assert.equal(resumed.workdir, a.workdir);
  assert.equal(await readFile(join(a.workdir, 'UNFINISHED.txt'), 'utf8'), 'Keep after reopening');

  const unpublishedBefore = await git(a.workdir, 'rev-parse', 'HEAD');
  const statusBefore = await git(a.workdir, 'status', '--porcelain');
  let credentialRequests = 0;
  await assert.rejects(service.commitPush({ projectId: project.id, taskId: first.id,
    repositoryLink: { ...repositoryLink, cloneUrl: 'https://github.com/other/repository.git' },
    message: 'Must not publish to a different origin', tokenProvider: async () => { credentialRequests++; return 'fixture-token'; },
  }), /origin.*does not match/);
  assert.equal(credentialRequests, 0, 'unexpected origin never receives a GitHub App credential');
  assert.equal(await git(a.workdir, 'rev-parse', 'HEAD'), unpublishedBefore, 'origin validation precedes local commit mutation');
  assert.equal(await git(a.workdir, 'status', '--porcelain'), statusBefore);

  const originalHead = await git(a.workdir, 'rev-parse', 'HEAD');
  await writeFile(join(seed, 'UPSTREAM.txt'), 'New published source');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Update baseline'); await git(seed, 'push', remote, 'main');
  const offline = createProjectCpService({ rootDir: checkouts, gitRunner: async (cwd, args, options) => {
    if (args[0] === 'fetch' || args[0] === 'ls-remote') throw new Error('GitHub unavailable');
    return promisify(execFile)('git', args, { cwd, env: { ...process.env, ...options?.env } });
  } });
  const cached = await offline.prepareTask({ projectId: project.id, taskId: task('Start from downloaded source').id, profileId: 'default', repositoryLink });
  assert.equal(await readFile(join(cached.workdir, 'README.md'), 'utf8'), 'Published baseline\n');
  await assert.rejects(readFile(join(cached.workdir, 'UPSTREAM.txt')), 'new task preparation never silently changes the last synced source');
  const sync = await service.sync({ projectId: project.id, repositoryLink, releaseEditorLeaseId: legacyLease.id });
  assert.equal(sync.updated, true);
  assert.equal(sync.currentSha, await git(seed, 'rev-parse', 'HEAD'));
  assert.equal(await git(a.workdir, 'rev-parse', 'HEAD'), originalHead, 'Project sync never changes existing task source');
  assert.equal(getProjectEditorForTask(project.id, legacy.id)?.id, legacyLease.id, 'obsolete release parameter cannot release legacy work');
  assert.equal((await service.sync({ projectId: project.id, repositoryLink })).updated, false);
  const fresh = await prepare(task('Fresh after sync').id);
  assert.equal(await readFile(join(fresh.workdir, 'UPSTREAM.txt'), 'utf8'), 'New published source');
  await assert.rejects(readFile(join(a.workdir, 'UPSTREAM.txt')));
  assert.equal(await readFile(join(legacyPath, 'poster.png'), 'utf8'), 'Saved poster bytes');

  // Old released leases may refer to another task's still-live shared checkout.
  const historical = task('Old released task');
  db.prepare(`INSERT INTO project_editor_leases SELECT 'historical-lease', project_id, ?, profile_id, repository_full_name, base_branch, branch_name, workdir, base_sha, 'released', 'old-token', created_at, updated_at, updated_at FROM project_editor_leases WHERE id = ?`).run(historical.id, legacyLease.id);
  const reopened = await prepare(historical.id);
  assert.notEqual(reopened.workdir, legacyPath, 'a historical released shared lease is never reused for a task with no retained workspace');
  assert.equal(await readFile(join(legacyPath, 'poster.png'), 'utf8'), 'Saved poster bytes');

  const failedTask = task('Interrupted initial clone');
  const failedPath = join(checkouts, 'tasks', project.id, failedTask.id);
  const failing = createProjectCpService({ rootDir: checkouts, gitRunner: async (cwd, args, options) => {
    if (args[0] === 'clone' && args.includes(projectBaselineWorkdir(checkouts, project.id, repositoryLink))) {
      await mkdir(failedPath); await writeFile(join(failedPath, 'PARTIAL'), 'Incomplete clone');
      throw new Error('Clone interrupted');
    }
    return promisify(execFile)('git', args, { cwd, env: { ...process.env, ...options?.env } });
  } });
  await assert.rejects(failing.prepareTask({ projectId: project.id, taskId: failedTask.id, profileId: 'default', repositoryLink }), /Clone interrupted/);
  assert.equal((await prepare(failedTask.id)).workdir, failedPath, 'a failed initial clone can be retried without an orphan workspace blocker');
  assert.equal(await readFile(join(legacyPath, 'poster.png'), 'utf8'), 'Saved poster bytes');

  const unsafeRoot = join(root, 'unsafe-checkouts'); const outside = join(root, 'outside');
  await mkdir(unsafeRoot); await mkdir(outside); await symlink(outside, join(unsafeRoot, 'tasks'));
  const unsafeTask = task('Do not follow a redirected parent');
  await assert.rejects(createProjectCpService({ rootDir: unsafeRoot }).prepareTask({ projectId: project.id, taskId: unsafeTask.id, profileId: 'default', repositoryLink }), /symbolic link/);
  await assert.rejects(readFile(join(outside, project.id, unsafeTask.id, 'README.md')));
} finally {
  db.close(); await rm(root, { recursive: true, force: true });
}
console.log('Independent task workspace and legacy preservation tests passed');
