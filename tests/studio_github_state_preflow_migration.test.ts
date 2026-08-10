import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

const root = await mkdtemp(join(tmpdir(), 'olympus-studio-preflow-migration-'));
const dbPath = join(root, 'data', 'studio.db');
await mkdir(dirname(dbPath), { recursive: true });

const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE studio_github_connection_states (
    state_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
  INSERT INTO studio_github_connection_states (
    state_hash, expires_at, consumed_at
  ) VALUES ('legacy-install-only', 9999999999999, NULL);
`);
legacy.close();

process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = dbPath;

const { default: db } = await import('../server/db/index.js');
try {
  assert.deepEqual(
    db.prepare("SELECT state_hash, flow, installation_id FROM studio_github_connection_states WHERE state_hash = 'legacy-install-only'").get(),
    { state_hash: 'legacy-install-only', flow: 'install', installation_id: null },
  );
  assert.doesNotThrow(() => db.prepare(`
    INSERT INTO studio_github_connection_states (
      state_hash, flow, installation_id, expires_at, consumed_at
    ) VALUES ('manifest-state', 'manifest', NULL, 9999999999999, NULL)
  `).run());
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}

console.log('Studio GitHub pre-flow state migration tests passed');
