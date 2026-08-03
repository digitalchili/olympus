import assert from 'node:assert/strict';
import {
  applyProfileMentionSelection,
  findActiveProfileMention,
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

console.log('Profile mention parser tests passed');
