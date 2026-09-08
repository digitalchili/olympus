import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const root = await mkdtemp(join(tmpdir(), 'olympus-baseline-identity-'));
process.env.DB_PATH = join(root, 'test.db'); process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)('git', args, { cwd })).stdout.trim();
const { createProjectCpService } = await import('../server/project-cp.js');
const { createProject, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { insertTask } = await import('../server/db/queries.js');
const { default: db } = await import('../server/db/index.js');
try {
  const makeRemote = async (name: string) => {
    const seed = join(root, name); await mkdir(seed);
    await git(seed, 'init', '-b', 'main'); await git(seed, 'config', 'user.name', 'Fixture'); await git(seed, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(seed, 'identity.txt'), name); await git(seed, 'add', '.'); await git(seed, 'commit', '-m', name);
    await git(seed, 'checkout', '-b', 'develop');
    await writeFile(join(seed, 'identity.txt'), `${name}-develop`); await git(seed, 'commit', '-am', 'Develop');
    const remote = join(root, `${name}.git`); await git(root, 'clone', '--bare', seed, remote); return remote;
  };
  const a = await makeRemote('repository-a'); const b = await makeRemote('repository-b');
  upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
  const project = createProject({ name: 'Change source before tasks', purpose: 'Reconfigure safely', managerProfileId: 'default', changedBy: 'test' });
  const link = (id: number, cloneUrl: string, defaultBranch = 'main') => upsertProjectRepositoryLink(project.id, 77, { id, name: `repo-${id}`, fullName: `fixture/repo-${id}`, owner: 'fixture', private: false, defaultBranch, htmlUrl: 'https://example.invalid', cloneUrl });
  const service = createProjectCpService({ rootDir: join(root, 'checkouts') });
  await service.sync({ projectId: project.id, repositoryLink: link(1, a) });
  const changedRepo = link(2, b);
  const switched = await service.sync({ projectId: project.id, repositoryLink: changedRepo });
  assert.equal(switched.currentSha, await git(b, 'rev-parse', 'main'), 'changing the connected repository selects its own baseline');
  const changedBranch = link(2, b, 'develop');
  await service.sync({ projectId: project.id, repositoryLink: changedBranch });
  const task = insertTask({ title: 'Use current repository and branch', status: 'in_progress', project_id: project.id, handling_profile_id: 'default' });
  const workspace = await service.prepareTask({ projectId: project.id, taskId: task.id, profileId: 'default', repositoryLink: changedBranch });
  assert.equal(await readFile(join(workspace.workdir, 'identity.txt'), 'utf8'), 'repository-b-develop');
  const baselines = await readdir(join(root, 'checkouts', 'baselines'));
  const saved = await Promise.all(baselines.map(name => readFile(join(root, 'checkouts', 'baselines', name, 'identity.txt'), 'utf8')));
  assert.deepEqual(saved.sort(), ['repository-a', 'repository-b', 'repository-b-develop'], 'changing configuration preserves earlier downloaded baselines');
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
console.log('Repository and branch baseline identity tests passed');
