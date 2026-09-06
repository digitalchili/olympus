import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const root = await mkdtemp(join(tmpdir(), 'olympus-bots-migration-'));
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.HERMES_HOME = join(root, 'hermes');
process.env.DB_PATH = join(root, 'legacy.db');
await mkdir(process.env.HERMES_HOME, { recursive: true });
const legacy = new Database(process.env.DB_PATH);
legacy.exec(`CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'in_progress',
  profile_name TEXT, routing_source TEXT, agent_model TEXT, agent_provider TEXT, reasoning_effort TEXT,
  workdir TEXT, handling_profile_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_agent_response_at INTEGER, last_viewed_at INTEGER, last_context_used_tokens INTEGER, last_context_window_tokens INTEGER
);
INSERT INTO tasks (id,title,description,status,profile_name,handling_profile_id,created_at,updated_at)
VALUES ('old-default','Preserve me','History linkage','in_review',NULL,NULL,11,22),
       ('old-writer','Writer task',NULL,'done','writer','',33,44);`);
legacy.close();
try {
  const { default: first } = await import('../server/db/index.js');
  const rows = first.prepare('SELECT id,title,description,status,kind,handling_profile_id,created_at,updated_at FROM tasks ORDER BY id').all();
  assert.deepEqual(rows, [
    { id: 'old-default', title: 'Preserve me', description: 'History linkage', status: 'in_review', kind: 'task', handling_profile_id: 'default', created_at: 11, updated_at: 22 },
    { id: 'old-writer', title: 'Writer task', description: null, status: 'done', kind: 'task', handling_profile_id: 'writer', created_at: 33, updated_at: 44 },
  ]);
  first.close();
  const moduleUrl = new URL('../server/db/index.js', import.meta.url);
  moduleUrl.searchParams.set('restart', 'true');
  const { default: second } = await import(moduleUrl.href);
  assert.deepEqual(second.prepare('SELECT id,title,description,status,kind,handling_profile_id,created_at,updated_at FROM tasks ORDER BY id').all(), rows);
  second.close();
} finally { await rm(root, { recursive: true, force: true }); }
console.log('Bot migration preserves existing task state across repeated startup');
