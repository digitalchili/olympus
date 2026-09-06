import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StreamEvent, BotMessageRespondRequest } from '../server/adapters/types.js';

const root = await mkdtemp(join(tmpdir(), 'olympus-bot-races-'));
process.env.HERMES_HOME = join(root, 'hermes');
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.DB_PATH = join(root, 'state.db');
await mkdir(join(root, 'hermes', 'profiles', 'writer'), { recursive: true });
await writeFile(join(root, 'hermes', 'config.yaml'), '{}\n');
await writeFile(join(root, 'hermes', 'profiles', 'writer', 'config.yaml'), '{}\n');
await writeFile(join(root, 'hermes', 'profiles', 'writer', 'profile.yaml'), 'displayName: Writer\n');
const { default: app, adapter, drainController } = await import('../server/app.js');
const q = await import('../server/db/bot-messages.js');
const { ensureBotTask } = await import('../server/db/bots.js');
const { getTask } = await import('../server/db/queries.js');
const { getRecovery, reconcileRecoveries, recoverRecoveryRecords } = await import('../server/run-recovery.js');
const { localProfileRegistry } = await import('../server/local-profiles.js');
const { hasActiveTaskRun, getActiveOperationCount } = await import('../server/task-run-lifecycle.js');
const { getRunStatus } = await import('../server/live-chat.js');
const a = ensureBotTask(localProfileRegistry.requireActive('default'));
const b = ensureBotTask(localProfileRegistry.requireActive('writer'));
const acks: BotMessageRespondRequest[] = [];
const starts: string[] = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Fixture did not reach expected state');
}
const idle = async () => waitFor(() => !hasActiveTaskRun(a.id) && !hasActiveTaskRun(b.id));
const emptyInventory = async () => ({ available: true, work: [] });
adapter.getBackgroundWork = emptyInventory;
adapter.getDefaults = async () => ({ model: null, provider: null, baseUrl: null, apiMode: null, reasoningEffort: 'medium', showReasoning: true });
adapter.getScheduledTaskDrainStatus = async () => ({ draining: false, activeRuns: 0 });
adapter.setScheduledTasksDraining = () => {};
adapter.respondBotMessage = async request => { acks.push(request); };
adapter.interruptChat = async () => true;
let stream: (sessionId: string, message: string) => AsyncIterable<StreamEvent> = async function* (sessionId) {
  yield { type: 'text_delta', content: 'Complete' };
  yield { type: 'done', sessionId };
};
adapter.chatStream = (sessionId, message) => { starts.push(message); return stream(sessionId, message); };
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const post = (path: string, body: unknown = {}, signal?: AbortSignal) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
});
const request = () => {
  const runId = randomUUID();
  q.beginBotRun(a.id, runId, Date.now() + 60_000);
  return q.enqueueBotMessage({ sender: a, recipient: b, runId, message: randomUUID() });
};
const deliver = (message: ReturnType<typeof request>, extra = {}) => post(`/api/tasks/${b.id}/messages?profile=writer`, {
  content: q.botDeliveryContent(message), botDeliveryId: message.id, ...extra,
});

