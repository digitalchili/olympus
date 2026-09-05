import { isVerifying } from '../coding-verification.js';
import { getRecovery, cancelRecovery } from '../run-recovery.js';
import { getLatestTaskAgentRun } from '../db/task-agent-runs.js';
import { Router } from 'express';
import type { AgentAdapter } from '../adapters/types.js';
import { getTask } from '../db/queries.js';
import { getRunStatus } from '../live-chat.js';
import { requireTaskForProfile } from '../profile-context.js';
import type { Task } from '../../shared/types.js';

/** Before queue claims, checkout changes or agent startup; never stops existing work. */
export function createTaskRecoveryRouter(adapter: Pick<AgentAdapter, 'getBackgroundWork'>): Router {
  const router = Router();
  const starting = new Set<string>();
  router.post('/:id/recovery/stop', requireTaskForProfile(getTask), (_req, res) => { cancelRecovery((res.locals.task as Task).id); res.json({ paused: true }); });
  router.get('/:id/recovery', requireTaskForProfile(getTask), (_req, res) => {
    const row = getRecovery((res.locals.task as Task).id);
    res.json({ recovery: row ? { state: row.state, attempts: row.attempts, deadlineAt: row.deadline_at, reason: row.reason, checkpoint: row.checkpoint_json ? JSON.parse(row.checkpoint_json) : null } : null });
  });
  router.post('/:id/messages', requireTaskForProfile(getTask), async (req, res, next) => {
    const task = res.locals.task as Task;
    if (typeof req.body?.content !== 'string' || !req.body.content.trim()) return next();
    const live = getRunStatus(task.id);
    if (isVerifying(task.id) || starting.has(task.id) || live?.status === 'streaming' || live?.status === 'compacting') {
      return res.status(409).json({ code: 'TASK_RUN_ACTIVE', error: 'This task already has a message in progress.' });
    }
    // Hold through downstream startup so two tabs cannot both pass an async probe.
    starting.add(task.id);
    const release = () => starting.delete(task.id);
    res.once('finish', release);
    res.once('close', release);
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
        return res.status(409).json({ code: 'BACKGROUND_WORK_ACTIVE', error: 'This task still has background work. Wait for it to finish or reconcile it before continuing; nothing new was started.' });
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
