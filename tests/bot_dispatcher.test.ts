import assert from 'node:assert/strict';
import { createBotMessageDispatcher } from '../server/bot-message-dispatcher.js';

let paused = true;
const busy = new Set<string>();
const deliveries: string[] = [];
const errors: string[] = [];
const pending = [{ id: 'one', recipientTaskId: 'bot-a' }, { id: 'two', recipientTaskId: 'bot-a' }, { id: 'three', recipientTaskId: 'bot-b' }];
const dispatcher = createBotMessageDispatcher({
  canDispatch: () => !paused,
  load: () => [...pending],
  isBusy: id => busy.has(id),
  deliver: async message => {
    deliveries.push(message.id);
    busy.add(message.recipientTaskId);
    pending.splice(pending.findIndex(row => row.id === message.id), 1);
  },
  onError: (_row, error) => errors.push(String(error)),
});
await dispatcher.dispatch();
assert.deepEqual(deliveries, [], 'maintenance prevents new turns');
paused = false;
await Promise.all([dispatcher.dispatch(), dispatcher.dispatch()]);
assert.deepEqual(deliveries, ['one', 'three'], 'concurrent ticks keep FIFO and one turn per recipient');
busy.clear();
await dispatcher.dispatch();
assert.deepEqual(deliveries, ['one', 'three', 'two']);
assert.deepEqual(errors, []);
console.log('Bot dispatcher maintenance, concurrency and per-recipient FIFO passed');
