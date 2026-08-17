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
  'Here is the useful partial result.',
  'internal iteration-limit errors must not be appended to assistant reply prose',
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
  'Here is the live partial result.',
  'the EventSource projection must not append internal iteration-limit errors to reply prose',
);

console.log('Iteration-limit reply projection tests passed');
