import assert from 'node:assert/strict';
import { hasReviewableAssistantOutput, shouldPromoteTerminalRun } from '../server/run-settlement.js';

assert.equal(shouldPromoteTerminalRun('done', false), true, 'successful runs always move to review');
assert.equal(
  shouldPromoteTerminalRun('error', true),
  false,
  'forced limits preserve partial output without presenting it as successful delivery',
);
assert.equal(shouldPromoteTerminalRun('stopped', true), false, 'user-stopped runs remain incomplete');
assert.equal(shouldPromoteTerminalRun('error', false), false, 'failures with no assistant result remain retryable');
assert.equal(shouldPromoteTerminalRun('streaming', true), false, 'active runs never move early');
assert.equal(hasReviewableAssistantOutput([
  { id: 'assistant-1', role: 'assistant', content: '', created_at: 1, tools: [{ tool: 'terminal', status: 'completed' }] },
]), true, 'visible tool progress is reviewable after a forced terminal stop');
assert.equal(hasReviewableAssistantOutput([
  { id: 'assistant-2', role: 'assistant', content: '', created_at: 1, tools: [] },
]), false);
