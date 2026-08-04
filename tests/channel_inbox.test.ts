import assert from 'node:assert/strict';
import { pinnedChannelInboxes } from '../client/src/lib/channelInbox.js';
import type { HermesChannel } from '../shared/types.js';

const channels: HermesChannel[] = [
  { id: 'telegram', displayLabel: 'Telegram', enabled: true, health: 'healthy' },
  { id: 'discord', displayLabel: 'Discord', enabled: false, health: 'inactive' },
  { id: 'api', displayLabel: 'Api', enabled: true, health: 'healthy' },
  { id: 'api-server', displayLabel: 'Api Server', enabled: true, health: 'healthy' },
  { id: 'api_server', displayLabel: 'Api Server', enabled: true, health: 'healthy' },
  { id: 'webhook', displayLabel: 'Webhook', enabled: true, health: 'healthy' },
];

assert.deepEqual(pinnedChannelInboxes(channels), [channels[0]],
  'the UI must reject internal transports even if a server regression returns them as enabled');

console.log('Channel inbox filtering tests passed');