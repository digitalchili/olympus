import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-bots-task-routes-'));
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.HERMES_HOME = join(root, 'hermes');
process.env.DB_PATH = join(root, 'state', 'test.db');
for (const id of ['default', 'writer']) {
  const home = id === 'default' ? process.env.HERMES_HOME : join(process.env.HERMES_HOME, 'profiles', id);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.yaml'), '{}\n');
  await writeFile(join(home, 'profile.yaml'), `displayName: ${id}\nactive: true\n`);
}
const { default: app, adapter } = await import('../server/app.js');
const { ensureBotTask, getBotTask } = await import('../server/db/bots.js');
const { insertTask, getTask, recordAgentResponse } = await import('../server/db/queries.js');
const { putQueuedTaskMessage, getQueuedTaskMessage } = await import('../server/db/task-message-queue.js');
const { getRunStatus } = await import('../server/live-chat.js');
const { beginBotRun, getBotRun, enqueueBotMessage, getBotMessage } = await import('../server/db/bot-messages.js');
const { default: db } = await import('../server/db/index.js');
const bot = ensureBotTask({ id: 'default', label: 'Main Bot', workspaceDir: join(root, 'default-workspace') });
const writer = ensureBotTask({ id: 'writer', label: 'Writer Bot', workspaceDir: join(root, 'writer-workspace') });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const call = (path: string, method: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
try {
  const created = await call('tasks', 'POST', { kind: 'bot', title: 'Rogue bot', description: 'Bypass canonical chat' });
  assert.equal(created.status, 400, 'only Bot creation can create canonical chats');
  assert.equal(getBotTask('default')?.id, bot.id);
  for (const [method, suffix, body] of [
    ['DELETE', '', undefined], ['POST', '/move', { status: 'done' }],
    ['PATCH', '', { status: 'in_review' }], ['PATCH', '', { kind: 'task' }],
    ['PATCH', '', { handlingProfileId: 'writer' }], ['PATCH', '', { handling_profile_id: 'writer' }],
    ['PATCH', '', { profile_name: 'writer' }], ['PATCH', '', { projectId: 'project' }],
    ['PATCH', '', { project_id: 'project' }], ['PATCH', '', { workdir: null }],
  ] as const) {
    const response = await call(`tasks/${bot.id}${suffix}`, method, body);
    assert.equal(response.status, 409, `${method} ${JSON.stringify(body)} cannot replace Bot identity`);
    assert.equal((await response.json()).code, 'BOT_TASK_PERMANENT');
  }
  assert.equal((await call(`tasks/${bot.id}?profile=writer`, 'GET')).status, 404);
  const title = await call(`tasks/${bot.id}`, 'PATCH', { title: 'My assistant' });
  assert.equal(title.status, 200);
  assert.equal((await title.json()).task.title, 'My assistant');
  recordAgentResponse(bot.id, 123);
  const viewed = await call(`tasks/${bot.id}/viewed`, 'POST', {});
  assert.equal((await viewed.json()).task.last_viewed_at, 123);
  assert.equal(getTask(bot.id)?.status, 'in_progress');
  assert.equal((await (await call('tasks', 'GET')).json()).tasks.some((task: { id: string }) => task.id === bot.id), false);

  const ordinary = insertTask({ title: 'Ordinary', status: 'in_progress' });
  assert.equal((await call(`tasks/${ordinary.id}`, 'PATCH', { kind: 'bot' })).status, 409);
  assert.equal((await call(`tasks/${ordinary.id}/move`, 'POST', { status: 'done' })).status, 200);

  putQueuedTaskMessage({ taskId: writer.id, id: 'queued-bot', content: 'Remember this', settings: {}, invitedProfileIds: [], collaborationScope: 'once', confirmPersistentCollaboration: false, createdAt: 1, updatedAt: 1 });
  adapter.getBackgroundWork = async () => ({ available: true, work: [] });
  let entered = false;
  let finishRun!: () => void;
  adapter.chatStream = async function* () {
    entered = true;
    await new Promise<void>(resolve => { finishRun = resolve; });
    yield { type: 'error', message: 'Stopped for profile deletion' };
  };
  assert.equal((await call(`tasks/${writer.id}/messages?profile=writer`, 'POST', { content: 'Work until stopped' })).status, 202);
  for (let attempt = 0; attempt < 100 && !entered; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(entered, true);
  const runId = getRunStatus(writer.id)!.runId;
  if (!getBotRun(runId)) beginBotRun(writer.id, runId, Date.now() + 60_000);
  const outgoing = enqueueBotMessage({ sender: writer, recipient: bot, runId, message: 'Pending request from deleted profile' });
  let interrupted = false;
  adapter.interruptChat = async (taskId) => {
    assert.equal(taskId, writer.id);
    interrupted = true;
    finishRun();
    return true;
  };
  let evicted = false;
  let outgoingAtEviction: string | undefined;
  adapter.evictProfile = async (profileId) => {
    assert.equal(profileId, 'writer');
    assert.ok(getTask(writer.id), 'profile worker settles before Bot metadata is deleted');
    outgoingAtEviction = getBotMessage(outgoing.id)?.status;
    evicted = true;
  };
  const deletion = call('profiles/writer?profile=default', 'DELETE', { confirmation: 'writer' });
  for (let attempt = 0; attempt < 100 && !interrupted; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const cancelledBeforeIdle = interrupted;
  finishRun();
  const deleted = await deletion;
  const body = await deleted.json();
  assert.equal(deleted.status, 200, JSON.stringify(body));
  assert.equal(cancelledBeforeIdle, true, 'profile deletion must interrupt Bot work before waiting for idle');
  assert.equal(evicted, true);
  assert.equal(outgoingAtEviction, 'cancelled', 'outgoing Bot exchange is closed before profile eviction');
  assert.equal(body.deletedTaskCount, 1, 'Bot is part of the profile deletion snapshot');
  assert.equal(getTask(writer.id), undefined);
  assert.equal(getQueuedTaskMessage(writer.id), undefined);
  assert.equal(getRunStatus(writer.id), undefined);
  const backup = JSON.parse(await readFile(join(body.backupDir, 'olympus-profile-data.json'), 'utf8'));
  assert.equal(backup.tasks[0].id, writer.id);
  assert.equal(backup.tasks[0].kind, 'bot');
  assert.ok(getTask(bot.id), 'deleting one profile leaves other Bot chats intact');
} finally {
  server.close(); await once(server, 'close'); db.close();
  await rm(root, { recursive: true, force: true });
}
console.log('Permanent Bot task guards and profile deletion tests passed');
