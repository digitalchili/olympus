import assert from 'node:assert/strict';
import { applyBotProfileMentionSelection, applyProfileMentionSelection } from '../client/src/lib/profileMentions.js';
const profile = { id: 'writer', label: 'Writing bot' };
const selected = applyBotProfileMentionSelection('Ask @wr about this', { start: 4, end: 7 }, profile);
assert.equal(selected.text, 'Ask @writer about this');
assert.equal(selected.cursor, 12);
assert.equal(applyProfileMentionSelection('Ask @wr about this', { start: 4, end: 7 }, profile).text, 'Ask about this', 'ordinary task invitations retain existing behavior');
console.log('Bot mentions remain literal message content');
