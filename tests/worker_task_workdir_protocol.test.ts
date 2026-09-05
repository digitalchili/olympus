import assert from 'node:assert/strict';
import { buildChatWorkerRequest } from '../server/adapters/hermes-worker.js';

const request = buildChatWorkerRequest('session-1', 'Edit the project', {
  systemMessage: 'System',
  settings: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
  task: {
    id: 'task-1',
    title: 'Editor task',
    workdir: '/srv/olympus/project-checkouts/project-1',
  },
  runBudget: {
    maxRuntimeMs: 3_600_000,
    hardDeadlineAtMs: 9_999_999,
    finalizeBeforeMs: 300_000,
    childDrainBeforeMs: 120_000,
    maxDelegatedChildren: 4,
  },
});

assert.deepEqual(request, {
  type: 'chat',
  sessionId: 'session-1',
  message: 'Edit the project',
  systemMessage: 'System',
  settings: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
  taskId: 'task-1',
  taskTitle: 'Editor task',
  workdir: '/srv/olympus/project-checkouts/project-1',
  runBudget: {
    maxRuntimeMs: 3_600_000,
    hardDeadlineAtMs: 9_999_999,
    finalizeBeforeMs: 300_000,
    childDrainBeforeMs: 120_000,
    maxDelegatedChildren: 4,
  },
});

console.log('Hermes worker task workspace protocol tests passed');
