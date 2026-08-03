import assert from 'node:assert/strict';
import {
  formatMessageTimestamp,
  getShowMessageTimestamps,
  selectMessageTimestamp,
  setShowMessageTimestamps,
} from '../client/src/lib/messageTimestamps.js';

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

{
  const storage = createStorage();
  assert.equal(getShowMessageTimestamps(storage), true);

  setShowMessageTimestamps(false, storage);
  assert.equal(getShowMessageTimestamps(storage), false);

  setShowMessageTimestamps(true, storage);
  assert.equal(getShowMessageTimestamps(storage), true);
}

{
  const createdAt = Date.UTC(2025, 0, 2, 3, 4);
  const completedAt = createdAt + 5_000;
  assert.equal(selectMessageTimestamp({ created_at: createdAt, completed_at: completedAt }), completedAt);
  assert.equal(selectMessageTimestamp({ created_at: createdAt }), createdAt);
  assert.equal(selectMessageTimestamp({ created_at: createdAt, completed_at: 0 }), createdAt);
  assert.equal(selectMessageTimestamp({ created_at: 0 }), null);
  assert.equal(formatMessageTimestamp(createdAt, 'en-US', 'UTC'), 'Jan 2, 2025, 3:04 AM');
}

console.log('Message timestamp tests passed');
