import assert from 'node:assert/strict';
import {
  REMOTE_PROFILE_IDS,
  RemoteProfileRoutingError,
  buildRemoteProfileRegistry,
  resolveTaskRouting,
} from '../server/remote-profiles.js';

const env = {
  SOM_GATEWAY_URL: 'https://som.example.test',
  SOM_KEY: 'som-secret',
  SOMCHAI_GATEWAY_URL: 'https://somchai.example.test',
  SOMCHAI_KEY: 'somchai-secret',
  SOMBOON_GATEWAY_URL: 'https://somboon.example.test',
  SOMBOON_KEY: 'somboon-secret',
};

const configured = buildRemoteProfileRegistry({
  env,
  json: JSON.stringify({
    som: { baseUrl: '$SOM_GATEWAY_URL', apiKeyEnv: 'SOM_KEY' },
    somboon: { baseUrl: '$SOMBOON_GATEWAY_URL', apiKeyEnv: 'SOMBOON_KEY' },
  }),
});

assert.deepEqual(REMOTE_PROFILE_IDS, ['som', 'somchai', 'somboon']);

const publicProfiles = configured.publicProfiles();
assert.equal(publicProfiles.length, 3);
assert.equal(publicProfiles.find((profile) => profile.id === 'som')?.available, true);
assert.equal(publicProfiles.find((profile) => profile.id === 'somchai')?.available, false);
assert.equal(publicProfiles.find((profile) => profile.id === 'som')?.remoteProfile, 'som-spirithouse-wine');
assert.equal(JSON.stringify(publicProfiles).includes('secret'), false);
assert.equal(JSON.stringify(publicProfiles).includes('example.test'), false);

assert.deepEqual(resolveTaskRouting(configured, { requestedProfileName: 'som', description: 'anything' }), {
  profileName: 'som',
  routingSource: 'manual',
});

assert.throws(
  () => resolveTaskRouting(configured, { requestedProfileName: 'somchai', description: 'anything' }),
  /unavailable/i,
);

assert.throws(
  () => resolveTaskRouting(configured, { requestedProfileName: 'som-spirithouse-wine', description: 'anything' }),
  /unknown/i,
);

assert.deepEqual(resolveTaskRouting(configured, { description: 'Please update Spirit House wine inventory' }), {
  profileName: 'som',
  routingSource: 'automatic',
});

assert.deepEqual(resolveTaskRouting(configured, { description: 'General maintenance task' }), {
  profileName: 'somboon',
  routingSource: 'automatic',
});

const somUnavailable = buildRemoteProfileRegistry({
  env,
  json: JSON.stringify({
    somboon: { baseUrl: '$SOMBOON_GATEWAY_URL', apiKeyEnv: 'SOMBOON_KEY' },
  }),
});

const localOnly = buildRemoteProfileRegistry({ env: {}, json: '{}' });
assert.deepEqual(resolveTaskRouting(localOnly, { description: 'Create a portable installation sentinel' }), {
  profileName: null,
  routingSource: null,
});

assert.throws(
  () => resolveTaskRouting(somUnavailable, { description: 'Clear wine request' }),
  (error) => error instanceof RemoteProfileRoutingError && error.status === 409 && /unavailable/i.test(error.message),
);

const allConfigured = buildRemoteProfileRegistry({
  env,
  json: JSON.stringify({
    som: { baseUrl: '$SOM_GATEWAY_URL', apiKeyEnv: 'SOM_KEY' },
    somchai: { baseUrl: '$SOMCHAI_GATEWAY_URL', apiKeyEnv: 'SOMCHAI_KEY' },
    somboon: { baseUrl: '$SOMBOON_GATEWAY_URL', apiKeyEnv: 'SOMBOON_KEY' },
  }),
});

assert.deepEqual(resolveTaskRouting(allConfigured, { description: 'Please work on Chili   Radio scheduling' }), {
  profileName: 'somchai',
  routingSource: 'automatic',
});

assert.deepEqual(resolveTaskRouting(allConfigured, { requestedProfileName: 'somchai', description: 'Write a wine description' }), {
  profileName: 'somchai',
  routingSource: 'manual',
});

assert.throws(
  () => resolveTaskRouting(configured, { requestedProfileName: 'somchai', description: 'Chili Radio' }),
  /unavailable/i,
);

assert.throws(
  () => resolveTaskRouting(configured, { description: 'Chili Radio station update' }),
  (error) => error instanceof RemoteProfileRoutingError && error.status === 409 && /unavailable/i.test(error.message),
);

console.log('Remote profile routing tests passed');
