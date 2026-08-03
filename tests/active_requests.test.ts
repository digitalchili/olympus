import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createActiveRequestTracker } from '../server/active-requests.js';

const tracker = createActiveRequestTracker();
const response = new EventEmitter();
let nextCalled = false;
tracker.middleware({ method: 'POST', path: '/api/tasks' } as never, response as never, () => { nextCalled = true; });
assert.equal(nextCalled, true);
assert.equal(tracker.count(), 1);
response.emit('finish');
assert.equal(tracker.count(), 0);
response.emit('close');
assert.equal(tracker.count(), 0);

tracker.middleware({ method: 'GET', path: '/api/tasks' } as never, new EventEmitter() as never, () => {});
assert.equal(tracker.count(), 0);

console.log('Active request tracker tests passed');
