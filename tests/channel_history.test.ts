import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-channel-history-'));
const dispatchHome = join(root, 'dispatch');
const hermesHome = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = dispatchHome;
process.env.DB_PATH = join(dispatchHome, 'data', 'test.db');

try {
  await mkdir(hermesHome, { recursive: true });
  const hermesDb = new Database(join(hermesHome, 'state.db'));
  hermesDb.exec(`
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
  hermesDb.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
    'telegram-root-session', 'telegram', null, 100, null, 'Customer chat',
  );
  hermesDb.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
    'telegram-continuation-session', 'telegram', 'telegram-root-session', 200, 'Order question', 'Customer chat',
  );
  hermesDb.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
    'webhook-session', 'webhook', null, 300, 'Internal webhook', null,
  );
  hermesDb.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
    'cli-session', 'cli', null, 400, 'CLI work', null,
  );

  const insertMessage = hermesDb.prepare(
    'INSERT INTO messages (session_id, role, content, timestamp, active, display_kind) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertMessage.run('telegram-root-session', 'user', 'Where is my order?', 101, 1, null);
  insertMessage.run('telegram-root-session', 'tool', 'INTERNAL TOOL RESULT', 102, 1, null);
  insertMessage.run('telegram-root-session', 'assistant', 'I am checking it now.', 103, 1, null);
  insertMessage.run('telegram-root-session', 'assistant', 'INTERNAL HIDDEN TURN', 104, 1, 'hidden');
  insertMessage.run('telegram-root-session', 'user', 'SOFT DELETED TURN', 105, 0, null);
  insertMessage.run(
    'telegram-continuation-session',
    'user',
    '\0json:' + JSON.stringify([
      { type: 'text', text: 'Here is the delivery photo.' },
      { type: 'image_url', image_url: { url: 'https://secret.example/signed-photo' } },
    ]),
    201,
    1,
    null,
  );
  insertMessage.run('telegram-continuation-session', 'assistant', 'It was left at the front desk.', 202, 1, null);
  insertMessage.run('webhook-session', 'user', 'WEBHOOK PAYLOAD', 301, 1, null);
  hermesDb.close();

  const { default: dispatchDb } = await import('../server/db/index.js');
  const {
    ChannelHistoryBridge,
    HermesSqliteChannelHistorySource,
  } = await import('../server/channel-history.js');
  const bridge = new ChannelHistoryBridge(dispatchDb, new HermesSqliteChannelHistorySource());

  const first = await bridge.listThreads('internal-profile-name', hermesHome, 'telegram');
  assert.equal(first.state, 'available');
  assert.equal(first.threads.length, 1, 'compression lineage is one conversation thread');
  const thread = first.threads[0];
  assert.equal(thread.title, 'Order question');
  assert.equal(thread.preview, 'It was left at the front desk.');
  assert.equal(thread.messageCount, 4);
  assert.equal(thread.updatedAt, 202_000);
  assert.equal(thread.id.includes('telegram-root-session'), false, 'Hermes session IDs stay server-side');
  assert.equal(thread.id.includes('internal-profile-name'), false, 'profile IDs stay server-side');

  const second = await bridge.listThreads('internal-profile-name', hermesHome, 'telegram');
  assert.deepEqual(second, first);
  assert.equal((dispatchDb.prepare('SELECT COUNT(*) AS count FROM channel_threads').get() as { count: number }).count, 1,
    'repeated thread sync is idempotent');

  const history = await bridge.listMessages('internal-profile-name', hermesHome, 'telegram', thread.id);
  assert.ok(history);
  assert.equal(history.state, 'available');
  assert.equal(history.truncated, false);
  assert.deepEqual(history.messages.map((message) => [message.direction, message.content]), [
    ['inbound', 'Where is my order?'],
    ['outbound', 'I am checking it now.'],
    ['inbound', 'Here is the delivery photo.'],
    ['outbound', 'It was left at the front desk.'],
  ]);
  const serialized = JSON.stringify(history);
  for (const forbidden of [
    'INTERNAL TOOL RESULT',
    'INTERNAL HIDDEN TURN',
    'SOFT DELETED TURN',
    'signed-photo',
    'telegram-root-session',
    'telegram-continuation-session',
    'internal-profile-name',
  ]) assert.equal(serialized.includes(forbidden), false, `public history leaked ${forbidden}`);

  await bridge.listMessages('internal-profile-name', hermesHome, 'telegram', thread.id);
  assert.equal((dispatchDb.prepare('SELECT COUNT(*) AS count FROM channel_messages').get() as { count: number }).count, 4,
    'repeated message sync is idempotent');
  assert.equal(await bridge.listMessages('another-profile', hermesHome, 'telegram', thread.id), null,
    'opaque thread IDs are scoped to the selected profile');

  const unsupported = await bridge.listThreads('internal-profile-name', join(root, 'missing-hermes-home'), 'telegram');
  assert.deepEqual(unsupported, { state: 'awaiting_bridge', threads: [] });

  dispatchDb.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Hermes channel history bridge tests passed');