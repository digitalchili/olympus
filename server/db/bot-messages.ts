import { randomUUID } from 'node:crypto';
import db from './index.js';
import type { BotMessage, Task } from '../../shared/types.js';

export interface BotDelivery extends BotMessage {
  senderTaskId: string;
  recipientTaskId: string;
  sourceRunId: string;
  chainId: string;
  depth: number;
  runId: string | null;
  replyTo: string | null;
}

export interface BotRunContext {
  runId: string;
  taskId: string;
  chainId: string;
  depth: number;
  deliveryId: string | null;
  deadlineAt: number;
  cancelled: number;
}

const columns = `id, sender_task_id AS senderTaskId, recipient_task_id AS recipientTaskId,
  sender_profile_id AS senderProfileId, recipient_profile_id AS recipientProfileId,
  sender_label AS senderLabel, recipient_label AS recipientLabel, source_run_id AS sourceRunId,
  chain_id AS chainId, depth, kind, message, status, run_id AS runId, reply_to AS replyTo,
  error, created_at AS createdAt, updated_at AS updatedAt`;

export function getBotMessage(id: string): BotDelivery | undefined {
  return db.prepare(`SELECT ${columns} FROM bot_messages WHERE id = ?`).get(id) as BotDelivery | undefined;
}

export function listBotMessages(profileId: string): BotDelivery[] {
  return db.prepare(`SELECT ${columns} FROM bot_messages WHERE sender_profile_id = ? OR recipient_profile_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 100`).all(profileId, profileId) as BotDelivery[];
}

export function listPendingBotMessages(): BotDelivery[] {
  return db.prepare(`SELECT ${columns} FROM bot_messages WHERE status = 'queued' ORDER BY created_at, rowid`).all() as BotDelivery[];
}

export function getBotRun(runId: string): BotRunContext | undefined {
  return db.prepare(`SELECT r.run_id AS runId, r.task_id AS taskId, r.chain_id AS chainId,
    r.depth, r.delivery_id AS deliveryId, c.deadline_at AS deadlineAt, c.cancelled
    FROM bot_run_contexts r JOIN bot_chains c ON c.id = r.chain_id WHERE r.run_id = ?`).get(runId) as BotRunContext | undefined;
}

function requireActiveChain(chainId: string): { deadlineAt: number } {
  const chain = db.prepare('SELECT deadline_at AS deadlineAt, cancelled FROM bot_chains WHERE id = ?')
    .get(chainId) as { deadlineAt: number; cancelled: number } | undefined;
  if (!chain || chain.cancelled) throw new Error('This Bot exchange was cancelled');
  if (chain.deadlineAt <= Date.now()) throw new Error('This Bot exchange reached its time limit');
  return chain;
}

export function beginBotRun(taskId: string, runId: string, deadlineAt: number, deliveryId?: string, recoveryOfRunId?: string): BotRunContext {
  return db.transaction(() => {
    const delivery = deliveryId ? getBotMessage(deliveryId) : undefined;
    const previous = recoveryOfRunId ? getBotRun(recoveryOfRunId) : undefined;
    if (deliveryId && (!delivery || delivery.recipientTaskId !== taskId || delivery.status !== 'queued')) {
      throw new Error('Bot delivery was changed or already started');
    }
    if (recoveryOfRunId && (!previous || previous.taskId !== taskId || previous.deliveryId)) {
      throw new Error('Interrupted Bot deliveries require an explicit message retry');
    }
    const chainId = delivery?.chainId ?? previous?.chainId ?? runId;
    if (delivery || previous) requireActiveChain(chainId);
    else db.prepare('INSERT INTO bot_chains (id, deadline_at) VALUES (?, ?)').run(chainId, deadlineAt);
    db.prepare('INSERT INTO bot_run_contexts (run_id, task_id, chain_id, depth, delivery_id) VALUES (?, ?, ?, ?, ?)')
      .run(runId, taskId, chainId, delivery?.depth ?? previous?.depth ?? 0, deliveryId ?? null);
    if (delivery) db.prepare("UPDATE bot_messages SET status = 'running', run_id = ?, updated_at = ? WHERE id = ?")
      .run(runId, Date.now(), delivery.id);
    return getBotRun(runId)!;
  })();
}

