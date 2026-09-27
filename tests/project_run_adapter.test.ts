import assert from 'node:assert/strict';
import { HermesWorkerAdapter, buildChatWorkerRequest } from '../server/adapters/hermes-worker.js';
import { ProfileAgentAdapter } from '../server/adapters/routing.js';
import type { ProjectRunRespondRequest } from '../server/adapters/types.js';

assert.equal(buildChatWorkerRequest('task', 'Read source', { projectRun: true }).projectRun, true);
assert.equal('projectRun' in buildChatWorkerRequest('task', 'Hello'), false);
assert.equal('projectRun' in buildChatWorkerRequest('task', 'Hello', { projectRun: false }), false);
const adapter = new HermesWorkerAdapter();
const request = { requestId: 'request', workerRunId: 'run', command: 'npm test', secrets: ['DATABASE_URL'] };
const sent: unknown[] = [];
// Replace only the subprocess boundary; exercise stream mapping and RPC transport.
Object.assign(adapter, { client: {
  onDelegationEvent() { return () => {}; },
  onDelegationReset() { return () => {}; },
  async *stream(input: unknown) {
    sent.push(input);
    yield { id: 'run', type: 'project_run_requested', projectRun: request };
    yield { id: 'run', type: 'done', sessionId: 'task' };
  },
  async request(input: unknown) { sent.push(input); return { accepted: true }; },
} });
const events = [];
for await (const event of adapter.chatStream('task', 'Read source', { projectRun: true })) events.push(event);
assert.deepEqual(events[0], { type: 'project_run_requested', projectRun: request });
const response: ProjectRunRespondRequest = { taskId: 'task', ...request, result: { ok: true, exitCode: 0, output: 'safe', truncated: false } };
await adapter.respondProjectRun(response);
assert.deepEqual(sent[1], { type: 'project.run.respond', ...response });

const routed = new ProfileAgentAdapter(adapter);
const taskIds: string[] = [];
Object.assign(routed, { async adapterForTaskId(taskId: string) { taskIds.push(taskId); return adapter; } });
await routed.respondProjectRun(response);
assert.deepEqual(taskIds, ['task']);
assert.deepEqual(sent[2], { type: 'project.run.respond', ...response });
Object.assign(routed, { async adapterForTaskId() { return {}; } });
await assert.rejects(routed.respondProjectRun(response), /Project commands are unavailable/);
console.log('Project command adapter request, stream, reply and task routing tests passed');

// Terminal transport signals fire while the consumer is paused on a private request.
const { HermesWorkerClient } = await import('../server/adapters/hermes-worker.js');
for (const failure of ['terminal', 'exit']) {
  const client = new HermesWorkerClient('/unused-test-home');
  let id = ''; let closed = 0;
  Object.assign(client, { async start() {}, write(input: { id: string }) {
    id = input.id;
    (client as any).handleLine(JSON.stringify({ id, type: 'project_run_requested', projectRun: request }));
  } });
  const stream = client.stream(buildChatWorkerRequest('task', 'Test'), () => { closed++; });
  assert.equal((await stream.next()).value?.type, 'project_run_requested');
  assert.equal(closed, 0);
  if (failure === 'terminal') {
    (client as any).handleLine(JSON.stringify({ id, type: 'done' }));
    assert.equal(closed, 1, 'terminal signals before consumer drains the event');
    await stream.next();
  } else {
    (client as any).failPending(new Error('Synthetic worker exit'));
    assert.equal(closed, 1, 'worker failure signals before next stream read');
    await assert.rejects(stream.next(), /Synthetic worker exit/);
  }
  await stream.return(undefined);
  assert.equal(closed, 1);
}
const closedCallback = () => {};
assert.equal('onStreamClosed' in buildChatWorkerRequest('task', 'Hello', { onStreamClosed: closedCallback }), false);
