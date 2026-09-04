import assert from 'node:assert/strict';
import { shouldPromoteTerminalRun } from '../server/run-settlement.js';

assert.equal(shouldPromoteTerminalRun('done'), true, 'successful runs always move to review');
assert.equal(
  shouldPromoteTerminalRun('error'),
  false,
  'partial assistant output does not make a failed run complete',
);
assert.equal(shouldPromoteTerminalRun('stopped'), false, 'user-stopped runs remain actionable');
assert.equal(shouldPromoteTerminalRun('streaming'), false, 'active runs never move early');
