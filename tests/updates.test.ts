import assert from 'node:assert/strict';
import { request } from 'node:http';
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
const originalFetch = globalThis.fetch;
delete process.env.OLYMPUS_DISPATCH_UPDATE_URL;
globalThis.fetch = async () => {
  throw new Error('No network request should run without a configured update hook.');
};

const app = express();
app.use('/api/updates', createUpdatesRouter());
const server = app.listen(0);

try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await new Promise<{ status: number; body: { error?: string } }>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: address.port,
      path: '/api/updates/apply',
      method: 'POST',
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

  assert.equal(response.status, 503);
  assert.match(response.body.error ?? '', /installation-local update hook/i);
} finally {
  server.close();
  globalThis.fetch = originalFetch;
  if (previousUpdateUrl === undefined) delete process.env.OLYMPUS_DISPATCH_UPDATE_URL;
  else process.env.OLYMPUS_DISPATCH_UPDATE_URL = previousUpdateUrl;
}

console.log('Update helper and route tests passed');
