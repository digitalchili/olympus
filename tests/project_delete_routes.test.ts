import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import type { TaskBackgroundWork } from '../shared/background-work.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-project-delete-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'state', 'test.db');
for (const id of ['default', 'reader', 'design.team']) {
  const home = id === 'default' ? process.env.HERMES_HOME : join(process.env.HERMES_HOME, 'profiles', id);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'profile.yaml'), `displayName: ${id}\nactive: true\n`);
  await writeFile(join(home, 'config.yaml'), '{}\n');
}
const { createProjectsRouter } = await import('../server/routes/projects.js');
const { createProject, deleteProject, getProject, grantProjectProfileAccess, upsertProjectRepositoryLink } = await import('../server/db/projects.js');
const { prepareProjectDeletionCleanup, retryPendingProjectDeletionCleanup } = await import('../server/project-deletion-cleanup.js');
const { insertTask, getTask } = await import('../server/db/queries.js');
const { acquireProjectEditor, releaseProjectEditor } = await import('../server/db/project-cp.js');
const { createProjectPublication } = await import('../server/db/project-publications.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { createProjectReferenceFromFile } = await import('../server/db/project-references.js');
const { putQueuedTaskMessage, getQueuedTaskMessage } = await import('../server/db/task-message-queue.js');
const { beginProfileDeletion } = await import('../server/profile-deletion.js');
const { beginRecovery } = await import('../server/run-recovery.js');
const { claimProjectOperation, claimTaskOperation } = await import('../server/task-run-lifecycle.js');
const { startRun, discardRun } = await import('../server/live-chat.js');
const { default: db } = await import('../server/db/index.js');
const { resolveOlympusDataDir, resolveOlympusWorkspaceDir } = await import('../server/paths.js');
const { createHash } = await import('node:crypto');
const idle = (): TaskBackgroundWork => ({ available: true, work: [], continuation: { status: 'none' } });
let inventory: (id: string) => Promise<TaskBackgroundWork> = async () => idle();
const app = express();
app.use(express.json());
app.use('/api/projects', createProjectsRouter({ adapter: { getBackgroundWork: (id: string) => inventory(id) } as never }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const remove = (id: string, profile = '') => fetch(`http://127.0.0.1:${address.port}/api/projects/${id}${profile ? `?profile=${profile}` : ''}`, { method: 'DELETE' });
let sequence = 0;
function fixture() {
  const project = createProject({ name: `Deletion ${++sequence}`, purpose: 'Deletion fixture', managerProfileId: 'default', changedBy: 'test' });
  const task = insertTask({ title: 'Preserved task', status: 'in_review', project_id: project.id, workdir: join(root, `workspace-${sequence}`) });
  return { project, task };
}
async function blocked(projectId: string, code: string) {
  const response = await remove(projectId);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, code);
  assert.ok(getProject(projectId), 'blocked deletion retains Project metadata');
}

try {
  await test('deletion removes owned Project storage and tasks but keeps external files and other Projects', async () => {
    const { project, task } = fixture();
    const other = fixture();
    await mkdir(task.workdir!, { recursive: true });
    const sentinel = join(task.workdir!, 'uncommitted.txt');
    await writeFile(sentinel, 'Keep local work');
    const managed = [
      join(resolveOlympusDataDir(), 'project-checkouts', 'tasks', project.id, task.id),
      join(resolveOlympusDataDir(), 'project-checkouts', project.id),
      join(resolveOlympusDataDir(), 'project-checkouts', 'baselines', `${project.id}-${'a'.repeat(24)}`),
      join(resolveOlympusDataDir(), 'project-checkouts', 'baselines', `${project.id}-${'b'.repeat(24)}`),
      join(resolveOlympusWorkspaceDir(), 'tasks', task.id),
      join(resolveOlympusDataDir(), 'task-artifact-previews', 'tasks', createHash('sha256').update(task.id).digest('hex').slice(0, 32)),
    ];
    for (const directory of managed) { await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'owned.txt'), 'Delete local copy'); }
    await symlink(task.workdir!, join(managed[0], 'external-link'));
    const source = join(root, 'reference.txt');
    await writeFile(source, 'Project reference sentinel');
    const reference = await createProjectReferenceFromFile({ projectId: project.id, filePath: source });
    assert.ok(reference);
    const stored = db.prepare('SELECT storage_path FROM project_references WHERE id = ?').get(reference.id) as { storage_path: string };
    const editor = acquireProjectEditor({ projectId: project.id, taskId: task.id, profileId: 'default', repositoryFullName: 'fixture/repo', baseBranch: 'main', branchName: 'task/fixture', workdir: task.workdir!, leaseToken: 'fixture' });
    upsertGitHubInstallation({ id: 71, accountLogin: 'fixture', accountType: 'Organization', permissionMode: 'read_write' });
    upsertProjectRepositoryLink(project.id, 71, { id: 91, name: 'repo', fullName: 'fixture/repo', owner: 'fixture', private: true, defaultBranch: 'main', htmlUrl: 'https://github.com/fixture/repo', cloneUrl: 'https://github.com/fixture/repo.git' });
    const response = await remove(project.id);
    assert.equal(response.status, 204);
    assert.equal(getProject(project.id), undefined);
    assert.equal(getTask(task.id), undefined);
    assert.equal(getTask(other.task.id)?.project_id, other.project.id);
    assert.ok(getProject(other.project.id));
    assert.equal(await readFile(sentinel, 'utf8'), 'Keep local work');
    for (const directory of [...managed, stored.storage_path]) await assert.rejects(lstat(directory), { code: 'ENOENT' });
    for (const table of ['project_manager_history', 'project_repository_links', 'project_editor_leases', 'project_references', 'project_reference_chunks_fts']) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(project.id) as { count: number }).count, 0, table);
    }
    assert.equal((await remove(project.id)).status, 404);
  });

  await test('profile deletion needs manage access and operator deletion works without a profile', async () => {
    const { project } = fixture();
    grantProjectProfileAccess({ projectId: project.id, profileId: 'reader', role: 'view', grantedBy: 'test' });
    assert.equal((await remove(project.id, 'reader')).status, 404);
    assert.ok(getProject(project.id));
    assert.equal((await remove(project.id, 'default')).status, 204);
  });

  await test('running tasks and claimed Project or task mutations block deletion', async () => {
    const { project, task } = fixture();
    startRun(task.id, 'active-run', 'Working');
    try { await blocked(project.id, 'PROJECT_OPERATION_ACTIVE'); } finally { discardRun(task.id); }
    for (const acquire of [() => claimProjectOperation(project.id), () => claimTaskOperation(task.id, project.id)]) {
      const release = acquire();
      assert.ok(release);
      try { await blocked(project.id, 'PROJECT_OPERATION_ACTIVE'); } finally { release(); }
    }
    assert.equal((await remove(project.id)).status, 204);
  });

  await test('native work, pending continuation and unavailable inventory preserve the Project', async () => {
    for (const status of [
      { available: true, work: [{ id: 'child', kind: 'delegation' as const, status: 'running' }] },
      { available: false, work: [] },
      { ...idle(), continuation: { status: 'pending' as const } },
    ]) {
      const { project } = fixture();
      inventory = async () => status;
      await blocked(project.id, 'PROJECT_TASK_WORK_PENDING');
    }
    inventory = async () => { throw new Error('Private native failure'); };
    const { project } = fixture();
    await blocked(project.id, 'PROJECT_TASK_WORK_PENDING');
    inventory = async () => idle();
  });

  await test('deleting tasks also removes their queued messages', async () => {
    const { project, task } = fixture();
    putQueuedTaskMessage({ id: 'queued', taskId: task.id, content: 'Pending request', settings: {}, invitedProfileIds: [], collaborationScope: 'discussion', confirmPersistentCollaboration: false, createdAt: 1, updatedAt: 1 });
    assert.equal((await remove(project.id)).status, 204);
    assert.equal(getQueuedTaskMessage(task.id), undefined);
    assert.equal(getTask(task.id), undefined);
  });

  await test('automatic recovery must be stopped before Project deletion', async () => {
    const { project, task } = fixture();
    beginRecovery(task.id, 'recovering', 1);
    for (const state of ['running', 'pending', 'waiting', 'dispatching']) {
      db.prepare('UPDATE task_recovery SET state = ? WHERE task_id = ?').run(state, task.id);
      await blocked(project.id, 'PROJECT_TASK_WORK_PENDING');
    }
    db.prepare("UPDATE task_recovery SET state = 'blocked' WHERE task_id = ?").run(task.id);
    assert.equal((await remove(project.id)).status, 204);
  });

  await test('profile deletion blocks deleting its Project tasks', async () => {
    const { project, task } = fixture();
    const lock = beginProfileDeletion('default');
    try {
      await blocked(project.id, 'PROJECT_TASK_WORK_PENDING');
      assert.equal(getTask(task.id)?.project_id, project.id);
    } finally { lock.release(); }
  });

  await test('uncertain publication receipts cannot be discarded', async () => {
    const { project, task } = fixture();
    const editor = acquireProjectEditor({ projectId: project.id, taskId: task.id, profileId: 'default', repositoryFullName: 'fixture/repo', baseBranch: 'main', branchName: 'task/fixture', workdir: task.workdir!, leaseToken: 'fixture' });
    releaseProjectEditor({ leaseId: editor.id, taskId: task.id });
    const receipt = createProjectPublication({ id: `receipt-${sequence}`, projectId: project.id, taskId: null, leaseId: null, repository: { installationId: 71, providerRepositoryId: 91, cloneUrl: 'https://github.com/fixture/repo.git', defaultBranch: 'main' }, action: 'commit_push', revertedVersionId: null, parentSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), commitSha: null, commitMessage: 'Fixture', changedFiles: ['README.md'], targetBranch: 'task/fixture', refs: [{ ref: 'refs/heads/task/fixture', source: 'commit', createOnly: false }], createdAt: 1 });
    for (const state of ['prepared', 'pending']) {
      db.prepare('UPDATE project_publications SET state = ? WHERE id = ?').run(state, receipt.id);
      await blocked(project.id, 'PROJECT_PUBLICATION_PENDING');
      assert.ok(db.prepare('SELECT id FROM project_publications WHERE id = ?').get(receipt.id));
    }
  });

  await test('managed folders used by another task through an alias are preserved', async () => {
    const { project, task } = fixture();
    const owned = join(resolveOlympusDataDir(), 'project-checkouts', 'tasks', project.id, task.id);
    await mkdir(owned, { recursive: true });
    await writeFile(join(owned, 'keep.txt'), 'Shared with another task');
    const alias = join(root, `alias-${sequence}`);
    await symlink(owned, alias);
    const outsider = insertTask({ title: 'External owner', status: 'in_review', workdir: alias });
    await blocked(project.id, 'PROJECT_STORAGE_SHARED');
    assert.ok(getTask(outsider.id));
    assert.equal(await readFile(join(owned, 'keep.txt'), 'utf8'), 'Shared with another task');
  });

  await test('symlinked managed parents cannot redirect deletion outside Olympus', async () => {
    const { project, task } = fixture();
    const tasksRoot = join(resolveOlympusDataDir(), 'project-checkouts', 'tasks');
    const hidden = `${tasksRoot}-temporarily-saved`;
    const { rename } = await import('node:fs/promises');
    await rename(tasksRoot, hidden);
    const outside = join(root, 'outside-parent');
    await mkdir(join(outside, project.id, task.id), { recursive: true });
    await writeFile(join(outside, project.id, task.id, 'keep.txt'), 'External sentinel');
    await symlink(outside, tasksRoot);
    try {
      await blocked(project.id, 'PROJECT_STORAGE_UNSAFE');
      assert.equal(await readFile(join(outside, project.id, task.id, 'keep.txt'), 'utf8'), 'External sentinel');
    } finally { await rm(tasksRoot); await rename(hidden, tasksRoot); }
  });

  await test('a managed leaf symlink used by another task is not unlinked', async () => {
    const { project } = fixture();
    const owned = join(resolveOlympusDataDir(), 'project-checkouts', project.id);
    const external = join(root, `retained-target-${sequence}`);
    await mkdir(external);
    await symlink(external, owned);
    insertTask({ title: 'Uses managed alias', status: 'in_review', workdir: owned });
    await blocked(project.id, 'PROJECT_STORAGE_SHARED');
    assert.equal((await lstat(owned)).isSymbolicLink(), true);
  });

  await test('failed disk cleanup stays recoverable and only the operator can retry it', { skip: process.getuid?.() === 0 ? 'Root bypasses filesystem permission failures' : false }, async () => {
    const { project, task } = fixture();
    const owned = join(resolveOlympusDataDir(), 'project-checkouts', 'tasks', project.id);
    const locked = join(owned, 'locked');
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, 'local.txt'), 'Discarded local work');
    await chmod(locked, 0);
    try {
      const response = await remove(project.id);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'PROJECT_CLEANUP_PENDING');
      assert.equal(getProject(project.id), undefined);
      assert.equal(getTask(task.id), undefined);
      assert.equal((await remove(project.id, 'default')).status, 404);
      const index = await fetch(`http://127.0.0.1:${address.port}/api/projects`).then(response => response.json());
      assert.deepEqual(index.pendingDeletions, [{ id: project.id, name: project.name }]);
    } finally { await chmod(locked, 0o700); }
    assert.equal((await remove(project.id)).status, 204);
    await assert.rejects(lstat(owned), { code: 'ENOENT' });
    const index = await fetch(`http://127.0.0.1:${address.port}/api/projects`).then(response => response.json());
    assert.deepEqual(index.pendingDeletions, []);
  });

  await test('pending cleanup refuses remapped roots and resumes after restart with the original root', async () => {
    const { project, task } = fixture();
    const originalHome = process.env.OLYMPUS_DISPATCH_HOME!;
    const owned = join(resolveOlympusDataDir(), 'project-checkouts', 'tasks', project.id);
    await mkdir(owned, { recursive: true });
    await writeFile(join(owned, 'old.txt'), 'Delete original managed copy');
    const plan = await prepareProjectDeletionCleanup(project.id, [task]);
    deleteProject(project.id, plan);
    const remappedHome = join(root, 'remapped-home');
    const remapped = join(remappedHome, 'data', 'project-checkouts', 'tasks', project.id);
    await mkdir(remapped, { recursive: true });
    await writeFile(join(remapped, 'new.txt'), 'Keep unrelated remapped copy');
    process.env.OLYMPUS_DISPATCH_HOME = remappedHome;
    try {
      const response = await remove(project.id);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'PROJECT_CLEANUP_PENDING');
      assert.equal((await remove(project.id, 'default')).status, 404);
      await retryPendingProjectDeletionCleanup();
      assert.equal(await readFile(join(remapped, 'new.txt'), 'utf8'), 'Keep unrelated remapped copy');
      assert.equal(await readFile(join(owned, 'old.txt'), 'utf8'), 'Delete original managed copy');
      const index = await fetch(`http://127.0.0.1:${address.port}/api/projects`).then(response => response.json());
      assert.deepEqual(index.pendingDeletions, [{ id: project.id, name: project.name }]);
    } finally { process.env.OLYMPUS_DISPATCH_HOME = originalHome; }
    await retryPendingProjectDeletionCleanup();
    await assert.rejects(lstat(owned), { code: 'ENOENT' });
    assert.equal((await remove(project.id)).status, 404);
    assert.equal(await readFile(join(remapped, 'new.txt'), 'utf8'), 'Keep unrelated remapped copy');
  });

  await test('valid dotted profile names can clean their task output folders', async () => {
    const project = createProject({ name: 'Dotted profile project', purpose: 'Valid local profile', managerProfileId: 'design.team', changedBy: 'test' });
    const task = insertTask({ title: 'Design output', status: 'in_review', project_id: project.id, profile_name: 'design.team' });
    const output = join(process.env.HERMES_HOME!, 'profiles', 'design.team', 'workspace', 'tasks', task.id);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'poster.txt'), 'Disposable output');
    assert.equal((await remove(project.id)).status, 204);
    await assert.rejects(lstat(output), { code: 'ENOENT' });
  });

  await test('inventory checks fence task admission and recheck newly added tasks before deletion', async () => {
    const { project, task } = fixture();
    let entered!: () => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    inventory = async () => { entered(); await new Promise<void>(resolve => { resume = resolve; }); return idle(); };
    const deleting = remove(project.id);
    await Promise.race([checking, deleting.then(response => assert.equal(response.status, 204))]);
    assert.equal(claimTaskOperation(task.id, project.id), null);
    const added = insertTask({ title: 'Added while checking', status: 'in_progress', project_id: project.id });
    resume();
    const response = await deleting;
    assert.equal(response.status, 409);
    assert.equal(getTask(added.id)?.project_id, project.id);
    assert.ok(getProject(project.id));
    inventory = async () => idle();
    assert.equal((await remove(project.id)).status, 204);
  });

  await test('protected task history rolls back the entire Project deletion', async () => {
    const { project, task } = fixture();
    const protectedTask = insertTask({ title: 'Protected task', status: 'in_review', project_id: project.id });
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(2, task.id);
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(1, protectedTask.id);
    db.prepare('INSERT INTO project_reference_chunks_fts (chunk_id, project_id, reference_id, text) VALUES (?, ?, ?, ?)').run('protected-chunk', project.id, 'protected-reference', 'Keep indexed content');
    const owned = join(resolveOlympusDataDir(), 'project-checkouts', 'tasks', project.id, task.id);
    await mkdir(owned, { recursive: true });
    await writeFile(join(owned, 'rollback.txt'), 'Untouched by rollback');
    db.exec(`CREATE TABLE deletion_protected_history (task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE);
      CREATE TRIGGER deletion_history_immutable BEFORE DELETE ON deletion_protected_history
      BEGIN SELECT RAISE(ABORT, 'TASK_CONTROL_EVENT_IMMUTABLE'); END;`);
    db.prepare('INSERT INTO deletion_protected_history VALUES (?)').run(protectedTask.id);
    await blocked(project.id, 'TASK_CONTROL_EVENT_IMMUTABLE');
    assert.equal(getTask(task.id)?.project_id, project.id);
    assert.equal(getTask(protectedTask.id)?.project_id, project.id);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM deletion_protected_history').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM project_reference_chunks_fts WHERE project_id = ?').get(project.id) as { n: number }).n, 1);
    assert.equal(await readFile(join(owned, 'rollback.txt'), 'utf8'), 'Untouched by rollback');
    assert.equal(db.prepare('SELECT project_id FROM project_deletion_cleanup WHERE project_id = ?').get(project.id), undefined);
  });
} finally {
  server.close(); await once(server, 'close');
  db.close();
  await rm(root, { recursive: true, force: true });
}
