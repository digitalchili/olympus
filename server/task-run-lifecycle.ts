import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Task } from '../shared/types.js';
import { cancelCollaborationRun, getCollaborationRun } from './db/collaboration.js';
import { getRunStatus } from './live-chat.js';
import { getAllTasks } from './db/queries.js';
import { cancelCodingVerification, isVerifying } from './coding-verification.js';

export type ActiveCollaboration = {
  runId: string;
  phase: 'proposal' | 'review' | 'synthesizing';
  cancelled: boolean;
  settled: boolean;
};

export const activeCollaborations = new Map<string, ActiveCollaboration>();
const activeTaskRuns = new Map<string, Set<Promise<void>>>();
const taskOperations = new Set<string>();
const taskOperationKeys = new Map<string, string[]>();
const projectTaskOperations = new Map<string, number>();
let activeOperations = 0;

function claimOperations(keys: string[]): (() => void) | null {
  if (keys.some(key => taskOperations.has(key))) return null;
  keys.forEach(key => taskOperations.add(key));
  activeOperations += 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      keys.forEach(key => taskOperations.delete(key));
      activeOperations -= 1;
    }
  };
}

function workspacePath(workdir: string): string {
  try { return realpathSync(workdir); } catch { return resolve(workdir); }
}

/** Legacy and manually selected folders can still be shared across task IDs. */
export function hasActiveWorkspaceRun(taskId: string, workdir?: string | null): boolean {
  if (!workdir) return false;
  const path = workspacePath(workdir);
  return getAllTasks().some(task => {
    if (task.id === taskId || !task.workdir) return false;
    const live = getRunStatus(task.id);
    const collaboration = activeCollaborations.get(task.id);
    const busy = hasTaskOperation(task.id) || hasActiveTaskRun(task.id) || isVerifying(task.id)
      || live?.status === 'streaming' || live?.status === 'compacting' || (collaboration && !collaboration.settled);
    return busy && workspacePath(task.workdir) === path;
  });
}

/** Attach a freshly prepared workspace to the request's existing task claim. */
export function claimPreparedTaskWorkspace(taskId: string, workdir?: string | null): boolean {
  if (!workdir) return true;
  const keys = taskOperationKeys.get(taskId);
  if (!keys || hasActiveWorkspaceRun(taskId, workdir)) return false;
  const key = `workspace:${workspacePath(workdir)}`;
  if (keys.includes(key)) return true;
  if (taskOperations.has(key)) return false;
  keys.push(key); taskOperations.add(key);
  return true;
}

/** Hold message preparation and manual verification across their awaited work. */
export function claimTaskOperation(taskId: string, projectId?: string | null, workdir?: string | null): (() => void) | null {
  if (projectId && taskOperations.has(`project-config:${projectId}`)) return null;
  if (hasActiveWorkspaceRun(taskId, workdir)) return null;
  const keys = [`task:${taskId}`, ...(workdir ? [`workspace:${workspacePath(workdir)}`] : [])];
  const release = claimOperations(keys);
  if (!release) return null;
  taskOperationKeys.set(taskId, keys);
  if (projectId) projectTaskOperations.set(projectId, (projectTaskOperations.get(projectId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    taskOperationKeys.delete(taskId);
    release();
    if (projectId) {
      const remaining = (projectTaskOperations.get(projectId) ?? 1) - 1;
      if (remaining) projectTaskOperations.set(projectId, remaining);
      else projectTaskOperations.delete(projectId);
    }
  };
}

/** Shared baseline Git operations do not own independent task workspaces. */
export function claimProjectOperation(projectId: string): (() => void) | null {
  return claimOperations([`project:${projectId}`]);
}

/** Repository configuration must not change during workspace preparation or sync. */
export function claimProjectConfigurationOperation(projectId: string): (() => void) | null {
  if (projectTaskOperations.has(projectId)) return null;
  return claimOperations([`project:${projectId}`, `project-config:${projectId}`]);
}

export function hasTaskOperation(taskId: string): boolean {
  return taskOperations.has(`task:${taskId}`);
}

export function hasProjectOperation(projectId: string): boolean {
  return taskOperations.has(`project:${projectId}`);
}

export function getActiveOperationCount(): number {
  return activeOperations;
}

export function getActiveTaskRunCount(): number {
  let count = 0;
  for (const runs of activeTaskRuns.values()) count += runs.size;
  return count;
}

export function hasActiveTaskRun(taskId: string): boolean {
  return (activeTaskRuns.get(taskId)?.size ?? 0) > 0;
}

export function trackTaskRun(taskId: string, work: Promise<void>): Promise<void> {
  let runs = activeTaskRuns.get(taskId);
  if (!runs) {
    runs = new Set();
    activeTaskRuns.set(taskId, runs);
  }

  const tracked = work.finally(() => {
    runs.delete(tracked);
    if (runs.size === 0 && activeTaskRuns.get(taskId) === runs) activeTaskRuns.delete(taskId);
  });
  runs.add(tracked);
  return tracked;
}

interface TaskRunCancellationAdapter {
  interruptChat(sessionId: string, reason?: string): Promise<boolean>;
  interruptChatForProfile(profileId: string, sessionId: string, reason?: string): Promise<boolean>;
}

export async function cancelTaskRunForDeletion(
  task: Task,
  adapter: TaskRunCancellationAdapter,
): Promise<void> {
  const reason = 'Task deleted';
  const collaboration = activeCollaborations.get(task.id);
  const live = getRunStatus(task.id);
  await cancelCodingVerification(task.id, reason);

  if (collaboration && !collaboration.cancelled) {
    collaboration.cancelled = true;
    collaboration.settled = true;
    const runningContributions = getCollaborationRun(collaboration.runId)?.contributions
      .filter((contribution) => contribution.status === 'running') ?? [];
    cancelCollaborationRun(collaboration.runId, reason);

    if (collaboration.phase === 'synthesizing') {
      await Promise.allSettled([adapter.interruptChat(task.id, reason)]);
    } else {
      await Promise.allSettled(runningContributions.map((contribution) => (
        adapter.interruptChatForProfile(contribution.profile_id, contribution.session_id, reason)
      )));
    }

    activeCollaborations.delete(task.id);
  } else if (live?.status === 'streaming' || live?.status === 'compacting') {
    await Promise.allSettled([adapter.interruptChat(task.id, reason)]);
  }

  for (;;) {
    const activeRuns = activeTaskRuns.get(task.id);
    if (!activeRuns?.size) return;
    await Promise.allSettled(Array.from(activeRuns));
  }
}
