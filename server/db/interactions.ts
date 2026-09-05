import db from './index.js';
import type { InteractionResponse, InteractionStatus, NativeInteraction, TaskInteraction } from '../../shared/interactions.js';

interface InteractionRow {
  id: string;
  task_id: string;
  profile_name: string;
  olympus_run_id: string;
  worker_run_id: string;
  kind: 'clarification' | 'approval';
  status: InteractionStatus;
  title: string;
  payload_json: string;
  response_json: string | null;
  delivery_error: string | null;
  requested_at: number;
  expires_at: number;
  delivery_claimed_at: number | null;
  settled_at: number | null;
}

export interface RecordInteractionInput {
  taskId: string;
  profileName: string;
  olympusRunId: string;
  interaction: NativeInteraction;
  requestedAt?: number;
}

function parseInteraction(row: InteractionRow): TaskInteraction {
  const payload = JSON.parse(row.payload_json) as NativeInteraction;
  return {
    ...payload,
    taskId: row.task_id,
    profileName: row.profile_name,
    olympusRunId: row.olympus_run_id,
    status: row.status,
    requestedAt: row.requested_at,
    settledAt: row.settled_at,
    response: row.response_json ? JSON.parse(row.response_json) as InteractionResponse : null,
    deliveryError: row.delivery_error,
  };
}

const selectInteraction = db.prepare('SELECT * FROM task_interactions WHERE id = ?');
const selectTaskInteractions = db.prepare(`
  SELECT * FROM task_interactions
  WHERE task_id = ? AND profile_name = ?
  ORDER BY CASE WHEN status IN ('waiting', 'claimed') THEN 0 ELSE 1 END, requested_at DESC
  LIMIT 64
`);
const insertInteractionStmt = db.prepare(`
  INSERT OR IGNORE INTO task_interactions (
    id, task_id, profile_name, olympus_run_id, worker_run_id, kind, status,
    title, payload_json, requested_at, expires_at
  ) VALUES (
    @id, @taskId, @profileName, @olympusRunId, @workerRunId, @kind, 'waiting',
    @title, @payloadJson, @requestedAt, @expiresAt
  )
`);
const expireWaitingStmt = db.prepare(`
  UPDATE task_interactions
  SET status = 'expired', settled_at = ?
  WHERE status = 'waiting' AND expires_at <= ?
`);
const recoverInterruptedStmt = db.prepare(`
  UPDATE task_interactions
  SET status = 'cancelled', settled_at = COALESCE(settled_at, ?),
      delivery_error = COALESCE(delivery_error, 'Olympus restarted before this interaction was answered')
  WHERE status IN ('waiting', 'claimed')
`);
const markSettledStmt = db.prepare(`
  UPDATE task_interactions
  SET status = @status, settled_at = @settledAt
  WHERE id = @id AND status IN ('waiting', 'claimed', 'delivery_unknown')
`);
const markDeliveredStmt = db.prepare(`
  UPDATE task_interactions
  SET status = @status, response_json = @responseJson, settled_at = @settledAt, delivery_error = NULL
  WHERE id = @id AND status = 'claimed'
`);
const markDeliveryUnknownStmt = db.prepare(`
  UPDATE task_interactions
  SET status = 'delivery_unknown', delivery_error = @error, settled_at = @settledAt
  WHERE id = @id AND status = 'claimed'
`);

export function expireWaitingInteractions(now = Date.now()): void {
  expireWaitingStmt.run(now, now);
}

export function recoverInterruptedInteractions(now = Date.now()): void {
  recoverInterruptedStmt.run(now);
}

export function recordInteraction(input: RecordInteractionInput): TaskInteraction {
  const requestedAt = input.requestedAt ?? Date.now();
  const payloadJson = JSON.stringify(input.interaction);
  insertInteractionStmt.run({
    id: input.interaction.id,
    taskId: input.taskId,
    profileName: input.profileName,
    olympusRunId: input.olympusRunId,
    workerRunId: input.interaction.workerRunId,
    kind: input.interaction.kind,
    title: input.interaction.title,
    payloadJson,
    requestedAt,
    expiresAt: input.interaction.expiresAt,
  });
  return getInteraction(input.interaction.id)!;
}

export function listTaskInteractions(taskId: string, profileName: string, now = Date.now()): TaskInteraction[] {
  expireWaitingInteractions(now);
  return (selectTaskInteractions.all(taskId, profileName) as InteractionRow[]).map(parseInteraction);
}

export function getInteraction(id: string): TaskInteraction | null {
  const row = selectInteraction.get(id) as InteractionRow | undefined;
  return row ? parseInteraction(row) : null;
}

export const claimInteraction: (input: {
  taskId: string;
  profileName: string;
  interactionId: string;
  workerRunId: string;
  olympusRunId: string;
  response: InteractionResponse;
  now?: number;
}) => TaskInteraction | null = db.transaction((input: {
  taskId: string;
  profileName: string;
  interactionId: string;
  workerRunId: string;
  olympusRunId: string;
  response: InteractionResponse;
  now?: number;
}): TaskInteraction | null => {
  const now = input.now ?? Date.now();
  expireWaitingInteractions(now);
  const result = db.prepare(`
    UPDATE task_interactions
    SET status = 'claimed', delivery_claimed_at = @now, response_json = @responseJson
    WHERE id = @interactionId
      AND task_id = @taskId
      AND profile_name = @profileName
      AND worker_run_id = @workerRunId
      AND olympus_run_id = @olympusRunId
      AND status = 'waiting'
      AND expires_at > @now
  `).run({ ...input, now, responseJson: JSON.stringify(input.response) });
  if (result.changes !== 1) return null;
  return getInteraction(input.interactionId);
});

export function markInteractionDelivered(id: string, status: 'answered' | 'denied', response: InteractionResponse, now = Date.now()): void {
  markDeliveredStmt.run({ id, status, responseJson: JSON.stringify(response), settledAt: now });
}

export function markInteractionDeliveryUnknown(id: string, error: string, now = Date.now()): void {
  markDeliveryUnknownStmt.run({ id, error: error.slice(0, 2000), settledAt: now });
}

export function closeRunInteractions(taskId: string, olympusRunId: string, now = Date.now()): void {
  db.prepare(`UPDATE task_interactions
    SET status = CASE WHEN status = 'claimed' THEN 'delivery_unknown' ELSE 'cancelled' END,
        settled_at = ?, delivery_error = COALESCE(delivery_error, 'Worker turn ended before interaction settlement')
    WHERE task_id = ? AND olympus_run_id = ? AND status IN ('waiting', 'claimed')
  `).run(now, taskId, olympusRunId);
}

export function hasUnansweredInteractions(taskId: string, olympusRunId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM task_interactions
    WHERE task_id = ? AND olympus_run_id = ? AND status NOT IN ('answered', 'denied') LIMIT 1
  `).get(taskId, olympusRunId);
}

export function markInteractionSettled(interactionId: string, status: 'answered' | 'denied' | 'expired' | 'cancelled', now = Date.now()): void {
  const current = getInteraction(interactionId);
  if (current?.status === 'answered' || current?.status === 'denied') return;
  markSettledStmt.run({ id: interactionId, status, settledAt: now });
}
