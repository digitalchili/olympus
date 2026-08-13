import { v4 as uuid } from 'uuid';
import type {
  ProjectEditorLease,
  ProjectVersion,
  ProjectVersionAction,
} from '../../shared/types.js';
import db from './index.js';

type LeaseRow = {
  id: string;
  project_id: string;
  task_id: string;
  profile_id: string;
  repository_full_name: string;
  base_branch: string;
  branch_name: string;
  workdir: string;
  base_sha: string | null;
  status: 'active' | 'released';
  lease_token: string;
  created_at: number;
  updated_at: number;
  released_at: number | null;
};

type VersionRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  lease_id: string | null;
  action: ProjectVersionAction;
  commit_sha: string;
  parent_sha: string | null;
  reverted_version_id: string | null;
  branch_name: string;
  commit_message: string;
  changed_files_json: string;
  pushed_at: number;
};

function requiredText(value: string, field: string, maxLength: number): string {
  const result = value.trim();
  if (!result) throw new Error(`${field} is required`);
  if (result.length > maxLength) throw new Error(`${field} is too long`);
  if (/\p{Cc}/u.test(result)) throw new Error(`${field} contains invalid control characters`);
  return result;
}

function optionalSha(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const result = value.trim();
  if (!/^[0-9a-f]{40}$/i.test(result)) throw new Error(`${field} must be a 40-character git SHA`);
  return result;
}

function leaseFromRow(row: LeaseRow): ProjectEditorLease {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    profileId: row.profile_id,
    repositoryFullName: row.repository_full_name,
    baseBranch: row.base_branch,
    branchName: row.branch_name,
    workdir: row.workdir,
    baseSha: row.base_sha,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    releasedAt: row.released_at,
  };
}

function versionFromRow(row: VersionRow): ProjectVersion {
  let changedFiles: string[] = [];
  try {
    const parsed = JSON.parse(row.changed_files_json) as unknown;
    if (Array.isArray(parsed)) changedFiles = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    changedFiles = [];
  }
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    leaseId: row.lease_id,
    action: row.action,
    commitSha: row.commit_sha,
    parentSha: row.parent_sha,
    revertedVersionId: row.reverted_version_id,
    branchName: row.branch_name,
    commitMessage: row.commit_message,
    changedFiles,
    pushedAt: row.pushed_at,
  };
}

export interface AcquireProjectEditorInput {
  projectId: string;
  taskId: string;
  profileId: string;
  repositoryFullName: string;
  baseBranch: string;
  workdir: string;
  branchName: string;
  baseSha?: string | null;
  leaseToken: string;
  now?: number;
}

export function getProjectEditor(projectId: string): ProjectEditorLease | null {
  const row = db.prepare(`
    SELECT id, project_id, task_id, profile_id, repository_full_name, base_branch,
      branch_name, workdir, base_sha, status, lease_token, created_at, updated_at, released_at
    FROM project_editor_leases
    WHERE project_id = ? AND status = 'active'
  `).get(projectId) as LeaseRow | undefined;
  return row ? leaseFromRow(row) : null;
}

export function getProjectEditorForTask(projectId: string, taskId: string): ProjectEditorLease | null {
  const row = db.prepare(`
    SELECT id, project_id, task_id, profile_id, repository_full_name, base_branch,
      branch_name, workdir, base_sha, status, lease_token, created_at, updated_at, released_at
    FROM project_editor_leases
    WHERE project_id = ? AND task_id = ? AND status = 'active'
  `).get(projectId, taskId) as LeaseRow | undefined;
  return row ? leaseFromRow(row) : null;
}

export function getActiveProjectEditorForTask(taskId: string): ProjectEditorLease | null {
  const row = db.prepare(`
    SELECT id, project_id, task_id, profile_id, repository_full_name, base_branch,
      branch_name, workdir, base_sha, status, lease_token, created_at, updated_at, released_at
    FROM project_editor_leases
    WHERE task_id = ? AND status = 'active'
  `).get(taskId) as LeaseRow | undefined;
  return row ? leaseFromRow(row) : null;
}

export function getActiveProjectEditorForProfile(profileId: string): ProjectEditorLease | null {
  const row = db.prepare(`
    SELECT id, project_id, task_id, profile_id, repository_full_name, base_branch,
      branch_name, workdir, base_sha, status, lease_token, created_at, updated_at, released_at
    FROM project_editor_leases
    WHERE profile_id = ? AND status = 'active'
    ORDER BY created_at
    LIMIT 1
  `).get(profileId) as LeaseRow | undefined;
  return row ? leaseFromRow(row) : null;
}

export function acquireProjectEditor(input: AcquireProjectEditorInput): ProjectEditorLease {
  const existing = getProjectEditor(input.projectId);
  if (existing) {
    if (existing.taskId === input.taskId) return existing;
    throw new Error('Project already has an editor');
  }
  const now = input.now ?? Date.now();
  const id = uuid();
  db.prepare(`
    INSERT INTO project_editor_leases (
      id, project_id, task_id, profile_id, repository_full_name, base_branch,
      branch_name, workdir, base_sha, status, lease_token, created_at, updated_at, released_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)
  `).run(
    id,
    requiredText(input.projectId, 'projectId', 120),
    requiredText(input.taskId, 'taskId', 120),
    requiredText(input.profileId, 'profileId', 64),
    requiredText(input.repositoryFullName, 'repositoryFullName', 240),
    requiredText(input.baseBranch, 'baseBranch', 240),
    requiredText(input.branchName, 'branchName', 240),
    requiredText(input.workdir, 'workdir', 1_000),
    optionalSha(input.baseSha, 'baseSha'),
    requiredText(input.leaseToken, 'leaseToken', 120),
    now,
    now,
  );
  return getProjectEditor(input.projectId)!;
}

