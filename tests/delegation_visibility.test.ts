import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-delegations-'));
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = join(root, 'data', 'test.db');

try {
  const [{ default: db }, queries, delegationDb, delegationEvents] = await Promise.all([
    import('../server/db/index.js'),
    import('../server/db/queries.js'),
    import('../server/db/delegations.js'),
    import('../server/delegation-events.js'),
  ]);

  const defaultTask = queries.insertTask({
    title: 'Default task',
    status: 'in_progress',
    profile_name: 'default',
  });
  const otherTask = queries.insertTask({
    title: 'Other task',
    status: 'in_progress',
    profile_name: 'writer',
  });

  const malicious = delegationEvents.normalizeDelegationEvent({
    schema: 'olympus.delegation.event.v1',
    delegationId: 'deleg-1',
    childId: 'child-1',
    parentSessionId: defaultTask.id,
    childSessionId: 'session-child-1',
    parentChildId: null,
    childIndex: 0,
    childCount: 1,
    status: 'running',
    currentAction: 'web_search',
    model: 'gpt-5.6-sol',
    toolCount: 2,
    apiCalls: 1,
    durationSeconds: null,
    inputTokens: 10,
    outputTokens: 4,
    reasoningTokens: 2,
    costUsd: 0.001,
    filesTouched: 0,
    goal: 'PRIVATE GOAL SENTINEL',
    args: { token: 'PRIVATE ARG SENTINEL' },
    summary: 'PRIVATE SUMMARY SENTINEL',
    outputTail: 'PRIVATE OUTPUT SENTINEL',
    files: ['/private/path/sentinel.txt'],
  });
  assert.ok(malicious);
  const serialized = JSON.stringify(malicious);
  for (const forbidden of ['PRIVATE GOAL', 'PRIVATE ARG', 'PRIVATE SUMMARY', 'PRIVATE OUTPUT', '/private/path']) {
    assert.equal(serialized.includes(forbidden), false, `normalizer leaked ${forbidden}`);
  }
  assert.deepEqual(Object.keys(malicious).sort(), [
    'apiCalls',
    'childCount',
    'childId',
    'childIndex',
    'childSessionId',
    'costUsd',
    'currentAction',
    'delegationId',
    'durationSeconds',
    'filesTouched',
    'inputTokens',
    'model',
    'outputTokens',
    'parentChildId',
    'parentSessionId',
    'reasoningTokens',
    'schema',
    'status',
    'toolCount',
  ].sort());

  const queued = delegationDb.recordDelegationEvent({
    profileId: 'default',
    taskId: defaultTask.id,
    event: { ...malicious, status: 'queued', currentAction: null, toolCount: 0, apiCalls: 0 },
    receivedAt: 100,
  });
  assert.ok(queued);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.task_id, defaultTask.id);
  assert.equal(queued.profile_name, 'default');

  const running = delegationDb.recordDelegationEvent({
    profileId: 'default',
    taskId: defaultTask.id,
    event: malicious,
    receivedAt: 200,
  });
  assert.equal(running?.id, queued.id, 'duplicate child events must upsert one row');
  assert.equal(running?.status, 'running');
  assert.equal(running?.current_action, 'web_search');

  const completed = delegationDb.recordDelegationEvent({
    profileId: 'default',
    taskId: defaultTask.id,
    event: {
      ...malicious,
      status: 'completed',
      currentAction: null,
      durationSeconds: 12.5,
      apiCalls: 3,
      filesTouched: 2,
    },
    receivedAt: 300,
  });
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.completed_at, 300);

  const staleRunning = delegationDb.recordDelegationEvent({
    profileId: 'default',
    taskId: defaultTask.id,
    event: malicious,
    receivedAt: 250,
  });
  assert.equal(staleRunning?.status, 'completed', 'terminal states must not regress');
  assert.equal(staleRunning?.updated_at, 300, 'out-of-order events must not move timestamps backwards');

  const rebind = delegationDb.recordDelegationEvent({
    profileId: 'writer',
    taskId: otherTask.id,
    event: malicious,
    receivedAt: 400,
  });
  assert.equal(rebind, null, 'an immutable child ID cannot be rebound to another profile/task');
  assert.equal(delegationDb.listDelegationRuns(defaultTask.id, 'default').length, 1);
  assert.equal(delegationDb.listDelegationRuns(otherTask.id, 'writer').length, 0);

  const activeChild = delegationEvents.normalizeDelegationEvent({
    ...malicious,
    delegationId: 'deleg-2',
    childId: 'child-2',
    childSessionId: 'session-child-2',
    status: 'waiting',
    currentAction: null,
  });
  assert.ok(activeChild);
  delegationDb.recordDelegationEvent({
    profileId: 'default',
    taskId: defaultTask.id,
    event: activeChild,
    receivedAt: 500,
  });
  const writerActive = delegationEvents.normalizeDelegationEvent({
    ...malicious,
    delegationId: 'deleg-writer',
    childId: 'child-writer',
    childSessionId: 'session-child-writer',
    parentSessionId: otherTask.id,
    status: 'running',
  });
  assert.ok(writerActive);
  delegationDb.recordDelegationEvent({
    profileId: 'writer',
    taskId: otherTask.id,
    event: writerActive,
    receivedAt: 550,
  });
  const resetWriterRuns = delegationDb.markProfileDelegationsUnknown('writer', 575);
  assert.equal(resetWriterRuns.length, 1);
  assert.equal(resetWriterRuns[0].status, 'unknown');
  assert.equal(
    delegationDb.listDelegationRuns(defaultTask.id, 'default').find((row) => row.child_id === 'child-2')?.status,
    'waiting',
    'a worker reset must affect only its owning profile',
  );
  assert.equal(delegationDb.markUnprovenDelegationsUnknown(600), 1);
  const rowsAfterRecovery = delegationDb.listDelegationRuns(defaultTask.id, 'default');
  assert.equal(rowsAfterRecovery.find((row) => row.child_id === 'child-2')?.status, 'unknown');
  assert.equal(rowsAfterRecovery.find((row) => row.child_id === 'child-1')?.status, 'completed');

  const provenAfterRecovery = delegationDb.recordDelegationEvent({
    profileId: 'default',
    taskId: defaultTask.id,
    event: { ...activeChild, status: 'completed', durationSeconds: 20 },
    receivedAt: 700,
  });
  assert.equal(provenAfterRecovery?.status, 'completed');
  assert.equal(provenAfterRecovery?.completed_at, 700, 'a proven terminal callback replaces the restart approximation');

  db.prepare('DELETE FROM tasks WHERE id = ?').run(defaultTask.id);
  assert.equal(delegationDb.listDelegationRuns(defaultTask.id, 'default').length, 0, 'task deletion cascades delegation rows');
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Delegation visibility persistence and sanitization tests passed');
