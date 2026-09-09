import assert from 'node:assert/strict';
import db from '../server/db/index.js';
import { insertTask } from '../server/db/queries.js';
import { createTaskAgentRun, finishTaskAgentRun } from '../server/db/task-agent-runs.js';
import { beginRecovery, recoveryOutcome, cancelRecovery } from '../server/run-recovery.js';
import { taskRunSnapshot } from '../server/task-run-snapshot.js';
import { startRun, getRunStatus, discardRun } from '../server/live-chat.js';
const task = insertTask({ title: 'Persisted execution state', status: 'in_progress' });
try {
  startRun(task.id, task.id, 'Test');
  const run = getRunStatus(task.id)!;
  createTaskAgentRun({ ...run, status: 'streaming' });
  beginRecovery(task.id, run.runId, run.startedAt);
  finishTaskAgentRun(run.runId, 'error', Date.now(), 'iteration_limit');
  recoveryOutcome(task.id, run.runId, 'error', 'iteration_limit');
  assert.equal(taskRunSnapshot().find(r => r.taskId === task.id)?.status, 'error', 'persisted terminal beats stale live streaming');
  discardRun(task.id);
  assert.equal(taskRunSnapshot().find(r => r.taskId === task.id)?.recoveryState, 'pending', 'reconnect includes recovery without a live snapshot');
  cancelRecovery(task.id);
  assert.equal(taskRunSnapshot().find(r => r.taskId === task.id)?.recoveryState, 'blocked');
  startRun(task.id, task.id, 'Continue');
  assert.equal(taskRunSnapshot().find(r => r.taskId === task.id)?.status, 'streaming', 'new live run beats old terminal');
} finally { discardRun(task.id); db.close(); }
