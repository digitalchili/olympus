import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { request } from 'node:http';
import { testLocalPathProbe, parseLinuxMounts, detectStorageMount } from '../server/storage-probe.js';
import type { StorageProbeResult } from '../server/storage-probe.js';

// 1. Direct function tests
const tempDir = await mkdtemp(join(tmpdir(), 'olympus-probe-test-'));
process.env.OLYMPUS_DISPATCH_HOME = join(tempDir, 'state');
process.env.HERMES_HOME = join(tempDir, 'hermes');
process.env.DB_PATH = join(tempDir, 'test.db');
const { createStorageRouter } = await import('../server/routes/storage.js');
const { default: db } = await import('../server/db/index.js');

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

  // 2. Linux mount table parsing tests
  const mockProcMounts = `
overlay / overlay rw,relatime,lowerdir=/var/lib/docker/overlay2/l/XYZ 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
/dev/sda1 /etc/resolv.conf ext4 rw,relatime 0 0
/dev/sdb /opt/data ext4 rw,relatime,data=ordered 0 0
tmpfs /dev/shm tmpfs rw,nosuid,nodev 0 0
`;
  const hetznerMount = parseLinuxMounts(mockProcMounts, '/opt/data/olympus-dispatch');
  assert.ok(hetznerMount);
  assert.equal(hetznerMount.device, '/dev/sdb');
  assert.equal(hetznerMount.mountPoint, '/opt/data');
  assert.equal(hetznerMount.fsType, 'ext4');
  assert.equal(hetznerMount.isExternal, true);
  assert.equal(hetznerMount.label, 'Attached Volume (/dev/sdb · ext4)');

  const vpsRootMounts = `
/dev/sda1 / ext4 rw,relatime 0 0
tmpfs /run tmpfs rw 0 0
`;
  const rootMount = parseLinuxMounts(vpsRootMounts, '/var/olympus');
  assert.ok(rootMount);
  assert.equal(rootMount.device, '/dev/sda1');
  assert.equal(rootMount.mountPoint, '/');
  assert.equal(rootMount.isExternal, false);
  assert.equal(rootMount.label, 'Primary VPS Disk (/dev/sda1 · ext4)');

  const byIdMounts = `
/dev/disk/by-id/scsi-0HC_Volume_106792525 /mnt/storage ext4 rw 0 0
`;
  const byIdResult = parseLinuxMounts(byIdMounts, '/mnt/storage/hermes');
  assert.ok(byIdResult);
  assert.equal(byIdResult.isExternal, true);
  assert.equal(byIdResult.label, 'Attached Volume (scsi-0HC_Volume_106792525 · ext4)');

  const sshfsMounts = `
user@remote:/pool /mnt/remote fuse.sshfs rw 0 0
`;
  const sshfsResult = parseLinuxMounts(sshfsMounts, '/mnt/remote/tasks');
  assert.ok(sshfsResult);
  assert.equal(sshfsResult.isExternal, true);
  assert.equal(sshfsResult.label, 'Remote SSHFS Drive (/mnt/remote)');

  const spaceMounts = `
/dev/sdc1 /mnt/my\\040drive ext4 rw 0 0
`;
  const spaceResult = parseLinuxMounts(spaceMounts, '/mnt/my drive/olympus');
  assert.ok(spaceResult);
  assert.equal(spaceResult.mountPoint, '/mnt/my drive');

  // File-based mount probe test
  const tempMountFile = join(tempDir, 'proc_mounts_mock');
  await writeFile(tempMountFile, mockProcMounts);
  const detected = await detectStorageMount('/opt/data/olympus-dispatch', tempMountFile);
  assert.ok(detected);
  assert.equal(detected.device, '/dev/sdb');
  assert.equal(detected.isExternal, true);

  // 3. HTTP Endpoint test
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
  db.close();
  await rm(tempDir, { recursive: true, force: true });
}

console.log('Storage probe tests passed');
process.exit(0);
