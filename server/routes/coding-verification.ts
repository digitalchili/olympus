import { acquireProfileWork } from '../profile-deletion.js';
import { claimTaskOperation, hasActiveTaskRun, trackTaskRun } from '../task-run-lifecycle.js';
import { Router } from 'express';
import { getTask, updateTask } from '../db/queries.js';
import { getLatestTaskAgentRun } from '../db/task-agent-runs.js';
import { requireTaskForProfile } from '../profile-context.js';
import { getRunStatus } from '../live-chat.js';
import type { AgentAdapter } from '../adapters/types.js';
import { codingReviewAllowed, isVerifying, readCodingEvidence, verifyCodingRun } from '../coding-verification.js';
import { broadcast } from '../events.js';
import type { Task } from '../../shared/types.js';
import { beginRecovery, recoveryOutcome, queueVerificationRepair, getRecovery } from '../run-recovery.js';

export function createCodingVerificationRouter(adapter: Pick<AgentAdapter, 'getBackgroundWork'>): Router {
const codingVerificationRouter = Router();
codingVerificationRouter.use('/:id/verification', requireTaskForProfile(getTask));
codingVerificationRouter.get('/:id/verification', async (_req, res) => {
  try { res.json({ evidence: await readCodingEvidence(res.locals.task as Task) }); }
  catch { res.status(503).json({ error: 'Verification evidence unavailable' }); }
});
codingVerificationRouter.post('/:id/verification', async (_req, res) => {
  const task = res.locals.task as Task;
  if (task.kind === 'bot') return res.status(400).json({ error: 'Create a coding task to run Project verification.', code: 'BOT_CHAT_MODE' });
  if (hasActiveTaskRun(task.id) || isVerifying(task.id) || ['streaming','compacting'].includes(getRunStatus(task.id)?.status ?? '')) return res.status(409).json({ error: 'Wait for the active run to settle.' });
  const run = getLatestTaskAgentRun(task.id);
  if (!run) return res.status(409).json({ error: 'Start a coding task before running verification.' });
  const recovery = getRecovery(task.id);
  if (recovery?.repair_fingerprint && ['pending', 'waiting', 'dispatching'].includes(recovery.state)) {
    return res.status(409).json({ error: 'Automatic repair is already queued. Pause automatic repair before running checks manually.' });
  }
  const releaseOperation = claimTaskOperation(task.id, task.project_id, task.workdir);
  if (!releaseOperation) return res.status(409).json({ error: 'Wait for the active task operation to settle.' });
  // Record admission before any await so Stop during the background probe wins.
  if (run.status === 'done') beginRecovery(task.id, run.runId, Date.now());
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const background = await Promise.race([
        adapter.getBackgroundWork?.(task.id) ?? Promise.resolve({ available: false, work: [] }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Background check timed out')), 5_000); }),
      ]);
      if (!background.available || background.work.length) return res.status(409).json({ error: 'Check or stop this task’s background work before running checks.' });
    } finally { if (timer) clearTimeout(timer); }
    if (run.status === 'done' && (getRecovery(task.id)?.state === 'blocked' || getRecovery(task.id)?.run_id !== run.runId)) {
      return res.status(409).json({ error: 'Verification was stopped before it started.' });
    }
    const release = acquireProfileWork(task.handling_profile_id ?? task.profile_name ?? 'default');
    let passed = false;
    try { await trackTaskRun(task.id, verifyCodingRun(task, run.runId).then(result => { passed = result; })); } finally { release(); }
    if (run.status === 'done') {
      recoveryOutcome(task.id, run.runId, 'done');
      queueVerificationRepair(task.id, run.runId);
    }
    if (passed && codingReviewAllowed(task.id, run.runId) && getLatestTaskAgentRun(task.id)?.runId === run.runId && run.status === 'done') {
      const updated = updateTask(task.id, { status: 'in_review' });
      if (updated) broadcast({ type: 'task_updated', task: updated });
    }
    return res.json({ evidence: await readCodingEvidence(task) });
  } catch { return res.status(503).json({ error: 'Could not run verification.' }); }
  finally {
    if (run.status === 'done' && getRecovery(task.id)?.run_id === run.runId && getRecovery(task.id)?.state === 'running') recoveryOutcome(task.id, run.runId, 'done');
    releaseOperation();
  }
});

return codingVerificationRouter;
}
