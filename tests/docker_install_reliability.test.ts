import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const image = 'ghcr.io/digitalchili/olympus:9.8.7';
const pin = `ghcr.io/digitalchili/olympus@sha256:${'a'.repeat(64)}`;
const originalEnvironment = 'HERMES_DATA_VOLUME=selected-hermes\nOLYMPUS_DISPATCH_STATE_VOLUME=fixture-state\nOLYMPUS_MAINTENANCE_TOKEN=fixture-token\nPRESERVED_SETTING=keep\n';

// Run the actual lifecycle scripts with disposable files. Only host/Docker
// boundaries are replaced, so no real installation or credentials are accessed.
async function fixture(body: (context: {
  directory: string;
  run: (script: string, args?: string[], extraEnv?: Record<string, string>) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  commands: () => Promise<Array<{ args: string[]; hermes?: string }>>;
}) => Promise<void>) {
  const directory = await mkdtemp(join(process.cwd(), '.tmp-olympus-docker-install-'));
  const bin = join(directory, 'bin');
  const log = join(directory, 'commands.jsonl');
  await mkdir(bin);
  await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}');
  await cp('scripts/docker', join(directory, 'scripts/docker'), { recursive: true });
  await cp('deploy/nginx', join(directory, 'deploy/nginx'), { recursive: true });
  await writeFile(log, '');
  await writeFile(join(bin, 'docker'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ args, hermes: process.env.HERMES_DATA_VOLUME }) + '\\n');
