import type { AgentAdapter } from './adapters/types.js';
import type { Task } from '../shared/types.js';
import { getAllTasks, getTask } from './db/queries.js';
import { getProjectRepositoryLink } from './db/projects.js';
import { getProjectEditorForTask } from './db/project-cp.js';
import { getLatestTaskAgentRun } from './db/task-agent-runs.js';
import { getQueuedTaskMessage } from './db/task-message-queue.js';
import { claimRepositoryTask, enqueueRepositoryTask, finishRepositoryTask, listRepositoryOwners, queuedRepositoryTasks, removeUnstartedRepositoryTask, repositoryKey, repositoryOwner, repositoryOwnerForTask, setRepositoryBlocker, setRepositoryWait } from './db/repository-queue.js';
import { createRepositoryDevelopment, RepositoryHandoffError } from './repository-development.js';
import { claimTaskOperation, hasActiveTaskRun, hasTaskOperation } from './task-run-lifecycle.js';
import { getRunStatus } from './live-chat.js';
import { isVerifying } from './coding-verification.js';
import { hasUnansweredInteractions } from './db/interactions.js';
import { scheduleQueuedMessageDispatch } from './queued-message-dispatcher.js';
import { broadcast } from './events.js';
import { getRecovery } from './run-recovery.js';

const running = (taskId: string) => hasActiveTaskRun(taskId) || isVerifying(taskId)
  || ['streaming', 'compacting'].includes(getRunStatus(taskId)?.status ?? getLatestTaskAgentRun(taskId)?.status ?? '');

function stopped(taskId: string, runId: string): boolean {
  const latest = getLatestTaskAgentRun(taskId);
  const recovery = getRecovery(taskId);
  return latest?.runId === runId && (latest.status === 'stopped'
    || (recovery?.run_id === runId && recovery.state === 'blocked' && recovery.reason === 'Stopped by user'));
}

