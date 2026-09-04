import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { request } from 'node:http';
import { testLocalPathProbe } from '../server/storage-probe.js';
import { createStorageRouter } from '../server/routes/storage.js';
import type { StorageProbeResult } from '../server/storage-probe.js';

// 1. Direct function tests
const tempDir = await mkdtemp(join(tmpdir(), 'olympus-probe-test-'));

try {
  // Test valid directory
  const validResult = await testLocalPathProbe(tempDir);
  assert.equal(validResult.ok, true);
  assert.equal(validResult.isWritable, true);
  assert.ok((validResult.totalBytes ?? 0) > 0);
  assert.ok((validResult.availableBytes ?? 0) > 0);

  // Test non-existent path
  const nonExistent = await testLocalPathProbe(join(tempDir, 'does-not-exist'));
  assert.equal(nonExistent.ok, false);
  assert.match(nonExistent.error ?? '', /does not exist/);

  // Test file instead of directory
  const testFile = join(tempDir, 'file.txt');
  await writeFile(testFile, 'hello');
  const fileResult = await testLocalPathProbe(testFile);
  assert.equal(fileResult.ok, false);
  assert.match(fileResult.error ?? '', /is a file, not a directory/);

  // 2. HTTP Endpoint test
  const app = express();
  app.use(express.json());
  app.use('/api/storage', createStorageRouter());

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const probeResult = await new Promise<{ status: number; body: StorageProbeResult }>((resolve, reject) => {
      const payload = JSON.stringify({ path: tempDir });
      const req = request({
        host: '127.0.0.1',
        port: address.port,
        path: '/api/storage/probe/local',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 500,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });

    assert.equal(probeResult.status, 200);
    assert.equal(probeResult.body.ok, true);
    assert.equal(probeResult.body.isWritable, true);
  } finally {
    server.close();
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log('Storage probe tests passed');
process.exit(0);
