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
const { createProjectCpService } = await import('../server/project-cp.js');
const { createProject, getProjectRepositoryLink, upsertProjectRepositoryLink, grantProjectProfileAccess } = await import('../server/db/projects.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { insertTask, getTask } = await import('../server/db/queries.js');
const { getProjectEditor } = await import('../server/db/project-cp.js');
const { claimTaskOperation } = await import('../server/task-run-lifecycle.js');
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
const workdir = join(root, 'checkouts', project.id);

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

  await test('idle editor is named; recovery releases only the reviewed lease after successful sync', async () => {
    const editor = await acquire();
    const blocked = await call('POST');
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.blocker.task.id, owner.id);
    assert.equal(blocked.body.blocker.task.title, 'Website update');
    assert.equal(blocked.body.blocker.releaseEditorLeaseId, editor.id);
    const stale = await call('POST', { releaseEditorLeaseId: 'old-editor-lease' });
    assert.equal(stale.status, 409);
    assert.equal(getProjectEditor(project.id)?.id, editor.id);
    const released = await call('POST', { releaseEditorLeaseId: editor.id });
    assert.equal(released.status, 200);
    assert.equal(getProjectEditor(project.id), null);
    assert.equal(getTask(owner.id)?.workdir, null);
  });

  await test('active tasks and compaction identify their owner and cannot be interrupted by recovery', async () => {
    const editor = await acquire();
    for (const mode of ['streaming', 'compacting', 'preparing']) {
      const release = mode === 'preparing' ? claimTaskOperation(other.id, project.id) : null;
      if (mode === 'streaming') startRun(other.id, other.id, 'Working');
      if (mode === 'compacting') startCompactionRun(other.id, other.id);
      try {
        for (const method of ['GET', 'POST']) {
          const result = await call(method, method === 'POST' ? { releaseEditorLeaseId: editor.id } : undefined);
          assert.equal(result.status, method === 'GET' ? 200 : 409);
          assert.equal(result.body.blocker.task.id, other.id);
          assert.equal(result.body.blocker.releaseEditorLeaseId, null);
          assert.equal(getProjectEditor(project.id)?.id, editor.id);
        }
      } finally { release?.(); discardRun(other.id); }
    }
  });

  await test('native background work and unavailable inventory block recovery without changing the checkout', async () => {
    const editor = getProjectEditor(project.id)!;
    const head = await git(workdir, 'rev-parse', 'HEAD');
    const priorEvidence = (await call()).body.lastSync;
    try {
      for (const inventory of [
        async () => ({ available: true, work: [{ id: 'child-1', kind: 'delegation' as const, status: 'running' }] }),
        async () => ({ available: false, work: [] }),
        async () => { throw new Error('Worker unavailable'); },
      ]) {
        backgroundWork = inventory;
        const state = await call();
        assert.equal(state.body.blocker.task.id, owner.id);
        assert.equal(state.body.blocker.releaseEditorLeaseId, null);
        const blocked = await call('POST', { releaseEditorLeaseId: editor.id });
        assert.equal(blocked.status, 409);
        assert.equal(blocked.body.blocker.releaseEditorLeaseId, null);
        assert.equal(getProjectEditor(project.id)?.id, editor.id);
        assert.equal(await git(workdir, 'rev-parse', 'HEAD'), head);
        assert.deepEqual((await call()).body.lastSync, priorEvidence);
      }
    } finally { backgroundWork = async () => ({ available: true, work: [] }); }
  });

  await test('background recovery checks hold the Project lock and time out safely', async () => {
    const editor = getProjectEditor(project.id)!;
    let entered!: () => void;
    let finish!: (value: TaskBackgroundWork) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    backgroundWork = () => { entered(); return new Promise(resolve => { finish = resolve; }); };
    const pending = call('POST', { releaseEditorLeaseId: editor.id });
    try {
      await Promise.race([started, pending.then(result => assert.fail(`Sync skipped background check: ${JSON.stringify(result)}`))]);
      const illegal = claimTaskOperation(other.id, project.id); illegal?.();
      assert.equal(illegal, null);
      finish({ available: false, work: [] });
      assert.equal((await pending).status, 409);
      backgroundWork = () => new Promise(() => {});
      const timedOut = await call('POST', { releaseEditorLeaseId: editor.id });
      assert.equal(timedOut.status, 409);
      assert.match(timedOut.body.blocker.message, /Could not verify/);
      assert.equal(getProjectEditor(project.id)?.id, editor.id);
      const released = claimTaskOperation(other.id, project.id);
      assert.ok(released, 'timeout releases the operation lock without releasing the editor');
      released();
    } finally { finish?.({ available: false, work: [] }); backgroundWork = async () => ({ available: true, work: [] }); }
  });

  await test('uncommitted and unpublished work stay owned and untouched', async () => {
    const editor = getProjectEditor(project.id)!;
    await writeFile(join(workdir, 'WIP.md'), 'Keep this work\n');
    const dirty = await call('POST', { releaseEditorLeaseId: editor.id });
    assert.equal(dirty.status, 409);
    assert.equal(dirty.body.blocker.releaseEditorLeaseId, null);
    assert.equal(await readFile(join(workdir, 'WIP.md'), 'utf8'), 'Keep this work\n');
    await git(workdir, 'add', '.'); await git(workdir, 'commit', '-m', 'Unpublished checkpoint');
    const unpublished = await call('POST', { releaseEditorLeaseId: editor.id });
    assert.equal(unpublished.status, 409);
    assert.match(unpublished.body.blocker.message, /publish|push/i);
    assert.equal(getProjectEditor(project.id)?.id, editor.id);
    // Publish through the real CP service to leave the fixture ready for the next case.
    assert.equal((await call('POST', { taskId: owner.id, message: 'Save WIP' }, '', 'commit-push')).status, 200);
  });

  await test('failed fetch retains editor, prior evidence, and isolates GitHub credentials', async () => {
    const editor = getProjectEditor(project.id)!;
    const previous = (await call()).body.lastSync;
    beforeGit = async args => { if (args[0] === 'ls-remote') throw new Error(`Network failure ${token}`); };
    try {
      const failed = await call('POST', { releaseEditorLeaseId: editor.id });
      assert.equal(failed.status, 500);
      assert.equal(getProjectEditor(project.id)?.id, editor.id);
      assert.deepEqual((await call()).body.lastSync, previous);
    } finally { beforeGit = async () => {}; }
    assert.ok(credentialsUsed > 0);
    assert.equal((await readFile(join(workdir, '.git/config'), 'utf8')).includes(token), false);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM project_editor_leases').all()).includes(token), false);
  });

  await test('ACL and task-handler checks apply to release-and-sync', async () => {
    const editor = getProjectEditor(project.id)!;
    assert.equal((await call('POST', undefined, 'viewer')).status, 404);
    assert.equal((await call('POST', { releaseEditorLeaseId: editor.id }, 'writer')).status, 404);
    assert.equal((await call('GET', undefined, 'writer')).body.blocker.releaseEditorLeaseId, null);
    assert.equal((await call('GET', undefined, 'viewer')).body.blocker.releaseEditorLeaseId, null);
    assert.equal(getProjectEditor(project.id)?.id, editor.id);
  });

  await test('release-and-sync excludes a task start throughout the awaited Git operation', async () => {
    const editor = getProjectEditor(project.id)!;
    let entered!: () => void; let finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { finish = resolve; });
    beforeGit = async args => { if (args[0] === 'ls-remote') { entered(); await hold; } };
    const pending = call('POST', { releaseEditorLeaseId: editor.id });
    try {
      await Promise.race([started, pending.then(result => assert.fail(`Sync finished before Git: ${JSON.stringify(result)}`))]);
      assert.equal(getProjectEditor(project.id)?.id, editor.id, 'lease remains held while Git is running');
      const illegal = claimTaskOperation(other.id, project.id); illegal?.();
      assert.equal(illegal, null);
    } finally { finish(); beforeGit = async () => {}; }
    assert.equal((await pending).status, 200);
    assert.equal(getProjectEditor(project.id), null);
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

  await test('merge conflicts and new merge checkpoints retain the editor and do not claim sync success', async () => {
    assert.equal((await call('POST')).status, 200);
    const previous = (await call()).body.lastSync;
    const editor = await acquire();
    await writeFile(join(workdir, 'README.md'), 'Saved task work\n');
    assert.equal((await call('POST', { taskId: owner.id, message: 'Save task work' }, '', 'commit-push')).status, 200);
    const saved = await git(workdir, 'rev-parse', 'HEAD');
    await writeFile(join(seed, 'README.md'), 'Conflicting GitHub work\n');
    await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Conflicting update'); await git(seed, 'push', remote, 'main');
    const conflict = await call('POST', { releaseEditorLeaseId: editor.id });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'PROJECT_MERGE_CONFLICT');
    assert.equal(conflict.body.activeTaskId, owner.id);
    assert.equal(await git(workdir, 'rev-parse', 'HEAD'), saved);
    assert.equal(await readFile(join(workdir, 'README.md'), 'utf8'), 'Saved task work\n');
    assert.equal(await git(workdir, 'status', '--porcelain'), '');
    assert.equal(getProjectEditor(project.id)?.id, editor.id);
    assert.deepEqual((await call()).body.lastSync, previous);

    await writeFile(join(seed, 'README.md'), 'Saved task work\n');
    await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Resolve upstream content'); await git(seed, 'push', remote, 'main');
    const checkpoint = await call('POST', { releaseEditorLeaseId: editor.id });
    assert.equal(checkpoint.status, 409);
    assert.equal(checkpoint.body.code, 'PROJECT_CHECKPOINT_PENDING');
    assert.equal(getProjectEditor(project.id)?.id, editor.id);
    assert.deepEqual((await call()).body.lastSync, previous);
    assert.equal((await call()).body.blocker.releaseEditorLeaseId, null);
    assert.equal((await call('POST', { taskId: owner.id, message: 'Publish synchronized checkpoint' }, '', 'commit-push')).status, 200);
    assert.equal((await call('POST', { releaseEditorLeaseId: editor.id })).status, 200);
  });
} finally {
  discardRun(other.id);
  server.close(); await once(server, 'close'); db.close();
  await rm(root, { recursive: true, force: true });
}