try {
  await test('Stop rejects a late native request and retains ownership until stream settlement', async () => {
    const late = deferred(), finish = deferred();
    stream = async function* (sessionId) {
      await late.promise;
      yield { type: 'bot_message_requested', botMessage: { requestId: 'late', workerRunId: 'native', target: 'writer', message: 'Must not queue' } };
      await finish.promise;
      yield { type: 'done', sessionId };
    };
    try {
      assert.equal((await post(`/api/tasks/${a.id}/messages`, { content: 'Wait for Stop' })).status, 202);
      assert.equal((await post(`/api/tasks/${a.id}/interrupt`)).status, 200);
      assert.equal(getRunStatus(a.id)?.status, 'stopped');
      late.resolve();
      await waitFor(() => acks.some(ack => ack.requestId === 'late'));
      assert.equal(acks.find(ack => ack.requestId === 'late')?.result.accepted, false);
      assert.equal(q.listPendingBotMessages().length, 0);
      assert.equal((await post(`/api/tasks/${a.id}/messages`, { content: 'Too soon' })).status, 409);
    } finally { late.resolve(); finish.resolve(); await idle(); }
  });

  await test('cancellation during background admission leaves receipt unstarted', async () => {
    const message = request(), probe = deferred();
    let probing = false;
    adapter.getBackgroundWork = async () => { probing = true; await probe.promise; return emptyInventory(); };
    const before = starts.length;
    const pending = deliver(message);
    try {
      await waitFor(() => probing);
      assert.ok(getActiveOperationCount() > 0);
      assert.equal((await post(`/api/bots/messages/${message.id}/cancel`)).status, 200);
      probe.resolve();
      assert.equal((await pending).status, 409);
      assert.equal(q.getBotMessage(message.id)?.status, 'cancelled');
      assert.equal(starts.length, before);
    } finally { probe.resolve(); await pending; adapter.getBackgroundWork = emptyInventory; }
  });

  await test('human queue arriving during background admission wins over Bot delivery', async () => {
    const message = request(), probe = deferred();
    let probing = false;
    adapter.getBackgroundWork = async () => { probing = true; await probe.promise; return emptyInventory(); };
    const pending = deliver(message);
    const queueId = randomUUID();
    try {
      await waitFor(() => probing);
      const queued = await fetch(`${base}/api/tasks/${b.id}/queued-message?profile=writer`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: queueId, content: 'Human first', settings: { mode: 'task' }, invitedProfileIds: [] }),
      });
      assert.equal(queued.status, 200);
      probe.resolve();
      assert.equal((await pending).status, 409);
      assert.equal(q.getBotMessage(message.id)?.status, 'queued');
    } finally {
      probe.resolve(); await pending; adapter.getBackgroundWork = emptyInventory;
      await fetch(`${base}/api/tasks/${b.id}/queued-message/${queueId}?profile=writer`, { method: 'DELETE' });
      q.cancelBotChain(message.chainId);
    }
  });

  await test('recoverable incoming failure remains manual across recovery reconciliation', async () => {
    const message = request();
    stream = async function* () { yield { type: 'error', error: 'Worker restarted', code: 'worker_restarted' }; };
    assert.equal((await deliver(message)).status, 202);
    await idle();
    assert.equal(q.getBotMessage(message.id)?.status, 'failed');
    assert.equal(getRecovery(b.id)?.state, 'blocked');
    recoverRecoveryRecords();
    let recovered = 0;
    await reconcileRecoveries({ getBackgroundWork: async () => ({ available: true, work: [], continuation: { status: 'pending' } }) }, async () => { recovered++; });
    assert.equal(recovered, 0);
    q.cancelBotChain(message.chainId);
  });

  await test('receipt delivery cannot mutate recipient model or provider settings', async () => {
    const message = request();
    const before = getTask(b.id)!;
    stream = async function* (sessionId) { yield { type: 'done', sessionId }; };
    await deliver(message, { settings: { mode: 'task', model: 'untrusted-model', provider: 'untrusted-provider' } });
    await idle();
    try {
      assert.equal(getTask(b.id)?.agent_model, before.agent_model);
      assert.equal(getTask(b.id)?.agent_provider, before.agent_provider);
    } finally { q.cancelBotChain(message.chainId); }
  });

  await test('disconnected retry remains counted while interrupt acknowledgement is pending', async () => {
    const finish = deferred(), interrupted = deferred(), interruptAck = deferred();
    stream = async function* (sessionId) {
      yield { type: 'bot_message_requested', botMessage: { requestId: 'retry-source', workerRunId: 'native', target: 'writer', message: 'Retry after startup failure' } };
      await finish.promise;
      yield { type: 'done', sessionId };
    };
    adapter.interruptChat = async () => { interrupted.resolve(); await interruptAck.promise; return true; };
    const controller = new AbortController();
    let pending: Promise<Response | undefined> | undefined;
    let messageId: string | undefined;
    try {
      assert.equal((await post(`/api/tasks/${a.id}/messages`, { content: 'Source with queued child' })).status, 202);
      await waitFor(() => acks.some(ack => ack.requestId === 'retry-source'));
      messageId = acks.find(ack => ack.requestId === 'retry-source')!.result.messageId!;
      q.markBotMessageFailed(messageId, 'Recipient startup unavailable');
      pending = post(`/api/bots/messages/${messageId}/retry`, {}, controller.signal).catch(() => undefined);
      await interrupted.promise;
      finish.resolve(); await idle();
      controller.abort(); await pending;
      await new Promise(resolve => setTimeout(resolve, 25));
      drainController.begin();
      assert.ok((await drainController.refreshStatus()).activeRuns! > 0, 'retry still owns a pending queue mutation after its socket closes');
    } finally {
      drainController.cancel(); finish.resolve(); interruptAck.resolve();
      await pending; await idle(); adapter.interruptChat = async () => true;
      if (messageId) {
        await waitFor(() => q.getBotMessage(messageId!)?.status === 'queued');
        q.cancelBotChain(q.getBotMessage(messageId)!.chainId);
      }
    }
  });

  await test('cancelling a receipt also blocks its failed source automatic recovery', async () => {
    stream = async function* () {
      yield { type: 'bot_message_requested', botMessage: { requestId: 'failed-source', workerRunId: 'native', target: 'writer', message: 'Cancel before source recovery' } };
      yield { type: 'error', code: 'worker_restarted', error: 'Worker restarted' };
    };
    assert.equal((await post(`/api/tasks/${a.id}/messages`, { content: 'Source will fail after sending' })).status, 202);
    await idle();
    const messageId = acks.find(ack => ack.requestId === 'failed-source')!.result.messageId!;
    assert.equal(getRecovery(a.id)?.state, 'pending');
    assert.equal((await post(`/api/bots/messages/${messageId}/cancel?profile=writer`)).status, 200);
    assert.equal(q.getBotMessage(messageId)?.status, 'cancelled');
    assert.equal(getRecovery(a.id)?.state, 'blocked', 'cancelling from the recipient must not leave source recovery dispatchable');
  });

  await test('cancelling an old chain preserves a newer unrelated source run and recovery', async () => {
    const old = request(), finish = deferred();
    stream = async function* (sessionId) { await finish.promise; yield { type: 'done', sessionId }; };
    try {
      const started = await post(`/api/tasks/${a.id}/messages`, { content: 'New human conversation' });
      assert.equal(started.status, 202);
      const { runId } = await started.json();
      assert.equal((await post(`/api/bots/messages/${old.id}/cancel?profile=writer`)).status, 200);
      assert.equal(getRunStatus(a.id)?.runId, runId);
      assert.equal(getRunStatus(a.id)?.status, 'streaming');
      assert.equal(getRecovery(a.id)?.run_id, runId);
      assert.equal(getRecovery(a.id)?.state, 'running');
    } finally { finish.resolve(); await idle(); }
  });
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  (await import('../server/db/index.js')).default.close();
  await rm(root, { recursive: true, force: true });
}
