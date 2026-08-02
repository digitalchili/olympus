import assert from 'node:assert/strict';
import { isVersionNewer, parseGitHubRepositoryUrl } from '../server/routes/updates.js';

assert.equal(isVersionNewer('1.2.11', '1.2.10'), true);
assert.equal(isVersionNewer('1.3.0', '1.2.99'), true);
assert.equal(isVersionNewer('1.2.10', '1.3.0'), false);
assert.equal(isVersionNewer('1.2.10', '1.2.10'), false);
assert.equal(isVersionNewer('invalid', '1.2.10'), false);
assert.equal(parseGitHubRepositoryUrl('https://github.com/leakim69/olympus-dispatch.git'), 'leakim69/olympus-dispatch');
assert.equal(parseGitHubRepositoryUrl('git@github.com:leakim69/olympus-dispatch.git'), 'leakim69/olympus-dispatch');

console.log('Update helper tests passed');
