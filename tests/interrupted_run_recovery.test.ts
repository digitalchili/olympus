import assert from 'node:assert/strict';
import { getRun, interruptActiveRuns, startRun } from '../server/live-chat.js';

startRun('recovery-task', 'recovery-session', 'message that must be retryable after worker loss');
const interrupted = interruptActiveRuns('Hermes worker restarted; resend your message to retry.');
assert.equal(interrupted.length, 1);
const run = getRun('recovery-task');
assert.equal(run?.status, 'error');
assert.match(run?.error ?? '', /restarted/);
assert.match(run?.messages.at(-1)?.content ?? '', /retry/);

console.log('Interrupted run recovery tests passed');
