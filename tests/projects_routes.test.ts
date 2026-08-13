import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const root = await mkdtemp(join(tmpdir(), 'olympus-project-routes-'));
const hermesHome = join(root, 'hermes');
const dispatchHome = join(root, 'dispatch');
process.env.HERMES_HOME = hermesHome;
process.env.OLYMPUS_DISPATCH_HOME = dispatchHome;
process.env.DB_PATH = join(dispatchHome, 'data', 'projects.db');

async function profile(id: string, displayName: string, active: boolean, provider: string, model: string) {
  const home = id === 'default' ? hermesHome : join(hermesHome, 'profiles', id);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'profile.yaml'), `displayName: ${displayName}\nactive: ${active}\n`);
  await writeFile(join(home, 'config.yaml'), `model:\n  provider: ${provider}\n  default: ${model}\n`);
}

await profile('default', 'Somboon', true, 'openai-codex', 'gpt-5.6-sol');
await profile('studio', 'Somboon Studio', true, 'openai-codex', 'gpt-5.6-sol');
await profile('claude-manager', 'Claude Development Manager', true, 'anthropic', 'claude-opus');
await profile('inactive', 'Inactive Manager', false, 'openai', 'gpt-5');

const { LocalProfileRegistry } = await import('../server/local-profiles.js');
const { createProjectsRouter } = await import('../server/routes/projects.js');
const { upsertGitHubInstallation } = await import('../server/db/studio-projects.js');
const { default: db } = await import('../server/db/index.js');
const { getProfileProjectRole } = await import('../server/db/projects.js');
const { ProjectAccessError, requireProfileProjectAccess } = await import('../server/project-access.js');
const registry = new LocalProfileRegistry(hermesHome, dispatchHome);

