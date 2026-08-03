import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, cp, readFile, rm } from 'node:fs/promises';
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

// Real curl integration: the fixture receives the secret while process output does not.
const secret = 'fixture-maintenance-secret';
let received = '';
const server = createServer((req, res) => { received = req.headers.authorization ?? ''; res.end('{"activeRuns":0}'); });
const socket = join(tmpdir(), `olympus-auth-${process.pid}.sock`);
const listening = await new Promise<boolean>((resolve, reject) => {
  server.once('error', (error: NodeJS.ErrnoException) => error.code === 'EPERM' ? resolve(false) : reject(error));
  server.listen(socket, () => resolve(true));
});
if (listening) {
  const authRun = await run('sh', ['-c', '. ./scripts/docker/lib.sh; maintenance_at http://localhost GET status'], {
    cwd: process.cwd(), env: { ...process.env, OLYMPUS_MAINTENANCE_TOKEN: secret, CURL_UNIX_SOCKET: socket }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.close();
  assert.equal(authRun.code, 0);
  assert.equal(received, `Bearer ${secret}`);
  assert.doesNotMatch(authRun.stdout + authRun.stderr, new RegExp(secret));
} else {
  server.close();
  process.stderr.write('SKIP local HTTP auth fixture: sandbox forbids listening sockets\n');
}

// Deterministic Docker harness: verifies order, immutable slot metadata, and recovery.
// Keep executable fixtures on the repository filesystem. Some Linux /tmp mounts are noexec.
const fixture = await mkdtemp(join(process.cwd(), '.tmp-olympus-portable-'));
await mkdir(join(fixture, 'scripts/docker'), { recursive: true });
await mkdir(join(fixture, 'deploy/nginx/conf.d'), { recursive: true });
for (const file of ['lib.sh', 'update.sh', 'rollback.sh', 'backup.sh']) await cp(join('scripts/docker', file), join(fixture, 'scripts/docker', file));
for (const file of ['active-blue.conf', 'active-green.conf']) await cp(join('deploy/nginx', file), join(fixture, 'deploy/nginx', file));
await cp('docker-compose.ha.yml', join(fixture, 'docker-compose.ha.yml'));
await writeFile(join(fixture, '.env'), 'HERMES_DATA_VOLUME=hermes\nOLYMPUS_MAINTENANCE_TOKEN=fake-secret\n');
await writeFile(join(fixture, '.olympus-active-slot'), 'blue\n');
await writeFile(join(fixture, '.olympus-slots.env'), 'OLYMPUS_BLUE_IMAGE=repo@sha256:oldblue\nOLYMPUS_GREEN_IMAGE=repo@sha256:oldgreen\n');
await writeFile(join(fixture, 'deploy/nginx/conf.d/active.conf'), 'blue\n');
const bin = join(fixture, 'bin'); await mkdir(bin);
await writeFile(join(bin, 'docker'), `#!/bin/sh
echo "docker $*" >> "$FAKE_LOG"
case "$*" in
  "image inspect"*) case "$*" in *version*) echo 0.3.0;; *) echo repo@sha256:newimage;; esac ;;
  "compose"*"ps -q"*) echo fake-container ;;
esac
exit 0
`, { mode: 0o755 });
await writeFile(join(bin, 'curl'), `#!/bin/sh
config=$(cat)
echo "curl $* $(printf '%s' "$config" | sed 's/Bearer [^\"]*/Bearer REDACTED/')" >> "$FAKE_LOG"
case "$config" in *maintenance/status*) echo '{"activeRuns":0}' ;; esac
case "$*" in *api/ready*) [ "${'$'}{FAIL_PROXY:-0}" = 1 ] && exit 22 ;; esac
exit 0
`, { mode: 0o755 });
const log = join(fixture, 'commands.log');
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, DRAIN_INTERVAL_SECONDS: '0', BACKUP_DIR: join(fixture, 'backups') };

// A live operation lock must reject concurrent lifecycle work before Docker is touched.
await mkdir(join(fixture, '.olympus-operation.lock'));
await writeFile(join(fixture, '.olympus-operation.lock/pid'), `${process.pid}\n`);
const lockedUpdate = await run('sh', ['scripts/docker/update.sh', '--yes'], { cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe'] });
assert.notEqual(lockedUpdate.code, 0);
assert.match(lockedUpdate.stderr, /Another Olympus operation is running/);
await rm(join(fixture, '.olympus-operation.lock'), { recursive: true });

const update = await run('sh', ['scripts/docker/update.sh', '--yes'], { cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe'] });
assert.equal(update.code, 0, update.stderr);
const commands = await readFile(log, 'utf8');
const positions = ['docker pull', 'olympus-preflight-state', 'maintenance/drain', 'maintenance/status', ':/state -v', 'up -d --no-deps olympus-green', 'nginx -s reload', '--retry 10', 'stop olympus-blue']
  .map((needle) => commands.indexOf(needle));
for (let i = 0; i < positions.length; i += 1) assert(positions[i] >= 0 && (i === 0 || positions[i] > positions[i - 1]), `missing/out-of-order command index ${i}:\n${commands}`);
assert.equal(await readFile(join(fixture, '.olympus-active-slot'), 'utf8'), 'green\n');
assert.match(await readFile(join(fixture, '.olympus-slots.env'), 'utf8'), /OLYMPUS_GREEN_IMAGE=repo@sha256:newimage/);
assert.doesNotMatch(commands + update.stdout + update.stderr, /fake-secret/);

await writeFile(log, '');
const rollback = await run('sh', ['scripts/docker/rollback.sh', '--yes'], { cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe'] });
assert.equal(rollback.code, 0, rollback.stderr);
const rollbackCommands = await readFile(log, 'utf8');
const rollbackBackup = rollbackCommands.indexOf(':/state -v');
const rollbackStart = rollbackCommands.indexOf('up -d --no-deps olympus-blue');
assert(rollbackBackup >= 0 && rollbackStart > rollbackBackup, rollbackCommands);
assert.equal(await readFile(join(fixture, '.olympus-active-slot'), 'utf8'), 'blue\n');

const metadataBeforeFailure = await readFile(join(fixture, '.olympus-slots.env'), 'utf8');
await writeFile(log, '');
const failedUpdate = await run('sh', ['scripts/docker/update.sh', '--yes'], { cwd: fixture, env: { ...env, FAIL_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
assert.notEqual(failedUpdate.code, 0);
assert.equal(await readFile(join(fixture, '.olympus-active-slot'), 'utf8'), 'blue\n');
assert.equal(await readFile(join(fixture, '.olympus-slots.env'), 'utf8'), metadataBeforeFailure);
assert.equal(await readFile(join(fixture, 'deploy/nginx/conf.d/active.conf'), 'utf8'), await readFile(join(fixture, 'deploy/nginx/active-blue.conf'), 'utf8'));
const recovery = await readFile(log, 'utf8');
assert.match(recovery, /stop olympus-green/);
assert.match(recovery, /maintenance\/cancel/);
assert.match(recovery, /exec -T olympus-blue node -e/);

// macOS dry-runs are isolated and cannot touch the real HOME, launchd, or Hermes state.
const fakeHome = await mkdtemp(join(tmpdir(), 'olympus-macos-home-'));
const fakeHermesPython = join(fakeHome, '.hermes/hermes-agent/venv/bin/python');
await mkdir(join(fakeHome, '.hermes/hermes-agent/venv/bin'), { recursive: true });
await writeFile(fakeHermesPython, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
for (const script of ['install.sh', 'update.sh']) {
  const dry = await run('sh', [join(process.cwd(), 'scripts/macos', script), '--dry-run'], {
    cwd: process.cwd(), env: { ...process.env, HOME: fakeHome, OLYMPUS_INSTALL_ROOT: join(fakeHome, 'install') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(dry.code, 0, dry.stderr);
}
await assert.rejects(readFile(join(fakeHome, 'Library/LaunchAgents/com.olympus.dispatch.plist')));
await assert.rejects(readFile(join(fakeHome, 'install/current')));
await rm(fixture, { recursive: true, force: true });
await rm(fakeHome, { recursive: true, force: true });

console.log('Portable shell integration tests passed');
