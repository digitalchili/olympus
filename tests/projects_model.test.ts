import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-projects-model-'));
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = join(root, 'data', 'projects.db');

try {
  const {
    countProjectsManagedByProfile,
    createProject,
    getProject,
    getProfileProjectRole,
    grantProjectProfileAccess,
    listProjectProfileGrants,
    listProjectManagerHistory,
    listProjects,
    reassignProject,
    revokeProjectProfileAccess,
    updateProject,
  } = await import('../server/db/projects.js');
  const { default: db } = await import('../server/db/index.js');

  const created = createProject({
    name: '  Example Project  ',
    purpose: '  Development and operation of Example Project  ',
    managerProfileId: 'somboon-studio',
    changedBy: 'local-user',
  }, 1_000);

  assert.equal(created.name, 'Example Project');
  assert.equal(created.purpose, 'Development and operation of Example Project');
  assert.equal(created.managerProfileId, 'somboon-studio');
  assert.equal(created.createdAt, 1_000);
  assert.deepEqual(listProjects(), [created]);
  assert.deepEqual(getProject(created.id), created);
  assert.equal(getProfileProjectRole(created.id, 'somboon-studio'), 'manage');
  assert.equal(getProfileProjectRole(created.id, 'somchai'), null);
  assert.equal(countProjectsManagedByProfile('somboon-studio'), 1);

  const updated = updateProject(created.id, {
    name: '  Updated Project  ',
    purpose: '  Updated purpose  ',
  }, 1_050);
  assert.equal(updated.name, 'Updated Project');
  assert.equal(updated.purpose, 'Updated purpose');
  assert.equal(updated.updatedAt, 1_050);

  createProject({
    name: 'Second Project',
    purpose: 'Used to verify normalized update collisions',
    managerProfileId: 'default',
    changedBy: 'local-user',
  }, 1_060);
  assert.throws(
    () => updateProject(created.id, { name: ' second project ' }, 1_070),
    /already exists/i,
  );

  const initialHistory = listProjectManagerHistory(created.id);
  assert.equal(initialHistory.length, 1);
  assert.equal(initialHistory[0].profileId, 'somboon-studio');
  assert.equal(initialHistory[0].effectiveFrom, 1_000);
  assert.equal(initialHistory[0].effectiveTo, null);
  assert.equal(initialHistory[0].changedBy, 'local-user');

  grantProjectProfileAccess({
    projectId: created.id,
    profileId: 'somchai',
    role: 'view',
    grantedBy: 'local-user',
  }, 1_100);
  assert.equal(getProfileProjectRole(created.id, 'somchai'), 'view');
  assert.deepEqual(listProjectProfileGrants(created.id).map((grant) => ({
    profileId: grant.profileId,
    role: grant.role,
    grantedBy: grant.grantedBy,
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
  })), [{
    profileId: 'somchai', role: 'view', grantedBy: 'local-user', createdAt: 1_100, updatedAt: 1_100,
  }]);
  revokeProjectProfileAccess(created.id, 'somchai');
  assert.deepEqual(listProjectProfileGrants(created.id), []);
  grantProjectProfileAccess({
    projectId: created.id,
    profileId: 'somchai',
    role: 'view',
    grantedBy: 'local-user',
  }, 1_200);

  const reassigned = reassignProject({
    projectId: created.id,
    managerProfileId: 'claude-manager',
    changedBy: 'local-user',
  }, 2_000);
  assert.equal(reassigned.managerProfileId, 'claude-manager');
  assert.equal(countProjectsManagedByProfile('somboon-studio'), 0);
  assert.equal(countProjectsManagedByProfile('claude-manager'), 1);
  assert.equal(reassigned.updatedAt, 2_000);
  assert.equal(getProfileProjectRole(created.id, 'claude-manager'), 'manage');
  assert.equal(getProfileProjectRole(created.id, 'somboon-studio'), null);
  assert.equal(getProfileProjectRole(created.id, 'somchai'), 'view');

  const history = listProjectManagerHistory(created.id);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((entry) => ({
    profileId: entry.profileId,
    effectiveFrom: entry.effectiveFrom,
    effectiveTo: entry.effectiveTo,
  })), [
    { profileId: 'somboon-studio', effectiveFrom: 1_000, effectiveTo: 2_000 },
    { profileId: 'claude-manager', effectiveFrom: 2_000, effectiveTo: null },
  ]);

  assert.throws(
    () => createProject({
      name: 'updated project',
      purpose: 'Duplicate normalized name',
      managerProfileId: 'default',
      changedBy: 'local-user',
    }, 3_000),
    /already exists/i,
  );
  assert.throws(
    () => grantProjectProfileAccess({
      projectId: created.id,
      profileId: 'writer',
      role: 'owner' as 'view',
      grantedBy: 'local-user',
    }, 3_000),
    /invalid project access role/i,
  );

  const openHistory = db.prepare(`
    SELECT COUNT(*) AS count
    FROM project_manager_history
    WHERE project_id = ? AND effective_to IS NULL
  `).get(created.id) as { count: number };
  assert.equal(openHistory.count, 1);
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Global Projects model and manager history tests passed');
