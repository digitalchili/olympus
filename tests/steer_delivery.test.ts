import assert from 'node:assert/strict';
import {
  appendSteeredUserMessage,
  applyEvent,
  getRun,
  startRun,
} from '../server/live-chat.js';

const taskId = 'steer-delivery-test';
startRun(taskId, taskId, 'Initial request');
appendSteeredUserMessage(taskId, 'Follow-up direction');
applyEvent(taskId, { type: 'text_delta', content: 'Updated response' });

const run = getRun(taskId);
assert.ok(run);
assert.deepEqual(
  run.messages.map(({ role, content }) => ({ role, content })),
  [
    { role: 'user', content: 'Initial request' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'Follow-up direction' },
    { role: 'assistant', content: 'Updated response' },
  ],
);

console.log('Steer delivery tests passed');