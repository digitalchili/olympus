import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-bot-queue-'));
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = join(root, 'state.db');
await mkdir(join(root, 'workspace'));
try {
  const { insertTask } = await import('../server/db/queries.js');
  const queue = await import('../server/db/bot-messages.js');
  const sender = insertTask({ title: 'Writer', status: 'in_progress', kind: 'bot', profile_name: 'writer' });
  const recipient = insertTask({ title: 'Reviewer', status: 'in_progress', kind: 'bot', profile_name: 'reviewer' });
  queue.beginBotRun(sender.id, 'source-run', Date.now() + 60_000);
  const first = queue.enqueueBotMessage({ sender, recipient, runId: 'source-run', message: 'Review `$(literal)` safely' });
  const duplicate = queue.enqueueBotMessage({ sender, recipient, runId: 'source-run', message: 'Review `$(literal)` safely' });
  assert.equal(first.id, duplicate.id, 'same source-run send has one durable receipt');
  assert.equal(queue.listPendingBotMessages().length, 1);
  queue.beginBotRun(recipient.id, 'recipient-run', Date.now() + 60_000, first.id);
  assert.equal(queue.getBotMessage(first.id)?.status, 'running');
  queue.finishBotRun('recipient-run', 'done', 'Review complete');
  queue.finishBotRun('recipient-run', 'done', 'Duplicate completion');
  assert.equal(queue.getBotMessage(first.id)?.status, 'completed');
  const replies = queue.listPendingBotMessages();
  assert.equal(replies.length, 1, 'completion queues precisely one reply');
  assert.equal(replies[0].kind, 'reply');
  assert.equal(replies[0].recipientTaskId, sender.id);
  assert.equal(replies[0].message, 'Review complete');
  queue.beginBotRun(sender.id, 'reply-run', Date.now() + 60_000, replies[0].id);
  queue.finishBotRun('reply-run', 'done', 'Thanks');
  assert.equal(queue.listPendingBotMessages().length, 0, 'reply turns do not ping-pong');

  queue.beginBotRun(sender.id, 'stopped-source', Date.now() + 60_000);
  const stopped = queue.enqueueBotMessage({ sender, recipient, runId: 'stopped-source', message: 'Stop this exchange' });
  queue.beginBotRun(recipient.id, 'stopped-recipient', Date.now() + 60_000, stopped.id);
  queue.cancelBotChain(stopped.chainId);
  queue.finishBotRun('stopped-recipient', 'done', 'Too late');
  assert.equal(queue.getBotMessage(stopped.id)?.status, 'cancelled');
  assert.equal(queue.listPendingBotMessages().length, 0, 'late completion cannot revive a stopped chain');
  assert.throws(() => queue.enqueueBotMessage({ sender, recipient, runId: 'stopped-source', message: 'Late tool call' }), /cancelled/i);

  queue.beginBotRun(sender.id, 'restarted-source', Date.now() + 60_000);
  const interrupted = queue.enqueueBotMessage({ sender, recipient, runId: 'restarted-source', message: 'In flight at restart' });
  const pending = queue.enqueueBotMessage({ sender, recipient, runId: 'restarted-source', message: 'Waiting at restart' });
  queue.beginBotRun(recipient.id, 'interrupted-run', Date.now() + 60_000, interrupted.id);
  queue.recoverBotMessages();
  assert.equal(queue.getBotMessage(interrupted.id)?.status, 'interrupted');
  assert.equal(queue.getBotMessage(pending.id)?.status, 'queued');
  queue.retryBotMessage(interrupted.id);
  assert.equal(queue.getBotMessage(interrupted.id)?.status, 'queued');
  assert.throws(() => queue.retryBotMessage(first.id), /retry/i);

  queue.beginBotRun(sender.id, 'bounded-source', Date.now() + 60_000);
  for (let i = 0; i < 10; i++) queue.enqueueBotMessage({ sender, recipient, runId: 'bounded-source', message: `Bounded ${i}` });
  assert.throws(() => queue.enqueueBotMessage({ sender, recipient, runId: 'bounded-source', message: 'Too many' }), /limit/i);
  assert.throws(() => queue.enqueueBotMessage({ sender, recipient: sender, runId: 'source-run', message: 'Self' }), /itself/i);
  console.log('Bot queue persistence, replies, restart, cancellation and limits passed');
  (await import('../server/db/index.js')).default.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
