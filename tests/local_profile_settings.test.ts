import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LocalProfileRegistry,
  readProfileSettings,
  updateProfileSettings,
} from '../server/local-profiles.js';

const hermesHome = join(process.cwd(), `.test-profile-settings-${process.pid}`);
const profileId = 'immutable-id';
const profileHome = join(hermesHome, 'profiles', profileId);
const originalConfig = 'model:\n  provider: openai\n  default: gpt-test\n';

try {
  await mkdir(profileHome, { recursive: true });
  await writeFile(join(profileHome, 'profile.yaml'), 'display_name: Original name\ndescription: Test profile\n');
  await writeFile(join(profileHome, 'config.yaml'), originalConfig);
  await writeFile(join(profileHome, 'SOUL.md'), 'Stay focused.\n');

  const registry = new LocalProfileRegistry(hermesHome);
  const target = registry.require(profileId);
  const updated = await updateProfileSettings(target, { displayName: 'Friendly name' });

  assert.equal(updated.id, profileId, 'renaming must not change the immutable profile id');
  assert.equal(updated.displayName, 'Friendly name');
  assert.equal((await readProfileSettings(registry.require(profileId))).displayName, 'Friendly name');
  assert.equal(registry.publicProfiles().find((profile) => profile.id === profileId)?.label, 'Friendly name');
  assert.equal(await readFile(join(profileHome, 'config.yaml'), 'utf8'), originalConfig, 'display-name-only updates must not rewrite config');
  assert.equal(await readFile(join(profileHome, 'SOUL.md'), 'utf8'), 'Stay focused.\n', 'display-name-only updates must not rewrite SOUL.md');
} finally {
  await rm(hermesHome, { recursive: true, force: true });
}

console.log('Local profile settings tests passed');
