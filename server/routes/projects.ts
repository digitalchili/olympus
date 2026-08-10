import { Router, type Request, type Response } from 'express';
import type { Project, ProjectAccessRole } from '../../shared/types.js';
import {
  createProject,
  getProject,
  grantProjectProfileAccess,
  listProjectManagerHistory,
  listProjectProfileGrants,
  listProjects,
  reassignProject,
  revokeProjectProfileAccess,
  updateProject,
} from '../db/projects.js';
import { getTask, getTasksForProject } from '../db/queries.js';
import { addProjectClient, initSSE, sendEvent } from '../events.js';
import { getRunStatuses } from '../live-chat.js';
import {
  LocalProfileError,
  localProfileRegistry,
  readProfileSettings,
  type LocalProfileRegistry,
} from '../local-profiles.js';
import { requestProfile } from '../profile-context.js';
import {
  canProfileAccessProject,
  ProjectAccessError,
  requireProfileProjectAccess,
} from '../project-access.js';

interface ProjectsRouterOptions {
  registry?: LocalProfileRegistry;
  now?: () => number;
  changedBy?: string;
}

type ManagerProjection = {
  id: string;
  displayName: string;
  provider: string | null;
  model: string | null;
};

type ProjectResponse = Project & { manager: ManagerProjection };

