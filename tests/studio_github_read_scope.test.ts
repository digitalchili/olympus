import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createGitHubAppGateway } from '../server/studio/github-app.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const requests: any[] = [];
const env = {
  OLYMPUS_STUDIO_GITHUB_APP_ID: '123', OLYMPUS_STUDIO_GITHUB_APP_SLUG: 'test',
  OLYMPUS_STUDIO_GITHUB_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  OLYMPUS_STUDIO_GITHUB_CLIENT_ID: 'test', OLYMPUS_STUDIO_GITHUB_CLIENT_SECRET: 'test',
};
const gateway = createGitHubAppGateway({ env, fetchImpl: async (url, init) => {
  if (String(url).includes('/access_tokens')) {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ token: 'test-token' });
  }
  assert.match(String(url), /\/installation\/repositories/);
  return Response.json({ repositories: [] });
} });
await gateway.installationToken!(22, { readOnly: true, repositoryId: 456 });
assert.deepEqual(requests[0], { url: 'https://api.github.com/app/installations/22/access_tokens', body: { permissions: { metadata: 'read', contents: 'read' }, repository_ids: [456] } });
await gateway.listRepositories(22, { readOnly: true });
assert.deepEqual(requests[1].body, { permissions: { metadata: 'read', contents: 'read' } });
await gateway.installationToken!(11);
assert.deepEqual(requests[2].body, { permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' } }, 'primary publish behavior remains unchanged');
for (const stage of ['token-fetch', 'token-body', 'catalog-fetch', 'catalog-body']) {
  const controller = new AbortController();
  let observedSignal: AbortSignal | null | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const abortingGateway = createGitHubAppGateway({ env, fetchImpl: async (url, init) => {
    const target = String(url).includes('/access_tokens') ? 'token' : 'catalog';
    if (!stage.startsWith(target)) return Response.json({ token: 'test-token' });
    observedSignal = init?.signal;
    assert.ok(observedSignal, 'each GitHub fetch keeps a timeout signal');
    const signal = observedSignal;
    if (stage.endsWith('fetch')) {
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        markStarted();
      });
    }
    return new Response(new ReadableStream({ start(stream) {
      signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
      markStarted();
    } }));
  } });
  const pending = stage.startsWith('token')
    ? abortingGateway.installationToken!(22, { readOnly: true, repositoryId: 456, signal: controller.signal })
    : abortingGateway.listRepositories(22, { readOnly: true, signal: controller.signal });
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  await started;
  controller.abort();
  assert.equal(observedSignal?.aborted, true, `${stage} must receive caller cancellation`);
  await rejected;
}
console.log('GitHub read-only installation scope and fetch/body cancellation passed');
