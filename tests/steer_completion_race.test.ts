import assert from 'node:assert/strict';
import { ApiError } from '../client/src/lib/api.js';
import { deliverQueuedSteer } from '../client/src/lib/steerDelivery.js';

let followUpCalls = 0;
const outcome = await deliverQueuedSteer(
  async () => {
    throw new ApiError('This task has no active message to steer', 409);
  },
  async () => {
    followUpCalls += 1;
  },
);

assert.equal(outcome, 'follow-up');
assert.equal(followUpCalls, 1);

console.log('Steer completion race test passed');
