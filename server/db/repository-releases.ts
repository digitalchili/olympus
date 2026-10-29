import { createHash, randomUUID } from 'node:crypto';
import db from './index.js';
import type { ProjectRepositoryLink, QueuedTaskMessage } from '../../shared/types.js';
import type { RepositoryRelease, RepositoryChange } from '../../shared/repository-releases.js';
import type { CodingCheck, SourceIdentity } from '../../shared/coding-evidence.js';

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

export type ReleaseMember = RepositoryChange & { queueFingerprint?: string; boundRunId?: string };
export interface SavedRepositoryRelease extends RepositoryRelease {
  repositoryKey: string; projectId: string; actor: string | null; repository: ProjectRepositoryLink;
  targetSha: string; sourceSha: string | null; members: ReleaseMember[];
  candidate?: { workdir: string; headSha: string; treeSha: string; changedFiles: string[] };
  verification?: { source: SourceIdentity; checks: CodingCheck[]; passed: boolean; reason?: string };
  publicationId?: string;
}
export function queueReleaseFingerprint(message: QueuedTaskMessage): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex');
}
export function getRepositoryRelease(id: string): SavedRepositoryRelease | null {
  const row = db.prepare('SELECT payload_json FROM repository_releases WHERE id = ?').get(id) as { payload_json: string } | undefined;
  return row ? JSON.parse(row.payload_json) : null;
}
export function listRepositoryReleases(key?: string): SavedRepositoryRelease[] {
  return (db.prepare(`SELECT payload_json FROM repository_releases ${key ? 'WHERE repository_key = ?' : ''} ORDER BY created_at DESC, rowid DESC`)
    .all(...(key ? [key] : [])) as Array<{ payload_json: string }>).map(row => JSON.parse(row.payload_json));
}
export function saveRepositoryRelease(row: SavedRepositoryRelease): void {
  db.prepare(`INSERT INTO repository_releases VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state, payload_json=excluded.payload_json`)
    .run(row.id, row.repositoryKey, row.projectId, row.state, JSON.stringify(row), row.createdAt);
}
/** Bind the exact consumed request, never infer it from whichever run is latest. */
export function bindRepositoryReleaseQueue(message: QueuedTaskMessage, runId: string): void {
  for (const row of listRepositoryReleases().filter(row => row.state === 'waiting')) {
    let changed = false;
    for (const member of row.members) if (member.taskId === message.taskId && member.queueId === message.id && !member.boundRunId) {
      changed = true;
      if (member.queueFingerprint === queueReleaseFingerprint(message)) member.boundRunId = runId;
      else { row.state = 'blocked'; row.message = 'A saved request changed. Review the included tasks and make a new publish request.'; }
    }
    if (changed) saveRepositoryRelease(row);
  }
}