if (args[0] === 'pull') process.exitCode = process.env.FIXTURE_PULL_FAIL === '1' ? 1 : 0;
else if (args[0] === 'image' && args[1] === 'inspect') {
  if (process.env.FIXTURE_PULL_FAIL === '1' && process.env.FIXTURE_CACHED !== '1') process.exitCode = 1;
  else process.stdout.write(${JSON.stringify(pin)});
} else if (args[0] === 'volume' && ['inspect', 'create'].includes(args[1])) {}
else if (args[0] === 'run' || args[0] === 'exec') {}
else if (args[0] === 'compose' && args.includes('ps')) process.stdout.write('fixture-container');
else if (args[0] === 'compose' && (args.includes('up') || args.includes('stop'))) {}
else throw Error('Unexpected Docker operation: ' + JSON.stringify(args));
`, { mode: 0o755 });
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(bin, 'openssl'), '#!/bin/sh\nprintf fixture-generated-token\n', { mode: 0o755 });
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
require('fs').appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ args: ['gh', ...process.argv.slice(2)] }) + '\\n');
process.exitCode = 1;
`, { mode: 0o755 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OLYMPUS_|HERMES_|COMPOSE_|DRY_RUN$|YES$|ACTIVE_SLOT_FILE$|METADATA_FILE$)/.test(key)));
  try {
    await body({
      directory,
      commands: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
      run: (script, args = [], extraEnv = {}) => new Promise((resolve, reject) => {
        const child = spawn('sh', [join(directory, 'scripts/docker', script), ...args], {
          cwd: directory,
          env: { ...env, HOME: directory, PATH: `${bin}:${process.env.PATH}`, FIXTURE_LOG: log, ...extraEnv },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', code => resolve({ code, stdout, stderr }));
      }),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const script of ['install.sh', 'update.sh']) {
  await test(`${script} refuses an unspecified image before Docker or local mutations`, async () => fixture(async ({ directory, run, commands }) => {
    await writeFile(join(directory, '.env'), originalEnvironment);
    if (script === 'update.sh') {
      await writeFile(join(directory, '.olympus-active-slot'), 'blue\n');
      await writeFile(join(directory, '.olympus-slots.env'), `OLYMPUS_BLUE_IMAGE=${pin}\nOLYMPUS_GREEN_IMAGE=${pin}\n`);
    }
    const result = await run(script, ['--dry-run', '--yes', '--hermes-volume', 'selected-hermes']);
    assert.notEqual(result.code, 0, 'a missing image must not silently choose an old release');
    assert.match(result.stderr, /--image|OLYMPUS_DISPATCH_IMAGE/);
    assert.deepEqual(await commands(), []);
    assert.equal(await readFile(join(directory, '.env'), 'utf8'), originalEnvironment);
  }));
}

await test('update requires --image even when an older image is saved in .env', async () => fixture(async ({ directory, run, commands }) => {
  const original = originalEnvironment + 'OLYMPUS_DISPATCH_IMAGE=ghcr.io/digitalchili/olympus:0.3.0\n';
  await writeFile(join(directory, '.env'), original);
  await writeFile(join(directory, '.olympus-active-slot'), 'blue\n');
  await writeFile(join(directory, '.olympus-slots.env'), `OLYMPUS_BLUE_IMAGE=${pin}\nOLYMPUS_GREEN_IMAGE=${pin}\n`);
  const result = await run('update.sh', ['--dry-run']);
  assert.notEqual(result.code, 0, 'update must not reuse a stale configured image');
  assert.match(result.stderr, /--image/);
  assert.deepEqual(await commands(), []);
  assert.equal(await readFile(join(directory, '.env'), 'utf8'), original);
}));

await test('install refuses a conflicting saved Hermes volume before touching Docker or configuration', async () => fixture(async ({ directory, run, commands }) => {
  const original = originalEnvironment.replace('selected-hermes', 'saved-hermes');
  await writeFile(join(directory, '.env'), original);
  const result = await run('install.sh', ['--yes', '--image', image, '--hermes-volume', 'selected-hermes']);
  assert.notEqual(result.code, 0, 'a saved installation must not silently change volume');
  assert.match(result.stderr, /Hermes volume|HERMES_DATA_VOLUME/);
  assert.deepEqual(await commands(), []);
  assert.equal(await readFile(join(directory, '.env'), 'utf8'), original);
  await assert.rejects(readFile(join(directory, '.olympus-active-slot')), { code: 'ENOENT' });
}));

for (const dryRun of [true, false]) {
  await test(`update refuses a conflicting saved Hermes volume before Docker (${dryRun ? 'dry-run' : 'apply'})`, async () => fixture(async ({ directory, run, commands }) => {
    const original = originalEnvironment.replace('selected-hermes', 'saved-hermes');
    const metadata = `OLYMPUS_BLUE_IMAGE=${pin}\nOLYMPUS_GREEN_IMAGE=${pin}\n`;
    await writeFile(join(directory, '.env'), original);
    await writeFile(join(directory, '.olympus-active-slot'), 'blue\n');
    await writeFile(join(directory, '.olympus-slots.env'), metadata);
    const args = ['--image', image, '--hermes-volume', 'different-hermes', ...(dryRun ? ['--dry-run'] : [])];
    const result = await run('update.sh', args, { FIXTURE_PULL_FAIL: '1' });
    assert.deepEqual(await commands(), [], 'volume conflicts must stop before any Docker action');
    assert.notEqual(result.code, 0, 'an update must not use a different Hermes installation');
    assert.match(result.stderr, /Hermes volume|HERMES_DATA_VOLUME/);
    assert.equal(await readFile(join(directory, '.env'), 'utf8'), original);
    assert.equal(await readFile(join(directory, '.olympus-active-slot'), 'utf8'), 'blue\n');
    assert.equal(await readFile(join(directory, '.olympus-slots.env'), 'utf8'), metadata);
  }));
}

await test('install persists an explicit Hermes selection in an existing environment and immutable slot pins', async () => fixture(async ({ directory, run, commands }) => {
  await writeFile(join(directory, '.env'), originalEnvironment.replace('HERMES_DATA_VOLUME=selected-hermes\n', '') + 'OLYMPUS_DISPATCH_IMAGE=ghcr.io/digitalchili/olympus:0.3.0\n');
  const result = await run('install.sh', ['--yes', '--image', pin, '--hermes-volume', 'selected-hermes']);
  assert.equal(result.code, 0, result.stderr);
  const saved = await readFile(join(directory, '.env'), 'utf8');
  assert.match(saved, /^HERMES_DATA_VOLUME=selected-hermes$/m);
  assert.match(saved, /^PRESERVED_SETTING=keep$/m);
  assert.match(saved, /^OLYMPUS_MAINTENANCE_TOKEN=fixture-token$/m);
  assert.equal(await readFile(join(directory, '.olympus-slots.env'), 'utf8'), `OLYMPUS_BLUE_IMAGE=${pin}\nOLYMPUS_GREEN_IMAGE=${pin}\n`);
  assert.equal(await readFile(join(directory, '.olympus-active-slot'), 'utf8'), 'blue\n');
  const calls = await commands();
  assert.deepEqual(calls.find(call => call.args[0] === 'pull')?.args, ['pull', pin]);
  assert.equal(calls.find(call => call.args.includes('up'))?.hermes, 'selected-hermes');
}));

await test('matching saved volume and explicit cached image still install without credentials', async () => fixture(async ({ directory, run, commands }) => {
  await writeFile(join(directory, '.env'), originalEnvironment + `OLYMPUS_DISPATCH_IMAGE=${image}\n`);
  const result = await run('install.sh', ['--yes', '--hermes-volume', 'selected-hermes'], { FIXTURE_PULL_FAIL: '1', FIXTURE_CACHED: '1' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(join(directory, '.olympus-active-slot'), 'utf8'), 'blue\n');
  assert.ok((await commands()).every(call => !call.args.includes('gh') && !call.args.includes('login')));
}));

await test('failed public pull without a cached image fails without reading GitHub credentials', async () => fixture(async ({ directory, run, commands }) => {
  await writeFile(join(directory, '.env'), originalEnvironment);
  const result = await run('install.sh', ['--yes', '--image', image, '--hermes-volume', 'selected-hermes'], { FIXTURE_PULL_FAIL: '1' });
  assert.notEqual(result.code, 0);
  assert.ok((await commands()).every(call => !call.args.includes('gh') && !call.args.includes('login')), 'public installation must never read or configure GitHub credentials');
  assert.equal(await readFile(join(directory, '.env'), 'utf8'), originalEnvironment);
}));

await test('dry-run reports the selected image and volume without creating installation files', async () => fixture(async ({ directory, run, commands }) => {
  const result = await run('install.sh', ['--dry-run', '--yes', '--image', image, '--hermes-volume', 'selected-hermes']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(image), 'dry-run must identify the exact selected image');
  assert.match(result.stdout, /selected-hermes/);
  assert.deepEqual((await commands()).map(call => call.args), [['volume', 'inspect', 'selected-hermes']]);
  await assert.rejects(readFile(join(directory, '.env')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, '.olympus-active-slot')), { code: 'ENOENT' });
}));
