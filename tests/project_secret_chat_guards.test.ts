import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'olympus-secret-chat-guards-'));
const hermes = join(root, 'hermes'); await mkdir(hermes);
await writeFile(join(hermes, 'config.yaml'), '{}\n');
await writeFile(join(hermes, 'profile.yaml'), 'displayName: Default\nactive: true\n');
process.env.HERMES_HOME = hermes;
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'test.db');
const { default: app, adapter } = await import('../server/app.js');
const { default: db } = await import('../server/db/index.js');
const { insertTask } = await import('../server/db/queries.js');
const { getQueuedTaskMessage } = await import('../server/db/task-message-queue.js');
const { getRunStatus, discardRun } = await import('../server/live-chat.js');
const received: string[] = [], steered: string[] = [], tasks: string[] = [];
let release!: () => void;
const running = new Promise<void>(resolve => { release = resolve; });
adapter.getBackgroundWork = async () => ({ available: true, work: [], continuation: { status: 'none' } });
adapter.chatStream = async function* (_sessionId, content) {
  received.push(content); yield { type: 'text_delta', content: 'Working' }; await running; yield { type: 'done' };
};
adapter.steerChat = async (_taskId, content) => { steered.push(content); return true; };
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}/api/tasks`;
const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
try {
  for (const content of ['API_KEY=example-from-documentation', 'DATABASE_URL=postgres://example:example@localhost/test', 'Explain this: TOKEN=example', '/secrets\nEXAMPLE=still-normal-chat']) {
    const task = insertTask({ title: 'Ordinary pasted text', status: 'in_progress', profile_name: 'default' });
    tasks.push(task.id);
    const sent = await fetch(`${base}/${task.id}/messages?profile=default`, json('POST', { content }));
    assert.equal(sent.status, 202, await sent.text());
    assert.equal(received.at(-1), content, 'ordinary message reaches the worker unchanged');
    assert.equal(getRunStatus(task.id)?.status, 'streaming');
    const queued = await fetch(`${base}/${task.id}/queued-message?profile=default`, json('PUT', {
      id: 'queued-' + task.id, content, settings: { mode: 'task' }, invitedProfileIds: [], collaborationScope: 'discussion',
    }));
    assert.equal(queued.status, 200, await queued.text());
    assert.equal(getQueuedTaskMessage(task.id)?.content, content, 'queue preserves the original text');
    const steer = await fetch(`${base}/${task.id}/steer?profile=default`, json('POST', { content }));
    assert.equal(steer.status, 200); assert.deepEqual(await steer.json(), { steered: true, queued: false });
    assert.equal(steered.at(-1), content, 'steering is not intercepted by secret detection');
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM project_secrets').get() as any).count, 0, 'ordinary text never creates saved secrets');
} finally {
  release();
  await new Promise(resolve => setTimeout(resolve, 50));
  tasks.forEach(discardRun);
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await adapter.stop(); db.close(); await rm(root, { recursive: true, force: true });
}
console.log('Normal chat, queued input and steering never infer secret entry');
