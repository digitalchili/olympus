import { Router } from 'express';
import type { ProjectCpService } from '../project-cp.js';
import { ProjectRepositoryBusyError, ProjectRepositoryMergeConflictError, ProjectRepositoryCheckpointError } from '../project-cp.js';
import { getQueuedTaskMessage, consumeQueuedTaskMessage, restoreQueuedTaskMessage } from '../db/task-message-queue.js';
import { getProjectRepositoryLink } from '../db/projects.js';
import { getTask, updateTask } from '../db/queries.js';
import { broadcast } from '../events.js';
import { getRunStatus } from '../live-chat.js';
import { hasActiveTaskRun, hasTaskOperation, claimPreparedTaskWorkspace } from '../task-run-lifecycle.js';
import { requireTaskForProfile } from '../profile-context.js';
import type { StudioGitHubGateway } from './studio.js';
import { DEFAULT_PROFILE_NAME, type QueuedTaskMessage, type Task } from '../../shared/types.js';

interface ProjectTaskWorkspaceRouterOptions {
  projectCp: ProjectCpService;
  github?: StudioGitHubGateway;
}

function tokenProvider(github: StudioGitHubGateway | undefined) {
  if (!github?.installationToken) return undefined;
  return (installationId: number) => github.installationToken!(installationId);
}

/** A deliberately narrow task-chat command. Ordinary development requests still go to Hermes. */
export function commitPushRequest(content: unknown): { message: string } | null {
  if (typeof content !== 'string') return null;
  const match = /^\s*(?:\/commit(?:\s+and)?\s+push|commit\s*(?:&|and)\s*push|push\s*(?:&|and)\s*commit)(?:\s*[:—-]\s*(.+))?\s*[.!]?\s*$/i.exec(content);
  if (!match) return null;
  const requested = match[1]?.trim();
  return { message: requested || 'chore: checkpoint from task chat' };
}

