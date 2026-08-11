import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { v4 as uuid } from 'uuid';
import type { Project, ProjectAccessRole, ProjectRepositoryLink } from '../../shared/types.js';
import {
  createProject,
  createProjectWithRepository,
  deleteProjectRepositoryLink,
  getProject,
  getProjectRepositoryLink,
  grantProjectProfileAccess,
  listProjectManagerHistory,
  listProjectProfileGrants,
  listProjects,
  reassignProject,
  revokeProjectProfileAccess,
  updateProject,
  updateProjectWithRepository,
  upsertProjectRepositoryLink,
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
import type { StudioGitHubGateway } from './studio.js';
import { getGitHubInstallation } from '../db/studio-projects.js';
import {
  PROJECT_REFERENCE_MAX_BYTES,
  createProjectReferenceFromQuarantine,
  deleteProjectReference,
  getProjectReference,
  listProjectReferenceChunks,
  listProjectReferences,
  publicProjectReference,
  reindexProjectReference,
  searchProjectReferences,
  validateProjectReferenceCandidate,
} from '../db/project-references.js';
import { resolveProjectReferencesDir } from '../paths.js';

interface ProjectsRouterOptions {
  registry?: LocalProfileRegistry;
  now?: () => number;
  changedBy?: string;
  github?: StudioGitHubGateway;
}

type ManagerProjection = {
  id: string;
  displayName: string;
  provider: string | null;
  model: string | null;
};

type ProjectResponse = Project & { manager: ManagerProjection; repositoryLink: ProjectRepositoryLink | null };

function routeId(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}


function linkRequest(body: unknown): { installationId: number; repositoryId: number } | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const installationId = Number(record.installationId);
  const repositoryId = Number(record.repositoryId);
  return Number.isSafeInteger(installationId) && installationId > 0
    && Number.isSafeInteger(repositoryId) && repositoryId > 0
    ? { installationId, repositoryId }
    : null;
}

async function verifiedRepositoryLink(
  github: StudioGitHubGateway | undefined,
  input: { installationId: number; repositoryId: number },
) {
  if (!github) throw Object.assign(new Error('GitHub gateway is not configured'), { statusCode: 503 });
  if (!getGitHubInstallation(input.installationId)) {
    throw Object.assign(new Error('GitHub installation was not found'), { statusCode: 404 });
  }
  const repositories = await github.listRepositories(input.installationId);
  const repository = repositories.find((candidate) => candidate.id === input.repositoryId);
  if (!repository) throw Object.assign(new Error('Repository is not available to this GitHub installation'), { statusCode: 404 });
  return repository;
}

function sendError(res: Response, error: unknown): Response {
  if (error instanceof ProjectAccessError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error instanceof LocalProfileError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: 'Project reference upload was rejected', code: 'PROJECT_REFERENCE_REJECTED' });
  }
  const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: unknown }).statusCode) : null;
  const message = error instanceof Error ? error.message : 'Project request failed';
  if (statusCode === 404) return res.status(404).json({ error: message, code: 'PROJECT_REPOSITORY_NOT_FOUND' });
  if (statusCode === 503) return res.status(503).json({ error: message, code: 'GITHUB_GATEWAY_UNAVAILABLE' });
  if (/UNIQUE constraint failed: project_repository_links\.provider, project_repository_links\.provider_repository_id/i.test(message)) return res.status(409).json({ error: 'Repository is already linked to another Project', code: 'PROJECT_REPOSITORY_LINK_EXISTS' });
  if (/Project reference.*(safe filename|empty|size limit|not supported|does not match|archive|MIME)|unsupported Project reference|exceeds/i.test(message)) {
    return res.status(400).json({ error: message, code: 'PROJECT_REFERENCE_REJECTED' });
  }
  if (/Project reference not found/i.test(message)) return res.status(404).json({ error: 'Project reference not found', code: 'PROJECT_REFERENCE_NOT_FOUND' });
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

function requireProjectRouteAccess(req: Request, registry: LocalProfileRegistry, projectId: string, role: ProjectAccessRole): void {
  if (!getProject(projectId)) throw new Error('Project not found');
  const actor = profileActor(req, registry);
  if (actor) requireProfileProjectAccess(projectId, actor, role);
}

async function uploadReferenceFile(req: Request, res: Response, projectId: string): Promise<Express.Multer.File> {
  const root = resolveProjectReferencesDir();
  const quarantineDir = resolve(root, projectId, 'quarantine');
  if (!quarantineDir.startsWith(resolve(root))) throw new Error('Invalid Project reference quarantine path');
  await mkdir(quarantineDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => callback(null, quarantineDir),
      filename: (_req, file, callback) => callback(null, `${Date.now()}-${uuid()}${file.originalname ? '-' : ''}${file.originalname}`),
    }),
    limits: { fileSize: PROJECT_REFERENCE_MAX_BYTES, files: 1, fields: 0, parts: 2 },
    fileFilter: (_req, file, callback) => {
      try {
        validateProjectReferenceCandidate({ originalFilename: file.originalname, mimeType: file.mimetype, sizeBytes: 1 });
        callback(null, true);
      } catch (error) {
        callback(error as Error);
      }
    },
  }).single('file');
  await new Promise<void>((resolvePromise, reject) => {
    upload(req, res, (error) => error ? reject(error) : resolvePromise());
  });
  if (!req.file) throw new Error('Project reference file is required');
  return req.file;
}