let now = 1_000;
const repositories = [{ id: 501, name: 'atlas', fullName: 'example/atlas', owner: 'example', private: true, defaultBranch: 'main', htmlUrl: 'https://github.com/example/atlas', cloneUrl: 'https://github.com/example/atlas.git' }];
upsertGitHubInstallation({
  id: 44,
  accountLogin: 'example',
  accountType: 'Organization',
  permissionMode: 'read_write',
}, now);
const github = {
  configured: true,
  manifestRegistration() { throw new Error('not used'); },
  async completeManifest() { throw new Error('not used'); },
  installationUrl() { throw new Error('not used'); },
  authorizationUrl() { throw new Error('not used'); },
  async authorizeInstallation() { throw new Error('not used'); },
  async listRepositories(installationId: number) {
    assert.equal(installationId, 44);
    return repositories;
  },
};
const app = express();
app.use(express.json());
app.use('/api/projects', createProjectsRouter({ registry, now: () => now, changedBy: 'local-user', github }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');

type Result = { status: number; body: Record<string, unknown> };

try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const call = (path: string, method = 'GET', body?: unknown) => new Promise<Result>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : undefined,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });

  const invalid = await call('/api/projects', 'POST', { name: '', purpose: '', managerProfileId: 'missing' });
  assert.equal(invalid.status, 400);

  const inactive = await call('/api/projects', 'POST', {
    name: 'Inactive project',
    purpose: 'Must not be assigned to an inactive manager',
    managerProfileId: 'inactive',
  });
  assert.equal(inactive.status, 409);
  assert.equal(inactive.body.code, 'INACTIVE_PROFILE');

  const createdResponse = await call('/api/projects', 'POST', {
    name: 'Example Project',
    purpose: 'Development and operation of Example Project',
    managerProfileId: 'studio',
    repositoryLink: { installationId: 44, repositoryId: 501 },
  });
  assert.equal(createdResponse.status, 201);
  const created = createdResponse.body.project as Record<string, unknown>;
  assert.equal(created.name, 'Example Project');
  assert.equal((created.repositoryLink as Record<string, unknown>).fullName, 'example/atlas');
  assert.equal((created.repositoryLink as Record<string, unknown>).mode, 'branch_pr');
  assert.equal(JSON.stringify(created).includes('token'), false);
  assert.deepEqual(created.manager, {
    id: 'studio',
    displayName: 'Somboon Studio',
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
  });
  const projectId = String(created.id);

  const repositoryDetail = await call(`/api/projects/${projectId}/repository`);
  assert.equal(repositoryDetail.status, 200);
  assert.equal(((repositoryDetail.body.repositoryLink as Record<string, unknown>)).providerRepositoryId, 501);

  const unavailableRepository = await call(`/api/projects/${projectId}/repository`, 'PUT', { installationId: 44, repositoryId: 999 });
  assert.equal(unavailableRepository.status, 404);

  const removedRepository = await call(`/api/projects/${projectId}/repository`, 'DELETE');
  assert.equal(removedRepository.status, 204);
  assert.equal((await call(`/api/projects/${projectId}/repository`)).body.repositoryLink, null);

  const relinkedRepository = await call(`/api/projects/${projectId}/repository`, 'PUT', { installationId: 44, repositoryId: 501 });
  assert.equal(relinkedRepository.status, 200);
  assert.equal(((relinkedRepository.body.repositoryLink as Record<string, unknown>)).mode, 'branch_pr');

  const duplicateRepositoryCreate = await call('/api/projects', 'POST', {
    name: 'Must roll back',
    purpose: 'Duplicate repository must not leave a Project behind',
    managerProfileId: 'studio',
    repositoryLink: { installationId: 44, repositoryId: 501 },
  });
  assert.equal(duplicateRepositoryCreate.status, 409);
  assert.equal((await call('/api/projects')).body.projects instanceof Array, true);
  assert.equal((await call('/api/projects')).body.projects instanceof Array
    ? ((await call('/api/projects')).body.projects as unknown[]).length
    : -1, 1, 'failed linked creation rolls back the Project row');

  const unlinkedResponse = await call('/api/projects', 'POST', {
    name: 'Atomic update target',
    purpose: 'Verify metadata and repository changes share one transaction',
    managerProfileId: 'studio',
  });
  assert.equal(unlinkedResponse.status, 201);
  const unlinkedId = String((unlinkedResponse.body.project as Record<string, unknown>).id);
  const duplicateRepositoryPatch = await call(`/api/projects/${unlinkedId}`, 'PATCH', {
    name: 'Must not persist',
    repositoryLink: { installationId: 44, repositoryId: 501 },
  });
  assert.equal(duplicateRepositoryPatch.status, 409);
  assert.equal(((await call(`/api/projects/${unlinkedId}`)).body.project as Record<string, unknown>).name, 'Atomic update target');

  const globalOperatorIndex = await call('/api/projects');
  assert.equal(globalOperatorIndex.status, 200);
  assert.equal((globalOperatorIndex.body.projects as unknown[]).length, 2);

  const globalFromUnrelatedProfile = await call('/api/projects?profile=claude-manager');
  assert.equal(globalFromUnrelatedProfile.status, 200);
  assert.equal((globalFromUnrelatedProfile.body.projects as unknown[]).length, 0);
  assert.equal((await call(`/api/projects/${projectId}?profile=claude-manager`)).status, 404);
  assert.equal((await call(`/api/projects/${projectId}?profile=studio`)).status, 200);

  const profileCreate = await call('/api/projects?profile=studio', 'POST', {
    name: 'Profile-created Project',
    purpose: 'Must remain an operator action',
    managerProfileId: 'studio',
  });
  assert.equal(profileCreate.status, 403);
  assert.equal(profileCreate.body.code, 'PROJECT_OPERATOR_ONLY');

  const unrelatedPatch = await call(`/api/projects/${projectId}?profile=claude-manager`, 'PATCH', {
    purpose: 'Must not be accepted without manage access',
  });
  assert.equal(unrelatedPatch.status, 404);

  now = 1_250;
  const managerPatch = await call(`/api/projects/${projectId}?profile=studio`, 'PATCH', {
    name: 'Renamed Example Project',
    purpose: 'Updated by the current Project manager',
  });
  assert.equal(managerPatch.status, 200);
  assert.equal((managerPatch.body.project as Record<string, unknown>).name, 'Renamed Example Project');
  assert.equal((managerPatch.body.project as Record<string, unknown>).purpose, 'Updated by the current Project manager');

  assert.equal(getProfileProjectRole(projectId, 'studio'), 'manage');
  assert.equal(getProfileProjectRole(projectId, 'claude-manager'), null);
  assert.throws(
    () => requireProfileProjectAccess(projectId, 'claude-manager', 'view'),
    (error) => error instanceof ProjectAccessError && error.status === 404,
  );

  now = 1_500;
  const granted = await call(`/api/projects/${projectId}/grants/claude-manager`, 'PUT', { role: 'view' });
  assert.equal(granted.status, 200);
  assert.equal((granted.body.grant as Record<string, unknown>).profileId, 'claude-manager');
  assert.equal((granted.body.grant as Record<string, unknown>).role, 'view');
  const grants = await call(`/api/projects/${projectId}/grants`);
  assert.equal(grants.status, 200);
  assert.deepEqual((grants.body.grants as Array<Record<string, unknown>>).map((grant) => ({
    profileId: grant.profileId,
    role: grant.role,
  })), [{ profileId: 'claude-manager', role: 'view' }]);
  assert.equal((await call('/api/projects?profile=claude-manager')).body.projects instanceof Array, true);
  assert.equal((await call(`/api/projects/${projectId}?profile=claude-manager`)).status, 200);
  const forbiddenGrant = await call(`/api/projects/${projectId}/grants/default?profile=claude-manager`, 'PUT', { role: 'manage' });
  assert.equal(forbiddenGrant.status, 404);
  const forbiddenProfileReassign = await call(`/api/projects/${projectId}/reassign?profile=claude-manager`, 'POST', {
    managerProfileId: 'claude-manager',
  });
  assert.equal(forbiddenProfileReassign.status, 404);

  now = 2_000;
  const reassignedResponse = await call(`/api/projects/${projectId}/reassign`, 'POST', {
    managerProfileId: 'claude-manager',
    previousManagerRole: 'view',
  });
  assert.equal(reassignedResponse.status, 200);
  const reassigned = reassignedResponse.body.project as Record<string, unknown>;
  assert.deepEqual(reassigned.manager, {
    id: 'claude-manager',
    displayName: 'Claude Development Manager',
    provider: 'anthropic',
    model: 'claude-opus',
  });
  assert.equal(getProfileProjectRole(projectId, 'claude-manager'), 'manage');
  assert.equal(getProfileProjectRole(projectId, 'studio'), 'view');
  assert.doesNotThrow(() => requireProfileProjectAccess(projectId, 'studio', 'view'));
  assert.throws(
    () => requireProfileProjectAccess(projectId, 'studio', 'contribute'),
    (error) => error instanceof ProjectAccessError && error.status === 404,
  );

  const details = await call(`/api/projects/${projectId}`);
  assert.equal(details.status, 200);
  const history = details.body.managerHistory as Array<Record<string, unknown>>;
  assert.equal(history.length, 2);
  assert.equal(history[0].effectiveTo, 2_000);
  assert.equal(history[1].effectiveTo, null);

  const revoked = await call(`/api/projects/${projectId}/grants/studio`, 'DELETE');
  assert.equal(revoked.status, 204);
  assert.equal(getProfileProjectRole(projectId, 'studio'), null);

  const duplicate = await call('/api/projects', 'POST', {
    name: ' renamed example project ',
    purpose: 'Duplicate',
    managerProfileId: 'default',
  });
  assert.equal(duplicate.status, 409);

  const missing = await call('/api/projects/missing');
  assert.equal(missing.status, 404);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  await rm(root, { recursive: true, force: true });
}

console.log('Global Projects API and access-control tests passed');
