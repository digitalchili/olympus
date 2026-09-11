import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const root = await mkdtemp(join(tmpdir(), 'olympus-github-access-'));
process.env.DB_PATH = join(root, 'test.db');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
const { default: db } = await import('../server/db/index.js');
const { createProject } = await import('../server/db/projects.js');
const { insertTask } = await import('../server/db/queries.js');
const { upsertGitHubInstallation, deleteGitHubInstallation } = await import('../server/db/studio-projects.js');
const { getProjectGitHubInstallationIds, setProjectGitHubInstallationIds } = await import('../server/db/project-github-access.js');
const { createProjectGitHubService, runProjectSourceGit } = await import('../server/project-github.js');
const run = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await run('git', args, { cwd })).stdout.trim();
try {
  for (const id of [11, 22]) upsertGitHubInstallation({ id, accountLogin: `account${id}`, accountType: 'User', permissionMode: 'read_write' });
  const project = createProject({ name: 'Migration', purpose: 'Import sources', managerProfileId: 'default', changedBy: 'test' });
  const other = createProject({ name: 'Other', purpose: 'No source access', managerProfileId: 'default', changedBy: 'test' });
  const task = insertTask({ title: 'Migrate', status: 'in_progress', project_id: project.id, profile_name: 'default', handling_profile_id: 'default' });
  const otherTask = insertTask({ title: 'Other task', status: 'in_progress', project_id: other.id, profile_name: 'default', handling_profile_id: 'default' });
  assert.deepEqual(getProjectGitHubInstallationIds(project.id), []);
  setProjectGitHubInstallationIds(project.id, [22, 11, 22]);
  assert.deepEqual(getProjectGitHubInstallationIds(project.id), [11, 22]);
  assert.equal(deleteGitHubInstallation(22), false, 'selected account cannot be disconnected behind a Project');
  assert.throws(() => setProjectGitHubInstallationIds(project.id, [999]));
  assert.deepEqual(getProjectGitHubInstallationIds(project.id), [11, 22], 'invalid replacement is atomic');

  const remote = join(root, 'remote.git'); const seed = join(root, 'seed'); await mkdir(seed);
  await git(seed, ['init', '-b', 'main']);
  await writeFile(join(seed, 'app.txt'), 'original'); await git(seed, ['add', '.']);
  await git(seed, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'First']);
  const first = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['checkout', '-b', 'develop']);
  await writeFile(join(seed, 'dev.txt'), 'development'); await git(seed, ['add', '.']);
  await git(seed, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Develop']);
  await git(seed, ['checkout', 'main']); await git(root, ['clone', '--bare', seed, remote]);
  const repo = { id: 123, name: 'source', fullName: 'account22/source', owner: 'account22', private: true, defaultBranch: 'main', cloneUrl: 'https://github.com/account22/source.git', htmlUrl: 'https://github.com/account22/source' };
  const tokens: unknown[] = []; const catalog: number[] = []; const argsSeen: string[][] = [];
  const gateway = {
    configured: true,
    async listRepositories(id: number, options?: { readOnly?: boolean }) { assert.equal(options?.readOnly, true); catalog.push(id); return id === 22 ? [repo] : []; },
    async installationToken(id: number, options?: { readOnly?: boolean; repositoryId?: number; signal?: AbortSignal }) {
      assert.ok(options?.signal);
      tokens.push({ id, options: { readOnly: options?.readOnly, repositoryId: options?.repositoryId } });
      return 'fake-private-token';
    },
  };
  const service = createProjectGitHubService({ github: gateway as any, workspaceForTask: () => join(root, 'workspace'),
    gitRunner: async (cwd, args, options) => {
      argsSeen.push(args);
      assert.equal(args.join(' ').includes('fake-private-token'), false);
      if (options?.env) assert.ok(Object.values(options.env).some(value => value?.includes(Buffer.from('x-access-token:fake-private-token').toString('base64'))));
      return run('git', args.map(arg => ['clone', 'ls-remote'].includes(args[0]) && arg === repo.cloneUrl ? remote : arg), { cwd });
    },
  });
  const request = (action: 'list' | 'check' | 'clone', repository?: string) => ({ requestId: 'request', workerRunId: 'run', action, repository });
  const call = (action: 'list' | 'check' | 'clone', repository?: string) => service.execute(task, request(action, repository), () => true);
  const listed = await call('list'); assert.equal(listed.ok, true); assert.equal((listed.repositories as any[])[0].fullName, repo.fullName);
  const checked = await call('check', repo.fullName); assert.equal(checked.ok, true); assert.deepEqual(checked.branches, ['develop', 'main']);
  const cloned = await call('clone', repo.fullName); assert.equal(cloned.ok, true); const path = String(cloned.path);
  assert.equal(await readFile(join(path, 'app.txt'), 'utf8'), 'original');
  assert.equal(await git(path, ['rev-parse', 'HEAD']), first);
  assert.equal(await git(path, ['show', 'origin/develop:dev.txt']), 'development', 'all branches and history available');
  assert.equal(await git(path, ['remote', 'get-url', '--push', 'origin']), 'DISABLED');
  assert.equal((await readFile(join(path, '.git', 'config'), 'utf8')).includes('fake-private-token'), false);
  assert.ok(tokens.every(value => JSON.stringify(value) === JSON.stringify({ id: 22, options: { readOnly: true, repositoryId: 123 } })));
  await writeFile(join(path, 'keep.txt'), 'Keep local edits');
  assert.equal((await call('clone', repo.fullName)).existing, true);
  assert.equal(await readFile(join(path, 'keep.txt'), 'utf8'), 'Keep local edits');
  await rm(join(path, '.git'), { recursive: true });
  const invalidClone = await call('clone', repo.fullName);
  assert.equal(invalidClone.ok, false, 'an existing folder without the expected repository is not a successful clone');
  assert.equal(await readFile(join(path, 'keep.txt'), 'utf8'), 'Keep local edits');
  assert.equal((await call('clone', '../../etc')).ok, false);
  assert.equal((await service.execute(otherTask, request('clone', repo.fullName), () => true)).ok, false);
  assert.equal((await service.execute(task, request('clone', repo.fullName), () => false)).ok, false);
  let started!: () => void;
  const gitStarted = new Promise<void>(resolve => { started = resolve; });
  let running = true; let aborted = false;
  const stoppedService = createProjectGitHubService({ github: gateway as any, workspaceForTask: () => join(root, 'workspace'),
    gitRunner: async (_cwd, _args, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      started();
    }),
  });
  const stoppedCheck = stoppedService.execute(task, request('check', repo.fullName), () => running);
  await gitStarted; running = false;
  assert.equal((await stoppedCheck).ok, false);
  assert.equal(aborted, true, 'Stop aborts pending Git and waits for cleanup');
  const controller = new AbortController();
  const realGit = runProjectSourceGit(root, ['-c', 'alias.wait=!sleep 60', 'wait'], { signal: controller.signal });
  const stop = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(realGit); } finally { clearTimeout(stop); }
  const revokingService = createProjectGitHubService({ github: {
    ...gateway,
    async listRepositories(id: number) {
      if (id === 22) setProjectGitHubInstallationIds(project.id, [22]);
      return [{ ...repo, fullName: `account${id}/source` }];
    },
  } as any, workspaceForTask: () => join(root, 'workspace') });
  assert.equal((await revokingService.execute(task, request('list'), () => true)).ok, false,
    'revocation while a later account loads must withhold the earlier account listing');
  setProjectGitHubInstallationIds(project.id, [11]);
  const before = tokens.length;
  assert.equal((await call('check', repo.fullName)).ok, false);
  assert.equal(tokens.length, before, 'revoked selection never mints a source token');
  assert.equal(await readFile(join(path, 'keep.txt'), 'utf8'), 'Keep local edits', 'revocation does not erase previous work');
  assert.equal(deleteGitHubInstallation(22), true);
  assert.ok(argsSeen.some(args => args.includes('--no-recurse-submodules')));
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
console.log('Project GitHub account selection and source access passed');
