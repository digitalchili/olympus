import { randomUUID } from 'node:crypto';
import db from './index.js';

export interface RepositoryContribution {
  id: string; repositoryKey: string; projectId: string; taskId: string; runId: string;
  commitSha: string; previousSha: string; fingerprint: string; changedFiles: string[]; acceptedAt: number;
}
export function listRepositoryContributions(key: string): RepositoryContribution[] {
  return (db.prepare('SELECT * FROM repository_contributions WHERE repository_key = ? ORDER BY accepted_at, rowid').all(key) as any[])
    .map(row => ({ id: row.id, repositoryKey: row.repository_key, projectId: row.project_id, taskId: row.task_id,
      runId: row.run_id, commitSha: row.commit_sha, previousSha: row.previous_sha, fingerprint: row.fingerprint,
      changedFiles: JSON.parse(row.changed_files_json), acceptedAt: row.accepted_at }));
}
export function recordRepositoryContribution(input: Omit<RepositoryContribution, 'id' | 'acceptedAt'>): void {
  const old = listRepositoryContributions(input.repositoryKey).find(row => row.taskId === input.taskId && row.runId === input.runId);
  if (old) {
    if (old.commitSha !== input.commitSha) throw new Error('The checked result for this run changed. Review it before publishing.');
    return;
  }
  db.prepare(`INSERT INTO repository_contributions
    (id, repository_key, project_id, task_id, run_id, commit_sha, previous_sha, fingerprint, changed_files_json, accepted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), input.repositoryKey, input.projectId, input.taskId, input.runId,
      input.commitSha, input.previousSha, input.fingerprint, JSON.stringify(input.changedFiles), Date.now());
}
