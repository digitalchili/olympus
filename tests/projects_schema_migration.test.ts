import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

const root = await mkdtemp(join(tmpdir(), 'olympus-projects-migration-'));
const dbPath = join(root, 'data', 'legacy.db');
await mkdir(dirname(dbPath), { recursive: true });

const legacy = new Database(dbPath);
legacy.pragma('foreign_keys = ON');
legacy.exec(`
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress',
    profile_name TEXT,
    routing_source TEXT,
    agent_model TEXT,
    agent_provider TEXT,
    reasoning_effort TEXT,
    workdir TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_agent_response_at INTEGER,
    last_viewed_at INTEGER,
    last_context_used_tokens INTEGER,
    last_context_window_tokens INTEGER
  );
  INSERT INTO tasks (
    id, title, description, status, profile_name, routing_source,
    created_at, updated_at
  ) VALUES
    ('named-task', 'Named', NULL, 'in_progress', 'somchai', 'manual', 100, 100),
    ('legacy-default', 'Default', NULL, 'done', NULL, NULL, 200, 200);

  CREATE TABLE studio_github_installations (
    id INTEGER PRIMARY KEY CHECK(id > 0),
    account_login TEXT NOT NULL,
    account_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO studio_github_installations VALUES (44, 'digitalchili', 'Organization', 100, 100);

  CREATE TABLE studio_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_repository_id INTEGER NOT NULL,
    installation_id INTEGER NOT NULL,
    owner TEXT NOT NULL,
    full_name TEXT NOT NULL,
    private INTEGER NOT NULL,
    default_branch TEXT NOT NULL,
    html_url TEXT NOT NULL,
    clone_url TEXT NOT NULL,
    mode TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(provider, provider_repository_id)
  );
  INSERT INTO studio_projects VALUES (
    'legacy-project', 'legacy-repository', 'github', 101, 44, 'digitalchili',
    'digitalchili/legacy-repository', 1, 'main', 'https://github.com/digitalchili/legacy-repository',
    'https://github.com/digitalchili/legacy-repository.git', 'read_only', 300, 400
  );
`);
legacy.close();

process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = dbPath;

try {
  const { default: db } = await import('../server/db/index.js');

  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
  for (const required of ['project_id', 'handling_profile_id', 'delegated_worker_id']) {
    assert.ok(taskColumns.some((column) => column.name === required), `missing tasks.${required}`);
  }

  assert.deepEqual(
    db.prepare('SELECT id, project_id, handling_profile_id, delegated_worker_id FROM tasks ORDER BY id').all(),
    [
      { id: 'legacy-default', project_id: null, handling_profile_id: 'default', delegated_worker_id: null },
      { id: 'named-task', project_id: null, handling_profile_id: 'somchai', delegated_worker_id: null },
    ],
  );

  const project = db.prepare(`
    SELECT id, name, purpose, manager_profile_id, created_at, updated_at
    FROM projects WHERE id = 'legacy-project'
  `).get();
  assert.deepEqual(project, {
    id: 'legacy-project',
    name: 'legacy-repository',
    purpose: 'Imported from GitHub: digitalchili/legacy-repository',
    manager_profile_id: 'default',
    created_at: 300,
    updated_at: 400,
  });

  assert.deepEqual(db.prepare(`
    SELECT project_id, provider, provider_repository_id, installation_id, full_name, mode
    FROM project_repository_links WHERE project_id = 'legacy-project'
  `).get(), {
    project_id: 'legacy-project',
    provider: 'github',
    provider_repository_id: 101,
    installation_id: 44,
    full_name: 'digitalchili/legacy-repository',
    mode: 'read_only',
  });

  assert.deepEqual(db.prepare(`
    SELECT project_id, profile_id, effective_from, effective_to, changed_by
    FROM project_manager_history WHERE project_id = 'legacy-project'
  `).get(), {
    project_id: 'legacy-project',
    profile_id: 'default',
    effective_from: 300,
    effective_to: null,
    changed_by: 'legacy-studio-migration',
  });

  assert.deepEqual(db.prepare(`
    SELECT label, permission_mode
    FROM studio_github_installations
    WHERE id = 44
  `).get(), {
    label: 'digitalchili',
    permission_mode: 'upgrade_required',
  });

  // Startup migration must be idempotent and must not duplicate history or links.
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM projects WHERE id = 'legacy-project') AS projects,
      (SELECT COUNT(*) FROM project_repository_links WHERE project_id = 'legacy-project') AS links,
      (SELECT COUNT(*) FROM project_manager_history WHERE project_id = 'legacy-project') AS history
  `).get();
  assert.deepEqual(counts, { projects: 1, links: 1, history: 1 });

  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Global Projects compatibility migration tests passed');
