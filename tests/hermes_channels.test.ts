import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverHermesChannels } from '../server/hermes-channels.js';

const hermesHome = join(process.cwd(), `.test-hermes-channels-${process.pid}`);

try {
  await mkdir(hermesHome, { recursive: true });
  await writeFile(join(hermesHome, 'gateway.json'), JSON.stringify({
    platforms: {
      matrix: { enabled: true, token: 'legacy-secret-token' },
      api_server: { enabled: true, token: 'never-expose-api-token' },
    },
  }));
  await writeFile(join(hermesHome, 'config.yaml'), `
gateway:
  platforms:
    google_chat:
      enabled: true
      extra:
        client_secret: never-expose-this
platforms:
  webhook:
    enabled: true
    secret: never-expose-webhook-secret
  "not a safe id":
    enabled: true
discord:
  enabled: false
  token: never-expose-discord-token
`);
  await writeFile(join(hermesHome, 'gateway_state.json'), JSON.stringify({
    gateway_state: 'running',
    platforms: {
      telegram: { state: 'connected', error_message: 'never expose runtime errors' },
      discord: { state: 'connected' },
      matrix: { state: 'fatal', error_message: 'contains internal details' },
      google_chat: { state: 'disconnected' },
      api: { state: 'connected' },
      webhook: { state: 'connected' },
    },
  }));

  const channels = await discoverHermesChannels(hermesHome);
  assert.deepEqual(channels, [
    { id: 'discord', displayLabel: 'Discord', enabled: false, health: 'inactive' },
    { id: 'google_chat', displayLabel: 'Google Chat', enabled: true, health: 'degraded' },
    { id: 'matrix', displayLabel: 'Matrix', enabled: true, health: 'degraded' },
    { id: 'telegram', displayLabel: 'Telegram', enabled: true, health: 'healthy' },
  ]);

  const serialized = JSON.stringify(channels);
  for (const forbidden of [
    'legacy-secret-token',
    'never-expose-api-token',
    'never-expose-this',
    'never-expose-webhook-secret',
    'never-expose-discord-token',
    'never expose runtime errors',
    'contains internal details',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `channel discovery leaked ${forbidden}`);
  }
  assert.equal(serialized.includes(hermesHome), false, 'profile paths must stay server-side');
  assert.equal(serialized.includes('not a safe id'), false, 'unsafe config keys are not channel IDs');
  assert.equal(channels.some((channel) => ['api', 'api_server', 'webhook'].includes(channel.id)), false,
    'Hermes infrastructure transports must never become channel inboxes');

  await writeFile(join(hermesHome, 'config.yaml'), 'platforms: [invalid');
  await writeFile(join(hermesHome, 'gateway_state.json'), '{invalid');
  assert.deepEqual(await discoverHermesChannels(hermesHome), [
    { id: 'matrix', displayLabel: 'Matrix', enabled: true, health: 'unknown' },
  ], 'malformed current files still permit safe legacy discovery');
} finally {
  await rm(hermesHome, { recursive: true, force: true });
}

console.log('Safe Hermes channel discovery tests passed');
