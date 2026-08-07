import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  formatMessageTimestamp,
  getShowMessageTimestamps,
  messageTimestampTitle,
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
  assert.equal(messageTimestampTitle({ created_at: createdAt }, 'en-US', 'UTC'), 'Jan 2, 2025, 3:04 AM');
  assert.equal(messageTimestampTitle({ created_at: 0 }, 'en-US', 'UTC'), undefined);
}

const taskChatSource = await readFile('client/src/components/TaskChat.tsx', 'utf8');
assert.match(taskChatSource, /import \{ messageTimestampTitle \} from ['"]\.\.\/lib\/messageTimestamps['"]/);
assert.equal(
  taskChatSource.match(/const timestampLabel = messageTimestampTitle\(msg\);/g)?.length,
  2,
  'both user questions and assistant replies derive a timestamp label',
);
assert.equal(
  taskChatSource.match(/title=\{timestampLabel\}/g)?.length,
  2,
  'both message types retain a native timestamp fallback',
);
assert.equal(
  taskChatSource.match(/onMouseEnter=\{\(event\) => showHoverTimestamp\(event, timestampLabel\)\}/g)?.length,
  2,
  'both user questions and assistant replies open the cursor-following timestamp tooltip',
);
assert.match(
  taskChatSource,
  /data-message-timestamp="pointer-tooltip"/,
  'the shared timestamp tooltip is rendered once near the pointer',
);
assert.equal(
  taskChatSource.match(/data-message-timestamp="visible-hover"/g)?.length,
  2,
  'both duplicate visual timestamp labels are explicitly marked',
);
assert.doesNotMatch(
  taskChatSource,
  /\{shouldShowReplyCopyButton\([^)]*\) && \([\s\S]*?<div className="mt-1 flex/,
  'assistant timestamps must not depend on reply copy-button visibility',
);

console.log('Message timestamp tests passed');