export function createRepositoryQueue(options: { rootDir: string; adapter: Pick<AgentAdapter, 'getBackgroundWork'>; canDispatch?: () => boolean }) {
  const development = createRepositoryDevelopment(options.rootDir);
  let ticking = false;
  const notify = (extra?: string) => {
    for (const id of new Set([...queuedRepositoryTasks(), ...(extra ? [extra] : [])])) {
      const task = getTask(id);
      if (task) broadcast({ type: 'task_updated', task });
    }
  };
  async function idle(taskId: string, stoppedRunId?: string): Promise<boolean> {
    const inventory = await options.adapter.getBackgroundWork?.(taskId);
    // Native inventory omits continuation when no journal has ever existed.
    if (!inventory?.available || inventory.work.length) return false;
    if (!inventory.continuation || inventory.continuation.status === 'none') return true;
    // Hermes retains a user-stop marker even after all work has ended. Keep
    // that saved journal intact, including undelivered results. The explicit
    // Stop prevents recovery; the fresh work inventory proves no writer remains.
    const receipt = inventory.checkpoint;
    return Boolean(stoppedRunId && stopped(taskId, stoppedRunId)
      && inventory.continuation.status === 'blocked'
      && inventory.continuation.reason === 'Stopped by user or interaction; explicit continuation is required.'
      && receipt?.saved && receipt.source === 'task-continuation-journal');
  }
  return {
    async admit(task: Task): Promise<boolean> {
      const link = task.project_id && getProjectRepositoryLink(task.project_id);
      if (!link || link.mode !== 'branch_pr') return true;
      const key = repositoryKey(link);
      enqueueRepositoryTask(key, task.id);
      const owner = repositoryOwner(key);
      if (owner) { notify(); return owner.taskId === task.id; }
      // Existing native work predates the queue. Never replace or interrupt it.
      for (const other of getAllTasks()) {
        if (other.id === task.id || !other.project_id) continue;
        const otherLink = getProjectRepositoryLink(other.project_id);
        const previousRun = getLatestTaskAgentRun(other.id);
        if (!otherLink || repositoryKey(otherLink) !== key || !previousRun) continue;
        if (running(other.id) || hasTaskOperation(other.id) || !(await idle(other.id, previousRun.runId).catch(() => false))
          || running(other.id) || hasTaskOperation(other.id)) {
          setRepositoryWait(task.id, other.id); notify(); return false;
        }
      }
      setRepositoryWait(task.id, null);
      const claimed = claimRepositoryTask(key, task.id);
      notify();
      return Boolean(claimed);
    },
    async checkpoint(task: Task, isStopped: () => boolean = () => false, onWaiting?: () => void): Promise<void> {
      if (!task.project_id || !repositoryOwnerForTask(task.id)) return;
      let announced = false;
      while (true) {
        if (isStopped()) throw new Error('Run stopped by user');
        const ready = await idle(task.id).catch(() => false);
        if (isStopped()) throw new Error('Run stopped by user');
        if (ready) break;
        if (!announced) { onWaiting?.(); announced = true; }
        // No expiry grants ownership to another writer. Stop remains available.
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      const lease = getProjectEditorForTask(task.project_id, task.id);
      if (!lease) throw new Error('This task’s saved workspace is unavailable.');
      // A saved publication owns its exact source fingerprint. Let that existing
      // protocol create its commit; the handoff will check the published commit.
      if (!getQueuedTaskMessage(task.id)?.publication) await development.checkpoint(lease);
    },
    async tick(): Promise<void> {
      if (ticking || options.canDispatch?.() === false) return;
      ticking = true;
      try {
        for (const owner of listRepositoryOwners()) {
          if (options.canDispatch?.() === false) break;
          if (running(owner.taskId) || hasTaskOperation(owner.taskId)) continue;
          const task = getTask(owner.taskId);
          if (!task) {
            // Missing metadata cannot prove that an old worker or its children died.
            setRepositoryBlocker(owner.key, owner.token, 'The earlier task is unavailable. Its background work must be checked before continuing.');
            notify(); continue;
          }
          if (!owner.runId) {
            // A removed initial request or completed publication shortcut never
            // started an agent. Release only after independently proving idle.
            const release = claimTaskOperation(task.id, task.project_id, task.workdir);
            if (!release) continue;
            try {
              if (!getQueuedTaskMessage(task.id) && await idle(task.id).catch(() => false)
                && !repositoryOwnerForTask(task.id)?.runId && !getQueuedTaskMessage(task.id)) {
                finishRepositoryTask(owner.key, owner.token); notify(task.id);
              }
            } finally { release(); }
            continue;
          }
          const latest = getLatestTaskAgentRun(task.id);
          if (latest?.runId !== owner.runId) continue;
          if (getQueuedTaskMessage(task.id)) continue;
          if (stopped(task.id, owner.runId)) {
            const release = claimTaskOperation(task.id, task.project_id, task.workdir);
            if (!release) continue;
            try {
              if (await idle(task.id, owner.runId).catch(() => false) && stopped(task.id, owner.runId)
                && !running(task.id) && !getQueuedTaskMessage(task.id)) {
                // Keep this task's workspace and history. Do not accept its
                // unfinished code; the next task uses the last accepted source.
                finishRepositoryTask(owner.key, owner.token);
              } else setRepositoryBlocker(owner.key, owner.token, 'This task was stopped. Waiting for its background work to finish before starting the next task.');
            } finally { release(); notify(task.id); }
            continue;
          }
          if (latest.status !== 'done' || getRecovery(task.id)?.state === 'blocked' || hasUnansweredInteractions(task.id, owner.runId)) {
            setRepositoryBlocker(owner.key, owner.token, hasUnansweredInteractions(task.id, owner.runId)
              ? 'This task needs your answer. Open it to reply.'
              : 'This task ended before it finished. Open it to continue, or stop it to let the next task start. Its work is saved.');
            notify(); continue;
          }
          const release = claimTaskOperation(task.id, task.project_id, task.workdir);
          if (!release) continue;
          try {
            if (!(await idle(task.id))) {
              setRepositoryBlocker(owner.key, owner.token, 'This task is finishing background work. The next task will start automatically when it is ready.');
              continue;
            }
            if (getLatestTaskAgentRun(task.id)?.runId !== owner.runId || getQueuedTaskMessage(task.id) || stopped(task.id, owner.runId)) continue;
            const link = task.project_id && getProjectRepositoryLink(task.project_id);
            const lease = task.project_id && getProjectEditorForTask(task.project_id, task.id);
            if (!link || !lease || repositoryKey(link) !== owner.key) throw new RepositoryHandoffError('This task’s project connection or saved workspace is unavailable. Check its Project settings.');
            await development.accept(task, owner.runId, lease, link);
            finishRepositoryTask(owner.key, owner.token);
          } catch (error) {
            setRepositoryBlocker(owner.key, owner.token, error instanceof RepositoryHandoffError ? error.message
              : 'Olympus could not check this task’s saved code. Its work is safe; the next task is waiting.');
          } finally { release(); notify(task.id); }
        }
        for (const taskId of queuedRepositoryTasks()) {
          if (!getQueuedTaskMessage(taskId)) { removeUnstartedRepositoryTask(taskId); continue; }
          if (options.canDispatch?.() !== false) scheduleQueuedMessageDispatch(taskId);
        }
        notify();
      } finally { ticking = false; }
    },
  };
}
export type RepositoryQueue = ReturnType<typeof createRepositoryQueue>;
