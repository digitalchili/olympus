import assert from 'node:assert/strict';
import { buildProjectGitEnv, validateProjectGitTransportConfig } from '../server/project-git-auth.js';

const env = buildProjectGitEnv({ cloneUrl: 'https://github.com/fixture/repo.git', token: 'fixture-secret', baseEnv: {
  PATH: '/safe/bin', GIT_DIR: '/other', GIT_TRACE: '/capture', GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'url.https://evil.invalid/.insteadOf', GIT_CONFIG_VALUE_0: 'https://github.com/',
  GIT_SSH_COMMAND: 'unsafe', SSH_ASKPASS: 'unsafe', GIT_CONFIG_PARAMETERS: 'unsafe',
} });
assert.equal(env.PATH, '/safe/bin');
for (const key of ['GIT_DIR', 'GIT_TRACE', 'GIT_SSH_COMMAND', 'SSH_ASKPASS', 'GIT_CONFIG_PARAMETERS']) assert.equal(env[key], undefined);
const config = new Map(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
assert.equal(config.get('core.hooksPath'), '/dev/null');
assert.equal(config.get('core.askPass'), '');
assert.equal(config.get('credential.helper'), '');
assert.equal(config.get('http.followRedirects'), 'false');
assert.equal(config.get('http.sslVerify'), 'true');
assert.equal(config.get('http.extraHeader'), '');
assert.ok(config.has('http.https://github.com/fixture/repo.git.extraHeader'));
assert.equal(config.get('protocol.allow'), 'never');
assert.equal(config.get('push.followTags'), 'false');
assert.equal(config.get('push.gpgSign'), 'false');
assert.equal(config.get('push.recurseSubmodules'), 'false');
assert.throws(() => buildProjectGitEnv({ baseEnv: {}, cloneUrl: 'https://other.invalid/repo', token: 'fixture-secret' }));
for (const key of ['url.https://evil/.insteadof', 'remote.origin.pushinsteadof', 'remote.origin.receivepack', 'remote.origin.proxy', 'http.sslverify', 'http.https://github.com/.extraheader', 'include.path', 'includeif.gitdir:/.path', 'core.gitproxy']) {
  assert.throws(() => validateProjectGitTransportConfig([{ key, value: 'fixture-secret' }]), /configuration/i);
}
validateProjectGitTransportConfig([{ key: 'core.repositoryformatversion', value: '0' }, { key: 'user.name', value: 'Fixture' }]);
console.log('Controlled Git environment and local configuration rejection passed');

// Real local Git must ignore executable settings even when the command carries a fake token.
const { execFile, spawn } = await import('node:child_process');
const { promisify } = await import('node:util');
const { mkdtemp, mkdir, writeFile, readFile, access, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const root = await mkdtemp(join(tmpdir(), 'olympus-git-boundary-'));
process.env.DB_PATH = join(root, 'test.db');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
const { createProjectCpService } = await import('../server/project-cp.js');
const { GitHubPermissionUpgradeError } = await import('../server/studio/github-permissions.js');
const { createProject, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { insertTask } = await import('../server/db/queries.js');
const { default: db } = await import('../server/db/index.js');
try {
  const remote = join(root, 'remote.git');
  await git(root, 'init', '--bare', '-b', 'main', remote);
  upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
  const project = createProject({ name: 'Auth boundary', purpose: 'Scoped transport', managerProfileId: 'default', changedBy: 'test' });
  const cloneUrl = 'https://github.com/fixture/scoped.git';
  const repositoryLink = upsertProjectRepositoryLink(project.id, 77, { id: 123, name: 'scoped', fullName: 'fixture/scoped', owner: 'fixture', private: true, defaultBranch: 'main', htmlUrl: cloneUrl, cloneUrl });
  const task = insertTask({ title: 'Publish', status: 'in_progress', project_id: project.id, handling_profile_id: 'default' });
  const scopes: boolean[] = [];
  let requirePermissionUpgrade = false;
  const input = { projectId: project.id, taskId: task.id, profileId: 'default', repositoryLink,
    tokenProvider: async (id: number, scope: { repositoryId: number; readOnly: boolean }) => {
      assert.equal(id, 77); assert.equal(scope.repositoryId, 123); scopes.push(scope.readOnly);
      if (requirePermissionUpgrade && !scope.readOnly) throw new GitHubPermissionUpgradeError();
      return 'fixture-secret';
    } };
  const seen: Array<{ args: string[]; token: boolean }> = [];
  const service = createProjectCpService({ rootDir: join(root, 'managed'), gitRunner: async (cwd, args, options) => {
    assert.ok(options?.env); assert.equal(options.env.GIT_DIR, undefined); assert.equal(options.env.GIT_TRACE, undefined);
    assert.equal(args.join(' ').includes('fixture-secret'), false);
    seen.push({ args, token: Object.values(options.env).some(value => value?.startsWith('AUTHORIZATION: basic ')) });
    // Test-only transport replacement: the product still sees/validates the GitHub origin.
    const replacement = args[0] === 'remote' && args[1] === 'get-url' ? [] : ['-c', 'protocol.file.allow=always', '-c', `url.${remote}.insteadOf=${cloneUrl}`];
    return run('git', [...replacement, ...args], { cwd, env: options.env });
  } });
  const lease = await service.prepareTask(input);
  assert.ok(scopes.length && scopes.every(Boolean), 'preparation uses only read scope');
  const hookMarker = join(root, 'hook-ran');
  const hooks = join(root, 'hooks'); await mkdir(hooks);
  for (const hook of ['pre-push', 'pre-commit', 'post-commit']) await writeFile(join(hooks, hook), `#!/bin/sh\necho called > '${hookMarker}'\n`, { mode: 0o755 });
  await git(lease.workdir, 'config', 'core.hooksPath', hooks);
  const helperMarker = join(root, 'helper-ran');
  await git(lease.workdir, 'config', 'credential.helper', `!echo called > '${helperMarker}'`);
  await git(lease.workdir, 'config', 'push.followTags', 'true');
  await git(lease.workdir, 'tag', '-a', 'must-stay-local', '-m', 'Unrequested tag');
  const signerMarker = join(root, 'signer-ran');
  const signer = join(root, 'fake-signer');
  await writeFile(signer, `#!/bin/sh\nif env | grep -q 'AUTHORIZATION: basic'; then echo authenticated > '${signerMarker}'; else echo called > '${signerMarker}'; fi\nexit 1\n`, { mode: 0o755 });
  await git(remote, 'config', 'receive.certNonceSeed', 'fixture-signing');
  await git(lease.workdir, 'config', 'push.gpgSign', 'true');
  await git(lease.workdir, 'config', 'gpg.program', signer);
  await writeFile(join(lease.workdir, 'app.txt'), 'Safe publication');
  const oldDir = process.env.GIT_DIR, oldTrace = process.env.GIT_TRACE;
  process.env.GIT_DIR = '/not-the-repository'; process.env.GIT_TRACE = join(root, 'trace');
  let publicationError: unknown;
  try { await service.commitPush({ ...input, message: 'Safe publication' }); }
  catch (error) { publicationError = error; }
  finally { if (oldDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldDir; if (oldTrace === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = oldTrace; }
  assert.equal(await readFile(signerMarker, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; }), null, 'repository-controlled push signer must not run or receive the authorization environment');
  if (publicationError) throw publicationError;
  assert.equal(scopes.at(-1), false, 'publication mints write scope');
  assert.equal(await git(remote, 'tag'), '', 'publication sends only saved refs, never configured follow-tags');
  assert.ok(seen.filter(call => call.token).every(call => ['clone', 'ls-remote', 'fetch', 'push'].includes(call.args[0])), 'local commit/hooks never receive tokens');
  await assert.rejects(access(hookMarker)); await assert.rejects(access(helperMarker)); await assert.rejects(access(join(root, 'trace')));
  const askpassMarker = join(root, 'askpass-ran');
  const askpass = join(root, 'fake-askpass');
  await writeFile(askpass, `#!/bin/sh\necho called > '${askpassMarker}'\nexit 1\n`, { mode: 0o755 });
  await git(lease.workdir, 'config', 'core.askPass', askpass);
  const child = spawn('git', ['credential', 'fill'], { cwd: lease.workdir,
    env: buildProjectGitEnv({ baseEnv: process.env, cloneUrl, token: 'fixture-secret' }), stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end('protocol=https\nhost=github.com\n\n');
  await new Promise<void>(resolve => child.on('close', () => resolve()));
  await assert.rejects(access(helperMarker), 'credential lookup cannot execute repository helper');
  await assert.rejects(access(askpassMarker), 'credential lookup cannot execute repository askpass');
  assert.equal((await readFile(join(lease.workdir, '.git/config'), 'utf8')).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM project_publications').all()).includes('fixture-secret'), false);
  await writeFile(join(lease.workdir, 'app.txt'), 'New unsaved work');
  for (const key of ['url.https://evil.invalid/.insteadOf', 'url.https://evil.invalid/.pushInsteadOf', 'remote.origin.receivepack', 'remote.origin.proxy', 'http.sslVerify', 'include.path']) {
    await git(lease.workdir, 'config', key, 'unsafe');
    const before = scopes.length;
    await assert.rejects(service.commitPush({ ...input, message: 'Reject unsafe config' }), /unsupported transport configuration/);
    assert.equal(scopes.length, before, `${key} rejected before token minting`);
    await git(lease.workdir, 'config', '--unset', key);
  }
  const { default: express } = await import('express');
  const { once } = await import('node:events');
  const { createProjectsRouter } = await import('../server/routes/projects.js');
  const { createProjectTaskWorkspaceRouter } = await import('../server/routes/project-task-workspace.js');
  const { createTaskRecoveryRouter } = await import('../server/routes/task-recovery.js');
  const app = express(); app.use(express.json());
  const github = { installationToken: input.tokenProvider } as never;
  const adapter = { getBackgroundWork: async () => ({ available: true, work: [] }) };
  app.use('/projects', createProjectsRouter({ projectCp: service, github, adapter: adapter as never }));
  app.use('/tasks', createTaskRecoveryRouter(adapter));
  app.use('/tasks', createProjectTaskWorkspaceRouter({ projectCp: service, github }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    for (const viaChat of [false, true]) {
      await writeFile(join(lease.workdir, 'app.txt'), `Permission upgrade ${viaChat}`);
      requirePermissionUpgrade = true;
      const path = viaChat ? `tasks/${task.id}/messages` : `projects/${project.id}/commit-push`;
      const body = viaChat ? { content: '/commit push' } : { taskId: task.id, message: 'Needs write permission' };
      const response = await fetch(`http://127.0.0.1:${address.port}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      assert.equal(response.status, 409, JSON.stringify(result));
      assert.equal(result.code, 'GITHUB_PERMISSION_UPGRADE_REQUIRED');
      assert.match(result.error, /permission upgrade.*Workflows/);
      assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
      const receipt = (await service.status(input)).pendingPublication!;
      assert.ok(receipt.commitSha, 'write token failure preserves the exact committed publication');
      requirePermissionUpgrade = false;
      const retry = await service.retryPublication({ ...input, publicationId: receipt.id });
      assert.equal(retry.commitSha, receipt.commitSha);
    }
    for (const viaChat of [false, true]) {
      await writeFile(join(lease.workdir, 'app.txt'), `Scoped route ${viaChat}`);
      scopes.length = 0;
      const path = viaChat ? `tasks/${task.id}/messages` : `projects/${project.id}/commit-push`;
      const body = viaChat ? { content: '/commit push' } : { taskId: task.id, message: 'Scoped route' };
      const response = await fetch(`http://127.0.0.1:${address.port}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.text());
      assert.ok(scopes.includes(true)); assert.equal(scopes.at(-1), false, 'both route wrappers forward repository-scoped read/write intent');
    }
  } finally { server.close(); await once(server, 'close'); }
  console.log('Real Git hooks/helpers disabled; inherited controls stripped; scoped auth through both HTTP wrappers and unsafe local transport rejection passed');
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
