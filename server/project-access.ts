import type { ProjectAccessRole } from '../shared/types.js';
import { getProfileProjectRole } from './db/projects.js';

const ACCESS_RANK: Record<ProjectAccessRole, number> = {
  view: 1,
  contribute: 2,
  manage: 3,
};

export class ProjectAccessError extends Error {
  public readonly status = 404;
  public readonly code = 'PROJECT_NOT_FOUND';

  constructor() {
    super('Project not found');
    this.name = 'ProjectAccessError';
  }
}

export function requireProfileProjectAccess(
  projectId: string,
  profileId: string,
  minimum: ProjectAccessRole = 'view',
): ProjectAccessRole {
  const role = getProfileProjectRole(projectId, profileId);
  if (!role || ACCESS_RANK[role] < ACCESS_RANK[minimum]) throw new ProjectAccessError();
  return role;
}

export function canProfileAccessProject(
  projectId: string,
  profileId: string,
  minimum: ProjectAccessRole = 'view',
): boolean {
  try {
    requireProfileProjectAccess(projectId, profileId, minimum);
    return true;
  } catch (error) {
    if (error instanceof ProjectAccessError) return false;
    throw error;
  }
}
