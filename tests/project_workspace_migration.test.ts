import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const root = await mkdtemp(join(tmpdir(), 'olympus-workspace-migration-'));
const dbPath = join(root, 'test.db'); const workdir = join(root, 'legacy-checkout');
await mkdir(workdir); await writeFile(join(workdir, 'saved.png'), 'Unpublished poster');
const legacy = new Database(dbPath);
legacy.exec(await readFile(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
legacy.exec(`
  DROP INDEX IF EXISTS idx_project_editor_active_task;
  DROP INDEX IF EXISTS idx_project_editor_active_workdir;
  CREATE UNIQUE INDEX idx_project_editor_active ON project_editor_leases(project_id) WHERE status = 'active';
  INSERT INTO projects VALUES ('project', 'Legacy', 'legacy', 'Preserve existing work', 'default', 1, 1);
  INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES ('owner', 'Old owner', 'in_progress', 1, 1), ('next', 'New task', 'in_progress', 2, 2);
`);
legacy.prepare('UPDATE tasks SET workdir = ? WHERE id = ?').run(workdir, 'owner');
legacy.prepare(`INSERT INTO project_editor_leases VALUES ('old-lease', 'project', 'owner', 'default', 'fixture/repo', 'main', 'olympus/old', ?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'active', 'legacy-token', 1, 1, NULL)`).run(workdir);
const before = legacy.prepare('SELECT * FROM project_editor_leases WHERE id = ?').get('old-lease');
legacy.close();

try {
  const runStartup = () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "const {default: db} = await import('./server/db/index.ts'); db.close();"], {
    cwd: process.cwd(), env: { ...process.env, DB_PATH: dbPath, OLYMPUS_DISPATCH_HOME: root },
  });
  await runStartup();
  const upgraded = new Database(dbPath);
  assert.deepEqual(upgraded.prepare('SELECT * FROM project_editor_leases WHERE id = ?').get('old-lease'), before);
  assert.equal(await readFile(join(workdir, 'saved.png'), 'utf8'), 'Unpublished poster');
  upgraded.prepare(`INSERT INTO project_editor_leases SELECT 'new-lease', project_id, 'next', profile_id, repository_full_name, base_branch, 'olympus/next', ?, base_sha, 'active', 'next-token', 2, 2, NULL FROM project_editor_leases WHERE id = 'old-lease'`).run(join(root, 'task-next'));
  assert.throws(() => upgraded.prepare(`INSERT INTO project_editor_leases SELECT 'duplicate-task', project_id, task_id, profile_id, repository_full_name, base_branch, branch_name, 'somewhere-else', base_sha, 'active', 'duplicate', 3, 3, NULL FROM project_editor_leases WHERE id = 'new-lease'`).run(), /UNIQUE/);
  upgraded.close();
  await runStartup();
  const again = new Database(dbPath);
  assert.equal((again.prepare("SELECT COUNT(*) n FROM project_editor_leases WHERE status = 'active'").get() as { n: number }).n, 2, 'restart keeps both task workspaces');
  assert.deepEqual(again.prepare('SELECT * FROM project_editor_leases WHERE id = ?').get('old-lease'), before);
  again.close();
} finally { await rm(root, { recursive: true, force: true }); }
console.log('Legacy workspace ownership migration tests passed');
