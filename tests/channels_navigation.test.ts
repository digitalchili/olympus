import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  channelInboxPath,
  enabledChannelInboxes,
  selectedChannelInbox,
} from '../client/src/lib/channelInbox.js';
import type { HermesChannel } from '../shared/types.js';

const telegram: HermesChannel = {
  id: 'telegram',
  displayLabel: 'Telegram',
  enabled: true,
  health: 'healthy',
};
const matrix: HermesChannel = {
  id: 'matrix',
  displayLabel: 'Matrix',
  enabled: true,
  health: 'degraded',
};
const channels: HermesChannel[] = [
  telegram,
  { id: 'discord', displayLabel: 'Discord', enabled: false, health: 'inactive' },
  { id: 'api', displayLabel: 'Api', enabled: true, health: 'healthy' },
  matrix,
];

assert.deepEqual(enabledChannelInboxes(channels), [telegram, matrix]);
assert.equal(selectedChannelInbox([telegram, matrix], 'matrix'), matrix);
assert.equal(selectedChannelInbox([telegram, matrix], 'missing'), telegram);
assert.equal(selectedChannelInbox([], 'telegram'), null);
assert.equal(channelInboxPath('google chat'), '/channels?channel=google%20chat');

const [appSource, boardSource, columnSource, sidebarSource, pageSource] = await Promise.all([
  readFile('client/src/App.tsx', 'utf8'),
  readFile('client/src/components/Board.tsx', 'utf8'),
  readFile('client/src/components/Column.tsx', 'utf8'),
  readFile('client/src/components/Sidebar.tsx', 'utf8'),
  readFile('client/src/components/ChannelsPage.tsx', 'utf8'),
]);

assert.match(appSource, /path="\/channels" element=\{<ChannelsPage \/>\}/,
  'the main app must expose the standalone channels route');
assert.doesNotMatch(boardSource, /ChannelInboxCard|fetchHermesChannels|pinnedChannelInboxes|enabledChannelInboxes/,
  'the task board must not discover or render channel inbox cards');
assert.doesNotMatch(columnSource, /ChannelInboxCard|channelProfileId|channels\??:/,
  'task columns must only render tasks');
assert.match(sidebarSource, />\s*Channels\s*</, 'the sidebar must include a Channels section');
assert.match(sidebarSource, /fetchHermesChannels\(activeProfileId\)/,
  'sidebar discovery must use only the active profile');
assert.ok(sidebarSource.indexOf('label="Files"') < sidebarSource.indexOf('>Search</span>'),
  'Search must appear below Files in source order');
assert.match(pageSource, /fetchHermesChannels\(activeProfileId\)/,
  'the Channels page must scope discovery to the active profile');
assert.match(pageSource, /<ChannelInboxCard[\s\S]*profileId=\{activeProfileId\}/,
  'the Channels page must reuse the profile-scoped read-only inbox card');
assert.match(pageSource, /to="\/settings#channels"/,
  'the Channels page must preserve access to channel settings');

console.log('Standalone Channels navigation regression tests passed');
