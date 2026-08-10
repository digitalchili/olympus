import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const root = await mkdtemp(join(tmpdir(), 'olympus-studio-'));
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = join(root, 'data', 'studio.db');

const { createStudioRouter } = await import('../server/routes/studio.js');
const { default: db } = await import('../server/db/index.js');

type Repository = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
};

const repositories: Repository[] = [{
  id: 101,
  name: 'olympus-dispatch',
  fullName: 'leakim69/olympus-dispatch',
  owner: 'leakim69',
  private: true,
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/leakim69/olympus-dispatch',
  cloneUrl: 'https://github.com/leakim69/olympus-dispatch.git',
}];

const app = express();
app.use(express.json());
app.use('/api/studio', createStudioRouter({
  github: {
    configured: true,
    manifestRegistration() { throw new Error('must not run'); },
    async completeManifest() { throw new Error('must not run'); },
    installationUrl(state: string) {
      return `https://github.com/apps/somboon-studio/installations/new?state=${encodeURIComponent(state)}`;
    },
    authorizationUrl(state: string) {
      return `https://github.com/login/oauth/authorize?client_id=studio-client&state=${encodeURIComponent(state)}`;
    },
    async authorizeInstallation(code: string, installationId: number) {
      assert.equal(code, 'verified-user-code');
      assert.equal(installationId, 44);
      return { id: 44, accountLogin: 'leakim69', accountType: 'User' as const };
    },
    async listRepositories(installationId: number) {
      assert.equal(installationId, 44);
      return repositories;
    },
  },
  stateTtlMs: 60_000,
}));

const server = app.listen(0);

