import type { ProjectVersion, ProjectVersionAction } from '../../shared/types.js';
import db from './index.js';
import { getProjectVersion, recordProjectVersion } from './project-cp.js';

export interface ProjectPublication {
  id: string; projectId: string; taskId: string | null; leaseId: string | null;
  repository: { installationId: number; providerRepositoryId: number; cloneUrl: string; defaultBranch: string };
  action: ProjectVersionAction; revertedVersionId: string | null;
  parentSha: string; treeSha: string; commitSha: string | null;
  commitMessage: string; changedFiles: string[]; targetBranch: string;
  refs: Array<{ ref: string; source: string; createOnly: boolean }>;
  state: 'prepared' | 'pending' | 'confirmed' | 'abandoned';
  createdAt: number; completedAt: number | null;
  failureReason?: 'branch_advanced';
}

function fromRow(row: any): ProjectPublication | null {
  return row ? { id: row.id, projectId: row.project_id, taskId: row.task_id, leaseId: row.lease_id,
    repository: JSON.parse(row.repository_json), action: row.action, revertedVersionId: row.reverted_version_id,
    parentSha: row.parent_sha, treeSha: row.tree_sha, commitSha: row.commit_sha, commitMessage: row.commit_message,
    changedFiles: JSON.parse(row.changed_files_json), targetBranch: row.target_branch, refs: JSON.parse(row.refs_json),
    state: row.state, createdAt: row.created_at, completedAt: row.completed_at,
    ...(row.failure_reason === 'branch_advanced' ? { failureReason: 'branch_advanced' as const } : {}) } : null;
}
export function getProjectPublication(id: string): ProjectPublication | null {
  return fromRow(db.prepare('SELECT * FROM project_publications WHERE id = ?').get(id));
}
export function markProjectPublicationBranchAdvanced(id: string): ProjectPublication {
  db.prepare("UPDATE project_publications SET failure_reason = 'branch_advanced' WHERE id = ? AND state = 'pending'").run(id);
  return getProjectPublication(id)!;
}
export function getPendingProjectPublication(projectId: string, taskId: string): ProjectPublication | null {
  return fromRow(db.prepare("SELECT * FROM project_publications WHERE project_id = ? AND task_id = ? AND state IN ('prepared','pending')").get(projectId, taskId));
}
export function hasPendingProjectPublication(projectId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM project_publications WHERE project_id = ? AND state IN ('prepared','pending') LIMIT 1").get(projectId));
}
function sha(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('Invalid publication commit or tree');
  return value;
}
export function createProjectPublication(input: Omit<ProjectPublication, 'state' | 'completedAt'>): ProjectPublication {
  sha(input.parentSha); sha(input.treeSha); if (input.commitSha) sha(input.commitSha);
  if (!input.refs.length || input.refs.some(ref => !ref.ref.startsWith('refs/heads/') || (ref.source !== 'commit' && !/^[0-9a-f]{40}$/.test(ref.source)))) throw new Error('Invalid publication refs');
  db.prepare(`INSERT INTO project_publications (id,project_id,task_id,lease_id,repository_json,action,reverted_version_id,
    parent_sha,tree_sha,commit_sha,commit_message,changed_files_json,target_branch,refs_json,state,created_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,NULL)`).run(input.id, input.projectId, input.taskId, input.leaseId,
    JSON.stringify(input.repository), input.action, input.revertedVersionId, input.parentSha, input.treeSha, input.commitSha,
    input.commitMessage, JSON.stringify(input.changedFiles), input.targetBranch, JSON.stringify(input.refs), input.createdAt);
  return getProjectPublication(input.id)!;
}
export function setProjectPublicationCommit(id: string, commitSha: string): ProjectPublication {
  sha(commitSha);
  const row = getProjectPublication(id);
  if (!row || !['prepared', 'pending'].includes(row.state) || (row.commitSha && row.commitSha !== commitSha)) throw new Error('Publication commit or state changed');
  db.prepare("UPDATE project_publications SET commit_sha = ?, state = 'pending' WHERE id = ? AND state IN ('prepared','pending')").run(commitSha, id);
  return getProjectPublication(id)!;
}
export function confirmProjectPublication(id: string, pushedAt: number): ProjectVersion {
  return db.transaction(() => {
    const row = getProjectPublication(id);
    if (row?.state === 'confirmed') return getProjectVersion(id)!;
    if (row?.state !== 'pending' || !row.commitSha) throw new Error('Publication is not ready for confirmation');
    const version = recordProjectVersion({ ...row, commitSha: row.commitSha, branchName: row.targetBranch, pushedAt });
    db.prepare("UPDATE project_publications SET state = 'confirmed', completed_at = ? WHERE id = ?").run(pushedAt, id);
    return version;
  })();
}
export function abandonProjectPublication(id: string): ProjectPublication {
  const row = getProjectPublication(id);
  if (!row || row.state === 'confirmed') throw new Error('Publication cannot be abandoned');
  db.prepare("UPDATE project_publications SET state = 'abandoned', completed_at = COALESCE(completed_at, ?) WHERE id = ?").run(Date.now(), id);
  return getProjectPublication(id)!;
}
