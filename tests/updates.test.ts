import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
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
    body: { error?: string; updateAvailable?: boolean; updateConfigured?: boolean };
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

  process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET = `/tmp/missing-olympus-update-${process.pid}.sock`;
  globalThis.fetch = async () => new Response(JSON.stringify({
    tag_name: 'v99.0.0',
    html_url: 'https://github.com/digitalchili/olympus/releases/tag/v99.0.0',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const unavailableStatus = await callRoute('/api/updates?refresh=true');
  assert.equal(unavailableStatus.status, 200);
  assert.equal(unavailableStatus.body.updateAvailable, true);
  assert.equal(unavailableStatus.body.updateConfigured, false);

  const socketDirectory = await mkdtemp(join(tmpdir(), 'olympus-update-status-'));
  const socketPath = join(socketDirectory, 'update.sock');
  const socketServer = createServer();
  await new Promise<void>((resolve, reject) => {
    socketServer.once('error', reject);
    socketServer.listen(socketPath, resolve);
  });
  try {
    process.env.OLYMPUS_DISPATCH_UPDATE_SOCKET = socketPath;
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
