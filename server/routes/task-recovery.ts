import { isVerifying } from '../coding-verification.js';
import { claimTaskOperation, hasActiveTaskRun, hasTaskOperation, hasProjectOperation } from '../task-run-lifecycle.js';
import { getRecovery, cancelRecovery } from '../run-recovery.js';
import { getLatestTaskAgentRun } from '../db/task-agent-runs.js';
import { Router } from 'express';
import type { AgentAdapter, TaskBackgroundWork } from '../adapters/types.js';
import { getTask } from '../db/queries.js';
import { getRunStatus } from '../live-chat.js';
import { requireTaskForProfile } from '../profile-context.js';
import type { Task } from '../../shared/types.js';

function taskIsRunning(task: Task): boolean {
  const live = getRunStatus(task.id);
  return hasActiveTaskRun(task.id) || isVerifying(task.id)
    || live?.status === 'streaming' || live?.status === 'compacting'
    || getLatestTaskAgentRun(task.id)?.status === 'streaming';
}

async function readInventory(adapter: Pick<AgentAdapter, 'getBackgroundWork'>, taskId: string): Promise<TaskBackgroundWork> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      adapter.getBackgroundWork?.(taskId) ?? Promise.resolve({ available: false, work: [] }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Background check timed out')), 5_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Admission is read-only. Cleanup requires a separate, explicit user action. */
export function createTaskRecoveryRouter(adapter: Pick<AgentAdapter, 'getBackgroundWork' | 'stopBackgroundWork'>): Router {
  const router = Router();
  router.get('/:id/background-work', requireTaskForProfile(getTask), async (_req, res) => {
    const task = res.locals.task as Task;
    try {
      const inventory = await readInventory(adapter, task.id);
      const canStop = Boolean(adapter.stopBackgroundWork && inventory.available && inventory.work.length
        && inventory.work.every(item => item.kind === 'process') && !taskIsRunning(task)
        && !hasTaskOperation(task.id) && !(task.project_id && hasProjectOperation(task.project_id)));
      res.json({ ...inventory, canStop, runId: getLatestTaskAgentRun(task.id)?.runId ?? null });
    } catch {
      res.status(503).json({ code: 'BACKGROUND_WORK_UNAVAILABLE', error: 'Could not check background work. Try again.' });
    }
  });
  router.post('/:id/background-work/stop', requireTaskForProfile(getTask), async (req, res) => {
    const task = res.locals.task as Task;
    const { processIds, runId } = req.body ?? {};
    if (!Array.isArray(processIds) || !processIds.length || processIds.length > 100
      || processIds.some(id => typeof id !== 'string' || !id || id.length > 160)
      || new Set(processIds).size !== processIds.length || !(runId === null || typeof runId === 'string')) {
      return res.status(400).json({ error: 'Select the background work to stop.' });
    }
    if (taskIsRunning(task)) return res.status(409).json({ code: 'TASK_RUN_ACTIVE', error: 'The agent is still working. Wait for it to finish or use Stop in chat.' });
    const release = claimTaskOperation(task.id, task.project_id);
    if (!release) return res.status(409).json({ code: 'TASK_RUN_ACTIVE', error: 'The task or Project is busy. Check again shortly.' });
    // Keep ownership even when the browser disconnects during process termination.
    try {
      const inventory = await readInventory(adapter, task.id);
      if (!inventory.available || !adapter.stopBackgroundWork) return res.status(503).json({ code: 'BACKGROUND_WORK_UNAVAILABLE', error: 'Background recovery is unavailable. Nothing was stopped.' });
      if (taskIsRunning(task) || inventory.work.some(item => item.kind !== 'process')) return res.status(409).json({ code: 'BACKGROUND_WORK_ACTIVE', error: 'The agent or a delegated worker is still working. Nothing was stopped.' });
      const currentIds = new Set(inventory.work.map(item => item.id));
      if (runId !== (getLatestTaskAgentRun(task.id)?.runId ?? null) || currentIds.size !== processIds.length || processIds.some(id => !currentIds.has(id))) {
        return res.status(409).json({ code: 'BACKGROUND_WORK_CHANGED', error: 'Background work changed. Check again before stopping it.' });
      }
      cancelRecovery(task.id, 'Background cleanup requested by user; send a message to continue');
      const result = await adapter.stopBackgroundWork(task.id, processIds);
      if (result.errorCode || !result.available || result.work.length) {
        return res.status(result.available ? 409 : 503).json({ code: result.errorCode ?? 'BACKGROUND_WORK_ACTIVE', error: 'Background work has not cleared. Check again; your files and message are kept.' });
      }
      return res.json({ cleared: true });
    } catch {
      return res.status(503).json({ code: 'BACKGROUND_WORK_UNAVAILABLE', error: 'Could not confirm background work stopped. Check again before continuing.' });
    } finally { release(); }
  });
  router.post('/:id/recovery/stop', requireTaskForProfile(getTask), (_req, res) => { cancelRecovery((res.locals.task as Task).id); res.json({ paused: true }); });
  router.get('/:id/recovery', requireTaskForProfile(getTask), (_req, res) => {
    const row = getRecovery((res.locals.task as Task).id);
    res.json({ recovery: row ? { state: row.state, attempts: row.attempts, deadlineAt: row.deadline_at, reason: row.reason, checkpoint: row.checkpoint_json ? JSON.parse(row.checkpoint_json) : null } : null });
  });
  router.post('/:id/messages', requireTaskForProfile(getTask), async (req, res, next) => {
    const task = res.locals.task as Task;
    if (typeof req.body?.content !== 'string' || !req.body.content.trim()) return next();
    const live = getRunStatus(task.id);
    if (hasActiveTaskRun(task.id) || isVerifying(task.id) || live?.status === 'streaming' || live?.status === 'compacting') {
      return res.status(409).json({ code: 'TASK_RUN_ACTIVE', error: 'This task already has a message in progress.' });
    }
    // Hold through downstream startup so two tabs cannot both pass an async probe.
    const release = claimTaskOperation(task.id, task.project_id);
    if (!release) return res.status(409).json({ code: 'TASK_RUN_ACTIVE', error: 'This task already has work in progress.' });
    res.locals.releaseTaskOperation = release;
    res.once('finish', release);
    res.once('close', () => { if (!res.locals.preparingProjectTask) release(); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const inventory = await Promise.race([
        adapter.getBackgroundWork?.(task.id) ?? Promise.resolve({ available: false, work: [], continuation: undefined }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('background check timeout')), 5_000); }),
      ]);
      if (res.destroyed) return;
      if (!inventory.available || !Array.isArray(inventory.work)) {
        return res.status(503).json({ code: 'BACKGROUND_WORK_UNAVAILABLE', error: 'Could not verify whether this task still has background work. Nothing new was started. Retry the check before continuing.' });
      }
      if (inventory.work.length > 0) {
        return res.status(409).json({ code: 'BACKGROUND_WORK_ACTIVE', error: 'This task has background work. Use the recovery controls above the message box to check or stop it, then send your message again.' });
      }
      if (req.body.recoveryOfRunId !== undefined) {
        const recovery = getRecovery(task.id);
        if (!recovery || recovery.state !== 'dispatching' || recovery.run_id !== req.body.recoveryOfRunId || getLatestTaskAgentRun(task.id)?.runId !== recovery.run_id || inventory.continuation?.status !== 'pending') {
          return res.status(409).json({ error: 'Recovery state changed; nothing new was started.' });
        }
        res.locals.recoveryContinuation = true;
        res.locals.recoveryKind = getLatestTaskAgentRun(task.id)?.kind;
      }
      return next();
    } catch {
      if (!res.destroyed) return res.status(503).json({ code: 'BACKGROUND_WORK_UNAVAILABLE', error: 'Could not verify background work. Nothing new was started.' });
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
  return router;
}
