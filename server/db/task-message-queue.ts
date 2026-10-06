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
  publication_json: string | null;
}

const getStmt = db.prepare('SELECT * FROM task_message_queue WHERE task_id = ?');
const listStmt = db.prepare('SELECT * FROM task_message_queue ORDER BY created_at');
const putStmt = db.prepare(`
  INSERT INTO task_message_queue (
    task_id, id, content, settings_json, invited_profile_ids_json,
    collaboration_scope, confirm_persistent_collaboration, created_at, updated_at, publication_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(task_id) DO UPDATE SET
    id = excluded.id,
    content = excluded.content,
    settings_json = excluded.settings_json,
    invited_profile_ids_json = excluded.invited_profile_ids_json,
    collaboration_scope = excluded.collaboration_scope,
    confirm_persistent_collaboration = excluded.confirm_persistent_collaboration,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    publication_json = excluded.publication_json
`);
const deleteStmt = db.prepare('DELETE FROM task_message_queue WHERE task_id = ? AND id = ?');
const consumeStmt = db.prepare('DELETE FROM task_message_queue WHERE task_id = ? AND id = ? RETURNING *');
const restoreStmt = db.prepare(`
  INSERT OR IGNORE INTO task_message_queue (
    task_id, id, content, settings_json, invited_profile_ids_json,
    collaboration_scope, confirm_persistent_collaboration, created_at, updated_at, publication_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    ...(row.publication_json ? { publication: JSON.parse(row.publication_json) } : {}),
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
    message.publication ? JSON.stringify(message.publication) : null,
  );
  return getQueuedTaskMessage(message.taskId)!;
}

export function deleteQueuedTaskMessage(taskId: string, id: string): boolean {
  return deleteStmt.run(taskId, id).changes > 0;
}

/** Replace only the failed publication the caller inspected, never a human follow-up. */
export function replaceFailedQueuedPublication(previousId: string, message: QueuedTaskMessage): boolean {
  return db.prepare(`UPDATE task_message_queue SET id = ?, content = ?, publication_json = ?, updated_at = ?
    WHERE task_id = ? AND id = ? AND json_extract(publication_json, '$.error') IS NOT NULL`)
    .run(message.id, message.content, JSON.stringify(message.publication), message.updatedAt, message.taskId, previousId).changes > 0;
}

export function pauseQueuedPublication(taskId: string, id: string, error: string): void {
  const saved = getQueuedTaskMessage(taskId);
  if (saved?.id !== id || !saved.publication) return;
  db.prepare('UPDATE task_message_queue SET publication_json = ?, updated_at = ? WHERE task_id = ? AND id = ?')
    .run(JSON.stringify({ ...saved.publication, error }), Date.now(), taskId, id);
}

export function startQueuedPublication(taskId: string, id: string): boolean {
  const saved = getQueuedTaskMessage(taskId);
  if (saved?.id !== id || !saved.publication || saved.publication.started || saved.publication.error) return false;
  return db.prepare('UPDATE task_message_queue SET publication_json = ?, updated_at = ? WHERE task_id = ? AND id = ?')
    .run(JSON.stringify({ ...saved.publication, started: true }), Date.now(), taskId, id).changes > 0;
}

export function consumeQueuedTaskMessage(taskId: string, id: string): QueuedTaskMessage | undefined {
  const row = consumeStmt.get(taskId, id);
  return fromRow(row as QueueRow | undefined);
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
    message.publication ? JSON.stringify(message.publication) : null,
  ).changes > 0;
}
