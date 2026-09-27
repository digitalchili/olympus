import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { UpdateStatus } from '../shared/types.js';
import { createUpdatesRouter, isVersionNewer, parseGitHubRepositoryUrl } from '../server/routes/updates.js';

assert.equal(isVersionNewer('1.2.11', '1.2.10'), true);
assert.equal(isVersionNewer('1.3.0', '1.2.99'), true);
assert.equal(isVersionNewer('1.2.10', '1.3.0'), false);
assert.equal(isVersionNewer('1.2.10', '1.2.10'), false);
assert.equal(isVersionNewer('invalid', '1.2.10'), false);
assert.equal(parseGitHubRepositoryUrl('https://github.com/example/project.git'), 'example/project');
assert.equal(parseGitHubRepositoryUrl('git@github.com:example/project.git'), 'example/project');

const previousUpdateUrl = process.env.OLYMPUS_DISPATCH_UPDATE_URL;
const previousUpdateSocket = process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET;
const originalFetch = globalThis.fetch;
delete process.env.OLYMPUS_DISPATCH_UPDATE_URL;
delete process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET;
globalThis.fetch = async () => {
  throw new Error('No network request should run without a configured update hook.');
};

const app = express();
app.use('/api/updates', createUpdatesRouter());
const server = app.listen(0);

