import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-collaboration-migration-'));
const dbPath = join(root, 'data', 'legacy.db');
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = dbPath;

try {
  await mkdir(dirname(dbPath), { recursive: true });
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE collaboration_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      status TEXT NOT NULL,
      question TEXT NOT NULL,
      owner_profile_id TEXT NOT NULL,
      owner_invited INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      contributors_completed_at INTEGER,
      completed_at INTEGER,
      UNIQUE(task_id, round)
    );
    CREATE TABLE collaboration_contributions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES collaboration_runs(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL,
      profile_label TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      content TEXT,
      error TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(run_id, profile_id)
    );
  `);
  legacy.close();

  const { default: db } = await import('../server/db/index.js');
  const columns = db.prepare('PRAGMA table_info(collaboration_contributions)').all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === 'phase'));
  assert.ok(columns.some((column) => column.name === 'phase_round'));
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_collaboration_contributions_run'").get() as { sql: string };
  assert.match(index.sql, /phase_round/);
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Legacy collaboration schema migration tests passed');
