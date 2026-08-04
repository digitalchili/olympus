import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import express from 'express';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HermesSqliteChannelHistorySource } from '../server/channel-history.js';
import { LocalProfileRegistry } from '../server/local-profiles.js';
import { createChannelHistoryRouter } from '../server/routes/channel-history.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-channel-routes-'));
const hermesHome = join(root, 'hermes');
const writerHome = join(hermesHome, 'profiles', 'writer');
const waitingHome = join(hermesHome, 'profiles', 'waiting');
const dispatchDb = new Database(':memory:');

dispatchDb.exec(`
  CREATE TABLE channel_threads (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    hermes_root_session_id TEXT NOT NULL,
    hermes_tip_session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    preview TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(profile_id, channel_id, hermes_root_session_id)
  );
  CREATE TABLE channel_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES channel_threads(id) ON DELETE CASCADE,
    hermes_message_id INTEGER NOT NULL,
    direction TEXT NOT NULL,
    content TEXT NOT NULL,
    content_truncated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(thread_id, hermes_message_id)
  );
`);

function createHermesState(home: string, sessionId: string, userText: string, assistantText: string): void {
  const db = new Database(join(home, 'state.db'));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      parent_session_id TEXT,
      started_at REAL NOT NULL,
      title TEXT,
      display_name TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      timestamp REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      display_kind TEXT
    );
  `);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(sessionId, 'telegram', null, 100, 'Local chat', null);
  db.prepare('INSERT INTO messages (session_id, role, content, timestamp, active, display_kind) VALUES (?, ?, ?, ?, 1, NULL)')
    .run(sessionId, 'user', userText, 101);
  db.prepare('INSERT INTO messages (session_id, role, content, timestamp, active, display_kind) VALUES (?, ?, ?, ?, 1, NULL)')
    .run(sessionId, 'assistant', assistantText, 102);
  db.close();
}

try {
  await mkdir(writerHome, { recursive: true });
  await mkdir(waitingHome, { recursive: true });
  await writeFile(join(hermesHome, 'config.yaml'), '{}\n');
  await writeFile(join(writerHome, 'profile.yaml'), 'displayName: Writer\n');
  await writeFile(join(writerHome, 'config.yaml'), '{}\n');
  await writeFile(join(waitingHome, 'profile.yaml'), 'displayName: Waiting\n');
  await writeFile(join(waitingHome, 'config.yaml'), '{}\n');
  createHermesState(hermesHome, 'default-private-session', 'Default local user', 'Default local assistant');
  createHermesState(writerHome, 'writer-private-session', 'Writer local user', 'Writer local assistant');

  const discoveredHomes: string[] = [];
  const app = express();
  app.use('/api/channels', createChannelHistoryRouter({
    db: dispatchDb,
    source: new HermesSqliteChannelHistorySource(),
    profiles: new LocalProfileRegistry(hermesHome),
    discover: async (home) => {
      discoveredHomes.push(home);
      return [{ id: 'telegram', displayLabel: 'Telegram', enabled: true, health: 'healthy' }];
    },
  }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/channels`;

  try {
    const defaultResponse = await fetch(`${base}/telegram/threads?profile=default`);
    assert.equal(defaultResponse.status, 200);
    const defaultThreads = await defaultResponse.json() as { state: string; threads: Array<{ id: string; preview: string }> };
    assert.equal(defaultThreads.state, 'available');
    assert.equal(defaultThreads.threads.length, 1);
    assert.equal(defaultThreads.threads[0].preview, 'Default local assistant');

    const writerResponse = await fetch(`${base}/telegram/threads?profile=writer`);
    assert.equal(writerResponse.status, 200);
    const writerThreads = await writerResponse.json() as { state: string; threads: Array<{ id: string; preview: string }> };
    assert.equal(writerThreads.threads.length, 1);
    assert.equal(writerThreads.threads[0].preview, 'Writer local assistant');
    assert.notEqual(writerThreads.threads[0].id, defaultThreads.threads[0].id);

    const messagesResponse = await fetch(`${base}/telegram/threads/${defaultThreads.threads[0].id}/messages?profile=default`);
    assert.equal(messagesResponse.status, 200);
    const history = await messagesResponse.json() as { messages: Array<{ direction: string; content: string }> };
    assert.deepEqual(history.messages.map((message) => [message.direction, message.content]), [
      ['inbound', 'Default local user'],
      ['outbound', 'Default local assistant'],
    ]);

    const crossProfile = await fetch(`${base}/telegram/threads/${defaultThreads.threads[0].id}/messages?profile=writer`);
    assert.equal(crossProfile.status, 404, 'opaque thread IDs remain profile scoped at the API boundary');

    const waitingResponse = await fetch(`${base}/telegram/threads?profile=waiting`);
    assert.equal(waitingResponse.status, 200);
    assert.deepEqual(await waitingResponse.json(), { state: 'awaiting_bridge', threads: [] });

    assert.equal((await fetch(`${base}/webhook/threads?profile=default`)).status, 404,
      'infrastructure transports cannot be read as channel history');
    assert.equal((await fetch(`${base}/telegram/threads?profile=missing`)).status, 400);
    assert.deepEqual(
      discoveredHomes.toSorted(),
      [hermesHome, hermesHome, writerHome, writerHome, waitingHome].toSorted(),
      'every route resolves channel discovery against only the request profile local Hermes home',
    );

    const serialized = JSON.stringify({ defaultThreads, writerThreads, history });
    for (const forbidden of ['default-private-session', 'writer-private-session', hermesHome]) {
      assert.equal(serialized.includes(forbidden), false, `channel API leaked ${forbidden}`);
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
} finally {
  dispatchDb.close();
  await rm(root, { recursive: true, force: true });
}

console.log('Profile-scoped channel history route tests passed');
