import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

function run(command: string, args: string[], options: Record<string, unknown>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, options);
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const projectRoot = process.cwd();
const fixture = await mkdtemp(join(projectRoot, '.tmp-olympus-macos-reliability-'));
const stateHome = await mkdtemp(join(tmpdir(), 'omr-state-'));

try {
  const repository = join(fixture, 'release-repository');
  await mkdir(repository);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Olympus Test'],
  ]) {
    const result = await run('git', args, { cwd: repository, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.code, 0, result.stderr);
  }
  await writeFile(join(repository, 'package.json'), '{"name":"release-fixture","version":"1.2.3"}\n');
  for (const args of [['add', 'package.json'], ['commit', '-qm', 'release fixture'], ['tag', 'v1.2.3'], ['tag', 'v2.0.0']]) {
    const result = await run('git', args, { cwd: repository, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.code, 0, result.stderr);
  }
  await writeFile(join(repository, 'package.json'), '{"name":"release-fixture","version":"9.9.9"}\n');

  const candidateSource = join(fixture, 'candidate-source');
  const fetch = await run('sh', ['-c', '. ./scripts/macos/lib.sh; node=$(command -v node); fetch_release_source 1.2.3 "$DESTINATION"'], {
    cwd: projectRoot,
    env: { ...process.env, DESTINATION: candidateSource, OLYMPUS_UPDATE_GIT_URL: repository },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(fetch.code, 0, fetch.stderr);
  assert.equal(JSON.parse(await readFile(join(candidateSource, 'package.json'), 'utf8')).version, '1.2.3');

  const mismatched = await run('sh', ['-c', '. ./scripts/macos/lib.sh; node=$(command -v node); fetch_release_source 2.0.0 "$DESTINATION"'], {
    cwd: projectRoot,
    env: { ...process.env, DESTINATION: join(fixture, 'mismatched-source'), OLYMPUS_UPDATE_GIT_URL: repository },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.notEqual(mismatched.code, 0, 'tag/package version mismatch must be rejected');
  assert.match(mismatched.stderr, /does not match requested release/i);

  const backupDir = join(fixture, 'backups');
  const database = join(stateHome, 'data/olympus-dispatch.db');
  await mkdir(join(stateHome, 'data'), { recursive: true });
  await writeFile(join(stateHome, 'keep.txt'), 'portable state\n');
  const createDatabase = await run(process.execPath, ['-e', `const Database=require('better-sqlite3'); const db=new Database(process.argv[1]); db.exec("create table t(value text); insert into t values ('ok')"); db.close()`, database], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(createDatabase.code, 0, createDatabase.stderr);

  const socketPath = join(stateHome, 'update.sock');
  const socketServer = createServer();
  await new Promise<void>((resolve, reject) => {
    socketServer.once('error', reject);
    socketServer.listen(socketPath, resolve);
  });
  try {
    const backup = await run('sh', ['-c', '. ./scripts/macos/lib.sh; node="$NODE"; backup_native_release "$RELEASE_ROOT"'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE: process.execPath,
        RELEASE_ROOT: projectRoot,
        OLYMPUS_STATE_HOME: stateHome,
        OLYMPUS_BACKUP_DIR: backupDir,
        DB_PATH: database,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(backup.code, 0, backup.stderr);
    assert.doesNotMatch(backup.stderr, /socket/i);
  } finally {
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
  }
  const archiveName = (await readdir(backupDir)).find((name) => name.endsWith('-state.tgz'));
  assert.ok(archiveName);
  const archive = await run('tar', ['-tzf', join(backupDir, archiveName)], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(archive.code, 0, archive.stderr);
  assert.match(archive.stdout, /keep\.txt/);
  assert.doesNotMatch(archive.stdout, /update\.sock/);

  const fakeBin = join(fixture, 'bin');
  const launchLog = join(fixture, 'launchctl.log');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'launchctl'), `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_LAUNCH_LOG"
if [ "$1" = bootstrap ]; then
  count=$(cat "$FAKE_BOOTSTRAP_COUNT" 2>/dev/null || printf '0')
  count=$((count + 1))
  printf '%s\n' "$count" > "$FAKE_BOOTSTRAP_COUNT"
  [ "$count" -gt 1 ]
elif [ "$1" = kickstart ]; then
  [ "$(cat "$FAKE_BOOTSTRAP_COUNT" 2>/dev/null || printf '0')" -gt 1 ]
fi
`);
  await writeFile(join(fakeBin, 'curl'), `#!/bin/sh
case "$*" in
  */api/version*) printf '{"version":"1.2.3"}\n' ;;
  *) printf '{"ready":true}\n' ;;
esac
`);
  await chmod(join(fakeBin, 'launchctl'), 0o755);
  await chmod(join(fakeBin, 'curl'), 0o755);
  const restart = await run('sh', ['-c', '. ./scripts/macos/lib.sh; label=com.olympus.test; plist=/tmp/test.plist; PORT=16971; restart_launchd; wait_ready_mac 1.2.3'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_LAUNCH_LOG: launchLog,
      FAKE_BOOTSTRAP_COUNT: join(fixture, 'bootstrap-count'),
      LAUNCHD_INTERVAL_SECONDS: '0',
      READY_INTERVAL_SECONDS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(restart.code, 0, restart.stderr);
  const launchCommands = await readFile(launchLog, 'utf8');
  assert.match(launchCommands, /^bootout /m);
  assert.match(launchCommands, /^bootstrap /m);
  assert.match(launchCommands, /^kickstart -k /m);
  assert.equal(launchCommands.match(/^bootstrap /gm)?.length, 2, 'launchd bootstrap must retry after a transient race');

  const updateSource = await readFile('scripts/macos/update.sh', 'utf8');
  assert.match(updateSource, /--version/);
  assert.match(updateSource, /fetch_release_source/);
  assert.match(updateSource, /wait_ready_mac "\$version"/);
} finally {
  await rm(fixture, { recursive: true, force: true });
  await rm(stateHome, { recursive: true, force: true });
}

console.log('macOS update reliability tests passed');