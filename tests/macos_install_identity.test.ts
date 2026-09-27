import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveHermesHome } from '../server/paths.js';

const repository = process.cwd();
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'olympus-macos-identity-')));
function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
const home = join(fixture, 'user');
const selected = join(fixture, 'selected & checkout');
const profileHome = join(fixture, 'selected & profiles');
const plist = join(fixture, 'launch.plist');
const serviceLog = join(fixture, 'service.log');
const env = { ...process.env, HOME: home, HERMES_AGENT_DIR: selected, HERMES_HOME: profileHome,
  OLYMPUS_INSTALL_ROOT: join(fixture, 'app'), OLYMPUS_STATE_HOME: join(fixture, 'state'),
  OLYMPUS_PLIST_PATH: plist, OLYMPUS_LAUNCHD_LABEL: 'com.olympus.fixture',
  FIXTURE_SERVICE_LOG: serviceLog, PLISTBUDDY: join(fixture, 'PlistBuddy'),
};
const parsePlist = async () => {
  const result = await run('python3', ['-c', 'import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))', plist], env);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
};
try {
  for (const path of [home, profileHome, join(fixture, 'scripts/macos'), join(fixture, 'deploy/macos')]) await mkdir(path, { recursive: true });
  for (const checkout of [selected, join(home, '.hermes/hermes-agent')]) {
    await mkdir(join(checkout, 'venv/bin'), { recursive: true });
    await writeFile(join(checkout, 'run_agent.py'), '# Source identity fixture only\n');
    await writeFile(join(checkout, 'venv/bin/python'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  for (const name of ['install.sh', 'update.sh', 'lib.sh']) await copyFile(join(repository, 'scripts/macos', name), join(fixture, 'scripts/macos', name));
  await copyFile(join(repository, 'deploy/macos/com.olympus.dispatch.plist'), join(fixture, 'deploy/macos/com.olympus.dispatch.plist'));
  await writeFile(join(fixture, 'package.json'), '{"version":"1.2.3"}\n');
  // Run the actual lifecycle/rendering code, replacing only the build and service
  // boundaries. This fixture cannot execute launchd, npm, curl or a real worker.
  const library = join(fixture, 'scripts/macos/lib.sh');
  await writeFile(library, (await readFile(library, 'utf8')) + `
build_release() {
  printf 'build\\n' >> "$FIXTURE_SERVICE_LOG"
  mkdir -p "$1/deploy/macos" "$1/dist/server/server"
  cp "$source_root/package.json" "$1/package.json"
  cp "$source_root/deploy/macos/com.olympus.dispatch.plist" "$1/deploy/macos/"
  : > "$1/dist/server/server/index.js"
}
restart_launchd() { printf 'restart\\n' >> "$FIXTURE_SERVICE_LOG"; }
launchctl() { printf 'mock launchctl\\n' >> "$FIXTURE_SERVICE_LOG"; }
wait_ready_mac() { return 0; }
maintenance_request() { printf 'maintenance\\n' >> "$FIXTURE_SERVICE_LOG"; printf '{"activeRuns":0}\\n'; }
backup_native_release() { return 0; }
`);
  await writeFile(env.PLISTBUDDY, `#!/usr/bin/env python3
import plistlib,sys
command, path = sys.argv[2:4]
with open(path, 'rb') as file: value = plistlib.load(file)
action, key, *rest = command.split(' ', 2)
parts = key.strip(':').split(':')
parent = value
try:
    for part in parts[:-1]: parent = parent[int(part)] if isinstance(parent, list) else parent[part]
    key = int(parts[-1]) if isinstance(parent, list) else parts[-1]
    if action == 'Print': print(parent[key]); sys.exit(0)
    if action == 'Delete': del parent[key]
    elif action == 'Set':
        parent[key]  # Set must reject missing keys, just like PlistBuddy.
        parent[key] = rest[0]
    elif action == 'Add':
        kind, _, text = rest[0].partition(' ')
        new = [] if kind == 'array' else text
        if isinstance(parent, list): parent.insert(key, new)
        else: parent[key] = new
    else: sys.exit(2)
except (KeyError, IndexError): sys.exit(1)
with open(path, 'wb') as file: plistlib.dump(value, file)
`);
  await chmod(env.PLISTBUDDY, 0o755);

  const dry = await run('sh', ['scripts/macos/install.sh', '--dry-run'], env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.ok(dry.stdout.includes(selected), 'dry-run must identify the selected Hermes source');
  assert.ok(dry.stdout.includes(profileHome), 'dry-run must identify the selected profile home');
  await assert.rejects(readFile(serviceLog));
  const installed = await run('sh', ['scripts/macos/install.sh'], env);
  assert.equal(installed.code, 0, installed.stderr);
  const before = await parsePlist();
  assert.equal(before.EnvironmentVariables.HERMES_AGENT_DIR, selected);
  assert.equal(before.EnvironmentVariables.HERMES_HOME, profileHome);
  assert.equal(before.EnvironmentVariables.HERMES_PYTHON, join(selected, 'venv/bin/python'));
  const discovered = await run('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(repository, 'server/workers'))}); import hermes_worker; print(hermes_worker._discover_agent_dir())`], {
    HOME: home, PATH: process.env.PATH, ...before.EnvironmentVariables,
  });
  assert.equal(discovered.code, 0, discovered.stderr);
  assert.equal(discovered.stdout.trim(), selected, 'selected checkout wins even when an unrelated default exists');
  const originalHome = process.env.HERMES_HOME;
  try { process.env.HERMES_HOME = before.EnvironmentVariables.HERMES_HOME; assert.equal(resolveHermesHome(), profileHome); }
  finally { if (originalHome === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = originalHome; }

  const updated = await run('sh', ['scripts/macos/update.sh'], { ...env, HERMES_AGENT_DIR: join(home, '.hermes/hermes-agent'), HERMES_HOME: join(home, '.hermes') });
  assert.equal(updated.code, 0, updated.stderr);
  assert.deepEqual((await parsePlist()).EnvironmentVariables, before.EnvironmentVariables, 'update must preserve the installed identity, not its caller’s profile');

  const repeatDry = await run('sh', ['scripts/macos/install.sh', '--dry-run'], { ...env, HERMES_AGENT_DIR: join(home, '.hermes/hermes-agent'), HERMES_HOME: join(home, '.hermes') });
  assert.equal(repeatDry.code, 0, repeatDry.stderr);
  assert.ok(repeatDry.stdout.includes(selected) && repeatDry.stdout.includes(profileHome), 'install dry-run on an existing installation must preview its actual update identity');

  await rm(join(selected, 'run_agent.py'));
  const missingStoredSource = await run('sh', ['scripts/macos/update.sh', '--dry-run'], env);
  assert.notEqual(missingStoredSource.code, 0, 'invalid stored source must not fall back to another installation');
  await writeFile(join(selected, 'run_agent.py'), '# Restored fixture source\n');

  // Old standard plists can safely be made explicit; a custom interpreter alone
  // is ambiguous and must stop before lifecycle work, rather than guess.
  const removeIdentity = await run('python3', ['-c', `import plistlib,sys; p=sys.argv[1]; d=plistlib.load(open(p,'rb')); e=d['EnvironmentVariables']; e.pop('HERMES_AGENT_DIR'); e.pop('HERMES_HOME'); plistlib.dump(d,open(p,'wb'))`, plist], env);
  assert.equal(removeIdentity.code, 0, removeIdentity.stderr);
  const starts = await readFile(serviceLog, 'utf8');
  const ambiguous = await run('sh', ['scripts/macos/update.sh'], env);
  assert.notEqual(ambiguous.code, 0);
  assert.match(ambiguous.stderr, /ambiguous/i);
  assert.equal(await readFile(serviceLog, 'utf8'), starts);
  const setLegacyPython = await run(env.PLISTBUDDY, ['-c', `Set :EnvironmentVariables:HERMES_PYTHON ${join(home, '.hermes/hermes-agent/venv/bin/python')}`, plist], env);
  assert.equal(setLegacyPython.code, 0, setLegacyPython.stderr);
  // A default interpreter does not prove the old source: discovery prefers a
  // checkout under a saved custom home when HERMES_AGENT_DIR was absent.
  await mkdir(join(profileHome, 'hermes-agent'));
  await writeFile(join(profileHome, 'hermes-agent/run_agent.py'), '# Custom legacy source\n');
  const setLegacyHome = await run(env.PLISTBUDDY, ['-c', `Add :EnvironmentVariables:HERMES_HOME string ${profileHome}`, plist], env);
  assert.equal(setLegacyHome.code, 0, setLegacyHome.stderr);
  const customLegacyEnv = (await parsePlist()).EnvironmentVariables;
  const legacyDiscovered = await run('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(repository, 'server/workers'))}); import hermes_worker; print(hermes_worker._discover_agent_dir())`], {
    HOME: home, PATH: process.env.PATH, ...customLegacyEnv,
  });
  assert.equal(legacyDiscovered.code, 0, legacyDiscovered.stderr);
  assert.equal(legacyDiscovered.stdout.trim(), join(profileHome, 'hermes-agent'));
  const savedLegacyPlist = await readFile(plist, 'utf8');
  const customHomeUpdate = await run('sh', ['scripts/macos/update.sh'], env);
  assert.notEqual(customHomeUpdate.code, 0, 'legacy custom home must not silently select the default source');
  assert.match(customHomeUpdate.stderr, /ambiguous/i);
  assert.equal(await readFile(serviceLog, 'utf8'), starts, 'ambiguous identity must stop before build, drain, or restart');
  assert.equal(await readFile(plist, 'utf8'), savedLegacyPlist, 'ambiguous identity must preserve the saved configuration');
  const removeLegacyHome = await run(env.PLISTBUDDY, ['-c', 'Delete :EnvironmentVariables:HERMES_HOME', plist], env);
  assert.equal(removeLegacyHome.code, 0, removeLegacyHome.stderr);
  const legacy = await run('sh', ['scripts/macos/update.sh'], env);
  assert.equal(legacy.code, 0, legacy.stderr);
  const legacyEnv = (await parsePlist()).EnvironmentVariables;
  assert.equal(legacyEnv.HERMES_AGENT_DIR, join(home, '.hermes/hermes-agent'));
  assert.equal(legacyEnv.HERMES_HOME, join(home, '.hermes'));

  const incomplete = join(fixture, 'incomplete-checkout');
  await mkdir(join(incomplete, 'venv/bin'), { recursive: true });
  await writeFile(join(incomplete, 'venv/bin/python'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  for (const invalid of [{ HERMES_AGENT_DIR: join(fixture, 'missing') }, { HERMES_AGENT_DIR: incomplete }, { HERMES_HOME: join(fixture, 'missing') }]) {
    const result = await run('sh', ['scripts/macos/install.sh', '--dry-run'], { ...env, OLYMPUS_INSTALL_ROOT: join(fixture, 'fresh-app'), ...invalid });
    assert.notEqual(result.code, 0, 'invalid explicit selection must fail despite a valid default installation');
  }
} finally { await rm(fixture, { recursive: true, force: true }); }
console.log('macOS selected Hermes identity and update preservation tests passed');
