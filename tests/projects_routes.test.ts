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
const { default: db } = await import('../server/db/index.js');
const { getProfileProjectRole, grantProjectProfileAccess } = await import('../server/db/projects.js');
const { ProjectAccessError, requireProfileProjectAccess } = await import('../server/project-access.js');
const registry = new LocalProfileRegistry(hermesHome, dispatchHome);

let now = 1_000;
const app = express();
app.use(express.json());
app.use('/api/projects', createProjectsRouter({ registry, now: () => now, changedBy: 'local-user' }));
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
  });
  assert.equal(createdResponse.status, 201);
  const created = createdResponse.body.project as Record<string, unknown>;
  assert.equal(created.name, 'Example Project');
  assert.deepEqual(created.manager, {
    id: 'studio',
    displayName: 'Somboon Studio',
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
  });
  const projectId = String(created.id);

  const globalOperatorIndex = await call('/api/projects');
  assert.equal(globalOperatorIndex.status, 200);
  assert.equal((globalOperatorIndex.body.projects as unknown[]).length, 1);

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

  assert.equal(getProfileProjectRole(projectId, 'studio'), 'manage');
  assert.equal(getProfileProjectRole(projectId, 'claude-manager'), null);
  assert.throws(
    () => requireProfileProjectAccess(projectId, 'claude-manager', 'view'),
    (error) => error instanceof ProjectAccessError && error.status === 404,
  );

  grantProjectProfileAccess({
    projectId,
    profileId: 'claude-manager',
    role: 'view',
    grantedBy: 'local-user',
  }, 1_500);
  assert.equal((await call('/api/projects?profile=claude-manager')).body.projects instanceof Array, true);
  assert.equal((await call(`/api/projects/${projectId}?profile=claude-manager`)).status, 200);
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

  const duplicate = await call('/api/projects', 'POST', {
    name: ' example project ',
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
