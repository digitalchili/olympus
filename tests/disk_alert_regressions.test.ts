import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'olympus-disk-regressions-'));
process.env.OLYMPUS_DISPATCH_HOME = join(root, 'state');
process.env.HERMES_HOME = join(root, 'hermes');
process.env.DB_PATH = join(root, 'test.db');
const alerts = await import('../server/disk-alert.js');
const { default: db } = await import('../server/db/index.js');
const { insertTask, updateTask, getTask } = await import('../server/db/queries.js');
const high = { customHome: root, customStats: { totalBytes: 1000, freeBytes: 50 } };
const low = { ...high, customStats: { totalBytes: 1000, freeBytes: 300 } };
function reset() { db.exec('DELETE FROM tasks; DELETE FROM app_settings'); }
after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

test('overlapping checks create one active alert', async () => {
  reset();
  const results = await Promise.all(Array.from({ length: 5 }, () => alerts.checkDiskSpaceAndAlert(high)));
  assert.equal(new Set(results.map((result) => result.task?.id)).size, 1);
});

test('a new incident alerts immediately after automatic recovery', async () => {
  reset();
  const first = await alerts.checkDiskSpaceAndAlert(high);
  await alerts.checkDiskSpaceAndAlert(low);
  const next = await alerts.checkDiskSpaceAndAlert(high);
  assert.equal(next.task?.status, 'in_review');
  assert.notEqual(next.task?.id, first.task?.id);
});

test('recovery stays effective after the polling process restarts', async () => {
  reset();
  await alerts.checkDiskSpaceAndAlert(high);
  await alerts.checkDiskSpaceAndAlert(low);
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    env: process.env, encoding: 'utf8',
    input: `
      const { checkDiskSpaceAndAlert } = await import('./server/disk-alert.ts');
      const result = await checkDiskSpaceAndAlert({ customHome: process.env.OLYMPUS_DISPATCH_HOME, customStats: { totalBytes: 1000, freeBytes: 50 } });
      console.log(result.task.status);
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'in_review');
});

test('dismissal cooldown starts at dismissal, but recovery clears it', async () => {
  reset();
  const first = await alerts.checkDiskSpaceAndAlert(high);
  const id = first.task!.id;
  db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(Date.now() - 8 * 60 * 60 * 1000, id);
  updateTask(id, { status: 'done' });
  assert.equal((await alerts.checkDiskSpaceAndAlert(high)).task?.id, id);
  await alerts.checkDiskSpaceAndAlert(low);
  assert.equal((await alerts.checkDiskSpaceAndAlert(high)).task?.status, 'in_review');
});

test('running disk tests preserves a configured installation sentinel', () => {
  reset();
  const sentinel = insertTask({ title: 'Preserve user notes', description: 'original bytes', status: 'in_review', routing_source: 'system_alert' });
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tests/disk_alert.test.ts'], { env: process.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(getTask(sentinel.id)?.description, 'original bytes');
});

test('background polling survives SQLITE_FULL and reports the failure', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    env: { ...process.env, DB_PATH: join(root, 'full.db') }, encoding: 'utf8',
    input: `
      const { default: db } = await import('./server/db/index.ts');
      const { insertTask } = await import('./server/db/queries.ts');
      const alerts = await import('./server/disk-alert.ts');
      db.pragma('max_page_count = ' + db.pragma('page_count', { simple: true }));
      for (;;) {
        try { insertTask({ title: 'fill', status: 'in_progress' }); }
        catch (error) { if (error.code !== 'SQLITE_FULL') throw error; break; }
      }
      const poll = alerts.pollDiskSpaceAndAlert ?? alerts.checkDiskSpaceAndAlert;
      void poll({ customHome: process.env.OLYMPUS_DISPATCH_HOME, customStats: { totalBytes: 1000, freeBytes: 0 } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      db.close();
      console.log('poll settled');
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /poll settled/);
  assert.match(result.stdout + result.stderr, /SQLITE_FULL/);
});
