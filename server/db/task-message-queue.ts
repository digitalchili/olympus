import db from './index.js';
import type { QueuedTaskMessage } from '../../shared/types.js';

interface QueueRow {
  task_id: string;
  id: string;
  content: string;
  settings_json: string;
  invited_profile_ids_json: string;
  collaboration_scope: QueuedTaskMessage['collaborationScope'];
  confirm_persistent_collaboration: number;
  created_at: number;
  updated_at: number;
}

const getStmt = db.prepare('SELECT * FROM task_message_queue WHERE task_id = ?');
const listStmt = db.prepare('SELECT * FROM task_message_queue ORDER BY created_at');
const putStmt = db.prepare(`
  INSERT INTO task_message_queue (
    task_id, id, content, settings_json, invited_profile_ids_json,
    collaboration_scope, confirm_persistent_collaboration, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(task_id) DO UPDATE SET
    id = excluded.id,
    content = excluded.content,
    settings_json = excluded.settings_json,
    invited_profile_ids_json = excluded.invited_profile_ids_json,
    collaboration_scope = excluded.collaboration_scope,
    confirm_persistent_collaboration = excluded.confirm_persistent_collaboration,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare('DELETE FROM task_message_queue WHERE task_id = ? AND id = ?');
const consumeStmt = db.prepare('DELETE FROM task_message_queue WHERE task_id = ? AND id = ? RETURNING *');
const restoreStmt = db.prepare(`
  INSERT OR IGNORE INTO task_message_queue (
    task_id, id, content, settings_json, invited_profile_ids_json,
    collaboration_scope, confirm_persistent_collaboration, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function fromRow(row: QueueRow | undefined): QueuedTaskMessage | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    taskId: row.task_id,
    content: row.content,
    settings: JSON.parse(row.settings_json),
    invitedProfileIds: JSON.parse(row.invited_profile_ids_json),
    collaborationScope: row.collaboration_scope,
    confirmPersistentCollaboration: row.confirm_persistent_collaboration === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getQueuedTaskMessage(taskId: string): QueuedTaskMessage | undefined {
  return fromRow(getStmt.get(taskId) as QueueRow | undefined);
}

export function listQueuedTaskMessages(): QueuedTaskMessage[] {
  return (listStmt.all() as QueueRow[]).map((row) => fromRow(row)!);
}

export function putQueuedTaskMessage(message: QueuedTaskMessage): QueuedTaskMessage {
  putStmt.run(
    message.taskId,
    message.id,
    message.content,
    JSON.stringify(message.settings),
    JSON.stringify(message.invitedProfileIds),
    message.collaborationScope,
    message.confirmPersistentCollaboration ? 1 : 0,
    message.createdAt,
    message.updatedAt,
  );
  return getQueuedTaskMessage(message.taskId)!;
}

export function deleteQueuedTaskMessage(taskId: string, id: string): boolean {
  return deleteStmt.run(taskId, id).changes > 0;
}

export function consumeQueuedTaskMessage(taskId: string, id: string): QueuedTaskMessage | undefined {
  return fromRow(consumeStmt.get(taskId, id) as QueueRow | undefined);
}

export function restoreQueuedTaskMessage(message: QueuedTaskMessage): boolean {
  return restoreStmt.run(
    message.taskId,
    message.id,
    message.content,
    JSON.stringify(message.settings),
    JSON.stringify(message.invitedProfileIds),
    message.collaborationScope,
    message.confirmPersistentCollaboration ? 1 : 0,
    message.createdAt,
    message.updatedAt,
  ).changes > 0;
}