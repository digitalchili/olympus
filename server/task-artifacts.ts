import { createReadStream } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { Router, type Response } from 'express';
import type { Task, TaskAttachment, TaskMessage } from '../shared/types.js';
import { expandHomePrefix } from './paths.js';
import { LocalProfileError, LocalProfileRegistry, localProfileRegistry, type LocalProfileTarget } from './local-profiles.js';
import { requestProfile, taskBelongsToProfile } from './profile-context.js';

class TaskArtifactError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

interface OpenTaskArtifact extends TaskAttachment {
  handle: FileHandle;
  realPath: string;
}

interface TaskArtifactsRouterOptions {
  getTask: (id: string) => Task | undefined;
  registry?: LocalProfileRegistry;
}

function taskProfile(task: Task, registry: LocalProfileRegistry): LocalProfileTarget {
  return task.profile_name ? registry.require(task.profile_name) : registry.default();
}

function isSameOrChildPath(parentPath: string, childPath: string): boolean {
  const childRelativePath = relative(parentPath, childPath);
  return childRelativePath === '' || (!childRelativePath.startsWith('..') && !isAbsolute(childRelativePath));
}

function artifactPaths(content: string): string[] {
  const paths: string[] = [];
  const footer = /\n\n\[Attached files:\n([\s\S]*?)\]$/.exec(content);
  if (footer) {
    for (const line of footer[1].split('\n')) {
      if (line.startsWith('- ')) paths.push(line.slice(2).trim());
    }
  }
  for (const line of content.split(/\r?\n/)) {
    const media = /^MEDIA:(.+)$/.exec(line.trim());
    if (media) paths.push(media[1].trim());
  }
  return [...new Set(paths.filter(Boolean))];
}

async function approvedRoots(task: Task, profile: LocalProfileTarget): Promise<string[]> {
  const roots = [profile.workspaceDir, task.workdir].filter((path): path is string => Boolean(path));
  const resolved = await Promise.all(roots.map((path) => realpath(resolve(expandHomePrefix(path))).catch(() => null)));
  return resolved.filter((path): path is string => path !== null);
}

async function openTaskArtifact(
  task: Task,
  candidatePath: string,
  registry: LocalProfileRegistry,
): Promise<OpenTaskArtifact> {
  if (!candidatePath.trim()) {
    throw new TaskArtifactError(400, 'Artifact path is required', 'BAD_REQUEST');
  }

  const profile = taskProfile(task, registry);
  let realPath: string;
  try {
    realPath = await realpath(resolve(expandHomePrefix(candidatePath)));
  } catch {
    throw new TaskArtifactError(404, 'Artifact does not exist', 'ARTIFACT_NOT_FOUND');
  }

  const roots = await approvedRoots(task, profile);
  if (!roots.some((root) => isSameOrChildPath(root, realPath))) {
    throw new TaskArtifactError(403, 'Artifact is outside the task workspace', 'ARTIFACT_OUTSIDE_WORKSPACE');
  }

  const handle = await open(realPath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new TaskArtifactError(400, 'Artifact is not a regular file', 'ARTIFACT_NOT_FILE');
    }
    if (stats.size <= 0) {
      throw new TaskArtifactError(422, 'Artifact is empty', 'EMPTY_ARTIFACT');
    }
    return {
      handle,
      realPath,
      path: candidatePath,
      name: basename(realPath),
      size: stats.size,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function publishTaskAttachments(
  task: Task,
  content: string,
  registry: LocalProfileRegistry = localProfileRegistry,
): Promise<TaskAttachment[]> {
  const attachments = await Promise.all(artifactPaths(content).map(async (path) => {
    try {
      const artifact = await openTaskArtifact(task, path, registry);
      await artifact.handle.close();
      return { path: artifact.path, name: artifact.name, size: artifact.size };
    } catch {
      return null;
    }
  }));
  return attachments.filter((attachment): attachment is TaskAttachment => attachment !== null);
}

export async function publishMessageAttachments(
  task: Task,
  messages: TaskMessage[],
  registry: LocalProfileRegistry = localProfileRegistry,
): Promise<TaskMessage[]> {
  return Promise.all(messages.map(async (message) => {
    if (message.role !== 'assistant') return message;
    const attachments = await publishTaskAttachments(task, message.content, registry);
    return attachments.length > 0 ? { ...message, attachments } : message;
  }));
}

function sendArtifactError(res: Response, error: unknown): void {
  if (error instanceof TaskArtifactError || error instanceof LocalProfileError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: 'Failed to download artifact', code: 'ARTIFACT_DOWNLOAD_FAILED' });
}

export function createTaskArtifactsRouter(options: TaskArtifactsRouterOptions): Router {
  const router = Router();
  const registry = options.registry ?? localProfileRegistry;

  router.get('/:id/artifacts/download', async (req, res) => {
    let artifact: OpenTaskArtifact | null = null;
    try {
      const task = options.getTask(req.params.id);
      if (!task) throw new TaskArtifactError(404, 'Task not found', 'TASK_NOT_FOUND');

      const requestedProfile = requestProfile(req, registry);
      if (!taskBelongsToProfile(task, requestedProfile)) {
        throw new TaskArtifactError(404, 'Task not found', 'TASK_NOT_FOUND');
      }
      if (typeof req.query.path !== 'string') {
        throw new TaskArtifactError(400, 'Artifact path is required', 'BAD_REQUEST');
      }

      artifact = await openTaskArtifact(task, req.query.path, registry);
      res.status(200);
      res.attachment(artifact.name);
      res.type(artifact.name);
      res.setHeader('Content-Length', String(artifact.size));

      const stream = createReadStream(artifact.realPath, {
        fd: artifact.handle.fd,
        autoClose: true,
      });
      artifact = null;
      stream.on('error', (error) => {
        if (res.headersSent) res.destroy(error);
        else sendArtifactError(res, error);
      });
      stream.pipe(res);
    } catch (error) {
      if (artifact) await artifact.handle.close().catch(() => undefined);
      sendArtifactError(res, error);
    }
  });

  return router;
}