import assert from 'node:assert/strict';
import fs, { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after, mock } from 'node:test';
import express from 'express';

const root = await mkdtemp(join(tmpdir(), 'olympus-disk-maintenance-'));
process.env.DB_PATH = join(root, 'test.db');
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.HERMES_HOME = join(root, 'hermes');
const { checkDiskSpaceAndAlert, pollDiskSpaceAndAlert } = await import('../server/disk-alert.js');
const { createStorageRouter } = await import('../server/routes/storage.js');
const { default: db } = await import('../server/db/index.js');
const high = { customStats: { totalBytes: 1000, freeBytes: 0 } };
const count = () => (db.prepare('SELECT count(*) AS count FROM tasks').get() as { count: number }).count;
after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

test('maintenance suppresses queued disk alert mutations', async () => {
  await checkDiskSpaceAndAlert({ ...high, canWrite: () => false });
  assert.equal(count(), 0);
});

test('maintenance beginning during mount inspection prevents a late insert', async () => {
  db.exec('DELETE FROM tasks; DELETE FROM app_settings');
  let draining = false;
  await checkDiskSpaceAndAlert({ ...high, canWrite: () => {
    if (!draining) queueMicrotask(() => { draining = true; });
    return !draining;
  } });
  assert.equal(draining, true);
  assert.equal(count(), 0, 'an admitted poll must recheck after awaited mount inspection');
});

test('GET storage respects the maintenance predicate while still returning disk information', async () => {
  db.exec('DELETE FROM tasks; DELETE FROM app_settings');
  const fault = mock.method(fs, 'statfs', async () => ({ blocks: 1000, bavail: 0, bsize: 1 }));
  syncBuiltinESMExports();
  const app = express();
  app.use('/storage', createStorageRouter(() => false));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/storage`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).disk.usedPercent, 100);
    await pollDiskSpaceAndAlert({ ...high, canWrite: () => false });
    assert.equal(count(), 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fault.mock.restore();
    syncBuiltinESMExports();
  }
});
