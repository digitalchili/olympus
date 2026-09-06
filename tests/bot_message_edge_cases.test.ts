import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = await mkdtemp(join(tmpdir(), 'olympus-bot-edges-'));
process.env.DB_PATH = join(root, 'test.db');
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.HERMES_HOME = join(root, 'hermes');
const { insertTask } = await import('../server/db/queries.js');
const { default: db } = await import('../server/db/index.js');
const q = await import('../server/db/bot-messages.js');
const bot = (label: string) => insertTask({ title: label, status: 'in_progress', kind: 'bot', profile_name: randomUUID() });
const begin = (taskId: string, deliveryId?: string, previous?: string) => {
  const runId = randomUUID();
  q.beginBotRun(taskId, runId, Date.now() + 60_000, deliveryId, previous);
  return runId;
};

try {
await test('recovered source run shares deduplication and original chain deadline', () => {
  const a = bot('Recovery sender'), b = bot('Recovery recipient');
  const firstRun = begin(a.id);
  const first = q.enqueueBotMessage({ sender: a, recipient: b, runId: firstRun, message: 'Inspect once' });
  const recoveredRun = begin(a.id, undefined, firstRun);
  const duplicate = q.enqueueBotMessage({ sender: a, recipient: b, runId: recoveredRun, message: '  Inspect once  ' });
  assert.equal(duplicate.id, first.id);
  assert.equal(q.getBotRun(recoveredRun)?.deadlineAt, q.getBotRun(firstRun)?.deadlineAt);
});

await test('three hops cannot be extended and expired chains reject new delivery starts', () => {
  const bots = [bot('Depth a'), bot('Depth b'), bot('Depth c'), bot('Depth d')];
  let runId = begin(bots[0].id);
  let last!: ReturnType<typeof q.enqueueBotMessage>;
  for (let depth = 1; depth <= 3; depth++) {
    last = q.enqueueBotMessage({ sender: bots[depth - 1], recipient: bots[depth], runId, message: `Hop ${depth}` });
    runId = begin(bots[depth].id, last.id);
  }
  assert.throws(() => q.enqueueBotMessage({ sender: bots[3], recipient: bots[0], runId, message: 'Fourth hop' }), /limit/i);
  const sourceRun = begin(bots[0].id);
  const expires = q.enqueueBotMessage({ sender: bots[0], recipient: bots[1], runId: sourceRun, message: 'Expired' });
  db.prepare('UPDATE bot_chains SET deadline_at=? WHERE id=?').run(Date.now() - 1, expires.chainId);
  assert.throws(() => begin(bots[1].id, expires.id), /time limit/i);
  assert.throws(() => q.enqueueBotMessage({ sender: bots[0], recipient: bots[2], runId: sourceRun, message: 'Late' }), /time limit/i);
});

await test('manual retry retires descendants from the interrupted attempt', () => {
  const a = bot('Retry sender'), b = bot('Retry recipient'), c = bot('Old child');
  const sourceRun = begin(a.id);
  const original = q.enqueueBotMessage({ sender: a, recipient: b, runId: sourceRun, message: 'Coordinate review' });
  const recipientRun = begin(b.id, original.id);
  const child = q.enqueueBotMessage({ sender: b, recipient: c, runId: recipientRun, message: 'Inspect files' });
  q.recoverBotMessages();
  const retried = q.retryBotMessage(original.id);
  assert.notEqual(retried.chainId, original.chainId);
  assert.equal(q.getBotMessage(child.id)?.status, 'cancelled', 'the previous attempt must not keep dispatching after explicit retry');
  assert.throws(() => q.enqueueBotMessage({ sender: b, recipient: c, runId: recipientRun, message: 'Late old tool call' }), /cancelled/i);
});

await test('stale completion cannot finish a retried message or duplicate its reply', () => {
  const a = bot('Reply sender'), b = bot('Reply recipient');
  const request = q.enqueueBotMessage({ sender: a, recipient: b, runId: begin(a.id), message: 'Answer' });
  const oldRun = begin(b.id, request.id);
  q.recoverBotMessages();
  q.retryBotMessage(request.id);
  const newRun = begin(b.id, request.id);
  q.finishBotRun(oldRun, 'done', 'Stale answer');
  assert.equal(q.getBotMessage(request.id)?.status, 'running');
  q.finishBotRun(newRun, 'done', 'Current answer');
  q.finishBotRun(newRun, 'done', 'Duplicate answer');
  const replies = q.listBotMessages(a.profile_name!).filter(message => message.replyTo === request.id);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].message, 'Current answer');
  q.cancelBotChain(replies[0].chainId);
  assert.equal(q.getBotMessage(replies[0].id)?.status, 'cancelled');
  q.finishBotRun(newRun, 'done', 'Late answer after Stop');
  assert.equal(q.getBotMessage(replies[0].id)?.status, 'cancelled');
});

} finally { db.close(); await rm(root, { recursive: true, force: true }); }
