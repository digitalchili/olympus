import { codingReviewAllowed, readCodingEvidence } from './coding-verification.js';
import { getTask, updateTask } from './db/queries.js';
import { getLatestTaskAgentRun, listLatestTaskAgentRuns } from './db/task-agent-runs.js';
import { hasUnansweredInteractions } from './db/interactions.js';
import { getQueuedTaskMessage } from './db/task-message-queue.js';
import { claimTaskOperation, hasActiveTaskRun } from './task-run-lifecycle.js';
import { broadcast } from './events.js';

/** Older releases skipped clean read-only checks but never recorded completion. */
export async function reconcileSkippedReviews(): Promise<void> {
  for (const run of listLatestTaskAgentRuns()) {
    const task = getTask(run.taskId);
    if (!task || task.kind === 'bot' || task.status !== 'in_progress' || task.last_agent_response_at !== null
      || run.status !== 'done' || run.completedAt === null || hasActiveTaskRun(task.id)
      // A later task edit may be an intentional status choice. Ambiguous legacy
      // records stay untouched rather than undoing a human reopening the task.
      || task.updated_at > run.completedAt
      || getQueuedTaskMessage(task.id) || hasUnansweredInteractions(task.id, run.runId)) continue;
    const release = claimTaskOperation(task.id, task.project_id, task.workdir);
    if (!release) continue;
    try {
      const evidence = await readCodingEvidence(task);
      if (evidence?.runId !== run.runId || evidence.status !== 'skipped' || !codingReviewAllowed(task.id, run.runId)) continue;
      const current = getTask(task.id);
      if (!current || current.updated_at !== task.updated_at || current.status !== task.status || getLatestTaskAgentRun(task.id)?.runId !== run.runId
        || getQueuedTaskMessage(task.id) || hasUnansweredInteractions(task.id, run.runId)) continue;
      const updated = updateTask(task.id, { status: 'in_review', last_agent_response_at: run.completedAt });
      if (updated) broadcast({ type: 'task_updated', task: updated });
    } catch {
      // Missing/unavailable source never authorizes review. A later restart can retry.
    } finally { release(); }
  }
}
