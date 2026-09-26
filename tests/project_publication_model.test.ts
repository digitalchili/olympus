import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import db from '../server/db/index.js';
import { createProject } from '../server/db/projects.js';
import { insertTask } from '../server/db/queries.js';
import { acquireProjectEditor, getProjectVersion, listProjectVersions } from '../server/db/project-cp.js';
import { createProjectPublication, getProjectPublication, getPendingProjectPublication, setProjectPublicationCommit, confirmProjectPublication, abandonProjectPublication } from '../server/db/project-publications.js';

const project = createProject({ name: 'Publication model', purpose: 'Receipt durability', managerProfileId: 'default', changedBy: 'test' });
const task = insertTask({ title: 'Publish', project_id: project.id, status: 'in_progress' });
const lease = acquireProjectEditor({ projectId: project.id, taskId: task.id, profileId: 'default', repositoryFullName: 'fixture/repo', workdir: '/fixture/model', branchName: 'task', baseBranch: 'main', baseSha: 'a'.repeat(40), leaseToken: 'fixture' });
const input = { id: `z-${randomUUID()}`, projectId: project.id, taskId: task.id, leaseId: lease.id,
  repository: { installationId: 77, providerRepositoryId: 88, cloneUrl: 'https://github.com/fixture/repo.git', defaultBranch: 'main' },
  action: 'commit_push' as const, revertedVersionId: null, parentSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), commitSha: null,
  commitMessage: 'Saved intent', changedFiles: ['a.txt'], targetBranch: 'task',
  refs: [{ ref: 'refs/heads/task', source: 'commit', createOnly: false }], createdAt: 1 };
const receipt = createProjectPublication(input);
assert.equal(receipt.state, 'prepared');
assert.equal(getPendingProjectPublication(project.id, task.id)?.id, receipt.id);
assert.throws(() => createProjectPublication({ ...input, id: randomUUID() }), /UNIQUE/);
assert.throws(() => setProjectPublicationCommit(receipt.id, 'not-a-sha'));
assert.equal(setProjectPublicationCommit(receipt.id, 'c'.repeat(40)).state, 'pending');
assert.equal(setProjectPublicationCommit(receipt.id, 'c'.repeat(40)).commitSha, 'c'.repeat(40));
assert.throws(() => setProjectPublicationCommit(receipt.id, 'd'.repeat(40)), /commit|state/i);
db.exec(`CREATE TRIGGER fail_publication_confirmation BEFORE UPDATE ON project_publications WHEN NEW.state = 'confirmed' BEGIN SELECT RAISE(ABORT, 'fixture db failure'); END;`);
assert.throws(() => confirmProjectPublication(receipt.id, 2), /fixture db failure/);
assert.equal(getProjectVersion(receipt.id), null, 'confirmation rolls back version insertion too');
assert.equal(getProjectPublication(receipt.id)?.state, 'pending');
db.exec('DROP TRIGGER fail_publication_confirmation');
const version = confirmProjectPublication(receipt.id, 2);
assert.equal(confirmProjectPublication(receipt.id, 3).id, version.id);
assert.equal(listProjectVersions(project.id).length, 1);
assert.equal(getPendingProjectPublication(project.id, task.id), null);
const restore = createProjectPublication({ ...input, id: `a-${randomUUID()}`, action: 'revert', revertedVersionId: version.id });
setProjectPublicationCommit(restore.id, 'd'.repeat(40));
assert.equal(confirmProjectPublication(restore.id, 4).revertedVersionId, version.id);
const abandoned = createProjectPublication({ ...input, id: randomUUID() });
assert.equal(abandonProjectPublication(abandoned.id).state, 'abandoned');
assert.equal(abandonProjectPublication(abandoned.id).state, 'abandoned');
assert.throws(() => confirmProjectPublication(abandoned.id, 4));
const schema = await readFile(new URL('../server/db/schema.sql', import.meta.url), 'utf8');
const legacy = new Database(':memory:');
legacy.pragma('foreign_keys = ON');
legacy.exec(schema.replace(/CREATE TABLE IF NOT EXISTS project_publications \([\s\S]*?CREATE UNIQUE INDEX IF NOT EXISTS idx_project_publication_pending_task[\s\S]*?;/, ''));
const historical: Record<string, unknown[]> = {};
legacy.transaction(() => {
  legacy.pragma('defer_foreign_keys = ON'); // Restore/version UUID order is unrelated to dependency order.
  for (const table of ['projects', 'tasks', 'project_editor_leases', 'project_versions']) {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'} = ? ORDER BY id`).all(project.id) as Record<string, unknown>[];
    historical[table] = rows;
    for (const row of rows) {
      const fields = Object.keys(row);
      legacy.prepare(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...Object.values(row));
    }
  }
})();
assert.deepEqual(legacy.pragma('foreign_key_check'), []);
legacy.exec(schema); legacy.exec(schema);
assert.equal((legacy.prepare('SELECT COUNT(*) AS count FROM project_publications').get() as { count: number }).count, 0);
for (const [table, rows] of Object.entries(historical)) assert.deepEqual(legacy.prepare(`SELECT * FROM ${table} ORDER BY id`).all(), rows, `upgrade preserves historical ${table}`);
legacy.close();
const before = db.prepare('SELECT * FROM project_versions ORDER BY id').all();
db.exec(schema); db.exec(schema);
assert.deepEqual(db.prepare('SELECT * FROM project_versions ORDER BY id').all(), before);
db.prepare('DELETE FROM project_editor_leases WHERE id = ?').run(lease.id);
assert.equal(getProjectPublication(receipt.id)?.leaseId, null);
db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
assert.equal(getProjectPublication(receipt.id)?.taskId, null);
console.log('Publication model: uniqueness, exact commit, atomic confirmation, idempotency, repeated schema and history retention passed');
