import type { ProjectRepositoryLink, ProjectSyncEvidence } from '../../shared/types.js';
import db from './index.js';

function repositoryKey(link: ProjectRepositoryLink): string {
  return JSON.stringify([link.installationId, link.providerRepositoryId, link.cloneUrl, link.defaultBranch]);
}

export function getProjectSyncEvidence(link: ProjectRepositoryLink): ProjectSyncEvidence | null {
  const row = db.prepare(`SELECT verified_at, current_sha, updated FROM project_repository_sync
    WHERE project_id = ? AND repository_key = ?`).get(link.projectId, repositoryKey(link)) as {
    verified_at: number; current_sha: string; updated: number;
  } | undefined;
  return row ? { verifiedAt: row.verified_at, currentSha: row.current_sha, updated: row.updated === 1 } : null;
}

export function recordProjectSyncEvidence(link: ProjectRepositoryLink, evidence: ProjectSyncEvidence): void {
  db.prepare(`INSERT INTO project_repository_sync (project_id, repository_key, verified_at, current_sha, updated)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET
    repository_key = excluded.repository_key, verified_at = excluded.verified_at,
    current_sha = excluded.current_sha, updated = excluded.updated`).run(
    link.projectId, repositoryKey(link), evidence.verifiedAt, evidence.currentSha, evidence.updated ? 1 : 0,
  );
}
