import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-studio-manifest-'));
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = join(root, 'data', 'studio.db');

const { default: db } = await import('../server/db/index.js');
const { createGitHubCredentialStore } = await import('../server/studio/github-credentials.js');
const { createGitHubAppGateway } = await import('../server/studio/github-app.js');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const requests: Array<{ url: string; method: string; authorization: string | null }> = [];

try {
  const credentialStore = createGitHubCredentialStore({
    keyPath: join(root, 'data', 'studio-github-app.key'),
  });
  const gateway = createGitHubAppGateway({
    env: {},
    credentialStore,
    fetchImpl: async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
      });
      if (url === 'https://api.github.com/app-manifests/temporary-code/conversions') {
        return Response.json({
          id: 12345,
          slug: 'olympus-studio-example-org',
          pem,
          client_id: 'Iv1.client-id',
          client_secret: 'generated-client-secret',
        }, { status: 201 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(gateway.configured, false);
  const registration = gateway.manifestRegistration('opaque-state', 'https://olympus.example', 'example-org');
  assert.equal(registration.url, 'https://github.com/organizations/example-org/settings/apps/new');
  assert.equal(registration.method, 'POST');
  assert.equal(registration.fields.state, 'opaque-state');

  const manifest = JSON.parse(registration.fields.manifest) as Record<string, unknown>;
  const instanceSuffix = createHash('sha256').update('https://olympus.example').digest('hex').slice(0, 8);
  assert.equal(manifest.name, `Olympus Studio ${instanceSuffix}`);
  assert.equal(manifest.url, 'https://olympus.example');
  assert.equal(manifest.redirect_url, 'https://olympus.example/api/studio/github/manifest/callback');
  assert.deepEqual(manifest.callback_urls, ['https://olympus.example/api/studio/github/oauth/callback']);
  assert.equal(manifest.setup_url, 'https://olympus.example/api/studio/github/callback');
  assert.equal(manifest.public, false);
  assert.deepEqual(manifest.default_permissions, { metadata: 'read' });
  assert.deepEqual(manifest.default_events, []);
  assert.equal(manifest.request_oauth_on_install, false);
  assert.equal(JSON.stringify(manifest).includes('secret'), false);

  const personalRegistration = gateway.manifestRegistration('personal-state', 'https://olympus.example', null);
  assert.equal(personalRegistration.url, 'https://github.com/settings/apps/new');
  assert.equal(
    (JSON.parse(personalRegistration.fields.manifest) as Record<string, unknown>).name,
    manifest.name,
    'retries for one installation must keep the same App name',
  );
  const otherInstance = gateway.manifestRegistration('other-state', 'https://other-olympus.example', null);
  assert.notEqual(
    (JSON.parse(otherInstance.fields.manifest) as Record<string, unknown>).name,
    manifest.name,
    'independent Olympus installations must not compete for one global GitHub App name',
  );
  assert.throws(
    () => gateway.manifestRegistration('invalid-state', 'https://olympus.example', 'not/a/github-org'),
    /owner is invalid/i,
  );

  await gateway.completeManifest('temporary-code');
  assert.equal(gateway.configured, true);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    url: 'https://api.github.com/app-manifests/temporary-code/conversions',
    method: 'POST',
    authorization: null,
  });
  assert.equal(
    gateway.installationUrl('install-state'),
    'https://github.com/apps/olympus-studio-example-org/installations/new?state=install-state',
  );
  assert.equal(credentialStore.load()?.clientSecret, 'generated-client-secret');

  await assert.rejects(() => gateway.completeManifest('second-code'), /already configured/i);
  assert.equal(requests.length, 1, 'an existing configuration must be rejected before consuming another GitHub code');
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}

console.log('Studio GitHub App manifest gateway tests passed');
