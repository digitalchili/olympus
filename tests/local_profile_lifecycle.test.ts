import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LocalProfileError,
  LocalProfileRegistry,
  readProfileSettings,
  resolveTaskProfile,
  updateProfileSettings,
} from '../server/local-profiles.js';

const root = join(process.cwd(), `.test-profile-lifecycle-${process.pid}`);
const hermesHome = join(root, 'hermes');
const lifecycleHome = join(root, 'dispatch');

try {
  await mkdir(hermesHome, { recursive: true });
  await writeFile(join(hermesHome, 'config.yaml'), '{}\n');

  const registry = new LocalProfileRegistry(hermesHome, lifecycleHome);
  const created = await registry.create({
    id: 'research-guide',
    displayName: 'Research Guide',
    description: 'Finds and validates sources',
    provider: 'openai',
    model: 'gpt-test',
    reasoningEffort: 'high',
    soul: '# Research Guide\nBe precise.\n',
  });

  assert.equal(created.id, 'research-guide');
  assert.equal(created.active, true);
  assert.equal(registry.publicProfiles().some((profile) => profile.id === created.id), true);
  assert.deepEqual(await readProfileSettings(created), {
    id: 'research-guide',
    displayName: 'Research Guide',
    description: 'Finds and validates sources',
    provider: 'openai',
    model: 'gpt-test',
    reasoningEffort: 'high',
    soul: '# Research Guide\nBe precise.\n',
  });

  await updateProfileSettings(created, { displayName: 'Evidence Guide', description: 'Checks source quality' });
  assert.equal(registry.require(created.id).displayName, 'Evidence Guide');
  assert.equal(registry.require(created.id).id, 'research-guide', 'profile IDs remain immutable');

  await registry.setActive(created.id, false, 'default');
  assert.equal(registry.require(created.id).active, false);
  assert.equal(registry.publicProfiles().some((profile) => profile.id === created.id), false, 'inactive profiles stay out of selectors');
  assert.equal(registry.allPublicProfiles().some((profile) => profile.id === created.id), true, 'settings can still list inactive profiles');
  assert.throws(
    () => resolveTaskProfile(registry, { requestedProfileName: created.id }),
    (error) => error instanceof LocalProfileError && error.code === 'INACTIVE_PROFILE',
  );

  await registry.setActive(created.id, true, 'default');
  assert.equal(registry.require(created.id).active, true);
  await assert.rejects(
    () => registry.delete(created.id, 'wrong-id', 'default'),
    (error) => error instanceof LocalProfileError && error.code === 'PROFILE_ID_CONFIRMATION_REQUIRED',
  );
  await assert.rejects(
    () => registry.delete(created.id, created.id, created.id),
    (error) => error instanceof LocalProfileError && error.code === 'CURRENT_PROFILE',
  );

  const deleted = await registry.delete(created.id, created.id, 'default', { tasks: [{ id: 'task-1' }] });
  assert.equal(registry.get(created.id), null);
  assert.match(await readFile(join(deleted.backupDir, 'SOUL.md'), 'utf8'), /Be precise/);
  assert.deepEqual(JSON.parse(await readFile(join(deleted.backupDir, 'olympus-profile-data.json'), 'utf8')), {
    tasks: [{ id: 'task-1' }],
  });
  assert.match(await readFile(join(lifecycleHome, 'logs', 'profile-lifecycle.jsonl'), 'utf8'), /profile\.deleted/);

  await assert.rejects(
    () => registry.setActive('default', false, 'research-guide'),
    (error) => error instanceof LocalProfileError && error.code === 'PROTECTED_PROFILE',
  );
  await assert.rejects(
    () => registry.delete('default', 'default', 'research-guide'),
    (error) => error instanceof LocalProfileError && error.code === 'PROTECTED_PROFILE',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Local profile lifecycle tests passed');
