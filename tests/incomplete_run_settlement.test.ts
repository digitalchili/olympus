import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamEvent } from '../server/adapters/types.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-incomplete-run-settlement-'));
const hermesHome = join(root, 'hermes');
const dispatchHome = join(root, 'dispatch');
await mkdir(hermesHome, { recursive: true });
await writeFile(join(hermesHome, 'config.yaml'), '{}\n');
process.env.HERMES_HOME = hermesHome;
process.env.OLYMPUS_DISPATCH_HOME = dispatchHome;
process.env.DB_PATH = join(dispatchHome, 'data', 'test.db');

const [{ default: app, adapter }, queries, liveChat, { default: db }] = await Promise.all([
  import('../server/app.js'),
  import('../server/db/queries.js'),
  import('../server/live-chat.js'),
  import('../server/db/index.js'),
]);

const errorTask = queries.insertTask({ title: 'Partial error', status: 'in_progress', profile_name: 'default' });
const stoppedTask = queries.insertTask({ title: 'Partial stopped', status: 'in_progress', profile_name: 'default' });
const doneTask = queries.insertTask({ title: 'Completed', status: 'in_progress', profile_name: 'default' });
const originalChatStream = adapter.chatStream;
adapter.chatStream = async function* (sessionId, content): AsyncIterable<StreamEvent> {
  yield { type: 'text_delta', content: `Partial output for ${content}` };
  if (content === 'error') {
    yield { type: 'error', code: 'iteration_limit', error: 'internal iteration details' };
    return;
  }
  yield { type: 'done', sessionId, interrupted: content === 'stopped', context: null };
};

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

async function run(taskId: string, content: string): Promise<void> {
  const response = await fetch(`${base}/api/tasks/${taskId}/messages?profile=default`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  assert.equal(response.status, 202);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = liveChat.getRunStatus(taskId)?.status;
    if (status === 'done' || status === 'error' || status === 'stopped') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`run ${taskId} did not settle`);
}

try {
  await run(errorTask.id, 'error');
  assert.equal(queries.getTask(errorTask.id)?.status, 'in_progress', 'partial error runs remain actionable');
  assert.equal(liveChat.getRun(errorTask.id)?.status, 'error');
  assert.match(liveChat.getRun(errorTask.id)?.messages.at(-1)?.content ?? '', /Run stopped before completion/);
  assert.doesNotMatch(liveChat.getRun(errorTask.id)?.messages.at(-1)?.content ?? '', /internal iteration details/);

  await run(stoppedTask.id, 'stopped');
  assert.equal(queries.getTask(stoppedTask.id)?.status, 'in_progress', 'partial stopped/cancelled runs remain actionable');
  assert.equal(liveChat.getRun(stoppedTask.id)?.status, 'stopped');
  assert.match(liveChat.getRun(stoppedTask.id)?.messages.at(-1)?.content ?? '', /Run stopped before completion/);

  await run(doneTask.id, 'done');
  assert.equal(queries.getTask(doneTask.id)?.status, 'in_review', 'genuinely completed runs still move to review');
  assert.equal(liveChat.getRun(doneTask.id)?.status, 'done');
} finally {
  adapter.chatStream = originalChatStream;
  server.close();
  await once(server, 'close');
  db.close();
  await rm(root, { recursive: true, force: true });
}

console.log('Incomplete run settlement route tests passed');
