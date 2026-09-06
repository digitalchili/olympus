import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'olympus-standalone-update-'));
const updater = resolve('scripts/standalone/docker_compose_update.sh');
const image = 'ghcr.io/digitalchili/olympus:1.2.3';

// Execute the real updater. Only Docker and sleep are replaced; the environment
// switch, backup copy, rollback and exit status run against disposable files.
const fakeDocker = `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE, 'utf8'));
const finish = (code = 0, output = '') => {
  fs.writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state));
  process.stdout.write(output);
  process.exitCode = code;
};
if (args[0] === 'pull') finish();
else if (args[0] === 'image' && args[1] === 'inspect') {
  const format = args.at(-1);
  if (format === '{{.Id}}') finish(0, state.requestedId);
  else if (format.includes('image.version')) finish(0, '1.2.3');
  else if (format.includes('image.source')) finish(0, 'https://github.com/digitalchili/olympus');
  else throw Error('Unexpected image inspection');
} else if (args[0] === 'inspect') finish(0, args.at(-1) === '{{.Image}}' ? state.currentId : state.originalImage);
else if (args[0] === 'compose') {
  if (args.includes('ps')) finish(0, 'original-container');
  else if (args.includes('up')) {
    state.starts += 1;
    // Either Compose has nothing to change, or replacement fails before it
    // touches the original container. Restoring its old configuration is a no-op.
    finish(state.scenario === 'failed-replacement' && state.starts === 1 ? 23 : 0);
  } else throw Error('Unexpected Compose operation');
} else if (args[0] === 'exec') {
  const endpoint = args.at(-1);
  if (endpoint === 'drain') { state.drained = true; finish(0, '{"activeRuns":0}'); }
  else if (endpoint === 'status') finish(0, '{"activeRuns":0}');
  else if (endpoint === 'cancel') { state.drained = false; state.cancels += 1; finish(); }
  else if (args.some(arg => arg.includes('/api/ready'))) finish(state.drained ? 1 : 0);
  else if (args.includes('test') || args.includes('rm') || args.includes('sh')) finish();
  else throw Error('Unexpected container command');
} else if (args[0] === 'cp') { fs.writeFileSync(args[2], 'fixture SQLite backup'); finish(); }
else throw Error('Unexpected Docker command');
`;

try {
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), fakeDocker);
  await writeFile(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  await chmod(join(bin, 'docker'), 0o755);
  await chmod(join(bin, 'sleep'), 0o755);

  for (const scenario of ['same-version', 'failed-replacement']) await test(`${scenario} resumes the unchanged container`, async () => {
    const directory = join(root, scenario);
    await mkdir(directory);
    const environmentFile = join(directory, '.env');
    const stateFile = join(directory, 'docker-state.json');
    const originalImage = scenario === 'same-version' ? image : 'sha256:previous';
    const originalEnvironment = `OLYMPUS_DISPATCH_IMAGE=${originalImage}\nPRESERVED_SETTING=fixture\n`;
    await writeFile(environmentFile, originalEnvironment);
    await writeFile(stateFile, JSON.stringify({
      scenario, originalImage, currentId: 'sha256:previous',
      requestedId: scenario === 'same-version' ? 'sha256:previous' : 'sha256:candidate',
      starts: 0, cancels: 0, drained: false,
    }));
    const result = await new Promise<{ code: number | null; stderr: string }>((resolveRun, reject) => {
      const child = spawn('sh', [updater, '--version', '1.2.3'], {
        cwd: directory,
        env: {
          ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_STATE: stateFile,
          OLYMPUS_UPDATER_COMPOSE_DIR: directory, OLYMPUS_UPDATER_COMPOSE_PROJECT: 'fixture',
          OLYMPUS_UPDATER_COMPOSE_FILE: 'fixture.yml', OLYMPUS_UPDATER_SERVICE: 'olympus-dispatch',
          OLYMPUS_UPDATER_ENV_FILE: environmentFile, OLYMPUS_UPDATER_GHCR_TOKEN: '',
          OLYMPUS_UPDATER_BACKUP_DIR: join(directory, 'backups'), OLYMPUS_UPDATER_LOCK_DIR: join(directory, 'lock'),
          OLYMPUS_UPDATER_READY_ATTEMPTS: '1', OLYMPUS_UPDATER_DRAIN_ATTEMPTS: '1',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => resolveRun({ code, stderr }));
    });
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(result.code, scenario === 'same-version' ? 0 : 23, result.stderr);
    assert.equal(state.drained, false, 'the original container must resume after success or rollback');
    assert.equal(state.cancels, 1);
    assert.equal(state.currentId, 'sha256:previous');
    assert.doesNotMatch(result.stderr, /CRITICAL/);
    assert.equal(await readFile(environmentFile, 'utf8'), originalEnvironment);
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
