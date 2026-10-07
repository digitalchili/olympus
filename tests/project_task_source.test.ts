import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const root = await mkdtemp(join(tmpdir(), 'olympus-task-source-'));
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'state/test.db');
const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)('git', args, { cwd })).stdout.trim();
const { createProjectCpService } = await import('../server/project-cp.js');
const { createProject, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
const { getProjectSyncEvidence } = await import('../server/db/project-sync.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { insertTask } = await import('../server/db/queries.js');
const { default: db } = await import('../server/db/index.js');

try {
  const seed = join(root, 'seed'); const remote = join(root, 'remote.git');
  await mkdir(seed);
  await git(seed, 'init', '-b', 'main');
  await git(seed, 'config', 'user.name', 'Fixture'); await git(seed, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(seed, 'README.md'), 'Initial README\n');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Initial');
  await git(root, 'clone', '--bare', seed, remote);
  upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
  const project = createProject({ name: 'Fresh task source', purpose: 'Keep tasks current', managerProfileId: 'default', changedBy: 'test' });
  const repositoryLink = upsertProjectRepositoryLink(project.id, 77, { id: 9001, name: 'fixture', fullName: 'fixture/repo', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/repo', cloneUrl: remote });
  const service = createProjectCpService({ rootDir: join(root, 'checkouts') });
  const input = () => ({ projectId: project.id, taskId: insertTask({ title: 'Work', status: 'in_progress', project_id: project.id, handling_profile_id: 'default' }).id, profileId: 'default', repositoryLink });
  const old = input(); const oldLease = await service.prepareTask(old);
  const oldHead = await git(oldLease.workdir, 'rev-parse', 'HEAD');
  await writeFile(join(seed, 'website.txt'), 'The current website\n');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Website'); await git(seed, 'push', remote, 'main');
  const websiteHead = await git(seed, 'rev-parse', 'HEAD');

  // Reusing a cached baseline must never silently give a new task the old README-only tree.
  const fresh = input(); const freshLease = await service.prepareTask(fresh);
  assert.equal(await readFile(join(freshLease.workdir, 'website.txt'), 'utf8'), 'The current website\n');
  assert.equal(await git(freshLease.workdir, 'rev-parse', 'HEAD'), websiteHead);
  assert.equal(getProjectSyncEvidence(repositoryLink)?.currentSha, websiteHead);
  assert.equal(await git(oldLease.workdir, 'rev-parse', 'HEAD'), oldHead, 'starting another task never mutates an existing task');

  const updated = await service.updateTaskSource(old);
  assert.equal(updated.updated, true);
  assert.equal(updated.currentSha, websiteHead);
  assert.equal((await service.status(old)).clean, true, 'an upstream-only update is not an unpublished task change');
  assert.equal((await service.updateTaskSource(old)).updated, false);
  assert.equal(await git(oldLease.workdir, 'branch', '--show-current'), oldLease.branchName);

  // Concurrent tasks merge distinct committed changes, then publish both without overwriting main.
  await writeFile(join(oldLease.workdir, 'task-a.txt'), 'Task A\n');
  const a = await service.commitPush({ ...old, message: 'Task A', deployToDefaultBranch: true });
  await writeFile(join(freshLease.workdir, 'task-b.txt'), 'Task B\n');
  await git(freshLease.workdir, 'add', '.'); await git(freshLease.workdir, 'commit', '-m', 'Task B local checkpoint');
  const localB = await git(freshLease.workdir, 'rev-parse', 'HEAD');
  await git(freshLease.workdir, 'config', `branch.${freshLease.branchName}.mergeOptions`, '--squash');
  await git(freshLease.workdir, 'config', 'pull.twohead', 'ours');
  const merged = await service.updateTaskSource(fresh);
  assert.equal(merged.updated, true);
  assert.equal(await readFile(join(freshLease.workdir, 'task-a.txt'), 'utf8'), 'Task A\n');
  assert.equal(await readFile(join(freshLease.workdir, 'task-b.txt'), 'utf8'), 'Task B\n');
  assert.equal(await git(freshLease.workdir, 'merge-base', '--is-ancestor', localB, 'HEAD'), '');
  assert.equal(await git(freshLease.workdir, 'merge-base', '--is-ancestor', a.commitSha, 'HEAD'), '');
  assert.equal((await service.status(fresh)).clean, false, 'the combined task commit still needs publication');
  assert.equal(await git(remote, 'rev-parse', 'main'), a.commitSha, 'updating source never publishes');
  const b = await service.commitPush({ ...fresh, message: 'Task B', deployToDefaultBranch: true });
  assert.equal(await git(remote, 'rev-parse', 'main'), b.commitSha);
  assert.equal(await git(remote, 'show', 'main:task-a.txt'), 'Task A');
  assert.equal(await git(remote, 'show', 'main:task-b.txt'), 'Task B');

  await service.releaseEditor(fresh);
  assert.equal((await service.updateTaskSource(fresh)).updated, false, 'published tasks can explicitly update their retained workspace');

  const conflict = input(); const conflictLease = await service.prepareTask(conflict);
  await writeFile(join(conflictLease.workdir, 'README.md'), 'Task wording\n');
  await git(conflictLease.workdir, 'add', '.'); await git(conflictLease.workdir, 'commit', '-m', 'Local wording');
  const beforeConflict = await git(conflictLease.workdir, 'rev-parse', 'HEAD');
  await git(seed, 'fetch', remote, 'main'); await git(seed, 'merge', '--ff-only', 'FETCH_HEAD');
  await writeFile(join(seed, 'README.md'), 'Different upstream wording\n');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Upstream wording'); await git(seed, 'push', remote, 'main');
  await assert.rejects(service.updateTaskSource(conflict), /conflict/i);
  assert.equal(await git(conflictLease.workdir, 'rev-parse', 'HEAD'), beforeConflict);
  assert.equal(await readFile(join(conflictLease.workdir, 'README.md'), 'utf8'), 'Task wording\n');
  assert.equal(await git(conflictLease.workdir, 'status', '--porcelain'), '', 'conflict attempt is aborted without discarding prior work');
  await writeFile(join(oldLease.workdir, 'unsaved.txt'), 'Keep me\n');
  await assert.rejects(service.updateTaskSource(old), /uncommitted/i);
  assert.equal(await readFile(join(oldLease.workdir, 'unsaved.txt'), 'utf8'), 'Keep me\n');

  // Git normally overwrites ignored files during a merge; task-local files must survive.
  await writeFile(join(seed, '.gitignore'), 'runtime.txt\n');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Ignore task runtime file'); await git(seed, 'push', remote, 'main');
  const ignored = input(); const ignoredLease = await service.prepareTask(ignored);
  await writeFile(join(ignoredLease.workdir, 'runtime.txt'), 'Private local content\n');
  await writeFile(join(seed, 'runtime.txt'), 'New tracked content\n');
  await git(seed, 'add', '-f', 'runtime.txt'); await git(seed, 'commit', '-m', 'Track runtime file'); await git(seed, 'push', remote, 'main');
  await assert.rejects(service.updateTaskSource(ignored), 'an update must refuse overwriting ignored local files');
  assert.equal(await readFile(join(ignoredLease.workdir, 'runtime.txt'), 'utf8'), 'Private local content\n');
  assert.equal(await git(ignoredLease.workdir, 'rev-parse', 'HEAD'), ignoredLease.baseSha);

  // A task started while GitHub was empty must explain an independently initialized history.
  const emptyRemote = join(root, 'empty.git'); await git(root, 'init', '--bare', '-b', 'main', emptyRemote);
  const emptyProject = createProject({ name: 'Initially empty', purpose: 'Preserve independent history', managerProfileId: 'default', changedBy: 'test' });
  const emptyLink = upsertProjectRepositoryLink(emptyProject.id, 77, { id: 9002, name: 'empty', fullName: 'fixture/empty', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/empty', cloneUrl: emptyRemote });
  const emptyInput = { projectId: emptyProject.id, taskId: insertTask({ title: 'Empty start', status: 'in_progress', project_id: emptyProject.id, handling_profile_id: 'default' }).id, profileId: 'default', repositoryLink: emptyLink };
  const emptyLease = await service.prepareTask(emptyInput);
  await git(seed, 'push', emptyRemote, 'main');
  await assert.rejects(service.updateTaskSource(emptyInput), /no shared history/i);
  assert.equal(await git(emptyLease.workdir, 'rev-parse', 'HEAD'), emptyLease.baseSha);
  assert.equal(await git(emptyLease.workdir, 'status', '--porcelain'), '');

  let tokenRequests = 0;
  await assert.rejects(service.updateTaskSource({ ...fresh, repositoryLink: { ...repositoryLink, cloneUrl: 'https://github.com/other/repo.git' }, tokenProvider: async () => { tokenRequests++; return 'test-token'; } }), /origin.*does not match/);
  assert.equal(tokenRequests, 0, 'origin validation precedes credential issuance');
  const offline = createProjectCpService({ rootDir: join(root, 'checkouts'), gitRunner: async (cwd, args, options) => {
    if (args[0] === 'fetch') throw new Error('Offline');
    return promisify(execFile)('git', args, { cwd, env: options?.env });
  } });
  await assert.rejects(offline.prepareTask(input()), { code: 'PROJECT_GIT_UNAVAILABLE' }, 'new tasks cannot silently start from stale cached code');
  assert.equal((await offline.prepareTask(old)).id, oldLease.id, 'existing work can still resume offline');
} finally {
  db.close(); await rm(root, { recursive: true, force: true });
}
console.log('Fresh task source and safe two-task merge tests passed');
