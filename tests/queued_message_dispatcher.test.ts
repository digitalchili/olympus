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

let releaseDelivery!: () => void;
const heldDelivery = new Promise<void>(resolve => { releaseDelivery = resolve; });
let inFlight = 0;
let peakInFlight = 0;
let calls = 0;
let otherTaskCalls = 0;
const concurrent = createQueuedMessageDispatcher({
  load: () => queue,
  isActive: () => false,
  deliver: async (taskId) => {
    if (taskId === 'task-2') { otherTaskCalls += 1; return; }
    calls += 1;
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await heldDelivery;
    inFlight -= 1;
  },
  defer: (work) => queueMicrotask(work),
});
concurrent.schedule('task-1');
await new Promise(resolve => setTimeout(resolve, 0));
concurrent.schedule('task-1');
concurrent.schedule('task-2');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(peakInFlight, 1, 'repeated queue ticks must not overlap delivery of the same task');
assert.equal(otherTaskCalls, 1, 'another task may be delivered while this task is waiting');
releaseDelivery();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(calls, 2, 'a schedule during delivery is retried after it settles');

let releaseConsumed!: () => void;
const consumedGate = new Promise<void>(resolve => { releaseConsumed = resolve; });
let saved: typeof queue | undefined = queue;
let consumedCalls = 0;
const consumed = createQueuedMessageDispatcher({
  load: () => saved,
  isActive: () => false,
  deliver: async () => { consumedCalls += 1; await consumedGate; saved = undefined; },
  defer: (work) => queueMicrotask(work),
});
consumed.schedule('task-1');
await new Promise(resolve => setTimeout(resolve, 0));
consumed.schedule('task-1');
releaseConsumed();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(consumedCalls, 1, 'a consumed message is not delivered again after a pending schedule');

let rejectDelivery!: (error: Error) => void;
const failedGate = new Promise<void>((_resolve, reject) => { rejectDelivery = reject; });
let failedCalls = 0;
let errors = 0;
const failed = createQueuedMessageDispatcher({
  load: () => queue,
  isActive: () => false,
  deliver: async () => { failedCalls += 1; if (failedCalls === 1) await failedGate; },
  onError: () => { errors += 1; },
  defer: (work) => queueMicrotask(work),
});
failed.schedule('task-1');
await new Promise(resolve => setTimeout(resolve, 0));
failed.schedule('task-1');
assert.equal(failedCalls, 1, 'a retry must not overlap a still-running delivery');
rejectDelivery(new Error('delivery failed'));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(errors, 1, 'the failed delivery reaches the error handler');
assert.equal(failedCalls, 2, 'a pending schedule retries after failure settles');

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