async function projectResponse(project: Project, registry: LocalProfileRegistry): Promise<ProjectResponse> {
  const target = registry.get(project.managerProfileId);
  if (!target) {
    return {
      ...project,
      repositoryLink: getProjectRepositoryLink(project.id),
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
      repositoryLink: getProjectRepositoryLink(project.id),
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
      repositoryLink: getProjectRepositoryLink(project.id),
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
  const github = options.github;

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
      const requestedLink = req.body?.repositoryLink === null || req.body?.repositoryLink === undefined ? null : linkRequest(req.body.repositoryLink);
      if (req.body?.repositoryLink !== undefined && req.body?.repositoryLink !== null && !requestedLink) {
        return res.status(400).json({ error: 'A valid repositoryLink installationId and repositoryId are required', code: 'INVALID_PROJECT_REPOSITORY_LINK' });
      }
      const repository = requestedLink ? await verifiedRepositoryLink(github, requestedLink) : null;
      const timestamp = now();
      const createInput = { name, purpose, managerProfileId, changedBy };
      const project = requestedLink && repository
        ? createProjectWithRepository(createInput, {
          installationId: requestedLink.installationId,
          repository,
        }, timestamp)
        : createProject(createInput, timestamp);
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
      const hasRepositoryLink = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'repositoryLink');
      if (name === undefined && purpose === undefined && !hasRepositoryLink) {
        return res.status(400).json({ error: 'name, purpose, or repositoryLink is required', code: 'INVALID_PROJECT' });
      }
      let requestedRepository: Awaited<ReturnType<typeof verifiedRepositoryLink>> | null = null;
      let requestedRepositoryInstallationId: number | null = null;
      if (hasRepositoryLink && req.body.repositoryLink !== null) {
        const requestedLink = linkRequest(req.body.repositoryLink);
        if (!requestedLink) return res.status(400).json({ error: 'A valid repositoryLink installationId and repositoryId are required', code: 'INVALID_PROJECT_REPOSITORY_LINK' });
        requestedRepository = await verifiedRepositoryLink(github, requestedLink);
        requestedRepositoryInstallationId = requestedLink.installationId;
      }
      const timestamp = now();
      const project = hasRepositoryLink
        ? updateProjectWithRepository(
          projectId,
          { name, purpose },
          req.body.repositoryLink === null ? null : {
            installationId: requestedRepositoryInstallationId!,
            repository: requestedRepository!,
          },
          timestamp,
        )
        : updateProject(projectId, { name, purpose }, timestamp);
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

  router.get('/:id/repository', (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      if (!getProject(projectId)) return res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      const actor = profileActor(req, registry);
      if (actor) requireProfileProjectAccess(projectId, actor, 'view');
      return res.json({ repositoryLink: getProjectRepositoryLink(projectId) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.put('/:id/repository', async (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      if (!getProject(projectId)) return res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      const actor = profileActor(req, registry);
      if (actor) requireProfileProjectAccess(projectId, actor, 'manage');
      const requestedLink = linkRequest(req.body);
      if (!requestedLink) return res.status(400).json({ error: 'A valid installationId and repositoryId are required', code: 'INVALID_PROJECT_REPOSITORY_LINK' });
      const repository = await verifiedRepositoryLink(github, requestedLink);
      const repositoryLink = upsertProjectRepositoryLink(projectId, requestedLink.installationId, repository, now());
      return res.json({ repositoryLink });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.delete('/:id/repository', (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      if (!getProject(projectId)) return res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
      const actor = profileActor(req, registry);
      if (actor) requireProfileProjectAccess(projectId, actor, 'manage');
      deleteProjectRepositoryLink(projectId);
      return res.status(204).end();
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/:id/references', (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      requireProjectRouteAccess(req, registry, projectId, 'view');
      return res.json({ references: listProjectReferences(projectId) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/:id/references', async (req, res) => {
    let file: Express.Multer.File | undefined;
    try {
      const projectId = routeId(req.params.id);
      requireProjectRouteAccess(req, registry, projectId, 'contribute');
      file = await uploadReferenceFile(req, res, projectId);
      const reference = await createProjectReferenceFromQuarantine({
        projectId,
        quarantinePath: file.path,
        originalFilename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        now: now(),
      });
      return res.status(201).json({ reference: publicProjectReference(reference) });
    } catch (error) {
      if (file?.path) void rm(file.path, { force: true });
      return sendError(res, error);
    }
  });

  router.get('/:id/references/search', (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      requireProjectRouteAccess(req, registry, projectId, 'view');
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      return res.json({ results: searchProjectReferences(projectId, q) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/:id/references/:referenceId', (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      const referenceId = routeId(req.params.referenceId);
      requireProjectRouteAccess(req, registry, projectId, 'view');
      const reference = getProjectReference(projectId, referenceId);
      if (!reference || reference.status === 'deleted') throw new Error('Project reference not found');
      return res.json({
        reference: publicProjectReference(reference),
        chunks: listProjectReferenceChunks(projectId, referenceId),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/:id/references/:referenceId/download', (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      const referenceId = routeId(req.params.referenceId);
      requireProjectRouteAccess(req, registry, projectId, 'view');
      const reference = getProjectReference(projectId, referenceId);
      if (!reference || reference.status === 'deleted') throw new Error('Project reference not found');
      res.download(reference.storagePath, reference.originalFilename);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/references/:referenceId/reindex', async (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      const referenceId = routeId(req.params.referenceId);
      requireProjectRouteAccess(req, registry, projectId, 'contribute');
      const reference = await reindexProjectReference(projectId, referenceId, now());
      return res.json({ reference: publicProjectReference(reference) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.delete('/:id/references/:referenceId', (req, res) => {
    try {
      const projectId = routeId(req.params.id);
      const referenceId = routeId(req.params.referenceId);
      requireProjectRouteAccess(req, registry, projectId, 'manage');
      deleteProjectReference(projectId, referenceId, now());
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