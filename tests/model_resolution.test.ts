import assert from 'node:assert/strict';
import { applyEvent, discardRun, getRun, startRun } from '../server/live-chat.js';

const taskId = 'model-resolution-test';

try {
  startRun(taskId, taskId, 'Use the selected model');
  applyEvent(taskId, {
    type: 'model_resolution',
    modelResolution: {
      requested: {
        model: 'gpt-6-astra',
        provider: 'openai-codex',
        reasoningEffort: 'xhigh',
      },
      actual: {
        model: 'gpt-6-astra',
        provider: 'openai-codex',
        reasoningEffort: 'xhigh',
      },
    },
  });
  applyEvent(taskId, {
    type: 'model_resolution',
    modelResolution: {
      requested: {
        model: 'gpt-6-astra',
        provider: 'openai-codex',
        reasoningEffort: 'xhigh',
      },
      actual: {
        model: 'gpt-5.5',
        provider: 'openai-codex',
        reasoningEffort: 'xhigh',
      },
      fallbackReason: 'Requested model failed; Hermes activated its configured fallback.',
    },
  });

  assert.deepEqual(getRun(taskId)?.modelResolution, {
    requested: {
      model: 'gpt-6-astra',
      provider: 'openai-codex',
      reasoningEffort: 'xhigh',
    },
    actual: {
      model: 'gpt-5.5',
      provider: 'openai-codex',
      reasoningEffort: 'xhigh',
    },
    fallbackReason: 'Requested model failed; Hermes activated its configured fallback.',
  });
} finally {
  discardRun(taskId);
}
