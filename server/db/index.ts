import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOlympusDbPath, ensureOlympusStateDirs } from '../paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

ensureOlympusStateDirs();

const dbPath = resolveOlympusDbPath();

const db: import('better-sqlite3').Database = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');

function ensureColumn(table: string, column: string, ddl: string): void {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!info.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function migrateCollaborationContributions(): void {
  const columns = db.prepare('PRAGMA table_info(collaboration_contributions)').all() as Array<{ name: string }>;
  if (columns.length === 0 || columns.some((column) => column.name === 'phase')) return;

  db.exec(`
    ALTER TABLE collaboration_contributions RENAME TO collaboration_contributions_legacy;
    CREATE TABLE collaboration_contributions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES collaboration_runs(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL,
      profile_label TEXT NOT NULL,
      session_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      phase_round INTEGER NOT NULL,
      status TEXT NOT NULL,
      content TEXT,
      error TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(run_id, profile_id, phase)
    );
    INSERT INTO collaboration_contributions (
      id, run_id, profile_id, profile_label, session_id, phase, phase_round,
      status, content, error, started_at, completed_at
    )
    SELECT id, run_id, profile_id, profile_label, session_id, 'proposal', 1,
      status, content, error, started_at, completed_at
    FROM collaboration_contributions_legacy;
    DROP TABLE collaboration_contributions_legacy;
  `);
}

function ensureCollaborationContributionIndex(): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_collaboration_contributions_run;
    CREATE INDEX idx_collaboration_contributions_run
      ON collaboration_contributions(run_id, phase_round, started_at);
  `);
}

function migrateStudioGitHubConnectionStates(): void {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'studio_github_connection_states'
  `).get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'manifest'")) return;

  const columns = db.prepare('PRAGMA table_info(studio_github_connection_states)').all() as Array<{ name: string }>;
  const hasFlow = columns.some((column) => column.name === 'flow');
  const hasInstallationId = columns.some((column) => column.name === 'installation_id');
  const legacyFlow = hasFlow ? 'flow' : "'install'";
  const legacyInstallationId = hasInstallationId ? 'installation_id' : 'NULL';

  db.exec(`
    ALTER TABLE studio_github_connection_states RENAME TO studio_github_connection_states_legacy;
    CREATE TABLE studio_github_connection_states (
      state_hash TEXT PRIMARY KEY,
      flow TEXT NOT NULL CHECK(flow IN ('manifest', 'install', 'oauth')),
      installation_id INTEGER,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      CHECK(
        (flow IN ('manifest', 'install') AND installation_id IS NULL)
        OR (flow = 'oauth' AND installation_id > 0)
      )
    );
    INSERT INTO studio_github_connection_states (
      state_hash, flow, installation_id, expires_at, consumed_at
    )
    SELECT state_hash, ${legacyFlow}, ${legacyInstallationId}, expires_at, consumed_at
    FROM studio_github_connection_states_legacy;
    DROP TABLE studio_github_connection_states_legacy;
  `);
}

