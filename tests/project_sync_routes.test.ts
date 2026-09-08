import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import type { TaskBackgroundWork } from '../server/adapters/types.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-sync-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'state', 'test.db');
for (const profile of ['', 'profiles/writer', 'profiles/viewer']) {
  await mkdir(join(process.env.HERMES_HOME, profile), { recursive: true });
  await writeFile(join(process.env.HERMES_HOME, profile, 'config.yaml'), '{}\n');
  if (profile) await writeFile(join(process.env.HERMES_HOME, profile, 'profile.yaml'), 'display_name: Test profile\n');
}
const { createProjectsRouter } = await import('../server/routes/projects.js');
const { createProjectCpService, projectBaselineWorkdir } = await import('../server/project-cp.js');
const { createProject, getProjectRepositoryLink, upsertProjectRepositoryLink, grantProjectProfileAccess } = await import('../server/db/projects.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { insertTask, getTask } = await import('../server/db/queries.js');
const { getProjectEditor, getProjectEditorForTask } = await import('../server/db/project-cp.js');
const { claimTaskOperation, claimProjectOperation } = await import('../server/task-run-lifecycle.js');
const { startRun, discardRun, startCompactionRun } = await import('../server/live-chat.js');
const { default: db } = await import('../server/db/index.js');
const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)('git', args, { cwd })).stdout.trim();
const seed = join(root, 'seed');
const remote = join(root, 'remote.git');
await mkdir(seed);
await git(seed, 'init', '-b', 'main');
await git(seed, 'config', 'user.name', 'Fixture');
await git(seed, 'config', 'user.email', 'fixture@example.invalid');
await writeFile(join(seed, 'README.md'), 'Initial\n');
await git(seed, 'add', '.');
await git(seed, 'commit', '-m', 'Initial');
await git(root, 'clone', '--bare', seed, remote);
const initialSha = await git(seed, 'rev-parse', 'HEAD');
const cloneUrl = 'https://github.com/fixture/sync.git';
const token = 'ghs_TEST_SYNC_ONLY';
let timestamp = 1_000;
let beforeGit: (args: string[]) => Promise<void> = async () => {};
let credentialsUsed = 0;
let backgroundWork: () => Promise<TaskBackgroundWork> = async () => ({ available: true, work: [] });
const service = createProjectCpService({
  rootDir: join(root, 'checkouts'), now: () => timestamp,
  gitRunner: async (cwd, args, options) => {
    assert.equal(args.join(' ').includes(token), false, 'credentials never enter command arguments');
    if (options?.env?.GIT_CONFIG_VALUE_0) {
      credentialsUsed++;
      assert.equal(options.env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`);
    }
    await beforeGit(args);
    const rewrite = args[0] === 'remote' && args[1] === 'get-url' ? [] : ['-c', `url.${remote}.insteadOf=${cloneUrl}`];
    return promisify(execFile)('git', [...rewrite, ...args], { cwd, env: { ...process.env, ...options?.env } });
  },
});
upsertGitHubInstallation({ id: 77, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
const project = createProject({ name: 'Sync UX', purpose: 'Safe sync', managerProfileId: 'default', changedBy: 'test' });
upsertProjectRepositoryLink(project.id, 77, { id: 9001, name: 'sync', fullName: 'fixture/sync', owner: 'fixture', private: true, defaultBranch: 'main', htmlUrl: cloneUrl, cloneUrl });
grantProjectProfileAccess({ projectId: project.id, profileId: 'writer', role: 'contribute', grantedBy: 'test' });
grantProjectProfileAccess({ projectId: project.id, profileId: 'viewer', role: 'view', grantedBy: 'test' });
const owner = insertTask({ title: 'Website update', status: 'in_progress', project_id: project.id, handling_profile_id: 'default' });
const other = insertTask({ title: 'Checking the site', status: 'in_progress', project_id: project.id, handling_profile_id: 'default' });
const app = express();
app.use(express.json());
app.use('/api/projects', createProjectsRouter({
  projectCp: service, now: () => timestamp,
  adapter: { getBackgroundWork: async (taskId: string) => { assert.equal(taskId, owner.id); return backgroundWork(); } } as never,
  github: { installationToken: async () => token } as never,
}));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const call = async (method = 'GET', body?: unknown, profile = '', suffix = 'sync') => {
  const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/${project.id}/${suffix}${profile ? `?profile=${profile}` : ''}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.match(response.headers.get('content-type') ?? '', /application\/json/, `${method} ${suffix} returned ${response.status}`);
  const result = await response.json();
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes(root), false, 'server checkout paths remain private');
  return { status: response.status, body: result };
};
const acquire = async () => {
  const response = await call('POST', { taskId: owner.id }, '', 'editor/acquire');
  assert.equal(response.status, 200);
  return response.body.editor;
};
const workdir = projectBaselineWorkdir(join(root, 'checkouts'), project.id, getProjectRepositoryLink(project.id)!);

try {
  await test('sync records verified time and commit, survives reload, and distinguishes updates', async () => {
    assert.equal((await call()).body.lastSync, null);
    const first = await call('POST');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.lastSync, { verifiedAt: 1_000, currentSha: initialSha, updated: true });
    assert.deepEqual((await call()).body.lastSync, first.body.lastSync);
    timestamp = 2_000;
    const unchanged = await call('POST');
    assert.equal(unchanged.body.lastSync.updated, false);
    assert.equal(unchanged.body.lastSync.verifiedAt, 2_000);
    await writeFile(join(seed, 'EXTERNAL.md'), 'From GitHub\n');
    await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'External update'); await git(seed, 'push', remote, 'main');
    timestamp = 3_000;
    const updated = await call('POST');
    assert.equal(updated.body.lastSync.updated, true);
    assert.equal(updated.body.lastSync.currentSha, await git(seed, 'rev-parse', 'HEAD'));
    assert.equal(await readFile(join(workdir, 'EXTERNAL.md'), 'utf8'), 'From GitHub\n');
  });

  await test('sync preserves dirty and active task workspaces, including legacy release requests', async () => {
    const editor = await acquire();
    const taskWorkdir = getTask(owner.id)!.workdir!;
    await writeFile(join(taskWorkdir, 'WIP.md'), 'Keep this unpublished work\n');
    const before = await git(taskWorkdir, 'rev-parse', 'HEAD');
    for (const phase of ['streaming', 'compacting', 'preparing']) {
      const release = phase === 'preparing' ? claimTaskOperation(owner.id, project.id) : null;
      if (phase === 'streaming') startRun(owner.id, owner.id, 'Working');
      if (phase === 'compacting') startCompactionRun(owner.id, owner.id);
      try {
        assert.equal((await call()).body.blocker, null);
        const synced = await call('POST', { releaseEditorLeaseId: editor.id });
        assert.equal(synced.status, 200);
        assert.equal(getProjectEditorForTask(project.id, owner.id)?.id, editor.id, 'sync never releases an independent workspace');
        assert.equal(await git(taskWorkdir, 'rev-parse', 'HEAD'), before);
        assert.equal(await readFile(join(taskWorkdir, 'WIP.md'), 'utf8'), 'Keep this unpublished work\n');
      } finally { release?.(); discardRun(owner.id); }
    }
  });

  await test('baseline sync does not depend on task background inventory', async () => {
    backgroundWork = async () => { throw new Error('Task worker is unavailable'); };
    try { assert.equal((await call('POST')).status, 200); }
    finally { backgroundWork = async () => ({available:true,work:[]}); }
  });

  await test('failed fetch preserves prior verified evidence and isolates GitHub credentials', async () => {
    const previous = (await call()).body.lastSync;
    beforeGit = async args => { if (args[0] === 'fetch') throw new Error(`Network failure ${token}`); };
    try {
      assert.equal((await call('POST')).status, 500);
      assert.deepEqual((await call()).body.lastSync, previous);
    } finally { beforeGit = async () => {}; }
    assert.ok(credentialsUsed > 0);
    assert.equal((await readFile(join(workdir, '.git/config'), 'utf8')).includes(token), false);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM project_editor_leases').all()).includes(token), false);
  });

  await test('baseline sync retains Project ACL while task mutations retain task-handler ACL', async () => {
    assert.equal((await call('POST', undefined, 'viewer')).status, 404);
    assert.equal((await call('POST', undefined, 'writer')).status, 200, 'a contributor can sync the shared baseline');
    assert.equal((await call('POST', {taskId:owner.id}, 'writer', 'editor/release')).status, 404, 'another profile cannot release the task workspace');
    assert.equal((await call('GET', undefined, 'viewer')).body.blocker, null);
  });

  await test('awaited baseline Git excludes another baseline mutation but allows a task operation', async () => {
    let entered!: () => void; let finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { finish = resolve; });
    beforeGit = async args => { if (args[0] === 'fetch') { entered(); await hold; } };
    const pending = call('POST');
    try {
      await Promise.race([started, pending.then(result => assert.fail(`Sync finished before Git: ${JSON.stringify(result)}`))]);
      const independent = claimTaskOperation(other.id, project.id); assert.ok(independent); independent();
      assert.equal(claimProjectOperation(project.id), null);
      assert.equal((await call()).body.blocker.kind, 'project_operation');
      assert.equal((await call('POST')).status, 409);
    } finally { finish(); beforeGit = async () => {}; }
    assert.equal((await pending).status, 200);
    assert.equal((await call()).body.blocker, null);
  });

  await test('sync refuses a changed origin before giving Git an installation token', async () => {
    const previous = (await call()).body.lastSync;
    await git(workdir, 'remote', 'set-url', 'origin', 'https://example.invalid/untrusted.git');
    const previousCredentialsUsed = credentialsUsed;
    beforeGit = async args => { if (args[0] === 'ls-remote' || args[0] === 'fetch') throw new Error('Unexpected network access'); };
    try {
      assert.equal((await call('POST')).status, 409);
      assert.equal(credentialsUsed, previousCredentialsUsed);
      assert.deepEqual((await call()).body.lastSync, previous);
    } finally { await git(workdir, 'remote', 'set-url', 'origin', cloneUrl); beforeGit = async () => {}; }
  });

  await test('ordinary Project edits preserve evidence but a changed repository branch invalidates it', async () => {
    const previous = (await call()).body.lastSync;
    assert.ok(previous);
    db.prepare('UPDATE project_repository_links SET updated_at = updated_at + 1 WHERE project_id = ?').run(project.id);
    assert.deepEqual((await call()).body.lastSync, previous);
    db.prepare("UPDATE project_repository_links SET default_branch = 'new-main' WHERE project_id = ?").run(project.id);
    try { assert.equal((await call()).body.lastSync, null); }
    finally { db.prepare("UPDATE project_repository_links SET default_branch = 'main' WHERE project_id = ?").run(project.id); }
    assert.ok(getProjectRepositoryLink(project.id));
  });

  await test('upstream changes update only the baseline and leave a divergent task untouched', async () => {
    const taskWorkdir = getTask(owner.id)!.workdir!;
    await writeFile(join(taskWorkdir, 'README.md'), 'Saved task work\n');
    const savedHead = await git(taskWorkdir, 'rev-parse', 'HEAD');
    await writeFile(join(seed, 'README.md'), 'Conflicting upstream update\n');
    await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Conflicting update'); await git(seed, 'push', remote, 'main');
    const synced = await call('POST');
    assert.equal(synced.status, 200);
    assert.equal(synced.body.lastSync.currentSha, await git(seed, 'rev-parse', 'HEAD'));
    assert.equal(await readFile(join(workdir, 'README.md'), 'utf8'), 'Conflicting upstream update\n');
    assert.equal(await readFile(join(taskWorkdir, 'README.md'), 'utf8'), 'Saved task work\n');
    assert.equal(await git(taskWorkdir, 'rev-parse', 'HEAD'), savedHead);
    assert.ok(getProjectEditorForTask(project.id, owner.id));
  });

} finally {
  discardRun(other.id);
  server.close(); await once(server, 'close'); db.close();
  await rm(root, { recursive: true, force: true });
}
