import assert from 'node:assert/strict';
import { profileLabel, taskProfileLabel } from '../client/src/lib/profiles.js';
import type { Task } from '../shared/types.js';

assert.equal(profileLabel('writer'), 'writer');
assert.equal(profileLabel(null), null);

const task = {
  profile_name: 'writer',
  routing_source: 'manual',
} as Task;
assert.equal(taskProfileLabel(task), 'Local profile: writer');
assert.equal(taskProfileLabel({ profile_name: null } as Task), null);

console.log('Local profile label tests passed');