function normalizedProjectName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function migrateLegacyStudioProjects(): void {
  const legacy = db.prepare(`
    SELECT id, name, provider, provider_repository_id, installation_id, owner,
      full_name, private, default_branch, html_url, clone_url, mode, created_at, updated_at
    FROM studio_projects
    ORDER BY created_at, id
  `).all() as Array<{
    id: string;
    name: string;
    provider: 'github';
    provider_repository_id: number;
    installation_id: number;
    owner: string;
    full_name: string;
    private: number;
    default_branch: string;
    html_url: string;
    clone_url: string;
    mode: 'read_only';
    created_at: number;
    updated_at: number;
  }>;

  const projectExists = db.prepare('SELECT 1 FROM projects WHERE id = ?');
  const nameExists = db.prepare('SELECT 1 FROM projects WHERE name_key = ?');
  const insertProject = db.prepare(`
    INSERT INTO projects (
      id, name, name_key, purpose, manager_profile_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'default', ?, ?)
  `);
  const insertHistory = db.prepare(`
    INSERT OR IGNORE INTO project_manager_history (
      id, project_id, profile_id, effective_from, effective_to, changed_by
    ) VALUES (?, ?, 'default', ?, NULL, 'legacy-studio-migration')
  `);
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO project_repository_links (
      project_id, provider, provider_repository_id, installation_id, owner, full_name,
      private, default_branch, html_url, clone_url, mode, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of legacy) {
    if (!projectExists.get(row.id)) {
      let name = row.name.trim() || row.full_name;
      let nameKey = normalizedProjectName(name);
      if (nameExists.get(nameKey)) {
        name = row.full_name;
        nameKey = normalizedProjectName(name);
      }
      if (nameExists.get(nameKey)) {
        name = `${row.full_name} (${row.id.slice(0, 8)})`;
        nameKey = normalizedProjectName(name);
      }
      insertProject.run(
        row.id,
        name,
        nameKey,
        `Imported from GitHub: ${row.full_name}`,
        row.created_at,
        row.updated_at,
      );
    }
    insertHistory.run(randomUUID(), row.id, row.created_at);
    insertLink.run(
      row.id,
      row.provider,
      row.provider_repository_id,
      row.installation_id,
      row.owner,
      row.full_name,
      row.private,
      row.default_branch,
      row.html_url,
      row.clone_url,
      row.mode,
      row.created_at,
      row.updated_at,
    );
  }
}

function recoverInterruptedCollaborations(): void {
  const now = Date.now();
  db.prepare(`
    UPDATE collaboration_contributions
    SET status = 'error',
        error = COALESCE(error, 'Olympus restarted before this contribution completed'),
        completed_at = COALESCE(completed_at, ?)
    WHERE status IN ('pending', 'running')
  `).run(now);
  db.prepare(`
    UPDATE collaboration_runs
    SET status = 'failed', completed_at = COALESCE(completed_at, ?)
    WHERE status IN ('gathering', 'proposal', 'review', 'synthesizing')
  `).run(now);
}

function recoverInterruptedDelegations(): void {
  const now = Date.now();
  db.prepare(`
    UPDATE delegation_runs
    SET status = 'unknown', current_action = NULL,
        completed_at = MAX(updated_at + 1, ?),
        updated_at = MAX(updated_at + 1, ?)
    WHERE status IN ('queued', 'running', 'waiting')
  `).run(now, now);
}

db.exec('BEGIN IMMEDIATE');
try {
  db.exec(schema);
  migrateCollaborationContributions();
  ensureCollaborationContributionIndex();
  migrateStudioGitHubConnectionStates();
  ensureColumn('task_agent_runs', 'error_code', 'TEXT');
  ensureColumn('tasks', 'agent_provider', 'TEXT');
  ensureColumn('tasks', 'workdir', 'TEXT');
  ensureColumn('tasks', 'profile_name', 'TEXT');
  ensureColumn('tasks', 'routing_source', 'TEXT');
  ensureColumn('tasks', 'project_id', 'TEXT REFERENCES projects(id) ON DELETE SET NULL');
  ensureColumn('tasks', 'handling_profile_id', 'TEXT');
  ensureColumn('tasks', 'delegated_worker_id', 'TEXT');
  ensureColumn('studio_github_installations', 'label', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('studio_github_installations', 'permission_mode', "TEXT NOT NULL DEFAULT 'upgrade_required'");
  db.prepare(`
    UPDATE studio_github_installations
    SET label = account_login
    WHERE TRIM(label) = ''
  `).run();
  db.prepare(`
    UPDATE tasks
    SET handling_profile_id = COALESCE(NULLIF(profile_name, ''), 'default')
    WHERE handling_profile_id IS NULL
  `).run();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_handler ON tasks(handling_profile_id, updated_at DESC);
  `);
  migrateLegacyStudioProjects();
  recoverInterruptedCollaborations();
  recoverInterruptedDelegations();
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

export default db;
