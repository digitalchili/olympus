import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GitRunner } from '../server/project-cp.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-empty-repository-'));
process.env.DB_PATH = join(root, 'test.db');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
const realRunner: GitRunner = async (cwd, args, options) => run('git', args, { cwd, env: { ...process.env, ...options?.env } });
const { createProjectCpService, projectBaselineWorkdir } = await import('../server/project-cp.js');
const { createProject, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { insertTask } = await import('../server/db/queries.js');
const { listProjectVersions } = await import('../server/db/project-cp.js');
const { default: db } = await import('../server/db/index.js');
let nextId = 1;

async function fixture(defaultBranch = 'main') {
  const id = nextId++;
  const remote = join(root, `remote-${id}.git`);
  await git(root, 'init', '--bare', '-b', defaultBranch, remote);
  const project = createProject({ name: `Empty ${id}`, purpose: 'Start from scratch', managerProfileId: 'default', changedBy: 'test' });
  const repositoryLink = upsertProjectRepositoryLink(project.id, 77, { id, name: `repo-${id}`, fullName: `fixture/repo-${id}`, owner: 'fixture', private: true, defaultBranch, htmlUrl: 'https://example.invalid', cloneUrl: remote });
  const checkouts = join(root, `checkouts-${id}`);
  const service = createProjectCpService({ rootDir: checkouts });
  const newTask = () => insertTask({ title: 'Build app', status: 'in_progress', project_id: project.id, handling_profile_id: 'default' });
  const task = newTask();
  const input = { projectId: project.id, taskId: task.id, profileId: 'default', repositoryLink };
  return { remote, checkouts, service, newTask, input, baseline: projectBaselineWorkdir(checkouts, project.id, repositoryLink) };
}

try {
  upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
  const f = await fixture();
  const a = await f.service.prepareTask(f.input);
  assert.deepEqual(await readdir(a.workdir), ['.git'], 'preparation adds no README or application files');
  assert.equal(await git(f.remote, 'show-ref').catch(() => ''), '', 'preparation does not publish anything');
  assert.equal((await f.service.status(f.input)).clean, true);
  const restarted = createProjectCpService({ rootDir: f.checkouts });
  assert.equal((await restarted.prepareTask(f.input)).id, a.id, 'restart reuses the task');
  const sync = await restarted.sync(f.input);
  assert.equal(sync.currentSha, a.baseSha);
  assert.match(sync.message, /empty|local/i, 'sync must not claim the starting commit is on GitHub');
  const bInput = { ...f.input, taskId: f.newTask().id };
  const b = await restarted.prepareTask(bInput);
  assert.equal(b.baseSha, a.baseSha, 'tasks share the same starting history');
  await writeFile(join(a.workdir, 'app.txt'), 'First application');
  await writeFile(join(b.workdir, 'other.txt'), 'Independent task');
  const version = await restarted.commitPush({ ...f.input, message: 'First app' });
  assert.equal(await git(f.remote, 'rev-parse', 'main'), a.baseSha, 'ordinary publication creates only an empty default-branch base');
  assert.equal(await git(f.remote, 'show', `${a.branchName}:app.txt`), 'First application');
  assert.equal(await git(f.remote, 'ls-tree', '--name-only', 'main'), '', 'application code still requires explicit deployment or merge');
  assert.equal(await git(f.remote, 'merge-base', 'main', a.branchName), a.baseSha, 'the first task is mergeable');
  assert.deepEqual(version.changedFiles, ['app.txt']);
  await restarted.commitPush({ ...bInput, message: 'Second task' });
  assert.equal(await git(f.remote, 'show', `${b.branchName}:other.txt`), 'Independent task');
  await git(a.workdir, 'push', 'origin', 'HEAD:main');
  assert.equal((await restarted.sync(f.input)).currentSha, version.commitSha);
  assert.equal(await readFile(join(b.workdir, 'other.txt'), 'utf8'), 'Independent task', 'sync preserves existing tasks');
  const c = await restarted.prepareTask({ ...f.input, taskId: f.newTask().id });
  assert.equal(await readFile(join(c.workdir, 'app.txt'), 'utf8'), 'First application');

  const deploy = await fixture('develop');
  const d = await deploy.service.prepareTask(deploy.input);
  await writeFile(join(d.workdir, 'app.txt'), 'Deploy first app');
  const deployed = await deploy.service.commitPush({ ...deploy.input, message: 'Initial deployment', deployToDefaultBranch: true });
  assert.equal(deployed.branchName, 'develop');
  assert.equal(await git(deploy.remote, 'rev-parse', 'develop'), deployed.commitSha);
  assert.equal(await git(deploy.remote, 'rev-parse', d.branchName), deployed.commitSha);

  const failure = await fixture();
  const failedTask = await failure.service.prepareTask(failure.input);
  await writeFile(join(failedTask.workdir, 'saved.txt'), 'Keep for retry');
  const rejected = createProjectCpService({ rootDir: failure.checkouts, gitRunner: async (cwd, args, options) => {
    if (args[0] === 'push') throw new Error('simulated publication failure');
    return realRunner(cwd, args, options);
  } });
  await assert.rejects(rejected.commitPush({ ...failure.input, message: 'Retry me' }), /simulated publication failure/);
  assert.equal(listProjectVersions(failure.input.projectId).length, 0);
  assert.equal(await readFile(join(failedTask.workdir, 'saved.txt'), 'utf8'), 'Keep for retry');
  assert.equal(await git(failure.remote, 'show-ref').catch(() => ''), '');
  await failure.service.commitPush({ ...failure.input, message: 'Retry succeeded' });

  const ambiguous = await fixture();
  const acceptedTask = await ambiguous.service.prepareTask(ambiguous.input);
  await writeFile(join(acceptedTask.workdir, 'app.txt'), 'Accepted before disconnect');
  const disconnected = createProjectCpService({ rootDir: ambiguous.checkouts, gitRunner: async (cwd, args, options) => {
    const result = await realRunner(cwd, args, options);
    if (args[0] === 'push') throw new Error('connection dropped after publication');
    return result;
  } });
  const accepted = await disconnected.commitPush({ ...ambiguous.input, message: 'Recover accepted first push' });
  assert.equal(await git(ambiguous.remote, 'rev-parse', 'main'), acceptedTask.baseSha);
  assert.equal(await git(acceptedTask.workdir, 'rev-parse', 'HEAD'), accepted.commitSha);
  assert.equal(listProjectVersions(ambiguous.input.projectId).length, 1);

  const racing = await fixture();
  const racingTask = await racing.service.prepareTask(racing.input);
  await writeFile(join(racingTask.workdir, 'app.txt'), 'Task publication');
  let concurrentSha = '';
  const concurrent = createProjectCpService({ rootDir: racing.checkouts, gitRunner: async (cwd, args, options) => {
    if (args[0] === 'push') {
      // Publish after Olympus has observed an empty remote, just before its push.
      const other = join(root, 'concurrent-publisher');
      await git(root, 'clone', racingTask.workdir, other);
      await writeFile(join(other, 'other.txt'), 'Concurrent work');
      await git(other, 'add', '.');
      await git(other, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Concurrent initial publication');
      concurrentSha = await git(other, 'rev-parse', 'HEAD');
      await git(other, 'push', racing.remote, 'HEAD:main');
    }
    return realRunner(cwd, args, options);
  } });
  await assert.rejects(concurrent.commitPush({ ...racing.input, message: 'Concurrent first push', deployToDefaultBranch: true }));
  assert.equal(await git(racing.remote, 'rev-parse', 'main'), concurrentSha, 'first publication never overwrites a concurrently created branch');
  await assert.rejects(git(racing.remote, 'rev-parse', `refs/heads/${racingTask.branchName}`), 'atomic rejection must not leave half a publication');
  assert.equal(listProjectVersions(racing.input.projectId).length, 0);
  assert.equal(await readFile(join(racingTask.workdir, 'app.txt'), 'utf8'), 'Task publication');

  // An external initial commit may arrive after local preparation. Sync can replace
  // the untouched disposable baseline, but must never reset an existing task.
  const external = await fixture();
  const e = await external.service.prepareTask(external.input);
  await writeFile(join(e.workdir, 'saved.txt'), 'Keep local work');
  const seed = join(root, 'external-seed'); await mkdir(seed);
  await git(seed, 'init', '-b', 'main');
  await writeFile(join(seed, 'README.md'), 'External initial commit');
  await git(seed, 'add', '.');
  await git(seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'External initial commit');
  const externalSha = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'push', external.remote, 'main');
  assert.equal((await external.service.sync(external.input)).currentSha, externalSha);
  assert.equal(await git(e.workdir, 'rev-parse', 'HEAD'), e.baseSha);
  assert.equal(await readFile(join(e.workdir, 'saved.txt'), 'utf8'), 'Keep local work');
  await assert.rejects(external.service.commitPush({ ...external.input, message: 'Cannot replace upstream', deployToDefaultBranch: true }));
  assert.equal(await git(external.remote, 'rev-parse', 'main'), externalSha);

  const modified = await fixture();
  await modified.service.prepareTask(modified.input);
  await writeFile(join(modified.baseline, 'keep.txt'), 'Manual baseline change');
  await git(seed, 'push', modified.remote, 'main');
  await assert.rejects(modified.service.sync(modified.input), /baseline has local changes/);
  assert.equal(await readFile(join(modified.baseline, 'keep.txt'), 'utf8'), 'Manual baseline change');

  const missing = await fixture();
  await git(seed, 'push', missing.remote, 'main:develop');
  await assert.rejects(missing.service.prepareTask(missing.input), /Remote branch main not found/);
  assert.deepEqual(await readdir(join(missing.checkouts, 'baselines')), [], 'failed preparation leaves no false empty baseline');

  const tagged = await fixture();
  await git(seed, 'tag', 'v1');
  await git(seed, 'push', tagged.remote, 'refs/tags/v1');
  await assert.rejects(tagged.service.prepareTask(tagged.input), /Remote branch main not found/, 'a tag-only repository is not empty');

  const offline = await fixture();
  const offlineService = createProjectCpService({ rootDir: offline.checkouts, gitRunner: async (cwd, args, options) => {
    if (args[0] === 'clone' || args[0] === 'ls-remote') throw new Error('authentication unavailable');
    return realRunner(cwd, args, options);
  } });
  await assert.rejects(offlineService.prepareTask(offline.input), /authentication unavailable/);
  assert.deepEqual(await readdir(join(offline.checkouts, 'baselines')), []);
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}
console.log('Empty Project repository lifecycle tests passed');
