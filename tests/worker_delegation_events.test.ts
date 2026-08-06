import assert from 'node:assert/strict';
import { HermesWorkerClient } from '../server/adapters/hermes-worker.js';
import type { DelegationWorkerEvent } from '../shared/types.js';

const worker = new HermesWorkerClient('/tmp/unused-hermes-home');
const received: Array<{ taskId: string; event: DelegationWorkerEvent }> = [];
const unsubscribe = worker.onDelegationEvent((event) => received.push(event));

const event: DelegationWorkerEvent = {
  schema: 'olympus.delegation.event.v1',
  delegationId: 'deleg-1',
  childId: 'child-1',
  parentSessionId: 'task-1',
  childSessionId: 'child-session-1',
  parentChildId: null,
  childIndex: 0,
  childCount: 1,
  status: 'completed',
  currentAction: null,
  model: 'gpt-5.6-sol',
  toolCount: 3,
  apiCalls: 2,
  durationSeconds: 12,
  inputTokens: 10,
  outputTokens: 5,
  reasoningTokens: 2,
  costUsd: null,
  filesTouched: 1,
};

// Deliberately no pending chat request: late background completion must still publish.
(worker as unknown as { handleLine: (line: string) => void }).handleLine(JSON.stringify({
  id: 'already-finished-parent-request',
  type: 'delegation_event',
  taskId: 'task-1',
  event,
}));
assert.deepEqual(received, [{ taskId: 'task-1', event }]);

unsubscribe();
(worker as unknown as { handleLine: (line: string) => void }).handleLine(JSON.stringify({
  id: 'another-late-request',
  type: 'delegation_event',
  taskId: 'task-1',
  event,
}));
assert.equal(received.length, 1, 'unsubscribed listeners receive no late events');

let resets = 0;
worker.onDelegationReset(() => { resets += 1; });
(worker as unknown as { ready: boolean }).ready = true;
(worker as unknown as { handleExit: (error: Error) => void }).handleExit(new Error('simulated worker crash'));
assert.equal(resets, 1, 'a live worker crash emits one delegation reset');
(worker as unknown as { handleExit: (error: Error) => void }).handleExit(new Error('duplicate exit notification'));
assert.equal(resets, 1, 'duplicate exit notifications do not emit duplicate resets');

console.log('Late worker delegation event routing tests passed');