interface ResponseResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const call = (
    path: string,
    method = 'GET',
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) => new Promise<ResponseResult>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: {
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: raw.trim().startsWith('{') ? JSON.parse(raw) as Record<string, unknown> : {},
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });

  const initial = await call('/api/studio/github/status');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.configured, true);
  assert.deepEqual(initial.body.installations, []);

  const connect = await call('/api/studio/github/connect', 'POST');
  assert.equal(connect.status, 200);
  assert.equal(typeof connect.body.url, 'string');
  const installUrl = new URL(String(connect.body.url));
  const state = installUrl.searchParams.get('state');
  assert.ok(state);
  const installCookie = String(connect.headers['set-cookie']);
  assert.match(installCookie, /studio_github_install_state=/);
  assert.match(installCookie, /HttpOnly/i);
  assert.match(installCookie, /SameSite=Lax/i);

  const installMissingCookie = await call(
    `/api/studio/github/callback?installation_id=44&setup_action=install&state=${encodeURIComponent(state)}`,
  );
  assert.equal(installMissingCookie.status, 400);
  assert.match(String(installMissingCookie.body.error), /invalid or expired/i);

  const installMissingQueryState = await call(
    '/api/studio/github/callback?installation_id=44&setup_action=install',
    'GET',
    undefined,
    { Cookie: installCookie.split(';', 1)[0] },
  );
  assert.equal(installMissingQueryState.status, 400);
  assert.match(String(installMissingQueryState.body.error), /invalid or expired/i);

  const callback = await call(
    `/api/studio/github/callback?installation_id=44&setup_action=install&state=${encodeURIComponent(state)}`,
    'GET',
    undefined,
    { Cookie: installCookie.split(';', 1)[0] },
  );
  assert.equal(callback.status, 302);
  const authorizationUrl = new URL(String(callback.headers.location));
  assert.equal(authorizationUrl.origin, 'https://github.com');
  assert.equal(authorizationUrl.pathname, '/login/oauth/authorize');
  const oauthState = authorizationUrl.searchParams.get('state');
  assert.ok(oauthState);
  const callbackCookies = callback.headers['set-cookie'];
  assert.ok(Array.isArray(callbackCookies));
  const oauthCookie = callbackCookies.find((value) => value.startsWith('studio_github_oauth_state='));
  assert.ok(oauthCookie);
  assert.match(oauthCookie, /HttpOnly/i);
  assert.match(oauthCookie, /SameSite=Lax/i);

  const replay = await call(
    `/api/studio/github/callback?installation_id=44&setup_action=install&state=${encodeURIComponent(state)}`,
    'GET',
    undefined,
    { Cookie: installCookie.split(';', 1)[0] },
  );
  assert.equal(replay.status, 400);
  assert.match(String(replay.body.error), /invalid or expired/i);

  const malformedCookie = await call(
    '/api/studio/github/callback?installation_id=44',
    'GET',
    undefined,
    { Cookie: 'studio_github_install_state=%ZZ' },
  );
  assert.equal(malformedCookie.status, 400);

  const oauthMissingCookie = await call(`/api/studio/github/oauth/callback?code=verified-user-code&state=${encodeURIComponent(oauthState)}`);
  assert.equal(oauthMissingCookie.status, 400);
  assert.match(String(oauthMissingCookie.body.error), /invalid or expired/i);

  const oauthCallback = await call(
    `/api/studio/github/oauth/callback?code=verified-user-code&state=${encodeURIComponent(oauthState)}`,
    'GET',
    undefined,
    { Cookie: oauthCookie.split(';', 1)[0] },
  );
  assert.equal(oauthCallback.status, 302);
  assert.equal(oauthCallback.headers.location, '/studio?installationId=44');

  const automaticallyImported = await call('/api/studio/projects');
  assert.equal((automaticallyImported.body.projects as unknown[]).length, 1);
  assert.equal(
    ((automaticallyImported.body.projects as Array<Record<string, unknown>>)[0]).fullName,
    repositories[0].fullName,
  );

  const oauthReplay = await call(`/api/studio/github/oauth/callback?code=verified-user-code&state=${encodeURIComponent(oauthState)}`);
  assert.equal(oauthReplay.status, 400);
  assert.match(String(oauthReplay.body.error), /invalid or expired/i);

  const connected = await call('/api/studio/github/status');
  assert.deepEqual(connected.body.installations, [{
    id: 44,
    accountLogin: 'leakim69',
    accountType: 'User',
    createdAt: (connected.body.installations as Array<Record<string, unknown>>)[0].createdAt,
    updatedAt: (connected.body.installations as Array<Record<string, unknown>>)[0].updatedAt,
  }]);

  const available = await call('/api/studio/github/repositories?installationId=44');
  assert.equal(available.status, 200);
  assert.deepEqual(available.body.repositories, repositories);
  assert.equal(JSON.stringify(available.body).includes('token'), false);

  const missingRepository = await call('/api/studio/projects', 'POST', { installationId: 44, repositoryId: 999 });
  assert.equal(missingRepository.status, 404);

  const imported = await call('/api/studio/projects', 'POST', { installationId: 44, repositoryId: 101 });
  assert.equal(imported.status, 200);
  const project = imported.body.project as Record<string, unknown>;
  assert.equal(project.fullName, 'leakim69/olympus-dispatch');
  assert.equal(project.mode, 'read_only');
  assert.equal(project.defaultBranch, 'main');
  assert.equal('token' in project, false);

  const importedAgain = await call('/api/studio/projects', 'POST', { installationId: 44, repositoryId: 101 });
  assert.equal(importedAgain.status, 200);
  assert.equal((importedAgain.body.project as Record<string, unknown>).id, project.id);

  const projects = await call('/api/studio/projects');
  assert.equal(projects.status, 200);
  assert.equal((projects.body.projects as unknown[]).length, 1);

  const unknownInstallation = await call('/api/studio/github/repositories?installationId=45');
  assert.equal(unknownInstallation.status, 404);

  let generatedAppConfigured = false;
  const unconfiguredApp = express();
  unconfiguredApp.use(express.json());
  unconfiguredApp.use('/api/studio', createStudioRouter({
    github: {
      get configured() { return generatedAppConfigured; },
      manifestRegistration(state, publicUrl, owner) {
        assert.equal(publicUrl, 'https://olympus.example');
        assert.equal(owner, 'example-org');
        return {
          url: 'https://github.com/organizations/example-org/settings/apps/new',
          method: 'POST' as const,
          fields: { state, manifest: '{"metadata":"read"}' },
        };
      },
      async completeManifest(code) {
        assert.equal(code, 'temporary-manifest-code');
        generatedAppConfigured = true;
      },
      installationUrl(state) {
        assert.equal(generatedAppConfigured, true);
        return `https://github.com/apps/olympus-studio/installations/new?state=${encodeURIComponent(state)}`;
      },
      authorizationUrl() { throw new Error('must not run'); },
      async authorizeInstallation() { throw new Error('must not run'); },
      async listRepositories() { throw new Error('must not run'); },
    },
    publicUrl: 'https://olympus.example',
    stateTtlMs: 60_000,
  }));
  const unconfiguredServer = unconfiguredApp.listen(0);
  try {
    const unconfiguredAddress = unconfiguredServer.address();
    assert.ok(unconfiguredAddress && typeof unconfiguredAddress === 'object');
    const unconfigured = await new Promise<ResponseResult>((resolve, reject) => {
      const payload = JSON.stringify({ owner: 'example-org' });
      const req = request({
        host: '127.0.0.1',
        port: unconfiguredAddress.port,
        path: '/api/studio/github/connect',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        }));
      });
      req.on('error', reject);
      req.end(payload);
    });
    assert.equal(unconfigured.status, 200);
    assert.equal(unconfigured.body.method, 'POST');
    assert.equal(unconfigured.body.url, 'https://github.com/organizations/example-org/settings/apps/new');
    const fields = unconfigured.body.fields as Record<string, string>;
    assert.equal(fields.manifest, '{"metadata":"read"}');
    assert.ok(fields.state);
    const manifestCookie = String(unconfigured.headers['set-cookie']);
    assert.match(manifestCookie, /studio_github_manifest_state=/);
    assert.match(manifestCookie, /HttpOnly/i);

    const manifestMissingCookie = await new Promise<ResponseResult>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: unconfiguredAddress.port,
        path: `/api/studio/github/manifest/callback?code=temporary-manifest-code&state=${encodeURIComponent(fields.state)}`,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(manifestMissingCookie.status, 400);

    const manifestCallback = await new Promise<ResponseResult>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: unconfiguredAddress.port,
        path: `/api/studio/github/manifest/callback?code=temporary-manifest-code&state=${encodeURIComponent(fields.state)}`,
        headers: { Cookie: manifestCookie.split(';', 1)[0] },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: raw.trim().startsWith('{') ? JSON.parse(raw) as Record<string, unknown> : {},
          });
        });
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(manifestCallback.status, 302);
    const generatedInstallUrl = new URL(String(manifestCallback.headers.location));
    assert.equal(generatedInstallUrl.pathname, '/apps/olympus-studio/installations/new');
    assert.ok(generatedInstallUrl.searchParams.get('state'));
    assert.match(String(manifestCallback.headers['set-cookie']), /studio_github_install_state=/);
    assert.equal(generatedAppConfigured, true);
  } finally {
    unconfiguredServer.close();
  }
} finally {
  server.close();
  db.close();
  await rm(root, { recursive: true, force: true });
}

console.log('Studio GitHub onboarding tests passed');