function routeId(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

function sendError(res: Response, error: unknown): Response {
  if (error instanceof ProjectAccessError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error instanceof LocalProfileError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  const message = error instanceof Error ? error.message : 'Project request failed';
  if (/Project not found/i.test(message)) return res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
  if (/already exists/i.test(message)) return res.status(409).json({ error: message, code: 'PROJECT_NAME_EXISTS' });
  if (/required|too long|invalid control|invalid.*role/i.test(message)) return res.status(400).json({ error: message, code: 'INVALID_PROJECT' });
  return res.status(500).json({ error: 'Project request failed', code: 'PROJECT_ERROR' });
}

/**
 * Project routes have two caller modes in v1:
 * - no profile query: installation operator, already protected by the local or
 *   reverse-proxy authentication boundary, with global Project visibility;
 * - explicit ?profile=: a profile-originated call, restricted by Project ACL.
 *
 * The active profile in the browser is routing context, not user identity. The
 * global client API therefore intentionally omits the profile query.
 */
function profileActor(req: Request, registry: LocalProfileRegistry): string | null {
  if (req.query.profile === undefined) return null;
  return requestProfile(req, registry).id;
}

async function projectResponse(project: Project, registry: LocalProfileRegistry): Promise<ProjectResponse> {
  const target = registry.get(project.managerProfileId);
  if (!target) {
    return {
      ...project,
      manager: {
        id: project.managerProfileId,
        displayName: project.managerProfileId,
        provider: null,
        model: null,
      },
    };
  }
  try {
    const settings = await readProfileSettings(target);
    return {
      ...project,
      manager: {
        id: target.id,
        displayName: settings.displayName,
        provider: settings.provider,
        model: settings.model,
      },
    };
  } catch {
    return {
      ...project,
      manager: {
        id: target.id,
        displayName: target.displayName,
        provider: null,
        model: null,
      },
    };
  }
}

export function createProjectsRouter(options: ProjectsRouterOptions = {}): Router {
  const router = Router();
  const registry = options.registry ?? localProfileRegistry;
  const now = options.now ?? Date.now;
  const changedBy = options.changedBy ?? 'local-user';

  router.get('/', async (req, res) => {
    try {
      const actor = profileActor(req, registry);
      const visible = actor
        ? listProjects().filter((project) => canProfileAccessProject(project.id, actor, 'view'))
        : listProjects();
      const projects = await Promise.all(visible.map((project) => projectResponse(project, registry)));
      return res.json({ projects });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/', async (req, res) => {
    try {
      if (profileActor(req, registry)) {
        return res.status(403).json({
          error: 'Only the installation operator can create Projects',
          code: 'PROJECT_OPERATOR_ONLY',
        });
      }
      const name = typeof req.body?.name === 'string' ? req.body.name : '';
      const purpose = typeof req.body?.purpose === 'string' ? req.body.purpose : '';
      const managerProfileId = typeof req.body?.managerProfileId === 'string'
        ? req.body.managerProfileId.trim()
        : '';
      registry.requireActive(managerProfileId);
      const project = createProject({ name, purpose, managerProfileId, changedBy }, now());
      return res.status(201).json({ project: await projectResponse(project, registry) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      if (!getProject(projectId)) {
        return res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      }
      const actor = profileActor(req, registry);
      if (actor) requireProfileProjectAccess(projectId, actor, 'manage');
      const name = typeof req.body?.name === 'string' ? req.body.name : undefined;
      const purpose = typeof req.body?.purpose === 'string' ? req.body.purpose : undefined;
      if (name === undefined && purpose === undefined) {
        return res.status(400).json({ error: 'name or purpose is required', code: 'INVALID_PROJECT' });
      }
      const project = updateProject(projectId, { name, purpose }, now());
      return res.json({ project: await projectResponse(project, registry) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/:id/grants', (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      if (!getProject(projectId)) {
        return res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      }
      const actor = profileActor(req, registry);
      if (actor) requireProfileProjectAccess(projectId, actor, 'manage');
      return res.json({ grants: listProjectProfileGrants(projectId) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.put('/:id/grants/:profileId', (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      const project = getProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      const actor = profileActor(req, registry);
      if (actor) requireProfileProjectAccess(projectId, actor, 'manage');
      const profileId = routeId(req.params.profileId).trim();
      if (profileId === project.managerProfileId) {
        return res.status(400).json({ error: 'The Project manager already has manage access', code: 'PROJECT_MANAGER_ACCESS_IMPLICIT' });
      }
      registry.requireActive(profileId);
      const grant = grantProjectProfileAccess({
        projectId,
        profileId,
        role: req.body?.role as ProjectAccessRole,
        grantedBy: actor ?? changedBy,
      }, now());
      return res.json({ grant });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.delete('/:id/grants/:profileId', (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      const project = getProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      const actor = profileActor(req, registry);
      if (actor) requireProfileProjectAccess(projectId, actor, 'manage');
      const profileId = routeId(req.params.profileId).trim();
      if (profileId === project.managerProfileId) {
        return res.status(400).json({ error: 'The Project manager has implicit manage access', code: 'PROJECT_MANAGER_ACCESS_IMPLICIT' });
      }
      revokeProjectProfileAccess(projectId, profileId);
      return res.status(204).end();
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const project = getProject(routeId(req.params.id));
      if (!project) return res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      const actor = profileActor(req, registry);
      if (actor) requireProfileProjectAccess(project.id, actor, 'view');
      return res.json({
        project: await projectResponse(project, registry),
        managerHistory: listProjectManagerHistory(project.id),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/:id/tasks', (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      if (!getProject(projectId)) {
        return res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      }
      const actor = profileActor(req, registry);
      if (actor) requireProfileProjectAccess(projectId, actor, 'view');
      return res.json({ tasks: getTasksForProject(projectId) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/:id/events', (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      if (!getProject(projectId)) {
        return res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      }
      const actor = profileActor(req, registry);
      if (actor) requireProfileProjectAccess(projectId, actor, 'view');
      const runs = getRunStatuses().filter((run) => getTask(run.taskId)?.project_id === projectId);
      initSSE(res);
      addProjectClient(res, projectId);
      sendEvent(res, { type: 'task_runs_snapshot', runs });
      return undefined;
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/:id/reassign', async (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      const current = getProject(projectId);
      if (!current) return res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      const actor = profileActor(req, registry);
      if (actor) requireProfileProjectAccess(projectId, actor, 'manage');
      const managerProfileId = typeof req.body?.managerProfileId === 'string'
        ? req.body.managerProfileId.trim()
        : '';
      registry.requireActive(managerProfileId);
      const previousManagerRole = req.body?.previousManagerRole as unknown;
      if (previousManagerRole !== undefined
        && previousManagerRole !== null
        && previousManagerRole !== 'view'
        && previousManagerRole !== 'contribute') {
        return res.status(400).json({
          error: 'previousManagerRole must be view, contribute, or null',
          code: 'INVALID_PROJECT_ACCESS_ROLE',
        });
      }

      const changeActor = actor ?? changedBy;
      const project = reassignProject({
        projectId,
        managerProfileId,
        changedBy: changeActor,
        previousManagerRole: previousManagerRole as 'view' | 'contribute' | null | undefined,
      }, now());
      return res.json({ project: await projectResponse(project, registry) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}
