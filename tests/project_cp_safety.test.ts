import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-project-cp-safety-'));
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = join(root, 'data', 'cp-safety.db');

try {
  const { createProjectCpService } = await import('../server/project-cp.js');
  const { createProject, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
  const { insertTask } = await import('../server/db/queries.js');
  const { acquireProjectEditor, listProjectVersions } = await import('../server/db/project-cp.js');
  const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');

  upsertGitHubInstallation({ id: 77, accountLogin: 'example', accountType: 'Organization', permissionMode: 'read_write' }, 900);
  const project = createProject({
    name: 'CP safety fixture', purpose: 'Exercise auth and failure recovery', managerProfileId: 'default', changedBy: 'test',
  }, 1_000);
  const task = insertTask({ title: 'Editor', status: 'in_progress', project_id: project.id, handling_profile_id: 'default' });
  const link = upsertProjectRepositoryLink(project.id, 77, {
    id: 9001, name: 'atlas', fullName: 'example/atlas', owner: 'example', private: true,
    defaultBranch: 'main', htmlUrl: 'https://github.com/example/atlas', cloneUrl: 'https://github.com/example/atlas.git',
  }, 1_000);
  const workdir = join(root, 'managed', project.id, task.id);
  acquireProjectEditor({
    projectId: project.id, taskId: task.id, profileId: 'default', repositoryFullName: link.fullName,
    baseBranch: 'main', branchName: 'olympus/safe-test', workdir, baseSha: 'a'.repeat(40), leaseToken: 'lease', now: 2_000,
  });

  let head = 'a'.repeat(40);
  let dirty = true;
  const calls: Array<{ args: string[]; env?: Record<string, string | undefined> }> = [];
  const gitRunner = async (_cwd: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
    calls.push({ args, env: options?.env });
    if (args[0] === 'status') return { stdout: dirty ? ' M README.md\0' : '', stderr: '' };
    if (args[0] === 'diff' && args.includes('--name-only')) return { stdout: dirty ? 'README.md\0' : '', stderr: '' };
    if (args[0] === 'ls-files') return { stdout: '', stderr: '' };
    if (args[0] === 'diff') return { stdout: 'diff --git a/README.md b/README.md\n', stderr: '' };
    if (args[0] === 'rev-parse') return { stdout: `${head}\n`, stderr: '' };
    if (args[0] === 'commit') { head = 'b'.repeat(40); dirty = false; return { stdout: '', stderr: '' }; }
    if (args[0] === 'push') throw new Error('simulated push failure');
    if (args[0] === 'reset' && args[1] === '--soft') { head = 'a'.repeat(40); dirty = true; return { stdout: '', stderr: '' }; }
    return { stdout: '', stderr: '' };
  };
  const service = createProjectCpService({ rootDir: join(root, 'managed'), gitRunner });
  await assert.rejects(
    service.commitPush({ projectId: project.id, taskId: task.id, repositoryLink: link, message: 'Safe checkpoint', tokenProvider: async () => 'ghs_SECRET_TEST' }),
    /simulated push failure/,
  );
  assert.equal(listProjectVersions(project.id).length, 0, 'failed pushes never become visible checkpoints');
  assert.ok(calls.some((call) => call.args[0] === 'reset' && call.args[1] === '--soft'), 'failed push restores a retryable staged state');
  const pushCall = calls.find((call) => call.args[0] === 'push');
  assert.ok(pushCall?.env?.GIT_CONFIG_VALUE_0?.startsWith('AUTHORIZATION: basic '), 'private Git auth uses a valid transient HTTP header');
  assert.equal(JSON.stringify(calls.map((call) => call.args)).includes('ghs_SECRET_TEST'), false, 'token never appears in process arguments');
  assert.equal(JSON.stringify(process.env).includes('ghs_SECRET_TEST'), false, 'token is not added to the parent process environment');

  head = 'a'.repeat(40);
  dirty = true;
  calls.length = 0;
  const remoteAcceptedSha = 'b'.repeat(40);
  const ambiguousRunner = async (_cwd: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
    calls.push({ args, env: options?.env });
    if (args[0] === 'status') return { stdout: dirty ? ' M README.md\0' : '', stderr: '' };
    if (args[0] === 'diff') return { stdout: 'diff --git a/README.md b/README.md\n', stderr: '' };
    if (args[0] === 'rev-parse') return { stdout: `${head}\n`, stderr: '' };
    if (args[0] === 'commit') { head = remoteAcceptedSha; dirty = false; return { stdout: '', stderr: '' }; }
    if (args[0] === 'push') throw new Error('connection dropped after remote accepted push');
    if (args[0] === 'ls-remote') return { stdout: `${remoteAcceptedSha}\trefs/heads/olympus/safe-test\n`, stderr: '' };
    if (args[0] === 'reset') throw new Error('an accepted push must not be reset');
    return { stdout: '', stderr: '' };
  };
  const ambiguousService = createProjectCpService({ rootDir: join(root, 'managed'), gitRunner: ambiguousRunner });
  const recovered = await ambiguousService.commitPush({
    projectId: project.id,
    taskId: task.id,
    repositoryLink: link,
    message: 'Accepted despite transport error',
    tokenProvider: async () => 'ghs_SECRET_TEST',
  });
  assert.equal(recovered.commitSha, remoteAcceptedSha, 'remote-accepted ambiguous pushes become visible checkpoints');
  assert.equal(listProjectVersions(project.id).length, 1);

  head = 'b'.repeat(40);
  dirty = true;
  calls.length = 0;
  const deployRunner = async (_cwd: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
    calls.push({ args, env: options?.env });
    if (args[0] === 'status') return { stdout: dirty ? ' M README.md\0' : '', stderr: '' };
    if (args[0] === 'diff') return { stdout: 'diff --git a/README.md b/README.md\n', stderr: '' };
    if (args[0] === 'rev-parse') return { stdout: `${head}\n`, stderr: '' };
    if (args[0] === 'commit') { head = 'c'.repeat(40); dirty = false; return { stdout: '', stderr: '' }; }
    return { stdout: '', stderr: '' };
  };
  const deployService = createProjectCpService({ rootDir: join(root, 'managed'), gitRunner: deployRunner });
  const deployed = await deployService.commitPush({
    projectId: project.id,
    taskId: task.id,
    repositoryLink: link,
    message: 'Deploy commit to default branch',
    tokenProvider: async () => 'ghs_SECRET_TEST',
    deployToDefaultBranch: true,
  });
  assert.equal(deployed.branchName, 'main', 'version record reflects deployment to default branch');
  const deployPushCall = calls.find((call) => call.args[0] === 'push');
  assert.ok(deployPushCall?.args.includes('HEAD:refs/heads/main'), 'push includes refspec for default branch');
  assert.ok(deployPushCall?.args.includes('HEAD:refs/heads/olympus/safe-test'), 'push also includes refspec for working branch');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Project CP safety tests passed');