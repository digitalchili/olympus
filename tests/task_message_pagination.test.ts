import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchMessages } from '../client/src/lib/api.js';
import { prependOlderMessages, type ChatMessage } from '../client/src/hooks/useChat.js';

const merged = prependOlderMessages(
  [
    { id: 'current-1', role: 'user', content: 'current user', created_at: 3 },
    { id: 'current-2', role: 'assistant', content: 'current assistant', created_at: 4 },
  ] as ChatMessage[],
  [
    { id: 'older-1', role: 'user', content: 'older user', created_at: 1 },
    { id: 'older-2', role: 'assistant', content: 'older assistant', created_at: 2 },
    { id: 'current-1', role: 'user', content: 'duplicate boundary', created_at: 3 },
  ] as ChatMessage[],
);
assert.deepEqual(merged.map((message) => message.id), ['older-1', 'older-2', 'current-1', 'current-2']);

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let requestedUrl = '';
try {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { search: '?profile=writer' } },
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      messages: [],
      pageInfo: { hasOlder: false, olderCursor: null },
      context: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  await fetchMessages('task-1', 'cursor/value');
  assert.equal(
    requestedUrl,
    '/api/tasks/task-1/messages?limit=40&before=cursor%2Fvalue&profile=writer',
    'message pages must retain the selected profile and encode the older cursor',
  );
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}

const taskChatSource = await readFile('client/src/components/TaskChat.tsx', 'utf8');
assert.match(taskChatSource, /Load older messages/);
assert.match(taskChatSource, /await loadOlderMessages\(taskId\)/);
assert.match(taskChatSource, /current\.scrollTop = previousTop \+ current\.scrollHeight - previousHeight/);
assert.match(taskChatSource, /olderMessagesError/);

const root = await mkdtemp(join(tmpdir(), 'olympus-message-pages-'));
const hermesHome = join(root, 'hermes');
const writerHome = join(hermesHome, 'profiles', 'writer');
const dispatchHome = join(root, 'dispatch');
const previousHermesHome = process.env.HERMES_HOME;
const previousDispatchHome = process.env.OLYMPUS_DISPATCH_HOME;
const previousDbPath = process.env.DB_PATH;

try {
  await mkdir(writerHome, { recursive: true });
  await writeFile(join(hermesHome, 'config.yaml'), '{}\n');
  await writeFile(join(writerHome, 'profile.yaml'), 'displayName: Writer\n');
  await writeFile(join(writerHome, 'config.yaml'), '{}\n');
  process.env.HERMES_HOME = hermesHome;
  process.env.OLYMPUS_DISPATCH_HOME = dispatchHome;
  process.env.DB_PATH = join(dispatchHome, 'data', 'test.db');

  const [{ default: app, adapter }, queries, { default: db }] = await Promise.all([
    import('../server/app.js'),
    import('../server/db/queries.js'),
    import('../server/db/index.js'),
  ]);

  const defaultTask = queries.insertTask({
    title: 'Default history',
    status: 'in_progress',
    profile_name: 'default',
    last_agent_response_at: Date.now(),
  });
  const legacyDefaultTask = queries.insertTask({
    title: 'Legacy default history',
    status: 'in_progress',
    profile_name: null,
    last_agent_response_at: Date.now(),
  });
  const writerTask = queries.insertTask({
    title: 'Writer history',
    status: 'in_progress',
    profile_name: 'writer',
    last_agent_response_at: Date.now(),
  });
  const emptyTask = queries.insertTask({
    title: 'No session yet',
    status: 'in_progress',
    profile_name: 'default',
  });

  const calls: Array<{ sessionId: string; taskId: string; options: { limit: number; before?: string | null } }> = [];
  adapter.getMessagePage = async (sessionId, taskId, options) => {
    calls.push({ sessionId, taskId, options });
    return {
      messages: [{ id: `${taskId}-tail`, task_id: taskId, role: 'assistant', content: `tail:${taskId}`, created_at: 1 }],
      pageInfo: { hasOlder: true, olderCursor: 'next-cursor' },
    };
  };

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/tasks`;

  try {
    const defaultResponse = await fetch(`${base}/${defaultTask.id}/messages?profile=default&limit=2&before=older`);
    assert.equal(defaultResponse.status, 200);
    const defaultPage = await defaultResponse.json() as { messages: ChatMessage[]; pageInfo: { hasOlder: boolean; olderCursor: string | null } };
    assert.equal(defaultPage.messages[0]?.content, `tail:${defaultTask.id}`);
    assert.deepEqual(defaultPage.pageInfo, { hasOlder: true, olderCursor: 'next-cursor' });
    assert.deepEqual(calls.at(-1)?.options, { limit: 2, before: 'older' });

    const legacyResponse = await fetch(`${base}/${legacyDefaultTask.id}/messages?profile=default`);
    assert.equal(legacyResponse.status, 200, 'legacy null-profile tasks remain visible in the default profile');
    assert.deepEqual(calls.at(-1)?.options, { limit: 40, before: null });

    const crossToWriter = await fetch(`${base}/${defaultTask.id}/messages?profile=writer`);
    assert.equal(crossToWriter.status, 404);
    const crossToDefault = await fetch(`${base}/${writerTask.id}/messages?profile=default`);
    assert.equal(crossToDefault.status, 404);

    const writerResponse = await fetch(`${base}/${writerTask.id}/messages?profile=writer`);
    assert.equal(writerResponse.status, 200);
    assert.equal(calls.at(-1)?.taskId, writerTask.id);

    const callsBeforeEmpty = calls.length;
    const emptyResponse = await fetch(`${base}/${emptyTask.id}/messages?profile=default`);
    assert.equal(emptyResponse.status, 200);
    assert.deepEqual(await emptyResponse.json(), {
      messages: [],
      pageInfo: { hasOlder: false, olderCursor: null },
      context: null,
    });
    assert.equal(calls.length, callsBeforeEmpty, 'tasks without a Hermes session do not start a worker page read');

    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'before=']) {
      const response = await fetch(`${base}/${defaultTask.id}/messages?profile=default&${query}`);
      assert.equal(response.status, 400, `invalid page query must be rejected: ${query}`);
    }
    assert.equal((await fetch(`${base}/${defaultTask.id}/messages?profile=missing`)).status, 400);
  } finally {
    server.close();
    await once(server, 'close');
    db.close();
  }
} finally {
  if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = previousHermesHome;
  if (previousDispatchHome === undefined) delete process.env.OLYMPUS_DISPATCH_HOME;
  else process.env.OLYMPUS_DISPATCH_HOME = previousDispatchHome;
  if (previousDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = previousDbPath;
  await rm(root, { recursive: true, force: true });
}

console.log('Task message pagination tests passed');
