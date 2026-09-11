import db from './index.js';

export function getProjectGitHubInstallationIds(projectId: string): number[] {
  return (db.prepare('SELECT installation_id FROM project_github_access WHERE project_id = ? ORDER BY installation_id').all(projectId) as Array<{ installation_id: number }>).map(row => row.installation_id);
}

export function setProjectGitHubInstallationIds(projectId: string, installationIds: number[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM project_github_access WHERE project_id = ?').run(projectId);
    const insert = db.prepare('INSERT INTO project_github_access (project_id, installation_id) VALUES (?, ?)');
    for (const id of new Set(installationIds)) insert.run(projectId, id);
  })();
}