export function enqueueBotMessage(input: { sender: Task; recipient: Task; runId: string; message: string }): BotDelivery {
  return db.transaction(() => {
    const { sender, recipient, runId } = input;
    if (sender.kind !== 'bot' || recipient.kind !== 'bot') throw new Error('Messaging requires canonical Bot conversations');
    if (sender.id === recipient.id) throw new Error('A Bot cannot message itself');
    const context = getBotRun(runId);
    if (!context || context.taskId !== sender.id) throw new Error('Bot sender does not own this run');
    requireActiveChain(context.chainId);
    const message = input.message.trim();
    if (!message || message.length > 12_000) throw new Error('Bot messages must contain 1–12000 characters');
    const duplicate = db.prepare(`SELECT ${columns} FROM bot_messages WHERE chain_id = ? AND sender_task_id = ? AND recipient_task_id = ? AND kind = 'request' AND message = ?`)
      .get(context.chainId, sender.id, recipient.id, message) as BotDelivery | undefined;
    if (duplicate) return duplicate;
    const requests = db.prepare("SELECT COUNT(*) AS count FROM bot_messages WHERE chain_id = ? AND kind = 'request'")
      .get(context.chainId) as { count: number };
    if (context.depth >= 3 || requests.count >= 10) throw new Error('Bot exchange limit reached (three hops and ten messages)');
    const pending = db.prepare("SELECT COUNT(*) AS count FROM bot_messages WHERE recipient_task_id = ? AND status IN ('queued', 'running')")
      .get(recipient.id) as { count: number };
    if (pending.count >= 50) throw new Error('This Bot inbox has reached its pending message limit');
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO bot_messages (id, sender_task_id, recipient_task_id, sender_profile_id, recipient_profile_id,
      sender_label, recipient_label, source_run_id, chain_id, depth, kind, message, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'request', ?, 'queued', ?, ?)`).run(
      id, sender.id, recipient.id, sender.handling_profile_id ?? sender.profile_name ?? 'default',
      recipient.handling_profile_id ?? recipient.profile_name ?? 'default', sender.title, recipient.title,
      runId, context.chainId, context.depth + 1, message, now, now,
    );
    return getBotMessage(id)!;
  })();
}

export function finishBotRun(runId: string, status: string, response: string, error?: string): void {
  db.transaction(() => {
    const context = getBotRun(runId);
    if (!context?.deliveryId) return;
    const delivery = getBotMessage(context.deliveryId);
    if (!delivery || delivery.runId !== runId || delivery.status !== 'running') return;
    if (context.cancelled) {
      db.prepare("UPDATE bot_messages SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), delivery.id);
      return;
    }
    const completed = status === 'done';
    const next = completed ? 'completed' : status === 'stopped' ? 'interrupted' : 'failed';
    const now = Date.now();
    db.prepare('UPDATE bot_messages SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(next, completed ? null : (error || 'The Bot turn did not complete. Review it before retrying.').slice(0, 1000), now, delivery.id);
    if (!completed || delivery.kind !== 'request') return;
    db.prepare(`INSERT OR IGNORE INTO bot_messages (id, sender_task_id, recipient_task_id, sender_profile_id, recipient_profile_id,
      sender_label, recipient_label, source_run_id, chain_id, depth, kind, message, status, reply_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reply', ?, 'queued', ?, ?, ?)`).run(
      randomUUID(), delivery.recipientTaskId, delivery.senderTaskId, delivery.recipientProfileId, delivery.senderProfileId,
      delivery.recipientLabel, delivery.senderLabel, runId, delivery.chainId, delivery.depth,
      response.trim().slice(0, 24_000) || 'The Bot completed its turn without a text reply.', delivery.id, now, now,
    );
  })();
}

export function markBotMessageFailed(id: string, error: string): void {
  db.prepare("UPDATE bot_messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
    .run(error.slice(0, 1000), Date.now(), id);
}

export function recoverBotMessages(): void {
  db.prepare(`UPDATE bot_messages SET status = 'interrupted', error = 'Olympus restarted during delivery. Review the conversation before retrying.', updated_at = ?
    WHERE status = 'running'`).run(Date.now());
}

export function retryBotMessage(id: string): BotDelivery {
  return db.transaction(() => {
    const message = getBotMessage(id);
    if (!message || !['failed', 'interrupted'].includes(message.status)) throw new Error('Cannot retry a delivery unless it failed or was interrupted');
    cancelBotChain(message.chainId);
    const chainId = randomUUID();
    db.prepare('INSERT INTO bot_chains (id, deadline_at) VALUES (?, ?)').run(chainId, Date.now() + 30 * 60_000);
    db.prepare("UPDATE bot_messages SET status = 'queued', run_id = NULL, error = NULL, chain_id = ?, depth = 1, updated_at = ? WHERE id = ?")
      .run(chainId, Date.now(), id);
    return getBotMessage(id)!;
  })();
}

export function cancelBotChain(chainId: string): BotRunContext[] {
  return db.transaction(() => {
    const contexts = (db.prepare('SELECT run_id AS runId FROM bot_run_contexts WHERE chain_id = ?').all(chainId) as Array<{ runId: string }>)
      .map(row => getBotRun(row.runId)!);
    db.prepare('UPDATE bot_chains SET cancelled = 1 WHERE id = ?').run(chainId);
    db.prepare("UPDATE bot_messages SET status = 'cancelled', error = 'Exchange stopped', updated_at = ? WHERE chain_id = ? AND status IN ('queued', 'running')")
      .run(Date.now(), chainId);
    return contexts;
  })();
}

export function botChainsForTask(taskId: string): string[] {
  return (db.prepare(`SELECT DISTINCT chain_id AS id FROM bot_messages WHERE (sender_task_id = ? OR recipient_task_id = ?)
    AND status IN ('queued', 'running')`).all(taskId, taskId) as Array<{ id: string }>).map(row => row.id);
}

export function botDeliveryContent(delivery: BotDelivery): string {
  return `Message ${delivery.kind === 'reply' ? 'reply ' : ''}from ${delivery.senderLabel} (@${delivery.senderProfileId})\n\n${delivery.message}`;
}

export function requireQueuedBotMessage(id: string, recipientTaskId: string): BotDelivery {
  const delivery = getBotMessage(id);
  if (!delivery || delivery.recipientTaskId !== recipientTaskId || delivery.status !== 'queued') throw new Error('Bot delivery is no longer queued');
  requireActiveChain(delivery.chainId);
  return delivery;
}
