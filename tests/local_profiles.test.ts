import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LocalProfileError,
  LocalProfileRegistry,
  discoverLocalProfiles,
  resolveTaskProfile,
} from '../server/local-profiles.js';

const hermesHome = join(process.cwd(), `.test-hermes-profiles-${process.pid}`);

try {
  await mkdir(join(hermesHome, 'profiles', 'writer'), { recursive: true });
  await writeFile(join(hermesHome, 'profiles', 'writer', 'profile.yaml'), 'description: Writes product copy\n');

  await mkdir(join(hermesHome, 'profiles', 'researcher'), { recursive: true });
  await writeFile(join(hermesHome, 'profiles', 'researcher', 'profile.yaml'), 'description: "Researches local sources"\n');

  await mkdir(join(hermesHome, 'profiles', 'missing-metadata'), { recursive: true });
  await mkdir(join(hermesHome, 'profiles', 'bad name'), { recursive: true });
  await writeFile(join(hermesHome, 'profiles', 'bad name', 'profile.yaml'), 'description: ignored\n');
  await mkdir(join(hermesHome, 'profiles', 'malformed'), { recursive: true });
  await writeFile(join(hermesHome, 'profiles', 'malformed', 'profile.yaml'), 'description: [unterminated\n');
  await writeFile(join(hermesHome, 'profiles', 'not-a-directory'), 'description: ignored\n');

  const profiles = discoverLocalProfiles(hermesHome);
  assert.deepEqual(profiles, [
    { id: 'default', label: 'Default', description: 'Default local Hermes profile', isDefault: true },
    { id: 'researcher', label: 'researcher', description: 'Researches local sources', isDefault: false },
    { id: 'writer', label: 'writer', description: 'Writes product copy', isDefault: false },
  ]);
  assert.equal(JSON.stringify(profiles).includes(hermesHome), false, 'profile paths must stay server-side');
  assert.equal('baseUrl' in profiles[1], false);
  assert.equal('remoteProfile' in profiles[1], false);

  const registry = new LocalProfileRegistry(hermesHome);
  assert.equal(registry.require('writer').hermesHome, join(hermesHome, 'profiles', 'writer'));
  assert.deepEqual(resolveTaskProfile(registry, {}), { profileName: null, routingSource: null });
  assert.deepEqual(resolveTaskProfile(registry, { requestedProfileName: 'writer' }), {
    profileName: 'writer',
    routingSource: 'manual',
  });
  assert.deepEqual(resolveTaskProfile(registry, { requestedProfileName: 'default' }), {
    profileName: 'default',
    routingSource: 'manual',
  });

  assert.throws(
    () => resolveTaskProfile(registry, { requestedProfileName: 'missing' }),
    (error) => error instanceof LocalProfileError && error.status === 400 && /unknown local Hermes profile/i.test(error.message),
  );
  assert.throws(
    () => resolveTaskProfile(registry, { requestedProfileName: 42 }),
    (error) => error instanceof LocalProfileError && error.status === 400,
  );
} finally {
  await rm(hermesHome, { recursive: true, force: true });
}

console.log('Local Hermes profile discovery tests passed');
