import { Router } from 'express';
import type { ProjectCpService } from '../project-cp.js';
import { ProjectRepositoryBusyError } from '../project-cp.js';
import { getProjectRepositoryLink } from '../db/projects.js';
import { getTask } from '../db/queries.js';
import { requireTaskForProfile } from '../profile-context.js';
import type { StudioGitHubGateway } from './studio.js';
import { DEFAULT_PROFILE_NAME, type Task } from '../../shared/types.js';

interface ProjectTaskWorkspaceRouterOptions {
  projectCp: ProjectCpService;
  github?: StudioGitHubGateway;
}

function tokenProvider(github: StudioGitHubGateway | undefined) {
  if (!github?.installationToken) return undefined;
  return (installationId: number) => github.installationToken!(installationId);
}

export function createProjectTaskWorkspaceRouter(options: ProjectTaskWorkspaceRouterOptions): Router {
  const router = Router();
  const requireTask = requireTaskForProfile(getTask);

  router.post('/:id/messages', requireTask, async (req, res, next) => {
    const task = res.locals.task as Task;
    if (!task.project_id) return next();
    const repositoryLink = getProjectRepositoryLink(task.project_id);
    if (!repositoryLink || repositoryLink.mode !== 'branch_pr') return next();

    try {
      await options.projectCp.prepareTask({
        projectId: task.project_id,
        taskId: task.id,
        profileId: task.handling_profile_id ?? task.profile_name ?? DEFAULT_PROFILE_NAME,
        repositoryLink,
        tokenProvider: tokenProvider(options.github),
      });
      return next();
    } catch (error) {
      if (error instanceof ProjectRepositoryBusyError) {
        return res.status(423).json({
          error: `${error.activeTaskTitle} is currently using this Project repository. Finish or release it before starting this task.`,
          code: 'PROJECT_REPOSITORY_BUSY',
          activeTaskId: error.activeTaskId,
        });
      }
      const message = error instanceof Error ? error.message : 'Project repository preparation failed';
      return res.status(503).json({
        error: `Olympus could not prepare this Project repository: ${message}`,
        code: 'PROJECT_REPOSITORY_PREPARE_FAILED',
      });
    }
  });

  return router;
}
