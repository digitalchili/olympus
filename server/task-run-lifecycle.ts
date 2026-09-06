import type { Task } from '../shared/types.js';
import { cancelCollaborationRun, getCollaborationRun } from './db/collaboration.js';
import { getRunStatus } from './live-chat.js';
import { cancelCodingVerification } from './coding-verification.js';

export type ActiveCollaboration = {
  runId: string;
  phase: 'proposal' | 'review' | 'synthesizing';
  cancelled: boolean;
  settled: boolean;
};

export const activeCollaborations = new Map<string, ActiveCollaboration>();
const activeTaskRuns = new Map<string, Set<Promise<void>>>();
const taskOperations = new Set<string>();
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

/** Hold message preparation and manual verification across their awaited work. */
export function claimTaskOperation(taskId: string, projectId?: string | null): (() => void) | null {
  return claimOperations([`task:${taskId}`, ...(projectId ? [`project:${projectId}`] : [])]);
}

/** Direct Project mutations share ownership with task preparation and checks. */
export function claimProjectOperation(projectId: string): (() => void) | null {
  return claimOperations([`project:${projectId}`]);
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
