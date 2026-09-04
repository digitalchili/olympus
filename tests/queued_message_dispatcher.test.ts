import assert from 'node:assert/strict';
import { assertQueuedMessageDeliveryResponse, createQueuedMessageDispatcher } from '../server/queued-message-dispatcher.js';

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

await assert.doesNotReject(() => assertQueuedMessageDeliveryResponse({
  ok: true,
  status: 200,
  text: async () => '{"action":"commit_push"}',
}));
await assert.doesNotReject(() => assertQueuedMessageDeliveryResponse({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ action: 'commit_push', version: { changedFiles: Array.from({ length: 100 }, (_, index) => `file-${index}.txt`) } }),
}));
await assert.doesNotReject(() => assertQueuedMessageDeliveryResponse({
  ok: true,
  status: 202,
  text: async () => 'run accepted',
}));
await assert.rejects(() => assertQueuedMessageDeliveryResponse({
  ok: true,
  status: 200,
  text: async () => '{"action":"not_commit_push"}',
}), /HTTP 200: expected commit_push response/);
await assert.rejects(() => assertQueuedMessageDeliveryResponse({
  ok: true,
  status: 200,
  text: async () => 'not json',
}), /HTTP 200: expected commit_push JSON/);
await assert.rejects(() => assertQueuedMessageDeliveryResponse({
  ok: true,
  status: 204,
  text: async () => 'unexpected success shape',
}), /HTTP 204: unexpected success shape/);
await assert.rejects(() => assertQueuedMessageDeliveryResponse({
  ok: false,
  status: 409,
  text: async () => 'queue conflict',
}), /HTTP 409: queue conflict/);
