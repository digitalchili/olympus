import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Request } from 'express';
import { LocalProfileError, LocalProfileRegistry } from '../server/local-profiles.js';
import { requestProfile } from '../server/profile-context.js';
import { deleteInstalledSkill, listInstalledSkills } from '../server/routes/skills.js';

const hermesHome = join(process.cwd(), `.test-profile-skills-${process.pid}`);
const namedHome = join(hermesHome, 'profiles', 'specialist');

async function writeSkill(root: string, id: string, name: string): Promise<void> {
  await mkdir(join(root, id), { recursive: true });
  await writeFile(join(root, id, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\n`);
}

try {
  await mkdir(hermesHome, { recursive: true });
  await writeFile(join(hermesHome, 'config.yaml'), '{}\n');
  await mkdir(namedHome, { recursive: true });
  await writeFile(join(namedHome, 'profile.yaml'), 'display_name: Specialist\n');
  await writeFile(join(namedHome, 'config.yaml'), '{}\n');
  await writeSkill(join(hermesHome, 'skills'), 'default-only', 'Default only');
  await writeSkill(join(namedHome, 'skills'), 'named-only', 'Named only');

  const registry = new LocalProfileRegistry(hermesHome);
  const defaultTarget = requestProfile({ query: {} } as Request, registry);
  const namedTarget = requestProfile({ query: { profile: 'specialist' } } as unknown as Request, registry);

  assert.equal(defaultTarget.id, 'default');
  assert.equal(defaultTarget.skillsDir, join(hermesHome, 'skills'));
  assert.equal(namedTarget.id, 'specialist');
  assert.equal(namedTarget.skillsDir, join(namedHome, 'skills'));

  assert.deepEqual((await listInstalledSkills(defaultTarget.skillsDir)).map((skill) => skill.id), ['default-only']);
  assert.deepEqual((await listInstalledSkills(namedTarget.skillsDir)).map((skill) => skill.id), ['named-only']);

  await deleteInstalledSkill('named-only', namedTarget.skillsDir);
  assert.deepEqual(await listInstalledSkills(namedTarget.skillsDir), []);
  assert.deepEqual((await listInstalledSkills(defaultTarget.skillsDir)).map((skill) => skill.id), ['default-only']);

  assert.throws(
    () => requestProfile({ query: { profile: 'missing' } } as unknown as Request, registry),
    (error) => error instanceof LocalProfileError && error.code === 'UNKNOWN_PROFILE',
  );
} finally {
  await rm(hermesHome, { recursive: true, force: true });
}

console.log('Profile-scoped skills tests passed');
