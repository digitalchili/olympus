import assert from 'node:assert/strict';
import { HermesWorkerAdapter, buildChatWorkerRequest } from '../server/adapters/hermes-worker.js';
import { ProfileAgentAdapter } from '../server/adapters/routing.js';
import type { ProjectGitHubRespondRequest } from '../server/adapters/types.js';

assert.equal(buildChatWorkerRequest('task', 'Read source', { projectGitHub: true }).projectGitHub, true);
assert.equal('projectGitHub' in buildChatWorkerRequest('task', 'Hello'), false);
assert.equal('projectGitHub' in buildChatWorkerRequest('task', 'Hello', { projectGitHub: false }), false);
const adapter = new HermesWorkerAdapter();
const request = { requestId: 'request', workerRunId: 'run', action: 'clone' as const, repository: 'owner/repo' };
const sent: unknown[] = [];
// Replace only the subprocess boundary; exercise stream mapping and RPC transport.
Object.assign(adapter, { client: {
  onDelegationEvent() { return () => {}; },
  onDelegationReset() { return () => {}; },
  async *stream(input: unknown) {
    sent.push(input);
    yield { id: 'run', type: 'project_github_requested', projectGitHub: request };
    yield { id: 'run', type: 'done', sessionId: 'task' };
  },
  async request(input: unknown) { sent.push(input); return { accepted: true }; },
} });
const events = [];
for await (const event of adapter.chatStream('task', 'Read source', { projectGitHub: true })) events.push(event);
assert.deepEqual(events[0], { type: 'project_github_requested', projectGitHub: request });
const response: ProjectGitHubRespondRequest = { taskId: 'task', ...request, result: { ok: true, path: '/source' } };
await adapter.respondProjectGitHub(response);
assert.deepEqual(sent[1], { type: 'project.github.respond', ...response });

const routed = new ProfileAgentAdapter(adapter);
const taskIds: string[] = [];
Object.assign(routed, { async adapterForTaskId(taskId: string) { taskIds.push(taskId); return adapter; } });
await routed.respondProjectGitHub(response);
assert.deepEqual(taskIds, ['task']);
assert.deepEqual(sent[2], { type: 'project.github.respond', ...response });
Object.assign(routed, { async adapterForTaskId() { return {}; } });
await assert.rejects(routed.respondProjectGitHub(response), /Project GitHub access is unavailable/);
console.log('Project GitHub adapter request, stream, reply and task routing tests passed');
