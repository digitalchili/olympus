import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyObject = publicKey;
const requests: Array<{ url: string; authorization: string; method: string; body: string }> = [];

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const authorization = String(new Headers(init?.headers).get('authorization') ?? '');
  requests.push({
    url,
    authorization,
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? init.body : '',
  });

  if (url === 'https://github.com/login/oauth/access_token') {
    return Response.json({ access_token: 'short-lived-user-token' });
  }
  if (url.endsWith('/user/installations?per_page=100&page=1')) {
    return Response.json({ total_count: 1, installations: [{ id: 44 }] });
  }
  if (url.endsWith('/app/installations/44')) {
    return Response.json({
      id: 44,
      account: { login: 'leakim69', type: 'User' },
      permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' },
    });
  }
  if (url.endsWith('/app/installations/44/access_tokens')) {
    return Response.json({ token: 'short-lived-installation-token' });
  }
  if (url.endsWith('/installation/repositories?per_page=100&page=1')) {
    return Response.json({
      total_count: 1,
      repositories: [{
        id: 101,
        name: 'olympus-dispatch',
        full_name: 'leakim69/olympus-dispatch',
        owner: { login: 'leakim69' },
        private: true,
        default_branch: 'main',
        html_url: 'https://github.com/leakim69/olympus-dispatch',
        clone_url: 'https://github.com/leakim69/olympus-dispatch.git',
      }],
    });
  }
  throw new Error(`Unexpected URL: ${url}`);
};

const { createGitHubAppGateway } = await import('../server/studio/github-app.js');
const nowMs = 1_786_323_600_000;
const gateway = createGitHubAppGateway({
  env: {
    OLYMPUS_STUDIO_GITHUB_APP_ID: '12345',
    OLYMPUS_STUDIO_GITHUB_APP_SLUG: 'somboon-studio',
    OLYMPUS_STUDIO_GITHUB_PRIVATE_KEY: privateKeyPem,
    OLYMPUS_STUDIO_GITHUB_CLIENT_ID: 'studio-client',
    OLYMPUS_STUDIO_GITHUB_CLIENT_SECRET: 'studio-client-secret',
  },
  fetchImpl: fakeFetch,
  now: () => nowMs,
});

assert.equal(gateway.configured, true);
assert.equal(
  gateway.installationUrl('opaque state'),
  'https://github.com/apps/somboon-studio/installations/new?state=opaque%20state',
);
assert.equal(
  gateway.authorizationUrl('oauth state'),
  'https://github.com/login/oauth/authorize?client_id=studio-client&state=oauth%20state',
);

const installation = await gateway.authorizeInstallation('oauth-code', 44);
assert.deepEqual(installation, {
  id: 44,
  accountLogin: 'leakim69',
  accountType: 'User',
  permissionMode: 'read_write',
});

assert.equal(requests[1].authorization, 'Bearer short-lived-user-token');
const appInstallationRequest = requests.find((entry) => entry.url.endsWith('/app/installations/44'));
assert.ok(appInstallationRequest);
const jwt = appInstallationRequest.authorization.replace(/^Bearer /, '');
const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
assert.ok(encodedHeader && encodedPayload && encodedSignature);
assert.deepEqual(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')), { alg: 'RS256', typ: 'JWT' });
assert.deepEqual(JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')), {
  iat: Math.floor(nowMs / 1000) - 60,
  exp: Math.floor(nowMs / 1000) + 9 * 60,
  iss: '12345',
});
assert.equal(verify(
  'RSA-SHA256',
  Buffer.from(`${encodedHeader}.${encodedPayload}`),
  publicKeyObject,
  Buffer.from(encodedSignature, 'base64url'),
), true);

const repositories = await gateway.listRepositories(44);
assert.deepEqual(repositories, [{
  id: 101,
  name: 'olympus-dispatch',
  fullName: 'leakim69/olympus-dispatch',
  owner: 'leakim69',
  private: true,
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/leakim69/olympus-dispatch',
  cloneUrl: 'https://github.com/leakim69/olympus-dispatch.git',
}]);
assert.equal(requests.at(-1)?.authorization, 'Bearer short-lived-installation-token');
const installationTokenRequest = requests.find((entry) => entry.url.endsWith('/app/installations/44/access_tokens'));
assert.ok(installationTokenRequest);
assert.deepEqual(JSON.parse(installationTokenRequest.body), {
  permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' },
});
assert.equal(repositories[0].defaultBranch, 'main');
assert.equal(repositories[0].cloneUrl, 'https://github.com/leakim69/olympus-dispatch.git');
assert.ok(!JSON.stringify(repositories).includes('short-lived-installation-token'));
assert.ok(!JSON.stringify(repositories).includes('short-lived-user-token'));

let appDetailsRequested = false;
const rejectingGateway = createGitHubAppGateway({
  env: {
    OLYMPUS_STUDIO_GITHUB_APP_ID: '12345',
    OLYMPUS_STUDIO_GITHUB_APP_SLUG: 'somboon-studio',
    OLYMPUS_STUDIO_GITHUB_PRIVATE_KEY: privateKeyPem,
    OLYMPUS_STUDIO_GITHUB_CLIENT_ID: 'studio-client',
    OLYMPUS_STUDIO_GITHUB_CLIENT_SECRET: 'studio-client-secret',
  },
  fetchImpl: async (input, init) => {
    const url = String(input);
    if (url === 'https://github.com/login/oauth/access_token') {
      return Response.json({ access_token: 'unrelated-user-token' });
    }
    if (url.includes('/user/installations')) {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer unrelated-user-token');
      return Response.json({ total_count: 0, installations: [] });
    }
    appDetailsRequested = true;
    return Response.json({ id: 999, account: { login: 'attacker', type: 'User' } });
  },
});
await assert.rejects(
  rejectingGateway.authorizeInstallation('unrelated-code', 999),
  /not associated with the authorized user/i,
);
assert.equal(appDetailsRequested, false, 'unowned installations must not be accepted or queried as linked projects');

const unconfigured = createGitHubAppGateway({ env: {} });

assert.throws(() => unconfigured.installationUrl('state'), /not configured/i);
await assert.rejects(() => unconfigured.listRepositories(44), /not configured/i);

console.log('Studio GitHub App JWT and API client tests passed');
