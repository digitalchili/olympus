import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMinionsDbPath, ensureMinionsStateDirs } from '../paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

ensureMinionsStateDirs();

const dbPath = resolveMinionsDbPath();

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

db.exec('BEGIN IMMEDIATE');
try {
  db.exec(schema);
  migrateCollaborationContributions();
  ensureCollaborationContributionIndex();
  ensureColumn('tasks', 'agent_provider', 'TEXT');
  ensureColumn('tasks', 'workdir', 'TEXT');
  ensureColumn('tasks', 'profile_name', 'TEXT');
  ensureColumn('tasks', 'routing_source', 'TEXT');
  recoverInterruptedCollaborations();
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

export default db;
