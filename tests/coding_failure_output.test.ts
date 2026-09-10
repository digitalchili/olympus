import assert from 'node:assert/strict';
import { codingFailureDetails } from '../shared/coding-failure.js';

const output = '✓ passing test\n'.repeat(700) + `
⎯⎯ Failed Tests 2 ⎯⎯
 FAIL lib/normalize-order.test.ts > refund timestamp
AssertionError: expected '10:06' to be '03:06'
 FAIL lib/investor.test.ts > month boundary
AssertionError: expected '2026-05-01' to be '2026-04-30'
 Test Files 2 failed | 87 passed (89)
      Tests 2 failed | 568 passed (570)
 Duration 4.5s
` + 'npm notice Update available\n'.repeat(100);
const result = codingFailureDetails({ output, timedOut: false, exitCode: 1 });
assert.equal(result.summary, '2 tests failed · 568 passed');
assert.match(result.excerpt, /normalize-order/);
assert.match(result.excerpt, /investor/);
assert.doesNotMatch(result.excerpt, /npm notice|✓ passing/);
assert.match(codingFailureDetails({ output: 'Error: expected stderr from a passing test\n✓ passed\nFAIL actual.test.ts\nAssertionError: mismatch', timedOut: false, exitCode: 1 }).excerpt, /^FAIL actual/);
assert.equal(codingFailureDetails({ output: '\u001b[31merror TS2307: Missing module\u001b[0m', timedOut: false, exitCode: 2 }).excerpt, 'error TS2307: Missing module');
assert.equal(codingFailureDetails({ output: '', timedOut: false, exitCode: 1 }).excerpt, 'The command returned no output.');
assert.equal(codingFailureDetails({ output: '', timedOut: true, exitCode: null }).summary, 'Check timed out');
assert.equal(codingFailureDetails({ output: 'connection refused', timedOut: false, exitCode: 1 }).excerpt, 'connection refused');
assert.ok(codingFailureDetails({ output: 'x'.repeat(10000), timedOut: false, exitCode: 1 }).excerpt.length <= 6000);
console.log('Coding failure excerpts preserve errors instead of trailing npm notices');
