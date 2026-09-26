import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';

await writeFile(`${process.env.HERMES_HOME}/config.yaml`, '{}\n');
const { default: app, adapter } = await import('../server/app.js');
const { default: db } = await import('../server/db/index.js');
const { insertTask } = await import('../server/db/queries.js');
const { createTaskAgentRun, finishTaskAgentRun, getLatestTaskAgentRun } = await import('../server/db/task-agent-runs.js');
const { beginRecovery, recoveryOutcome, reconcileRecoveries, getRecovery } = await import('../server/run-recovery.js');
const { putQueuedTaskMessage, getQueuedTaskMessage, deleteQueuedTaskMessage } = await import('../server/db/task-message-queue.js');
const { recordInteraction, markInteractionSettled } = await import('../server/db/interactions.js');
const { discardRun } = await import('../server/live-chat.js');

const originals = { background: adapter.getBackgroundWork, chat: adapter.chatStream, page: adapter.getMessagePage };
const inventory = { available: true, work: [], continuation: { status: 'pending' as const } };
const tasks: string[] = [];
let starts = 0;
adapter.getMessagePage = async () => ({ messages: [], pageInfo: { hasOlder: false, olderCursor: null } });
adapter.chatStream = async function* () {
  starts++;
  yield { type: 'error', error: 'Fixture completed', code: 'provider_error' };
};
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as { port: number }).port;

try {
  for (const blocker of ['queue', 'interaction'] as const) {
    const task = insertTask({ title: `Recovery ${blocker}`, status: 'in_progress', profile_name: 'default' });
    tasks.push(task.id);
    const runId = `prior-${blocker}`;
    createTaskAgentRun({ taskId: task.id, runId: runId, kind: 'chat', status: 'streaming', startedAt: 100 });
    beginRecovery(task.id, runId, 100);
    finishTaskAgentRun(runId, 'error', 200, 'worker_restarted');
    recoveryOutcome(task.id, runId, 'error', 'worker_restarted');
    let entered!: () => void;
    let release!: () => void;
    const admissionEntered = new Promise<void>(resolve => { entered = resolve; });
    const admissionGate = new Promise<void>(resolve => { release = resolve; });
    adapter.getBackgroundWork = async () => { entered(); await admissionGate; return inventory; };
    let httpStatus = 0;
    const deliver = async (taskId: string, recoveryRunId: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/messages?profile=default`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Resume saved work', recoveryOfRunId: recoveryRunId, settings: { mode: 'task' } }),
      });
      httpStatus = response.status;
      await response.text();
      if (!response.ok) throw new Error('Recovery admission was rejected');
    };
    const beforeStarts = starts;
    const recovery = reconcileRecoveries({ getBackgroundWork: async () => inventory }, deliver);
    await admissionEntered;
    const queued = {
      id: `queued-${blocker}`, taskId: task.id, content: 'New user direction', settings: { mode: 'task' as const },
      invitedProfileIds: [], collaborationScope: 'discussion' as const, confirmPersistentCollaboration: false,
      createdAt: 300, updatedAt: 300,
    };
    if (blocker === 'queue') putQueuedTaskMessage(queued);
    else recordInteraction({ taskId: task.id, profileName: 'default', olympusRunId: runId, interaction: {
      id: `ask-${blocker}`, workerRunId: 'fixture-worker', kind: 'approval', title: 'Approve change', expiresAt: 0,
    } as any });
    release();
    await recovery;
    assert.equal(httpStatus, 409, `${blocker} arriving during the second inventory must reject recovery admission`);
    assert.equal(starts, beforeStarts, 'rejected recovery must not start the agent');
    assert.equal(getLatestTaskAgentRun(task.id)?.runId, runId, 'rejection must preserve the exact failed run');
    assert.equal(getRecovery(task.id)?.state, 'waiting');
    if (blocker === 'queue') {
      assert.deepEqual(getQueuedTaskMessage(task.id), queued, 'rejection must preserve the saved user message');
      assert.equal(deleteQueuedTaskMessage(task.id, queued.id), true);
    } else markInteractionSettled(`ask-${blocker}`, 'answered');
    adapter.getBackgroundWork = async () => inventory;
    await reconcileRecoveries({ getBackgroundWork: async () => inventory }, deliver);
    assert.equal(httpStatus, 202);
    await new Promise(resolve => setImmediate(resolve));
    await reconcileRecoveries({ getBackgroundWork: async () => inventory }, deliver);
    assert.equal(starts, beforeStarts + 1, 'resolving the blocker permits exactly one normal recovery claim');
  }
} finally {
  adapter.getBackgroundWork = originals.background;
  adapter.chatStream = originals.chat;
  adapter.getMessagePage = originals.page;
  for (const taskId of tasks) discardRun(taskId);
  server.close();
  await once(server, 'close');
  db.close();
}
console.log('Recovery admission tests passed');
