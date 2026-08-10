import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-studio-credentials-'));
process.env.OLYMPUS_DISPATCH_HOME = root;
process.env.DB_PATH = join(root, 'data', 'studio.db');

const { default: db } = await import('../server/db/index.js');
const { createGitHubCredentialStore } = await import('../server/studio/github-credentials.js');

const config = {
  appId: '12345',
  appSlug: 'olympus-studio-test',
  privateKey: '[REDACTED PRIVATE KEY]',
  clientId: 'Iv1.client-id',
  clientSecret: 'client-secret-value',
};

try {
  const keyPath = join(root, 'data', 'studio-github-app.key');
  const store = createGitHubCredentialStore({ keyPath });
  assert.equal(store.load(), null);

  await mkdir(dirname(keyPath), { recursive: true });
  const plantedKey = join(root, 'attacker-known-key');
  await writeFile(plantedKey, Buffer.alloc(32, 7), { mode: 0o600 });
  await symlink(plantedKey, keyPath);
  assert.throws(
    () => store.save(config, 1_786_323_600_000),
    /secure regular file/i,
  );
  await rm(keyPath);

  await writeFile(keyPath, Buffer.alloc(32, 9), { mode: 0o644 });
  assert.throws(
    () => store.save(config, 1_786_323_600_000),
    /private permissions/i,
  );
  await rm(keyPath);

  store.save(config, 1_786_323_600_000);
  assert.deepEqual(store.load(), config);

  const key = await readFile(keyPath);
  assert.equal(key.length, 32);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);

  const row = db.prepare('SELECT encrypted_payload FROM studio_github_app_config WHERE id = 1').get() as {
    encrypted_payload: string;
  };
  assert.ok(row.encrypted_payload.startsWith('v1.'));
  assert.equal(row.encrypted_payload.includes(config.privateKey), false);
  assert.equal(row.encrypted_payload.includes(config.clientSecret), false);

  const reloaded = createGitHubCredentialStore({ keyPath });
  assert.deepEqual(reloaded.load(), config);
  assert.throws(() => reloaded.save({ ...config, appId: '99999' }), /already configured/i);

  db.prepare("UPDATE studio_github_app_config SET encrypted_payload = encrypted_payload || 'tampered' WHERE id = 1").run();
  assert.throws(() => reloaded.load(), /could not be decrypted/i);
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}

console.log('Studio GitHub encrypted credential store tests passed');