export interface TransferProjectEditorInput extends AcquireProjectEditorInput {
  previousLeaseId: string;
  previousTaskId: string;
}

export function transferProjectEditor(input: TransferProjectEditorInput): ProjectEditorLease {
  const now = input.now ?? Date.now();
  const id = uuid();
  db.transaction(() => {
    const released = db.prepare(`
      UPDATE project_editor_leases
      SET status = 'released', updated_at = ?, released_at = ?
      WHERE id = ? AND project_id = ? AND task_id = ? AND status = 'active'
    `).run(now, now, input.previousLeaseId, input.projectId, input.previousTaskId);
    if (released.changes !== 1) throw new Error('Project repository handoff lost its active lease');
    db.prepare(`
      INSERT INTO project_editor_leases (
        id, project_id, task_id, profile_id, repository_full_name, base_branch,
        branch_name, workdir, base_sha, status, lease_token, created_at, updated_at, released_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)
    `).run(
      id,
      requiredText(input.projectId, 'projectId', 120),
      requiredText(input.taskId, 'taskId', 120),
      requiredText(input.profileId, 'profileId', 64),
      requiredText(input.repositoryFullName, 'repositoryFullName', 240),
      requiredText(input.baseBranch, 'baseBranch', 240),
      requiredText(input.branchName, 'branchName', 240),
      requiredText(input.workdir, 'workdir', 1_000),
      optionalSha(input.baseSha, 'baseSha'),
      requiredText(input.leaseToken, 'leaseToken', 120),
      now,
      now,
    );
    db.prepare('UPDATE tasks SET workdir = NULL, updated_at = ? WHERE id = ?').run(now, input.previousTaskId);
    const bound = db.prepare('UPDATE tasks SET workdir = ?, updated_at = ? WHERE id = ?').run(input.workdir, now, input.taskId);
    if (bound.changes !== 1) throw new Error('Project repository handoff task was not found');
  })();
  return getProjectEditor(input.projectId)!;
}

export function releaseProjectEditor(input: { leaseId: string; taskId: string; now?: number }): ProjectEditorLease | null {
  const now = input.now ?? Date.now();
  db.prepare(`
    UPDATE project_editor_leases
    SET status = 'released', updated_at = ?, released_at = ?
    WHERE id = ? AND task_id = ? AND status = 'active'
  `).run(now, now, input.leaseId, input.taskId);
  const row = db.prepare(`
    SELECT id, project_id, task_id, profile_id, repository_full_name, base_branch,
      branch_name, workdir, base_sha, status, lease_token, created_at, updated_at, released_at
    FROM project_editor_leases
    WHERE id = ?
  `).get(input.leaseId) as LeaseRow | undefined;
  return row ? leaseFromRow(row) : null;
}

export interface RecordProjectVersionInput {
  projectId: string;
  taskId: string;
  leaseId?: string | null;
  action: ProjectVersionAction;
  commitSha: string;
  parentSha?: string | null;
  revertedVersionId?: string | null;
  branchName: string;
  commitMessage: string;
  changedFiles: string[];
  pushedAt?: number;
}

export function recordProjectVersion(input: RecordProjectVersionInput): ProjectVersion {
  if (input.action !== 'commit_push' && input.action !== 'revert') throw new Error('Invalid Project version action');
  const changedFiles = input.changedFiles
    .map((file) => requiredText(file, 'changed file', 500))
    .slice(0, 200);
  const id = uuid();
  const pushedAt = input.pushedAt ?? Date.now();
  db.prepare(`
    INSERT INTO project_versions (
      id, project_id, task_id, lease_id, action, commit_sha, parent_sha,
      reverted_version_id, branch_name, commit_message, changed_files_json, pushed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    requiredText(input.projectId, 'projectId', 120),
    requiredText(input.taskId, 'taskId', 120),
    input.leaseId ? requiredText(input.leaseId, 'leaseId', 120) : null,
    input.action,
    optionalSha(input.commitSha, 'commitSha'),
    optionalSha(input.parentSha, 'parentSha'),
    input.revertedVersionId ? requiredText(input.revertedVersionId, 'revertedVersionId', 120) : null,
    requiredText(input.branchName, 'branchName', 240),
    requiredText(input.commitMessage, 'commitMessage', 240),
    JSON.stringify(changedFiles),
    pushedAt,
  );
  return getProjectVersion(id)!;
}

export function getProjectVersion(id: string): ProjectVersion | null {
  const row = db.prepare(`
    SELECT id, project_id, task_id, lease_id, action, commit_sha, parent_sha,
      reverted_version_id, branch_name, commit_message, changed_files_json, pushed_at
    FROM project_versions
    WHERE id = ?
  `).get(id) as VersionRow | undefined;
  return row ? versionFromRow(row) : null;
}

export function listProjectVersions(projectId: string): ProjectVersion[] {
  const rows = db.prepare(`
    SELECT id, project_id, task_id, lease_id, action, commit_sha, parent_sha,
      reverted_version_id, branch_name, commit_message, changed_files_json, pushed_at
    FROM project_versions
    WHERE project_id = ?
    ORDER BY pushed_at DESC, id DESC
  `).all(projectId) as VersionRow[];
  return rows.map(versionFromRow);
}
