import assert from 'node:assert/strict';
import { applyLiveErrorEvent } from '../client/src/hooks/useChat.js';
import { applyEvent, getRun, startRun } from '../server/live-chat.js';
import type { LiveChatRun } from '../shared/types.js';

const taskId = 'iteration-limit-reply-test';
startRun(taskId, taskId, 'Do a bounded task');
applyEvent(taskId, { type: 'text_delta', content: 'Here is the useful partial result.' });
applyEvent(taskId, {
  type: 'error',
  code: 'iteration_limit',
  error: '[iteration_limit] Hermes reached the Olympus tool-iteration limit before completing this turn.',
});

const run = getRun(taskId);
assert.ok(run);
assert.equal(run.status, 'error', 'the incomplete turn remains retryable and is not promoted as complete');
assert.match(run.error ?? '', /iteration_limit/);
assert.equal(
  run.messages.at(-1)?.content,
  'Here is the useful partial result.\n[Run stopped before completion. Send another message to retry.]',
  'iteration limits append a concise retryable blocker without exposing internals',
);

const clientRun: LiveChatRun = {
  taskId: 'client-iteration-limit-test',
  runId: 'client-run',
  kind: 'chat',
  sessionId: 'client-iteration-limit-test',
  status: 'streaming',
  startedAt: 100,
  updatedAt: 100,
  messages: [{
    id: 'assistant-message',
    task_id: 'client-iteration-limit-test',
    role: 'assistant',
    content: 'Here is the live partial result.',
    created_at: 100,
  }],
};
applyLiveErrorEvent(clientRun, {
  type: 'error',
  code: 'iteration_limit',
  error: '[iteration_limit] Hermes reached the Olympus tool-iteration limit before completing this turn.',
}, 200);
assert.equal(clientRun.status, 'error');
assert.match(clientRun.error ?? '', /iteration_limit/);
assert.equal(
  clientRun.messages.at(-1)?.content,
  'Here is the live partial result.\n[Run stopped before completion. Send another message to retry.]',
  'the EventSource projection shows the same concise retryable blocker',
);

const idleTaskId = 'idle-timeout-reply-test';
startRun(idleTaskId, idleTaskId, 'Do a task with progress');
applyEvent(idleTaskId, { type: 'text_delta', content: 'Useful work before the idle stop.' });
applyEvent(idleTaskId, {
  type: 'error',
  code: 'run_idle_timeout',
  error: 'Hermes run produced no activity for 300000ms and was stopped',
});
assert.equal(
  getRun(idleTaskId)?.messages.at(-1)?.content,
  'Useful work before the idle stop.\n[Run stopped before completion. Send another message to retry.]',
  'idle watchdog failures show a user-safe blocker',
);

const runtimeClientRun: LiveChatRun = structuredClone(clientRun);
runtimeClientRun.status = 'streaming';
runtimeClientRun.error = undefined;
runtimeClientRun.messages.at(-1)!.content = 'Useful work before the runtime stop.';
applyLiveErrorEvent(runtimeClientRun, {
  type: 'error',
  code: 'run_runtime_timeout',
  error: 'Hermes run exceeded its maximum runtime for 1800000ms and was stopped',
}, 300);
assert.equal(
  runtimeClientRun.messages.at(-1)?.content,
  'Useful work before the runtime stop.\n[Run stopped before completion. Send another message to retry.]',
  'runtime watchdog failures show a user-safe blocker',
);

const providerClientRun: LiveChatRun = structuredClone(clientRun);
providerClientRun.status = 'streaming';
providerClientRun.error = undefined;
providerClientRun.messages.at(-1)!.content = 'Partial provider response.';
applyLiveErrorEvent(providerClientRun, {
  type: 'error',
  code: 'provider_error',
  error: 'Provider request failed',
}, 400);
assert.equal(
  providerClientRun.messages.at(-1)?.content,
  'Partial provider response.\n[Run stopped before completion. Send another message to retry.]',
  'provider errors expose a concise user-safe blocker instead of raw internals',
);

console.log('Iteration-limit reply projection tests passed');
