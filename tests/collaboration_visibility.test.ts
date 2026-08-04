import assert from 'node:assert/strict';
import type { CollaborationRun, TaskMessage } from '../shared/types.js';
import { collaborationAssistantMessageIds } from '../client/src/lib/collaborationVisibility.js';

const messages = [
  { id: 'user-collab', role: 'user', content: 'Use the invited expert', created_at: 1_000 },
  {
    id: 'assistant-collab',
    role: 'assistant',
    content: 'Final synthesized answer',
    thinking: 'private reasoning',
    tools: [{ name: 'catalog', status: 'completed' }],
    created_at: 2_000,
  },
  { id: 'user-normal', role: 'user', content: 'Follow up', created_at: 40_000 },
  {
    id: 'assistant-normal',
    role: 'assistant',
    content: 'Normal answer',
    thinking: 'visible normal reasoning',
    created_at: 41_000,
  },
] as TaskMessage[];

const runs = [
  { question: 'Use the invited expert', created_at: 1_500 },
] as CollaborationRun[];

const hidden = collaborationAssistantMessageIds(messages, runs);
assert.deepEqual([...hidden], ['assistant-collab']);
assert.equal(hidden.has('assistant-normal'), false);

console.log('Collaboration answer visibility tests passed');
