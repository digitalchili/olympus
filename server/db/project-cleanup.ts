import db from './index.js';

export type ProjectCleanupPath = (
  | { kind: 'task-checkouts' | 'legacy-checkout' | 'references' }
  | { kind: 'baseline'; name: string }
  | { kind: 'task-workspace'; taskId: string; profileId: string }
  | { kind: 'task-previews'; taskId: string }
) & { rootPath?: string; rootRealPath?: string | null };

export interface ProjectCleanupReceipt {
  id: string;
  name: string;
  paths: ProjectCleanupPath[];
}

export function getProjectCleanupReceipt(id: string): ProjectCleanupReceipt | null {
  const row = db.prepare('SELECT project_id, name, paths_json FROM project_deletion_cleanup WHERE project_id = ?').get(id) as { project_id: string; name: string; paths_json: string } | undefined;
  return row ? { id: row.project_id, name: row.name, paths: JSON.parse(row.paths_json) } : null;
}

export function listPendingProjectDeletions(): Array<{ id: string; name: string }> {
  return db.prepare('SELECT project_id AS id, name FROM project_deletion_cleanup ORDER BY created_at, project_id').all() as Array<{ id: string; name: string }>;
}

export function saveProjectCleanupReceipt(id: string, name: string, paths: ProjectCleanupPath[]): void {
  db.prepare('INSERT INTO project_deletion_cleanup (project_id, name, paths_json, created_at) VALUES (?, ?, ?, ?)').run(id, name, JSON.stringify(paths), Date.now());
}

export function removeProjectCleanupReceipt(id: string): void {
  db.prepare('DELETE FROM project_deletion_cleanup WHERE project_id = ?').run(id);
}
