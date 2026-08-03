import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-db-'));
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = join(root, 'data', 'test.db');

const { default: db } = await import('../server/db/index.js');
const timeout = db.pragma('busy_timeout', { simple: true });
assert.equal(timeout, 5_000);
const journalMode = db.pragma('journal_mode', { simple: true });
assert.equal(String(journalMode).toLowerCase(), 'wal');
assert.doesNotThrow(() => db.prepare('SELECT id FROM tasks LIMIT 1').all());
db.close();

console.log('Database startup tests passed');
