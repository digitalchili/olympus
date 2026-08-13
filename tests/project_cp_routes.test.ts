import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';

const execFile = promisify(execFileCallback);
const root = await mkdtemp(join(tmpdir(), 'olympus-project-cp-routes-'));
const hermesHome = join(root, 'hermes');
const dispatchHome = join(root, 'dispatch');
process.env.HERMES_HOME = hermesHome;
process.env.OLYMPUS_DISPATCH_HOME = dispatchHome;
process.env.DB_PATH = join(dispatchHome, 'data', 'project-cp-routes.db');

async function git(cwd: string, args: string[]) {
  const result = await execFile('git', args, { cwd });
  return result.stdout.trim();
}

async function profile(id: string, displayName: string) {
  const home = id === 'default' ? hermesHome : join(hermesHome, 'profiles', id);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'profile.yaml'), `displayName: ${displayName}\nactive: true\n`);
  await writeFile(join(home, 'config.yaml'), 'model:\n  provider: openai-codex\n  default: gpt-5.6-sol\n');
}

await profile('default', 'Default Builder');
await profile('writer', 'Contributing Writer');

try {
  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');
  await mkdir(seed, { recursive: true });
  await git(seed, ['init', '-b', 'main']);
  await writeFile(join(seed, 'README.md'), 'initial\n');
  await git(seed, ['add', 'README.md']);
  await git(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-m', 'Initial commit']);
  const defaultSha = await git(seed, ['rev-parse', 'HEAD']);
  await execFile('git', ['clone', '--bare', seed, remote]);

  const { LocalProfileRegistry } = await import('../server/local-profiles.js');
  const { createProjectCpService } = await import('../server/project-cp.js');
  const { grantProjectProfileAccess } = await import('../server/db/projects.js');
  const { createProjectsRouter } = await import('../server/routes/projects.js');
  const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
  const { insertTask } = await import('../server/db/queries.js');
  const { getProjectEditor, listProjectVersions } = await import('../server/db/project-cp.js');
  const { default: db } = await import('../server/db/index.js');

  const registry = new LocalProfileRegistry(hermesHome, dispatchHome);
  upsertGitHubInstallation({ id: 77, accountLogin: 'example', accountType: 'Organization', permissionMode: 'read_write' }, 1_000);
  const mintedTokens: string[] = [];
  const github = {
    configured: true,
    manifestRegistration() { throw new Error('not used'); },
    async completeManifest() { throw new Error('not used'); },
    installationUrl() { throw new Error('not used'); },
    authorizationUrl() { throw new Error('not used'); },
    async authorizeInstallation() { throw new Error('not used'); },
    async listRepositories() {
      return [{ id: 9001, name: 'atlas', fullName: 'example/atlas', owner: 'example', private: false, defaultBranch: 'main', htmlUrl: 'https://github.com/example/atlas', cloneUrl: remote }];
    },
    async installationToken(installationId: number) {
      assert.equal(installationId, 77);
      mintedTokens.push('ghs_FAKE_TOKEN_FOR_TEST');
      return '';
    },
  };

  let now = 10_000;
  const managedRoot = join(dispatchHome, 'managed-checkouts');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', createProjectsRouter({
    registry,
    github,
    now: () => now,
    projectCp: createProjectCpService({ rootDir: managedRoot, now: () => now }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  type Result = { status: number; body: Record<string, unknown> };
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const call = (path: string, method = 'GET', body?: unknown) => new Promise<Result>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : undefined,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });

  const createdResponse = await call('/api/projects', 'POST', {
    name: 'Commit Push Routes',
    purpose: 'Exercise explicit Commit & Push and non-destructive revert',
    managerProfileId: 'default',
    repositoryLink: { installationId: 77, repositoryId: 9001 },
  });
  assert.equal(createdResponse.status, 201);
  const projectId = String((createdResponse.body.project as Record<string, unknown>).id);
  const task = insertTask({ title: 'Editor task', description: 'Make a change', status: 'in_progress', project_id: projectId, handling_profile_id: 'default', profile_name: 'default' });
  const otherTask = insertTask({ title: 'Plan task', description: 'Plan only', status: 'in_progress', project_id: projectId, handling_profile_id: 'default', profile_name: 'default' });
  grantProjectProfileAccess({ projectId, profileId: 'writer', role: 'contribute', grantedBy: 'test' });

  const crossProfileAcquire = await call(`/api/projects/${projectId}/editor/acquire?profile=writer`, 'POST', { taskId: task.id });
  assert.equal(crossProfileAcquire.status, 404, 'a profile contributor cannot take over another profile handler\'s task');

  const acquired = await call(`/api/projects/${projectId}/editor/acquire`, 'POST', { taskId: task.id });
  assert.equal(acquired.status, 200);
  for (const [path, method, body] of [
    [`/api/projects/${projectId}/editor/status?taskId=${task.id}&profile=writer`, 'GET', undefined],
    [`/api/projects/${projectId}/editor/release?profile=writer`, 'POST', { taskId: task.id }],
    [`/api/projects/${projectId}/commit-push?profile=writer`, 'POST', { taskId: task.id, message: 'Unauthorized checkpoint' }],
    [`/api/projects/${projectId}/versions/missing/revert?profile=writer`, 'POST', { taskId: task.id }],
  ] as const) {
    const crossProfileOperation = await call(path, method, body);
    assert.equal(crossProfileOperation.status, 404, `${method} ${path} stays bound to the task handler`);
  }
  const repositoryChangeBlocked = await call(`/api/projects/${projectId}`, 'PATCH', { repositoryLink: null });
  assert.equal(repositoryChangeBlocked.status, 409, 'linked repository cannot change while a Project editor is active');
  assert.equal(repositoryChangeBlocked.body.code, 'PROJECT_COMMIT_PUSH_BLOCKED');
  const editor = acquired.body.editor as Record<string, unknown>;
  assert.equal(editor.taskId, task.id);
  assert.notEqual(editor.branchName, 'main', 'Olympus must never Commit & Push to the default branch');
  assert.equal('workdir' in editor, false, 'managed VPS paths stay private');
  const workdir = join(managedRoot, projectId);
  assert.equal(await readFile(join(workdir, 'README.md'), 'utf8'), 'initial\n');
  assert.equal(getProjectEditor(projectId)?.taskId, task.id, 'editor lease is durable in SQLite');

  await writeFile(join(workdir, 'README.md'), 'changed by Olympus\n');
  const status = await call(`/api/projects/${projectId}/editor/status?taskId=${encodeURIComponent(task.id)}`);
  assert.equal(status.status, 200);
  assert.deepEqual((status.body.status as Record<string, unknown>).changedFiles, ['README.md']);
  assert.equal(JSON.stringify(status.body).includes('ghs_FAKE'), false);

  const blocked = await call(`/api/projects/${projectId}/commit-push`, 'POST', { taskId: otherTask.id, message: 'Should be blocked' });
  assert.equal(blocked.status, 409);

  now = 20_000;
  const pushed = await call(`/api/projects/${projectId}/commit-push`, 'POST', { taskId: task.id, message: 'Update README from Olympus' });
  assert.equal(pushed.status, 200);
  const version = pushed.body.version as Record<string, unknown>;
  assert.equal(version.action, 'commit_push');
  assert.equal(version.parentSha, defaultSha);
  assert.deepEqual(version.changedFiles, ['README.md']);
  assert.equal(mintedTokens.length, 0, 'local temp repository fixture does not mint live GitHub tokens');
  assert.equal(JSON.stringify(pushed.body).includes('ghs_FAKE'), false);
  assert.match(await git(seed, ['ls-remote', remote, `refs/heads/${String(version.branchName)}`]), /^[0-9a-f]{40}\s+/);

  await writeFile(join(workdir, 'README.md'), 'interrupted after local commit\n');
  await git(workdir, ['add', '--all']);
  await git(workdir, ['commit', '-m', 'Interrupted local checkpoint']);
  const interruptedSha = await git(workdir, ['rev-parse', 'HEAD']);
  const pendingStatus = await call(`/api/projects/${projectId}/editor/status?taskId=${task.id}`);
  assert.equal(pendingStatus.status, 200);
  assert.equal((pendingStatus.body.status as Record<string, unknown>).clean, false);
  assert.match(String((pendingStatus.body.status as Record<string, unknown>).summary), /waiting to be pushed/i);
  now = 22_000;
  const recoveredPush = await call(`/api/projects/${projectId}/commit-push`, 'POST', { taskId: task.id, message: 'Retry interrupted checkpoint' });
  assert.equal(recoveredPush.status, 200, JSON.stringify(recoveredPush.body));
  assert.equal((recoveredPush.body.version as Record<string, unknown>).commitSha, interruptedSha, 'restart recovery pushes the existing local checkpoint without creating a replacement commit');

  await writeFile(join(workdir, 'README.md'), 'second checkpoint\n');
  now = 25_000;
  const pushedAgain = await call(`/api/projects/${projectId}/commit-push`, 'POST', { taskId: task.id, message: 'Second checkpoint' });
  assert.equal(pushedAgain.status, 200, JSON.stringify(pushedAgain.body));

  now = 30_000;
  const reverted = await call(`/api/projects/${projectId}/versions/${version.id}/revert`, 'POST', { taskId: task.id });
  assert.equal(reverted.status, 200, JSON.stringify(reverted.body));
  const revert = reverted.body.version as Record<string, unknown>;
  assert.equal(revert.action, 'revert');
  assert.equal(revert.revertedVersionId, version.id);
  assert.notEqual(revert.commitSha, version.commitSha);
  assert.equal(mintedTokens.length, 0, 'local revert fixture does not mint live GitHub tokens');
  assert.equal(JSON.stringify(reverted.body).includes('ghs_FAKE'), false);
  assert.deepEqual(listProjectVersions(projectId).map((entry) => entry.action), ['revert', 'commit_push', 'commit_push', 'commit_push']);
  assert.equal(await readFile(join(workdir, 'README.md'), 'utf8'), 'changed by Olympus\n', 'restoring the selected version restores that checkpoint tree');

  const versions = await call(`/api/projects/${projectId}/versions`);
  assert.equal(versions.status, 200);
  assert.equal((versions.body.versions as unknown[]).length, 4, 'version history is visible over the Project API');

  const released = await call(`/api/projects/${projectId}/editor/release`, 'POST', { taskId: task.id });
  assert.equal(released.status, 200);
  const repositoryChangeAfterHistoryBlocked = await call(`/api/projects/${projectId}`, 'PATCH', { repositoryLink: null });
  assert.equal(repositoryChangeAfterHistoryBlocked.status, 409, 'repository history stays bound to the repository that produced it');
  assert.equal(repositoryChangeAfterHistoryBlocked.body.code, 'PROJECT_COMMIT_PUSH_BLOCKED');
  assert.equal(getProjectEditor(projectId), null);

  const rawRows = JSON.stringify(db.prepare('SELECT * FROM project_editor_leases').all())
    + JSON.stringify(db.prepare('SELECT * FROM project_versions').all());
  assert.equal(rawRows.includes('ghs_FAKE'), false, 'tokens are never stored in CP tables');
  db.close();
  server.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Project CP route tests passed');
