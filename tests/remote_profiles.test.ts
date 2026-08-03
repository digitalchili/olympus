import assert from 'node:assert/strict';
import {
  RemoteProfileRoutingError,
  buildRemoteProfileRegistry,
  resolveTaskRouting,
} from '../server/remote-profiles.js';

const env = {
  WRITER_GATEWAY_URL: 'https://writer.example.test',
  WRITER_KEY: 'writer-secret',
};

const localOnly = buildRemoteProfileRegistry({ env: {}, json: null });
assert.deepEqual(localOnly.publicProfiles(), []);
assert.deepEqual(resolveTaskRouting(localOnly, { description: 'Hey' }), {
  profileName: null,
  routingSource: null,
});
assert.deepEqual(resolveTaskRouting(localOnly, { description: 'Write a wine description' }), {
  profileName: null,
  routingSource: null,
});

const configured = buildRemoteProfileRegistry({
  env,
  json: JSON.stringify({
    profiles: [
      {
        id: 'writer',
        label: 'Writing Agent',
        description: 'Remote writing profile',
        icon: 'pen',
        baseUrl: '$WRITER_GATEWAY_URL',
        apiKeyEnv: 'WRITER_KEY',
        remoteProfile: 'writer-production',
        remotePath: '/srv/writer',
      },
      {
        id: 'reviewer',
        label: 'Reviewer',
        baseUrl: '$REVIEWER_GATEWAY_URL',
        apiKeyEnv: 'REVIEWER_KEY',
      },
    ],
    routingRules: [
      { profile: 'writer', keywords: ['customer copy', 'landing page'] },
    ],
  }),
});

const publicProfiles = configured.publicProfiles();
assert.equal(publicProfiles.length, 2);
assert.deepEqual(publicProfiles[0], {
  id: 'writer',
  label: 'Writing Agent',
  description: 'Remote writing profile',
  icon: 'pen',
  available: true,
  remoteProfile: 'writer-production',
});
assert.equal(publicProfiles[1]?.id, 'reviewer');
assert.equal(publicProfiles[1]?.available, false);
assert.equal(JSON.stringify(publicProfiles).includes('secret'), false);
assert.equal(JSON.stringify(publicProfiles).includes('example.test'), false);

assert.deepEqual(resolveTaskRouting(configured, { requestedProfileName: 'writer', description: 'anything' }), {
  profileName: 'writer',
  routingSource: 'manual',
});
assert.deepEqual(resolveTaskRouting(configured, { description: 'Please prepare CUSTOMER COPY today' }), {
  profileName: 'writer',
  routingSource: 'automatic',
});
assert.deepEqual(resolveTaskRouting(configured, { description: 'Ordinary local task' }), {
  profileName: null,
  routingSource: null,
});

assert.throws(
  () => resolveTaskRouting(configured, { requestedProfileName: 'reviewer', description: 'anything' }),
  (error) => error instanceof RemoteProfileRoutingError && error.status === 409 && /unavailable/i.test(error.message),
);
assert.throws(
  () => resolveTaskRouting(configured, { requestedProfileName: 'missing', description: 'anything' }),
  (error) => error instanceof RemoteProfileRoutingError && error.status === 400 && /unknown/i.test(error.message),
);

const configuredDefault = buildRemoteProfileRegistry({
  env,
  json: JSON.stringify({
    defaultProfile: 'writer',
    profiles: [
      {
        id: 'writer',
        label: 'Writing Agent',
        baseUrl: '$WRITER_GATEWAY_URL',
        apiKeyEnv: 'WRITER_KEY',
      },
    ],
  }),
});
assert.deepEqual(resolveTaskRouting(configuredDefault, { description: 'Ordinary task' }), {
  profileName: 'writer',
  routingSource: 'automatic',
});

assert.throws(
  () => buildRemoteProfileRegistry({ json: JSON.stringify({ defaultProfile: 'missing', profiles: [] }) }),
  /default profile.*missing/i,
);
assert.throws(
  () => buildRemoteProfileRegistry({
    json: JSON.stringify({
      profiles: [{ id: 'one', label: 'One' }, { id: 'one', label: 'Duplicate' }],
    }),
  }),
  /duplicate remote profile/i,
);
assert.throws(
  () => buildRemoteProfileRegistry({
    json: JSON.stringify({
      profiles: [{ id: 'one', label: 'One' }],
      routingRules: [{ profile: 'missing', keywords: ['anything'] }],
    }),
  }),
  /routing rule.*missing/i,
);

console.log('Runtime profile registry tests passed');
