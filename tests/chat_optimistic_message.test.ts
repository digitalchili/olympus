import assert from 'node:assert/strict';
import {
  createOptimisticChatRun,
  reconcileOptimisticChatSnapshot,
  rollbackOptimisticChatRun,
  shouldCreateOptimisticChatRun,
} from '../client/src/hooks/useChat.js';
import type { LiveChatRun } from '../shared/types.js';

const optimistic = createOptimisticChatRun('task-a', 'Follow-up question', 'chat', 100);
assert.deepEqual(
  optimistic.messages.map(({ role, content }) => ({ role, content })),
  [
    { role: 'user', content: 'Follow-up question' },
    { role: 'assistant', content: '' },
  ],
  'a submitted message is visible locally before the POST or SSE snapshot completes',
);
assert.ok(optimistic.messages.every((message) => message.task_id === 'task-a'));

const serverSnapshot: LiveChatRun = {
  taskId: 'task-a',
  runId: 'server-run',
  kind: 'chat',
  sessionId: 'task-a',
  status: 'streaming',
  startedAt: 101,
  updatedAt: 101,
  messages: [
    { id: 'server-user', task_id: 'task-a', role: 'user', content: 'Follow-up question', created_at: 101 },
    { id: 'server-assistant', task_id: 'task-a', role: 'assistant', content: '', created_at: 101 },
  ],
};
const reconciled = reconcileOptimisticChatSnapshot(optimistic, serverSnapshot);
assert.equal(reconciled.messages.filter((message) => message.role === 'user').length, 1);
assert.equal(reconciled.messages[0]?.id, 'server-user', 'the authoritative snapshot replaces the optimistic duplicate');

const emptyGoalSnapshot: LiveChatRun = {
  taskId: 'task-a',
  runId: 'goal-run',
  kind: 'goal',
  sessionId: 'task-a',
  status: 'streaming',
  startedAt: 101,
  updatedAt: 101,
  messages: [],
};
const reconciledGoal = reconcileOptimisticChatSnapshot(optimistic, emptyGoalSnapshot);
assert.deepEqual(
  reconciledGoal.messages.map(({ role, content }) => ({ role, content })),
  [
    { role: 'user', content: 'Follow-up question' },
    { role: 'assistant', content: '' },
  ],
  'an early empty goal snapshot must not hide the optimistic user message',
);
assert.ok(reconciledGoal.messages.every((message) => message.task_id === 'task-a'));

const optimisticWithDelta: LiveChatRun = {
  ...optimistic,
  messages: optimistic.messages.map((message: LiveChatRun['messages'][number]) => (
    message.role === 'assistant' ? { ...message, content: 'Partial reply' } : { ...message }
  )),
};
assert.equal(
  reconcileOptimisticChatSnapshot(optimisticWithDelta, emptyGoalSnapshot).messages[1]?.content,
  'Partial reply',
  'an empty snapshot does not discard assistant deltas already applied to the optimistic run',
);

const otherTaskSnapshot: LiveChatRun = {
  ...serverSnapshot,
  taskId: 'task-b',
  messages: serverSnapshot.messages.map((message) => ({ ...message, task_id: 'task-b' })),
};
assert.equal(
  reconcileOptimisticChatSnapshot(optimistic, otherTaskSnapshot),
  otherTaskSnapshot,
  'optimistic messages never cross task/profile task boundaries',
);

const activeRun: LiveChatRun = {
  ...serverSnapshot,
  messages: serverSnapshot.messages.map((message) => ({ ...message })),
};
assert.equal(
  shouldCreateOptimisticChatRun(activeRun),
  false,
  'a pending server run stays authoritative while a follow-up POST may return 409',
);
assert.equal(
  rollbackOptimisticChatRun(optimistic, optimistic.runId),
  null,
  'a rejected optimistic send clears its standalone placeholder',
);
const hybridSnapshot = reconcileOptimisticChatSnapshot(optimistic, emptyGoalSnapshot);
const rolledBackHybrid = rollbackOptimisticChatRun(hybridSnapshot, optimistic.runId);
assert.equal(rolledBackHybrid?.runId, emptyGoalSnapshot.runId, 'rollback keeps the authoritative SSE run');
assert.deepEqual(
  rolledBackHybrid?.messages,
  [],
  'rollback removes a rejected optimistic message reconciled into an early SSE snapshot',
);
assert.equal(
  rollbackOptimisticChatRun(activeRun, optimistic.runId),
  activeRun,
  'rollback never replaces an SSE-backed run that has no optimistic placeholder',
);

console.log('Optimistic chat message tests passed');
