import assert from 'node:assert/strict';
import { shouldPromoteTerminalRun } from '../server/run-settlement.js';
import { applyEvent, getRun, startRun } from '../server/live-chat.js';

for (const status of ['error', 'stopped'] as const) {
  assert.equal(shouldPromoteTerminalRun(status, true), false, `${status} with partial output is not successful delivery`);
}
assert.equal(shouldPromoteTerminalRun('done', true), true);

startRun('failure-is-terminal', 'failure-is-terminal', 'Implement a bounded task');
applyEvent('failure-is-terminal', { type: 'text_delta', content: 'Partial checkpoint only' });
applyEvent('failure-is-terminal', { type: 'error', code: 'run_runtime_timeout', error: 'Runtime limit reached' });
applyEvent('failure-is-terminal', { type: 'done', sessionId: 'failure-is-terminal' });
assert.equal(getRun('failure-is-terminal')?.status, 'error', 'a trailing done frame cannot erase failure');
assert.equal(getRun('failure-is-terminal')?.error, 'Runtime limit reached');
console.log('Task run reliability tests passed');