export function createProjectTaskWorkspaceRouter(options: ProjectTaskWorkspaceRouterOptions): Router {
  const router = Router();
  const requireTask = requireTaskForProfile(getTask);

  router.post('/:id/messages', requireTask, async (req, res, next) => {
    const task = res.locals.task as Task;
    if (!task.project_id) return next();
    const repositoryLink = getProjectRepositoryLink(task.project_id);
    if (!repositoryLink || repositoryLink.mode !== 'branch_pr') return next();

    const content = req.body?.content;
    const command = commitPushRequest(content);
    const queuedMessageId = req.body?.queuedMessageId;
    const runStatus = getRunStatus(task.id)?.status;
    if (hasActiveTaskRun(task.id) || runStatus === 'streaming' || runStatus === 'compacting') {
      return res.status(409).json({ error: 'This task already has a message in progress' });
    }

    let consumedQueue: QueuedTaskMessage | undefined;
    let queueClaimed = false;
    const restoreConsumedQueue = () => {
      if (!consumedQueue || !queueClaimed) return;
      restoreQueuedTaskMessage(consumedQueue);
      delete res.locals.claimedQueuedTaskMessage;
    };
    if (queuedMessageId !== undefined) {
      if (typeof queuedMessageId !== 'string' || !queuedMessageId.trim()) {
        return res.status(400).json({ error: 'queuedMessageId must be a non-empty string' });
      }
      const saved = getQueuedTaskMessage(task.id);
      consumedQueue = saved?.id === queuedMessageId ? saved : undefined;
      if (!consumedQueue) {
        return res.status(409).json({ error: 'Queued message changed or no longer exists' });
      }
      if (typeof content !== 'string' || consumedQueue.content !== content) {
        restoreConsumedQueue();
        return res.status(409).json({ error: 'Queued message changed or no longer exists' });
      }
    }

    res.locals.preparingProjectTask = true;
    try {
      await options.projectCp.prepareTask({
        projectId: task.project_id,
        taskId: task.id,
        profileId: task.handling_profile_id ?? task.profile_name ?? DEFAULT_PROFILE_NAME,
        repositoryLink,
        tokenProvider: tokenProvider(options.github),
      });
    } catch (error) {
      restoreConsumedQueue();
      if (error instanceof ProjectRepositoryCheckpointError) {
        return res.status(409).json({ error: error.message, code: 'PROJECT_CHECKPOINT_PENDING', activeTaskId: error.activeTaskId });
      }
      if (error instanceof ProjectRepositoryMergeConflictError) {
        return res.status(409).json({ error: error.message, code: 'PROJECT_MERGE_CONFLICT', conflictingFiles: error.conflictingFiles, activeTaskId: error.activeTaskId });
      }
      if (error instanceof ProjectRepositoryBusyError) {
        return res.status(423).json({
          error: error.message,
          code: 'PROJECT_REPOSITORY_BUSY',
          activeTaskId: error.activeTaskId,
          activeTaskTitle: error.activeTaskTitle,
          activeTaskProfileId: error.activeTaskProfileId,
          reason: error.reason,
        });
      }
      const message = error instanceof Error ? error.message : 'Project repository preparation failed';
      return res.status(503).json({
        error: `Olympus could not prepare this Project repository: ${message}`,
        code: 'PROJECT_REPOSITORY_PREPARE_FAILED',
      });
    } finally {
      res.locals.preparingProjectTask = false;
      if (res.destroyed) {
        restoreConsumedQueue();
        res.locals.releaseTaskOperation?.();
      }
    }

    if (res.destroyed) return;
    const preparedTask = getTask(task.id);
    if (hasTaskOperation(task.id) && !claimPreparedTaskWorkspace(task.id, preparedTask?.workdir)) {
      restoreConsumedQueue();
      return res.status(409).json({ code: 'TASK_RUN_ACTIVE', error: 'This workspace still has work in progress. Try again after it finishes.' });
    }
    if (consumedQueue) {
      const claimed = consumeQueuedTaskMessage(task.id, consumedQueue.id);
      if (!claimed || claimed.content !== consumedQueue.content) {
        if (claimed) restoreQueuedTaskMessage(claimed);
        return res.status(409).json({ error: 'Queued message changed or no longer exists' });
      }
      consumedQueue = claimed;
      queueClaimed = true;
      res.locals.claimedQueuedTaskMessage = claimed;
    }
    if (!command) return next();

    res.locals.preparingProjectTask = true;
    try {
      const version = await options.projectCp.commitPush({
        projectId: task.project_id,
        taskId: task.id,
        repositoryLink,
        message: command.message,
        tokenProvider: tokenProvider(options.github),
      });
      await options.projectCp.releaseEditor({ projectId: task.project_id, taskId: task.id });
      const updatedTask = updateTask(task.id, { status: 'in_review' });
      if (!updatedTask) throw new Error('Task disappeared after Commit & Push');
      broadcast({ type: 'task_updated', task: updatedTask });
      return res.json({
        action: 'commit_push',
        version: {
          commitSha: version.commitSha,
          branchName: version.branchName,
          commitMessage: version.commitMessage,
          changedFiles: version.changedFiles,
        },
      });
    } catch (error) {
      restoreConsumedQueue();
      const message = error instanceof Error ? error.message : 'Project commit and push failed';
      const expectedConflict = /There are no changes|not the Project editor|will not push directly|Commit message/i.test(message);
      return res.status(expectedConflict ? 409 : 503).json({
        error: expectedConflict ? message : `Olympus could not commit and push this Project repository: ${message}`,
        code: expectedConflict ? 'PROJECT_COMMIT_PUSH_BLOCKED' : 'PROJECT_COMMIT_PUSH_FAILED',
      });
    } finally {
      res.locals.preparingProjectTask = false;
      if (res.destroyed) res.locals.releaseTaskOperation?.();
    }
  });

  return router;
}
