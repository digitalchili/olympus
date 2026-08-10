import { v4 as uuid } from 'uuid';
import type {
  Project,
  ProjectAccessRole,
  ProjectManagerHistoryEntry,
  ProjectProfileGrant,
} from '../../shared/types.js';
import { PROJECT_ACCESS_ROLES } from '../../shared/types.js';
import db from './index.js';

type ProjectRow = {
  id: string;
  name: string;
  purpose: string;
  manager_profile_id: string;
  created_at: number;
  updated_at: number;
};

type HistoryRow = {
  id: string;
  project_id: string;
  profile_id: string;
  effective_from: number;
  effective_to: number | null;
  changed_by: string;
};

type GrantRow = {
  project_id: string;
  profile_id: string;
  role: ProjectAccessRole;
  granted_by: string;
  created_at: number;
  updated_at: number;
};

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    managerProfileId: row.manager_profile_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function historyFromRow(row: HistoryRow): ProjectManagerHistoryEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    profileId: row.profile_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    changedBy: row.changed_by,
  };
}

function grantFromRow(row: GrantRow): ProjectProfileGrant {
  return {
    projectId: row.project_id,
    profileId: row.profile_id,
    role: row.role,
    grantedBy: row.granted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeProjectName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function requiredText(value: string, field: string, maxLength: number): string {
  const result = value.trim();
  if (!result) throw new Error(`${field} is required`);
  if (result.length > maxLength) throw new Error(`${field} is too long`);
  if (/\p{Cc}/u.test(result)) throw new Error(`${field} contains invalid control characters`);
  return result;
}

export function countProjectsManagedByProfile(profileId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM projects
    WHERE manager_profile_id = ?
  `).get(profileId) as { count: number };
  return row.count;
}

export function getProject(id: string): Project | undefined {
  const row = db.prepare(`
    SELECT id, name, purpose, manager_profile_id, created_at, updated_at
    FROM projects WHERE id = ?
  `).get(id) as ProjectRow | undefined;
  return row ? projectFromRow(row) : undefined;
}

export function listProjects(): Project[] {
  const rows = db.prepare(`
    SELECT id, name, purpose, manager_profile_id, created_at, updated_at
    FROM projects ORDER BY updated_at DESC, name COLLATE NOCASE
  `).all() as ProjectRow[];
  return rows.map(projectFromRow);
}

export function createProject(input: {
  name: string;
  purpose: string;
  managerProfileId: string;
  changedBy: string;
}, now = Date.now()): Project {
  const name = requiredText(input.name, 'name', 120);
  const purpose = requiredText(input.purpose, 'purpose', 2_000);
  const managerProfileId = requiredText(input.managerProfileId, 'managerProfileId', 64);
  const changedBy = requiredText(input.changedBy, 'changedBy', 120);
  const nameKey = normalizeProjectName(name);
  if (db.prepare('SELECT 1 FROM projects WHERE name_key = ?').get(nameKey)) {
    throw new Error(`A Project named ${name} already exists`);
  }

  const id = uuid();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO projects (
        id, name, name_key, purpose, manager_profile_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, nameKey, purpose, managerProfileId, now, now);
    db.prepare(`
      INSERT INTO project_manager_history (
        id, project_id, profile_id, effective_from, effective_to, changed_by
      ) VALUES (?, ?, ?, ?, NULL, ?)
    `).run(uuid(), id, managerProfileId, now, changedBy);
  })();
  return getProject(id)!;
}

export function updateProject(
  projectId: string,
  input: { name?: string; purpose?: string },
  now = Date.now(),
): Project {
  const current = getProject(projectId);
  if (!current) throw new Error('Project not found');
  const name = input.name === undefined ? current.name : requiredText(input.name, 'name', 120);
  const purpose = input.purpose === undefined ? current.purpose : requiredText(input.purpose, 'purpose', 2_000);
  const nameKey = normalizeProjectName(name);
  const duplicate = db.prepare('SELECT id FROM projects WHERE name_key = ? AND id <> ?')
    .get(nameKey, projectId) as { id: string } | undefined;
  if (duplicate) throw new Error(`A Project named ${name} already exists`);
  db.prepare(`
    UPDATE projects
    SET name = ?, name_key = ?, purpose = ?, updated_at = ?
    WHERE id = ?
  `).run(name, nameKey, purpose, now, projectId);
  return getProject(projectId)!;
}

export function reassignProject(input: {
  projectId: string;
  managerProfileId: string;
  changedBy: string;
  previousManagerRole?: 'view' | 'contribute' | null;
}, now = Date.now()): Project {
  const managerProfileId = requiredText(input.managerProfileId, 'managerProfileId', 64);
  const changedBy = requiredText(input.changedBy, 'changedBy', 120);
  const current = getProject(input.projectId);
  if (!current) throw new Error('Project not found');
  if (current.managerProfileId === managerProfileId) return current;

  db.transaction(() => {
    const closed = db.prepare(`
      UPDATE project_manager_history
      SET effective_to = ?
      WHERE project_id = ? AND effective_to IS NULL
    `).run(now, input.projectId);
    if (closed.changes !== 1) throw new Error('Project manager history is inconsistent');
    db.prepare(`
      UPDATE projects
      SET manager_profile_id = ?, updated_at = ?
      WHERE id = ?
    `).run(managerProfileId, now, input.projectId);
    db.prepare(`
      INSERT INTO project_manager_history (
        id, project_id, profile_id, effective_from, effective_to, changed_by
      ) VALUES (?, ?, ?, ?, NULL, ?)
    `).run(uuid(), input.projectId, managerProfileId, now, changedBy);
    db.prepare(`
      DELETE FROM project_profile_grants
      WHERE project_id = ? AND profile_id = ?
    `).run(input.projectId, managerProfileId);
    if (input.previousManagerRole === 'view' || input.previousManagerRole === 'contribute') {
      db.prepare(`
        INSERT INTO project_profile_grants (
          project_id, profile_id, role, granted_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, profile_id) DO UPDATE SET
          role = excluded.role,
          granted_by = excluded.granted_by,
          updated_at = excluded.updated_at
      `).run(
        input.projectId,
        current.managerProfileId,
        input.previousManagerRole,
        changedBy,
        now,
        now,
      );
    } else {
      db.prepare(`
        DELETE FROM project_profile_grants
        WHERE project_id = ? AND profile_id = ?
      `).run(input.projectId, current.managerProfileId);
    }
  })();
  return getProject(input.projectId)!;
}

export function listProjectManagerHistory(projectId: string): ProjectManagerHistoryEntry[] {
  const rows = db.prepare(`
    SELECT id, project_id, profile_id, effective_from, effective_to, changed_by
    FROM project_manager_history
    WHERE project_id = ?
    ORDER BY effective_from, id
  `).all(projectId) as HistoryRow[];
  return rows.map(historyFromRow);
}

export function listProjectProfileGrants(projectId: string): ProjectProfileGrant[] {
  const rows = db.prepare(`
    SELECT project_id, profile_id, role, granted_by, created_at, updated_at
    FROM project_profile_grants
    WHERE project_id = ?
    ORDER BY profile_id COLLATE NOCASE
  `).all(projectId) as GrantRow[];
  return rows.map(grantFromRow);
}

export function grantProjectProfileAccess(input: {
  projectId: string;
  profileId: string;
  role: ProjectAccessRole;
  grantedBy: string;
}, now = Date.now()): ProjectProfileGrant | null {
  if (!(PROJECT_ACCESS_ROLES as readonly string[]).includes(input.role)) {
    throw new Error('Invalid Project access role');
  }
  const project = getProject(input.projectId);
  if (!project) throw new Error('Project not found');
  const profileId = requiredText(input.profileId, 'profileId', 64);
  const grantedBy = requiredText(input.grantedBy, 'grantedBy', 120);
  if (profileId === project.managerProfileId) {
    db.prepare('DELETE FROM project_profile_grants WHERE project_id = ? AND profile_id = ?')
      .run(input.projectId, profileId);
    return null;
  }
  db.prepare(`
    INSERT INTO project_profile_grants (
      project_id, profile_id, role, granted_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, profile_id) DO UPDATE SET
      role = excluded.role,
      granted_by = excluded.granted_by,
      updated_at = excluded.updated_at
  `).run(input.projectId, profileId, input.role, grantedBy, now, now);
  const row = db.prepare(`
    SELECT project_id, profile_id, role, granted_by, created_at, updated_at
    FROM project_profile_grants
    WHERE project_id = ? AND profile_id = ?
  `).get(input.projectId, profileId) as GrantRow;
  return grantFromRow(row);
}

export function revokeProjectProfileAccess(projectId: string, profileId: string): void {
  db.prepare(`
    DELETE FROM project_profile_grants
    WHERE project_id = ? AND profile_id = ?
  `).run(projectId, profileId);
}

export function getProfileProjectRole(projectId: string, profileId: string): ProjectAccessRole | null {
  const project = getProject(projectId);
  if (!project) return null;
  if (project.managerProfileId === profileId) return 'manage';
  const row = db.prepare(`
    SELECT role FROM project_profile_grants
    WHERE project_id = ? AND profile_id = ?
  `).get(projectId, profileId) as { role: ProjectAccessRole } | undefined;
  return row?.role ?? null;
}
