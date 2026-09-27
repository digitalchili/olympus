// Reuses the disposable real-Git setup from project_task_isolation.test.ts.
// stdout is CSV; stderr contains the bounded summary. No external Git/model calls.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const root = await mkdtemp(join(tmpdir(), 'olympus-prepare-benchmark-'));
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'state', 'test.db');
process.env.HERMES_HOME = join(root, 'hermes');
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();
const { createProjectCpService } = await import('../../server/project-cp.js');
const { createProject, upsertProjectRepositoryLink } = await import('../../server/db/projects.js');
const { upsertGitHubInstallation } = await import('../../server/db/studio-projects.js');
const { insertTask } = await import('../../server/db/queries.js');
const { default: db } = await import('../../server/db/index.js');
const rows: Array<{ phase: string; sample: number; operation: string; wallMs: number; gitProcesses: number; remoteClones: number; baselineClones: number; fetches: number }> = [];
try {
  const seed = join(root, 'seed'); const remote = join(root, 'remote.git');
  await mkdir(seed); await mkdir(process.env.HERMES_HOME, { recursive: true });
  await git(seed, 'init', '-b', 'main'); await git(seed, 'config', 'user.name', 'Fixture'); await git(seed, 'config', 'user.email', 'fixture@example.invalid');
  for (let i = 0; i < 20; i++) await writeFile(join(seed, `file-${i}.txt`), 'a'.repeat(1024));
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Benchmark baseline'); await git(root, 'clone', '--bare', seed, remote);
  upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
  const project = createProject({ name: 'Preparation benchmark', purpose: 'Disposable local measurement', managerProfileId: 'default', changedBy: 'test' });
  const repositoryLink = upsertProjectRepositoryLink(project.id, 77, { id: 9001, name: 'fixture', fullName: 'fixture/repo', owner: 'fixture', private: false, defaultBranch: 'main', htmlUrl: 'https://example.invalid/repo', cloneUrl: remote });
  let operations: string[][] = [];
  const service = createProjectCpService({ rootDir: join(root, 'checkouts'), gitRunner: async (cwd, args, options) => {
    assert.notEqual(args[0], 'push', 'Preparation never publishes'); operations.push(args);
    return exec('git', args, { cwd, env: options?.env });
  } });
  // First pair has no baseline/workspace yet; next two warm the service/filesystem.
  // Remaining pairs each create one new task clone, then reuse exactly that clone.
  for (let index = -3; index < 30; index++) {
    const phase = index === -3 ? 'initial' : index < 0 ? 'warmup' : 'warm';
    const task = insertTask({ title: 'Preparation fixture', status: 'in_progress', project_id: project.id, handling_profile_id: 'default' });
    const input = { projectId: project.id, taskId: task.id, profileId: 'default', repositoryLink, tokenProvider: async () => { throw Error('Local Git must not request credentials'); } };
    let original: Awaited<ReturnType<typeof service.prepareTask>> | undefined;
    for (const operation of ['new_task', 'reuse']) {
      operations = []; const started = performance.now();
      const lease = await service.prepareTask(input); const wallMs = performance.now() - started;
      const row = { phase, sample: index < 0 ? index + 4 : index + 1, operation, wallMs,
        gitProcesses: operations.length, remoteClones: operations.filter(args => args[0] === 'clone' && args.includes(remote)).length,
        baselineClones: operations.filter(args => args[0] === 'clone' && !args.includes(remote)).length,
        fetches: operations.filter(args => ['fetch', 'ls-remote'].includes(args[0])).length };
      assert.equal(row.fetches, 0, 'Preparation uses retained source, not a silent remote refresh');
      if (operation === 'new_task') {
        assert.equal(row.remoteClones, phase === 'initial' ? 1 : 0); assert.equal(row.baselineClones, 1);
        original = lease; await writeFile(join(lease.workdir, 'USER-WORK.txt'), 'Uncommitted user work');
      } else {
        assert.equal(lease.id, original!.id); assert.equal(lease.workdir, original!.workdir);
        assert.equal(row.gitProcesses, 1); assert.equal(row.remoteClones + row.baselineClones, 0);
        assert.equal(await readFile(join(lease.workdir, 'USER-WORK.txt'), 'utf8'), 'Uncommitted user work');
      }
      rows.push(row);
    }
  }
  console.log('phase,sample,operation,wall_ms,git_processes,remote_clones,baseline_clones,fetch_or_ls_remote');
  for (const row of rows) console.log([row.phase, row.sample, row.operation, row.wallMs.toFixed(3), row.gitProcesses, row.remoteClones, row.baselineClones, row.fetches].join(','));
  for (const operation of ['new_task', 'reuse']) {
    const samples = rows.filter(row => row.phase === 'warm' && row.operation === operation); const times = samples.map(row => row.wallMs).sort((a, b) => a - b);
    console.error(JSON.stringify({ operation, samples: samples.length, medianMs: (times[14] + times[15]) / 2, p95Ms: times[28], gitProcesses: samples[0].gitProcesses }));
  }
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
