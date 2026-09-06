import assert from 'node:assert/strict';
import { buildChatWorkerRequest, HermesWorkerAdapter } from '../server/adapters/hermes-worker.js';
import { ProfileAgentAdapter } from '../server/adapters/routing.js';
import type { AgentAdapter, AgentRunOptions } from '../server/adapters/types.js';

const bot = { profileId: 'alpha', peers: [{ id: 'beta', label: 'Beta', description: 'Research' }] };
const options: AgentRunOptions = { task: { id: 'bot-task' }, bot };
assert.deepEqual(buildChatWorkerRequest('bot-task', 'Hello', options).bot, bot);
assert.equal('bot' in buildChatWorkerRequest('task', 'Ordinary'), false);
const botMessage = { requestId: 'message-1', workerRunId: 'worker-1', target: 'beta', message: 'Check this' };
const sent: unknown[] = [];
const worker = new HermesWorkerAdapter();
Object.assign(worker, { client: {
  async *stream(request: unknown) { sent.push(request); yield { id: 'worker-1', type: 'bot_message_requested', botMessage }; yield { id: 'worker-1', type: 'done' }; },
  async request(request: unknown) { sent.push(request); return { accepted: true }; },
} });
const events = [];
for await (const event of worker.chatStream('bot-task', 'Hello', options)) events.push(event);
assert.deepEqual(events[0], { type: 'bot_message_requested', botMessage });
const reply = { taskId: 'bot-task', requestId: 'message-1', workerRunId: 'worker-1', result: { accepted: true, messageId: 'durable-1' } };
await worker.respondBotMessage(reply);
assert.deepEqual(sent[1], { type: 'bot.message.respond', ...reply });
const named: unknown[] = [];
const defaultAdapter = { respondBotMessage: async () => { throw Error('Wrong profile'); } } as unknown as AgentAdapter;
const router = new ProfileAgentAdapter(defaultAdapter, {
  taskProfile: id => id === 'bot-task' ? 'alpha' : null,
  registry: { require: () => ({ id: 'alpha', isDefault: false }) } as never,
  createAdapter: () => ({ respondBotMessage: async request => { named.push(request); } }) as AgentAdapter,
});
await router.respondBotMessage(reply);
assert.deepEqual(named, [reply]);
console.log('Bot worker protocol and profile routing passed');
