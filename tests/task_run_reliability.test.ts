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

startRun('deadline-finalized', 'deadline-finalized', 'Implement a bounded task');
applyEvent('deadline-finalized', { type: 'text_delta', content: 'Completed X; remaining Y.' });
applyEvent('deadline-finalized', { type: 'tool_progress', tool: 'delegate_task', status: 'running' });
applyEvent('deadline-finalized', { type: 'error', code: 'deadline_finalized', error: 'Run paused after deadline checkpoint.' });
applyEvent('deadline-finalized', { type: 'done', sessionId: 'deadline-finalized' });
assert.equal(getRun('deadline-finalized')?.status, 'error');
assert.equal(getRun('deadline-finalized')?.errorCode, 'deadline_finalized');
assert.equal(getRun('deadline-finalized')?.messages.at(-1)?.tools?.at(-1)?.status, 'error');
console.log('Task run reliability tests passed');
