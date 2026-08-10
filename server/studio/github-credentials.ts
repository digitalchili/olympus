import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import db from '../db/index.js';
import { resolveOlympusDataDir } from '../paths.js';

const AAD = Buffer.from('olympus-studio-github-app-config:v1');
const KEY_BYTES = 32;

export interface StudioGitHubAppConfig {
  appId: string;
  appSlug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
}

interface GitHubCredentialStoreOptions {
  keyPath?: string;
}

export interface GitHubCredentialStore {
  load(): StudioGitHubAppConfig | null;
  save(config: StudioGitHubAppConfig, now?: number): void;
}

function requireConfig(value: unknown): StudioGitHubAppConfig {
  if (!value || typeof value !== 'object') throw new Error('Stored Studio GitHub App credentials are invalid.');
  const record = value as Record<string, unknown>;
  for (const field of ['appId', 'appSlug', 'privateKey', 'clientId', 'clientSecret'] as const) {
    if (typeof record[field] !== 'string' || !record[field]) {
      throw new Error('Stored Studio GitHub App credentials are invalid.');
    }
  }
  return {
    appId: record.appId as string,
    appSlug: record.appSlug as string,
    privateKey: record.privateKey as string,
    clientId: record.clientId as string,
    clientSecret: record.clientSecret as string,
  };
}

function readOrCreateKey(path: string): Buffer {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  const processUid = process.getuid?.();
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (processUid !== undefined && directoryStat.uid !== processUid)) {
    throw new Error('Studio GitHub credential key directory is not secure.');
  }
  chmodSync(directory, 0o700);

  const validateDescriptor = (descriptor: number): void => {
    const keyStat = fstatSync(descriptor);
    if (!keyStat.isFile() || (processUid !== undefined && keyStat.uid !== processUid)) {
      throw new Error('Studio GitHub credential key must be a secure regular file owned by Olympus.');
    }
    if ((keyStat.mode & 0o077) !== 0) {
      throw new Error('Studio GitHub credential key must already have private permissions.');
    }
  };

  const readExisting = (): Buffer => {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      validateDescriptor(descriptor);
      const existing = readFileSync(descriptor);
      if (existing.length !== KEY_BYTES) throw new Error('Studio GitHub credential key has an invalid length.');
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new Error('Studio GitHub credential key must be a secure regular file owned by Olympus.');
      }
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };

  try {
    return readExisting();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const generated = randomBytes(KEY_BYTES);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    validateDescriptor(descriptor);
    let offset = 0;
    while (offset < generated.length) {
      const written = writeSync(descriptor, generated, offset, generated.length - offset);
      if (written <= 0) throw new Error('Studio GitHub credential key could not be written completely.');
      offset += written;
    }
    fsyncSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readExisting();
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  let directoryDescriptor: number | undefined;
  try {
    directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(directoryDescriptor);
  } finally {
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
  return generated;
}

function encrypt(config: StudioGitHubAppConfig, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decrypt(payload: string, key: Buffer): StudioGitHubAppConfig {
  try {
    const [version, encodedIv, encodedTag, encodedCiphertext, ...extra] = payload.split('.');
    if (version !== 'v1' || !encodedIv || !encodedTag || !encodedCiphertext || extra.length > 0) throw new Error('invalid envelope');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encodedIv, 'base64url'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    const cleartext = Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return requireConfig(JSON.parse(cleartext));
  } catch {
    throw new Error('Stored Studio GitHub App credentials could not be decrypted.');
  }
}

export function createGitHubCredentialStore(options: GitHubCredentialStoreOptions = {}): GitHubCredentialStore {
  const keyPath = options.keyPath ?? join(resolveOlympusDataDir(), 'studio-github-app.key');

  return {
    load(): StudioGitHubAppConfig | null {
      const row = db.prepare('SELECT encrypted_payload FROM studio_github_app_config WHERE id = 1').get() as {
        encrypted_payload: string;
      } | undefined;
      if (!row) return null;
      return decrypt(row.encrypted_payload, readOrCreateKey(keyPath));
    },

    save(config: StudioGitHubAppConfig, now = Date.now()): void {
      const normalized = requireConfig(config);
      const encryptedPayload = encrypt(normalized, readOrCreateKey(keyPath));
      try {
        db.prepare(`
          INSERT INTO studio_github_app_config (id, encrypted_payload, created_at, updated_at)
          VALUES (1, ?, ?, ?)
        `).run(encryptedPayload, now, now);
      } catch (error) {
        if (String((error as Error).message).includes('UNIQUE constraint failed')) {
          throw new Error('The Studio GitHub App is already configured.');
        }
        throw error;
      }
    },
  };
}