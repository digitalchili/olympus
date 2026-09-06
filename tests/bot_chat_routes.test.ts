import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunOptions, StreamEvent } from '../server/adapters/types.js';
import type { Task } from '../shared/types.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-bot-routes-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'state.db');
await mkdir(join(root, 'hermes', 'profiles', 'writer'), { recursive: true });
await writeFile(join(root, 'hermes', 'config.yaml'), '{}\n');
await writeFile(join(root, 'hermes', 'profiles', 'writer', 'config.yaml'), '{}\n');
await writeFile(join(root, 'hermes', 'profiles', 'writer', 'profile.yaml'), 'displayName: Writer\n');
const { default: app, adapter, drainController } = await import('../server/app.js');
const queue = await import('../server/db/bot-messages.js');
const { hasActiveTaskRun } = await import('../server/task-run-lifecycle.js');
const { getTask, getAllTasks, insertTask } = await import('../server/db/queries.js');
const requests: Array<{ sessionId: string; message: string; options?: AgentRunOptions }> = [];
const acknowledgements: Array<{ accepted: boolean; messageId?: string }> = [];
adapter.getBackgroundWork = async () => ({ available: true, work: [] });
adapter.getDefaults = async () => ({ model: null, provider: null, baseUrl: null, apiMode: null, reasoningEffort: 'medium', showReasoning: true });
adapter.getScheduledTaskDrainStatus = async () => ({ draining: false, activeRuns: 0 });
adapter.setScheduledTasksDraining = () => {};
adapter.respondBotMessage = async request => { acknowledgements.push(request.result); };
adapter.chatStream = async function* (sessionId, message, options): AsyncIterable<StreamEvent> {
  requests.push({ sessionId, message, options });
  if (message === 'Ask writer for a review' || message === 'Regular task must not message') {
    yield { type: 'bot_message_requested', botMessage: { requestId: 'request', workerRunId: 'worker', target: 'writer', message: 'Please review `$(literal)`' } };
  }
  yield { type: 'text_delta', content: options?.bot?.profileId === 'writer' ? 'Writer review complete' : 'Here is the update' };
  yield { type: 'done', sessionId, context: null };
};
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const post = (path: string, body: unknown = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function settled(taskId: string) {
  for (let i = 0; i < 100 && hasActiveTaskRun(taskId); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(hasActiveTaskRun(taskId), false);
}
try {
  const open = await post('/api/bots/session?profile=default');
  assert.equal(open.status, 200, await open.clone().text());
  const bot = (await open.json()).task as Task;
  const second = await post('/api/bots/session?profile=default');
  assert.equal((await second.json()).task.id, bot.id);
  assert.equal(bot.kind, 'bot');
  assert.equal(getAllTasks().length, 0);
  assert.equal((await post(`/api/tasks/${bot.id}/messages?profile=default`, { content: 'Ask writer for a review' })).status, 202);
  await settled(bot.id);
  assert.equal(acknowledgements[0].accepted, true);
  const first = queue.listPendingBotMessages()[0];
  assert.equal(first.senderTaskId, bot.id);
  assert.equal(first.recipientProfileId, 'writer');
  assert.equal(getTask(bot.id)?.status, 'in_progress', 'Bot replies never enter Kanban review');
  assert.equal(requests[0].options?.bot?.profileId, 'default');
  assert.match(requests[0].options?.systemMessage ?? '', /untrusted advisory/);

  drainController.begin();
  const paused = await post(`/api/tasks/${first.recipientTaskId}/messages?profile=writer`, { content: queue.botDeliveryContent(first), botDeliveryId: first.id });
  assert.equal(paused.status, 503);
  assert.equal(queue.getBotMessage(first.id)?.status, 'queued');
  drainController.cancel();
  const deliver = await post(`/api/tasks/${first.recipientTaskId}/messages?profile=writer`, { content: queue.botDeliveryContent(first), botDeliveryId: first.id });
  assert.equal(deliver.status, 202, await deliver.clone().text());
  await settled(first.recipientTaskId);
  assert.equal(queue.getBotMessage(first.id)?.status, 'completed');
  assert.equal(requests[1].options?.bot?.profileId, 'writer');
  assert.match(requests[1].message, /Message from/);
  assert.match(requests[1].message, /`\$\(literal\)`/);
  const reply = queue.listPendingBotMessages()[0];
  assert.equal(reply.kind, 'reply');
  const receive = await post(`/api/tasks/${bot.id}/messages?profile=default`, { content: queue.botDeliveryContent(reply), botDeliveryId: reply.id });
  assert.equal(receive.status, 202);
  await settled(bot.id);
  assert.equal(queue.listPendingBotMessages().length, 0);
  assert.equal(requests.length, 3, 'one request, recipient turn and correlated reply turn');
  assert.equal(getAllTasks().length, 0);
  assert.equal((await post(`/api/tasks/${bot.id}/messages?profile=default`, { content: 'Goal', settings: { mode: 'goal' } })).status, 400);
  assert.equal((await post(`/api/tasks/${bot.id}/messages?profile=default`, { content: 'Invite', invitedProfileIds: ['writer'] })).status, 400);
  assert.equal((await post(`/api/tasks/${bot.id}/verification?profile=default`)).status, 400);
  assert.equal((await post(`/api/tasks/${bot.id}/messages?profile=writer`, { content: 'Cross profile' })).status, 404);
  const normal = insertTask({ title: 'Task', status: 'in_progress' });
  assert.equal((await post(`/api/tasks/${normal.id}/messages?profile=default`, { content: 'Regular task must not message' })).status, 202);
  await settled(normal.id);
  assert.equal(acknowledgements.at(-1)?.accepted, false);
  assert.equal(queue.listPendingBotMessages().length, 0);
  console.log('Canonical Bot chat, native send acknowledgement, attributed reply, drain and task boundaries passed');
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  (await import('../server/db/index.js')).default.close();
  await rm(root, { recursive: true, force: true });
}
