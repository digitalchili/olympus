import { randomUUID } from 'node:crypto';
import db from './index.js';
import type { ProjectRepositoryLink, Task } from '../../shared/types.js';

// Installation IDs and Project names are connections, not repository identity.
export const repositoryKey = (link: ProjectRepositoryLink): string => `${link.provider}:${link.providerRepositoryId}`;
export interface RepositoryOwner { key: string; taskId: string; token: string; runId: string | null; blocker: string | null }
export function repositoryOwner(key: string): RepositoryOwner | undefined {
  return db.prepare(`SELECT repository_key AS key, owner_task_id AS taskId, owner_token AS token,
    run_id AS runId, blocker FROM repository_workflows WHERE repository_key=? AND owner_task_id IS NOT NULL`).get(key) as RepositoryOwner | undefined;
}
export function repositoryOwnerForTask(taskId: string): RepositoryOwner | undefined {
  return db.prepare(`SELECT repository_key AS key, owner_task_id AS taskId, owner_token AS token,
    run_id AS runId, blocker FROM repository_workflows WHERE owner_task_id=?`).get(taskId) as RepositoryOwner | undefined;
}
export function listRepositoryOwners(): RepositoryOwner[] {
  return db.prepare(`SELECT repository_key AS key, owner_task_id AS taskId, owner_token AS token,
    run_id AS runId, blocker FROM repository_workflows WHERE owner_task_id IS NOT NULL`).all() as RepositoryOwner[];
}
export function enqueueRepositoryTask(key: string, taskId: string): void {
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO repository_workflows(repository_key) VALUES (?)').run(key);
    db.prepare('INSERT OR IGNORE INTO repository_task_queue(repository_key, task_id) VALUES (?, ?)').run(key, taskId);
  })();
}
export function claimRepositoryTask(key: string, taskId: string): RepositoryOwner | null {
  return db.transaction(() => {
    const owner = repositoryOwner(key);
    if (owner) return owner.taskId === taskId ? owner : null;
    const first = db.prepare('SELECT task_id, held_by FROM repository_task_queue WHERE repository_key=? ORDER BY position LIMIT 1').get(key) as { task_id: string; held_by: string | null } | undefined;
    if (first?.task_id !== taskId && first?.held_by !== taskId) return null;
    db.prepare(`UPDATE repository_workflows SET owner_task_id=?, owner_token=?, run_id=NULL, blocker=NULL
      WHERE repository_key=? AND owner_task_id IS NULL`).run(taskId, randomUUID(), key);
    return repositoryOwner(key) ?? null;
  }).immediate();
}
export function recordRepositoryRun(taskId: string, runId: string): void {
  db.prepare('UPDATE repository_workflows SET run_id=?, blocker=NULL WHERE owner_task_id=?').run(runId, taskId);
}
export function setRepositoryWait(taskId: string, otherTaskId: string | null): void {
  db.prepare('UPDATE repository_task_queue SET held_by=? WHERE task_id=?').run(otherTaskId, taskId);
}
export function setRepositoryBlocker(key: string, token: string, message: string | null): void {
  db.prepare('UPDATE repository_workflows SET blocker=? WHERE repository_key=? AND owner_token=?').run(message, key, token);
}
export function finishRepositoryTask(key: string, token: string): boolean {
  return db.transaction(() => {
    const owner = repositoryOwner(key);
    if (!owner || owner.token !== token) return false;
    db.prepare('DELETE FROM repository_task_queue WHERE repository_key=? AND task_id=?').run(key, owner.taskId);
    db.prepare('UPDATE repository_workflows SET owner_task_id=NULL, owner_token=NULL, run_id=NULL, blocker=NULL WHERE repository_key=? AND owner_token=?').run(key, token);
    return true;
  }).immediate();
}
export function queuedRepositoryTasks(): string[] {
  return (db.prepare('SELECT task_id FROM repository_task_queue ORDER BY position').all() as { task_id: string }[]).map(row => row.task_id);
}
export function removeUnstartedRepositoryTask(taskId: string): void {
  db.prepare(`DELETE FROM repository_task_queue WHERE task_id=? AND NOT EXISTS
    (SELECT 1 FROM repository_workflows WHERE owner_task_id=?)`).run(taskId, taskId);
}
export function projectHasRepositoryRequests(projectId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM repository_task_queue q JOIN tasks t ON t.id=q.task_id WHERE t.project_id=? LIMIT 1').get(projectId));
}
export function withRepositoryQueue<T extends Task | undefined>(task: T): T {
  if (!task) return task;
  const row = db.prepare(`SELECT COALESCE(w.owner_task_id, q.held_by) AS owner_task_id, w.blocker, t.title FROM repository_task_queue q
    JOIN repository_workflows w ON w.repository_key=q.repository_key
    LEFT JOIN tasks t ON t.id=COALESCE(w.owner_task_id, q.held_by) WHERE q.task_id=?`).get(task.id) as { owner_task_id: string | null; blocker: string | null; title: string | null } | undefined;
  if (row && (row.owner_task_id !== task.id || row.blocker)) {
    const title = row.title ?? 'the previous task';
    task.repositoryQueue = {
      state: row.blocker ? 'blocked' : 'waiting',
      waitingForTaskId: row.owner_task_id,
      message: row.owner_task_id === task.id ? row.blocker!
        : row.blocker ? `Waiting for “${title}” to be ready. ${row.blocker}`
          : row.owner_task_id ? `Waiting for “${title}” to finish.` : 'Waiting to start. Olympus will start this task automatically.',
    };
  }
  return task;
}
