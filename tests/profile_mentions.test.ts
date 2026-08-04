import assert from 'node:assert/strict';
import {
  addProfileInvite,
  applyProfileMentionSelection,
  findActiveProfileMention,
  numericProfileSelectionIndex,
  removeProfileInvite,
} from '../client/src/lib/profileMentions.ts';

const profiles = [
  { id: 'som', label: 'Som' },
  { id: 'somchai', label: 'Somchai' },
  { id: 'somboon', label: 'Somboon' },
];

assert.deepEqual(findActiveProfileMention('Ask @so to check wine', 7, profiles), {
  start: 4,
  end: 7,
  query: 'so',
  options: profiles,
});

assert.equal(findActiveProfileMention('email a@b.com', 9, profiles), null);
assert.equal(findActiveProfileMention('leave @ alone', 7, profiles)?.query, '');

assert.deepEqual(applyProfileMentionSelection('Ask @so to check wine', { start: 4, end: 7 }, profiles[0]), {
  text: 'Ask to check wine',
  profile: profiles[0],
  cursor: 4,
});

assert.deepEqual(applyProfileMentionSelection('@somchai', { start: 0, end: 8 }, profiles[1]), {
  text: '',
  profile: profiles[1],
  cursor: 0,
});

assert.deepEqual(addProfileInvite([profiles[0]], profiles[1]), [profiles[0], profiles[1]]);
assert.strictEqual(addProfileInvite([profiles[0]], profiles[0])[0], profiles[0]);
assert.deepEqual(removeProfileInvite([profiles[0], profiles[1]], 'som'), [profiles[1]]);
assert.equal(numericProfileSelectionIndex('1', 3), 0);
assert.equal(numericProfileSelectionIndex('3', 3), 2);
assert.equal(numericProfileSelectionIndex('4', 3), null);
assert.equal(numericProfileSelectionIndex('0', 9), null);

console.log('Profile mention parser tests passed');
