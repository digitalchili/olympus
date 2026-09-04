import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { request } from 'node:http';
import { createStorageRouter } from '../server/routes/storage.js';
import type { StorageStatus } from '../shared/types.js';

const app = express();
app.use('/api/storage', createStorageRouter());

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');

try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const result = await new Promise<{ status: number; body: StorageStatus }>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: address.port,
      path: '/api/storage',
      method: 'GET',
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
    req.end();
  });

  assert.equal(result.status, 200);
  assert.ok(result.body.olympusHome);
  assert.ok(result.body.hermesHome);
  assert.ok(result.body.projectRoot);
  assert.ok(result.body.dbPath);
  assert.equal(typeof result.body.isDocker, 'boolean');

  if (result.body.disk) {
    assert.ok(result.body.disk.totalBytes > 0);
    assert.ok(result.body.disk.usedPercent >= 0 && result.body.disk.usedPercent <= 100);
  }

  server.close();
} finally {
  server.close();
}

console.log('Storage route tests passed');
process.exit(0);
