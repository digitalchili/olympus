import assert from 'node:assert/strict';
import db from '../server/db/index.js';
import { insertTask } from '../server/db/queries.js';
import { createTaskAgentRun, finishTaskAgentRun, getLatestTaskAgentRun } from '../server/db/task-agent-runs.js';
import { putQueuedTaskMessage, deleteQueuedTaskMessage } from '../server/db/task-message-queue.js';
import { beginRecovery, recoveryOutcome, getRecovery, reconcileRecoveries } from '../server/run-recovery.js';
import { recordInteraction, markInteractionSettled } from '../server/db/interactions.js';
import { taskRunSnapshot } from '../server/task-run-snapshot.js';

const task = insertTask({ title: 'Waiting recovery', status: 'in_progress' });
createTaskAgentRun({ taskId: task.id, runId: 'waiting', kind: 'chat', status: 'streaming', startedAt: 100 });
beginRecovery(task.id, 'waiting', 100);
finishTaskAgentRun('waiting', 'error', 200, 'worker_restarted');
recoveryOutcome(task.id, 'waiting', 'error', 'worker_restarted');
const queued = { id: 'input', taskId: task.id, content: 'New direction', settings: { mode: 'task' as const }, invitedProfileIds: [], collaborationScope: 'discussion' as const, confirmPersistentCollaboration: false, createdAt: 210, updatedAt: 210 };
const ready = { getBackgroundWork: async () => ({ available: true, work: [], continuation: { status: 'pending' as const } }) };
let dispatches = 0;
try {
  const before = getRecovery(task.id);
  putQueuedTaskMessage(queued);
  for (let i = 0; i < 3; i++) await reconcileRecoveries(ready, async () => { dispatches++; });
  assert.equal(dispatches, 0);
  assert.deepEqual(getRecovery(task.id), before, 'waiting projection never rewrites the recovery cause or checkpoint');
  assert.equal(getLatestTaskAgentRun(task.id)?.recoveryWaitReason, 'queued_message');
  assert.equal(taskRunSnapshot().find(run => run.taskId === task.id)?.recoveryWaitReason, 'queued_message');
  recordInteraction({ taskId: task.id, profileName: 'default', olympusRunId: 'waiting', interaction: {
    id: 'ask', workerRunId: 'worker', kind: 'approval', title: 'Approve change', expiresAt: 0,
  } as any });
  assert.equal(getLatestTaskAgentRun(task.id)?.recoveryWaitReason, 'awaiting_input', 'input has priority over the queued message');
  markInteractionSettled('ask', 'answered');
  assert.equal(deleteQueuedTaskMessage(task.id, 'stale'), false);
  assert.equal(getLatestTaskAgentRun(task.id)?.recoveryWaitReason, 'queued_message');
  assert.equal(deleteQueuedTaskMessage(task.id, queued.id), true);
  assert.equal(getLatestTaskAgentRun(task.id)?.recoveryWaitReason, null, 'removal explicitly clears metadata');
  await reconcileRecoveries({ getBackgroundWork: async () => { putQueuedTaskMessage(queued); return ready.getBackgroundWork(); } }, async () => { dispatches++; });
  assert.equal(dispatches, 0, 'input queued during background lookup still takes priority');
  deleteQueuedTaskMessage(task.id, queued.id);
  await reconcileRecoveries(ready, async () => { dispatches++; });
  await reconcileRecoveries(ready, async () => { dispatches++; });
  assert.equal(dispatches, 1, 'removing input permits only one exact-run claim');
} finally { db.close(); }
