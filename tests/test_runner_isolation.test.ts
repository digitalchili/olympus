import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-runner-sentinel-'));
const sentinel = join(root, 'installation.db');
const probe = join(root, 'probe.mjs');
try {
  await writeFile(sentinel, 'original installation');
  await writeFile(probe, `
    import { writeFileSync, existsSync } from 'node:fs';
    import assert from 'node:assert/strict';
    for (const key of ['OLYMPUS_DISPATCH_HOME', 'HERMES_HOME', 'OLYMPUS_DISPATCH_PROJECT_ROOT']) {
      assert.ok(existsSync(process.env[key]), key);
      assert.notEqual(process.env[key], process.env.SENTINEL_HOME, key);
    }
    writeFileSync(process.env.DB_PATH, 'test data');
    console.log('isolated child ran');
  `);
  const result = spawnSync('npm', ['test', '--', probe], {
    encoding: 'utf8',
    env: {
      ...process.env, DB_PATH: sentinel, SENTINEL_HOME: root,
      OLYMPUS_DISPATCH_HOME: root, HERMES_HOME: root, OLYMPUS_DISPATCH_PROJECT_ROOT: root,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /isolated child ran/);
  assert.equal(await readFile(sentinel, 'utf8'), 'original installation');
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('Test runner installation isolation passed');
