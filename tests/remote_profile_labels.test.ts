import assert from 'node:assert/strict';
import { remoteProfileLabel, taskRoutingLabel } from '../client/src/lib/remoteProfiles.js';
import type { Task } from '../shared/types.js';

assert.equal(remoteProfileLabel('writer-production'), 'writer-production');
assert.equal(remoteProfileLabel('som'), 'som');
assert.equal(remoteProfileLabel(null), null);

const task = {
  profile_name: 'writer-production',
  routing_source: 'automatic',
} as Task;
assert.equal(taskRoutingLabel(task), 'Automatically routed to writer-production');

console.log('Remote profile label tests passed');
