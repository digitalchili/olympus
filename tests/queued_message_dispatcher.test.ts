import assert from 'node:assert/strict';
import { createQueuedMessageDispatcher } from '../server/queued-message-dispatcher.js';

const queue = { id: 'queue-1' };
let active = true;
let deliveries = 0;
let currentQueue: typeof queue | undefined = queue;
const dispatcher = createQueuedMessageDispatcher({
  load: () => currentQueue,
  isActive: () => active,
  deliver: async (_taskId, message) => {
    assert.equal(message, queue);
    deliveries += 1;
  },
  defer: (work) => queueMicrotask(work),
});

dispatcher.schedule('task-1');
dispatcher.schedule('task-1');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(deliveries, 0, 'an active run keeps the durable follow-up queued');

active = false;
dispatcher.schedule('task-1');
dispatcher.schedule('task-1');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(deliveries, 1, 'settlement launches one browser-independent delivery despite duplicate schedules');

currentQueue = undefined;
dispatcher.schedule('task-1');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(deliveries, 1, 'an empty queue is a no-op');