try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const callRoute = (path: string, method = 'GET') => new Promise<{
    status: number;
    body: Partial<UpdateStatus>;
  }>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: address.port,
      path,
      method,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: string },
      }));
    });
    req.on('error', reject);
    req.end();
  });

  const response = await callRoute('/api/updates/apply', 'POST');

  assert.equal(response.status, 503);
  assert.match(response.body.error ?? '', /installation-local update hook.*available/i);

  const publishedRelease = {
    tag_name: 'v99.0.0',
    html_url: 'https://github.com/digitalchili/olympus/releases/tag/v99.0.0',
    draft: false,
    prerelease: false,
    published_at: '2026-01-01T00:00:00Z',
  };
  const mockRelease = (body: unknown, status = 200) => {
    const calls: string[] = [];
    globalThis.fetch = async input => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/releases/latest')) return Response.json(body, { status });
      if (url.includes('/tags?')) return Response.json([{ name: 'v100.0.0' }]);
      if (url === 'http://127.0.0.1:9876/update') return Response.json({ accepted: true }, { status: 202 });
      throw new Error(`Unexpected fixture request: ${url}`);
    };
    return calls;
  };
  process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET = `/tmp/missing-olympus-update-${process.pid}.sock`;
  mockRelease(publishedRelease);
  const unavailableStatus = await callRoute('/api/updates?refresh=true');
  assert.equal(unavailableStatus.status, 200);
  assert.equal(unavailableStatus.body.updateAvailable, true);
  assert.equal(unavailableStatus.body.updateConfigured, false);
  assert.equal(unavailableStatus.body.latestVersion, '99.0.0');

  // A pushed tag may exist while the release/image workflow is still running.
  const missingCalls = mockRelease({ message: 'Not Found' }, 404);
  const missingRelease = await callRoute('/api/updates?refresh=true');
  assert.equal(missingRelease.body.updateAvailable, false, 'bare tags cannot advertise an unfinished release');
  assert.equal(missingRelease.body.latestVersion, null);
  assert.equal(missingRelease.body.releaseUrl, null);
  assert.match(missingRelease.body.error ?? '', /No GitHub release.*published/i);
  assert.equal(missingCalls.length, 1, 'release discovery must not fall back to tags');

  const olderReleaseUrl = 'https://github.com/digitalchili/olympus/releases/tag/v0.0.1';
  const oldCalls = mockRelease({ ...publishedRelease, tag_name: 'v0.0.1', html_url: olderReleaseUrl });
  const olderRelease = await callRoute('/api/updates?refresh=true');
  assert.equal(olderRelease.body.updateAvailable, false, 'new tags cannot supersede the published stable release');
  assert.equal(olderRelease.body.currentVersion, unavailableStatus.body.currentVersion);
  assert.equal(olderRelease.body.latestVersion, '0.0.1', 'latest version and release notes refer to the same published release');
  assert.equal(olderRelease.body.releaseUrl, olderReleaseUrl);
  assert.equal(olderRelease.body.error, undefined);
  assert.equal(oldCalls.length, 1);

  for (const invalid of [
    { ...publishedRelease, draft: true },
    { ...publishedRelease, prerelease: true },
    { ...publishedRelease, tag_name: 'v99.0.0-rc.1' },
    { ...publishedRelease, tag_name: 'v099.0.0' },
    { ...publishedRelease, tag_name: 'v99999999999999999999.0.0' },
    { ...publishedRelease, tag_name: 'nightly' },
    { ...publishedRelease, tag_name: 'v99.0' },
    { ...publishedRelease, published_at: null },
    { ...publishedRelease, published_at: 'not-a-date' },
    { tag_name: 'v99.0.0' },
    null,
  ]) {
    mockRelease(invalid);
    const ignored = await callRoute('/api/updates?refresh=true');
    assert.equal(ignored.body.updateAvailable, false, 'only a valid published stable release is installable');
    assert.equal(ignored.body.latestVersion, null);
    assert.equal(ignored.body.releaseUrl, null);
    assert.ok(ignored.body.error);
  }

  mockRelease({ message: 'SECRET upstream detail' }, 503);
  const failedRelease = await callRoute('/api/updates?refresh=true');
  assert.equal(failedRelease.body.updateAvailable, false);
  assert.equal(failedRelease.body.latestVersion, null);
  assert.match(failedRelease.body.error ?? '', /release check failed \(503\)/);
  assert.doesNotMatch(JSON.stringify(failedRelease.body), /SECRET/);

  delete process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET;
  process.env.OLYMPUS_DISPATCH_UPDATE_URL = 'http://127.0.0.1:9876/update';
  const applyCalls = mockRelease({ message: 'Not Found' }, 404);
  const unreadyApply = await callRoute('/api/updates/apply', 'POST');
  assert.equal(unreadyApply.status, 409);
  assert.ok(applyCalls.every(url => url.endsWith('/releases/latest')), 'no update hook invocation for a bare tag');
  delete process.env.OLYMPUS_DISPATCH_UPDATE_URL;

  const cachedCalls = mockRelease(publishedRelease);
  const refreshed = await callRoute('/api/updates?refresh=true');
  const cached = await callRoute('/api/updates');
  assert.equal(cached.body.latestVersion, '99.0.0');
  assert.equal(cached.body.checkedAt, refreshed.body.checkedAt);
  assert.equal(cachedCalls.length, 1, 'normal status reads reuse the release cache');

  // Relative Unix-socket addresses also work in deeply nested worktrees.
  const socketDirectory = await mkdtemp('.tmp-olympus-portable-update-status-');
  const socketPath = join(socketDirectory, 'update.sock');
  const socketServer = createServer();
  await new Promise<void>((resolve, reject) => {
    socketServer.once('error', reject);
    socketServer.listen(socketPath, resolve);
  });
  try {
    process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET = join(process.cwd(), socketPath);
    const availableStatus = await callRoute('/api/updates?refresh=true');
    assert.equal(availableStatus.body.updateConfigured, true);

    await chmod(socketPath, 0o000);
    const unreadableStatus = await callRoute('/api/updates');
    assert.equal(unreadableStatus.body.updateConfigured, false);
  } finally {
    socketServer.close();
    await rm(socketDirectory, { recursive: true, force: true });
  }

  const service = await readFile('deploy/systemd/olympus-dispatch-updater.service', 'utf8');
  const updaterEnv = await readFile('deploy/systemd/olympus-dispatch-updater.env.example', 'utf8');
  const updaterScript = await readFile('scripts/standalone/docker_compose_update.sh', 'utf8');
  const standaloneDocs = await readFile('docs/standalone-self-update.md', 'utf8');
  assert.match(service, /^StateDirectory=olympus-dispatch-updater$/m);
  assert.match(service, /^ExecStartPre=\/usr\/bin\/install -d -m 0755 \/var\/lib\/olympus-dispatch-updater\/socket$/m);
  assert.doesNotMatch(service, /^RuntimeDirectory=/m);
  assert.match(updaterEnv, /^OLYMPUS_UPDATER_SOCKET=\/var\/lib\/olympus-dispatch-updater\/socket\/update\.sock$/m);
  assert.match(updaterScript, /LOCK_DIR=\$\{OLYMPUS_UPDATER_LOCK_DIR:-\/var\/lib\/olympus-dispatch-updater\/operation\.lock\}/);
  assert.match(standaloneDocs, /- \/var\/lib\/olympus-dispatch-updater\/socket:\/run\/olympus-dispatch-updater/);
  assert.doesNotMatch(standaloneDocs, /- \/run\/olympus-dispatch-updater:\/run\/olympus-dispatch-updater/);
} finally {
  server.close();
  globalThis.fetch = originalFetch;
  if (previousUpdateUrl === undefined) delete process.env.OLYMPUS_DISPATCH_UPDATE_URL;
  else process.env.OLYMPUS_DISPATCH_UPDATE_URL = previousUpdateUrl;
  if (previousUpdateSocket === undefined) delete process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET;
  else process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET = previousUpdateSocket;
}

console.log('Update helper and route tests passed');
