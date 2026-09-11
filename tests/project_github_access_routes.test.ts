import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const root = await mkdtemp(join(tmpdir(), 'olympus-github-access-routes-'));
process.env.DB_PATH = join(root, 'test.db'); process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state'); process.env.HERMES_HOME = join(root, 'hermes');
for (const profile of ['', 'profiles/viewer', 'profiles/outsider']) {
  await mkdir(join(process.env.HERMES_HOME, profile), { recursive: true });
  await writeFile(join(process.env.HERMES_HOME, profile, 'config.yaml'), '{}\n');
  if (profile) await writeFile(join(process.env.HERMES_HOME, profile, 'profile.yaml'), 'display_name: Test\n');
}
const { createProjectGitHubAccessRouter } = await import('../server/routes/project-github-access.js');
const { createProject, grantProjectProfileAccess } = await import('../server/db/projects.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { getProjectGitHubInstallationIds } = await import('../server/db/project-github-access.js');
const { default: db } = await import('../server/db/index.js');
const project = createProject({ name: 'Accounts', purpose: 'Source access', managerProfileId: 'default', changedBy: 'test' });
grantProjectProfileAccess({ projectId: project.id, profileId: 'viewer', role: 'view', grantedBy: 'test' });
for (const id of [11, 22]) upsertGitHubInstallation({ id, accountLogin: `account${id}`, accountType: 'User', permissionMode: 'read_write' });
let reject = false; const verified: number[] = [];
const app = express(); app.use(express.json());
app.use('/api/projects', createProjectGitHubAccessRouter({ configured: true, async listRepositories(id: number, options: any) {
  assert.equal(options.readOnly, true); verified.push(id);
  if (reject) throw new Error('secret-upstream-token must not escape');
  return [];
} } as any));
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address === 'object');
const call = async (profile: string, ids?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/${project.id}/github-access?profile=${profile}`, ids === undefined ? undefined : {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ installationIds: ids }),
  });
  const body = await response.json(); assert.equal(JSON.stringify(body).includes('secret-upstream'), false);
  return { status: response.status, body };
};
try {
  assert.deepEqual((await call('default')).body.installationIds, []);
  assert.equal((await call('outsider')).status, 404);
  assert.equal((await call('viewer', [22])).status, 404);
  assert.deepEqual(verified, []);
  assert.equal((await call('default', [22, 11])).status, 200);
  assert.deepEqual(getProjectGitHubInstallationIds(project.id), [11, 22]);
  assert.deepEqual((await call('viewer')).body.installationIds, [11, 22]);
  assert.deepEqual((await call('default')).body.installationIds, [11, 22], 'saved access reloads');
  assert.equal((await call('default', [999])).status, 400);
  assert.equal((await call('default', ['11'])).status, 400);
  reject = true;
  assert.equal((await call('default', [11])).status, 403);
  assert.deepEqual(getProjectGitHubInstallationIds(project.id), [11, 22], 'failed verification retains grants');
  assert.equal((await call('default', [])).status, 200, 'revocation needs no working upstream account');
  assert.deepEqual(getProjectGitHubInstallationIds(project.id), []);
} finally { server.close(); await once(server, 'close'); db.close(); await rm(root, { recursive: true, force: true }); }
console.log('Project GitHub access route authorization passed');
