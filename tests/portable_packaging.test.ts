import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const required = [
  'docker-compose.ha.yml',
  'deploy/nginx/nginx.conf',
  'deploy/nginx/active-blue.conf',
  'deploy/nginx/active-green.conf',
  'scripts/docker/install.sh',
  'scripts/docker/update.sh',
  'scripts/docker/rollback.sh',
  'scripts/docker/status.sh',
  'scripts/docker/backup.sh',
  'scripts/docker/uninstall.sh',
  'scripts/macos/install.sh',
  'scripts/macos/update.sh',
  'scripts/macos/uninstall.sh',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
];

for (const file of required) await access(file);

const portableDefaults = await Promise.all([
  readFile('docker-compose.yml', 'utf8'),
  readFile('docker-compose.ha.yml', 'utf8'),
  readFile('.env.example', 'utf8'),
]);
for (const content of portableDefaults) {
  assert.doesNotMatch(content, /Somboon|Digital Chili|100\.67\.|som_internal|somboon-vps/i);
  assert.doesNotMatch(content, /OLYMPUS_REMOTE_PROFILES|remote profile/i);
}

const removedExternalProfileFiles = [
  'server/remote-profiles.ts',
  'server/adapters/remote-hermes.ts',
  'docs/remote-profiles.md',
  'docs/remote-profiles.example.json',
];
for (const file of removedExternalProfileFiles) {
  await assert.rejects(access(file), { code: 'ENOENT' });
}

const localProfileSources = await Promise.all([
  readFile('server/local-profiles.ts', 'utf8'),
  readFile('server/adapters/routing.ts', 'utf8'),
  readFile('server/routes/profiles.ts', 'utf8'),
  readFile('client/src/components/ProfilesSettings.tsx', 'utf8'),
  readFile('README.md', 'utf8'),
]);
for (const content of localProfileSources) {
  assert.doesNotMatch(content, /RemoteHermes|remoteProfile|OLYMPUS_REMOTE_PROFILES|remote profile/i);
}

for (const file of required.filter((file) => file.endsWith('.sh'))) {
  const content = await readFile(file, 'utf8');
  assert.match(content, /--dry-run/);
  assert.match(content, /set -[Ee]*u/);
}

const proxy = await readFile('deploy/nginx/nginx.conf', 'utf8');
assert.match(proxy, /proxy_buffering\s+off/);
assert.match(proxy, /proxy_read_timeout\s+3600s/);

const macInstall = await readFile('scripts/macos/install.sh', 'utf8');
const macUpdate = await readFile('scripts/macos/update.sh', 'utf8');
for (const content of [macInstall, macUpdate]) {
  assert.match(content, /releases/);
  assert.match(content, /current/);
}
const macLib = await readFile('scripts/macos/lib.sh', 'utf8');
assert.match(macLib, /node@22/);
assert.match(macLib, /--exclude=['"]?\.env['"]?/);
assert.match(macLib, /--exclude=['"]?\.env\.\*['"]?/);
assert.match(macUpdate, /activeRuns/);
assert.match(macUpdate, /previous_current/);

for (const compose of portableDefaults.slice(0, 2)) {
  assert.match(compose, /DB_PATH:\s*\/opt\/data\/olympus-dispatch\/data\/olympus-dispatch\.db/);
  assert.match(compose, /HERMES_WRITE_SAFE_ROOT:\s*\/opt\/data/);
}
const plist = await readFile('deploy/macos/com.olympus.dispatch.plist', 'utf8');
assert.match(plist, /<key>DB_PATH<\/key><string>@@STATE_HOME@@\/data\/olympus-dispatch\.db<\/string>/);

console.log('Portable packaging contract tests passed');
