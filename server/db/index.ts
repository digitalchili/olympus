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

db.exec('BEGIN IMMEDIATE');
try {
  db.exec(schema);
  ensureColumn('tasks', 'agent_provider', 'TEXT');
  ensureColumn('tasks', 'workdir', 'TEXT');
  ensureColumn('tasks', 'profile_name', 'TEXT');
  ensureColumn('tasks', 'routing_source', 'TEXT');
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

export default db;
