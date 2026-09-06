import { acquireProfileWork } from '../profile-deletion.js';
import { claimTaskOperation, hasActiveTaskRun, trackTaskRun } from '../task-run-lifecycle.js';
import { Router } from 'express';
import { getTask, updateTask } from '../db/queries.js';
import { getLatestTaskAgentRun } from '../db/task-agent-runs.js';
import { requireTaskForProfile } from '../profile-context.js';
import { getRunStatus } from '../live-chat.js';
import { getProjectEditor } from '../db/project-cp.js';
import { isVerifying, readCodingEvidence, verifyCodingRun } from '../coding-verification.js';
import { broadcast } from '../events.js';
import type { Task } from '../../shared/types.js';

export const codingVerificationRouter = Router();
codingVerificationRouter.use('/:id/verification', requireTaskForProfile(getTask));
codingVerificationRouter.get('/:id/verification', async (_req, res) => {
  try { res.json({ evidence: await readCodingEvidence(res.locals.task as Task) }); }
  catch { res.status(503).json({ error: 'Verification evidence unavailable' }); }
});
codingVerificationRouter.post('/:id/verification', async (_req, res) => {
  const task = res.locals.task as Task;
  if (task.kind === 'bot') return res.status(400).json({ error: 'Create a coding task to run Project verification.', code: 'BOT_CHAT_MODE' });
  if (hasActiveTaskRun(task.id) || isVerifying(task.id) || ['streaming','compacting'].includes(getRunStatus(task.id)?.status ?? '')) return res.status(409).json({ error: 'Wait for the active run to settle.' });
  const lease = task.project_id ? getProjectEditor(task.project_id) : undefined;
  if (lease && lease.taskId !== task.id) return res.status(409).json({ error: 'Another task owns this project checkout.' });
  const run = getLatestTaskAgentRun(task.id);
  if (!run) return res.status(409).json({ error: 'Start a coding task before running verification.' });
  const releaseOperation = claimTaskOperation(task.id, task.project_id);
  if (!releaseOperation) return res.status(409).json({ error: 'Wait for the active task operation to settle.' });
  try {
    const release = acquireProfileWork(task.handling_profile_id ?? task.profile_name ?? 'default');
    let passed = false;
    try { await trackTaskRun(task.id, verifyCodingRun(task, run.runId).then(result => { passed = result; })); } finally { release(); }
    if (passed && getLatestTaskAgentRun(task.id)?.runId === run.runId && run.status === 'done') {
      const updated = updateTask(task.id, { status: 'in_review' });
      if (updated) broadcast({ type: 'task_updated', task: updated });
    }
    return res.json({ evidence: await readCodingEvidence(task) });
  } catch { return res.status(503).json({ error: 'Could not run verification.' }); }
  finally { releaseOperation(); }
});
