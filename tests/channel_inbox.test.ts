import assert from 'node:assert/strict';
import {
  channelMessageAuthor,
  channelMessagesStatusText,
  channelThreadsStatusText,
  enabledChannelInboxes,
} from '../client/src/lib/channelInbox.js';
import type { HermesChannel } from '../shared/types.js';

const channels: HermesChannel[] = [
  { id: 'telegram', displayLabel: 'Telegram', enabled: true, health: 'healthy' },
  { id: 'discord', displayLabel: 'Discord', enabled: false, health: 'inactive' },
  { id: 'api', displayLabel: 'Api', enabled: true, health: 'healthy' },
  { id: 'api-server', displayLabel: 'Api Server', enabled: true, health: 'healthy' },
  { id: 'api_server', displayLabel: 'Api Server', enabled: true, health: 'healthy' },
  { id: 'webhook', displayLabel: 'Webhook', enabled: true, health: 'healthy' },
];

assert.deepEqual(enabledChannelInboxes(channels), [channels[0]],
  'the UI must reject internal transports even if a server regression returns them as enabled');

assert.equal(channelThreadsStatusText({ state: 'awaiting_bridge', threads: [] }),
  'Local Hermes history is not available yet.');
assert.equal(channelThreadsStatusText({ state: 'available', threads: [] }), 'No local conversations yet.');
assert.equal(channelThreadsStatusText({
  state: 'available',
  threads: [{ id: 'thread', channelId: 'telegram', title: 'Chat', preview: '', messageCount: 1, createdAt: 1, updatedAt: 2 }],
}), null);
assert.equal(channelMessagesStatusText({ state: 'awaiting_bridge', messages: [], truncated: false }),
  'Local Hermes history is not available yet.');
assert.equal(channelMessagesStatusText({ state: 'available', messages: [], truncated: false }),
  'No visible user or assistant messages in this conversation.');
assert.equal(channelMessageAuthor('inbound'), 'User');
assert.equal(channelMessageAuthor('outbound'), 'Assistant');

console.log('Channel inbox filtering and display helper tests passed');